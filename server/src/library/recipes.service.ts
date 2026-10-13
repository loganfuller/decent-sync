import { Injectable, NotFoundException } from "@nestjs/common";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { isObject } from "./listed.js";

/** A Recipe as the REST API returns it. */
export interface RecipeView {
  id: string;
  /** Its name, from its content; null where its content has none. */
  name: string | null;
  /** The Location it belongs to, if it still exists. */
  location: LocationView | null;
  /** Its Recipe Slot at its Location, or null for none. */
  slot: number | null;
  archived: boolean;
  /** When it joined the Library, by PostgreSQL's clock. */
  createdAt: string;
  /**
   * What it holds, in the Library's terms: `name`, `beverage`, `beanId`,
   * `beanBatchId`, `profileId`, `grinderId`, `basketId`, `toolIds` and
   * `toolAttributes` (a Tool's attributes for this Recipe, by the Tool's id),
   * `dose`, `yield`, `ratio`, `grindSetting`, `rpm`, `brewTemperature`,
   * `showOnDashboard`, `hotWaterVolume`, `hotWaterTemperature`,
   * `hotWaterDuration`, `hotWaterFlow`, `steamMode` and `hotWaterMode`, each
   * left out where it holds none.
   */
  content: Record<string, unknown>;
}

interface RecipeRow {
  id: string;
  content: unknown;
  locationId: string | null;
  slot: number | null;
  archived: boolean;
  createdAt: Date;
}

/** The Library's Recipes (ADR-0005), which Staff read as Admins do. They join it from tablets (`library/recipes.ts`). */
@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The Location's Recipes: those in its slots, in slot order, then the rest, by name, ignoring case; 404 for no such Location. */
  async atLocation(locationId: string): Promise<RecipeView[]> {
    const location = await this.prisma.location.findUnique({ where: { id: locationId } });
    if (!location) throw new NotFoundException("No such Location");
    const rows = await this.prisma.$queryRaw<RecipeRow[]>`
      SELECT id::text AS id, content, location_id::text AS "locationId", slot, archived, created_at AS "createdAt"
      FROM recipes WHERE location_id = ${locationId}::uuid`;
    const here = viewLocation(location);
    return rows
      .map((row) => view(row, here))
      .sort((a, b) => compareSlots(a.slot, b.slot) || compareText(a.name, b.name) || a.id.localeCompare(b.id));
  }

  /** A Recipe; 404 for none. */
  async get(id: string): Promise<RecipeView> {
    const [row] = await this.prisma.$queryRaw<RecipeRow[]>`
      SELECT id::text AS id, content, location_id::text AS "locationId", slot, archived, created_at AS "createdAt"
      FROM recipes WHERE id = ${id}::uuid`;
    if (!row) throw notFound();
    const location = row.locationId === null ? null : await this.prisma.location.findUnique({ where: { id: row.locationId } });
    return view(row, location ? viewLocation(location) : null);
  }
}

/** A Recipe's id from a path: a UUID. */
export function readRecipeId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound();
  return id;
}

function notFound(): NotFoundException {
  return new NotFoundException("No such Recipe");
}

function view(row: RecipeRow, location: LocationView | null): RecipeView {
  const content = isObject(row.content) ? row.content : {};
  return {
    id: row.id,
    name: typeof content.name === "string" && content.name !== "" ? content.name : null,
    location,
    slot: row.slot,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    content,
  };
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
