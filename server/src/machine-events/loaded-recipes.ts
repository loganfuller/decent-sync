import { loadedRecipeOf } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { currentEntry } from "../library/joining.js";

// Each Machine's Loaded Recipe (ADR-0022): the plugin works out which Recipe
// its Workflow has loaded and records the Recipe's global id in it
// (LOADED_RECIPE_KEY), so the server reads it from the Workflow deliveries
// milestone 1 captures, keeping each Machine's current Loaded Recipe and its
// history (`loaded_recipes`).

/** A Recipe as a Machine's Loaded Recipe names it. */
export interface LoadedRecipeItemView {
  id: string;
  name: string | null;
  /** Its Recipe Slot at its Location now, or null for none. */
  slot: number | null;
  locationId: string | null;
  archived: boolean;
}

/** A Machine's Loaded Recipe, or one it had: the Recipe, from when, and until when, null while it has it. */
export interface LoadedRecipeView {
  id: string;
  recipe: LoadedRecipeItemView;
  /** When the plugin observed the Workflow naming it, by the tablet's clock. */
  loadedAt: string;
  unloadedAt: string | null;
}

/**
 * Takes the Loaded Recipe a Workflow names into its Machine's state, in the
 * transaction storing the delivery from the Machine's own tablet, under its
 * row lock, after the Location's lock and the tablet's, as a hard delete of
 * the Recipe takes them before the Recipe's row: one of the Recipes of the
 * Machine's Location, while it takes part in the Library there, and none
 * otherwise, as on a Capture-only Machine, or one a Workflow names from the
 * Location the Machine left. A Machine's Loaded Recipe that differs from it
 * is unloaded then, and the Recipe the Workflow names is loaded from then.
 * Then is when the plugin observed the Workflow, by the tablet's clock,
 * which a delivery made while it was offline keeps, but never before the
 * Machine's latest entry, as when its tablet's clock jumped back.
 */
export async function takeInLoadedRecipe(tx: Prisma.TransactionClient, machineId: string, workflow: unknown, observedAt: string): Promise<void> {
  const named = loadedRecipeOf(workflow);
  const entry = named === null ? null : await currentEntry(tx, machineId);
  // Keyed share: a hard delete of the Recipe waits for this, and this for it.
  const [recipe] =
    named === null || entry === null
      ? []
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM recipes WHERE id = ${named}::uuid AND location_id = ${entry.locationId}::uuid FOR KEY SHARE`;
  const recipeId = recipe?.id ?? null;
  const [current] = await tx.$queryRaw<{ recipeId: string }[]>`
    SELECT recipe_id::text AS "recipeId" FROM loaded_recipes WHERE machine_id = ${machineId}::uuid AND unloaded_at IS NULL`;
  if ((current?.recipeId ?? null) === recipeId) return;
  const [latest] = await tx.$queryRaw<{ at: Date }[]>`
    SELECT GREATEST(${observedAt}::timestamptz, (SELECT GREATEST(loaded_at, unloaded_at) FROM loaded_recipes WHERE machine_id = ${machineId}::uuid ORDER BY id DESC LIMIT 1)) AS at`;
  const at = latest!.at;
  if (current) await tx.$executeRaw`UPDATE loaded_recipes SET unloaded_at = ${at} WHERE machine_id = ${machineId}::uuid AND unloaded_at IS NULL`;
  if (recipeId !== null) {
    await tx.$executeRaw`INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES (${machineId}::uuid, ${recipeId}::uuid, ${at})`;
  }
}

/** Each Machine's Loaded Recipe now, of those given, by Machine; a Machine with none is left out. */
export async function currentLoadedRecipes(prisma: Prisma.TransactionClient, machineIds: readonly string[]): Promise<Map<string, LoadedRecipeView>> {
  if (machineIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<LoadedRow[]>`
    ${SELECT_LOADED} WHERE l.machine_id = ANY(${[...machineIds]}::uuid[]) AND l.unloaded_at IS NULL`;
  return new Map(rows.map((row) => [row.machineId, viewLoaded(row)]));
}

/** The Machine's Loaded Recipes, latest first: its current one, if any, then those it had before. */
export async function loadedRecipeHistory(prisma: Prisma.TransactionClient, machineId: string, page: { limit: number; offset: number }) {
  const [rows, [counted]] = await Promise.all([
    prisma.$queryRaw<LoadedRow[]>`${SELECT_LOADED} WHERE l.machine_id = ${machineId}::uuid ORDER BY l.id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
    prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM loaded_recipes WHERE machine_id = ${machineId}::uuid`,
  ]);
  return { entries: rows.map(viewLoaded), total: counted?.total ?? 0, ...page };
}

interface LoadedRow {
  id: bigint;
  machineId: string;
  recipeId: string;
  name: unknown;
  slot: number | null;
  locationId: string | null;
  archived: boolean;
  loadedAt: Date;
  unloadedAt: Date | null;
}

const SELECT_LOADED = Prisma.sql`
  SELECT l.id, l.machine_id::text AS "machineId", r.id::text AS "recipeId", r.content -> 'name' AS name, r.slot,
    r.location_id::text AS "locationId", r.archived, l.loaded_at AS "loadedAt", l.unloaded_at AS "unloadedAt"
  FROM loaded_recipes AS l JOIN recipes AS r ON r.id = l.recipe_id`;

function viewLoaded(row: LoadedRow): LoadedRecipeView {
  return {
    id: row.id.toString(),
    recipe: { id: row.recipeId, name: typeof row.name === "string" ? row.name : null, slot: row.slot, locationId: row.locationId, archived: row.archived },
    loadedAt: row.loadedAt.toISOString(),
    unloadedAt: row.unloadedAt?.toISOString() ?? null,
  };
}
