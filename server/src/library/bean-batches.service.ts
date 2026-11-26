import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Scope } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { type SourceView, viewSource, withSource } from "./history.service.js";

/** A Bean Batch at a Location, as the REST API lists it. */
export interface BatchAtLocation {
  location: LocationView;
  /**
   * Its Remaining Weight there, in grams, worked out as it is read
   * (ADR-0037): the weight last entered there, less the dose of each Shot
   * linked to the batch that was pulled there since, and never below zero.
   * Null where it is untracked: no weight was entered there, or it was
   * cleared.
   */
  remainingWeight: number | null;
  /** The weight last entered there, which the count starts from, with when and who entered it, where that is known; null where it is untracked. */
  entered: { weight: number; at: string; by: SourceView | null } | null;
  /** The Shots linked to the batch pulled there since that weight was entered, and the coffee they used, in grams; null where it is untracked. */
  used: { shots: number; weight: number } | null;
  /** When it was last added there, by the edit's time: a tablet's edit by its clock. A tablet adding it again while it is there moves it. */
  since: string;
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
  /** The Locations it was at and has been finished at since, by name, with when and the weight last entered there, which went with it. */
  finished: { location: LocationView; remainingWeight: number | null; finishedAt: string }[];
}

const withPlaces = {
  bean: { select: { id: true, content: true } },
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
    const holding =
      batchCode === undefined
        ? undefined
        : (
            await this.prisma.$queryRaw<{ id: string }[]>`
              SELECT id::text AS id FROM bean_batches WHERE lower(btrim(content ->> 'batchCode')) = lower(btrim(${batchCode.trim()}::text))`
          ).map((batch) => batch.id);
    return sorted(await this.summaries(await this.prisma.beanBatch.findMany({ ...(holding ? { where: { id: { in: holding } } } : {}), include: withPlaces }), scope));
  }

  /** The Bean's batches, the latest roasted first. */
  async ofBean(beanId: string, scope: Scope): Promise<BeanBatchSummary[]> {
    return sorted(await this.summaries(await this.prisma.beanBatch.findMany({ where: { beanId }, include: withPlaces }), scope));
  }

  async get(id: string, scope: Scope): Promise<BeanBatchView> {
    const batch = await this.prisma.beanBatch.findUnique({ where: { id }, include: withPlaces });
    if (!batch) throw new NotFoundException("No such Bean Batch");
    const finished = batch.locations
      .flatMap((here) =>
        here.addedAt !== null && here.finishedAt !== null
          ? [{ location: viewLocation(here.location), remainingWeight: here.remainingWeight, finishedAt: here.finishedAt.toISOString() }]
          : [],
      )
      .sort((a, b) => a.location.name.localeCompare(b.location.name));
    return { ...(await this.summaries([batch], scope))[0]!, content: object(batch.content), finished };
  }

  /**
   * The batches as lists show them, each Location's Remaining Weight worked
   * out from the Shots pulled there since its weight was entered: read for
   * all of them at once, in one query for the Shots and one for who entered
   * the weights, however many batches there are.
   */
  private async summaries(batches: ListedBatch[], scope: Scope): Promise<BeanBatchSummary[]> {
    const entries = batches.flatMap((batch) => batch.locations.flatMap((here) => (tracked(here) ? [{ batchId: batch.id, locationId: here.locationId, at: here.remainingWeightAt }] : [])));
    const versionIds = batches.flatMap((batch) => batch.locations.flatMap((here) => (tracked(here) && here.remainingWeightVersionId !== null ? [here.remainingWeightVersionId] : [])));
    const [used, versions] = await Promise.all([
      usedSince(this.prisma, entries),
      versionIds.length === 0 ? [] : this.prisma.itemVersion.findMany({ where: { id: { in: versionIds } }, include: withSource }),
    ]);
    const enteredBy = new Map(versions.map((version) => [version.id, viewSource(version, scope)]));
    return batches.map((batch) => summary(batch, used, enteredBy));
  }
}

/** A Location's state of a batch that has it there with a weight entered: tracked there. */
function tracked(here: ListedBatch["locations"][number]): here is ListedBatch["locations"][number] & { addedAt: Date; remainingWeight: number; remainingWeightAt: Date } {
  return here.addedAt !== null && here.finishedAt === null && here.remainingWeight !== null && here.remainingWeightAt !== null;
}

/** The Shots that count against a weight entered, and the coffee they used, unrounded, so that only what is shown is rounded. */
interface Used {
  shots: number;
  weight: number;
}

/**
 * What the Shots pulled at each Location since the batch's weight was
 * entered there used, by `usedKey`, for the weights entered given, each
 * with the time it was entered as the batch's row was read (ADR-0037).
 * The time is taken from that read, not looked up again, so a weight
 * entered in between is never paired with the Shots of another. Every
 * Shot linked to the batch whose Location is that one and that was pulled
 * after the entry, Unfinished Shots and Trial Shots among them, each by its
 * measured dose, else the dose its Workflow was set to, else nothing. A Shot
 * with no Location, or pulled where the batch has no weight, is in none.
 * Nothing is kept: a Shot edited, linked to another batch, deleted or
 * arriving late changes the answer the next time it is read.
 */
export async function usedSince(
  db: Pick<Prisma.TransactionClient, "$queryRaw">,
  entries: readonly { batchId: string; locationId: string; at: Date }[],
): Promise<Map<string, Used>> {
  if (entries.length === 0) return new Map();
  const rows = await db.$queryRaw<{ batchId: string; locationId: string; shots: number; weight: number }[]>`
    SELECT here.batch_id::text AS "batchId", here.location_id::text AS "locationId", count(*)::integer AS shots,
      COALESCE(sum(COALESCE(shot.actual_dose, shot.target_dose, 0)), 0)::double precision AS weight
    FROM unnest(${entries.map((entry) => entry.batchId)}::uuid[], ${entries.map((entry) => entry.locationId)}::uuid[], ${entries.map((entry) => entry.at)}::timestamptz[])
      AS here(batch_id, location_id, entered_at)
    JOIN shots AS shot ON shot.library_batch_id = here.batch_id AND shot.location_id = here.location_id AND shot.pulled_at > here.entered_at
    GROUP BY here.batch_id, here.location_id`;
  return new Map(rows.map((row) => [usedKey(row.batchId, row.locationId), { shots: row.shots, weight: row.weight }]));
}

export function usedKey(batchId: string, locationId: string): string {
  return `${batchId} ${locationId}`;
}

/** A weight entered less what Shots have used since, never below zero: a weight entered too low reads zero, and finishes nothing. */
export function remainingAfter(entered: number, used: number): number {
  return Math.max(0, grams(entered - used));
}

/** A weight to the tenth of a gram, as doses are measured, so a sum of them shows no floating-point remainder. */
function grams(weight: number): number {
  return Math.round(weight * 10) / 10;
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

function summary(batch: ListedBatch, used: ReadonlyMap<string, Used>, enteredBy: ReadonlyMap<string, SourceView>): BeanBatchSummary {
  const bean = object(batch.bean.content);
  const content = object(batch.content);
  const locations = batch.locations
    .flatMap((here): BatchAtLocation[] => {
      if (here.addedAt === null || here.finishedAt !== null) return [];
      const place = { location: viewLocation(here.location), since: here.addedAt.toISOString() };
      if (!tracked(here)) return [{ ...place, remainingWeight: null, entered: null, used: null }];
      const since = used.get(usedKey(batch.id, here.locationId)) ?? { shots: 0, weight: 0 };
      const by = here.remainingWeightVersionId === null ? null : (enteredBy.get(here.remainingWeightVersionId) ?? null);
      return [
        {
          ...place,
          remainingWeight: remainingAfter(here.remainingWeight, since.weight),
          entered: { weight: here.remainingWeight, at: here.remainingWeightAt.toISOString(), by },
          used: { shots: since.shots, weight: grams(since.weight) },
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

/** Decaid's times, the latest first, with none last. */
function latestFirst(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return b.localeCompare(a);
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
