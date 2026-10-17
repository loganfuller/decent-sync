import {
  DYE2_SELECTION_FIELD,
  LIBRARY_ITEM_KINDS,
  LOADED_RECIPE_KIND,
  LOADED_RECIPE_PARTS,
  type LoadedRecipePart,
  RECIPE_SETTINGS,
  RECIPE_SETTING_NAMES,
  STEAM_ON_FROM,
  type WorkflowDelivery,
  dye2SelectionOf,
  steamOff,
} from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { PlannedWrite } from "../library/holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet, sharingLocation } from "../library/intake.js";
import type { CurrentEntry } from "../library/join-plan.js";
import { isObject } from "../library/listed.js";
import {
  type ItemKind,
  PARTS,
  type PartValue,
  RECIPE_FIELDS,
  type WorkflowParts,
  heldByRecord,
  partsWrite,
  readLoadBefore,
  readParts,
  recipeParts,
  RECORDED_PARTS,
  samePart,
  setBackToLoad,
  workflowParts,
} from "../library/loaded-recipe-intake.js";
import { lockLocation } from "../library/location-state.js";
import { type FieldEdits, latestDecision, readFieldEdits } from "../library/merge.js";
import type { PrismaService } from "../prisma.service.js";
import { profileOfSql } from "../shots/links.js";

// Each Machine's Loaded Recipe (ADR-0022): the recipe DYE2 has selected on
// its tablet, which DYE2 writes into the Workflow by its slot
// (DYE2_SELECTION_FIELD), so the server reads it from the Workflow
// deliveries milestone 1 captures, through the tablet's map of its recipes'
// slots (`selectedRecipe`), keeping each Machine's current Loaded Recipe and
// its history (`loaded_recipes`). A Machine follows its Loaded
// Recipe both ways (tickets #146, #173, #177 and #187): DYE2 records a change on
// it of the dose, yield, grind setting, RPM, Basket, brew temperature and
// steam, hot water and flush settings into the Recipe's record, which reaches
// the server as the tablet's change of the record (`recordedByDye2`,
// recipes.ts), so nothing of the Workflow itself edits the Recipe; and an
// edit of the Recipe from anywhere is written into the Workflow of every
// Machine that has it loaded, each tablet's Workflow as it last held them
// kept in `tablet_loaded_recipes`, so the plugin's own write is never read as
// the tablet's edit (loaded-recipe-intake.ts). A part set back to what a
// stale copy held, or to what the plugin's write of the load replaced before
// the Machine's first espresso since (`load_before`), is written back
// instead. Steam on and off stays each Machine's own: a steam temperature
// below STEAM_ON_FROM, and a steam time of 0 recorded while steam is off, are
// no edit, and the plugin writes no steam temperature into a Workflow whose
// steam is off.
// A Workflow naming a Recipe its Machine does not have loaded, as one taken
// out of its slot or Archived, or of a Location it left, or the one the
// server last had as its Loaded Recipe as it was made capture-only, has
// DYE2's selection of it cleared; one loaded on a Machine taking part
// nowhere stays.

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
 * The Recipe a Workflow's DYE2 selection names (ADR-0022): a recipe in a
 * slot names the Recipe whose record is in that slot on the tablet, by its
 * map (`tablet_recipes`), read under the tablet's lock, which every change of
 * the map holds; anything else names none, and so does every selection
 * while DYE2 is absent (`WorkflowDelivery.dye2Absent`).
 */
async function selectedRecipe(tx: Prisma.TransactionClient, tabletId: string, workflow: unknown, dye2Absent = false): Promise<string | null> {
  const { slot } = dye2SelectionOf(workflow);
  if (slot === null || dye2Absent) return null;
  const [row] = await tx.$queryRaw<{ recipeId: string }[]>`
    SELECT recipe_id::text AS "recipeId" FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND local_id = ${slot}`;
  return row?.recipeId ?? null;
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
  extra: Pick<WorkflowDelivery, "loadBefore" | "dye2Absent"> = {},
): Promise<void> {
  const named = await selectedRecipe(tx, tablet.tabletId, workflow, extra.dye2Absent);
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
  await followMachine(tx, tablet, workflow, named, recipe, loadedBefore === recipeId && !joining, clearsNowhere, loadBefore !== null);
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
}

async function heldLoadedRecipe(tx: Prisma.TransactionClient, tabletId: string): Promise<HeldLoadedRecipe | null> {
  const [row] = await tx.$queryRaw<{ recipeId: string; held: unknown }[]>`
    SELECT recipe_id::text AS "recipeId", held FROM tablet_loaded_recipes WHERE tablet_id = ${tabletId}::uuid`;
  if (!row) return null;
  return { recipeId: row.recipeId, held: readParts(row.held) };
}

/** Saves the Loaded Recipe the tablet's Workflow names, with its parts as the Workflow holds them. */
async function saveHeld(tx: Prisma.TransactionClient, tabletId: string, recipeId: string, held: WorkflowParts): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_loaded_recipes (tablet_id, recipe_id, held)
    VALUES (${tabletId}::uuid, ${recipeId}::uuid, ${JSON.stringify(held)}::jsonb)
    ON CONFLICT (tablet_id) DO UPDATE SET held = EXCLUDED.held, recipe_id = EXCLUDED.recipe_id`;
}

/**
 * Takes in the parts of a Workflow the tablet reported that follow its
 * Loaded Recipe (ADR-0022). A Workflow naming none forgets the one it named,
 * as does one naming a Recipe loaded while its Machine takes part nowhere
 * (`clears` false), which is not cleared from it.
 * One naming the Recipe its Machine went on having loaded (`recipe`, its
 * Loaded Recipe, and `continued`, as before this Workflow, not as the tablet
 * joins its Location) changes nothing: DYE2 records what changed into the
 * Recipe's record (`recordedByDye2`); but one carrying the plugin's write of
 * the load (`loadWritten`, its `loadBefore`) is held as it is, as that write
 * set its parts. Any other, as a load, or a Recipe
 * its Machine has not loaded, is held as it is: a Recipe's fields that
 * differ from it are written into the Workflow, as a load from a stale copy
 * needs, or the Recipe is cleared from it (`loadedRecipeDue`).
 */
async function followMachine(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  named: string | null,
  recipe: FollowedRecipe | null,
  continued: boolean,
  clears: boolean,
  loadWritten: boolean,
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
  // DYE2 records the Workflow's changes into the Recipe's record, so the parts are held as they were: but after the
  // plugin's own write of the load, as the Workflow then holds them, which no write is due to set again.
  if (recipe !== null && continued && known?.recipeId === named && !loadWritten) return;
  await saveHeld(tx, tablet.tabletId, named, workflowParts(workflow, await libraryProfileOf(tx, workflow)));
}

/**
 * Holds the parts a write of the plugin's set (`written`) as the Workflow
 * Decaid returned for it holds them (`now`), the rest as the tablet's
 * Workflow last held them (`known`), as the answer to that write (`followed`
 * its Recipe, `seen` the latest edit of it the write carried). A steam
 * temperature the write left out of a Workflow whose steam is off, as the
 * plugin never turns steam on, is held as the Recipe's, which the plugin set
 * as the one Streamline turns steam back on at (ADR-0021), where the write
 * carried the Recipe's current one: so the write is not planned again while
 * steam stays off, and an edit of it is.
 */
async function takeInWritten(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  followed: FollowedRecipe & { fieldEdits: unknown },
  known: HeldLoadedRecipe,
  now: WorkflowParts,
  written: ReadonlySet<LoadedRecipePart>,
  seen: Date | null,
): Promise<void> {
  const held: WorkflowParts = { ...known.held };
  for (const part of written) held[part] = now[part];
  const steam = followed.content[RECIPE_FIELDS.steamTemperature];
  const decided = readFieldEdits(followed.fieldEdits)[RECIPE_FIELDS.steamTemperature]?.decidedAt;
  const carried = decided === undefined || (seen !== null && new Date(decided).getTime() <= seen.getTime());
  if (!written.has("steamTemperature") && typeof steam === "number" && steam >= STEAM_ON_FROM && isOff(now.steamTemperature) && carried) {
    held.steamTemperature = steam;
  }
  await saveHeld(tx, tablet.tabletId, followed.id, held);
}

/** Whether a steam temperature, as a part holds it, is steam off. */
function isOff(temperature: PartValue): boolean {
  return typeof temperature === "number" && temperature < STEAM_ON_FROM;
}

/** The Library Profile a Workflow's profile is, found as a Shot's is (`profileOfSql`), or null. */
async function libraryProfileOf(tx: Prisma.TransactionClient, workflow: unknown): Promise<string | null> {
  const profile = isObject(workflow) ? workflow.profile : undefined;
  if (!isObject(profile)) return null;
  const [row] = await tx.$queryRaw<{ id: string | null }[]>`SELECT ${profileOfSql(Prisma.sql`${JSON.stringify(profile)}::jsonb`)} AS id`;
  return row?.id ?? null;
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
 * before this, and its dial until its record of the Recipe holds it
 * (`heldByRecord`), as when the tablet refused it;
 * where it named any other, as one taken out of its slot or Archived, or
 * when the Machine is no longer at its Location, or capture-only, the
 * clearing of DYE2's selection of it.
 */
export async function loadedRecipeDue(tx: Prisma.TransactionClient, tablet: { machineId: string; tabletId: string }, locationId: string | null): Promise<PlannedWrite | null> {
  const known = await heldLoadedRecipe(tx, tablet.tabletId);
  if (known === null) return null;
  const [recipe] = await tx.$queryRaw<{ content: unknown; fieldEdits: unknown }[]>`
    SELECT recipes.content, recipes.field_edits AS "fieldEdits"
    FROM recipes JOIN loaded_recipes AS loaded ON loaded.recipe_id = recipes.id AND loaded.machine_id = ${tablet.machineId}::uuid AND loaded.unloaded_at IS NULL
    WHERE recipes.id = ${known.recipeId}::uuid AND recipes.location_id = ${locationId}::uuid AND recipes.slot IS NOT NULL AND NOT recipes.archived`;
  const base = { kind: LOADED_RECIPE_KIND, globalId: known.recipeId, localId: null, decidedAt: null } as const;
  // Unloaded: the plugin clears DYE2's selection of it, and DYE2 then its field.
  if (!recipe) return { ...base, fields: { [DYE2_SELECTION_FIELD]: null }, contentDecidedAt: null };
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
  // Its dial waits for the tablet's record of it, written before (`heldByRecord`).
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
 * Workflow it records from (`RECORDED_PARTS`; `itemPatch` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at 2cf631c).
 */
const RECORDED_PATHS: Readonly<Record<string, LoadedRecipePart>> = {
  "dashboardVariables.dose": "dose",
  "dashboardVariables.drink": "yield",
  "dashboardVariables.grind": "grind",
  "dashboardVariables.brewC": "brewTemperature",
  "dashboardVariables.rpm": "rpm",
  "dashboardVariables.basketId": "basket",
  ...Object.fromEntries(RECIPE_SETTING_NAMES.map((setting) => [`dashboardVariables.${RECIPE_SETTINGS[setting].dye2}`, setting])),
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
 * Workflow left behind the record. Steam turned off is no edit either: a
 * steam temperature below STEAM_ON_FROM (`steamOffPaths` in recipe-intake.ts
 * takes in none), and a steam time of 0 while the Machine's latest Workflow
 * delivered has steam off, as Streamline's dashboard turns steam off with
 * both, and DYE2 records the time alone where the Recipe holds no steam
 * temperature (interim, until decentespresso/dye2#30). Each is held as the
 * Workflow holding the value recorded, so a stale one has the Recipe's value
 * written back into the Workflow, but a steam temperature, which the plugin
 * writes into no Workflow whose steam is off, and the record too.
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
  const locals = "dashboardVariables.basketId" in changed ? await tabletLocals(tx, tablet.tabletId) : undefined;
  const held: WorkflowParts = { ...known.held };
  // A steam time of 0 recorded while the Machine's steam is off, as Streamline's dashboard turns it off with.
  const steamTimeOff = changed[`dashboardVariables.${RECIPE_SETTINGS.steamDuration.dye2}`] === 0 && (await latestSteamOff(tx, tablet.machineId));
  for (const [path, value] of Object.entries(changed)) {
    const part = RECORDED_PATHS[path];
    if (part === undefined) continue;
    const recordedValue = readParts({ [part]: value })[part];
    if (recordedValue === null) continue;
    // The Recipe names its Basket by its global id, the record by the tablet's.
    const basket = content[RECIPE_FIELDS.basket];
    const recipeValue = part === "basket" ? (typeof basket === "string" ? (locals?.("basket", basket) ?? null) : null) : readParts({ [part]: content[RECIPE_FIELDS[part]] })[part];
    held[part] = recordedValue;
    if (part === "steamTemperature" && isOff(recordedValue)) {
      // Steam turned off, which no Recipe holds. The plugin writes no steam temperature into a Workflow whose steam is off,
      // so one held as holding the Recipe's already stays so. Otherwise, as after an edit the tablet missed while it was
      // offline, it is held as recorded, so the write is planned, and the plugin keeps the Recipe's as the one Streamline
      // turns steam back on at (`takeInWritten`).
      if (recipeValue !== null && !isOff(recipeValue) && samePart(part, known.held[part], recipeValue)) held[part] = recipeValue;
      stale.add(path);
      continue;
    }
    // A write of the server's still to land: never of a part the Recipe holds none of, which it writes none of.
    const unwritten = recipeValue !== null && known.held[part] !== null && samePart(part, known.held[part], recordedValue) && !samePart(part, recipeValue, recordedValue);
    // A value that is the Recipe's already, as DYE2 records the plugin's own write, is no edit either.
    const offWithSteam = part === "steamDuration" && steamTimeOff;
    if (samePart(part, recipeValue, recordedValue) || setBackToLoad(part, recordedValue, loadBefore, own) || unwritten || offWithSteam) stale.add(path);
  }
  await saveHeld(tx, tablet.tabletId, recipeId, held);
  return stale;
}

/** Whether the Machine's latest Workflow delivered has steam off (`steamOff`): the Machine's steam state, which no Recipe holds. */
async function latestSteamOff(tx: Prisma.TransactionClient, machineId: string): Promise<boolean> {
  const [latest] = await tx.$queryRaw<{ workflow: unknown }[]>`
    SELECT workflow FROM workflow_events WHERE machine_id = ${machineId}::uuid ORDER BY id DESC LIMIT 1`;
  return latest !== undefined && steamOff(latest.workflow);
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
  for (const part of RECORDED_PARTS) held[part] = now[part];
  await saveHeld(tx, tablet.tabletId, recipeId, held);
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
 * Recipe (`record`, its `context`, steam, hot water and flush settings and
 * profile), as `recordGrinderWritten` records a Grinder's record: each part
 * the write set is held as Decaid returned it, and the rest as before, as
 * DYE2 records any the tablet changed into the Recipe's record
 * (`takeInWritten`), but a steam temperature the plugin left out of a
 * Workflow whose steam is off, by the latest edit the write carried
 * (`contentSeen`). A Workflow whose DYE2 selection no
 * longer names the Recipe names none, but where it names nothing after a
 * write of the profile, batch or grinder, which DYE2 clears its selection
 * on and the plugin selects the slot again after; one naming another is
 * taken in from the Workflow the plugin sends after it. The answer to an
 * unload, which cleared DYE2's selection, leaves the Workflow's parts no
 * longer held. Recorded only while the answering connection holds its
 * Machine, under the Machine's and the tablet's locks, then its Location's
 * and the Recipe's.
 */
export async function recordLoadedRecipeWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  recipeId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  contentSeen: Date | null,
): Promise<AnswerRecorded> {
  if (!isObject(record.context)) return "notTheItem";
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    const known = await heldLoadedRecipe(tx, tablet.tabletId);
    if (known === null || known.recipeId !== recipeId.toLowerCase()) return "recorded";
    // Unloaded: the Workflow DYE2 clears its selection of is the one the plugin sends after it.
    if (written.has(DYE2_SELECTION_FIELD)) {
      await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
      return "recorded";
    }
    const set = new Set(PARTS.filter((part) => written.has(LOADED_RECIPE_PARTS[part][0])));
    const reselected = !dye2SelectionOf(record).named && (set.has("profile") || set.has("batch") || set.has("grinder"));
    const named = reselected ? known.recipeId : await selectedRecipe(tx, tablet.tabletId, record);
    const now = workflowParts(record, await libraryProfileOf(tx, record));
    // Cleared, or another loaded since: held as the Workflow holds it, as the one the plugin sends after it is.
    if (named === null) await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
    else if (named !== known.recipeId) await saveHeld(tx, tablet.tabletId, named, now);
    if (named !== known.recipeId) return "recorded";
    const locationId = await sharingLocation(tx, tablet.machineId);
    if (locationId !== null) await lockLocation(tx, locationId);
    const [row] = await tx.$queryRaw<(FollowedRecipe & { fieldEdits: unknown })[]>`
      SELECT recipes.id::text AS id, recipes.location_id::text AS "locationId", recipes.content, recipes.field_edits AS "fieldEdits"
      FROM recipes JOIN loaded_recipes AS loaded ON loaded.recipe_id = recipes.id AND loaded.machine_id = ${tablet.machineId}::uuid AND loaded.unloaded_at IS NULL
      WHERE recipes.id = ${known.recipeId}::uuid AND recipes.location_id = ${locationId}::uuid AND recipes.slot IS NOT NULL AND NOT recipes.archived
      FOR NO KEY UPDATE OF recipes`;
    // Not its Machine's Loaded Recipe: it is cleared from the Workflow.
    if (!row) return "recorded";
    await takeInWritten(tx, tablet, { ...row, content: isObject(row.content) ? row.content : {} }, known, now, set, contentSeen);
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
