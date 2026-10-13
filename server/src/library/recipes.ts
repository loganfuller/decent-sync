import { LIBRARY_ITEM_KINDS, dye2GlobalIdOf, dye2Records, isSlotId, sameValue } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { profileOfSql } from "../shots/links.js";
import { type EditOutcome, editContent, lockItems, recordJoined } from "./content-edits.js";
import { markUnrecognised } from "./dye2-lists.js";
import { answeredEquipment, beforeWriteAfter, editedContent, withoutSettled } from "./equipment-intake.js";
import { setAsideDeleted } from "./hard-deletes.js";
import { recordVersion, tabletSource } from "./history.js";
import type { HeldRecord, OfferedRecipe } from "./holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet, sharingLocation } from "./intake.js";
import { standing } from "./join-plan.js";
import { currentEntry, takenIn } from "./joining.js";
import { leaveOut, offersAny, screenLeftOut } from "./left-out.js";
import { isObject, listedIds } from "./listed.js";
import { editSettingsInRecipe, mirroredSettings } from "./location-settings.js";
import { deletedAt, lockLocation, transactionTime } from "./location-state.js";
import { latestDecision, readFieldEdits } from "./merge.js";
import {
  EDITED_PATHS,
  type IntakeContext,
  type MappedKind,
  type MappedRecipe,
  type RecipeView,
  type ReportedRecipe,
  type TabletIds,
  type WriteContext,
  editedPaths,
  holdsRecipe,
  holdsRecord,
  libraryValues,
  planRecipeIntake,
  readReportedRecipes,
  recipeContent,
  recipeRecord,
  recipeView,
  settingsValues,
  tabletIds,
} from "./recipe-intake.js";

// The Library's Recipes and the tablets that hold them (ADR-0005, ADR-0006,
// ADR-0019, ADR-0020): DYE2's recipes, which it keeps whole in a list under
// one key of Decaid's store, each under its Recipe Slot's number. A Recipe
// belongs to one Location and sits in one of its slots, or none. A tablet
// at a Location reports the list as a collection: a recipe saved in a slot
// is an edit of the Location's Recipe in that slot, merged per field
// (content-edits.ts), timed by when the plugin first read it, or a new
// Recipe there if the slot was empty; Recipes are never matched (ADR-0018).
// A recipe gone from a tablet's list is taken out of its slot at that
// Location and kept. Each sharing tablet holds its Location's slotted
// Recipes in slot order, each record naming the items it uses by the
// tablet's own ids and carrying what DYE2 derives from them, regenerated
// (recipe-intake.ts), and its global id in a top-level field of its own,
// beside the server's map per tablet; a slot that is emptied is removed from
// the list (holdings.ts). Each record's steam and flush values mirror the
// steam and rinse settings its tablet's Machine takes part in (ADR-0014), and
// a barista's change of one in a record the map holds is an edit of those
// settings (location-settings.ts).
//
// Under the locks equipment.ts takes, in the same order: the Machine's row,
// the tablet's, the Location's, under which its slots are decided, then the
// Recipes' rows, then the Location's settings' row.

/** The tablet's map of the items a recipe names, by their global ids and its own (ADR-0006). */
export async function readTabletIds(tx: Prisma.TransactionClient, tabletId: string): Promise<TabletIds> {
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
 * besides them: the names DYE2 copies, each Profile whole, and the steam and
 * rinse settings the tablet's recipes mirror at the Location.
 */
async function writeContext(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  locationId: string | null,
  ids: TabletIds,
  contents: readonly Record<string, unknown>[],
): Promise<WriteContext> {
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
    grinderModels: await names("grinders", "model", named("grinderId")),
    basketNames: await names("baskets", "name", named("basketId")),
    toolNames: await names("tools", "name", tools),
    profiles: new Map(profiles.flatMap((row) => (isObject(row.profile) ? [[row.id, row.profile]] : []))),
    settings: await mirroredSettings(tx, tablet, locationId),
  };
}

/**
 * Each Recipe in a slot of the Location, in slot order, with the record the
 * tablet is to hold of it (`recipeRecord`), as the tablet's writer plans
 * its writes.
 */
export async function offeredRecipes(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string): Promise<OfferedRecipe[]> {
  const rows = await tx.$queryRaw<{ id: string; slot: number; content: unknown; fieldEdits: unknown }[]>`
    SELECT id::text AS id, slot, content, field_edits AS "fieldEdits" FROM recipes
    WHERE location_id = ${locationId}::uuid AND slot IS NOT NULL AND NOT archived ORDER BY slot`;
  if (rows.length === 0) return [];
  const contents = rows.map((row) => (isObject(row.content) ? row.content : {}));
  const context = await writeContext(tx, tablet, locationId, await readTabletIds(tx, tablet.tabletId), contents);
  return rows.map((row, index) => ({
    id: row.id,
    slot: row.slot,
    record: recipeRecord(contents[index]!, row.slot, context),
    contentDecidedAt: latestDecision(readFieldEdits(row.fieldEdits)),
  }));
}

/** The tablet's records of Recipes, by its map: their content is what their Location's offer writes (`offeredRecipes`). */
export async function heldRecipes(tx: Prisma.TransactionClient, tabletId: string): Promise<HeldRecord[]> {
  const rows = await tx.$queryRaw<{ itemId: string; localId: string; record: Record<string, unknown> }[]>`
    SELECT recipe_id::text AS "itemId", local_id AS "localId", record FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid ORDER BY recipe_id`;
  return rows.map((row) => ({ ...row, content: null, contentDecidedAt: null }));
}

/** The record the tablet, with that map, at the Location, is to hold of a Recipe of this content, in the slot its record is in. */
async function recordFor(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  locationId: string | null,
  ids: TabletIds,
  content: Record<string, unknown>,
  localId: string,
): Promise<RecipeView> {
  return recipeRecord(content, Number(localId), await writeContext(tx, tablet, locationId, ids, [content]));
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
  const batches = current.flatMap((content) => (typeof content.beanBatchId === "string" ? [content.beanBatchId] : []));
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

/** Each Recipe's content and Location, by id, read in the transaction. */
async function readRecipes(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<Map<string, { content: Record<string, unknown>; locationId: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ id: string; content: unknown; locationId: string | null }[]>`
    SELECT id::text AS id, content, location_id::text AS "locationId" FROM recipes WHERE id = ANY(${[...new Set(ids)]}::uuid[])`;
  return new Map(rows.map((row) => [row.id, { content: isObject(row.content) ? row.content : {}, locationId: row.locationId }]));
}

/**
 * Takes a tablet's report of its recipes into the Library, as
 * `takeInEquipment` takes its baskets, in the transaction storing the
 * report, if its Machine takes part (`planRecipeIntake`). A list in a shape
 * that is not recognised, as one whose ids are not slot numbers, takes
 * nothing in, and keeps the tablet's map as it was: it is marked so for the
 * tablet, which its writer then writes nothing to. A report that is part of
 * the tablet joining its Location takes nothing of the tablet's in, but to a
 * Location with no Recipes yet, which takes the tablet's in their slots
 * (ADR-0018). Returns where the report was taken in (`standing`), or null if
 * nowhere.
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
  const recognised = dye2Records(value, "recipes") !== null;
  if (await markUnrecognised(tx, tablet.tabletId, "recipe", !recognised)) await notify(tx, "library_changes", locationId);
  if (!recognised) return takenInAt;
  /** Whether the report is part of the tablet joining the Location, so takes nothing of the tablet's into the Library (left-out.ts). */
  const joining = await takenIn(tx, tablet.tabletId, LIBRARY_ITEM_KINDS.recipe.list, entry);
  const read = readReportedRecipes(value, updatedAt);
  const listed = listedIds(value);
  const mapped = await tx.$queryRaw<(MappedRecipe & { contentSeenAt: Date | null })[]>`
    SELECT recipe_id::text AS "itemId", local_id AS "localId", record_updated_at AS "updatedAt", record, before_write AS "beforeWrite", listed,
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
  // Slots are decided under the Location's lock, so two tablets saving a recipe in one empty slot at once make one Recipe.
  await lockLocation(tx, locationId);
  /** Whether the report joins a Location with no Recipes yet, so brings the tablet's own in their slots. */
  const bringing = joining && !(await offersAny(tx, locationId, "recipe"));
  // DYE2's records cannot be set aside, only removed from the list, so one listed is never set aside.
  const left = await screenLeftOut(tx, tablet.tabletId, "recipe", reportedNew, (record) => ({ localId: record.localId, setAside: false }), listed, mappedIds, joining, true);
  const kept = new Set(left.kept);
  const reported = screened.kept.filter((record) => mappedIds.has(record.localId) || kept.has(record));
  const own = await tx.$queryRaw<{ id: string; slot: number | null }[]>`SELECT id::text AS id, slot FROM recipes WHERE location_id = ${locationId}::uuid`;
  const slots = new Map(own.flatMap((recipe) => (recipe.slot === null ? [] : [[String(recipe.slot), recipe.id] as const])));
  const steps = planRecipeIntake(reported, mapped, slots, listed, new Set(own.map((recipe) => recipe.id)));
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
  for (const step of steps) {
    if (step.kind === "delete" || step.kind === "forget") {
      await tx.$executeRaw`DELETE FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${step.itemId}::uuid`;
      // Deleted before the tablet joined, it is written again if the Location has it in a slot; lost as it was written, it is written again.
      if (step.kind === "delete" && !joining) await takeOutOfSlot(tx, step.itemId, locationId, step.localId, deletedAt(await transactionTime(tx), step.updatedAt), source);
      writesDue = true;
      continue;
    }
    const { reported: record } = step;
    const view = recipeView(record.record);
    // A joining tablet brings its own only to a Location with no Recipes yet; one in a slot the Location fills is not its Recipe's.
    if ((step.kind === "add" && joining && !bringing) || (step.kind === "edit" && joining)) {
      writesDue = (await leaveOut(tx, tablet.tabletId, "recipe", { localId: record.localId, setAside: false })) || writesDue;
      continue;
    }
    let itemId: string;
    if (step.kind === "add") {
      const content = recipeContent(view, await context(view));
      const [created] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO recipes (id, location_id, slot, content)
        VALUES (gen_random_uuid(), ${locationId}::uuid, ${Number(record.localId)}::integer, ${JSON.stringify(content)}::jsonb)
        RETURNING id::text AS id`;
      itemId = created!.id;
      await recordJoined(tx, { kind: "recipe", id: itemId }, content, record.updatedAt, source);
    } else {
      itemId = step.itemId;
    }
    // A record the map holds whose Recipe this tablet joined with is written over, not taken in.
    const recipe = recipes.get(itemId);
    let beforeWrite: { beforeWrite?: Record<string, unknown> | null } = {};
    if (step.kind === "edit" && recipe) {
      // Saved in the slot without having seen the Recipe there: each field it holds otherwise is its edit, merged with Conflicts.
      const values = libraryValues(view, EDITED_PATHS, recipe.content, await context(view));
      const changed = Object.fromEntries(Object.entries(values).filter(([field, value]) => !sameValue(recipe.content[field], value)));
      await editContent(tx, { kind: "recipe", id: itemId }, { values: changed, at: record.updatedAt, seenAt: null }, source);
    } else if (step.kind === "update") {
      const known = mappedById.get(itemId)!;
      const knownView = recipeView(known.record);
      if (!joining && recipe) {
        const edits = editedContent(knownView, view, known.beforeWrite);
        const paths = editedPaths(edits);
        if (paths.length > 0) {
          const values = libraryValues(view, paths, recipe.content, await context(view));
          await editContent(tx, { kind: "recipe", id: itemId }, { values, at: record.updatedAt, seenAt: known.contentSeenAt }, source);
        }
        // A steam or flush value changed is an edit of the settings the record mirrors, not of the Recipe.
        await editSettingsInRecipe(tx, tablet, locationId, settingsValues(view, Object.keys(edits)), record.updatedAt);
      }
      // A field the tablet set to a value of its own no longer takes setting it back for a stale save, nor one it and the
      // Recipe both hold at its value before the server's write.
      const standingBefore = beforeWriteAfter(known.beforeWrite, knownView, view);
      const content = recipe ? (await readRecipes(tx, [itemId])).get(itemId)?.content : undefined;
      beforeWrite = {
        beforeWrite:
          standingBefore && !joining && content ? withoutSettled(standingBefore, view, await recordFor(tx, tablet, locationId, ids, content, record.localId)) : standingBefore,
      };
    }
    // The record may differ from the Recipe now, or lack its global id: it is written.
    writesDue = true;
    await saveRecord(tx, tablet.tabletId, itemId, record.localId, record.record, record.updatedAt, { contentSeen: null, listed: true, ...beforeWrite });
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return takenInAt;
}

/**
 * Takes the Recipe out of its slot at the tablet's Location, as the tablet's
 * record of it in that slot is gone from its list (ADR-0019), and keeps it
 * there, unslotted: a version of its own, from the tablet, timed when the
 * server learned of it. A Recipe in another slot now, or at another
 * Location, stays where it is.
 */
async function takeOutOfSlot(tx: Prisma.TransactionClient, recipeId: string, locationId: string, localId: string, at: Date, source: ReturnType<typeof tabletSource>): Promise<void> {
  const taken = await tx.$executeRaw`
    UPDATE recipes SET slot = NULL WHERE id = ${recipeId}::uuid AND location_id = ${locationId}::uuid AND slot = ${Number(localId)}::integer`;
  if (taken > 0) await recordVersion(tx, { kind: "recipe", id: recipeId }, locationId, { slot: null }, source, at);
}

/**
 * Records a Recipe's record as the plugin wrote it, as
 * `recordEquipmentWritten` does a Basket's: the tablet's record of that
 * Recipe from now on. A path the write did not set that differs from the
 * record known was edited on the tablet since its last report, and is
 * merged as a report's edit would be (ADR-0020), timed when the plugin
 * wrote it, but for one set back to its value before an earlier write of the
 * server's, which is taken as unchanged and written again, and one holding
 * the value the server writes there, which is no edit (`answeredEquipment`).
 * A record the plugin `linked`, saved in the slot before the tablet reported
 * it, is an edit of the Recipe, each field it holds otherwise merged with
 * Conflicts, but for one the Library left out as the tablet joined, which
 * the Recipe is written over. Recorded only while the answering connection holds its
 * Machine, under the Machine's and the tablet's locks. Nothing is recorded
 * when the record is not in a slot, does not carry the Recipe's global id,
 * or the map holds it as another Recipe's, or when the Library no longer has
 * the Recipe.
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
  if (!isSlotId(record.id) || dye2GlobalIdOf(record) !== itemId.toLowerCase()) return "notTheItem";
  const localId = record.id;
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    // Its row locked, as an edit of it would, for its content before this answer.
    const [item] = await tx.$queryRaw<{ content: unknown; locationId: string | null }[]>`
      SELECT content, location_id::text AS "locationId" FROM recipes WHERE id = ${itemId}::uuid FOR NO KEY UPDATE`;
    if (!item) return "notTheItem";
    const [other] = await tx.$queryRaw<{ itemId: string }[]>`
      SELECT recipe_id::text AS "itemId" FROM tablet_recipes WHERE tablet_id = ${tablet.tabletId}::uuid AND local_id = ${localId}`;
    if (other && other.itemId !== itemId.toLowerCase()) return "notTheItem";
    const locationId = await sharingLocation(tx, tablet.machineId);
    const [known] = await tx.$queryRaw<{ record: Record<string, unknown>; contentSeenAt: Date | null; listed: boolean; beforeWrite: Record<string, unknown> | null }[]>`
      SELECT record, content_seen_at AS "contentSeenAt", listed, before_write AS "beforeWrite" FROM tablet_recipes
      WHERE tablet_id = ${tablet.tabletId}::uuid AND recipe_id = ${itemId}::uuid`;
    const at = updatedAt === null ? await transactionTime(tx) : new Date(updatedAt);
    const source = tabletSource(tablet);
    const ref = { kind: "recipe", id: itemId } as const;
    const content = isObject(item.content) ? item.content : {};
    const ids = await readTabletIds(tx, tablet.tabletId);
    const view = recipeView(record);
    const context = await intakeContext(tx, ids, item.locationId, [view], [content]);
    let edited: EditOutcome | null = null;
    // A field set back by a stale save, or a write lost, that no longer holds the Recipe's value, which is written again; or
    // one of the settings the record mirrors that does not hold theirs, as a blank value or one put back on a Machine whose
    // sharing of them is off.
    let stale = false;
    let staleSettings = false;
    let answeredBefore: { beforeWrite?: Record<string, unknown> | null } = {};
    // A Recipe of another Location than the tablet's now, as before its writer removes it after a move, takes no edit there.
    const here = item.locationId !== null && item.locationId === locationId;
    if (known) {
      const answered = answeredEquipment(recipeView(known.record), view, written, known.beforeWrite, await recordFor(tx, tablet, locationId, ids, content, localId));
      const paths = editedPaths(answered.values);
      // Edited on the tablet before the plugin wrote: judged by what the record had seen before.
      const values = paths.length === 0 || !here ? {} : libraryValues(view, paths, content, await context(view));
      edited = await editContent(tx, ref, { values, at, seenAt: known.contentSeenAt }, source);
      if (here) await editSettingsInRecipe(tx, tablet, locationId!, settingsValues(view, Object.keys(answered.values)), at);
      const now = await recordFor(tx, tablet, locationId, ids, (await readRecipes(tx, [itemId])).get(itemId)?.content ?? content, localId);
      stale = answered.stale && !holdsRecipe(view, now);
      staleSettings = !holdsRecord(view, now);
      answeredBefore = { beforeWrite: answered.beforeWrite };
    } else if (linked && (!here || (await forgetLeftOut(tx, tablet.tabletId, localId)))) {
      // A record the Library left out as the tablet joined, not yet removed, or one at another Location than the Recipe's:
      // the Recipe is written over it, so the record has not seen its content.
      edited = { writesDue: true, lost: true };
    } else if (linked) {
      // Saved in the slot before the tablet reported it: each field it holds otherwise is its edit, merged with Conflicts.
      const values = libraryValues(view, EDITED_PATHS, content, await context(view));
      const changed = Object.fromEntries(Object.entries(values).filter(([field, value]) => !sameValue(content[field], value)));
      edited = await editContent(tx, ref, { values: changed, at, seenAt: null }, source);
    }
    if (((edited?.writesDue ?? false) || staleSettings) && locationId !== null) await notify(tx, "library_changes", locationId);
    const holds = contentSeen !== null && !stale && (edited !== null ? !edited.lost : holdsRecipe(view, await recordFor(tx, tablet, locationId, ids, content, localId)));
    await saveRecord(tx, tablet.tabletId, itemId, localId, record, at, { contentSeen: holds ? contentSeen : null, listed: known?.listed ?? false, ...answeredBefore });
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * Forgets that the Library leaves out the tablet's record in that slot, as a
 * write of the Location's Recipe made it that Recipe's record, and says
 * whether it did: the tablet held it as it joined the Location, so it is
 * written over rather than taken in (ADR-0018).
 */
async function forgetLeftOut(tx: Prisma.TransactionClient, tabletId: string, localId: string): Promise<boolean> {
  return (await tx.$executeRaw`DELETE FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND kind = 'recipe' AND local_id = ${localId}`) > 0;
}

/**
 * Saves the tablet's record of a Recipe as the one it holds, under its slot
 * there, keeping the latest edit of its content it has seen; null keeps the
 * one known. `beforeWrite`, when given, replaces what it held before the
 * server's latest write, null for nothing; otherwise that is kept. A record
 * of another Recipe the map held in that slot is the tablet's no longer.
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  recipeId: string,
  localId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
  state: { contentSeen: Date | null; listed: boolean; beforeWrite?: Record<string, unknown> | null },
): Promise<void> {
  const beforeWrite = state.beforeWrite === undefined || state.beforeWrite === null ? null : JSON.stringify(state.beforeWrite);
  await tx.$executeRaw`DELETE FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND local_id = ${localId} AND recipe_id <> ${recipeId}::uuid`;
  await tx.$executeRaw`
    INSERT INTO tablet_recipes AS held (tablet_id, recipe_id, local_id, record, record_updated_at, before_write, listed, content_seen_at)
    VALUES (${tabletId}::uuid, ${recipeId}::uuid, ${localId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz, ${beforeWrite}::jsonb, ${state.listed},
      ${state.contentSeen}::timestamptz)
    ON CONFLICT (tablet_id, recipe_id) DO UPDATE SET
      local_id = EXCLUDED.local_id, record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at, listed = EXCLUDED.listed,
      before_write = ${state.beforeWrite === undefined ? Prisma.sql`held.before_write` : Prisma.sql`EXCLUDED.before_write`},
      content_seen_at = GREATEST(held.content_seen_at, EXCLUDED.content_seen_at)`;
}

/** The ids that are UUIDs: any other, as a record's own field may hold, names no item. */
function uuids(ids: readonly string[]): string[] {
  return ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
}
