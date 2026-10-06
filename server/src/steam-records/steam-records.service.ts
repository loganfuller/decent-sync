import { Injectable, NotFoundException } from "@nestjs/common";
import type { SteamDelivery, SteamIndex } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { creditReporter } from "../machines/credit.js";
import { creditSteamRecordLocation } from "../machines/location-history.js";
import { PrismaService } from "../prisma.service.js";
import { type RecordFilters, recordFilterSql } from "../record-filters.js";
import type { Reporter } from "../sync/identity.js";
import { extractSteamRecord } from "./extraction.js";

/**
 * Steam Records, stored once by their Decaid ids. Decaid offers no way to
 * detect an edit to one, so whatever delivers a stored record again, from any
 * tablet, changes nothing. Decaid records no hardware on them, so each is
 * credited to whoever reported it (ADR-0015), with no inferred marker, and to
 * the Location its Machine was at when it was recorded. Metadata and
 * measurements are separate queries, and lists never read measurements.
 */
@Injectable()
export class SteamRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  async store(message: SteamDelivery, reporter: Reporter): Promise<void> {
    const { measurements, ...record } = message.steam;
    // Not a record Decaid v0.8.7 or later sends: acknowledged, but ignored.
    if (!Array.isArray(measurements)) return;
    // Spares a backfill's repeats the locks below.
    if (await this.prisma.steamRecord.count({ where: { id: message.steamId } })) return;
    await this.prisma.$transaction(async (tx) => {
      // Credited, with its Machine's row locked, before the record is written, as Shots are.
      const credit = await creditReporter(tx, reporter);
      const stored = await tx.steamRecord.createMany({
        data: {
          id: message.steamId,
          record: record as Prisma.InputJsonObject,
          steamedAt: new Date(message.steamedAt),
          ...extractSteamRecord(message.steam),
          ...credit,
        },
        // Waits for another delivery of it, on any instance, and keeps that one if it commits.
        skipDuplicates: true,
      });
      if (stored.count === 0) return;
      await creditSteamRecordLocation(tx, message.steamId);
      await tx.steamMeasurements.create({ data: { steamRecordId: message.steamId, data: measurements as Prisma.InputJsonValue } });
    });
  }

  /** The indexed Steam Records not stored yet, in the index's order. */
  async requested(index: SteamIndex): Promise<string[]> {
    if (index.steams.length === 0) return [];
    const missing = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT offered.id FROM unnest(${index.steams.map((steam) => steam.id)}::text[]) WITH ORDINALITY AS offered(id, position)
      WHERE NOT EXISTS (SELECT 1 FROM steam_records WHERE steam_records.id = offered.id)
      ORDER BY offered.position`;
    return [...new Set(missing.map((steam) => steam.id))];
  }

  /** Newest first, with times read in each Steam Record's Location's time zone, or UTC without one. */
  async list(limit: number, offset: number, filters: RecordFilters = {}) {
    const where = Prisma.sql`${listed} AND ${recordFilterSql(filters, "r", "steamed_at")}`;
    // One snapshot, so the page's rows and the total agree.
    const { page, total } = await this.prisma.$transaction(
      async (tx) => {
        const [ids, [count]] = await Promise.all([
          tx.$queryRaw<{ id: string }[]>`
            SELECT r.id FROM steam_records r ${listedJoins} WHERE ${where}
            ORDER BY r.steamed_at DESC, r.id ASC LIMIT ${limit} OFFSET ${offset}`,
          tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM steam_records r ${listedJoins} WHERE ${where}`,
        ]);
        const rows = ids.length === 0
          ? []
          : await tx.steamRecord.findMany({ where: { id: { in: ids.map((row) => row.id) } }, omit: { record: true }, include: creditView });
        const byId = new Map(rows.map((row) => [row.id, row]));
        return { page: ids.flatMap((row) => byId.get(row.id) ?? []), total: count!.total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { steamRecords: page, total, limit, offset };
  }

  async get(id: string) {
    const steamRecord = await this.prisma.steamRecord.findFirst({ where: { id, ...visible }, include: creditView });
    if (!steamRecord) throw steamRecordNotFound();
    return steamRecord;
  }

  async measurements(id: string) {
    // The same visibility applies to all three endpoints.
    if (!(await this.prisma.steamRecord.count({ where: { id, ...visible } }))) throw steamRecordNotFound();
    return (await this.prisma.steamMeasurements.findUnique({ where: { steamRecordId: id } }))?.data ?? null;
  }
}

/** A dismissed Pending Machine's Steam Records are kept, but left out, until a machine entry takes its hardware over. */
const visible: Prisma.SteamRecordWhereInput = { OR: [{ machineId: { not: null } }, { pendingMachine: { dismissedAt: null } }] };
/** `visible` in SQL, for `steam_records` aliased `r` with `listedJoins`, which also joins its Location as `l` for filters. */
const listed = Prisma.sql`(r.machine_id IS NOT NULL OR (p.id IS NOT NULL AND p.dismissed_at IS NULL))`;
const listedJoins = Prisma.sql`LEFT JOIN pending_machines p ON p.id = r.pending_machine_id LEFT JOIN locations l ON l.id = r.location_id`;
const creditView = {
  machine: { select: { id: true, name: true } },
  pendingMachine: { select: { id: true, model: true, serial: true } },
  location: { select: { id: true, name: true, timeZone: true } },
} as const;

function steamRecordNotFound() { return new NotFoundException("Steam Record not found"); }
