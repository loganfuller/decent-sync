import { SETTINGS_KIND, SHARED_SETTINGS, type SharedSettings, sharedSettingsOf } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { type EditOutcome, type ItemEdit, decisionTime } from "./content-edits.js";
import { type EditSource, type ItemRef, recordConflict, recordReplaced, recordVersion, tabletSource } from "./history.js";
import type { PlannedWrite } from "./holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, currentLocation, lockHeldMachine, lockTablet } from "./intake.js";
import { transactionTime } from "./location-state.js";
import { type FieldEdits, editsAfter, latestDecision, mergeEdit, readFieldEdits } from "./merge.js";
import { type LocationValues, readLocationValues, settingsEdits, settingsToWrite } from "./settings-intake.js";

// Each Location's steam, hot water and rinse settings, shared by its
// Machines whatever their model (ADR-0014), each a field of its own merged as
// edits of a Library item's content are, with versions and Conflicts
// (ADR-0020). A tablet's edits arrive in the Workflow it reports (`workflow`
// deliveries), timed by when the plugin observed them; only the settings
// count. The first Machine at a Location to report its Workflow sets them. A
// Machine whose settings sharing is switched off takes no part: nothing of
// them is taken from its tablet or written to it.
// The server keeps, per tablet, the settings as it last had them, reported
// or as Decaid returned the plugin's write of them, so the plugin's own
// write is never read as the tablet's edit (ADR-0003). Under the same locks
// as the Library's intake: the reporting Machine's row, the tablet's, then
// the settings' row, which edits in the management interface take alone.

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

/** Whether a Machine's tablet shares its Location's settings: switched on, as it is unless an account switched it off. */
async function sharesSettings(tx: Prisma.TransactionClient, machineId: string): Promise<boolean> {
  return (await sharing(tx, machineId)).shares;
}

/**
 * Whether a Machine's tablet shares its Location's settings now, and whether
 * it did when the tablet observed a change: one observed before the Machine
 * was last switched on was made while it kept its own settings, and is not
 * shared, though delivered later, as from a tablet that was offline or whose
 * outbox held it. Compared with PostgreSQL's clock, which timed the switch,
 * as other tablet times are (ADR-0003).
 */
async function sharing(tx: Prisma.TransactionClient, machineId: string, observedAt?: Date): Promise<{ shares: boolean; sharedThen: boolean }> {
  const [row] = await tx.$queryRaw<{ shares: boolean; since: Date | null }[]>`
    SELECT shares_settings AS shares, shares_settings_since AS since FROM machines WHERE id = ${machineId}::uuid`;
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
 * sharing is switched off changes nothing, but its settings are kept as the
 * tablet's, so once it is switched on again its own changes since are told
 * from the Location's, which are written to it. Tells every instance when
 * the Location's tablets, this one included, are to be written.
 */
export async function takeInWorkflow(tx: Prisma.TransactionClient, tablet: ReportingTablet, workflow: unknown, observedAt: string): Promise<void> {
  const reported = sharedSettingsOf(workflow);
  if (reported === null) return;
  const locationId = await currentLocation(tx, tablet.machineId);
  if (locationId === null) return;
  await lockTablet(tx, tablet.tabletId);
  const settings = await lockSettingsAt(tx, locationId);
  const held = await heldSettings(tx, tablet.tabletId);
  const known = held?.settingsId === settings.id ? held : null;
  const { shares, sharedThen } = await sharing(tx, tablet.machineId, new Date(observedAt));
  if (!sharedThen) {
    await saveHeld(tx, tablet.tabletId, settings.id, reported, null);
    // Switched on since it was made: the tablet is to take the Location's, which its switching may have found it held already.
    if (shares && settingsToWrite(settings.values, reported) !== null) await notify(tx, "library_changes", locationId);
    return;
  }
  const values = settingsEdits(known?.values ?? null, reported, settings.fieldEdits);
  const edit = { values, at: new Date(observedAt), seenAt: known?.contentSeenAt ?? null };
  const edited = await editSettings(tx, settings.id, edit, tabletSource(tablet));
  await saveHeld(tx, tablet.tabletId, settings.id, reported, null);
  const now = edited.writesDue ? (await lockSettings(tx, settings.id))!.values : settings.values;
  if (edited.writesDue || settingsToWrite(now, reported) !== null) await notify(tx, "library_changes", locationId);
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
    // Switched off since the write was sent: what the tablet changed is its own.
    const shares = await sharesSettings(tx, tablet.machineId);
    let edited: EditOutcome | null = null;
    if (known !== null && shares) {
      const changed = settingsEdits(known, reported, settings.fieldEdits);
      const values = Object.fromEntries(Object.entries(changed).filter(([field]) => !written.has(field)));
      // Edited on the tablet before Decaid answered: judged by what its settings had seen before.
      const edit = { values, at: updatedAt === null ? await transactionTime(tx) : new Date(updatedAt), seenAt: held!.contentSeenAt };
      edited = await editSettings(tx, settingsId, edit, tabletSource(tablet));
      if (edited.writesDue) await notify(tx, "library_changes", settings.locationId);
    }
    const holds = contentSeen !== null && edited !== null && !edited.lost;
    await saveHeld(tx, tablet.tabletId, settingsId, reported, holds ? contentSeen : null);
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * The write of its Machine's Location's settings that the tablet is due, if
 * any (`settingsToWrite`), read in the snapshot that `tabletDue` reads. None
 * is due before the tablet has reported its Workflow there, as until then
 * the server does not know what it holds, nor while its Machine's sharing
 * is switched off.
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
