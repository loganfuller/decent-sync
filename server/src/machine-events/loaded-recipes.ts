import { LOADED_RECIPE_FIELD, LOADED_RECIPE_KIND, LOADED_RECIPE_PARTS, type LoadedRecipePart, loadedRecipeOf } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { editContent } from "../library/content-edits.js";
import { tabletSource } from "../library/history.js";
import type { PlannedWrite } from "../library/holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet, sharingLocation } from "../library/intake.js";
import type { CurrentEntry } from "../library/join-plan.js";
import { isObject } from "../library/listed.js";
import {
  type ItemKind,
  PARTS,
  type PartLookups,
  RECIPE_FIELDS,
  type StaleCheck,
  type WorkflowParts,
  changedParts,
  partEdits,
  partsWrite,
  readParts,
  recipeParts,
  workflowParts,
} from "../library/loaded-recipe-intake.js";
import { lockLocation, transactionTime } from "../library/location-state.js";
import { latestDecision, readFieldEdits } from "../library/merge.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";

// Each Machine's Loaded Recipe (ADR-0022): the plugin works out which Recipe
// its Workflow has loaded and records the Recipe's global id in it
// (LOADED_RECIPE_KEY), so the server reads it from the Workflow deliveries
// milestone 1 captures, keeping each Machine's current Loaded Recipe and its
// history (`loaded_recipes`). A Machine follows its Loaded Recipe both ways
// (ticket #146): a change on it of a part of its Workflow that follows the
// Recipe (LOADED_RECIPE_PARTS) is an edit of the Recipe, and an edit of the
// Recipe from anywhere is written into the Workflow of every Machine that
// has it loaded, each tablet's Workflow as it last held them kept in
// `tablet_loaded_recipes`, as `tablet_settings` keeps the settings, so the
// plugin's own write is never read as the tablet's edit (loaded-recipe-intake.ts).
// A Workflow naming a Recipe its Machine does not have loaded, as one taken
// out of its slot or Archived, or of a Location it left, or on a Machine
// made capture-only, has it cleared.

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
 * row lock and the tablet's (`takeInWorkflow` in location-settings.ts), as
 * the tablet's report of where it takes part (`entry`, null while its
 * Machine is capture-only), joining it or not: one of the Recipes in a slot
 * of the Machine's Location, while it takes part in the Library there, and
 * none otherwise, as on a Capture-only Machine, or one a Workflow names that
 * was taken out of its slot or Archived, or is of the Location the Machine
 * left. A Machine's Loaded Recipe that differs from it is unloaded then, and
 * the Recipe the Workflow names is loaded from then. Then is when the plugin
 * observed the Workflow, by the tablet's clock, which a delivery made while
 * it was offline keeps, but never before the Machine's latest entry, as when
 * its tablet's clock jumped back. The Recipe's row is locked after the
 * Location's lock, which a Recipe's slots, its edits and its hard delete
 * take before it. Then the Workflow's parts that follow the Recipe are taken
 * in (`followMachine`).
 */
export async function takeInLoadedRecipe(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  observedAt: string,
  entry: CurrentEntry | null,
  joining: boolean,
): Promise<void> {
  const named = loadedRecipeOf(workflow);
  let recipe: FollowedRecipe | null = null;
  if (named !== null && entry !== null) {
    await lockLocation(tx, entry.locationId);
    const [row] = await tx.$queryRaw<(FollowedRecipe & { slot: number | null; archived: boolean })[]>`
      SELECT id::text AS id, location_id::text AS "locationId", slot, archived, content
      FROM recipes WHERE id = ${named}::uuid AND location_id = ${entry.locationId}::uuid FOR NO KEY UPDATE`;
    if (row && row.slot !== null && !row.archived) recipe = { id: row.id, locationId: row.locationId, content: isObject(row.content) ? row.content : {} };
  }
  const recipeId = recipe?.id ?? null;
  const [current] = await tx.$queryRaw<{ recipeId: string }[]>`
    SELECT recipe_id::text AS "recipeId" FROM loaded_recipes WHERE machine_id = ${tablet.machineId}::uuid AND unloaded_at IS NULL`;
  const loadedBefore = current?.recipeId ?? null;
  if (loadedBefore !== recipeId) {
    const [latest] = await tx.$queryRaw<{ at: Date }[]>`
      SELECT GREATEST(${observedAt}::timestamptz, (SELECT GREATEST(loaded_at, unloaded_at) FROM loaded_recipes WHERE machine_id = ${tablet.machineId}::uuid ORDER BY id DESC LIMIT 1)) AS at`;
    const at = latest!.at;
    if (current) await tx.$executeRaw`UPDATE loaded_recipes SET unloaded_at = ${at} WHERE machine_id = ${tablet.machineId}::uuid AND unloaded_at IS NULL`;
    if (recipeId !== null) {
      await tx.$executeRaw`INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES (${tablet.machineId}::uuid, ${recipeId}::uuid, ${at})`;
    }
  }
  await followMachine(tx, tablet, workflow, named, recipe, loadedBefore === recipeId && !joining, new Date(observedAt));
}

/** A Recipe a Machine has loaded, as its edits read it: its Location and content. */
interface FollowedRecipe {
  id: string;
  locationId: string;
  content: Record<string, unknown>;
}

/** The Loaded Recipe a tablet's Workflow last named, as `tablet_loaded_recipes` keeps it. */
interface HeldLoadedRecipe {
  recipeId: string;
  held: WorkflowParts;
  pending: Pending;
  contentSeenAt: Date | null;
}

/** The parts naming a Basket or Bean Batch the tablet's map did not hold yet, each with the tablet's id for it and when it was observed. */
type Pending = Partial<Record<LoadedRecipePart, { localId: string; at: string }>>;

async function heldLoadedRecipe(tx: Prisma.TransactionClient, tabletId: string): Promise<HeldLoadedRecipe | null> {
  const [row] = await tx.$queryRaw<{ recipeId: string; held: unknown; pending: unknown; contentSeenAt: Date | null }[]>`
    SELECT recipe_id::text AS "recipeId", held, pending, content_seen_at AS "contentSeenAt" FROM tablet_loaded_recipes WHERE tablet_id = ${tabletId}::uuid`;
  if (!row) return null;
  return { recipeId: row.recipeId, held: readParts(row.held), pending: readPending(row.pending), contentSeenAt: row.contentSeenAt };
}

function readPending(value: unknown): Pending {
  if (!isObject(value)) return {};
  const pending: Pending = {};
  for (const part of PARTS) {
    const kept = value[part];
    if (isObject(kept) && typeof kept.localId === "string" && typeof kept.at === "string") pending[part] = { localId: kept.localId, at: kept.at };
  }
  return pending;
}

/**
 * Saves the Loaded Recipe the tablet's Workflow names, with its parts as the
 * Workflow holds them, and the latest edit of the Recipe it has seen: the
 * later of the one known, for the same Recipe, and `contentSeen`.
 */
async function saveHeld(
  tx: Prisma.TransactionClient,
  tabletId: string,
  recipeId: string,
  held: WorkflowParts,
  pending: Pending,
  contentSeen: Date | null,
): Promise<void> {
  const kept = Object.keys(pending).length === 0 ? null : JSON.stringify(pending);
  await tx.$executeRaw`
    INSERT INTO tablet_loaded_recipes AS known (tablet_id, recipe_id, held, pending, content_seen_at)
    VALUES (${tabletId}::uuid, ${recipeId}::uuid, ${JSON.stringify(held)}::jsonb, ${kept}::jsonb, ${contentSeen}::timestamptz)
    ON CONFLICT (tablet_id) DO UPDATE SET
      held = EXCLUDED.held, pending = EXCLUDED.pending,
      content_seen_at = CASE WHEN known.recipe_id = EXCLUDED.recipe_id
        THEN GREATEST(known.content_seen_at, EXCLUDED.content_seen_at) ELSE EXCLUDED.content_seen_at END,
      recipe_id = EXCLUDED.recipe_id`;
}

/**
 * Takes in the parts of a Workflow the tablet reported that follow its
 * Loaded Recipe (ADR-0022). A Workflow naming none forgets the one it named.
 * One naming the Recipe its Machine went on having loaded (`recipe`, its
 * Loaded Recipe, and `continued`, as before this Workflow, not as the tablet
 * joins its Location) is the tablet's edit of it in each part it changed
 * since it last held them (`takeInParts`). Any other, as a load, or a Recipe
 * its Machine has not loaded, is held as it is: a Recipe's fields that
 * differ from it are written into the Workflow, as a load from a stale copy
 * needs, or the Recipe is cleared from it (`loadedRecipeDue`). A load has
 * seen what the tablet's record of the Recipe had seen, which it was applied
 * from.
 */
async function followMachine(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  named: string | null,
  recipe: FollowedRecipe | null,
  continued: boolean,
  observedAt: Date,
): Promise<void> {
  if (named === null) {
    await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
    return;
  }
  const now = workflowParts(workflow);
  const known = await heldLoadedRecipe(tx, tablet.tabletId);
  if (recipe !== null && continued && known?.recipeId === named) {
    await takeInParts(tx, tablet, recipe, known, now, observedAt, new Set());
    return;
  }
  const [record] =
    recipe === null
      ? []
      : await tx.$queryRaw<{ contentSeenAt: Date | null }[]>`
          SELECT content_seen_at AS "contentSeenAt" FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${named}::uuid`;
  await saveHeld(tx, tablet.tabletId, named, now, {}, record?.contentSeenAt ?? null);
}

/**
 * Takes in the parts the Workflow holds (`now`) otherwise than the tablet's
 * Workflow last held them (`known`), but those `written`, as the tablet's
 * edit of its Loaded Recipe (`followed`), made at `at`, but for a part
 * naming a Basket or batch the map gained since it was observed, made then;
 * one the map does not hold yet waits for it. Saves what the Workflow holds
 * from now on, and tells every instance when the Location's tablets are to
 * be written. Returns whether the edit lost to one it had not seen.
 */
async function takeInParts(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  followed: FollowedRecipe,
  known: HeldLoadedRecipe,
  now: WorkflowParts,
  at: Date,
  written: ReadonlySet<LoadedRecipePart>,
): Promise<boolean> {
  const changed = changedParts(known.held, now).filter((part) => !written.has(part));
  const held: WorkflowParts = { ...known.held };
  for (const part of written) held[part] = now[part];
  const pending: Pending = {};
  if (changed.length === 0) {
    await saveHeld(tx, tablet.tabletId, followed.id, held, pending, null);
    return false;
  }
  const lookups = await partLookups(tx, tablet.tabletId);
  const stale = await staleCheck(tx, tablet.tabletId, followed, changed);
  const source = tabletSource(tablet);
  // A part the map gained since the Workflow named it was changed when it was observed, decided before the rest.
  const timed = changed.map((part) => {
    const waiting = known.pending[part];
    return { part, at: waiting !== undefined && waiting.localId === now[part] ? new Date(waiting.at) : at };
  });
  let lost = false;
  let writesDue = false;
  let content = followed.content;
  for (const time of [...new Set(timed.map((entry) => entry.at.getTime()))].sort((a, b) => a - b)) {
    const parts = timed.filter((entry) => entry.at.getTime() === time).map((entry) => entry.part);
    const edits = partEdits(parts, now, content, lookups, stale);
    for (const part of edits.taken) held[part] = now[part];
    for (const part of edits.unmapped) pending[part] = known.pending[part]?.localId === now[part] ? known.pending[part]! : { localId: String(now[part]), at: at.toISOString() };
    if (edits.taken.length > 0) writesDue = true;
    if (Object.keys(edits.values).length === 0) continue;
    const edited = await editContent(tx, { kind: "recipe", id: followed.id }, { values: edits.values, at: new Date(time), seenAt: known.contentSeenAt }, source);
    lost = lost || edited.lost;
    content = await recipeContent(tx, followed.id);
  }
  await saveHeld(tx, tablet.tabletId, followed.id, held, pending, null);
  // Its other tablets are written the Recipe, and so are the Workflows that have it loaded, this one's included where a
  // part was set back or lost.
  if (writesDue) await notify(tx, "library_changes", followed.locationId);
  return lost;
}

/** A Recipe's content now, read in the transaction. */
async function recipeContent(tx: Prisma.TransactionClient, recipeId: string): Promise<Record<string, unknown>> {
  const [row] = await tx.$queryRaw<{ content: unknown }[]>`SELECT content FROM recipes WHERE id = ${recipeId}::uuid`;
  return isObject(row?.content) ? row.content : {};
}

/** What the tablet's map and the Library say of the Baskets and Bean Batches a Workflow names (`PartLookups`). */
async function partLookups(tx: Prisma.TransactionClient, tabletId: string): Promise<PartLookups> {
  const rows = await tx.$queryRaw<{ kind: ItemKind; itemId: string; localId: string; beanId: string | null }[]>`
    SELECT 'basket' AS kind, basket_id::text AS "itemId", local_id AS "localId", NULL::text AS "beanId" FROM tablet_baskets WHERE tablet_id = ${tabletId}::uuid
    UNION ALL
    SELECT 'beanBatch', held.batch_id::text, held.local_id, batch.bean_id::text
    FROM tablet_bean_batches AS held JOIN bean_batches AS batch ON batch.id = held.batch_id WHERE held.tablet_id = ${tabletId}::uuid`;
  const items = new Map(rows.map((row) => [`${row.kind}:${row.localId}`, row.itemId]));
  const beans = new Map(rows.flatMap((row) => (row.beanId === null ? [] : [[row.itemId, row.beanId] as const])));
  return { item: (kind, localId) => items.get(`${kind}:${localId}`), beanOf: (batchId) => beans.get(batchId) };
}

/**
 * What tells a part set back by a stale copy of the Recipe (`StaleCheck`):
 * what the tablet's record of it held just before the server's latest write
 * of each field, and the value each field the parts follow held just before
 * its current one, that of its latest version setting another, as versions
 * record only the edits that applied, in the order they did.
 */
async function staleCheck(tx: Prisma.TransactionClient, tabletId: string, recipe: FollowedRecipe, parts: readonly LoadedRecipePart[]): Promise<StaleCheck> {
  const [record] = await tx.$queryRaw<{ beforeWrite: Record<string, unknown> | null }[]>`
    SELECT before_write AS "beforeWrite" FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND recipe_id = ${recipe.id}::uuid`;
  const beforeWrite = record?.beforeWrite ?? null;
  const previous: Record<string, unknown> = {};
  if (beforeWrite === null) return { beforeWrite, previous };
  for (const part of parts) {
    const field = RECIPE_FIELDS[part];
    const current = recipe.content[field];
    if (current === undefined || current === null) continue;
    const [row] = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT fields -> ${field} AS value FROM item_versions
      WHERE kind = 'recipe' AND item_id = ${recipe.id} AND location_id IS NULL AND fields ? ${field}
        AND fields -> ${field} <> ${JSON.stringify(current)}::jsonb
      ORDER BY seq DESC LIMIT 1`;
    if (row) previous[field] = row.value;
  }
  return { beforeWrite, previous };
}

/**
 * Takes in the parts of the tablet's Workflow that name a Basket or Bean
 * Batch its map had not held when it was observed, now the map gains it,
 * under the tablet's lock and its Location's, as a report of its batches or
 * baskets taken in at that Location holds them: each the tablet's edit of
 * its Loaded Recipe, timed when it was observed (`takeInParts`).
 */
export async function settlePendingParts(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string): Promise<void> {
  const known = await heldLoadedRecipe(tx, tablet.tabletId);
  if (known === null || Object.keys(known.pending).length === 0) return;
  await lockLocation(tx, locationId);
  const [row] = await tx.$queryRaw<FollowedRecipe[]>`
    SELECT recipes.id::text AS id, recipes.location_id::text AS "locationId", recipes.content
    FROM recipes JOIN loaded_recipes AS loaded ON loaded.recipe_id = recipes.id AND loaded.machine_id = ${tablet.machineId}::uuid AND loaded.unloaded_at IS NULL
    WHERE recipes.id = ${known.recipeId}::uuid AND recipes.location_id = ${locationId}::uuid AND recipes.slot IS NOT NULL AND NOT recipes.archived
    FOR NO KEY UPDATE OF recipes`;
  if (!row) return;
  const now: WorkflowParts = { ...known.held };
  for (const [part, waiting] of Object.entries(known.pending) as [LoadedRecipePart, { localId: string }][]) now[part] = waiting.localId;
  await takeInParts(tx, tablet, { ...row, content: isObject(row.content) ? row.content : {} }, known, now, new Date(), new Set());
}

/**
 * The write of LOADED_RECIPE_KIND that the tablet's Workflow is due, if
 * any, read in the snapshot that `tabletDue` reads, its Machine at the
 * Location given (null while it takes part nowhere, as when capture-only):
 * where its Workflow last named a Recipe that is its Machine's Loaded Recipe,
 * in a slot of that Location, the Recipe's fields that the Workflow holds
 * otherwise (`partsWrite`), those naming a Basket or batch its tablet holds
 * no record of yet waiting until it is written one, as it is before this;
 * where it named any other, as one taken out of its slot or Archived, or
 * when the Machine is no longer at its Location, or capture-only, the
 * clearing of its Loaded Recipe.
 */
export async function loadedRecipeDue(tx: Prisma.TransactionClient, tablet: { machineId: string; tabletId: string }, locationId: string | null): Promise<PlannedWrite | null> {
  const known = await heldLoadedRecipe(tx, tablet.tabletId);
  if (known === null) return null;
  const [recipe] = await tx.$queryRaw<{ content: unknown; fieldEdits: unknown }[]>`
    SELECT recipes.content, recipes.field_edits AS "fieldEdits"
    FROM recipes JOIN loaded_recipes AS loaded ON loaded.recipe_id = recipes.id AND loaded.machine_id = ${tablet.machineId}::uuid AND loaded.unloaded_at IS NULL
    WHERE recipes.id = ${known.recipeId}::uuid AND recipes.location_id = ${locationId}::uuid AND recipes.slot IS NOT NULL AND NOT recipes.archived`;
  const base = { kind: LOADED_RECIPE_KIND, globalId: known.recipeId, localId: null, decidedAt: null } as const;
  if (!recipe) return { ...base, fields: { [LOADED_RECIPE_FIELD]: null }, expected: { [LOADED_RECIPE_FIELD]: known.recipeId }, contentDecidedAt: null };
  const content = isObject(recipe.content) ? recipe.content : {};
  const rows = await tx.$queryRaw<{ kind: ItemKind; itemId: string; localId: string }[]>`
    SELECT 'basket' AS kind, basket_id::text AS "itemId", local_id AS "localId" FROM tablet_baskets WHERE tablet_id = ${tablet.tabletId}::uuid
    UNION ALL SELECT 'beanBatch', batch_id::text, local_id FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid`;
  const locals = new Map(rows.map((row) => [`${row.kind}:${row.itemId}`, row.localId]));
  const target = recipeParts(content, (kind, itemId) => locals.get(`${kind}:${itemId.toLowerCase()}`));
  const [names] = await tx.$queryRaw<{ basketName: unknown; coffeeName: unknown; coffeeRoaster: unknown }[]>`
    SELECT (SELECT content -> 'name' FROM baskets WHERE id::text = lower(${String(content.basketId ?? "")})) AS "basketName",
      bean.content -> 'name' AS "coffeeName", bean.content -> 'roaster' AS "coffeeRoaster"
    FROM (SELECT 1) AS one
    LEFT JOIN bean_batches AS batch ON batch.id::text = lower(${String(content.beanBatchId ?? "")})
    LEFT JOIN beans AS bean ON bean.id = batch.bean_id`;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const due = partsWrite(target, known.held, { basketName: text(names?.basketName), coffeeName: text(names?.coffeeName), coffeeRoaster: text(names?.coffeeRoaster) });
  if (due === null) return null;
  return { ...base, ...due, contentDecidedAt: latestDecision(readFieldEdits(recipe.fieldEdits)) };
}

/**
 * Records the Workflow Decaid returned for the plugin's write of its Loaded
 * Recipe (`record`, its `context` and `hotWaterData`), as
 * `recordSettingsWritten` records the settings': each part the write set is
 * held as Decaid returned it, and any other the tablet changed since its
 * last report is its edit, timed when the plugin had Decaid's answer
 * (`takeInParts`). The Workflow has seen the latest edit of the Recipe the
 * write carried (`contentSeen`) unless such an edit lost. A Workflow that no
 * longer names the Recipe, as once cleared, names none; one naming another
 * is taken in from the Workflow the plugin sends after it. Recorded only
 * while the answering connection holds its Machine, under the Machine's and
 * the tablet's locks, then its Location's and the Recipe's.
 */
export async function recordLoadedRecipeWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  recipeId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
  contentSeen: Date | null,
): Promise<AnswerRecorded> {
  if (!isObject(record.context)) return "notTheItem";
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    const known = await heldLoadedRecipe(tx, tablet.tabletId);
    if (known === null || known.recipeId !== recipeId.toLowerCase()) return "recorded";
    const named = loadedRecipeOf(record);
    const now = workflowParts(record);
    // Cleared, or another loaded since: held as the Workflow holds it, as the one the plugin sends after it is.
    if (named === null) await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
    else if (named !== known.recipeId) await saveHeld(tx, tablet.tabletId, named, now, {}, null);
    if (named !== known.recipeId) return "recorded";
    const locationId = await sharingLocation(tx, tablet.machineId);
    if (locationId !== null) await lockLocation(tx, locationId);
    const [row] = await tx.$queryRaw<FollowedRecipe[]>`
      SELECT recipes.id::text AS id, recipes.location_id::text AS "locationId", recipes.content
      FROM recipes JOIN loaded_recipes AS loaded ON loaded.recipe_id = recipes.id AND loaded.machine_id = ${tablet.machineId}::uuid AND loaded.unloaded_at IS NULL
      WHERE recipes.id = ${known.recipeId}::uuid AND recipes.location_id = ${locationId}::uuid AND recipes.slot IS NOT NULL AND NOT recipes.archived
      FOR NO KEY UPDATE OF recipes`;
    // Not its Machine's Loaded Recipe: it is cleared from the Workflow.
    if (!row) return "recorded";
    const set = new Set(PARTS.filter((part) => written.has(LOADED_RECIPE_PARTS[part][0])));
    const at = updatedAt === null ? await transactionTime(tx) : new Date(updatedAt);
    const lost = await takeInParts(tx, tablet, { ...row, content: isObject(row.content) ? row.content : {} }, known, now, at, set);
    if (contentSeen !== null && !lost) {
      await tx.$executeRaw`
        UPDATE tablet_loaded_recipes SET content_seen_at = GREATEST(content_seen_at, ${contentSeen}::timestamptz) WHERE tablet_id = ${tablet.tabletId}::uuid`;
    }
    return "recorded";
  }, INTAKE_TRANSACTION);
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
