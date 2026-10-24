import {
  DYE2_RECIPE_FIELD,
  LOADED_RECIPE_KIND,
  LOADED_RECIPE_PARTS,
  type LoadedRecipePart,
  RECIPE_SETTINGS,
  RECIPE_SETTING_NAMES,
  type WorkflowDelivery,
  dye2Fingerprint,
  dye2RecipeIdOf,
} from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { editContent } from "../library/content-edits.js";
import { tabletSource } from "../library/history.js";
import type { PlannedWrite } from "../library/holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet, sharingLocation } from "../library/intake.js";
import type { CurrentEntry } from "../library/join-plan.js";
import { currentEntry } from "../library/joining.js";
import { isObject } from "../library/listed.js";
import {
  type BaseParts,
  type ItemKind,
  PARTS,
  RECIPE_FIELDS,
  type WorkflowParts,
  dueParts,
  heldAlready,
  heldByRecord,
  partsWrite,
  readBase,
  readParts,
  recipeParts,
  samePart,
  valuesFromWorkflow,
  workflowParts,
} from "../library/loaded-recipe-intake.js";
import { lockLocation } from "../library/location-state.js";
import { latestDecision, readFieldEdits } from "../library/merge.js";
import type { PrismaService } from "../prisma.service.js";
import { profileOfSql } from "../shots/links.js";

// Each Machine's Loaded Recipe (ADR-0022): the recipe its tablet's Workflow
// names by the id of the tablet's record of it (DYE2_RECIPE_FIELD), which
// DYE2's dashboard, its Select Recipe page and Streamline's DYE strip set as
// they apply one, and DYE2 clears as the Workflow's profile changes. The
// server reads it from the Workflow deliveries milestone 1 captures, through
// the tablet's map of its recipes (`mappedRecipe`), keeping each Machine's
// current Loaded Recipe and its history (`loaded_recipes`), and what each
// tablet's Workflow last named (`tablet_loaded_recipes`): its record id, the
// Recipe, once the map holds it, which a recipe DYE2 made and named at once
// is loaded from (`recipeMapped`), the Workflow's parts as it last held them
// (`held`), and the Recipe's as the Workflow last took them (`base`).
//
// A Machine follows its Loaded Recipe both ways. Every change on it is the
// Recipe's, which the owner chose on 2026-10-24: the plugin has DYE2 save
// each change of the Workflow into the Recipe's record, which reaches the
// server as the tablet's change of the record (`recordedByDye2`, recipes.ts),
// and the server records itself what DYE2 saves none of
// (`valuesFromWorkflow`): a Grinder, a Bean Batch of the Recipe's Bean, and
// a dial value the Recipe holds none of. A load gains the Recipe each of
// those it holds none of. An edit of the Recipe from anywhere is written
// into the Workflow of every Machine that has it loaded (`loadedRecipeDue`),
// each part that changed since the Workflow took it, so the plugin's own
// write is never read as the tablet's edit, and what stays the Machine's
// own, as a batch of another Bean, a value cleared or steam turned off, is
// never written back. A Workflow naming a Recipe its Machine does not have
// loaded, as one Archived, or of a Location it left, or the one the server
// last had as its Loaded Recipe as it was made capture-only, has the recipe
// cleared from it; one loaded on a Machine taking part nowhere stays.

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
 * The Recipe whose record the tablet holds under that id, by its map
 * (`tablet_recipes`), read under the tablet's lock, which every change of
 * the map holds; null where the map holds none.
 */
async function mappedRecipe(tx: Prisma.TransactionClient, tabletId: string, recordId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ recipeId: string }[]>`
    SELECT recipe_id::text AS "recipeId" FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND local_id = ${recordId}`;
  return row?.recipeId ?? null;
}

/**
 * Takes the Loaded Recipe a Workflow names into its Machine's state, in the
 * transaction storing the delivery from the Machine's own tablet, under its
 * row lock and the tablet's (`takeInWorkflow` in joining.ts), as the
 * tablet's report of where it takes part (`entry`, null while its Machine is
 * capture-only), joining it or not: the Recipe whose record id it names, by
 * the tablet's map, one of the Recipes of the Machine's Location not
 * Archived, while it takes part in the Library there, and none otherwise, as
 * on a Capture-only Machine, or while DYE2 is absent
 * (`WorkflowDelivery.dye2Absent`). A Machine's Loaded Recipe that differs
 * from it is unloaded then, and the Recipe the Workflow names is loaded from
 * then (`switchLoaded`). Then the Workflow's parts that follow the Recipe
 * are taken in (`followMachine`).
 */
export async function takeInLoadedRecipe(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  observedAt: string,
  entry: CurrentEntry | null,
  joining: boolean,
  extra: Pick<WorkflowDelivery, "dye2Absent"> = {},
): Promise<void> {
  const recordId = extra.dye2Absent ? null : dye2RecipeIdOf(workflow);
  const named = recordId === null ? null : await mappedRecipe(tx, tablet.tabletId, recordId);
  const recipe = named === null || entry === null ? null : await followedRecipe(tx, named, entry.locationId);
  const loadedBefore = await switchLoaded(tx, tablet.machineId, recipe?.id ?? null, observedAt);
  // Taking part nowhere, as capture-only, only the Recipe the server last had as its Loaded Recipe is cleared: one loaded
  // since stays, as does one loaded on the tablet before it stopped that the server had not heard of yet, as while offline.
  const clearsNowhere = entry !== null || (named !== null && loadedBefore === named);
  await followMachine(tx, tablet, workflow, observedAt, recordId, named, recipe, loadedBefore === (recipe?.id ?? null) && !joining, joining, clearsNowhere);
}

/**
 * The Recipe at that Location, not Archived, its row locked after the
 * Location's lock, which a Recipe's slots, its edits and its hard delete take
 * before it; null for none.
 */
async function followedRecipe(tx: Prisma.TransactionClient, recipeId: string, locationId: string): Promise<FollowedRecipe | null> {
  await lockLocation(tx, locationId);
  const [row] = await tx.$queryRaw<(FollowedRecipe & { archived: boolean })[]>`
    SELECT id::text AS id, location_id::text AS "locationId", archived, content, field_edits AS "fieldEdits"
    FROM recipes WHERE id = ${recipeId}::uuid AND location_id = ${locationId}::uuid FOR NO KEY UPDATE`;
  return row && !row.archived ? { id: row.id, locationId: row.locationId, content: isObject(row.content) ? row.content : {}, fieldEdits: row.fieldEdits } : null;
}

/**
 * Makes `recipeId` the Machine's Loaded Recipe, or none, from `observedAt`,
 * by the tablet's clock, which a delivery made while it was offline keeps,
 * but never before the Machine's latest entry, as when its tablet's clock
 * jumped back. Returns the Recipe it had loaded before, or null.
 */
async function switchLoaded(tx: Prisma.TransactionClient, machineId: string, recipeId: string | null, observedAt: string | Date): Promise<string | null> {
  const [current] = await tx.$queryRaw<{ recipeId: string }[]>`
    SELECT recipe_id::text AS "recipeId" FROM loaded_recipes WHERE machine_id = ${machineId}::uuid AND unloaded_at IS NULL`;
  const loadedBefore = current?.recipeId ?? null;
  if (loadedBefore === recipeId) return loadedBefore;
  const [latest] = await tx.$queryRaw<{ at: Date }[]>`
    SELECT GREATEST(${observedAt}::timestamptz, (SELECT GREATEST(loaded_at, unloaded_at) FROM loaded_recipes WHERE machine_id = ${machineId}::uuid ORDER BY id DESC LIMIT 1)) AS at`;
  const at = latest!.at;
  if (current) await tx.$executeRaw`UPDATE loaded_recipes SET unloaded_at = ${at} WHERE machine_id = ${machineId}::uuid AND unloaded_at IS NULL`;
  if (recipeId !== null) await tx.$executeRaw`INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES (${machineId}::uuid, ${recipeId}::uuid, ${at})`;
  return loadedBefore;
}

/** A Recipe a Machine has loaded, as its edits read it: its Location, content and its fields' latest edits. */
interface FollowedRecipe {
  id: string;
  locationId: string;
  content: Record<string, unknown>;
  fieldEdits: unknown;
}

/** What a tablet's Workflow last named, as `tablet_loaded_recipes` keeps it. */
interface NamedRecipe {
  recordId: string;
  recipeId: string | null;
  namedAt: Date;
  held: WorkflowParts;
  base: BaseParts;
}

async function namedRecipe(tx: Prisma.TransactionClient, tabletId: string): Promise<NamedRecipe | null> {
  const [row] = await tx.$queryRaw<{ recordId: string; recipeId: string | null; namedAt: Date; held: unknown; base: unknown }[]>`
    SELECT record_id AS "recordId", recipe_id::text AS "recipeId", named_at AS "namedAt", held, base FROM tablet_loaded_recipes WHERE tablet_id = ${tabletId}::uuid`;
  if (!row) return null;
  return { recordId: row.recordId, recipeId: row.recipeId, namedAt: row.namedAt, held: readParts(row.held), base: readBase(row.base) };
}

/** Saves what the tablet's Workflow names, with its parts as the Workflow holds them, and the Recipe's as it took them. */
async function saveNamed(tx: Prisma.TransactionClient, tabletId: string, named: NamedRecipe): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_loaded_recipes (tablet_id, record_id, recipe_id, named_at, held, base)
    VALUES (${tabletId}::uuid, ${named.recordId}, ${named.recipeId}::uuid, ${named.namedAt}, ${JSON.stringify(named.held)}::jsonb, ${JSON.stringify(named.base)}::jsonb)
    ON CONFLICT (tablet_id) DO UPDATE SET
      record_id = EXCLUDED.record_id, recipe_id = EXCLUDED.recipe_id, named_at = EXCLUDED.named_at, held = EXCLUDED.held, base = EXCLUDED.base`;
}

async function forgetNamed(tx: Prisma.TransactionClient, tabletId: string): Promise<void> {
  await tx.$executeRaw`DELETE FROM tablet_loaded_recipes WHERE tablet_id = ${tabletId}::uuid`;
}

/**
 * Takes in the parts of a Workflow the tablet reported that follow the
 * recipe it names (ADR-0022). A Workflow naming none forgets the one it
 * named, as does one naming a Recipe loaded while its Machine takes part
 * nowhere (`clears` false), which is not cleared from it. One naming the
 * Recipe its Machine went on having loaded (`continued`, as before this
 * Workflow, not as the tablet joins its Location) has its changes taken in
 * as the Machine's: those Decent Sync records itself are the Recipe's
 * (`valuesFromWorkflow`), but for a change of profile, as DYE2 fingerprints
 * one, which DYE2 clears the recipe on a moment later; and the parts are
 * held as the Workflow holds them, each it holds as the Recipe does taken
 * as the Recipe's (`base`). Any other, as a load, is held as it is:
 * the Recipe gains from it each value it holds none of (`valuesFromWorkflow`
 * on a load), and its fields that differ from it are written into the
 * Workflow, as a load from a stale copy needs (`loadedRecipeDue`). One
 * naming a record the map does not hold yet, or a Recipe its Machine may not
 * have, as one Archived, is kept so: the first is loaded once the map gains
 * it (`recipeMapped`), and the second cleared from the Workflow.
 */
async function followMachine(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  observedAt: string,
  recordId: string | null,
  named: string | null,
  recipe: FollowedRecipe | null,
  continued: boolean,
  joining: boolean,
  clears: boolean,
): Promise<void> {
  if (recordId === null) return forgetNamed(tx, tablet.tabletId);
  const known = await namedRecipe(tx, tablet.tabletId);
  // A Recipe loaded on a Machine taking part nowhere, as capture-only, which nothing there shares, is left as it is: only
  // the one it had loaded as it stopped is cleared, as it still is while the Workflow names it.
  if (!clears && (known === null || known.recipeId !== named)) return forgetNamed(tx, tablet.tabletId);
  const namedAt = known !== null && known.recordId === recordId ? known.namedAt : new Date(observedAt);
  const now = workflowParts(workflow, await libraryProfileOf(tx, workflow));
  if (recipe === null) {
    await saveNamed(tx, tablet.tabletId, { recordId, recipeId: named, namedAt, held: now, base: {} });
    return;
  }
  if (continued && known !== null && known.recipeId === recipe.id) {
    const base = { ...known.base };
    if (!(await profileChanged(tx, tablet.machineId, workflow))) {
      for (const part of await recordFromWorkflow(tx, tablet, recipe, known.held, now, observedAt)) base[part] = now[part];
    }
    // A part the Workflow holds as the Recipe does has taken it, however it came there, as DYE2's editor applies a save
    // of the Recipe again: a change of it on the Machine since, as a value cleared, is the Machine's own, not written back.
    const target = await targetParts(tx, tablet.tabletId, recipe.id);
    if (target !== null) Object.assign(base, heldAlready(target, now));
    await saveNamed(tx, tablet.tabletId, { recordId, recipeId: recipe.id, namedAt, held: now, base });
    return;
  }
  // Loaded now, or named again as the tablet joins its Location, or for the first time since the server last forgot what it
  // named: a load gains the Recipe what it holds none of, and the parts it holds that the Workflow does not are written.
  if (!joining && !continued) await recordFromWorkflow(tx, tablet, recipe, null, now, observedAt);
  const target = await targetParts(tx, tablet.tabletId, recipe.id);
  // Named again with its Machine still having it loaded, as after an upgrade forgot it: taken as it stood.
  const base = continued && target !== null && known === null ? { ...target } as BaseParts : target === null ? {} : heldAlready(target, now);
  await saveNamed(tx, tablet.tabletId, { recordId, recipeId: recipe.id, namedAt, held: now, base });
}

/**
 * Whether a Workflow delivered, stored as its Machine's latest
 * (`workflow_events`), changed the profile from the Workflow stored before
 * it, as DYE2 fingerprints one (`dye2Fingerprint`), which DYE2 clears the
 * Workflow's recipe on.
 */
async function profileChanged(tx: Prisma.TransactionClient, machineId: string, workflow: unknown): Promise<boolean> {
  const rows = await tx.$queryRaw<{ workflow: unknown }[]>`
    SELECT workflow FROM workflow_events WHERE machine_id = ${machineId}::uuid ORDER BY id DESC LIMIT 2`;
  // PostgreSQL keeps a jsonb object's keys in an order of its own, so the stored Workflow's profile and the one delivered
  // are fingerprinted with their keys in one order.
  const profile = (value: unknown) => dye2Fingerprint(sortedKeys(isObject(value) ? value.profile : undefined));
  const previous = rows.length === 2 ? rows[1]!.workflow : undefined;
  return previous !== undefined && profile(previous) !== profile(workflow);
}

/** A copy of the value with each object's keys sorted, arrays kept in their order. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

/**
 * Records into the Recipe what Decent Sync takes into it from its
 * Machine's Workflow (`valuesFromWorkflow`), from `held`, as the Workflow
 * last held its parts, or on a load (`held` null), as the Workflow stands,
 * as the tablet's edit, timed as the plugin observed the Workflow, merged
 * per field with Conflicts (ADR-0020), judged by what the tablet's record of
 * the Recipe has seen. Returns the parts recorded. The Recipe's tablets are
 * written the edit, and so are the Workflows of the Machines that have it
 * loaded.
 */
async function recordFromWorkflow(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  recipe: FollowedRecipe,
  held: WorkflowParts | null,
  now: WorkflowParts,
  observedAt: string,
): Promise<LoadedRecipePart[]> {
  const local = await tabletLocals(tx, tablet.tabletId);
  const target = recipeParts(recipe.content, (kind, itemId) => local.local(kind, itemId));
  const grinders = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM grinders WHERE location_id = ${recipe.locationId}::uuid AND NOT archived`;
  const batch = now.batch === null ? undefined : local.item("beanBatch", now.batch as string);
  const beans = batch === undefined ? [] : await tx.$queryRaw<{ id: string; beanId: string }[]>`
    SELECT id::text AS id, bean_id::text AS "beanId" FROM bean_batches WHERE id = ${batch}::uuid`;
  const { values, parts } = valuesFromWorkflow(recipe.content, target, held, now, {
    item: (kind, localId) => local.item(kind, localId),
    grinders: new Set(grinders.map((row) => row.id)),
    batchBeans: new Map(beans.map((row) => [row.id, row.beanId])),
  });
  if (parts.length === 0) return [];
  const [seen] = await tx.$queryRaw<{ contentSeenAt: Date | null }[]>`
    SELECT content_seen_at AS "contentSeenAt" FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${recipe.id}::uuid`;
  const edited = await editContent(tx, { kind: "recipe", id: recipe.id }, { values, at: new Date(observedAt), seenAt: seen?.contentSeenAt ?? null }, tabletSource(tablet));
  if (edited.writesDue) await notify(tx, "library_changes", recipe.locationId);
  const [after] = await tx.$queryRaw<{ content: unknown }[]>`SELECT content FROM recipes WHERE id = ${recipe.id}::uuid`;
  if (after && isObject(after.content)) recipe.content = after.content;
  // Only those the Recipe holds now as the Workflow does: one that lost to an edit the tablet had not seen is written back.
  const nowTarget = recipeParts(recipe.content, (kind, itemId) => local.local(kind, itemId));
  return parts.filter((part) => samePart(part, nowTarget[part], now[part]));
}

/** The Library Profile a Workflow's profile is, found as a Shot's is (`profileOfSql`), or null. */
async function libraryProfileOf(tx: Prisma.TransactionClient, workflow: unknown): Promise<string | null> {
  const profile = isObject(workflow) ? workflow.profile : undefined;
  if (!isObject(profile)) return null;
  const [row] = await tx.$queryRaw<{ id: string | null }[]>`SELECT ${profileOfSql(Prisma.sql`${JSON.stringify(profile)}::jsonb`)} AS id`;
  return row?.id ?? null;
}

/**
 * The parts of the Recipe the tablet's Workflow is to hold (`recipeParts`),
 * its dial waiting for the tablet's record of it to hold it
 * (`heldByRecord`), as one the tablet refused; null for no such Recipe.
 */
async function targetParts(tx: Prisma.TransactionClient, tabletId: string, recipeId: string) {
  const [recipe] = await tx.$queryRaw<{ content: unknown }[]>`SELECT content FROM recipes WHERE id = ${recipeId}::uuid`;
  if (!recipe) return null;
  const content = isObject(recipe.content) ? recipe.content : {};
  const local = await tabletLocals(tx, tabletId);
  const [record] = await tx.$queryRaw<{ record: Record<string, unknown> }[]>`
    SELECT record FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND recipe_id = ${recipeId}::uuid`;
  const [profile] = await tx.$queryRaw<{ profile: unknown }[]>`SELECT content -> 'profile' AS profile FROM profiles WHERE id = ${String(content.profileId ?? "")}`;
  return heldByRecord(recipeParts(content, (kind, itemId) => local.local(kind, itemId), firstStepTemperature(profile?.profile)), record?.record ?? null);
}

/**
 * Once the tablet's map holds a record under the id its Workflow last named
 * while the map held none, as of a recipe DYE2's `save-recipe` made and
 * named at once, which its report brings after the Workflow: the Recipe is
 * taken in as the Workflow naming it, from when the plugin observed it
 * first naming it (`named_at`), so a Shot pulled meanwhile is pulled with
 * it, under the locks the report holds (the Machine's row, the tablet's,
 * then its Location's). A Workflow naming a Recipe the map held already, as
 * one of the Location the Machine left, never loads another the map gives
 * that id later.
 */
export async function recipeMapped(tx: Prisma.TransactionClient, tablet: ReportingTablet, recordId: string): Promise<void> {
  const known = await namedRecipe(tx, tablet.tabletId);
  if (known === null || known.recordId !== recordId || known.recipeId !== null) return;
  const [latest] = await tx.$queryRaw<{ workflow: unknown }[]>`
    SELECT workflow FROM workflow_events WHERE machine_id = ${tablet.machineId}::uuid ORDER BY id DESC LIMIT 1`;
  if (!latest || dye2RecipeIdOf(latest.workflow) !== recordId) return;
  const entry = await currentEntry(tx, tablet.machineId);
  await takeInLoadedRecipe(tx, tablet, latest.workflow, known.namedAt.toISOString(), entry, false);
}

/**
 * The write of LOADED_RECIPE_KIND that the tablet's Workflow is due, if
 * any, read in the snapshot that `tabletDue` reads, its Machine at the
 * Location given (null while it takes part nowhere, as when capture-only):
 * where its Workflow last named a Recipe that is its Machine's Loaded Recipe,
 * of that Location and not Archived, the Recipe's parts that changed since
 * the Workflow took them and that it holds otherwise (`dueParts`,
 * `partsWrite`), those naming a Grinder, Basket or batch its tablet holds no
 * record of yet waiting until it is written one, as it is before this, and
 * its dial until its record of the Recipe holds it (`heldByRecord`), as
 * when the tablet refused it; where it named any other, as one Archived, or
 * when the Machine is no longer at its Location, or capture-only, the
 * clearing of the recipe from the Workflow. Each expects the Workflow to
 * name the recipe by the tablet's record id of it still.
 */
export async function loadedRecipeDue(tx: Prisma.TransactionClient, tablet: { machineId: string; tabletId: string }, locationId: string | null): Promise<PlannedWrite | null> {
  const known = await namedRecipe(tx, tablet.tabletId);
  if (known === null || known.recipeId === null) return null;
  const [recipe] = await tx.$queryRaw<{ content: unknown; fieldEdits: unknown }[]>`
    SELECT recipes.content, recipes.field_edits AS "fieldEdits"
    FROM recipes JOIN loaded_recipes AS loaded ON loaded.recipe_id = recipes.id AND loaded.machine_id = ${tablet.machineId}::uuid AND loaded.unloaded_at IS NULL
    WHERE recipes.id = ${known.recipeId}::uuid AND recipes.location_id = ${locationId}::uuid AND NOT recipes.archived`;
  const base = { kind: LOADED_RECIPE_KIND, globalId: known.recipeId, localId: null, decidedAt: null } as const;
  const expected = { [DYE2_RECIPE_FIELD]: known.recordId };
  // Unloaded: the plugin clears the recipe from the Workflow while it still names it.
  if (!recipe) return { ...base, fields: { [DYE2_RECIPE_FIELD]: null }, expected, contentDecidedAt: null };
  const content = isObject(recipe.content) ? recipe.content : {};
  const target = await targetParts(tx, tablet.tabletId, known.recipeId);
  if (target === null) return null;
  const [names] = await tx.$queryRaw<{ profile: unknown; grinderModel: unknown; basketName: unknown; coffeeName: unknown; coffeeRoaster: unknown }[]>`
    SELECT (SELECT content -> 'profile' FROM profiles WHERE id = ${String(content.profileId ?? "")}) AS profile,
      (SELECT content -> 'model' FROM grinders WHERE id::text = lower(${String(content.grinderId ?? "")})) AS "grinderModel",
      (SELECT content -> 'name' FROM baskets WHERE id::text = lower(${String(content.basketId ?? "")})) AS "basketName",
      bean.content -> 'name' AS "coffeeName", bean.content -> 'roaster' AS "coffeeRoaster"
    FROM (SELECT 1) AS one
    LEFT JOIN bean_batches AS batch ON batch.id::text = lower(${String(content.beanBatchId ?? "")})
    LEFT JOIN beans AS bean ON bean.id = batch.bean_id`;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const due = partsWrite(dueParts(target, known.held, known.base), known.held, {
    profile: isObject(names?.profile) ? names.profile : null,
    grinderModel: text(names?.grinderModel),
    basketName: text(names?.basketName),
    coffeeName: text(names?.coffeeName),
    coffeeRoaster: text(names?.coffeeRoaster),
  });
  if (due === null) return null;
  return { ...base, fields: due.fields, expected: { ...due.expected, ...expected }, contentDecidedAt: latestDecision(readFieldEdits(recipe.fieldEdits)) };
}

/** A profile's first step's temperature, as a Recipe without a brew temperature of its own is brewed at; null for none. */
function firstStepTemperature(profile: unknown): number | null {
  const steps = isObject(profile) && Array.isArray(profile.steps) ? profile.steps : [];
  const first: unknown = steps[0];
  const temperature = isObject(first) ? first.temperature : undefined;
  return typeof temperature === "number" && Number.isFinite(temperature) ? temperature : null;
}

/**
 * The paths of a recipe record DYE2 saves into, each with the part of the
 * Workflow it saves from (`RECORDED_PARTS`; `itemPatch` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at v0.1.26).
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
 * their values, as `editedContent` finds them) that DYE2 saved from the
 * Workflow of its Machine while that Recipe is its Loaded Recipe (ADR-0022),
 * judged under the tablet's lock, which the report holds: the paths of
 * those that are no edit. DYE2 saves the Workflow's value of each field the
 * record holds otherwise, so a value is no edit where it is the Recipe's
 * already, as DYE2 saves the plugin's own write back, or where it is what
 * the Workflow held of a part the server's write has not changed yet, while
 * the Recipe holds another, as DYE2 then saves the Workflow left behind the
 * record: the Recipe's value is written back into the record and the
 * Workflow. Each is held as the Workflow holding the value saved, and one
 * that is an edit as the Workflow having taken the Recipe's new value.
 */
export async function recordedByDye2(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  recipeId: string,
  content: Readonly<Record<string, unknown>>,
  _fieldEdits: unknown,
  changed: Readonly<Record<string, unknown>>,
): Promise<Set<string>> {
  const stale = new Set<string>();
  const known = await namedRecipe(tx, tablet.tabletId);
  if (known === null || known.recipeId !== recipeId) return stale;
  const [loaded] = await tx.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM loaded_recipes WHERE machine_id = ${tablet.machineId}::uuid AND recipe_id = ${recipeId}::uuid AND unloaded_at IS NULL`;
  if (!loaded) return stale;
  const locals = "dashboardVariables.basketId" in changed ? await tabletLocals(tx, tablet.tabletId) : undefined;
  const held: WorkflowParts = { ...known.held };
  const base: BaseParts = { ...known.base };
  for (const [path, value] of Object.entries(changed)) {
    const part = RECORDED_PATHS[path];
    if (part === undefined) continue;
    const savedValue = readParts({ [part]: value })[part];
    if (savedValue === null) continue;
    // The Recipe names its Basket by its global id, the record by the tablet's.
    const basket = content[RECIPE_FIELDS.basket];
    const recipeValue = part === "basket" ? (typeof basket === "string" ? (locals?.local("basket", basket) ?? null) : null) : readParts({ [part]: content[RECIPE_FIELDS[part]] })[part];
    held[part] = savedValue;
    // A write of the server's still to land: never of a part the Recipe holds none of, which it writes none of, nor of one
    // the Workflow took the Recipe's value of already, as a change DYE2 could not save at once, saved at a later one.
    const pending = !(part in known.base) || !samePart(part, known.base[part], recipeValue);
    const unwritten = recipeValue !== null && pending && known.held[part] !== null && samePart(part, known.held[part], savedValue) && !samePart(part, recipeValue, savedValue);
    if (samePart(part, recipeValue, savedValue) || unwritten) stale.add(path);
    else base[part] = savedValue;
  }
  await saveNamed(tx, tablet.tabletId, { ...known, held, base });
  return stale;
}

/** The tablet's ids for its records of Grinders, Baskets and Bean Batches, by the items' global ids, and back, by its map. */
async function tabletLocals(tx: Prisma.TransactionClient, tabletId: string) {
  const rows = await tx.$queryRaw<{ kind: ItemKind; itemId: string; localId: string }[]>`
    SELECT 'basket' AS kind, basket_id::text AS "itemId", local_id AS "localId" FROM tablet_baskets WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'beanBatch', batch_id::text, local_id FROM tablet_bean_batches WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'grinder', grinder_id::text, local_id FROM tablet_grinders WHERE tablet_id = ${tabletId}::uuid`;
  const locals = new Map(rows.map((row) => [`${row.kind}:${row.itemId}`, row.localId]));
  const items = new Map(rows.map((row) => [`${row.kind}:${row.localId}`, row.itemId]));
  return {
    local: (kind: ItemKind, itemId: string) => locals.get(`${kind}:${itemId.toLowerCase()}`),
    item: (kind: ItemKind, localId: string) => items.get(`${kind}:${localId}`),
  };
}

/**
 * Records the Workflow Decaid returned for the plugin's write of its Loaded
 * Recipe (`record`, its `context`, steam, hot water and flush settings and
 * profile), as `recordGrinderWritten` records a Grinder's record: each part
 * the write set is held as Decaid returned it, and the rest as before; and
 * each part the write carried, by the latest edit it carried
 * (`contentSeen`), as taken by the Workflow, written or not, so a part a
 * barista changed meanwhile, which the plugin keeps, or a steam temperature
 * it left out of a Workflow whose steam is off, is not written again until
 * the Recipe changes. The answer to an unload, which cleared the recipe, or
 * one whose Workflow names another recipe or none by then, leaves nothing
 * named: the Workflow the plugin sends after it brings what it names. Recorded only while the
 * answering connection holds its Machine, under the Machine's and the
 * tablet's locks, then its Location's and the Recipe's.
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
    const known = await namedRecipe(tx, tablet.tabletId);
    if (known === null || known.recipeId !== recipeId.toLowerCase()) return "recorded";
    // Unloaded, or the Workflow names another recipe or none by now, which the Workflow the plugin sends after it brings:
    // nothing is due for the one it named.
    if (written.has(DYE2_RECIPE_FIELD) || dye2RecipeIdOf(record) !== known.recordId) {
      await forgetNamed(tx, tablet.tabletId);
      return "recorded";
    }
    const locationId = await sharingLocation(tx, tablet.machineId);
    if (locationId !== null) await lockLocation(tx, locationId);
    const [row] = await tx.$queryRaw<{ id: string; content: unknown; fieldEdits: unknown }[]>`
      SELECT recipes.id::text AS id, recipes.content, recipes.field_edits AS "fieldEdits"
      FROM recipes JOIN loaded_recipes AS loaded ON loaded.recipe_id = recipes.id AND loaded.machine_id = ${tablet.machineId}::uuid AND loaded.unloaded_at IS NULL
      WHERE recipes.id = ${known.recipeId}::uuid AND recipes.location_id = ${locationId}::uuid AND NOT recipes.archived
      FOR NO KEY UPDATE OF recipes`;
    // Not its Machine's Loaded Recipe: it is cleared from the Workflow.
    if (!row) return "recorded";
    const set = new Set(PARTS.filter((part) => written.has(LOADED_RECIPE_PARTS[part][0])));
    const now = workflowParts(record, await libraryProfileOf(tx, record));
    const target = await targetParts(tx, tablet.tabletId, row.id);
    const fieldEdits = readFieldEdits(row.fieldEdits);
    const held: WorkflowParts = { ...known.held };
    const base: BaseParts = { ...known.base };
    for (const part of PARTS) {
      const decided = fieldEdits[RECIPE_FIELDS[part]]?.decidedAt;
      const carried = contentSeen !== null && (decided === undefined || new Date(decided).getTime() <= contentSeen.getTime());
      if (set.has(part)) held[part] = now[part];
      if (carried && target !== null && target[part] !== undefined) base[part] = target[part];
      else if (set.has(part)) base[part] = now[part];
    }
    await saveNamed(tx, tablet.tabletId, { ...known, held, base });
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
