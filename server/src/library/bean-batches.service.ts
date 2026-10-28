import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";

/** A Bean Batch at a Location, as the REST API lists it. */
export interface BatchAtLocation {
  location: LocationView;
  /** The remaining weight entered there last, in grams: null if none was, or it was cleared. */
  remainingWeight: number | null;
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
  archived: boolean;
  /** The Locations it is at (ADR-0008), by name, each with its remaining weight there. */
  locations: BatchAtLocation[];
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
  /** The Locations it was at and has been finished at since, by name, with when and the remaining weight there last entered. */
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

  /** Every Bean Batch, by its Bean's name and roaster, ignoring case, then the latest roasted first. */
  async list(): Promise<BeanBatchSummary[]> {
    return sorted((await this.prisma.beanBatch.findMany({ include: withPlaces })).map(summary));
  }

  /** The Bean's batches, the latest roasted first. */
  async ofBean(beanId: string): Promise<BeanBatchSummary[]> {
    return sorted((await this.prisma.beanBatch.findMany({ where: { beanId }, include: withPlaces })).map(summary));
  }

  async get(id: string): Promise<BeanBatchView> {
    const batch = await this.prisma.beanBatch.findUnique({ where: { id }, include: withPlaces });
    if (!batch) throw new NotFoundException("No such Bean Batch");
    const finished = batch.locations
      .flatMap((here) =>
        here.addedAt !== null && here.finishedAt !== null
          ? [{ location: viewLocation(here.location), remainingWeight: here.remainingWeight, finishedAt: here.finishedAt.toISOString() }]
          : [],
      )
      .sort((a, b) => a.location.name.localeCompare(b.location.name));
    return { ...summary(batch), content: object(batch.content), finished };
  }
}

/** A Bean Batch id from a path. */
export function readBeanBatchId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException("No such Bean Batch");
  return id;
}

function summary(batch: ListedBatch): BeanBatchSummary {
  const bean = object(batch.bean.content);
  const content = object(batch.content);
  return {
    id: batch.id,
    bean: { id: batch.bean.id, roaster: text(bean.roaster), name: text(bean.name) },
    roastDate: text(content.roastDate),
    archived: batch.archived,
    locations: batch.locations
      .flatMap((here) =>
        here.addedAt !== null && here.finishedAt === null
          ? [{ location: viewLocation(here.location), remainingWeight: here.remainingWeight, since: here.addedAt.toISOString() }]
          : [],
      )
      .sort((a, b) => a.location.name.localeCompare(b.location.name)),
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
