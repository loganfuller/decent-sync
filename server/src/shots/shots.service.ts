import { Injectable, NotFoundException } from "@nestjs/common";
import { type ShotDelivery, type ShotIndex, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { creditHardware, creditReporter } from "../machines/credit.js";
import { creditShotLocation } from "../machines/location-history.js";
import { PrismaService } from "../prisma.service.js";
import type { Reporter } from "../sync/identity.js";
import { extractCurves, extractShot, shotHardware, shotVersion } from "./extraction.js";
import { type ShotFilters, shotFilterSql } from "./filters.js";

/** Advisory lock class for one Shot id; distinct from the server's other lock classes. */
const SHOT_LOCK = 4_000_003;

/** Metadata and curves are deliberately separate queries, including on detail reads. */
@Injectable()
export class ShotsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a Shot delivery, unless it is not a record Decaid v0.8.7 or later
   * sends: then it is ignored, and what it lacks is returned, to be logged.
   * Returns null otherwise, including for an id the server cannot store,
   * which is ignored too, as the plugin never sends one.
   */
  async store(message: ShotDelivery, reporter: Reporter): Promise<string | null> {
    const { measurements, ...incoming } = message.shot;
    const version = shotVersion(incoming);
    const full = message.type === "shot";
    if (!isRecordId(message.shotId)) return null;
    if (version === null) return "no updatedAt in UTC ending in Z";
    if (full && !Array.isArray(measurements)) return "no measurements array";
    await this.prisma.$transaction(async (tx) => {
      // Serializes even the first insertion across instances. No row is held
      // until credit is resolved: hardware adoption can finish while we wait
      // for its hardware lock. Adoption never takes this advisory lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SHOT_LOCK}::int, hashtext(${message.shotId}::text))`;
      const [stored] = await tx.$queryRaw<{ record: Prisma.JsonObject; hasFullRecord: boolean; duration: number | null; peakPressure: number | null; peakFlow: number | null; pulledAt: Date | null; newer: boolean }[]>`
        SELECT record, has_full_record AS "hasFullRecord", duration, peak_pressure AS "peakPressure", peak_flow AS "peakFlow",
          pulled_at AS "pulledAt", ${version}::timestamptz > version_at AS newer
        FROM shots WHERE id = ${message.shotId}`;
      if (stored && !stored.newer && (!full || stored.hasFullRecord)) return;

      // Every delivery carries complete metadata, so the newer one is kept
      // whole. A full record older than an early edit only adds its curves.
      const record = stored && !stored.newer ? stored.record : incoming;
      const metadata = extractShot(record);
      // The pull time needs the curves too, so it is set with them; edits never load or rewrite them.
      const curves = full ? extractCurves(record, measurements) : stored;
      // The first full record credits the Shot, with its Machine's row locked, and sets the pull time
      // its Location is credited by. Later records change neither, so they cannot race a change to
      // that Machine's Location History, or the adoption of a Pending Machine's Shot.
      const credit = full && !stored?.hasFullRecord ? await this.credit(tx, incoming, reporter) : null;
      const data = {
        ...metadata,
        pulledAt: (stored?.hasFullRecord ? stored.pulledAt : curves?.pulledAt) ?? null,
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
      if (credit) await creditShotLocation(tx, message.shotId);
      if (full) {
        const value = measurements as Prisma.InputJsonValue;
        await tx.shotMeasurements.upsert({
          where: { shotId: message.shotId },
          create: { shotId: message.shotId, data: value },
          update: { data: value },
        });
      }
    });
    return null;
  }

  /**
   * The indexed Shots the Machine's tablet should send: those not stored, or
   * stored without their full record (even if their edits have already
   * arrived) or at an older version, in the index's order. A Shot whose
   * delivery from this Machine was set aside counts as known, and one whose id
   * the server cannot store is never requested.
   */
  async requested(index: ShotIndex, machineId: string): Promise<string[]> {
    const offered = index.shots.filter((shot) => isRecordId(shot.id));
    if (offered.length === 0) return [];
    const ids = offered.map((shot) => shot.id);
    // Null in a reconnect's ids-only index.
    const versions = offered.map((shot) => shotVersion(shot));
    const missing = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT offered.id FROM unnest(${ids}::text[], ${versions}::timestamptz[]) WITH ORDINALITY AS offered(id, version_at, position)
      LEFT JOIN shots ON shots.id = offered.id
      WHERE (shots.id IS NULL OR NOT shots.has_full_record OR offered.version_at > shots.version_at)
        AND NOT EXISTS (
          SELECT 1 FROM set_aside_deliveries aside
          WHERE aside.machine_id = ${machineId}::uuid AND aside.record_id = offered.id AND aside.type IN ('shot', 'shotUpdated')
        )
      ORDER BY offered.position`;
    return [...new Set(missing.map((shot) => shot.id))];
  }

  async list(limit: number, offset: number, filters: ShotFilters = {}) {
    const where = Prisma.sql`${listed} AND ${shotFilterSql(filters)}`;
    // One snapshot, so the page's rows and the total agree.
    const { page, total } = await this.prisma.$transaction(
      async (tx) => {
        const [ids, [count]] = await Promise.all([
          tx.$queryRaw<{ id: string }[]>`
            SELECT s.id FROM shots s ${listedJoins} WHERE ${where}
            ORDER BY s.pulled_at DESC NULLS LAST, s.id ASC LIMIT ${limit} OFFSET ${offset}`,
          tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM shots s ${listedJoins} WHERE ${where}`,
        ]);
        const rows = ids.length === 0
          ? []
          : await tx.shot.findMany({ where: { id: { in: ids.map((row) => row.id) } }, omit: { record: true, versionAt: true, hasFullRecord: true }, include: creditView });
        const byId = new Map(rows.map((row) => [row.id, row]));
        return { page: ids.flatMap((row) => byId.get(row.id) ?? []), total: count!.total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { shots: page.map(withLocationInferred), total, limit, offset };
  }

  /**
   * The Beans, Baristas and profiles listed Shots recorded, for choosing
   * filters, each as recorded and sorted ignoring case. Null stands for the
   * Shots that recorded none: a Bean names neither roaster nor name.
   */
  async filterOptions() {
    const [beans, baristas, profiles] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<{ coffeeRoaster: string | null; coffeeName: string | null }[]>`
          SELECT nullif(s.coffee_roaster, '') AS "coffeeRoaster", nullif(s.coffee_name, '') AS "coffeeName"
          FROM shots s ${listedJoins} WHERE ${listed} GROUP BY 1, 2
          ORDER BY lower(nullif(s.coffee_roaster, '')) NULLS LAST, lower(nullif(s.coffee_name, '')) NULLS LAST, 1, 2`,
        this.distinct(Prisma.raw("s.barista")),
        this.distinct(Prisma.raw("s.profile_title")),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { beans, baristas: baristas.map((row) => row.value), profiles: profiles.map((row) => row.value) };
  }

  private distinct(column: Prisma.Sql) {
    return this.prisma.$queryRaw<{ value: string | null }[]>`
      SELECT nullif(${column}, '') AS value FROM shots s ${listedJoins} WHERE ${listed}
      GROUP BY 1 ORDER BY lower(nullif(${column}, '')) NULLS LAST, 1`;
  }

  /**
   * The Shot pulled on the same Machine, or held by the same Pending
   * Machine, just before this one, as the list orders them; none when its
   * time is unknown.
   */
  private async previous(shot: { id: string; pulledAt: Date | null; machineId: string | null; pendingMachineId: string | null }) {
    if (shot.pulledAt === null) return null;
    const credit = shot.machineId !== null
      ? Prisma.sql`s.machine_id = ${shot.machineId}::uuid`
      : Prisma.sql`s.pending_machine_id = ${shot.pendingMachineId}::uuid`;
    // Ordered as the indexes on pulled_at are, NULLS LAST, and bounded above, so an index scan starts at this Shot.
    const [previous] = await this.prisma.$queryRaw<{ id: string; pulledAt: Date }[]>`
      SELECT s.id, s.pulled_at AS "pulledAt" FROM shots s ${listedJoins}
      WHERE ${listed} AND ${credit} AND s.pulled_at <= ${shot.pulledAt}::timestamptz
        AND (s.pulled_at < ${shot.pulledAt}::timestamptz OR s.id > ${shot.id})
      ORDER BY s.pulled_at DESC NULLS LAST, s.id ASC LIMIT 1`;
    return previous ?? null;
  }

  async get(id: string) {
    const shot = await this.prisma.shot.findFirst({ where: { id, ...visible }, omit: { versionAt: true, hasFullRecord: true }, include: creditView });
    if (!shot) throw shotNotFound();
    return { ...withLocationInferred(shot), previousShot: await this.previous(shot) };
  }

  async measurements(id: string) {
    // The same visibility applies to all three endpoints.
    if (!(await this.prisma.shot.count({ where: { id, ...visible } }))) throw shotNotFound();
    return (await this.prisma.shotMeasurements.findUnique({ where: { shotId: id } }))?.data ?? null;
  }

  /** Credited by the hardware it recorded, otherwise, as inferred, to whoever reported it. */
  private async credit(tx: Prisma.TransactionClient, record: unknown, reporter: Reporter) {
    const recordedHardware = shotHardware(record);
    const credit = recordedHardware ? await creditHardware(tx, recordedHardware) : await creditReporter(tx, reporter);
    return { ...credit, machineInferred: recordedHardware === null };
  }
}

const visible: Prisma.ShotWhereInput = {
  hasFullRecord: true,
  OR: [{ machineId: { not: null } }, { pendingMachine: { dismissedAt: null } }],
};
/** `visible` in SQL, for `shots` aliased `s` with `listedJoins`, which also joins its Location as `l` for filters. */
const listed = Prisma.sql`s.has_full_record AND (s.machine_id IS NOT NULL OR (p.id IS NOT NULL AND p.dismissed_at IS NULL))`;
const listedJoins = Prisma.sql`LEFT JOIN pending_machines p ON p.id = s.pending_machine_id LEFT JOIN locations l ON l.id = s.location_id`;
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
