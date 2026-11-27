import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Scope } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { type SourceView, viewSource, withSource } from "./history.service.js";
import { type Count, type Moved, NOT_MOVED, type Used, countKey, grams, movedSince, remainingAfter, usedSince } from "./remaining-weight.js";

/** A Bean Batch at a Location, as the REST API lists it. */
export interface BatchAtLocation {
  location: LocationView;
  /**
   * Its Remaining Weight there, in grams, worked out as it is read
   * (ADR-0037): the weight its count there starts from, less the dose of
   * each Shot linked to the batch that was pulled there since, plus what
   * Batch Moves have brought there since, less what they have taken away,
   * and never below zero. Null where it is untracked: no weight was entered
   * there and none arrived by a move, or it was cleared.
   */
  remainingWeight: number | null;
  /**
   * The weight its count there starts from, with when: the weight last
   * entered there, and who entered it, where that is known, or, for a count
   * that started with a Batch Move, the amount that arrived, who moved it,
   * and the Location it arrived from (`arrivedFrom`, null for a weight
   * entered). Null where it is untracked.
   */
  entered: { weight: number; at: string; by: SourceView | null; arrivedFrom: LocationView | null } | null;
  /** The Shots linked to the batch pulled there since its count started, and the coffee they used, in grams; null where it is untracked. */
  used: { shots: number; weight: number } | null;
  /**
   * What Batch Moves have brought there (`in`) and taken from there (`away`)
   * since its count started, in grams, each with the amounts by the other
   * Location (`from`, `to`); null where it is untracked.
   */
  moved: { in: number; from: MovedWith[]; away: number; to: MovedWith[] } | null;
  /** When it was last added there, by the edit's time: a tablet's edit by its clock. A tablet adding it again while it is there moves it. */
  since: string;
}

/** An amount moved between a Location and another since its count started, in grams, by that other Location. */
export interface MovedWith {
  location: LocationView;
  weight: number;
}

/** A Bean Batch as the REST API lists it. */
export interface BeanBatchSummary {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  /** The Bean it is a roast of. */
  bean: { id: string; roaster: string | null; name: string | null };
  /** Its roast date, from its content, as Decaid recorded it; null where its content has none. */
  roastDate: string | null;
  /** Its Batch Code, the roaster's own identifier for it, from its content; null where it has none. */
  batchCode: string | null;
  archived: boolean;
  /** The Locations it is at (ADR-0008), by name, each with its remaining weight there. */
  locations: BatchAtLocation[];
  /** The sum of its remaining weights over the Locations that track it, in grams; null where none does. */
  totalRemainingWeight: number | null;
  /** When it joined the Library, by PostgreSQL's clock. */
  createdAt: string;
  /** The Location of the tablet that created it, if it still exists. */
  createdLocation: LocationView | null;
}

/** A Bean Batch with its content, as the REST API returns one. */
export interface BeanBatchView extends BeanBatchSummary {
  /**
   * Decaid's record fields, as the tablet that created it sent them, those
   * this server does not know included, but `archived` and
   * `weightRemaining`, which are each Location's.
   */
  content: Record<string, unknown>;
  /** The Locations it was at and has been finished at since, by name, with when and the weight its count there last started from, which went with it: zero where a Batch Move took all of it. */
  finished: { location: LocationView; remainingWeight: number | null; finishedAt: string }[];
  /** Whether its Bean is Archived, which takes it out of every Location as its own `archived` does (#732). */
  beanArchived: boolean;
  /**
   * The Recipes, not Archived, whose content names it, at any Location,
   * whether or not it is there now: by their Location's name, then in slot
   * order, then by name, ignoring case. One naming another batch of its
   * Bean is not among them.
   */
  recipes: BatchRecipe[];
}

/** A Recipe that names a batch, as the batch's page lists it. */
export interface BatchRecipe {
  id: string;
  /** Its name, from its content; null where its content has none. */
  name: string | null;
  /** The Location it belongs to, if it still exists. */
  location: LocationView | null;
  /** Its Recipe Slot at its Location, or null for none. */
  slot: number | null;
  /** Its dose, in grams, from its content; null for none, as for one of 0 (`RECIPE_NONE_AT_ZERO`). */
  dose: number | null;
  /** Its yield, in grams, from its content; null for none. */
  yield: number | null;
  /**
   * Whether the batch is not at the Recipe's Location now, as
   * `RecipeView.batchFinished` says of it: finished there, moved away from
   * it entirely, or Archived, it or its Bean.
   */
  batchFinished: boolean;
}

/** A Recipe at a Location that names a batch there, as the Location's list of batches gives it. */
export interface RecipeHere {
  id: string;
  /** Its name, from its content; null where its content has none. */
  name: string | null;
  /** Its Recipe Slot at the Location, or null for none. */
  slot: number | null;
}

/**
 * A Bean Batch at one Location, as that Location's list of batches gives it:
 * what names it, and that Location's own state of it, its Remaining Weight
 * there, what its count there starts from, and the Shots pulled and the
 * Batch Moves made there since, none of any other Location's.
 */
export interface BatchHere extends Omit<BatchAtLocation, "location"> {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  /** The Bean it is a roast of. */
  bean: { id: string; roaster: string | null; name: string | null };
  /** Its roast date, from its content, as Decaid recorded it; null where its content has none. */
  roastDate: string | null;
  /** Its Batch Code; null where it has none. */
  batchCode: string | null;
  /** The Recipes at the Location, not Archived, that name it: in slot order, then those in no slot, by name, ignoring case. */
  recipes: RecipeHere[];
}

const withPlaces = {
  bean: { select: { id: true, content: true, archived: true } },
  createdLocation: true,
  locations: { include: { location: true } },
} as const satisfies Prisma.BeanBatchInclude;

type ListedBatch = Prisma.BeanBatchGetPayload<{ include: typeof withPlaces }>;

/** The Library's Bean Batches, which Staff read as Admins do. Batches join it from tablets (`library/bean-batches.ts`). */
@Injectable()
export class BeanBatchesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every Bean Batch, by its Bean's name and roaster, ignoring case, then the
   * latest roasted first; or, with a Batch Code, those holding exactly it,
   * ignoring case and the spaces around it, compared in the database as the
   * index that keeps a code to one batch compares them (`refuseTakenCode`):
   * at most one that is not Archived, and any Archived that held it.
   */
  async list(scope: Scope, batchCode?: string): Promise<BeanBatchSummary[]> {
    return this.read(async (db) => {
      const holding =
        batchCode === undefined
          ? undefined
          : (
              await db.$queryRaw<{ id: string }[]>`
                SELECT id::text AS id FROM bean_batches WHERE lower(btrim(content ->> 'batchCode')) = lower(btrim(${batchCode.trim()}::text))`
            ).map((batch) => batch.id);
      return sorted(await this.summaries(db, await db.beanBatch.findMany({ ...(holding ? { where: { id: { in: holding } } } : {}), include: withPlaces }), scope));
    });
  }

  /** The Bean's batches, the latest roasted first. */
  async ofBean(beanId: string, scope: Scope): Promise<BeanBatchSummary[]> {
    return this.read(async (db) => sorted(await this.summaries(db, await db.beanBatch.findMany({ where: { beanId }, include: withPlaces }), scope)));
  }

  /**
   * The Bean Batches at the Location, each with the Location's own state of
   * it and the Recipes there that name it: those added there and not
   * finished there, neither Archived nor of an Archived Bean, as no Location
   * offers those (LIBRARY.md); the latest roasted first, then by Bean name
   * and roaster, ignoring case. 404 for no such Location. Read as a list is
   * (`summaries`), with one more query for the Recipes of them all, so with
   * no query per batch.
   */
  async atLocation(locationId: string, scope: Scope): Promise<{ location: LocationView; batches: BatchHere[] }> {
    return this.read(async (db) => {
      const location = await db.location.findUnique({ where: { id: locationId } });
      if (!location) throw new NotFoundException("No such Location");
      const batches = await this.summaries(
        db,
        await db.beanBatch.findMany({
          where: { archived: false, bean: { archived: false }, locations: { some: { locationId, addedAt: { not: null }, finishedAt: null } } },
          include: withPlaces,
        }),
        scope,
      );
      const ids = batches.map((batch) => batch.id);
      const naming =
        ids.length === 0
          ? []
          : await db.$queryRaw<(RecipeHere & { batchId: string })[]>`
              SELECT id::text AS id, NULLIF(content ->> 'name', '') AS name, slot, lower(content ->> 'beanBatchId') AS "batchId"
              FROM recipes
              WHERE location_id = ${locationId}::uuid AND NOT archived AND lower(content ->> 'beanBatchId') = ANY(${ids}::text[])`;
      const here = batches.flatMap((batch): BatchHere[] => {
        const state = batch.locations.find((each) => each.location.id === locationId);
        if (!state) return [];
        const { location: _, ...rest } = state;
        const recipes = naming
          .filter((recipe) => recipe.batchId === batch.id)
          .map(({ id, name, slot }) => ({ id, name, slot }))
          .sort((a, b) => compareSlots(a.slot, b.slot) || compareText(a.name, b.name) || a.id.localeCompare(b.id));
        return [{ id: batch.id, bean: batch.bean, roastDate: batch.roastDate, batchCode: batch.batchCode, ...rest, recipes }];
      });
      return {
        location: viewLocation(location),
        batches: here.sort(
          (a, b) => latestFirst(a.roastDate, b.roastDate) || compareText(a.bean.name, b.bean.name) || compareText(a.bean.roaster, b.bean.roaster) || a.id.localeCompare(b.id),
        ),
      };
    });
  }

  async get(id: string, scope: Scope): Promise<BeanBatchView> {
    return this.read(async (db) => {
      const batch = await db.beanBatch.findUnique({ where: { id }, include: withPlaces });
      if (!batch) throw new NotFoundException("No such Bean Batch");
      const finished = batch.locations
        .flatMap((here) =>
          here.addedAt !== null && here.finishedAt !== null
            ? [{ location: viewLocation(here.location), remainingWeight: here.remainingWeight, finishedAt: here.finishedAt.toISOString() }]
            : [],
        )
        .sort((a, b) => a.location.name.localeCompare(b.location.name));
      const view = (await this.summaries(db, [batch], scope))[0]!;
      const naming = await db.$queryRaw<{ id: string; content: Prisma.JsonValue; locationId: string | null; slot: number | null }[]>`
        SELECT id::text AS id, content, location_id::text AS "locationId", slot
        FROM recipes WHERE lower(content ->> 'beanBatchId') = ${batch.id.toLowerCase()} AND NOT archived`;
      const elsewhere = [...new Set(naming.flatMap((recipe) => (recipe.locationId === null ? [] : [recipe.locationId])))];
      const places = new Map((elsewhere.length === 0 ? [] : await db.location.findMany({ where: { id: { in: elsewhere } } })).map((location) => [location.id, viewLocation(location)]));
      const offered = !batch.archived && !batch.bean.archived;
      const recipes = naming
        .map((recipe): BatchRecipe => {
          const held = object(recipe.content);
          return {
            id: recipe.id,
            name: typeof held.name === "string" && held.name !== "" ? held.name : null,
            location: recipe.locationId === null ? null : (places.get(recipe.locationId) ?? null),
            slot: recipe.slot,
            dose: amount(held.dose) || null,
            yield: amount(held.yield),
            batchFinished: !(offered && view.locations.some((here) => here.location.id === recipe.locationId)),
          };
        })
        .sort((a, b) => compareText(a.location?.name ?? null, b.location?.name ?? null) || compareSlots(a.slot, b.slot) || compareText(a.name, b.name) || a.id.localeCompare(b.id));
      return { ...view, content: object(batch.content), finished, beanArchived: batch.bean.archived, recipes };
    });
  }

  /**
   * Reads in one snapshot (REPEATABLE READ): the batches' Locations, the
   * Shots and the Batch Moves since each count started, so a move committed
   * while they are read is in all of them or none, and a total read as one
   * is made is the one before it or the one after it, never short of what
   * one Location gave and the other had not yet been read to have.
   */
  private read<T>(fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /**
   * The batches as lists show them, each Location's Remaining Weight worked
   * out from the Shots pulled there and the Batch Moves made since its count
   * started: read for all of them at once, in one query for the Shots, one
   * for the moves and one for who started the counts, however many batches
   * there are.
   */
  private async summaries(db: Prisma.TransactionClient, batches: ListedBatch[], scope: Scope): Promise<BeanBatchSummary[]> {
    const counts = batches.flatMap((batch) =>
      batch.locations.flatMap((here): Count[] => (tracked(here) ? [{ batchId: batch.id, locationId: here.locationId, at: here.remainingWeightAt, versionId: here.remainingWeightVersionId }] : [])),
    );
    const versionIds = counts.flatMap((count) => (count.versionId === null ? [] : [count.versionId]));
    // One after another, as a transaction's queries go over its one connection.
    const used = await usedSince(db, counts);
    const moved = await movedSince(db, counts);
    const versions = versionIds.length === 0 ? [] : await db.itemVersion.findMany({ where: { id: { in: versionIds } }, include: withSource });
    const startedBy = new Map(versions.map((version) => [version.id, viewSource(version, scope)]));
    return batches.map((batch) => summary(batch, used, moved, startedBy));
  }
}

/** A Location's state of a batch that has it there with a weight its count starts from: tracked there. */
function tracked(here: ListedBatch["locations"][number]): here is ListedBatch["locations"][number] & { addedAt: Date; remainingWeight: number; remainingWeightAt: Date } {
  return here.addedAt !== null && here.finishedAt === null && here.remainingWeight !== null && here.remainingWeightAt !== null;
}

/** The Batch Code a list is asked for by, from a request's query: `batchCode`, or undefined where it gives none. 400 for one given more than once. */
export function readBatchCodeFilter(query: Record<string, unknown>): string | undefined {
  const { batchCode } = query;
  if (batchCode === undefined || batchCode === "") return undefined;
  if (typeof batchCode !== "string") throw new BadRequestException("Give one batchCode");
  return batchCode;
}

/** A Bean Batch id from a path. */
export function readBeanBatchId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException("No such Bean Batch");
  return id;
}

function summary(batch: ListedBatch, used: ReadonlyMap<string, Used>, moved: ReadonlyMap<string, Moved>, startedBy: ReadonlyMap<string, SourceView>): BeanBatchSummary {
  const bean = object(batch.bean.content);
  const content = object(batch.content);
  // Every Location a move of the batch names has a row of its state here, finished or not, while it exists.
  const named = new Map(batch.locations.map((here) => [here.locationId, viewLocation(here.location)]));
  const withLocations = (amounts: Moved["from"]): MovedWith[] =>
    amounts.flatMap(({ locationId, weight }) => {
      const location = locationId === null ? undefined : named.get(locationId);
      return location ? [{ location, weight: grams(weight) }] : [];
    });
  const locations = batch.locations
    .flatMap((here): BatchAtLocation[] => {
      if (here.addedAt === null || here.finishedAt !== null) return [];
      const place = { location: viewLocation(here.location), since: here.addedAt.toISOString() };
      if (!tracked(here)) return [{ ...place, remainingWeight: null, entered: null, used: null, moved: null }];
      const key = countKey(batch.id, here.locationId);
      const since = used.get(key) ?? { shots: 0, weight: 0 };
      const moves = moved.get(key) ?? NOT_MOVED;
      const by = here.remainingWeightVersionId === null ? null : (startedBy.get(here.remainingWeightVersionId) ?? null);
      const arrivedFrom = moves.startedBy?.fromLocationId == null ? null : (named.get(moves.startedBy.fromLocationId) ?? null);
      return [
        {
          ...place,
          remainingWeight: remainingAfter(here.remainingWeight, since.weight, moves),
          entered: { weight: here.remainingWeight, at: here.remainingWeightAt.toISOString(), by, arrivedFrom },
          used: { shots: since.shots, weight: grams(since.weight) },
          moved: { in: grams(moves.in), from: withLocations(moves.from), away: grams(moves.away), to: withLocations(moves.to) },
        },
      ];
    })
    .sort((a, b) => a.location.name.localeCompare(b.location.name));
  const weights = locations.flatMap((here) => (here.remainingWeight === null ? [] : [here.remainingWeight]));
  return {
    id: batch.id,
    bean: { id: batch.bean.id, roaster: text(bean.roaster), name: text(bean.name) },
    roastDate: text(content.roastDate),
    batchCode: text(content.batchCode),
    archived: batch.archived,
    locations,
    totalRemainingWeight: weights.length === 0 ? null : grams(weights.reduce((sum, weight) => sum + weight, 0)),
    createdAt: batch.createdAt.toISOString(),
    createdLocation: batch.createdLocation ? viewLocation(batch.createdLocation) : null,
  };
}

/** By Bean name, then roaster, ignoring case, then the latest roast date first, then the newest. */
function sorted(batches: BeanBatchSummary[]): BeanBatchSummary[] {
  return batches.sort(
    (a, b) =>
      compareText(a.bean.name, b.bean.name) ||
      compareText(a.bean.roaster, b.bean.roaster) ||
      latestFirst(a.roastDate, b.roastDate) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

function object(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A number of grams a Recipe's content holds; null for none. */
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Decaid's times, the latest first, with none last. */
function latestFirst(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return b.localeCompare(a);
}

/** Slots in order, with none last. */
function compareSlots(a: number | null, b: number | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a - b;
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
