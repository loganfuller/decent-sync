import { Injectable, NotFoundException } from "@nestjs/common";
import { type ShotDelivery, type ShotIndex, isRecordId } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { viewLocation } from "../locations/locations.service.js";
import { creditHardware, creditReporter } from "../machines/credit.js";
import { creditShotLocation } from "../machines/location-history.js";
import { PrismaService } from "../prisma.service.js";
import type { Reporter } from "../sync/identity.js";
import { extractCurves, extractShot, object, shotHardware, shotVersion, string } from "./extraction.js";
import { type ShotFilters, shotFilterSql } from "./filters.js";
import { type ShotLinks, resolveLinks, shotProfileSql } from "./links.js";

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
      const [stored] = await tx.$queryRaw<
        ({ record: Prisma.JsonObject; hasFullRecord: boolean; duration: number | null; peakPressure: number | null; peakFlow: number | null; pulledAt: Date | null; newer: boolean } & ShotLinks)[]
      >`
        SELECT record, has_full_record AS "hasFullRecord", duration, peak_pressure AS "peakPressure", peak_flow AS "peakFlow",
          pulled_at AS "pulledAt", ${version}::timestamptz > version_at AS newer, bean_batch_id AS "beanBatchId", grinder_id AS "grinderId",
          library_batch_id::text AS "libraryBatchId", library_grinder_id::text AS "libraryGrinderId"
        FROM shots WHERE id = ${message.shotId}`;
      if (stored && !stored.newer && (!full || stored.hasFullRecord)) return;

      // Every delivery carries complete metadata, so the newer one is kept
      // whole. A full record older than an early edit only adds its curves.
      const reported = !stored || stored.newer;
      const record = reported ? incoming : stored.record;
      const metadata = extractShot(record);
      // The pull time needs the curves too, so it is set with them; edits never load or rewrite them.
      const curves = full ? extractCurves(record, measurements) : stored;
      // The first full record credits the Shot, with its Machine's row locked, and sets the pull time
      // its Location is credited by. Later records change neither, so they cannot race a change to
      // that Machine's Location History, or the adoption of a Pending Machine's Shot.
      const credit = full && !stored?.hasFullRecord ? await this.credit(tx, incoming, reporter) : null;
      // Its ids are the reporting tablet's, so they resolve through its map, after the Machine's row lock credit takes.
      const links = reported ? { tabletId: reporter.tabletId, ...(await resolveLinks(tx, reporter.tabletId, metadata, stored)) } : null;
      const data = {
        ...metadata,
        ...links,
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
          : await withLinks(tx, await tx.shot.findMany({ where: { id: { in: ids.map((row) => row.id) } }, omit: listOmitted, include: creditView }));
        const byId = new Map(rows.map((row) => [row.id, row]));
        return { page: ids.flatMap((row) => byId.get(row.id) ?? []), total: count!.total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { shots: page.map(withLocationInferred), total, limit, offset };
  }

  /**
   * The Beans, Baristas and profiles listed Shots recorded, for choosing
   * filters, each as recorded and sorted ignoring case, and the Bean Batches
   * and Grinders they are linked to. Null stands for the Shots that recorded
   * none, or are linked to none: a Bean names neither roaster nor name.
   */
  async filterOptions() {
    return this.prisma.$transaction(
      async (tx) => {
        const [beans, baristas, profiles, batchIds, grinderIds] = await Promise.all([
          tx.$queryRaw<{ coffeeRoaster: string | null; coffeeName: string | null }[]>`
            SELECT nullif(s.coffee_roaster, '') AS "coffeeRoaster", nullif(s.coffee_name, '') AS "coffeeName"
            FROM shots s ${listedJoins} WHERE ${listed} GROUP BY 1, 2
            ORDER BY lower(nullif(s.coffee_roaster, '')) NULLS LAST, lower(nullif(s.coffee_name, '')) NULLS LAST, 1, 2`,
          distinct(tx, Prisma.raw("nullif(s.barista, '')")),
          distinct(tx, Prisma.raw("nullif(s.profile_title, '')")),
          distinct(tx, Prisma.raw("s.library_batch_id::text")),
          distinct(tx, Prisma.raw("s.library_grinder_id::text")),
        ]);
        const linked = (rows: { value: string | null }[]) => rows.flatMap((row) => (row.value === null ? [] : [row.value]));
        const unlinked = (rows: { value: string | null }[]) => (rows.some((row) => row.value === null) ? [null] : []);
        const [batches, grinders] = await Promise.all([
          tx.beanBatch.findMany({ where: { id: { in: linked(batchIds) } }, select: batchLink }),
          tx.grinder.findMany({ where: { id: { in: linked(grinderIds) } }, select: { ...grinderLink, location: true } }),
        ]);
        return {
          beans,
          baristas: baristas.map((row) => row.value),
          profiles: profiles.map((row) => row.value),
          beanBatches: [...batches.map(viewBatchLink).sort(byBatchName), ...unlinked(batchIds)],
          grinders: [
            ...grinders
              .map((grinder) => ({ ...viewGrinderLink(grinder), location: grinder.location ? viewLocation(grinder.location) : null }))
              .sort((a, b) => compareText(a.model, b.model) || compareText(a.location?.name ?? null, b.location?.name ?? null) || a.id.localeCompare(b.id)),
            ...unlinked(grinderIds),
          ],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
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
    const found = await this.prisma.shot.findFirst({ where: { id, ...visible }, omit: { versionAt: true, hasFullRecord: true, ...linkColumns }, include: creditView });
    if (!found) throw shotNotFound();
    const [shot] = await withLinks(this.prisma, [found]);
    return { ...withLocationInferred(shot!), previousShot: await this.previous(shot!) };
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
const batchLink = { id: true, content: true, bean: { select: { id: true, content: true } } } as const satisfies Prisma.BeanBatchSelect;
const grinderLink = { id: true, content: true } as const satisfies Prisma.GrinderSelect;
const creditView = {
  machine: { select: { id: true, name: true } },
  pendingMachine: { select: { id: true, model: true, serial: true } },
  location: { select: { id: true, name: true, timeZone: true } },
  libraryBatch: { select: batchLink },
  libraryGrinder: { select: grinderLink },
} as const;
/** The columns behind a Shot's links, which it shows as the items they link to. */
const linkColumns = { tabletId: true, libraryBatchId: true, libraryGrinderId: true } as const;
const listOmitted = { record: true, versionAt: true, hasFullRecord: true, ...linkColumns } as const;

/** A Library Bean Batch a Shot is linked to: its Bean and roast date, as the Bean Batches list names them. */
export interface BatchLink {
  id: string;
  bean: { id: string; roaster: string | null; name: string | null };
  roastDate: string | null;
}

/** A Library Grinder a Shot is linked to, by its model. */
export interface GrinderLink {
  id: string;
  model: string | null;
}

/** The Library Profile a Shot was pulled with, by its title. */
export interface ProfileLink {
  id: string;
  title: string | null;
}

function viewBatchLink(batch: Prisma.BeanBatchGetPayload<{ select: typeof batchLink }>): BatchLink {
  const bean = object(batch.bean.content);
  return { id: batch.id, bean: { id: batch.bean.id, roaster: string(bean.roaster), name: string(bean.name) }, roastDate: string(object(batch.content).roastDate) };
}

function viewGrinderLink(grinder: Prisma.GrinderGetPayload<{ select: typeof grinderLink }>): GrinderLink {
  return { id: grinder.id, model: string(object(grinder.content).model) };
}

/**
 * The Shots with the Library items they are linked to (links.ts): their
 * Bean Batch and Grinder, stored, and the Profile they were pulled with.
 */
async function withLinks<T extends { id: string; libraryBatch: Prisma.BeanBatchGetPayload<{ select: typeof batchLink }> | null; libraryGrinder: Prisma.GrinderGetPayload<{ select: typeof grinderLink }> | null }>(
  db: Prisma.TransactionClient,
  shots: T[],
): Promise<(Omit<T, "libraryBatch" | "libraryGrinder"> & { beanBatch: BatchLink | null; grinder: GrinderLink | null; profile: ProfileLink | null })[]> {
  const ids = shots.map((shot) => shot.id);
  const profiles = await db.$queryRaw<{ shotId: string; id: string; title: string | null }[]>`
    SELECT s.id AS "shotId", p.id, p.content -> 'profile' ->> 'title' AS title
    FROM shots AS s JOIN profiles AS p ON p.id = ${shotProfileSql("s")} WHERE s.id = ANY(${ids}::text[])`;
  const byShot = new Map(profiles.map(({ shotId, ...profile }) => [shotId, profile]));
  return shots.map(({ libraryBatch, libraryGrinder, ...shot }) => ({
    ...shot,
    beanBatch: libraryBatch ? viewBatchLink(libraryBatch) : null,
    grinder: libraryGrinder ? viewGrinderLink(libraryGrinder) : null,
    profile: byShot.get(shot.id) ?? null,
  }));
}

/** The distinct values listed Shots have of an expression on `shots` aliased `s`, empty text as null, sorted ignoring case. */
function distinct(tx: Prisma.TransactionClient, value: Prisma.Sql) {
  return tx.$queryRaw<{ value: string | null }[]>`
    SELECT ${value} AS value FROM shots s ${listedJoins} WHERE ${listed}
    GROUP BY 1 ORDER BY lower(${value}) NULLS LAST, 1`;
}

/** By Bean name, then roaster, ignoring case, then the latest roast date first, as the Bean Batches list orders them. */
function byBatchName(a: BatchLink, b: BatchLink): number {
  return (
    compareText(a.bean.name, b.bean.name) ||
    compareText(a.bean.roaster, b.bean.roaster) ||
    (a.roastDate === null || b.roastDate === null ? Number(a.roastDate === null) - Number(b.roastDate === null) : b.roastDate.localeCompare(a.roastDate)) ||
    a.id.localeCompare(b.id)
  );
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** A Location credited through an inferred Machine is inferred too. An unknown Location is not. */
function withLocationInferred<T extends { machineInferred: boolean; locationId: string | null }>(shot: T): T & { locationInferred: boolean } {
  return { ...shot, locationInferred: shot.machineInferred && shot.locationId !== null };
}

function shotNotFound() { return new NotFoundException("Shot not found"); }
