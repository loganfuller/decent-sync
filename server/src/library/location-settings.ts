import { SETTINGS_KIND, SHARED_SETTINGS, type SharedSetting, type SharedSettings, sameValue, sharedSettingsOf } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { type EditOutcome, type ItemEdit, decisionTime } from "./content-edits.js";
import { type EditSource, type ItemRef, recordConflict, recordReplaced, recordVersion, tabletSource } from "./history.js";
import type { PlannedWrite } from "./holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet } from "./intake.js";
import { type CurrentEntry, standing } from "./join-plan.js";
import { currentEntry, takeInWorkflowContext, takenIn } from "./joining.js";
import { transactionTime } from "./location-state.js";
import { type FieldEdits, editsAfter, latestDecision, mergeEdit, readFieldEdits } from "./merge.js";
import { MIRRORED_PATHS, blankApplied, staleApplied } from "./recipe-intake.js";
import { type LocationValues, mirroredValues, readLocationValues, settingsEdits, settingsToWrite } from "./settings-intake.js";

// Each Location's steam and rinse settings, shared by its Machines whatever
// their model (ADR-0014), each a field of its own merged as edits of a
// Library item's content are, with versions and Conflicts (ADR-0020). A
// tablet's edits arrive in the Workflow it reports (`workflow` deliveries),
// timed by when the plugin observed them; only the settings count, so a
// change of its hot water, which is each Machine's own, to be set by its
// Loaded Recipe (ADR-0022), is no edit of them. The first Machine at a
// Location to report its Workflow sets them. DYE2's recipes hold a steam
// time or flow and a flush time, which applying one merges into the
// Workflow, so each recipe written to a tablet mirrors them
// (`mirroredSettings`), and a change of one inside a recipe is an edit of
// them too (`editSettingsInRecipe`); a Workflow set back to a value its
// recipes held before the server's latest write of it, as by a recipe
// applied from a stale copy, is not. A Machine whose settings sharing is
// turned off takes no part: nothing of them is taken from its tablet or
// written to it, and its recipes mirror its own.
// The server keeps, per tablet, the settings as it last had them, reported
// or as Decaid returned the plugin's write of them, so the plugin's own
// write is never read as the tablet's edit (ADR-0003). Under the same locks
// as the Library's intake: the reporting Machine's row, the tablet's, then
// the settings' row, which edits in the management interface take alone,
// and an edit inside a recipe takes after the Recipes' rows.

/** A Location's settings, as edits merge them. */
interface EditedSettings {
  id: string;
  locationId: string;
  values: LocationValues;
  fieldEdits: FieldEdits;
}

/** A tablet's settings as it last had them, and what they had seen. */
interface HeldSettings {
  settingsId: string;
  values: SharedSettings | null;
  contentSeenAt: Date | null;
}

/** Whether a Machine's tablet shares its Location's settings: on, unless an account turned its sharing of them off, or an Admin its sharing. */
async function sharesSettings(tx: Prisma.TransactionClient, machineId: string): Promise<boolean> {
  return (await sharing(tx, machineId)).shares;
}

/**
 * Whether a Machine's tablet shares its Location's settings now, and whether
 * it did when the tablet observed a change: one observed before the Machine
 * last had sharing turned on was made while it kept its own settings, and is not
 * shared, though delivered later, as from a tablet that was offline or whose
 * outbox held it. Compared with PostgreSQL's clock, which timed the switch,
 * as other tablet times are (ADR-0003).
 */
async function sharing(tx: Prisma.TransactionClient, machineId: string, observedAt?: Date): Promise<{ shares: boolean; sharedThen: boolean }> {
  const [row] = await tx.$queryRaw<{ shares: boolean; since: Date | null }[]>`
    SELECT shares_settings AND sharing AS shares, shares_settings_since AS since FROM machines WHERE id = ${machineId}::uuid`;
  const shares = row?.shares ?? false;
  const sharedThen = shares && (observedAt === undefined || row!.since === null || observedAt.getTime() >= row!.since.getTime());
  return { shares, sharedThen };
}

/** The Location's settings, created unset if it has none yet, under their row lock. */
async function lockSettingsAt(tx: Prisma.TransactionClient, locationId: string): Promise<EditedSettings> {
  await tx.$executeRaw`
    INSERT INTO location_settings (id, location_id) VALUES (gen_random_uuid(), ${locationId}::uuid)
    ON CONFLICT (location_id) DO NOTHING`;
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM location_settings WHERE location_id = ${locationId}::uuid`;
  return (await lockSettings(tx, row!.id))!;
}

/** The settings with that id, under their row lock, or null if there are none. */
export async function lockSettings(tx: Prisma.TransactionClient, id: string): Promise<EditedSettings | null> {
  const [row] = await tx.$queryRaw<{ id: string; locationId: string; values: unknown; fieldEdits: unknown }[]>`
    SELECT id, location_id AS "locationId", values, field_edits AS "fieldEdits" FROM location_settings WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
  return row ? { id: row.id, locationId: row.locationId, values: readLocationValues(row.values), fieldEdits: readFieldEdits(row.fieldEdits) } : null;
}

/** A tablet's settings, by field name, as stored; null unless every one is there. */
function readHeld(value: unknown): SharedSettings | null {
  const values = readLocationValues(value);
  return SHARED_SETTINGS.every((field) => values[field] !== undefined) ? (values as SharedSettings) : null;
}

async function heldSettings(tx: Prisma.TransactionClient, tabletId: string): Promise<HeldSettings | null> {
  const [row] = await tx.$queryRaw<{ settingsId: string; values: unknown; contentSeenAt: Date | null }[]>`
    SELECT settings_id AS "settingsId", values, content_seen_at AS "contentSeenAt" FROM tablet_settings WHERE tablet_id = ${tabletId}::uuid`;
  return row ? { settingsId: row.settingsId, values: readHeld(row.values), contentSeenAt: row.contentSeenAt } : null;
}

/**
 * Saves the tablet's settings as the ones it has, of `settingsId`, with the
 * latest edit of them it has seen: the later of the one known, if of the
 * same settings, and `contentSeen`, a write's; null keeps the one known.
 */
async function saveHeld(tx: Prisma.TransactionClient, tabletId: string, settingsId: string, values: SharedSettings, contentSeen: Date | null): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_settings (tablet_id, settings_id, values, content_seen_at)
    VALUES (${tabletId}::uuid, ${settingsId}::uuid, ${JSON.stringify(values)}::jsonb, ${contentSeen}::timestamptz)
    ON CONFLICT (tablet_id) DO UPDATE SET
      values = EXCLUDED.values,
      content_seen_at = CASE WHEN tablet_settings.settings_id = EXCLUDED.settings_id
        THEN GREATEST(tablet_settings.content_seen_at, EXCLUDED.content_seen_at) ELSE EXCLUDED.content_seen_at END,
      settings_id = EXCLUDED.settings_id`;
}

/**
 * Merges an edit of the settings (`mergeEdit`), as `editContent` merges one
 * of an item's content: the fields it decides are set and kept as a version
 * of the settings, at their Location, and each value that lost, or that it
 * replaced without its maker having seen it, as a Conflict. Takes the
 * settings' row lock, if not held already.
 */
export async function editSettings(tx: Prisma.TransactionClient, settingsId: string, edit: ItemEdit, source: EditSource): Promise<EditOutcome> {
  if (Object.keys(edit.values).length === 0) return { writesDue: false, lost: false };
  const current = await lockSettings(tx, settingsId);
  if (!current) return { writesDue: false, lost: false };
  const item: ItemRef = { kind: SETTINGS_KIND, id: current.id };
  const seenAt = edit.seenAt === "everything" ? latestDecision(current.fieldEdits) : edit.seenAt;
  const merged = mergeEdit(current.values, current.fieldEdits, { ...edit, seenAt, tabletId: source.tabletId });
  for (const [field, value] of Object.entries(merged.lost)) await recordConflict(tx, item, current.locationId, field, value, source, edit.at);
  for (const { field, value, versionId } of merged.overwritten) await recordReplaced(tx, item, current.locationId, field, value, versionId);
  const lost = Object.keys(merged.lost).length > 0;
  if (Object.keys(merged.applied).length === 0) return { writesDue: lost, lost };
  const versionId = await recordVersion(tx, item, current.locationId, merged.applied, source, edit.at);
  const decidedAt = await decisionTime(tx, current.fieldEdits);
  const fieldEdits = editsAfter(current.fieldEdits, merged.applied, { at: edit.at, tabletId: source.tabletId }, decidedAt, versionId);
  const values = { ...current.values, ...merged.applied };
  await tx.$executeRaw`
    UPDATE location_settings SET values = ${JSON.stringify(values)}::jsonb, field_edits = ${JSON.stringify(fieldEdits)}::jsonb
    WHERE id = ${current.id}::uuid`;
  return { writesDue: true, lost };
}

/**
 * Takes the settings in a Workflow the tablet reported into its Machine's
 * Location's settings, in the transaction storing the Workflow, which holds
 * the Machine's row lock: each it changed since it last had them is its
 * edit, timed by when the plugin observed it, and each its Location has not
 * set yet is set by it (`settingsEdits`). A Machine at no Location shares
 * none, nor does a Workflow lacking what every supported Decaid sends. One whose
 * sharing is turned off changes nothing, but its settings are kept as the
 * tablet's, so once its sharing is turned back on its own changes since are told
 * from the Location's, which are written to it. A Workflow reported as the
 * tablet joins the Location (joining.ts) has had none of its settings yet,
 * whatever it held there before, so the Location's state wins (ADR-0008),
 * and its grinder, batch and Basket are cleared if the Location does not
 * offer them (`takeInWorkflowContext`), whether or not its Machine shares
 * the settings.
 * Its Loaded Recipe is taken in by `loadedRecipe`, given where the report is
 * taken in and whether it joins there, under the tablet's lock and before
 * the settings' row lock, capture-only included.
 * Tells every instance when the Location's tablets, this one included, are
 * to be written. Returns where it was taken in (`standing`), or null if
 * nowhere, as its Machine is capture-only.
 */
export async function takeInWorkflow(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  observedAt: string,
  loadedRecipe: (entry: CurrentEntry | null, joining: boolean) => Promise<void> = async () => {},
): Promise<string | null> {
  const entry = await currentEntry(tx, tablet.machineId);
  // Capture-only: its settings as last had are kept as they were, stale until it joins. The writer writes nothing until
  // a Workflow is taken in where its lists were (`TabletWriter`), so the joining Workflow replaces them before any write.
  if (entry === null) {
    await lockTablet(tx, tablet.tabletId);
    await loadedRecipe(null, false);
    return null;
  }
  const { locationId } = entry;
  const takenInAt = standing(entry);
  await lockTablet(tx, tablet.tabletId);
  const joining = await takenIn(tx, tablet.tabletId, "workflow", entry);
  // Before the settings' row lock: each may take the Location's lock, which comes first, and the Loaded Recipe's row after it.
  await takeInWorkflowContext(tx, tablet, workflow, locationId, joining);
  await loadedRecipe(entry, joining);
  const reported = sharedSettingsOf(workflow);
  if (reported === null) return takenInAt;
  const settings = await lockSettingsAt(tx, locationId);
  const held = await heldSettings(tx, tablet.tabletId);
  const known = !joining && held?.settingsId === settings.id ? held : null;
  const { shares, sharedThen } = await sharing(tx, tablet.machineId, new Date(observedAt));
  if (!sharedThen) {
    await saveHeld(tx, tablet.tabletId, settings.id, reported, null);
    // Sharing turned on since it was made: the tablet is to take the Location's, which turning it on may have found it held already.
    if (shares && settingsToWrite(settings.values, reported) !== null) await notify(tx, "library_changes", locationId);
    // Sharing off: its recipes mirror its own, which changed.
    if (!shares && mirroredChanged(held?.values ?? null, reported)) await notify(tx, "library_changes", locationId);
    return takenInAt;
  }
  const values = settingsEdits(known?.values ?? null, reported, settings.fieldEdits);
  await dropStaleApplies(tx, tablet.tabletId, settings, values);
  const edit = { values, at: new Date(observedAt), seenAt: known?.contentSeenAt ?? null };
  const edited = await editSettings(tx, settings.id, edit, tabletSource(tablet));
  await saveHeld(tx, tablet.tabletId, settings.id, reported, null);
  const now = edited.writesDue ? (await lockSettings(tx, settings.id))!.values : settings.values;
  if (edited.writesDue || settingsToWrite(now, reported) !== null) await notify(tx, "library_changes", locationId);
  return takenInAt;
}

/**
 * Records the settings Decaid returned for the plugin's write of them
 * (`written`, the fields it set) as the tablet's, as `recordGrinderWritten`
 * records a Grinder's record: a setting the write did not set that differs
 * from what the tablet last had is the tablet's edit, merged as a reported
 * one would be, timed when the plugin had Decaid's answer. They have seen the
 * latest edit of the settings the write carried (`contentSeen`) unless such
 * an edit lost; null says nothing new. Recorded only while the answering
 * connection holds its Machine. Nothing is recorded when the answer holds no
 * settings, or the Location's settings are gone.
 */
export async function recordSettingsWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  settingsId: string,
  written: ReadonlySet<string>,
  record: Record<string, unknown>,
  updatedAt: string | null,
  contentSeen: Date | null,
): Promise<AnswerRecorded> {
  const reported = sharedSettingsOf(record);
  if (reported === null) return "notTheItem";
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    const settings = await lockSettings(tx, settingsId);
    if (!settings) return "notTheItem";
    const held = await heldSettings(tx, tablet.tabletId);
    const known = held?.settingsId === settingsId ? held.values : null;
    // Sharing turned off since the write was sent: what the tablet changed is its own.
    const shares = await sharesSettings(tx, tablet.machineId);
    let edited: EditOutcome | null = null;
    if (known !== null && shares) {
      const changed = settingsEdits(known, reported, settings.fieldEdits);
      const values = Object.fromEntries(Object.entries(changed).filter(([field]) => !written.has(field)));
      await dropStaleApplies(tx, tablet.tabletId, settings, values);
      // Edited on the tablet before Decaid answered: judged by what its settings had seen before.
      const edit = { values, at: updatedAt === null ? await transactionTime(tx) : new Date(updatedAt), seenAt: held!.contentSeenAt };
      edited = await editSettings(tx, settingsId, edit, tabletSource(tablet));
      if (edited.writesDue) await notify(tx, "library_changes", settings.locationId);
    }
    const holds = contentSeen !== null && edited !== null && !edited.lost;
    await saveHeld(tx, tablet.tabletId, settingsId, reported, holds ? contentSeen : null);
    // A stale apply left out is written over, though no writer awaits this answer any longer.
    if (known !== null && shares && !edited?.writesDue && settingsToWrite(settings.values, reported) !== null) await notify(tx, "library_changes", settings.locationId);
    // Sharing off since the write was sent: its recipes mirror its own, which the write changed.
    if (!shares && mirroredChanged(held?.values ?? null, reported)) await notify(tx, "library_changes", settings.locationId);
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * The steam and rinse settings the tablet's recipes mirror (ADR-0014): its
 * Machine's Location's, or, while the Machine's sharing of them is off, its
 * tablet's own, as its Workflow last held them. A setting not known yet is
 * absent. Read in the caller's transaction.
 */
export async function mirroredSettings(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string | null): Promise<LocationValues> {
  const [row] = await tx.$queryRaw<{ location: unknown; own: unknown }[]>`
    SELECT (SELECT values FROM location_settings WHERE location_id = ${locationId}::uuid) AS location,
      (SELECT values FROM tablet_settings WHERE tablet_id = ${tablet.tabletId}::uuid) AS own`;
  return mirroredValues(await sharesSettings(tx, tablet.machineId), readLocationValues(row?.location), readLocationValues(row?.own));
}

/**
 * Takes a barista's change of the steam and rinse settings a recipe on the
 * tablet mirrors (`settingsValues` in recipe-intake.ts, `values`) into its
 * Machine's Location's settings, as a change of them in its Workflow is
 * (`takeInWorkflow`): each that differs is its edit, timed when the plugin
 * read it (`at`), merged with what the tablet's settings have seen, which
 * the server writes before its recipes. A Machine whose sharing of them is
 * off, or was when the plugin read it, changes nothing: its recipes are
 * written its own values again. Takes the settings' row lock, after the
 * Recipes' that the caller holds, and tells every instance when the
 * Location's tablets are to be written.
 */
export async function editSettingsInRecipe(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  locationId: string,
  values: Partial<Record<SharedSetting, number>>,
  at: Date,
): Promise<void> {
  if (Object.keys(values).length === 0 || !(await sharing(tx, tablet.machineId, at)).sharedThen) return;
  const settings = await lockSettingsAt(tx, locationId);
  // A value the settings hold already changes nothing, as when Streamline saves into a recipe the Workflow change it made.
  const changed = Object.fromEntries(Object.entries(values).filter(([field, value]) => !sameValue(settings.values[field as SharedSetting], value)));
  const held = await heldSettings(tx, tablet.tabletId);
  const seenAt = held?.settingsId === settings.id ? held.contentSeenAt : null;
  const edited = await editSettings(tx, settings.id, { values: changed, at, seenAt }, tabletSource(tablet));
  if (edited.writesDue) await notify(tx, "library_changes", locationId);
}

/** What the tablet's recipes held just before the server's latest write of each of their fields (`before_write`), by their paths. */
async function recipesBeforeWrite(tx: Prisma.TransactionClient, tabletId: string): Promise<Record<string, unknown>[]> {
  const rows = await tx.$queryRaw<{ beforeWrite: Record<string, unknown> }[]>`
    SELECT before_write AS "beforeWrite" FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND before_write IS NOT NULL`;
  return rows.map((row) => row.beforeWrite);
}

/**
 * Leaves out of a tablet's changes of the settings (`values`) each that a
 * recipe applied from a stale copy made (`staleApplied` in recipe-intake.ts),
 * or a blank one (`blankApplied`): no edit, so the settings' value is written
 * back.
 */
async function dropStaleApplies(tx: Prisma.TransactionClient, tabletId: string, settings: EditedSettings, values: Partial<Record<SharedSetting, number>>): Promise<void> {
  for (const field of blankApplied(values, settings.values)) delete values[field];
  const candidates = MIRRORED_SETTINGS.filter((field) => values[field] !== undefined);
  if (candidates.length === 0) return;
  for (const field of staleApplied(values, await recipesBeforeWrite(tx, tabletId), settings.values, await previousValues(tx, settings, candidates))) delete values[field];
}

/**
 * The value each of those settings held just before its current one: that
 * of its latest version setting another, as versions record only the edits
 * that applied, in the order they did (`seq`, taken under the settings' row
 * lock).
 */
async function previousValues(tx: Prisma.TransactionClient, settings: EditedSettings, fields: readonly SharedSetting[]): Promise<Partial<Record<SharedSetting, number>>> {
  const previous: Partial<Record<SharedSetting, number>> = {};
  for (const field of fields) {
    const current = settings.values[field];
    if (current === undefined) continue;
    const [row] = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT fields -> ${field} AS value FROM item_versions
      WHERE kind = ${SETTINGS_KIND} AND item_id = ${settings.id} AND fields ? ${field} AND fields -> ${field} <> ${JSON.stringify(current)}::jsonb
      ORDER BY seq DESC LIMIT 1`;
    if (typeof row?.value === "number") previous[field] = row.value;
  }
  return previous;
}

/** The settings DYE2's recipes hold a value of, which they mirror. */
const MIRRORED_SETTINGS: readonly SharedSetting[] = Object.values(MIRRORED_PATHS);

/** Whether a tablet's settings changed one its recipes mirror (`MIRRORED_PATHS` in recipe-intake.ts). */
function mirroredChanged(before: SharedSettings | null, after: SharedSettings): boolean {
  return before === null || MIRRORED_SETTINGS.some((field) => !sameValue(before[field], after[field]));
}

/**
 * The write of its Machine's Location's settings that the tablet is due, if
 * any (`settingsToWrite`), read in the snapshot that `tabletDue` reads. None
 * is due before the tablet has reported its Workflow there, as until then
 * the server does not know what it holds, nor while its Machine's sharing
 * is turned off.
 */
export async function settingsDue(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string): Promise<PlannedWrite | null> {
  if (!(await sharesSettings(tx, tablet.machineId))) return null;
  const [row] = await tx.$queryRaw<{ id: string; values: unknown; fieldEdits: unknown; held: unknown }[]>`
    SELECT settings.id, settings.values, settings.field_edits AS "fieldEdits", held.values AS held
    FROM location_settings AS settings
    JOIN tablet_settings AS held ON held.settings_id = settings.id AND held.tablet_id = ${tablet.tabletId}::uuid
    WHERE settings.location_id = ${locationId}::uuid`;
  const values = row ? readHeld(row.held) : null;
  if (!row || values === null) return null;
  const due = settingsToWrite(readLocationValues(row.values), values);
  if (due === null) return null;
  return { kind: SETTINGS_KIND, globalId: row.id, localId: null, ...due, decidedAt: null, contentDecidedAt: latestDecision(readFieldEdits(row.fieldEdits)) };
}
