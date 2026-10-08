import { Injectable, NotFoundException } from "@nestjs/common";
import { COLLECTION_NAMES, type CollectionDelivery, type CollectionName, isCollectionName } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { takeInBatches } from "../library/bean-batches.js";
import { takeInBeans } from "../library/beans.js";
import { INTAKE_TRANSACTION } from "../library/intake.js";
import type { TakenInList } from "../sync/tablet-writer.js";
import { creditFirstDelivery } from "../machines/credit.js";
import { machineNotFound } from "../machines/input.js";
import { PrismaService } from "../prisma.service.js";
import type { Reporter } from "../sync/identity.js";
import { type PairedDevicesView, pairedDevicesView } from "./paired-devices.js";

/** A collection's latest report, without its value, as the REST API lists it. */
export interface CollectionSummary {
  name: CollectionName;
  /** Whether the latest report had a value: false while, say, no scale is connected. */
  available: boolean;
  /** When the latest report, available or not, was received. */
  reportedAt: string;
  /** When the value was received; null if no report has had one. */
  receivedAt: string | null;
  /** How many entries the value lists, if it is a list. */
  items: number | null;
}

/** A collection's latest report and value, as the REST API returns it. */
export interface CollectionView extends CollectionSummary {
  /** The latest value reported, as Decaid sent it, kept while later reports are unavailable; null if none has been. */
  value: Prisma.JsonValue | null;
}

type Row = { name: string; available: boolean; reportedAt: Date; receivedAt: Date | null; items: number | null };

/**
 * The collections tablets report: their library, settings and paired
 * devices, stored as the latest value of each, per Machine. A tablet's
 * `beans` and `beanBatches` are also taken into the Library, in the same
 * transaction, when its connection is not mismatched and its Machine is at
 * a Location (server/src/library/beans.ts and bean-batches.ts); the Library
 * is written back to tablets, not these collections.
 *
 * A collection belongs to the session's token's Machine, or for a mismatched
 * session to its reported hardware: the Machine that has it, or else its
 * Pending Machine, which hands it over with the hardware (ADR-0015), as a
 * Workflow does. So a tablet moved onto other hardware never overwrites what
 * its token's Machine's own tablet last reported.
 *
 * Each delivery is handled once, by its delivery id, which is recorded
 * whatever it changes and kept for 90 days, as for Workflow and machine
 * state events, and in the order the plugin sends them. A delivery sent
 * before a reconnect, still being stored on another instance, is sent again
 * ahead of newer ones, and its resend waits for it, so it cannot replace a
 * newer value. An unavailable report keeps the value already known, and says
 * only that the latest read had none.
 *
 * The plugin sends every collection on every `welcome`, changed or not. A
 * value equal to the one stored, as jsonb compares them, is left as stored
 * rather than written again, so a large one, such as profiles, does not
 * rewrite its TOAST data and WAL on every reconnect. Its report time,
 * received time and item count are recorded as for a changed value.
 */
@Injectable()
export class CollectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a collection delivery. For a report of the tablet's beans or bean
   * batches from a connection that is not mismatched, stored now, returns
   * which it was and the Location it was taken in at, null for a Machine at
   * none, or undefined if it was unavailable and so not taken in; otherwise,
   * as for a delivery handled before, undefined.
   */
  async store(message: CollectionDelivery, reporter: Reporter): Promise<{ list: TakenInList; takenInAt: string | null | undefined } | undefined> {
    // A collection a newer plugin reports that this server does not know: acknowledged, and ignored.
    if (!isCollectionName(message.name)) return undefined;
    const value = message.available ? JSON.stringify(message.value) : null;
    const items = message.available && Array.isArray(message.value) ? message.value.length : null;
    // A mismatched connection's tablet is not its token's Machine's, so it takes no part in the Library (ADR-0004).
    const list = (message.name === "beans" || message.name === "beanBatches") && reporter.identity.kind !== "mismatch" ? message.name : null;
    const takesIn = list !== null && message.available;
    return this.prisma.$transaction(async (tx) => {
      const credit = await creditFirstDelivery(tx, reporter, message.id);
      if (!credit) return undefined;
      const holder = credit.machineId !== null ? Prisma.sql`machine_id` : Prisma.sql`pending_machine_id`;
      await tx.$executeRaw`
        INSERT INTO reported_collections (${holder}, name, available, reported_at, value, received_at, items)
        VALUES (
          ${credit.machineId ?? credit.pendingMachineId}::uuid, ${message.name}, ${message.available}::boolean, now(),
          ${value}::jsonb, CASE WHEN ${message.available}::boolean THEN now() END, ${items}::integer
        )
        ON CONFLICT (${holder}, name) DO UPDATE SET
          available = EXCLUDED.available,
          reported_at = EXCLUDED.reported_at,
          -- Set to itself, the stored value keeps its TOAST data rather than writing it again.
          value = CASE
            WHEN EXCLUDED.value IS NULL OR EXCLUDED.value = reported_collections.value THEN reported_collections.value
            ELSE EXCLUDED.value
          END,
          received_at = COALESCE(EXCLUDED.received_at, reported_collections.received_at),
          items = CASE WHEN EXCLUDED.available THEN EXCLUDED.items ELSE reported_collections.items END`;
      if (list === null) return undefined;
      if (!takesIn) return { list, takenInAt: undefined };
      const tablet = { machineId: reporter.machineId, tabletId: reporter.tabletId };
      const takeIn = list === "beans" ? takeInBeans : takeInBatches;
      return { list, takenInAt: await takeIn(tx, tablet, message.value, message.updatedAt) };
    }, takesIn ? INTAKE_TRANSACTION : undefined);
  }

  /** The Machine's reported collections, in COLLECTION_NAMES order, without their values. */
  async list(machineId: string): Promise<CollectionSummary[]> {
    await this.requireMachine(machineId);
    const rows = await this.prisma.reportedCollection.findMany({
      where: { machineId },
      select: { name: true, available: true, reportedAt: true, receivedAt: true, items: true },
    });
    return COLLECTION_NAMES.flatMap((name) => {
      const row = rows.find((candidate) => candidate.name === name);
      return row ? [summary(row, name)] : [];
    });
  }

  /** One of the Machine's collections, with its value; null if its tablet has not reported it. */
  async get(machineId: string, name: string): Promise<CollectionView | null> {
    if (!isCollectionName(name)) throw new NotFoundException("No such collection");
    await this.requireMachine(machineId);
    const row = await this.prisma.reportedCollection.findUnique({ where: { machineId_name: { machineId, name } } });
    return row ? { ...summary(row, name), value: row.value } : null;
  }

  /** The Machine's paired scale, auxiliary scale, sensors and other paired devices, from the collections that report them. */
  async pairedDevices(machineId: string): Promise<PairedDevicesView> {
    await this.requireMachine(machineId);
    const rows = await this.prisma.reportedCollection.findMany({
      where: { machineId, name: { in: ["pairedDevices", "scaleInfo", "sensors", "appSettings"] } },
      select: { name: true, available: true, reportedAt: true, value: true, receivedAt: true },
    });
    const report = (name: CollectionName) => rows.find((row) => row.name === name) ?? null;
    return pairedDevicesView({
      pairedDevices: report("pairedDevices"),
      scaleInfo: report("scaleInfo"),
      sensors: report("sensors"),
      appSettings: report("appSettings"),
    });
  }

  private async requireMachine(id: string): Promise<void> {
    if ((await this.prisma.machine.count({ where: { id } })) === 0) throw machineNotFound();
  }
}

function summary(row: Row, name: CollectionName): CollectionSummary {
  return {
    name,
    available: row.available,
    reportedAt: row.reportedAt.toISOString(),
    receivedAt: row.receivedAt?.toISOString() ?? null,
    items: row.items,
  };
}
