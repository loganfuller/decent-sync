import { sameValue } from "@decent-sync/protocol";

// How an edit of a Library item's content merges with the item's current
// content, field by field (ADR-0020): the fields an edit changed, and which of
// them it decides, each against the edit that set the field last. Two edits
// conflict only when both changed the same field without seeing each other:
// the later one wins, and the other is kept as a Conflict. Pure, so module
// tests can drive it; content-edits.ts reads what it needs and carries the
// merge out.

/** The latest edit of one field of an item, as the item keeps it (`fieldEdits`). */
export interface FieldEdit {
  /** When the edit was made: a tablet's by its record's `updatedAt` in UTC, never earlier than the edit before it. */
  at: string;
  /** When it was decided, by PostgreSQL's clock: a tablet's record that has seen it since had seen it (`contentSeenAt`). */
  decidedAt: string;
  /** The tablet that made it, if one did: that tablet has seen its own edit, whatever else its record has seen. */
  tabletId: string | null;
  /** Its version (`item_versions`), which says where it came from. */
  versionId: string;
}

/** An item's latest edit of each of its fields, by the field's name. */
export type FieldEdits = Readonly<Record<string, FieldEdit>>;

/** An edit of an item's content: the fields it changed, with their new values. */
export interface ContentEdit {
  values: Readonly<Record<string, unknown>>;
  /** When it was made. */
  at: Date;
  /** The tablet that made it, if one did. */
  tabletId: string | null;
  /** The latest edit of the item's content that its record had seen, by PostgreSQL's clock; null if none. */
  seenAt: Date | null;
  /**
   * The value the tablet's record held for each field before the edit: one
   * that is the item's value now had seen the field's latest edit, as far as
   * its value goes, however the record came to hold it.
   */
  had: Readonly<Record<string, unknown>>;
}

/** What an edit decides, field by field. */
export interface Merged {
  /** The fields it decides, with their values: each the field's latest edit from now on, even one it leaves as it was. */
  applied: Record<string, unknown>;
  /** The fields where it lost to a later edit its tablet had not seen, with the values it lost: Conflicts. */
  lost: Record<string, unknown>;
  /**
   * The values it replaced that its tablet had not seen, each set by an edit
   * made before it (`versionId`), which also had not seen it: Conflicts.
   */
  overwritten: { field: string; value: unknown; versionId: string }[];
}

/**
 * The fields of an item's content that differ between two of a tablet's
 * records of it, each with the value the newer one holds: what the tablet
 * changed between them. A field a record does not hold is null, as Decaid
 * leaves out a field it holds no value for.
 */
export function changedFields(known: Readonly<Record<string, unknown>>, now: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const field of new Set([...Object.keys(known), ...Object.keys(now)])) {
    if (!sameValue(known[field], now[field])) changed[field] = now[field] ?? null;
  }
  return changed;
}

/**
 * How an edit merges with an item's content (`current`, its fields' latest
 * edits in `edits`), field by field. An edit decides a field nobody has
 * edited yet, and one whose latest edit its tablet had seen: its own, one
 * decided by when its record last had what the server wrote it
 * (`seenAt`), or one whose value its record held before the edit (`had`), as
 * when the answer to the write that brought it was not awaited any more, so
 * its edit replaces nothing it had not seen. Otherwise edit times decide (ADR-0003): an edit made no
 * earlier than the field's latest decides it, and the value it replaces, if
 * another, is kept as a Conflict; one made earlier loses, and its value, if
 * another, is kept as a Conflict.
 */
export function mergeEdit(current: Readonly<Record<string, unknown>>, edits: FieldEdits, edit: ContentEdit): Merged {
  const merged: Merged = { applied: {}, lost: {}, overwritten: [] };
  for (const [field, value] of Object.entries(edit.values)) {
    const latest = Object.prototype.hasOwnProperty.call(edits, field) ? edits[field] : undefined;
    const same = sameValue(current[field], value);
    if (!latest || sawEdit(latest, edit) || (Object.prototype.hasOwnProperty.call(edit.had, field) && sameValue(edit.had[field], current[field]))) {
      merged.applied[field] = value;
    } else if (edit.at.getTime() >= new Date(latest.at).getTime()) {
      merged.applied[field] = value;
      if (!same) merged.overwritten.push({ field, value: current[field] ?? null, versionId: latest.versionId });
    } else if (!same) {
      merged.lost[field] = value;
    }
  }
  return merged;
}

/** Whether the tablet that made an edit had seen a field's latest edit. */
function sawEdit(latest: FieldEdit, edit: ContentEdit): boolean {
  if (edit.tabletId !== null && latest.tabletId === edit.tabletId) return true;
  return edit.seenAt !== null && new Date(latest.decidedAt).getTime() <= edit.seenAt.getTime();
}

/**
 * The fields' latest edits once an edit decided `applied`, at `decidedAt` by
 * PostgreSQL's clock, as version `versionId`. Each is timed no earlier than
 * the edit it follows, so one that applied because its tablet had seen the
 * field still wins over an edit timed between the two that had not.
 */
export function editsAfter(
  edits: FieldEdits,
  applied: Readonly<Record<string, unknown>>,
  edit: { at: Date; tabletId: string | null },
  decidedAt: Date,
  versionId: string,
): Record<string, FieldEdit> {
  const next: Record<string, FieldEdit> = { ...edits };
  for (const field of Object.keys(applied)) {
    const before = Object.prototype.hasOwnProperty.call(edits, field) ? edits[field] : undefined;
    const at = before && new Date(before.at).getTime() > edit.at.getTime() ? before.at : edit.at.toISOString();
    next[field] = { at, decidedAt: decidedAt.toISOString(), tabletId: edit.tabletId, versionId };
  }
  return next;
}

/** The latest time any of an item's fields was decided, by PostgreSQL's clock: what a record written its content then has seen. Null if none was. */
export function latestDecision(edits: FieldEdits): Date | null {
  let latest: number | null = null;
  for (const edit of Object.values(edits)) {
    const at = new Date(edit.decidedAt).getTime();
    if (latest === null || at > latest) latest = at;
  }
  return latest === null ? null : new Date(latest);
}

/** The values a tablet's record of an item held before an edit (`known`, as edits merge them) for each field the edit changed. */
export function heldBefore(known: Readonly<Record<string, unknown>>, changed: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(changed).map((field) => [field, known[field] ?? null]));
}

/** An item's field edits as stored, or none if they cannot be read. */
export function readFieldEdits(value: unknown): FieldEdits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as FieldEdits;
}
