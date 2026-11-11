import { Injectable, NotFoundException } from "@nestjs/common";
import { type ShotDelivery, type ShotIndex, isRecordId, shotSamples } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { viewLocation } from "../locations/locations.service.js";
import { creditHardware, creditReporter } from "../machines/credit.js";
import { creditShotLocation } from "../machines/location-history.js";
import { PrismaService } from "../prisma.service.js";
import type { Reporter } from "../sync/identity.js";
import { CURVES_REVISION, extractCurves, extractShot, measuredDetails, recordedDetails, recordingSeconds, shownDuration, object, shotHardware, shotVersion, string } from "./extraction.js";
import { type ShotFilters, baristaNamesSql, shotFilterSql } from "./filters.js";
import { claimListed, resolveLinks, shotProfileSql, shotRecipeSql } from "./links.js";
import { DEFAULT_NUMBERS, type Grouping, type NumberName, type ShotSummary, summarise } from "./summary.js";

/** Advisory lock class for one Shot id; distinct from the server's other lock classes. */
const SHOT_LOCK = 4_000_003;

/** Metadata and curves are deliberately separate queries: lists never read curves, and a detail read reads them once, in a query of their own. */
@Injectable()
export class ShotsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a Shot delivery, unless it is not a record Decaid v0.9.0 or later
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
      const [stored] = await tx.$queryRaw<{ record: Prisma.JsonObject; hasFullRecord: boolean; newer: boolean }[]>`
        SELECT record, has_full_record AS "hasFullRecord", ${version}::timestamptz > version_at AS newer
        FROM shots WHERE id = ${message.shotId}`;
      if (stored && !stored.newer && (!full || stored.hasFullRecord)) return;

      // Every delivery carries complete metadata, so the newer one is kept
      // whole. A full record older than an early edit only adds its curves.
      const reported = !stored || stored.newer;
      const record = reported ? incoming : stored.record;
      const { recipeRecordId, ...metadata } = extractShot(record);
      // The pull time needs the curves too, so it is set with them; edits never load or rewrite them,
      // so they leave the values computed from them as they are, whoever computed them (CurvesRefresh).
      const curves = full ? extractCurves(record, measurements) : null;
      // The first full record credits the Shot, with its Machine's row locked, and sets the pull time
      // its Location is credited by. Later records change neither, so they cannot race a change to
      // that Machine's Location History, or the adoption of a Pending Machine's Shot.
      const credit = full && !stored?.hasFullRecord ? await this.credit(tx, incoming, reporter) : null;
      // Its ids are the reporting tablet's, so they resolve through its map, after the Machine's row lock credit takes.
      const links = reported ? { tabletId: reporter.tabletId, ...(await resolveLinks(tx, reporter.tabletId, message.shotId, { ...metadata, recipeRecordId })) } : null;
      const data = {
        ...metadata,
        ...links,
        ...(curves && storedCurves(curves, !stored?.hasFullRecord)),
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
      // The Recipe it is linked to is not hard-deleted until the Shot is stored, which the delete then finds linked to it:
      // whatever this delivery stores, as a full record after an early edit sets the Machine and time the link reads.
      await tx.$queryRaw`SELECT 1 FROM recipes WHERE id = (SELECT ${shotRecipeSql("s")} FROM shots AS s WHERE s.id = ${message.shotId}) FOR KEY SHARE`;
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
   * the server cannot store is never requested. Those stored without a
   * tablet take this one, which holds them, and are linked (`claimListed`).
   */
  async requested(index: ShotIndex, machineId: string, tabletId: string): Promise<string[]> {
    const offered = index.shots.filter((shot) => isRecordId(shot.id));
    if (offered.length === 0) return [];
    const ids = offered.map((shot) => shot.id);
    await this.prisma.$transaction((tx) => claimListed(tx, tabletId, ids));
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
        const details = await recordedDetailsOf(tx, rows.map((row) => row.id));
        const byId = new Map(rows.map((row) => [row.id, { ...row, ...details.get(row.id)! }]));
        return { page: ids.flatMap((row) => byId.get(row.id) ?? []), total: count!.total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return { shots: page.map(shownShot), total, limit, offset };
  }

  /**
   * The Shot Summary of the Shots `list` lists for the same filters, grouped
   * by `groupBy`, with the `numbers` named: a page of its groups
   * (summary.ts).
   */
  summary(filters: ShotFilters = {}, groupBy: readonly Grouping[] = [], page = { limit: 20, offset: 0 }, numbers: readonly NumberName[] = DEFAULT_NUMBERS): Promise<ShotSummary> {
    return summarise(this.prisma, listedFrom, shotFilterSql(filters), groupBy, page, numbers);
  }

  /**
   * The Beans, Baristas and profiles listed Shots recorded, for choosing
   * filters, each as recorded and sorted ignoring case, and the Bean
   * Batches, Grinders, Recipes and Baskets they are linked to. A Barista is
   * given once, whatever the case of the name or the blanks around it, by
   * its most recent spelling (`baristaNamesSql`), as the Barista filter
   * finds every spelling. Null stands for the Shots that recorded none, or
   * are linked to none: a Bean names neither roaster nor name, and a
   * Barista's name may be blank.
   */
  async filterOptions() {
    return this.prisma.$transaction(
      async (tx) => {
        const [beans, baristas, profiles, batchIds, grinderIds, recipeIds, basketIds] = await Promise.all([
          tx.$queryRaw<{ coffeeRoaster: string | null; coffeeName: string | null }[]>`
            SELECT nullif(s.coffee_roaster, '') AS "coffeeRoaster", nullif(s.coffee_name, '') AS "coffeeName"
            FROM shots s ${listedJoins} WHERE ${listed} GROUP BY 1, 2
            ORDER BY lower(nullif(s.coffee_roaster, '')) NULLS LAST, lower(nullif(s.coffee_name, '')) NULLS LAST, 1, 2`,
          tx.$queryRaw<{ name: string | null }[]>(baristaNamesSql(listedFrom)),
          distinct(tx, Prisma.raw("nullif(s.profile_title, '')")),
          distinct(tx, Prisma.raw("s.library_batch_id::text")),
          distinct(tx, Prisma.raw("s.library_grinder_id::text")),
          distinct(tx, Prisma.sql`(${shotRecipeSql("s")})::text`),
          distinct(tx, Prisma.raw("s.library_basket_id::text")),
        ]);
        const linked = (rows: { value: string | null }[]) => rows.flatMap((row) => (row.value === null ? [] : [row.value]));
        const unlinked = (rows: { value: string | null }[]) => (rows.some((row) => row.value === null) ? [null] : []);
        const [batches, grinders, recipes, baskets] = await Promise.all([
          tx.beanBatch.findMany({ where: { id: { in: linked(batchIds) } }, select: batchLink }),
          tx.grinder.findMany({ where: { id: { in: linked(grinderIds) } }, select: { ...grinderLink, location: true } }),
          tx.recipe.findMany({ where: { id: { in: linked(recipeIds) } }, select: { ...recipeLink, location: true } }),
          tx.basket.findMany({ where: { id: { in: linked(basketIds) } }, select: basketLink }),
        ]);
        return {
          beans,
          baristas: baristas.map((row) => row.name),
          profiles: profiles.map((row) => row.value),
          beanBatches: [...batches.map(viewBatchLink).sort(byBatchName), ...unlinked(batchIds)],
          grinders: [
            ...grinders
              .map((grinder) => ({ ...viewGrinderLink(grinder), location: grinder.location ? viewLocation(grinder.location) : null }))
              .sort((a, b) => compareText(a.model, b.model) || compareText(a.location?.name ?? null, b.location?.name ?? null) || a.id.localeCompare(b.id)),
            ...unlinked(grinderIds),
          ],
          recipes: [
            ...recipes
              .map((recipe) => ({ ...viewRecipeLink(recipe), location: recipe.location ? viewLocation(recipe.location) : null }))
              .sort((a, b) => compareText(a.name, b.name) || compareText(a.location?.name ?? null, b.location?.name ?? null) || a.id.localeCompare(b.id)),
            ...unlinked(recipeIds),
          ],
          baskets: [...baskets.map(viewBasketLink).sort((a, b) => compareText(a.name, b.name) || a.id.localeCompare(b.id)), ...unlinked(basketIds)],
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

  /** A Shot as `GET /api/shots/:id` shows it (`read`). */
  async get(id: string) {
    return (await this.read(id)).shot;
  }

  /**
   * A Shot as `GET /api/shots/:id` shows it, with what its record and its
   * samples show beyond its columns (`recordedDetails`, `measuredDetails`),
   * and those samples (`shotSamples`), from one read of its measurements,
   * which get_shot also draws its curves from. Its steps, the one it ended
   * in and the scale's last weight are read from those samples, so a Shot
   * has them before its stored values are worked out (`measuredValues`);
   * its time to first drip and its flow at the stop are the stored ones,
   * null until then.
   */
  async read(id: string) {
    const found = await this.prisma.shot.findFirst({ where: { id, ...visible }, omit: readOmitted, include: creditView });
    if (!found) throw shotNotFound();
    const [shot] = await withLinks(this.prisma, [found]);
    const [measurements, previousShot] = await Promise.all([
      this.prisma.shotMeasurements.findUnique({ where: { shotId: id }, select: { data: true } }),
      this.previous(shot!),
    ]);
    const samples = shotSamples(measurements?.data ?? null, object(object(found.record).workflow).profile);
    return { shot: { ...shownShot(shot!), ...recordedDetails(found.record), ...measuredDetails(samples), previousShot }, samples };
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

/**
 * What a full record's curves store on its Shot (`extractCurves`), at the
 * current revision: its Preheat and peaks, what its samples show of how it
 * went (`measuredValues`), and the whole recording as its duration
 * (`recordingSeconds`); and its pull time, from its first full record alone.
 */
function storedCurves({ pulledAt, ...curves }: ReturnType<typeof extractCurves>, first: boolean) {
  return { ...(first && { pulledAt }), ...curves, duration: recordingSeconds(curves), curvesRevision: CURVES_REVISION };
}

const visible: Prisma.ShotWhereInput = {
  hasFullRecord: true,
  OR: [{ machineId: { not: null } }, { pendingMachine: { dismissedAt: null } }],
};
/** `visible` in SQL, for `shots` aliased `s` with `listedJoins`, which also joins its Location as `l` for filters. */
const listed = Prisma.sql`s.has_full_record AND (s.machine_id IS NOT NULL OR (p.id IS NOT NULL AND p.dismissed_at IS NULL))`;
const listedJoins = Prisma.sql`LEFT JOIN pending_machines p ON p.id = s.pending_machine_id LEFT JOIN locations l ON l.id = s.location_id`;
/** The rest of a query of every listed Shot, from its `FROM` on, to narrow with `AND`. */
const listedFrom = Prisma.sql`FROM shots s ${listedJoins} WHERE ${listed}`;
const batchLink = { id: true, content: true, bean: { select: { id: true, content: true } } } as const satisfies Prisma.BeanBatchSelect;
const grinderLink = { id: true, content: true } as const satisfies Prisma.GrinderSelect;
const basketLink = { id: true, content: true } as const satisfies Prisma.BasketSelect;
const recipeLink = { id: true, content: true } as const satisfies Prisma.RecipeSelect;
const creditView = {
  machine: { select: { id: true, name: true } },
  pendingMachine: { select: { id: true, model: true, serial: true } },
  location: { select: { id: true, name: true, timeZone: true } },
  libraryBatch: { select: batchLink },
  libraryGrinder: { select: grinderLink },
  libraryBasket: { select: basketLink },
} as const;
/** The columns behind a Shot's links, which it shows as the items they link to. */
const linkColumns = { tabletId: true, libraryBatchId: true, libraryGrinderId: true, libraryBasketId: true, libraryToolIds: true, recipeId: true } as const;
/**
 * What no read gives of a Shot. Of what its samples show (`measuredValues`),
 * whether it poured is kept for Shot Summaries to count Unfinished Shots by
 * (`UNFINISHED` in summary.ts), and the scale's last weight is read from its
 * samples where it is given (`ShotsService.read`).
 */
const readOmitted = { versionAt: true, hasFullRecord: true, curvesRevision: true, poured: true, lastWeight: true, lastWeightSeconds: true, ...linkColumns } as const;
/** A list leaves out the record too, and the flow at the stop. */
const listOmitted = { ...readOmitted, record: true, flowAtStop: true } as const;

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

/** The Library Recipe a Shot was pulled with, or a Basket it used, by its name. */
export interface NamedLink {
  id: string;
  name: string | null;
}

function viewBatchLink(batch: Prisma.BeanBatchGetPayload<{ select: typeof batchLink }>): BatchLink {
  const bean = object(batch.bean.content);
  return { id: batch.id, bean: { id: batch.bean.id, roaster: string(bean.roaster), name: string(bean.name) }, roastDate: string(object(batch.content).roastDate) };
}

function viewGrinderLink(grinder: Prisma.GrinderGetPayload<{ select: typeof grinderLink }>): GrinderLink {
  return { id: grinder.id, model: string(object(grinder.content).model) };
}

function viewBasketLink(basket: Prisma.BasketGetPayload<{ select: typeof basketLink }>): NamedLink {
  return { id: basket.id, name: string(object(basket.content).name) };
}

function viewRecipeLink(recipe: Prisma.RecipeGetPayload<{ select: typeof recipeLink }>): NamedLink {
  return { id: recipe.id, name: string(object(recipe.content).name) };
}

/**
 * The Shots with the Library items they are linked to (links.ts): their
 * Bean Batch, Grinder and Basket, stored, and the Profile and Recipe they
 * were pulled with.
 */
async function withLinks<
  T extends {
    id: string;
    libraryBatch: Prisma.BeanBatchGetPayload<{ select: typeof batchLink }> | null;
    libraryGrinder: Prisma.GrinderGetPayload<{ select: typeof grinderLink }> | null;
    libraryBasket: Prisma.BasketGetPayload<{ select: typeof basketLink }> | null;
  },
>(
  db: Prisma.TransactionClient,
  shots: T[],
): Promise<
  (Omit<T, "libraryBatch" | "libraryGrinder" | "libraryBasket"> & {
    beanBatch: BatchLink | null;
    grinder: GrinderLink | null;
    basket: NamedLink | null;
    profile: ProfileLink | null;
    recipe: NamedLink | null;
  })[]
> {
  const ids = shots.map((shot) => shot.id);
  const [profiles, recipes] = await Promise.all([
    db.$queryRaw<{ shotId: string; id: string; title: string | null }[]>`
      SELECT s.id AS "shotId", p.id, p.content -> 'profile' ->> 'title' AS title
      FROM shots AS s JOIN profiles AS p ON p.id = ${shotProfileSql("s")} WHERE s.id = ANY(${ids}::text[])`,
    db.$queryRaw<{ shotId: string; id: string; name: string | null }[]>`
      SELECT s.id AS "shotId", r.id::text AS id, r.content ->> 'name' AS name
      FROM shots AS s JOIN recipes AS r ON r.id = ${shotRecipeSql("s")} WHERE s.id = ANY(${ids}::text[])`,
  ]);
  const profileOf = new Map(profiles.map(({ shotId, ...profile }) => [shotId, profile]));
  const recipeOf = new Map(recipes.map(({ shotId, ...recipe }) => [shotId, recipe]));
  return shots.map(({ libraryBatch, libraryGrinder, libraryBasket, ...shot }) => ({
    ...shot,
    beanBatch: libraryBatch ? viewBatchLink(libraryBatch) : null,
    grinder: libraryGrinder ? viewGrinderLink(libraryGrinder) : null,
    basket: libraryBasket ? viewBasketLink(libraryBasket) : null,
    profile: profileOf.get(shot.id) ?? null,
    recipe: recipeOf.get(shot.id) ?? null,
  }));
}

/**
 * What each Shot recorded beyond its columns (`recordedDetails`), by its id,
 * read from only the parts of its record that hold it.
 */
async function recordedDetailsOf(db: Prisma.TransactionClient, ids: string[]): Promise<Map<string, ReturnType<typeof recordedDetails>>> {
  if (ids.length === 0) return new Map();
  const parts = await db.$queryRaw<{ id: string; stopReason: unknown; context: unknown; annotations: unknown }[]>`
    SELECT id, record -> 'stopReason' AS "stopReason", record #> '{workflow,context}' AS context, record -> 'annotations' AS annotations
    FROM shots WHERE id = ANY(${ids}::text[])`;
  return new Map(parts.map(({ id, stopReason, context, annotations }) => [id, recordedDetails({ stopReason, annotations, workflow: { context } })]));
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

/**
 * A Shot as it is shown. A Location credited through an inferred Machine is
 * inferred too; an unknown Location is not. Its duration leaves its Preheat
 * out (`shownDuration`). The step it ended in, as stored, is one value, null
 * where it ended in none or until it is worked out.
 */
function shownShot<
  T extends { machineInferred: boolean; locationId: string | null; duration: number | null; preheat: number | null; lastStepFrame: number | null; lastStepName: string | null },
>(shot: T): Omit<T, "preheat" | "lastStepFrame" | "lastStepName"> & { locationInferred: boolean; lastStep: { frame: number; name: string } | null } {
  const { preheat, lastStepFrame, lastStepName, ...shown } = shot;
  return {
    ...shown,
    duration: shownDuration(shot.duration, preheat),
    locationInferred: shot.machineInferred && shot.locationId !== null,
    lastStep: lastStepFrame !== null && lastStepName !== null ? { frame: lastStepFrame, name: lastStepName } : null,
  };
}

function shotNotFound() { return new NotFoundException("Shot not found"); }
