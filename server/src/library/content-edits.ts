import { type LibraryKind, beanMatchKey } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { type EditSource, type ItemRef, recordConflict, recordReplaced, recordVersion } from "./history.js";
import { isObject } from "./listed.js";
import { type FieldEdits, changedFields, editsAfter, latestDecision, mergeEdit, readFieldEdits } from "./merge.js";
import { profileText } from "./profile-intake.js";

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

/** The table holding each kind of item. */
const ITEM_TABLES: Readonly<Record<LibraryKind, { table: string; cast: string }>> = {
  bean: { table: "beans", cast: "uuid" },
  beanBatch: { table: "bean_batches", cast: "uuid" },
  grinder: { table: "grinders", cast: "uuid" },
  profile: { table: "profiles", cast: "text" },
};

/**
 * Holds the row locks of the items until the transaction ends, in id order,
 * so their edits are decided one report or answer at a time. Taken after the
 * Location's lock.
 */
export async function lockItems(tx: Prisma.TransactionClient, kind: LibraryKind, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { table, cast } = ITEM_TABLES[kind];
  await tx.$queryRaw`
    SELECT 1 FROM ${Prisma.raw(table)} WHERE id = ANY(${[...new Set(ids)]}::${Prisma.raw(cast)}[]) ORDER BY id FOR NO KEY UPDATE`;
}

/** An item's content as edits merge it, and its fields' latest edits. */
interface EditedItem {
  content: Record<string, unknown>;
  /** A Grinder's Archived state, a field of its own; null for other kinds. */
  archived: boolean | null;
  fieldEdits: FieldEdits;
}

/** Reads an item under its row lock, or null if the Library no longer has it. */
async function readItem(tx: Prisma.TransactionClient, item: ItemRef): Promise<EditedItem | null> {
  const { table, cast } = ITEM_TABLES[item.kind];
  const archived = item.kind === "grinder" ? Prisma.sql`archived` : Prisma.sql`NULL::boolean`;
  const [row] = await tx.$queryRaw<{ content: unknown; archived: boolean | null; fieldEdits: unknown }[]>`
    SELECT content, ${archived} AS archived, field_edits AS "fieldEdits" FROM ${Prisma.raw(table)}
    WHERE id = ${item.id}::${Prisma.raw(cast)} FOR NO KEY UPDATE`;
  if (!row) return null;
  return { content: isObject(row.content) ? row.content : {}, archived: row.archived, fieldEdits: readFieldEdits(row.fieldEdits) };
}

/** The values edits of an item merge: its content's fields, a Grinder's Archived state, a Profile's title, author and notes. */
function mergedValues(kind: LibraryKind, item: EditedItem): Record<string, unknown> {
  if (kind === "profile") return profileText(item.content);
  return item.archived === null ? item.content : { ...item.content, archived: item.archived };
}

/**
 * When an edit of the item is decided: now, by PostgreSQL's clock, to the
 * millisecond times are kept to, but after every edit of the item decided
 * before it, so a record that has seen one has seen every one before it.
 */
async function decisionTime(tx: Prisma.TransactionClient, edits: FieldEdits): Promise<Date> {
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
  const { table, cast } = ITEM_TABLES[item.kind];
  const { archived, ...fields } = applied;
  const content: Record<string, unknown> = { ...current.content };
  // Decaid leaves out a field it holds no value for, and so does the content.
  const target = item.kind === "profile" ? { ...(isObject(content.profile) ? content.profile : {}) } : content;
  for (const [field, value] of Object.entries(item.kind === "grinder" ? fields : applied)) {
    if (value === null) delete target[field];
    else target[field] = value;
  }
  if (item.kind === "profile") content.profile = target;
  const grinderArchived = item.kind === "grinder" && typeof archived === "boolean" ? Prisma.sql`, archived = ${archived}` : Prisma.empty;
  const matchKey =
    item.kind === "bean" && typeof content.roaster === "string" && typeof content.name === "string"
      ? Prisma.sql`, match_key = ${beanMatchKey(content.roaster, content.name)}`
      : Prisma.empty;
  await tx.$executeRaw`
    UPDATE ${Prisma.raw(table)} SET content = ${JSON.stringify(content)}::jsonb, field_edits = ${JSON.stringify(fieldEdits)}::jsonb ${grinderArchived} ${matchKey}
    WHERE id = ${item.id}::${Prisma.raw(cast)}`;
}

/** An edit of an item's content: the fields it changed, with their values, when it was made, and the latest edit of the item its record had seen. */
export interface ItemEdit {
  values: Readonly<Record<string, unknown>>;
  at: Date;
  seenAt: Date | null;
  /** The value the tablet's record held for each field before the edit, and when it was saved (`ContentEdit.had`, `heldAt`). */
  had: Readonly<Record<string, unknown>>;
  heldAt: Date | null;
}

/**
 * Merges an edit into the item's content (`mergeEdit`): the fields it
 * decides are set and kept as a version, and each value that lost, or that
 * it replaced without its maker having seen it, as a Conflict. Takes the
 * item's row lock, if not held already. Says whether anything changed that
 * the item's tablets are to be written: the item's content, or a field where
 * the edit lost, which is written back to its tablet.
 */
export async function editContent(tx: Prisma.TransactionClient, item: ItemRef, edit: ItemEdit, source: EditSource): Promise<boolean> {
  if (Object.keys(edit.values).length === 0) return false;
  const current = await readItem(tx, item);
  if (!current) return false;
  const merged = mergeEdit(mergedValues(item.kind, current), current.fieldEdits, { ...edit, tabletId: source.tabletId });
  for (const [field, value] of Object.entries(merged.lost)) await recordConflict(tx, item, null, field, value, source, edit.at);
  for (const { field, value, versionId } of merged.overwritten) await recordReplaced(tx, item, null, field, value, versionId);
  if (Object.keys(merged.applied).length === 0) return Object.keys(merged.lost).length > 0;
  const versionId = await recordVersion(tx, item, null, merged.applied, source, edit.at);
  const decidedAt = await decisionTime(tx, current.fieldEdits);
  await saveItem(tx, item, current, merged.applied, editsAfter(current.fieldEdits, merged.applied, { at: edit.at, tabletId: source.tabletId }, decidedAt, versionId));
  return true;
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
  const { table, cast } = ITEM_TABLES[item.kind];
  await tx.$executeRaw`UPDATE ${Prisma.raw(table)} SET field_edits = ${JSON.stringify(fieldEdits)}::jsonb WHERE id = ${item.id}::${Prisma.raw(cast)}`;
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
