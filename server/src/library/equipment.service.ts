import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import type { EquipmentKind } from "./equipment.js";
import { KINDS } from "./kinds.js";

/** A Basket or Tool as the REST API lists it. */
export interface EquipmentSummary {
  id: string;
  /** Its name, from its content; null where its content has none. */
  name: string | null;
  archived: boolean;
  /**
   * The Locations showing it (ADR-0008), by name, each with when the
   * Location last decided to show it, by PostgreSQL's clock. None while it is
   * Archived.
   */
  shownAt: { location: LocationView; since: string }[];
  /** When it joined the Library, by PostgreSQL's clock. */
  createdAt: string;
  /** The Location it was created at, by a tablet there or in the management interface, if it still exists. */
  createdLocation: LocationView | null;
  /**
   * DYE2's record fields, as the tablet that created it sent them, those this
   * server does not know included, as edited since: a few short fields, so
   * the lists show them.
   */
  content: Record<string, unknown>;
}

/** A Basket or Tool with where it is shown, as the REST API returns one. */
export interface EquipmentView extends EquipmentSummary {
  /**
   * Each Location that has decided whether it shows it, by name: whether it
   * is shown there, and when that was last decided, by PostgreSQL's clock.
   * Kept while it is Archived. A Location not listed does not show it.
   */
  locations: { location: LocationView; shown: boolean; since: string }[];
}

interface ItemRow {
  id: string;
  content: unknown;
  archived: boolean;
  createdAt: Date;
  createdLocationId: string | null;
}

interface PlaceRow {
  itemId: string;
  locationId: string;
  shown: boolean;
  decidedAt: Date;
}

/** Where each kind's Locations' showing of it is kept. */
const SHOWN: Readonly<Record<EquipmentKind, { table: string; column: string }>> = {
  basket: { table: "basket_locations", column: "basket_id" },
  tool: { table: "tool_locations", column: "tool_id" },
};

/** The Library's Baskets and Tools, which Staff read as Admins do. They join it from tablets (`library/equipment.ts`), or are created in the management interface. */
@Injectable()
export class EquipmentService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every item of the kind, by name, ignoring case. */
  async list(kind: EquipmentKind): Promise<EquipmentSummary[]> {
    const items = await this.prisma.$queryRaw<ItemRow[]>`
      SELECT id::text AS id, content, archived, created_at AS "createdAt", created_location_id::text AS "createdLocationId"
      FROM ${Prisma.raw(KINDS[kind].table)}`;
    const places = await this.places(kind, null);
    const locations = await this.locations(items, places);
    return items.map((item) => summary(item, places, locations)).sort((a, b) => compareText(a.name, b.name) || a.id.localeCompare(b.id));
  }

  async get(kind: EquipmentKind, id: string): Promise<EquipmentView> {
    const [item] = await this.prisma.$queryRaw<ItemRow[]>`
      SELECT id::text AS id, content, archived, created_at AS "createdAt", created_location_id::text AS "createdLocationId"
      FROM ${Prisma.raw(KINDS[kind].table)} WHERE id = ${id}::uuid`;
    if (!item) throw notFound(kind);
    const places = await this.places(kind, item.id);
    const locations = await this.locations([item], places);
    return {
      ...summary(item, places, locations),
      locations: places
        .map((here) => ({ location: locations.get(here.locationId)!, shown: here.shown, since: here.decidedAt.toISOString() }))
        .sort((a, b) => a.location.name.localeCompare(b.location.name)),
    };
  }

  /** Each Location's decision of whether it shows the kind's items, or the one item's. */
  private async places(kind: EquipmentKind, id: string | null): Promise<PlaceRow[]> {
    const { table, column } = SHOWN[kind];
    const only = id === null ? Prisma.empty : Prisma.sql`WHERE ${Prisma.raw(column)} = ${id}::uuid`;
    return this.prisma.$queryRaw<PlaceRow[]>`
      SELECT ${Prisma.raw(column)}::text AS "itemId", location_id::text AS "locationId", shown, decided_at AS "decidedAt"
      FROM ${Prisma.raw(table)} ${only}`;
  }

  /** The Locations the items and their places name, by id. */
  private async locations(items: readonly ItemRow[], places: readonly PlaceRow[]): Promise<Map<string, LocationView>> {
    const ids = [...new Set([...places.map((here) => here.locationId), ...items.flatMap((item) => (item.createdLocationId === null ? [] : [item.createdLocationId]))])];
    const rows = ids.length === 0 ? [] : await this.prisma.location.findMany({ where: { id: { in: ids } } });
    return new Map(rows.map((location) => [location.id, viewLocation(location)]));
  }
}

/** A Basket's or Tool's id from a path: a UUID. */
export function readEquipmentId(kind: EquipmentKind, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound(kind);
  return id;
}

function notFound(kind: EquipmentKind): NotFoundException {
  return new NotFoundException(`No such ${KINDS[kind].name}`);
}

function summary(item: ItemRow, places: readonly PlaceRow[], locations: ReadonlyMap<string, LocationView>): EquipmentSummary {
  const name = object(item.content).name;
  return {
    id: item.id,
    name: typeof name === "string" ? name : null,
    archived: item.archived,
    shownAt: item.archived
      ? []
      : places
          .filter((here) => here.itemId === item.id && here.shown)
          .map((here) => ({ location: locations.get(here.locationId)!, since: here.decidedAt.toISOString() }))
          .sort((a, b) => a.location.name.localeCompare(b.location.name)),
    createdAt: item.createdAt.toISOString(),
    createdLocation: item.createdLocationId === null ? null : (locations.get(item.createdLocationId) ?? null),
    content: object(item.content),
  };
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
