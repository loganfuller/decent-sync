import { LIBRARY_ITEM_KINDS, RECIPE_SHOWN_FIELD, RECIPE_SLOT_FIELD, dye2GlobalIdOf, dye2Records, isRecordId, recipeSlotOf, sameValue } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { linkRecipeShots, profileOfSql } from "../shots/links.js";
import { type EditOutcome, editContent, lockItems, recordJoined } from "./content-edits.js";
import { markUnrecognised } from "./dye2-lists.js";
import { recordedByDye2, recipeMapped } from "../machine-events/loaded-recipes.js";
import { answeredEquipment, editedContent } from "./equipment-intake.js";
import { setAsideDeleted } from "./hard-deletes.js";
import { recordVersion, tabletSource } from "./history.js";
import type { HeldRecord, OfferedRecipe } from "./holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet, sharingLocation } from "./intake.js";
import { joiningRecord, standing } from "./join-plan.js";
import { currentEntry, takenIn } from "./joining.js";
import { leaveOut, offersAny, screenLeftOut } from "./left-out.js";
import { isObject, listedIds } from "./listed.js";
import { deletedAt, lockLocation, transactionTime } from "./location-state.js";
import { type FieldEdits, latestDecision, readFieldEdits } from "./merge.js";
import {
  EDITED_PATHS,
  type IntakeContext,
  type MappedKind,
  type MappedRecipe,
  type RecipeView,
  type ReportedRecipe,
  type SlotMove,
  type TabletIds,
  type WriteContext,
  editedPaths,
  holdsRecipe,
  libraryValues,
  planRecipeIntake,
  readReportedRecipes,
  recipeContent,
  recipeRecord,
  recipeView,
  savedInEditor,
  slotMove,
  steamOffPaths,
  tabletIds,
  withoutOwnEdits,
} from "./recipe-intake.js";

// The Library's Recipes and the tablets that hold them (ADR-0005, ADR-0006,
// ADR-0019, ADR-0020): DYE2's recipes, which it keeps whole in a list under
// one key of Decaid's store, each under its record id, the same on every
// tablet at its Recipe's Location. A Recipe belongs to one Location and sits
// in one of its five Recipe Slots, or none, and is on Streamline's strip
// exactly while it is in one (DYE2 v0.1.32). A tablet at a Location reports
// the list as a collection: a change of a recipe's record is an edit of its
// Recipe, merged per field (content-edits.ts), timed by when the plugin
// first read it, and a change of its slot (`stripSlot`) moves it there, as
// hiding it from the strip takes it out of its slot (`recipeSlotOf`); a
// record of an id no Recipe there has is a new Recipe there, with that
// record id and slot; Recipes are never matched (ADR-0018). A recipe gone
// from a tablet's list is taken out of its slot at that Location and kept.
// Each sharing tablet holds every Recipe of its Location that is not
// Archived, each record naming the items it uses by the tablet's own ids and
// carrying what DYE2 derives from them, regenerated (recipe-intake.ts), its
// slot, and its global id in a top-level field of its own, beside the
// server's map per tablet; a Recipe Archived is removed from the list
// (holdings.ts). A steam temperature that turns steam off, as DYE2's editor
// saves for "Off", is no edit, and the Recipe's is written back
// (recipe-intake.ts).
//
// Under the locks equipment.ts takes, in the same order: the Machine's row,
// the tablet's, the Location's, under which its slots are decided, then the
// Recipes' rows.

/**
 * What putting a Recipe in a slot, or none (null), sets of its row: its
 * slot, and `showOnDashboard` in its content from it, which the previous
 * release (ADR-0025) writes its records' `showOnStreamlineDashboard` from and
 * shows; this one writes them shown exactly while the Recipe is in a slot
 * (`recipeRecord`), so both write the same. It is derived, so it is no edit
 * and has no version of its own: the slot's change is the version.
 */
export function placedIn(slot: number | null): Prisma.Sql {
  return Prisma.sql`slot = ${slot}::integer, content = jsonb_set(content, '{showOnDashboard}', to_jsonb(${slot !== null}::boolean))`;
}

/** The tablet's map of the items a recipe names, by their global ids and its own (ADR-0006). */
async function readTabletIds(tx: Prisma.TransactionClient, tabletId: string): Promise<TabletIds> {
  const rows = await tx.$queryRaw<{ kind: MappedKind; itemId: string; localId: string }[]>`
    SELECT 'bean' AS kind, bean_id::text AS "itemId", local_id AS "localId" FROM tablet_beans WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'beanBatch', batch_id::text, local_id FROM tablet_bean_batches WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'grinder', grinder_id::text, local_id FROM tablet_grinders WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'basket', basket_id::text, local_id FROM tablet_baskets WHERE tablet_id = ${tabletId}::uuid
    UNION ALL SELECT 'tool', tool_id::text, local_id FROM tablet_tools WHERE tablet_id = ${tabletId}::uuid`;
  return tabletIds(rows);
}

/**
 * What writing Recipes of this content to a tablet with that map reads
 * besides them: the names DYE2 copies, and each Profile whole.
 */
async function writeContext(tx: Prisma.TransactionClient, ids: TabletIds, contents: readonly Record<string, unknown>[]): Promise<WriteContext> {
  const named = (key: string) => [...new Set(contents.flatMap((content) => (typeof content[key] === "string" ? [content[key] as string] : [])))];
  const tools = [...new Set(contents.flatMap((content) => (Array.isArray(content.toolIds) ? content.toolIds.filter((id): id is string => typeof id === "string") : [])))];
  const names = async (table: string, field: string, itemIds: string[]) =>
    new Map(
      (
        await tx.$queryRaw<{ id: string; name: string | null }[]>`
          SELECT id::text AS id, content ->> ${field} AS name FROM ${Prisma.raw(table)} WHERE id = ANY(${uuids(itemIds)}::uuid[])`
      ).map((row) => [row.id, row.name]),
    );
  const profiles = await tx.$queryRaw<{ id: string; profile: unknown }[]>`
    SELECT id, content -> 'profile' AS profile FROM profiles WHERE id = ANY(${named("profileId")}::text[])`;
  return {
    ids,
    beanNames: await names("beans", "name", named("beanId")),
    beanRoasters: await names("beans", "roaster", named("beanId")),
    grinderModels: await names("grinders", "model", named("grinderId")),
    basketNames: await names("baskets", "name", named("basketId")),
    toolNames: await names("tools", "name", tools),
    profiles: new Map(profiles.flatMap((row) => (isObject(row.profile) ? [[row.id, row.profile]] : []))),
  };
}

/**
 * Each Recipe of the Location that is not Archived, in a slot or not, in
 * slot order, then as they joined, with the record the tablet is to hold of
 * it (`recipeRecord`), as the tablet's writer plans its writes.
 */
export async function offeredRecipes(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string): Promise<OfferedRecipe[]> {
  const rows = await tx.$queryRaw<{ id: string; recordId: string; slot: number | null; content: unknown; fieldEdits: unknown }[]>`
    SELECT id::text AS id, record_id AS "recordId", slot, content, field_edits AS "fieldEdits" FROM recipes
    WHERE location_id = ${locationId}::uuid AND NOT archived ORDER BY slot NULLS LAST, created_at, id`;
  if (rows.length === 0) return [];
  const contents = rows.map((row) => (isObject(row.content) ? row.content : {}));
  const context = await writeContext(tx, await readTabletIds(tx, tablet.tabletId), contents);
  return rows.map((row, index) => ({
    id: row.id,
    recordId: row.recordId,
    record: recipeRecord(contents[index]!, row.slot, context, row.id),
    contentDecidedAt: latestDecision(readFieldEdits(row.fieldEdits)),
  }));
}

/** The tablet's records of Recipes, by its map: their content is what their Location's offer writes (`offeredRecipes`). */
export async function heldRecipes(tx: Prisma.TransactionClient, tabletId: string): Promise<HeldRecord[]> {
  const rows = await tx.$queryRaw<{ itemId: string; localId: string; record: Record<string, unknown> }[]>`
    SELECT recipe_id::text AS "itemId", local_id AS "localId", record FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid ORDER BY recipe_id`;
  return rows.map((row) => ({ ...row, content: null, contentDecidedAt: null }));
}

/** The record the tablet, with that map, is to hold of a Recipe of this content, in that slot. */
async function recordFor(tx: Prisma.TransactionClient, ids: TabletIds, content: Record<string, unknown>, slot: number | null, recipeId: string): Promise<RecipeView> {
  return recipeRecord(content, slot, await writeContext(tx, ids, [content]), recipeId);
}

/** What taking records into Recipes of the Location reads, given what they are to edit (`current`, each Recipe's content now). */
async function intakeContext(
  tx: Prisma.TransactionClient,
  ids: TabletIds,
  locationId: string | null,
  views: readonly RecipeView[],
  current: readonly Record<string, unknown>[],
): Promise<(view: RecipeView) => Promise<IntakeContext>> {
  const grinders = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM grinders WHERE location_id = ${locationId}::uuid AND NOT archived`;
  // The Recipes' batches, and those the records hold, as DYE2's editor picks one with its Bean.
  const picked = views.flatMap((view) => (typeof view.beanBatchId === "string" ? [ids.item("beanBatch", view.beanBatchId)] : [])).filter((id): id is string => id !== undefined);
  const batches = [...current.flatMap((content) => (typeof content.beanBatchId === "string" ? [content.beanBatchId] : [])), ...picked];
  const batchBeans = await tx.$queryRaw<{ id: string; beanId: string }[]>`
    SELECT id::text AS id, bean_id::text AS "beanId" FROM bean_batches WHERE id = ANY(${uuids(batches)}::uuid[])`;
  const beans = [...new Set(views.flatMap((view) => (typeof view.beanId === "string" ? [ids.item("bean", view.beanId)] : [])))].filter((id): id is string => id !== undefined);
  // Each Bean's batch most recently added at the Location that is still there.
  const latest = await tx.$queryRaw<{ beanId: string; id: string }[]>`
    SELECT DISTINCT ON (batch.bean_id) batch.bean_id::text AS "beanId", batch.id::text AS id
    FROM bean_batches AS batch
    JOIN beans AS bean ON bean.id = batch.bean_id
    JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
    WHERE batch.bean_id = ANY(${beans}::uuid[]) AND here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived
    ORDER BY batch.bean_id, here.added_at DESC, batch.created_at DESC, batch.id`;
  const base = {
    ids,
    grinders: new Set(grinders.map((row) => row.id)),
    batchBeans: new Map(batchBeans.map((row) => [row.id, row.beanId])),
    latestBatches: new Map(latest.map((row) => [row.beanId, row.id])),
  };
  return async (view) => ({ ...base, snapshotProfile: await snapshotProfile(tx, view) });
}

/** The Library Profile a record's `profileSnapshot` is, as DYE2 saves a profile read from the Workflow without its id; null for none. */
async function snapshotProfile(tx: Prisma.TransactionClient, view: RecipeView): Promise<string | null> {
  if ((typeof view.profileId === "string" && view.profileId !== "") || !isObject(view.profileSnapshot)) return null;
  const [row] = await tx.$queryRaw<{ id: string | null }[]>`SELECT ${profileOfSql(Prisma.sql`${JSON.stringify(view.profileSnapshot)}::jsonb`)} AS id`;
  return row?.id ?? null;
}

/** Each Recipe's content, its fields' latest edits, its Location and its slot there, by id, read in the transaction. */
async function readRecipes(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
): Promise<Map<string, { content: Record<string, unknown>; fieldEdits: FieldEdits; locationId: string | null; slot: number | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ id: string; content: unknown; fieldEdits: unknown; locationId: string | null; slot: number | null }[]>`
    SELECT id::text AS id, content, field_edits AS "fieldEdits", location_id::text AS "locationId", slot FROM recipes WHERE id = ANY(${[...new Set(ids)]}::uuid[])`;
  return new Map(
    rows.map((row) => [row.id, { content: isObject(row.content) ? row.content : {}, fieldEdits: readFieldEdits(row.fieldEdits), locationId: row.locationId, slot: row.slot }]),
  );
}

/**
 * Takes a tablet's report of its recipes into the Library, as
 * `takeInEquipment` takes its baskets, in the transaction storing the
 * report, if its Machine takes part (`planRecipeIntake`). A list in a shape
 * that is not recognised takes nothing in, and keeps the tablet's map as it
 * was: it is marked so for the tablet, which its writer then writes nothing
 * to. A report that is part of the tablet joining its Location takes nothing
 * of the tablet's in, but to a Location with no Recipes yet, which takes the
 * tablet's in, with their ids and slots (ADR-0018). A record's change of
 * slot moves its Recipe there (`moveSlots`). Once the map holds the record
 * the tablet's Workflow names, which it may have named first, as DYE2's
 * `save-recipe` makes and names one at once, the Recipe is loaded
 * (`recipeMapped`). Returns where the report was taken in (`standing`), or
 * null if nowhere.
 */
export async function takeInRecipes(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  value: unknown,
  updatedAt: readonly (string | null)[] | undefined,
): Promise<string | null> {
  const entry = await currentEntry(tx, tablet.machineId);
  if (entry === null) return null;
  const { locationId } = entry;
  const takenInAt = standing(entry);
  await lockTablet(tx, tablet.tabletId);
  const recognised = dye2Records(value) !== null;
  if (await markUnrecognised(tx, tablet.tabletId, "recipe", !recognised)) await notify(tx, "library_changes", locationId);
  if (!recognised) return takenInAt;
  /** Whether the report is part of the tablet joining the Location, so takes nothing of the tablet's into the Library (left-out.ts). */
  const joining = await takenIn(tx, tablet.tabletId, LIBRARY_ITEM_KINDS.recipe.list, entry);
  const read = readReportedRecipes(value, updatedAt);
  const listed = listedIds(value);
  const mapped = await tx.$queryRaw<(MappedRecipe & { contentSeenAt: Date | null })[]>`
    SELECT recipe_id::text AS "itemId", local_id AS "localId", record_updated_at AS "updatedAt", record, listed,
      content_seen_at AS "contentSeenAt"
    FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid`;
  const mappedById = new Map(mapped.map((record) => [record.itemId, record]));
  const mappedIds = new Set(mapped.map((record) => record.localId));
  // A record the server's write created is listed now, so gone from a later report it was deleted there.
  const newlyListed = mapped.filter((record) => !record.listed && listed.has(record.localId)).map((record) => record.localId);
  if (newlyListed.length > 0) {
    await tx.$executeRaw`UPDATE tablet_recipes SET listed = true WHERE tablet_id = ${tablet.tabletId}::uuid AND local_id = ANY(${newlyListed}::text[])`;
  }
  // A tablet holding no recipe, nor any the map holds, has nothing to take in, so takes no lock of its Location's.
  if (listed.size === 0 && mapped.length === 0) {
    if ((await setAsideDeleted(tx, tablet.tabletId, "recipe", [], listed, mappedIds)).due) await notify(tx, "library_changes", locationId);
    await screenLeftOut(tx, tablet.tabletId, "recipe", [], (record: ReportedRecipe) => ({ localId: record.localId, setAside: false }), listed, mappedIds, joining, true);
    return takenInAt;
  }
  // Records of Recipes an Admin hard-deleted are removed on the tablet rather than taken in.
  const screened = await setAsideDeleted(tx, tablet.tabletId, "recipe", read, listed, mappedIds);
  const reportedNew = screened.kept.filter((record) => !mappedIds.has(record.localId));
  // Record ids and slots are decided under the Location's lock, so two tablets saving a recipe in one empty slot at once
  // leave it to one Recipe.
  await lockLocation(tx, locationId);
  /** Whether the report joins a Location with no Recipes yet, so brings the tablet's own in. */
  const bringing = joining && !(await offersAny(tx, locationId, "recipe"));
  // DYE2's records cannot be set aside, only removed from the list, so one listed is never set aside.
  const left = await screenLeftOut(tx, tablet.tabletId, "recipe", reportedNew, (record) => ({ localId: record.localId, setAside: false }), listed, mappedIds, joining, true);
  const kept = new Set(left.kept);
  const reported = screened.kept.filter((record) => mappedIds.has(record.localId) || kept.has(record));
  const own = await tx.$queryRaw<{ id: string; recordId: string; archived: boolean }[]>`
    SELECT id::text AS id, record_id AS "recordId", archived FROM recipes WHERE location_id = ${locationId}::uuid`;
  const recordIds = new Map(own.flatMap((recipe) => (recipe.archived ? [] : [[recipe.recordId, recipe.id] as const])));
  const steps = planRecipeIntake(reported, mapped, recordIds, listed, new Set(own.map((recipe) => recipe.id)));
  if (steps.length === 0) {
    if (screened.due || left.due) await notify(tx, "library_changes", locationId);
    return takenInAt;
  }
  // The Recipes the report edits, compared with their content.
  const edited = steps.flatMap((step) => ((step.kind === "update" || step.kind === "edit") && !joining ? [step.itemId] : []));
  await lockItems(tx, "recipe", edited);
  const recipes = await readRecipes(tx, edited);
  const ids = await readTabletIds(tx, tablet.tabletId);
  const reportedViews = steps.flatMap((step) => ("reported" in step ? [recipeView(step.reported.record)] : []));
  const context = await intakeContext(tx, ids, locationId, reportedViews, [...recipes.values()].map((recipe) => recipe.content));
  const source = tabletSource(tablet);

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = screened.due || left.due;
  /** The tablet's moves of its Recipes to other slots, as their records' slots changed. */
  const moves: SlotMove[] = [];
  for (const step of steps) {
    if (step.kind === "delete" || step.kind === "forget") {
      await tx.$executeRaw`DELETE FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${step.itemId}::uuid`;
      // Deleted before the tablet joined, it is written again; lost as it was written, it is written again.
      if (step.kind === "delete" && !joining) await takeOutOfSlot(tx, step.itemId, locationId, recipeSlotOf(step.record), deletedAt(await transactionTime(tx), step.updatedAt), source);
      writesDue = true;
      continue;
    }
    const { reported: record } = step;
    const view = recipeView(record.record);
    // A joining tablet brings its own only to a Location with no Recipes yet; one of a Recipe the Location has is not its own.
    if (joining && joiningRecord(step.kind, bringing) === "leftOut") {
      writesDue = (await leaveOut(tx, tablet.tabletId, "recipe", { localId: record.localId, setAside: false })) || writesDue;
      continue;
    }
    let itemId: string;
    if (step.kind === "add") {
      const content = recipeContent(view, await context(view));
      // In no slot until its move below puts it in its record's (`placedIn`).
      const [created] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO recipes (id, location_id, record_id, content)
        VALUES (gen_random_uuid(), ${locationId}::uuid, ${record.localId}, ${JSON.stringify({ ...content, showOnDashboard: false })}::jsonb)
        RETURNING id::text AS id`;
      itemId = created!.id;
      await recordJoined(tx, { kind: "recipe", id: itemId }, content, record.updatedAt, source);
      const move = slotMove(itemId, null, record);
      if (move) moves.push(move);
    } else {
      itemId = step.itemId;
    }
    // A record the map holds whose Recipe this tablet joined with is written over, not taken in.
    const recipe = recipes.get(itemId);
    if (step.kind === "edit" && recipe) {
      // Saved under its id without having seen the Recipe there: each field it holds otherwise is its edit, merged with Conflicts.
      const values = libraryValues(view, EDITED_PATHS, recipe.content, await context(view));
      const changed = Object.fromEntries(Object.entries(values).filter(([field, value]) => !sameValue(recipe.content[field], value)));
      await editContent(tx, { kind: "recipe", id: itemId }, { values: changed, at: record.updatedAt, seenAt: null }, source);
    } else if (step.kind === "update") {
      const known = mappedById.get(itemId)!;
      const knownView = recipeView(known.record);
      if (!joining && recipe) {
        const edits = editedContent(knownView, view, null);
        // What DYE2 saved from the Workflow of a Machine with the Recipe loaded that is no edit, as the server's write of
        // it still to land, is written back over (ADR-0022). A save of DYE2's editor is none of DYE2's saves from the
        // Workflow, which its Workflow does not hold yet: the Recipe's is written into the Workflow then.
        if (!savedInEditor(known.record, record.record)) {
          for (const path of await recordedByDye2(tx, tablet, itemId, recipe.content, edits)) delete edits[path];
        }
        const paths = editedPaths(edits);
        if (paths.length > 0) {
          const values = withoutOwnEdits(libraryValues(view, paths, recipe.content, await context(view)), recipe.content, recipe.fieldEdits, tablet.tabletId);
          await editContent(tx, { kind: "recipe", id: itemId }, { values, at: record.updatedAt, seenAt: known.contentSeenAt }, source);
        }
        const move = slotMove(itemId, known.record, record);
        if (move) moves.push(move);
      }
    }
    // The record may differ from the Recipe now, or lack its global id: it is written.
    writesDue = true;
    await saveRecord(tx, tablet.tabletId, itemId, record.localId, record.record, record.updatedAt, { contentSeen: null, listed: true });
    if (step.kind !== "update") await recordMapped(tx, tablet, itemId, record.localId);
  }
  await moveSlots(tx, locationId, moves, source);
  if (writesDue) await notify(tx, "library_changes", locationId);
  return takenInAt;
}

/**
 * Carries out the tablet's moves of its Recipes at its Location, each as
 * DYE2's editor moves a recipe on the strip (`takeSlot` in
 * dye2:dye2-plugin/src/utils/dev-api.ts at v0.1.32): a Recipe moved out
 * of the slot its record known was in leaves it, and one moved into a slot
 * takes it from the Recipe there, which leaves it. A move is made only
 * where the Recipe is still in the slot the tablet knew it in (`from`), so
 * one made over a move the tablet had not seen, as in the management
 * interface, is not, and the Recipe's slot is written back. Each change is a
 * version of its own, from the tablet, timed as the record moved. Slots
 * left are emptied first, so no two Recipes are ever in one.
 */
async function moveSlots(tx: Prisma.TransactionClient, locationId: string, moves: readonly SlotMove[], source: ReturnType<typeof tabletSource>): Promise<void> {
  if (moves.length === 0) return;
  const rows = await tx.$queryRaw<{ id: string; slot: number | null }[]>`
    SELECT id::text AS id, slot FROM recipes WHERE id = ANY(${moves.map((move) => move.itemId)}::uuid[]) AND location_id = ${locationId}::uuid AND NOT archived`;
  const slots = new Map(rows.map((row) => [row.id, row.slot]));
  const made = moves.filter((move) => slots.has(move.itemId) && slots.get(move.itemId) === move.from);
  for (const move of made) {
    if (move.from !== null) await tx.$executeRaw`UPDATE recipes SET ${placedIn(null)} WHERE id = ${move.itemId}::uuid`;
  }
  for (const move of made) {
    if (move.to === null) {
      await recordVersion(tx, { kind: "recipe", id: move.itemId }, locationId, { slot: null }, source, move.at);
      continue;
    }
    const taken = await tx.$queryRaw<{ id: string }[]>`
      UPDATE recipes SET ${placedIn(null)} WHERE location_id = ${locationId}::uuid AND slot = ${move.to}::integer AND id <> ${move.itemId}::uuid
      RETURNING id::text AS id`;
    for (const { id } of taken) await recordVersion(tx, { kind: "recipe", id }, locationId, { slot: null }, source, move.at);
    await tx.$executeRaw`UPDATE recipes SET ${placedIn(move.to)} WHERE id = ${move.itemId}::uuid`;
    await recordVersion(tx, { kind: "recipe", id: move.itemId }, locationId, { slot: move.to }, source, move.at);
  }
}

/**
 * Takes the Recipe out of its slot at the tablet's Location, as the tablet's
 * record of it is gone from its list (ADR-0019), and keeps it there,
 * unslotted: a version of its own, from the tablet, timed when the server
 * learned of it. A Recipe in another slot now than the record was in, or at
 * another Location, stays where it is.
 */
async function takeOutOfSlot(tx: Prisma.TransactionClient, recipeId: string, locationId: string, slot: number | null, at: Date, source: ReturnType<typeof tabletSource>): Promise<void> {
  if (slot === null) return;
  const taken = await tx.$executeRaw`
    UPDATE recipes SET ${placedIn(null)} WHERE id = ${recipeId}::uuid AND location_id = ${locationId}::uuid AND slot = ${slot}::integer`;
  if (taken > 0) await recordVersion(tx, { kind: "recipe", id: recipeId }, locationId, { slot: null }, source, at);
}

/**
 * Records a Recipe's record as the plugin wrote it, as
 * `recordEquipmentWritten` does a Basket's: the tablet's record of that
 * Recipe from now on. A path the write did not set that differs from the
 * record known was edited on the tablet since its last report, and is
 * merged as a report's edit would be (ADR-0020), timed when the plugin
 * wrote it, but for one holding the value the server writes there, which is
 * no edit (`answeredEquipment`), and what DYE2 saved from the Workflow that
 * is no edit (`recordedByDye2`), which is written again.
 * A record the plugin `linked`, saved under its id before the tablet
 * reported it, is an edit of the Recipe, each field it holds otherwise
 * merged with Conflicts, but for one the Library left out as the tablet
 * joined, which the Recipe is written over. Recorded only while the
 * answering connection holds its Machine, under the Machine's and the
 * tablet's locks, then the Recipe's Location's and its row's. Nothing is
 * recorded when the record does not carry the Recipe's global id, or the
 * map holds it as another Recipe's, or when the Library no longer has the
 * Recipe.
 */
export async function recordRecipeWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  itemId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
  contentSeen: Date | null,
  linked: boolean,
): Promise<AnswerRecorded> {
  if (!isRecordId(record.id) || dye2GlobalIdOf(record) !== itemId.toLowerCase()) return "notTheItem";
  const localId = record.id;
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    // Its Location's lock first, which a Recipe's slots, its edits and the Loaded Recipe a Workflow names take before its
    // row, as this answer may move it (`moveSlots`) or load it (`recipeMapped`); the Location a Recipe belongs to never changes.
    const [owner] = await tx.$queryRaw<{ locationId: string | null }[]>`SELECT location_id::text AS "locationId" FROM recipes WHERE id = ${itemId}::uuid`;
    if (owner?.locationId) await lockLocation(tx, owner.locationId);
    // Its row locked, as an edit of it would, for its content before this answer.
    const [item] = await tx.$queryRaw<{ content: unknown; fieldEdits: unknown; locationId: string | null; slot: number | null }[]>`
      SELECT content, field_edits AS "fieldEdits", location_id::text AS "locationId", slot FROM recipes WHERE id = ${itemId}::uuid FOR NO KEY UPDATE`;
    if (!item) return "notTheItem";
    const [other] = await tx.$queryRaw<{ itemId: string }[]>`
      SELECT recipe_id::text AS "itemId" FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND local_id = ${localId}`;
    if (other && other.itemId !== itemId.toLowerCase()) return "notTheItem";
    const locationId = await sharingLocation(tx, tablet.machineId);
    const [known] = await tx.$queryRaw<{ record: Record<string, unknown>; contentSeenAt: Date | null; listed: boolean }[]>`
      SELECT record, content_seen_at AS "contentSeenAt", listed FROM tablet_recipes
      WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${itemId}::uuid`;
    const at = updatedAt === null ? await transactionTime(tx) : new Date(updatedAt);
    const source = tabletSource(tablet);
    const ref = { kind: "recipe", id: itemId } as const;
    const content = isObject(item.content) ? item.content : {};
    const ids = await readTabletIds(tx, tablet.tabletId);
    const view = recipeView(record);
    const context = await intakeContext(tx, ids, item.locationId, [view], [content]);
    let edited: EditOutcome | null = null;
    // A field DYE2 saved from the Workflow that is no edit, which no longer holds the Recipe's value, is written again.
    let stale = false;
    // A Recipe of another Location than the tablet's now, as before its writer removes it after a move, takes no edit there.
    const here = item.locationId !== null && item.locationId === locationId;
    if (known) {
      const answered = answeredEquipment(recipeView(known.record), view, written, null, await recordFor(tx, ids, content, item.slot, itemId));
      // What DYE2 saved into the record just before the plugin's read of the list, which its post kept, is judged as a
      // report's is (ADR-0022): every field the write did not set, as that is what the Workflow held, which the
      // Recipe's is written back over where it is no edit.
      const saved = savedInEditor(known.record, record);
      const unwritten = Object.fromEntries(Object.entries(editedContent(recipeView(known.record), view, null)).filter(([path]) => !written.has(path)));
      const recorded = here && !saved ? await recordedByDye2(tx, tablet, itemId, content, unwritten) : new Set<string>();
      // Steam turned off, taken in as no edit (`libraryValues`), is written back over too.
      const steamOff = steamOffPaths(answered.values).length > 0;
      for (const path of recorded) delete answered.values[path];
      const paths = editedPaths(answered.values);
      // Edited on the tablet before the plugin wrote: judged by what the record had seen before.
      const values = paths.length === 0 || !here ? {} : withoutOwnEdits(libraryValues(view, paths, content, await context(view)), content, readFieldEdits(item.fieldEdits), tablet.tabletId);
      edited = await editContent(tx, ref, { values, at, seenAt: known.contentSeenAt }, source);
      const now = await recordFor(tx, ids, (await readRecipes(tx, [itemId])).get(itemId)?.content ?? content, item.slot, itemId);
      stale = (answered.stale || recorded.size > 0 || steamOff) && !holdsRecipe(view, now);
      // Moved on the tablet since its last report, as the write set neither its slot nor whether it is shown.
      const moved = !written.has(RECIPE_SLOT_FIELD) && !written.has(RECIPE_SHOWN_FIELD);
      const move = here && moved ? slotMove(itemId, known.record, { localId, globalId: itemId, updatedAt: at, record }) : null;
      if (move && locationId !== null) {
        await moveSlots(tx, locationId, [move], source);
        stale = true;
      }
    } else if (!linked) {
      // Created by the write.
    } else if (!here || (await forgetLeftOut(tx, tablet.tabletId, localId))) {
      // A record the Library left out as the tablet joined, not yet removed, or one at another Location than the Recipe's:
      // the Recipe is written over it, so the record has not seen its content.
      edited = { writesDue: true, lost: true };
    } else {
      // Saved under its id before the tablet reported it: each field it holds otherwise is its edit, merged with Conflicts.
      const values = libraryValues(view, EDITED_PATHS, content, await context(view));
      const changed = Object.fromEntries(Object.entries(values).filter(([field, value]) => !sameValue(content[field], value)));
      edited = await editContent(tx, ref, { values: changed, at, seenAt: null }, source);
    }
    if (((edited?.writesDue ?? false) || stale) && locationId !== null) await notify(tx, "library_changes", locationId);
    const holds = contentSeen !== null && !stale && (edited !== null ? !edited.lost : holdsRecipe(view, await recordFor(tx, ids, content, item.slot, itemId)));
    await saveRecord(tx, tablet.tabletId, itemId, localId, record, at, { contentSeen: holds ? contentSeen : null, listed: known?.listed ?? false });
    if (!known && here) await recordMapped(tx, tablet, itemId, localId);
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * Once the tablet's map holds its record of a Recipe under that id, which it
 * held none of: the Shots the tablet reported naming that id are linked to
 * it (`linkRecipeShots`), and a Workflow of the tablet's naming it loads it
 * (`recipeMapped`), as for a recipe DYE2's `save-recipe` made and named at
 * once, whose record reaches the server after the Workflow naming it.
 */
async function recordMapped(tx: Prisma.TransactionClient, tablet: ReportingTablet, recipeId: string, localId: string): Promise<void> {
  await linkRecipeShots(tx, tablet.tabletId, recipeId, localId);
  await recipeMapped(tx, tablet, localId);
}

/**
 * Forgets that the Library leaves out the tablet's record of that id, as a
 * write of the Location's Recipe made it that Recipe's record, and says
 * whether it did: the tablet held it as it joined the Location, so it is
 * written over rather than taken in (ADR-0018).
 */
async function forgetLeftOut(tx: Prisma.TransactionClient, tabletId: string, localId: string): Promise<boolean> {
  return (await tx.$executeRaw`DELETE FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND kind = 'recipe' AND local_id = ${localId}`) > 0;
}

/**
 * Saves the tablet's record of a Recipe as the one it holds, under its id
 * there, keeping the latest edit of its content it has seen; null keeps the
 * one known. A record of another Recipe the map held under that id is the
 * tablet's no longer.
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  recipeId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
  state: { contentSeen: Date | null; listed: boolean },
): Promise<void> {
  await tx.$executeRaw`DELETE FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND local_id = ${localId} AND recipe_id <> ${recipeId}::uuid`;
  await tx.$executeRaw`
    INSERT INTO tablet_recipes AS held (tablet_id, recipe_id, local_id, record, record_updated_at, listed, content_seen_at)
    VALUES (${tabletId}::uuid, ${recipeId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz, ${state.listed},
      ${state.contentSeen}::timestamptz)
    ON CONFLICT (tablet_id, recipe_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at, listed = EXCLUDED.listed,
      content_seen_at = GREATEST(held.content_seen_at, EXCLUDED.content_seen_at)`;
}

/** The ids that are UUIDs: any other, as a record's own field may hold, names no item. */
function uuids(ids: readonly string[]): string[] {
  return ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
}
