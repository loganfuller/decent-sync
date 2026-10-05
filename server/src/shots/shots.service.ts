import { Injectable, NotFoundException } from "@nestjs/common";
import type { ShotDelivery, ShotIndex } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { creditShotLocation } from "../machines/location-history.js";
import { lockHardware, lockMachine } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import type { Identity } from "../sync/identity.js";
import { extractCurves, extractShot, shotHardware, shotVersion } from "./extraction.js";

/** Advisory lock class for one Shot id; distinct from the server's other lock classes. */
const SHOT_LOCK = 4_000_003;

export interface ShotReporter {
  machineId: string;
  identity: Identity;
}

/** Metadata and curves are deliberately separate queries, including on detail reads. */
@Injectable()
export class ShotsService {
  constructor(private readonly prisma: PrismaService) {}

  async store(message: ShotDelivery, reporter: ShotReporter): Promise<void> {
    const { measurements, ...incoming } = message.shot;
    const version = shotVersion(incoming);
    const full = message.type === "shot";
    // Not a record Decaid v0.8.7 or later sends: acknowledged, but ignored.
    if (version === null || (full && !Array.isArray(measurements))) return;
    await this.prisma.$transaction(async (tx) => {
      // Serializes even the first insertion across instances. No row is held
      // until credit is resolved: hardware adoption can finish while we wait
      // for its hardware lock. Adoption never takes this advisory lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SHOT_LOCK}::int, hashtext(${message.shotId}::text))`;
      const [stored] = await tx.$queryRaw<{ record: Prisma.JsonObject; hasFullRecord: boolean; machineId: string | null; duration: number | null; peakPressure: number | null; peakFlow: number | null; pulledAt: Date | null; newer: boolean }[]>`
        SELECT record, has_full_record AS "hasFullRecord", machine_id AS "machineId", duration, peak_pressure AS "peakPressure", peak_flow AS "peakFlow",
          pulled_at AS "pulledAt", ${version}::timestamptz > version_at AS newer
        FROM shots WHERE id = ${message.shotId}`;
      if (stored && !stored.newer && (!full || stored.hasFullRecord)) return;

      // Every delivery carries complete metadata, so the newer one is kept
      // whole. A full record older than an early edit only adds its curves.
      const record = stored && !stored.newer ? stored.record : incoming;
      const metadata = extractShot(record);
      // The pull time needs the curves too, so it is set with them; edits never load or rewrite them.
      const curves = full ? extractCurves(record, measurements) : stored;
      const credit = full && !stored?.hasFullRecord ? await this.credit(tx, incoming, reporter) : {};
      // A full record sets the pull time its Location is credited by, so the Machine's row is
      // locked, as credit() locks a newly credited one: its Location History cannot change meanwhile.
      if (full && stored?.hasFullRecord && stored.machineId) await lockMachine(tx, stored.machineId);
      const data = {
        ...metadata,
        pulledAt: curves?.pulledAt ?? null,
        duration: curves?.duration ?? null,
        peakPressure: curves?.peakPressure ?? null,
        peakFlow: curves?.peakFlow ?? null,
        hasFullRecord: full || stored?.hasFullRecord === true,
        record: record as Prisma.InputJsonObject,
        ...credit,
      };
      if (stored) await tx.shot.update({ where: { id: message.shotId }, data });
      else await tx.shot.create({ data: { id: message.shotId, versionAt: new Date(0), ...data } });
      // Prisma's Date loses Decaid's microseconds. Let PostgreSQL parse and
      // retain them, so two edits within one millisecond compare correctly.
      if (!stored || stored.newer) {
        await tx.$executeRaw`UPDATE shots SET version_at = ${version}::timestamptz WHERE id = ${message.shotId}`;
      }
      if (full) {
        await creditShotLocation(tx, message.shotId);
        const value = measurements as Prisma.InputJsonValue;
        await tx.shotMeasurements.upsert({
          where: { shotId: message.shotId },
          create: { shotId: message.shotId, data: value },
          update: { data: value },
        });
      }
    });
  }

  /** Missing full records are requested even if their edits have already arrived. */
  async requested(index: ShotIndex): Promise<string[]> {
    if (index.shots.length === 0) return [];
    const entries = index.shots.map((shot) => Prisma.sql`(${shot.id}::text, ${shotVersion(shot)}::timestamptz)`);
    const missing = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT offered.id FROM (VALUES ${Prisma.join(entries)}) AS offered(id, version_at)
      LEFT JOIN shots ON shots.id = offered.id
      WHERE shots.id IS NULL OR NOT shots.has_full_record OR offered.version_at > shots.version_at`);
    return [...new Set(missing.map((shot) => shot.id))];
  }

  async list(limit: number, offset: number, machineId?: string) {
    const where: Prisma.ShotWhereInput = { ...visible, ...(machineId ? { machineId } : {}) };
    const [shots, total] = await this.prisma.$transaction([
      this.prisma.shot.findMany({ where, orderBy, take: limit, skip: offset, omit: { record: true, versionAt: true, hasFullRecord: true }, include: creditView }),
      this.prisma.shot.count({ where }),
    ]);
    return { shots: shots.map(withLocationInferred), total, limit, offset };
  }

  async get(id: string) {
    const shot = await this.prisma.shot.findFirst({ where: { id, ...visible }, omit: { versionAt: true, hasFullRecord: true }, include: creditView });
    if (!shot) throw shotNotFound();
    return withLocationInferred(shot);
  }

  async measurements(id: string) {
    // The same visibility applies to all three endpoints.
    if (!(await this.prisma.shot.count({ where: { id, ...visible } }))) throw shotNotFound();
    return (await this.prisma.shotMeasurements.findUnique({ where: { shotId: id } }))?.data ?? null;
  }

  private async credit(tx: Prisma.TransactionClient, record: unknown, reporter: ShotReporter) {
    const recordedHardware = shotHardware(record);
    const hardware = recordedHardware ?? (reporter.identity.kind === "mismatch" ? reporter.identity.hardware : null);
    const machineInferred = recordedHardware === null;
    if (!hardware) {
      await lockMachine(tx, reporter.machineId);
      return { machineId: reporter.machineId, pendingMachineId: null, machineInferred };
    }
    await lockHardware(tx, hardware);
    // Machine rows before the Pending Machine, matching hello and dismissal. Locked as lockMachine locks it.
    const [owner] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM machines WHERE model = ${hardware.model} AND serial = ${hardware.serial} FOR NO KEY UPDATE`;
    if (owner) return { machineId: owner.id, pendingMachineId: null, machineInferred };
    const pending = await tx.pendingMachine.upsert({ where: { model_serial: hardware }, create: hardware, update: {} });
    return { machineId: null, pendingMachineId: pending.id, machineInferred };
  }
}

const visible: Prisma.ShotWhereInput = {
  hasFullRecord: true,
  OR: [{ machineId: { not: null } }, { pendingMachine: { dismissedAt: null } }],
};
const orderBy: Prisma.ShotOrderByWithRelationInput[] = [{ pulledAt: { sort: "desc", nulls: "last" } }, { id: "asc" }];
const creditView = {
  machine: { select: { id: true, name: true } },
  pendingMachine: { select: { id: true, model: true, serial: true } },
  location: { select: { id: true, name: true, timeZone: true } },
} as const;

/** A Location credited through an inferred Machine is inferred too. An unknown Location is not. */
function withLocationInferred<T extends { machineInferred: boolean; locationId: string | null }>(shot: T): T & { locationInferred: boolean } {
  return { ...shot, locationInferred: shot.machineInferred && shot.locationId !== null };
}

function shotNotFound() { return new NotFoundException("Shot not found"); }
