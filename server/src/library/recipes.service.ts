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
  /** The items its content names, each with what the management interface names it by (`RecipeUses`). */
  uses: RecipeUses;
  /**
   * Whether it is in a slot and names a Bean Batch that is not at its
   * Location now: finished there, or Archived, as a slotted Recipe whose dial
   * needs the next roast.
   */
  batchFinished: boolean;
}

/**
 * The items a Recipe's content names, by their global ids (a Profile by
 * Decaid's), each with what names it; a field naming none is null, and an
 * item the Library no longer has is named by its id alone.
 */
export interface RecipeUses {
  bean: { id: string; roaster: string | null; name: string | null } | null;
  /** Its Bean Batch, with its roast date as Decaid recorded it, and whether it is at the Recipe's Location now, not Archived. */
  beanBatch: { id: string; roastDate: string | null; atLocation: boolean } | null;
  profile: { id: string; title: string | null } | null;
  grinder: { id: string; model: string | null } | null;
  basket: { id: string; name: string | null } | null;
  tools: { id: string; name: string | null }[];
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
    const uses = await this.uses(rows);
    return rows
      .map((row) => view(row, here, uses))
      .sort((a, b) => compareSlots(a.slot, b.slot) || compareText(a.name, b.name) || a.id.localeCompare(b.id));
  }

  /** A Recipe; 404 for none. */
  async get(id: string): Promise<RecipeView> {
    const [row] = await this.prisma.$queryRaw<RecipeRow[]>`
      SELECT id::text AS id, content, location_id::text AS "locationId", slot, archived, created_at AS "createdAt"
      FROM recipes WHERE id = ${id}::uuid`;
    if (!row) throw notFound();
    const location = row.locationId === null ? null : await this.prisma.location.findUnique({ where: { id: row.locationId } });
    return view(row, location ? viewLocation(location) : null, await this.uses([row]));
  }

  /** What names each item these Recipes' content names, by kind and id, and whether each batch is at the Recipe's Location now. */
  private async uses(rows: readonly RecipeRow[]): Promise<Names> {
    const contents = rows.map((row) => (isObject(row.content) ? row.content : {}));
    const ids = (key: string) => [...new Set(contents.flatMap((content) => (typeof content[key] === "string" ? [content[key] as string] : [])))].filter(isUuid);
    const tools = [...new Set(contents.flatMap((content) => (Array.isArray(content.toolIds) ? content.toolIds : [])))].filter(
      (id): id is string => typeof id === "string" && isUuid(id),
    );
    const profiles = [...new Set(contents.flatMap((content) => (typeof content.profileId === "string" ? [content.profileId] : [])))];
    const named = await this.prisma.$queryRaw<{ kind: string; id: string; first: string | null; second: string | null }[]>`
      SELECT 'bean' AS kind, id::text AS id, content ->> 'roaster' AS first, content ->> 'name' AS second FROM beans WHERE id = ANY(${ids("beanId")}::uuid[])
      UNION ALL SELECT 'beanBatch', id::text, content ->> 'roastDate', NULL FROM bean_batches WHERE id = ANY(${ids("beanBatchId")}::uuid[])
      UNION ALL SELECT 'profile', id, content -> 'profile' ->> 'title', NULL FROM profiles WHERE id = ANY(${profiles}::text[])
      UNION ALL SELECT 'grinder', id::text, content ->> 'model', NULL FROM grinders WHERE id = ANY(${ids("grinderId")}::uuid[])
      UNION ALL SELECT 'basket', id::text, content ->> 'name', NULL FROM baskets WHERE id = ANY(${ids("basketId")}::uuid[])
      UNION ALL SELECT 'tool', id::text, content ->> 'name', NULL FROM tools WHERE id = ANY(${tools}::uuid[])`;
    // Each batch at each Recipe's Location now, neither it nor its Bean Archived.
    const pairs = rows.flatMap((row, index) => {
      const batch = contents[index]!.beanBatchId;
      return row.locationId !== null && typeof batch === "string" && isUuid(batch) ? [{ batch, location: row.locationId }] : [];
    });
    const at = await this.prisma.$queryRaw<{ batch: string; location: string }[]>`
      SELECT here.batch_id::text AS batch, here.location_id::text AS location
      FROM batch_locations AS here
      JOIN bean_batches AS batch ON batch.id = here.batch_id
      JOIN beans AS bean ON bean.id = batch.bean_id
      WHERE (here.batch_id, here.location_id) IN (SELECT * FROM unnest(${pairs.map((pair) => pair.batch)}::uuid[], ${pairs.map((pair) => pair.location)}::uuid[]))
        AND here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived`;
    return {
      names: new Map(named.map((row) => [`${row.kind}:${row.id}`, { first: row.first, second: row.second }])),
      at: new Set(at.map((row) => `${row.batch}@${row.location}`)),
    };
  }
}

/** What names the items Recipes use, by `kind:id`, and each batch at a Location now, by `batch@location`. */
interface Names {
  names: ReadonlyMap<string, { first: string | null; second: string | null }>;
  at: ReadonlySet<string>;
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** A Recipe's id from a path: a UUID. */
export function readRecipeId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound();
  return id;
}

function notFound(): NotFoundException {
  return new NotFoundException("No such Recipe");
}

function view(row: RecipeRow, location: LocationView | null, { names, at }: Names): RecipeView {
  const content = isObject(row.content) ? row.content : {};
  const id = (key: string) => (typeof content[key] === "string" ? (content[key] as string) : null);
  // A Profile's id is Decaid's, kept as it is; the others are UUIDs.
  const name = (kind: string, itemId: string) => names.get(`${kind}:${kind === "profile" ? itemId : itemId.toLowerCase()}`);
  const named = <T>(kind: string, key: string, make: (itemId: string, found: { first: string | null; second: string | null } | undefined) => T): T | null => {
    const itemId = id(key);
    return itemId === null ? null : make(itemId, name(kind, itemId));
  };
  const beanBatch = named("beanBatch", "beanBatchId", (itemId, found) => ({
    id: itemId,
    roastDate: found?.first ?? null,
    atLocation: row.locationId !== null && at.has(`${itemId.toLowerCase()}@${row.locationId}`),
  }));
  const uses: RecipeUses = {
    bean: named("bean", "beanId", (itemId, found) => ({ id: itemId, roaster: found?.first ?? null, name: found?.second ?? null })),
    beanBatch,
    profile: named("profile", "profileId", (itemId, found) => ({ id: itemId, title: found?.first ?? null })),
    grinder: named("grinder", "grinderId", (itemId, found) => ({ id: itemId, model: found?.first ?? null })),
    basket: named("basket", "basketId", (itemId, found) => ({ id: itemId, name: found?.first ?? null })),
    tools: (Array.isArray(content.toolIds) ? content.toolIds : [])
      .filter((tool): tool is string => typeof tool === "string")
      .map((tool) => ({ id: tool, name: name("tool", tool)?.first ?? null })),
  };
  return {
    id: row.id,
    name: typeof content.name === "string" && content.name !== "" ? content.name : null,
    location,
    slot: row.slot,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    content,
    uses,
    batchFinished: row.slot !== null && beanBatch !== null && !beanBatch.atLocation,
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
