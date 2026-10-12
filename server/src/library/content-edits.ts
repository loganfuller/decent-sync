import type { LibraryKind } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { type EditSource, type LibraryItemRef as ItemRef, recordConflict, recordReplaced, recordVersion } from "./history.js";
import { KINDS, idSql, idsSql } from "./kinds.js";
import { isObject } from "./listed.js";
import { type FieldEdits, changedFields, editsAfter, latestDecision, mergeEdit, readFieldEdits } from "./merge.js";

// Edits of Library items' content, merged per field with the latest edit
// winning (ADR-0020): a Bean's, a Bean Batch's and a Grinder's record fields,
// whether a Grinder is Archived, and a Profile's title, author and notes,
// which are outside its id (ADR-0006). Each item keeps its fields' latest
// edits (`field_edits`); each accepted edit is a version, and each that lost,
// or that a later edit made without seeing it replaced, is a Conflict
// (history.ts). An item's edits are decided one at a time under its row lock,
// on any instance (ADR-0016), taken after the reporting tablet's and its
// Location's locks; a report's items are locked together, in id order, so two
// reports editing the same items never wait on each other in turn.

/**
 * Holds the row locks of the items until the transaction ends, in id order,
 * so their edits are decided one report or answer at a time. Taken after the
 * Location's lock.
 */
export async function lockItems(tx: Prisma.TransactionClient, kind: LibraryKind, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const description = KINDS[kind];
  await tx.$queryRaw`
    SELECT 1 FROM ${Prisma.raw(description.table)} WHERE id = ANY(${idsSql(description, [...new Set(ids)])}) ORDER BY id FOR NO KEY UPDATE`;
}

/** An item's content as edits merge it, and its fields' latest edits. */
interface EditedItem {
  content: Record<string, unknown>;
  /** Its Archived state, for a kind where it is a field of its content (`archivedIsContent`), as a Grinder's is; null for other kinds. */
  archived: boolean | null;
  fieldEdits: FieldEdits;
}

/** Reads an item under its row lock, or null if the Library no longer has it. */
async function readItem(tx: Prisma.TransactionClient, item: ItemRef): Promise<EditedItem | null> {
  const description = KINDS[item.kind];
  const archived = description.archivedIsContent ? Prisma.sql`archived` : Prisma.sql`NULL::boolean`;
  const [row] = await tx.$queryRaw<{ content: unknown; archived: boolean | null; fieldEdits: unknown }[]>`
    SELECT content, ${archived} AS archived, field_edits AS "fieldEdits" FROM ${Prisma.raw(description.table)}
    WHERE id = ${idSql(description, item.id)} FOR NO KEY UPDATE`;
  if (!row) return null;
  return { content: isObject(row.content) ? row.content : {}, archived: row.archived, fieldEdits: readFieldEdits(row.fieldEdits) };
}

/** The values edits of an item merge: its content's (`values`), and its Archived state where that is one of them. */
function mergedValues(kind: LibraryKind, item: EditedItem): Record<string, unknown> {
  const values = KINDS[kind].values(item.content);
  return item.archived === null ? values : { ...values, archived: item.archived };
}

/**
 * When an edit of the item is decided: now, by PostgreSQL's clock, to the
 * millisecond times are kept to, but after every edit of the item decided
 * before it, so a record that has seen one has seen every one before it.
 */
export async function decisionTime(tx: Prisma.TransactionClient, edits: FieldEdits): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp()::timestamptz(3) AS now`;
  const latest = latestDecision(edits);
  return latest !== null && latest.getTime() >= row!.now.getTime() ? new Date(latest.getTime() + 1) : row!.now;
}

/** Sets the item's merged values and their latest edits. */
async function saveItem(
  tx: Prisma.TransactionClient,
  item: ItemRef,
  current: EditedItem,
  applied: Readonly<Record<string, unknown>>,
  fieldEdits: Readonly<Record<string, unknown>>,
): Promise<void> {
  const description = KINDS[item.kind];
  const { archived, ...fields } = applied;
  const content: Record<string, unknown> = { ...current.content };
  // Decaid leaves out a field it holds no value for, and so does the content.
  const { editedIn } = description;
  const target = editedIn === null ? content : { ...(isObject(content[editedIn]) ? content[editedIn] : {}) };
  for (const [field, value] of Object.entries(description.archivedIsContent ? fields : applied)) {
    if (value === null) delete target[field];
    else target[field] = value;
  }
  if (editedIn !== null) content[editedIn] = target;
  const archivedColumn = description.archivedIsContent && typeof archived === "boolean" ? Prisma.sql`, archived = ${archived}` : Prisma.empty;
  await tx.$executeRaw`
    UPDATE ${Prisma.raw(description.table)}
    SET content = ${JSON.stringify(content)}::jsonb, field_edits = ${JSON.stringify(fieldEdits)}::jsonb ${archivedColumn} ${description.keptColumns(content)}
    WHERE id = ${idSql(description, item.id)}`;
}

/**
 * An edit of an item's content: the fields it changed, with their values,
 * when it was made, and the latest edit of the item its record had seen, or
 * `everything` for an edit in the management interface made over the item as
 * it stands, as using a Conflict's value is, which has seen every edit
 * decided before it.
 */
export interface ItemEdit {
  values: Readonly<Record<string, unknown>>;
  at: Date;
  seenAt: Date | null | "everything";
}

/**
 * What an edit of an item's content did: whether the item's tablets are to be
 * written (its content changed, or a field lost, which is written back to its
 * tablet), and whether any field lost.
 */
export interface EditOutcome {
  writesDue: boolean;
  lost: boolean;
}

/**
 * Merges an edit into the item's content (`mergeEdit`): the fields it
 * decides are set and kept as a version, and each value that lost, or that
 * it replaced without its maker having seen it, as a Conflict. Takes the
 * item's row lock, if not held already. Says whether anything changed that
 * the item's tablets are to be written: the item's content, or a field where
 * the edit lost, which is written back to its tablet.
 */
export async function editContent(tx: Prisma.TransactionClient, item: ItemRef, edit: ItemEdit, source: EditSource): Promise<EditOutcome> {
  if (Object.keys(edit.values).length === 0) return { writesDue: false, lost: false };
  const current = await readItem(tx, item);
  if (!current) return { writesDue: false, lost: false };
  const seenAt = edit.seenAt === "everything" ? latestDecision(current.fieldEdits) : edit.seenAt;
  const merged = mergeEdit(mergedValues(item.kind, current), current.fieldEdits, { ...edit, seenAt, tabletId: source.tabletId });
  for (const [field, value] of Object.entries(merged.lost)) await recordConflict(tx, item, null, field, value, source, edit.at);
  for (const { field, value, versionId } of merged.overwritten) await recordReplaced(tx, item, null, field, value, versionId);
  const lost = Object.keys(merged.lost).length > 0;
  if (Object.keys(merged.applied).length === 0) return { writesDue: lost, lost };
  const versionId = await recordVersion(tx, item, null, merged.applied, source, edit.at);
  const decidedAt = await decisionTime(tx, current.fieldEdits);
  await saveItem(tx, item, current, merged.applied, editsAfter(current.fieldEdits, merged.applied, { at: edit.at, tabletId: source.tabletId }, decidedAt, versionId));
  return { writesDue: true, lost };
}

/**
 * Keeps an item that just joined the Library as its first version: `values`,
 * its content as edits merge it, each field's latest edit from then on, made
 * at `at` by `source`.
 */
export async function recordJoined(tx: Prisma.TransactionClient, item: ItemRef, values: Readonly<Record<string, unknown>>, at: Date, source: EditSource): Promise<void> {
  const versionId = await recordVersion(tx, item, null, values, source, at);
  const decidedAt = await decisionTime(tx, {});
  const fieldEdits = editsAfter({}, values, { at, tabletId: source.tabletId }, decidedAt, versionId);
  const description = KINDS[item.kind];
  await tx.$executeRaw`UPDATE ${Prisma.raw(description.table)} SET field_edits = ${JSON.stringify(fieldEdits)}::jsonb WHERE id = ${idSql(description, item.id)}`;
}

/**
 * Keeps each field where a tablet's record linked to a Library item, by a
 * Bean's roaster and name or a Profile's id, held another value than the
 * item's content as a Conflict: the record takes the item's content, so
 * nothing is dropped silently (ADR-0018). `values` are the record's, as edits
 * merge them; a field it holds no value for is no Conflict. Says whether any
 * differed, so the record is to be written.
 */
export async function recordLinked(tx: Prisma.TransactionClient, item: ItemRef, values: Readonly<Record<string, unknown>>, at: Date, source: EditSource): Promise<boolean> {
  const current = await readItem(tx, item);
  if (!current) return false;
  // A field the record holds no value for loses nothing.
  const differing = Object.entries(changedFields(mergedValues(item.kind, current), values)).filter(([, value]) => value !== null);
  for (const [field, value] of differing) await recordConflict(tx, item, null, field, value, source, at);
  return differing.length > 0;
}

/**
 * Whether a tablet's record, as Decaid returned it for one of the server's
 * writes, holds the content that write carried, so it has seen the edits the
 * write's `contentDecidedAt` covers. A record the map held does unless a
 * change of its content the write did not set lost (`edited`): a field the
 * plugin left as the tablet had changed it, or that the tablet changed before
 * the write, which then lost, does not hold the item's value. One that won is
 * the field's latest edit, the tablet's own, which it has seen whatever this
 * says. One the map did not hold, as a create's, does when its content is
 * the item's now: a create may have found the record of an earlier write, or
 * a bean of the same roaster and name. `values` are the record's, as edits
 * merge them.
 */
export async function holdsWrittenContent(
  tx: Prisma.TransactionClient,
  item: ItemRef,
  values: Readonly<Record<string, unknown>>,
  edited: EditOutcome | null,
): Promise<boolean> {
  if (edited !== null) return !edited.lost;
  const description = KINDS[item.kind];
  const [row] = await tx.$queryRaw<{ content: unknown }[]>`SELECT content FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, item.id)}`;
  if (!row) return false;
  return Object.keys(changedFields(description.values(isObject(row.content) ? row.content : {}), values)).length === 0;
}
