import {
  LIBRARY_ITEM_KINDS,
  LOADED_RECIPE_FIELD,
  LOADED_RECIPE_KIND,
  LOADED_RECIPE_PARTS,
  type LoadedRecipePart,
  type WorkflowDelivery,
  loadedRecipeOf,
} from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { editContent } from "../library/content-edits.js";
import { tabletSource } from "../library/history.js";
import type { PlannedWrite } from "../library/holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet, sharingLocation } from "../library/intake.js";
import type { CurrentEntry } from "../library/join-plan.js";
import { isObject } from "../library/listed.js";
import {
  type ItemKind,
  NO_STALE_CHECK,
  PARTS,
  RECIPE_FIELDS,
  type StaleCheck,
  type WorkflowParts,
  changedParts,
  heldByRecord,
  partEdits,
  partsWrite,
  readLoadBefore,
  readParts,
  recipeParts,
  recordedParts,
  samePart,
  setBackToLoad,
  workflowEditedParts,
  workflowParts,
} from "../library/loaded-recipe-intake.js";
import { lockLocation, transactionTime } from "../library/location-state.js";
import { type FieldEdits, latestDecision, readFieldEdits } from "../library/merge.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { profileOfSql } from "../shots/links.js";

// Each Machine's Loaded Recipe (ADR-0022): the recipe DYE2 has selected on
// its tablet, which the plugin records in the Workflow by the Recipe's
// global id (LOADED_RECIPE_KEY), so the server reads it from the Workflow
// deliveries milestone 1 captures, keeping each Machine's current Loaded
// Recipe and its history (`loaded_recipes`). A Machine follows its Loaded
// Recipe both ways (tickets #146 and #177): DYE2 records a change on it of
// the dose, yield, grind setting, brew temperature and the hot water value
// of the Recipe's mode into the Recipe's record, which reaches the server as
// the tablet's change of the record (`recordedByDye2`, recipes.ts); a change
// of the Workflow's other parts that follow the Recipe (`workflowEditedParts`)
// is an edit of it; and an edit of the Recipe from anywhere is written into
// the Workflow of every Machine that has it loaded, each tablet's Workflow as
// it last held them kept in `tablet_loaded_recipes`, so the plugin's own
// write is never read as the tablet's edit (loaded-recipe-intake.ts). A part
// set back to what a stale copy held, or to what the plugin's write of the
// load replaced before the Machine's first espresso since (`load_before`),
// is written back instead.
// A Workflow naming a Recipe its Machine does not have loaded, as one taken
// out of its slot or Archived, or of a Location it left, or the one the
// server last had as its Loaded Recipe as it was made capture-only, has it
// cleared; one loaded on a Machine taking part nowhere stays.

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
 * row lock and the tablet's (`takeInWorkflow` in joining.ts), as
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
  extra: Pick<WorkflowDelivery, "loadBefore"> = {},
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
  // What the plugin's write of a load replaced, which a part set back to before the first espresso since is stale by. A
  // later load replaces it, so what was written over for a Recipe loaded before is not stale for this one.
  const loadBefore = readLoadBefore(extra.loadBefore);
  if (recipeId !== null && loadBefore !== null) {
    await tx.$executeRaw`
      UPDATE loaded_recipes SET load_before = ${JSON.stringify(loadBefore)}::jsonb WHERE machine_id = ${tablet.machineId}::uuid AND unloaded_at IS NULL`;
  }
  // Taking part nowhere, as capture-only, only the Recipe the server last had as its Loaded Recipe is cleared: one loaded
  // since stays, as does one loaded on the tablet before it stopped that the server had not heard of yet, as while offline.
  const clearsNowhere = entry !== null || loadedBefore === named;
  await followMachine(tx, tablet, workflow, named, recipe, loadedBefore === recipeId && !joining, new Date(observedAt), clearsNowhere);
}

/**
 * Closes the window in which a part set back to what the plugin's write of
 * the Machine's latest load replaced is stale (`load_before`), as the first
 * espresso since that load is delivered, in delivery order: the plugin
 * delivers a change of state after any Workflow change reported before it
 * (`MachineEvents`).
 */
export async function espressoStarted(tx: Prisma.TransactionClient, machineId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE loaded_recipes SET load_before = NULL WHERE machine_id = ${machineId}::uuid AND unloaded_at IS NULL AND load_before IS NOT NULL`;
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
  contentSeenAt: Date | null;
}

async function heldLoadedRecipe(tx: Prisma.TransactionClient, tabletId: string): Promise<HeldLoadedRecipe | null> {
  const [row] = await tx.$queryRaw<{ recipeId: string; held: unknown; contentSeenAt: Date | null }[]>`
    SELECT recipe_id::text AS "recipeId", held, content_seen_at AS "contentSeenAt" FROM tablet_loaded_recipes WHERE tablet_id = ${tabletId}::uuid`;
  if (!row) return null;
  return { recipeId: row.recipeId, held: readParts(row.held), contentSeenAt: row.contentSeenAt };
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
  contentSeen: Date | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_loaded_recipes AS known (tablet_id, recipe_id, held, content_seen_at)
    VALUES (${tabletId}::uuid, ${recipeId}::uuid, ${JSON.stringify(held)}::jsonb, ${contentSeen}::timestamptz)
    ON CONFLICT (tablet_id) DO UPDATE SET
      held = EXCLUDED.held,
      content_seen_at = CASE WHEN known.recipe_id = EXCLUDED.recipe_id
        THEN GREATEST(known.content_seen_at, EXCLUDED.content_seen_at) ELSE EXCLUDED.content_seen_at END,
      recipe_id = EXCLUDED.recipe_id`;
}

/**
 * Takes in the parts of a Workflow the tablet reported that follow its
 * Loaded Recipe (ADR-0022). A Workflow naming none forgets the one it named,
 * as does one naming a Recipe loaded while its Machine takes part nowhere
 * (`clears` false), which is not cleared from it.
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
  clears: boolean,
): Promise<void> {
  if (named === null) {
    await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
    return;
  }
  const known = await heldLoadedRecipe(tx, tablet.tabletId);
  // A Recipe loaded on a Machine taking part nowhere, as capture-only, which nothing there shares, is left as it is: only
  // the one it had loaded as it stopped is cleared, as it still is while the Workflow names it.
  if (!clears && known?.recipeId !== named) {
    await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
    return;
  }
  if (recipe !== null && continued && known?.recipeId === named) {
    // Its Grinder and Profile are no edit of it, so held as they were: the Profile is not looked up.
    await takeInParts(tx, tablet, recipe, known, workflowParts(workflow), observedAt, new Set());
    return;
  }
  const now = workflowParts(workflow, await libraryProfileOf(tx, workflow));
  const [record] =
    recipe === null
      ? []
      : await tx.$queryRaw<{ contentSeenAt: Date | null }[]>`
          SELECT content_seen_at AS "contentSeenAt" FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${named}::uuid`;
  await saveHeld(tx, tablet.tabletId, named, now, record?.contentSeenAt ?? null);
}

/**
 * Takes in the parts the Workflow holds (`now`) otherwise than the tablet's
 * Workflow last held them (`known`), but those `written`, as the tablet's
 * edit of its Loaded Recipe (`followed`), made at `at`. Saves what the
 * Workflow holds from now on, and tells every instance when the Location's
 * tablets are to be written.
 */
async function takeInParts(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  followed: FollowedRecipe,
  known: HeldLoadedRecipe,
  now: WorkflowParts,
  at: Date,
  written: ReadonlySet<LoadedRecipePart>,
): Promise<void> {
  // DYE2 records the rest into the Recipe's record.
  const changed = changedParts(known.held, now, workflowEditedParts(followed.content)).filter((part) => !written.has(part));
  const held: WorkflowParts = { ...known.held };
  for (const part of written) held[part] = now[part];
  if (changed.length === 0) {
    await saveHeld(tx, tablet.tabletId, followed.id, held, null);
    return;
  }
  const edits = partEdits(changed, now, followed.content, await staleCheck(tx, tablet, followed, changed));
  for (const part of edits.taken) held[part] = now[part];
  if (Object.keys(edits.values).length > 0) {
    await editContent(tx, { kind: "recipe", id: followed.id }, { values: edits.values, at, seenAt: known.contentSeenAt }, tabletSource(tablet));
  }
  await saveHeld(tx, tablet.tabletId, followed.id, held, null);
  // Its other tablets are written the Recipe, and so are the Workflows that have it loaded, this one's included where a
  // part was set back by a stale copy or an edit lost.
  if (edits.taken.length > 0) await notify(tx, "library_changes", followed.locationId);
}

/** The Library Profile a Workflow's profile is, found as a Shot's is (`profileOfSql`), or null. */
async function libraryProfileOf(tx: Prisma.TransactionClient, workflow: unknown): Promise<string | null> {
  const profile = isObject(workflow) ? workflow.profile : undefined;
  if (!isObject(profile)) return null;
  const [row] = await tx.$queryRaw<{ id: string | null }[]>`SELECT ${profileOfSql(Prisma.sql`${JSON.stringify(profile)}::jsonb`)} AS id`;
  return row?.id ?? null;
}

/**
 * Whether the tablet's Workflow, as last held, holds every part of the
 * Recipe as it is now, as the tablet names it: but a part naming an item
 * its Location (`locationId`) no longer offers the tablet, which no write
 * carries, as a Basket Archived or hidden there, so removed from DYE2's
 * list, or one in a list the tablet holds in a shape not recognised. An item
 * still offered that the tablet holds no record of, as one whose write it
 * refused, has not been seen.
 */
async function holdsWhole(tx: Prisma.TransactionClient, tabletId: string, recipeId: string, locationId: string): Promise<boolean> {
  const known = await heldLoadedRecipe(tx, tabletId);
  if (known === null) return false;
  const content = await recipeContent(tx, recipeId);
  const target = recipeParts(content, await tabletLocals(tx, tabletId));
  for (const part of PARTS) {
    if (target[part] === null || (target[part] !== undefined && samePart(part, known.held[part], target[part]))) continue;
    const itemId = content[RECIPE_FIELDS[part]];
    if (target[part] !== undefined || typeof itemId !== "string" || (await offeredTo(tx, tabletId, locationId, part, itemId))) return false;
  }
  return true;
}

/** Whether the Location offers the tablet the Grinder, Basket or Bean Batch a part names, so a write of it is to come. */
async function offeredTo(tx: Prisma.TransactionClient, tabletId: string, locationId: string, part: LoadedRecipePart, itemId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) return false;
  const [row] =
    part === "grinder"
      ? await tx.$queryRaw<unknown[]>`
          SELECT 1 FROM grinders WHERE id = ${itemId}::uuid AND location_id = ${locationId}::uuid AND NOT archived`
      : part === "basket"
        ? await tx.$queryRaw<unknown[]>`
            SELECT 1 FROM baskets JOIN basket_locations AS here ON here.basket_id = baskets.id AND here.location_id = ${locationId}::uuid
            WHERE baskets.id = ${itemId}::uuid AND here.shown AND NOT baskets.archived
              AND NOT EXISTS (SELECT 1 FROM tablet_unrecognised_lists WHERE tablet_id = ${tabletId}::uuid AND list = ${LIBRARY_ITEM_KINDS.basket.list})`
        : part === "batch"
          ? await tx.$queryRaw<unknown[]>`
              SELECT 1 FROM bean_batches AS batch JOIN beans AS bean ON bean.id = batch.bean_id
              JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
              WHERE batch.id = ${itemId}::uuid AND here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived`
          : [];
  return row !== undefined;
}

/** A Recipe's content now, read in the transaction. */
async function recipeContent(tx: Prisma.TransactionClient, recipeId: string): Promise<Record<string, unknown>> {
  const [row] = await tx.$queryRaw<{ content: unknown }[]>`SELECT content FROM recipes WHERE id = ${recipeId}::uuid`;
  return isObject(row?.content) ? row.content : {};
}

/**
 * What tells a part set back by a stale copy of the Recipe (`StaleCheck`):
 * what the tablet's record of it held just before the server's latest write
 * of each field, the value each field the parts follow held just before its
 * current one, that of its latest version setting another, as versions
 * record only the edits that applied, in the order they did, and the fields
 * whose latest edit the tablet made itself.
 */
async function staleCheck(tx: Prisma.TransactionClient, tablet: ReportingTablet, recipe: FollowedRecipe, parts: readonly LoadedRecipePart[]): Promise<StaleCheck> {
  const tabletId = tablet.tabletId;
  const [record] = await tx.$queryRaw<{ beforeWrite: Record<string, unknown> | null; fieldEdits: unknown }[]>`
    SELECT held.before_write AS "beforeWrite", recipes.field_edits AS "fieldEdits"
    FROM recipes LEFT JOIN tablet_recipes AS held ON held.recipe_id = recipes.id AND held.tablet_id = ${tabletId}::uuid
    WHERE recipes.id = ${recipe.id}::uuid`;
  const fieldEdits = readFieldEdits(record?.fieldEdits);
  const own = new Set(Object.entries(fieldEdits).flatMap(([field, latest]) => (latest.tabletId === tabletId ? [field] : [])));
  const load = await loadOf(tx, tablet.machineId, recipe.id);
  const loadBefore = load?.loadBefore ?? null;
  const ownSinceLoad = load ? ownSince(fieldEdits, tabletId, load.loadedAt) : new Set<string>();
  const beforeWrite = record?.beforeWrite ?? null;
  if (beforeWrite === null) return { ...NO_STALE_CHECK, loadBefore, ownSinceLoad };
  const previous: Record<string, unknown> = {};
  for (const part of parts) {
    const field = RECIPE_FIELDS[part];
    const current = recipe.content[field];
    if (current === undefined || current === null || own.has(field)) continue;
    const [row] = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT fields -> ${field} AS value FROM item_versions
      WHERE kind = 'recipe' AND item_id = ${recipe.id} AND location_id IS NULL AND fields ? ${field}
        AND fields -> ${field} <> ${JSON.stringify(current)}::jsonb
      ORDER BY seq DESC LIMIT 1`;
    if (row) previous[field] = row.value;
  }
  return { beforeWrite, previous, own, loadBefore, ownSinceLoad };
}

/**
 * The Machine's load of its current Loaded Recipe, if that is the Recipe:
 * what the plugin's write of it replaced, until the first espresso since,
 * or null, and when it was loaded.
 */
async function loadOf(tx: Prisma.TransactionClient, machineId: string, recipeId: string) {
  const [row] = await tx.$queryRaw<{ loadBefore: unknown; loadedAt: Date }[]>`
    SELECT load_before AS "loadBefore", loaded_at AS "loadedAt" FROM loaded_recipes
    WHERE machine_id = ${machineId}::uuid AND recipe_id = ${recipeId}::uuid AND unloaded_at IS NULL`;
  return row ? { loadBefore: readLoadBefore(row.loadBefore), loadedAt: row.loadedAt } : null;
}

/** The fields whose latest edit the tablet made, timed after `since`: a set-back of one undoes it. */
function ownSince(fieldEdits: FieldEdits, tabletId: string, since: Date): Set<string> {
  return new Set(Object.entries(fieldEdits).flatMap(([field, latest]) => (latest.tabletId === tabletId && new Date(latest.at).getTime() > since.getTime() ? [field] : [])));
}

/**
 * The write of LOADED_RECIPE_KIND that the tablet's Workflow is due, if
 * any, read in the snapshot that `tabletDue` reads, its Machine at the
 * Location given (null while it takes part nowhere, as when capture-only):
 * where its Workflow last named a Recipe that is its Machine's Loaded Recipe,
 * in a slot of that Location, the Recipe's fields that the Workflow holds
 * otherwise (`partsWrite`), those naming a Grinder, Basket or batch its
 * tablet holds no record of yet waiting until it is written one, as it is
 * before this, and its dial and batch until its record of the Recipe holds
 * them (`heldByRecord`), as when the tablet refused it;
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
  const local = await tabletLocals(tx, tablet.tabletId);
  const [record] = await tx.$queryRaw<{ record: Record<string, unknown> }[]>`
    SELECT record FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${known.recipeId}::uuid`;
  const [names] = await tx.$queryRaw<{ profile: unknown; grinderModel: unknown; basketName: unknown; coffeeName: unknown; coffeeRoaster: unknown }[]>`
    SELECT (SELECT content -> 'profile' FROM profiles WHERE id = ${String(content.profileId ?? "")}) AS profile,
      (SELECT content -> 'model' FROM grinders WHERE id::text = lower(${String(content.grinderId ?? "")})) AS "grinderModel",
      (SELECT content -> 'name' FROM baskets WHERE id::text = lower(${String(content.basketId ?? "")})) AS "basketName",
      bean.content -> 'name' AS "coffeeName", bean.content -> 'roaster' AS "coffeeRoaster"
    FROM (SELECT 1) AS one
    LEFT JOIN bean_batches AS batch ON batch.id::text = lower(${String(content.beanBatchId ?? "")})
    LEFT JOIN beans AS bean ON bean.id = batch.bean_id`;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  // Its dial and batch wait for the tablet's record of it, written before (`heldByRecord`).
  const target = heldByRecord(recipeParts(content, local, firstStepTemperature(names?.profile)), record?.record ?? null);
  const due = partsWrite(target, known.held, {
    profile: isObject(names?.profile) ? names.profile : null,
    grinderModel: text(names?.grinderModel),
    basketName: text(names?.basketName),
    coffeeName: text(names?.coffeeName),
    coffeeRoaster: text(names?.coffeeRoaster),
  });
  if (due === null) return null;
  return { ...base, ...due, contentDecidedAt: latestDecision(readFieldEdits(recipe.fieldEdits)) };
}

/** A profile's first step's temperature, as a Recipe without a brew temperature of its own is brewed at; null for none. */
function firstStepTemperature(profile: unknown): number | null {
  const steps = isObject(profile) && Array.isArray(profile.steps) ? profile.steps : [];
  const first: unknown = steps[0];
  const temperature = isObject(first) ? first.temperature : undefined;
  return typeof temperature === "number" && Number.isFinite(temperature) ? temperature : null;
}

/**
 * The paths of a recipe record DYE2 records into, each with the part of the
 * Workflow it records from: those of `recordedParts`, and the RPM, Basket
 * and other hot water value, which DYE2 records too, the hot water value
 * once it moves off the one the Workflow held as the recipe was selected
 * (`itemPatch` in dye2:dye2-plugin/src/utils/workflow-record.ts at 2cf631c).
 */
const RECORDED_PATHS: Readonly<Record<string, LoadedRecipePart>> = {
  "dashboardVariables.dose": "dose",
  "dashboardVariables.drink": "yield",
  "dashboardVariables.grind": "grind",
  "dashboardVariables.brewC": "brewTemperature",
  "dashboardVariables.hotWaterMl": "volume",
  "dashboardVariables.hotWaterTempC": "targetTemperature",
  "dashboardVariables.rpm": "rpm",
  "dashboardVariables.basketId": "basket",
};

/**
 * The tablet's changes of its record of a Recipe (`changed`, its paths with
 * their values, as `editedContent` finds them) that DYE2 recorded from the
 * Workflow of its Machine while that Recipe is its Loaded Recipe (ADR-0022),
 * judged under the tablet's lock, which the report holds: the paths of
 * those that are stale, and no edit. DYE2 records the Workflow's value, so
 * a value is stale where it is what the plugin's write of the load replaced,
 * before the Machine's first espresso since, but over the tablet's own
 * latest edit of the field (`setBackToLoad`); or where it is what the
 * Workflow held of a part the server's write has not changed yet, as one
 * Decaid refused, while the Recipe holds another, as DYE2 then records the
 * Workflow left behind the record. Each is held as the Workflow holding the
 * value recorded, so a stale one has the Recipe's value written back into
 * the Workflow, and the record too.
 */
export async function recordedByDye2(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  recipeId: string,
  content: Readonly<Record<string, unknown>>,
  fieldEdits: unknown,
  changed: Readonly<Record<string, unknown>>,
): Promise<Set<string>> {
  const stale = new Set<string>();
  const known = await heldLoadedRecipe(tx, tablet.tabletId);
  if (known === null || known.recipeId !== recipeId) return stale;
  const load = await loadOf(tx, tablet.machineId, recipeId);
  if (!load) return stale;
  const { loadBefore } = load;
  const own = ownSince(readFieldEdits(fieldEdits), tablet.tabletId, load.loadedAt);
  // The parts the Workflow also reports (`workflowEditedParts`) are held as it reports them, which can be later than the
  // value DYE2 recorded: only those DYE2 alone records are held as recorded.
  const recordedOnly = new Set(recordedParts(content));
  const locals = "dashboardVariables.basketId" in changed ? await tabletLocals(tx, tablet.tabletId) : undefined;
  const held: WorkflowParts = { ...known.held };
  for (const [path, value] of Object.entries(changed)) {
    const part = RECORDED_PATHS[path];
    if (part === undefined) continue;
    const recordedValue = readParts({ [part]: value })[part];
    if (recordedValue === null) continue;
    // The Recipe names its Basket by its global id, the record by the tablet's.
    const basket = content[RECIPE_FIELDS.basket];
    const recipeValue = part === "basket" ? (typeof basket === "string" ? (locals?.("basket", basket) ?? null) : null) : readParts({ [part]: content[RECIPE_FIELDS[part]] })[part];
    // A write of the server's still to land: never of a part the Recipe holds none of, which it writes none of.
    const unwritten = recipeValue !== null && known.held[part] !== null && samePart(part, known.held[part], recordedValue) && !samePart(part, recipeValue, recordedValue);
    // A value that is the Recipe's already, as DYE2 records the plugin's own write, is no edit either.
    if (samePart(part, recipeValue, recordedValue) || setBackToLoad(part, recordedValue, loadBefore, own) || unwritten) stale.add(path);
    if (recordedOnly.has(part)) held[part] = recordedValue;
  }
  await saveHeld(tx, tablet.tabletId, recipeId, held, null);
  return stale;
}

/**
 * After a save of DYE2's editor of a Recipe (`savedInEditor`), which DYE2
 * does not apply to the Workflow, and which a report can bring with what
 * DYE2 recorded before it: the parts DYE2 records are held as the tablet's
 * latest Workflow holds them, while that Recipe is its Loaded Recipe, under
 * the tablet's lock, which the report holds. So the save's values are
 * written into that Workflow, as into the others that have the Recipe
 * loaded, each expecting what it holds.
 */
export async function heldAfterEditorSave(tx: Prisma.TransactionClient, tablet: ReportingTablet, recipeId: string, content: Readonly<Record<string, unknown>>): Promise<void> {
  const known = await heldLoadedRecipe(tx, tablet.tabletId);
  if (known === null || known.recipeId !== recipeId) return;
  const [latest] = await tx.$queryRaw<{ workflow: unknown }[]>`
    SELECT workflow FROM workflow_events WHERE machine_id = ${tablet.machineId}::uuid ORDER BY id DESC LIMIT 1`;
  if (!latest) return;
  const now = workflowParts(latest.workflow);
  const held: WorkflowParts = { ...known.held };
  for (const part of recordedParts(content)) held[part] = now[part];
  await saveHeld(tx, tablet.tabletId, recipeId, held, null);
}

/** The tablet's id for its record of a Grinder, Basket or Bean Batch, by the item's global id, by its map; undefined where it holds none. */
async function tabletLocals(tx: Prisma.TransactionClient, tabletId: string): Promise<(kind: ItemKind, itemId: string) => string | undefined> {
  const rows = await tx.$queryRaw<{ kind: ItemKind; itemId: string; localId: string }[]>`
    SELECT 'basket' AS kind, basket_id::text AS "itemId", local_id AS "localId" FROM tablet_baskets WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'beanBatch', batch_id::text, local_id FROM tablet_bean_batches WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'grinder', grinder_id::text, local_id FROM tablet_grinders WHERE tablet_id = ${tabletId}::uuid`;
  const locals = new Map(rows.map((row) => [`${row.kind}:${row.itemId}`, row.localId]));
  return (kind, itemId) => locals.get(`${kind}:${itemId.toLowerCase()}`);
}

/**
 * Records the Workflow Decaid returned for the plugin's write of its Loaded
 * Recipe (`record`, its `context` and `hotWaterData`), as
 * `recordGrinderWritten` records a Grinder's record: each part the write set is
 * held as Decaid returned it, and any other the tablet changed since its
 * last report is its edit, timed when the plugin had Decaid's answer
 * (`takeInParts`). The Workflow has seen the latest edit of the Recipe the
 * write carried (`contentSeen`) only where it holds the whole Recipe then
 * (`holdsWhole`), as a part the write left out, or the plugin left as the
 * Workflow held it, has not seen it. A Workflow that no
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
    const now = workflowParts(record, await libraryProfileOf(tx, record));
    // Cleared, or another loaded since: held as the Workflow holds it, as the one the plugin sends after it is.
    if (named === null) await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
    else if (named !== known.recipeId) await saveHeld(tx, tablet.tabletId, named, now, null);
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
    await takeInParts(tx, tablet, { ...row, content: isObject(row.content) ? row.content : {} }, known, now, at, set);
    if (contentSeen !== null && (await holdsWhole(tx, tablet.tabletId, row.id, row.locationId))) {
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
