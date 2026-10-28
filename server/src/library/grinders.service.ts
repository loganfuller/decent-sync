import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";

/** A Grinder as the REST API lists it. */
export interface GrinderSummary {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  /** Its model, burrs and burr type, from its content; null where its content has none. */
  model: string | null;
  burrs: string | null;
  burrType: string | null;
  archived: boolean;
  /**
   * The Location it belongs to (ADR-0008): where it was created, and the only
   * one offering it, unless it is Archived. Null if that Location no longer
   * exists.
   */
  location: LocationView | null;
  /** When it joined the Library, by PostgreSQL's clock. */
  createdAt: string;
}

/** A Grinder with its content, as the REST API returns one. */
export interface GrinderView extends GrinderSummary {
  /** Decaid's record fields, as the tablet that created it sent them, those this server does not know included. */
  content: Record<string, unknown>;
}

const withLocation = { location: true } as const satisfies Prisma.GrinderInclude;

type ListedGrinder = Prisma.GrinderGetPayload<{ include: typeof withLocation }>;

/** The Library's Grinders, which Staff read as Admins do. Grinders join it from tablets (`library/grinders.ts`). */
@Injectable()
export class GrindersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every Grinder, by model, ignoring case, then by its Location's name. */
  async list(): Promise<GrinderSummary[]> {
    return (await this.prisma.grinder.findMany({ include: withLocation }))
      .map(summary)
      .sort((a, b) => compareText(a.model, b.model) || compareText(a.location?.name ?? null, b.location?.name ?? null) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<GrinderView> {
    const grinder = await this.prisma.grinder.findUnique({ where: { id }, include: withLocation });
    if (!grinder) throw grinderNotFound();
    return { ...summary(grinder), content: object(grinder.content) };
  }
}

/** A Grinder id from a path. */
export function readGrinderId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw grinderNotFound();
  return id;
}

function grinderNotFound(): NotFoundException {
  return new NotFoundException("No such Grinder");
}

function summary(grinder: ListedGrinder): GrinderSummary {
  const content = object(grinder.content);
  return {
    id: grinder.id,
    model: text(content.model),
    burrs: text(content.burrs),
    burrType: text(content.burrType),
    archived: grinder.archived,
    location: grinder.location ? viewLocation(grinder.location) : null,
    createdAt: grinder.createdAt.toISOString(),
  };
}

function object(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
