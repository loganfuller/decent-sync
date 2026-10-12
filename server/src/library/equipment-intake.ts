import { GLOBAL_ID_KEY, dye2GlobalIdOf, dye2Records, equipmentMatchKey, sameValue } from "@decent-sync/protocol";
import { changedFields } from "./merge.js";

// How a tablet's report of one of DYE2's lists of Baskets or Tools is taken
// into the Library (ADR-0005, ADR-0006, ADR-0018), and what it means at the
// tablet's Location (ADR-0008, ADR-0019), decided from the report, the
// tablet's map and the Library items the report may name. Pure, so module
// tests can drive it; equipment.ts reads what it needs and carries the plan
// out.
//
// DYE2's records carry no edit time, so each is timed by when the plugin
// first read its content. Every save in DYE2 or another app reads the whole
// list and posts it back, so a record can come back as it was before the
// server's latest write to it, from a page opened before the write or a
// write lost to the list being rewritten at the same moment: a field set back
// to the value the tablet held just before that write is taken as unchanged
// (ADR-0005), and the item's value written again.

/** A Basket's or Tool's record as a tablet reported it, one Decent Sync can take in. */
export interface ReportedEquipment {
  /** DYE2's id for it on that tablet. */
  localId: string;
  /** The global id its own field carries, if any. */
  globalId: string | null;
  /** Its name as Baskets and Tools are matched. */
  matchKey: string;
  /** When the plugin first read its content, in UTC. */
  updatedAt: Date;
  /** The record, as DYE2 keeps it. */
  record: Record<string, unknown>;
}

/** A Library Basket or Tool the tablet's map holds a record of. */
export interface MappedEquipment {
  itemId: string;
  localId: string;
  /** When the plugin first read the record known; null if it could not. */
  updatedAt: Date | null;
  /** The record known, as the tablet reported it or the plugin wrote it. */
  record: Record<string, unknown>;
  /** Each field the server's latest write to the record set, with the value the tablet held for it just before (null for none); null before any write. */
  beforeWrite: Record<string, unknown> | null;
  /** Whether a report has listed the record since the server's write that created it. */
  listed: boolean;
}

/** A Library Basket or Tool the report may name, by the global id a record carries or by name. */
export interface LibraryEquipment {
  id: string;
  matchKey: string;
  archived: boolean;
}

/** One thing a report changes. */
export type EquipmentIntakeStep =
  /**
   * The tablet's record of an item the map holds differs from the one
   * known, which it replaces. `content` holds the fields of the item's
   * content the tablet changed since, each with its value: its edit
   * (ADR-0020), but those set back to what the tablet held before the
   * server's latest write to it.
   */
  | { kind: "update"; itemId: string; reported: ReportedEquipment; content: Record<string, unknown> }
  /** The tablet holds a Library item the map did not know it held, by the global id its record carries. */
  | { kind: "map"; itemId: string; reported: ReportedEquipment }
  /** A record new to the Library whose name matches a Library item's: it is that item. */
  | { kind: "link"; itemId: string; reported: ReportedEquipment }
  /** A record new to the Library, which joins it. */
  | { kind: "add"; reported: ReportedEquipment }
  /** A record the map holds, listed before, is gone from the tablet's list: the tablet deleted it, which hides it at its Location (ADR-0019). */
  | { kind: "delete"; itemId: string; localId: string; updatedAt: Date | null }
  /**
   * A record the server's write created is gone from the list before any
   * report listed it: the write was lost to another app rewriting the list
   * at the same moment, so the tablet holds it no more, and is written it
   * again where its Location shows it (ADR-0005).
   */
  | { kind: "forget"; itemId: string; localId: string };

/**
 * The records of a reported list of Baskets or Tools that Decent Sync can
 * take in, each with when the plugin first read it, as it placed it beside
 * the list; none from a list in a shape it does not recognise
 * (`dye2Records`). A record without what DYE2 always saves (its id and name)
 * or a time is left out.
 */
export function readReportedEquipment(value: unknown, updatedAt: readonly (string | null)[] | undefined): ReportedEquipment[] {
  const records = dye2Records(value);
  if (records === null) return [];
  return records.flatMap((record, index) => {
    const time = updatedAt?.[index];
    if (typeof record.name !== "string" || !time) return [];
    return [{ localId: record.id as string, globalId: dye2GlobalIdOf(record), matchKey: equipmentMatchKey(record.name), updatedAt: new Date(time), record }];
  });
}

/**
 * A Basket's or Tool's content, from a tablet's record of it: DYE2's fields,
 * those this server does not know included, but its id, `createdAt` and
 * global id, which belong to that tablet's record.
 */
export function equipmentContent(record: Record<string, unknown>): Record<string, unknown> {
  const { id, createdAt, [GLOBAL_ID_KEY]: globalId, ...content } = record;
  return content;
}

/**
 * The fields of the item's content a tablet's record changed since the
 * record known, each with its value: but a field the server's latest write
 * to the record set that it set back to the value the tablet held just
 * before that write (`beforeWrite`), which is taken as unchanged (ADR-0005).
 * A barista who deliberately sets a field back to exactly that value has to
 * set it again.
 */
export function editedContent(
  known: Record<string, unknown>,
  reported: Record<string, unknown>,
  beforeWrite: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> {
  const changed = changedFields(equipmentContent(known), equipmentContent(reported));
  if (beforeWrite === null) return changed;
  const stale = (field: string, value: unknown) => Object.prototype.hasOwnProperty.call(beforeWrite, field) && sameValue(value, beforeWrite[field]);
  return Object.fromEntries(Object.entries(changed).filter(([field, value]) => !stale(field, value)));
}

/**
 * What of `beforeWrite` still stands once the tablet reports its record
 * anew: each field it reports unchanged, or set back to its value before the
 * server's write. A field it set to anything else is the tablet's own value
 * now, so setting it back to its value before the write later is an edit,
 * not a stale save. Null once none stands.
 */
export function beforeWriteAfter(
  beforeWrite: Readonly<Record<string, unknown>> | null,
  known: Readonly<Record<string, unknown>>,
  reported: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (beforeWrite === null) return null;
  const standing = Object.entries(beforeWrite).filter(([field, value]) => sameValue(reported[field], known[field]) || sameValue(reported[field], value));
  return standing.length === 0 ? null : Object.fromEntries(standing);
}

/**
 * What `before_write` holds once the server writes a tablet's record: for
 * each field the write set, what the record held just before it, null for a
 * field it held no value for; for each field it did not set, what `previous`
 * held, from the latest write that set it. But not a field the record held
 * at its value before the server's previous write to it: such a write puts
 * back the item's value over what was taken as a stale save, so the tablet
 * setting that value again is its barista's edit (ADR-0005), not another
 * stale save. Null if none is left.
 */
export function heldBefore(
  record: Readonly<Record<string, unknown>>,
  written: Iterable<string>,
  previous: Readonly<Record<string, unknown>> | null = null,
): Record<string, unknown> | null {
  const restoring = (field: string) => previous !== null && Object.prototype.hasOwnProperty.call(previous, field) && sameValue(record[field], previous[field]);
  const fields = new Set(written);
  const kept = Object.entries(previous ?? {}).filter(([field]) => !fields.has(field));
  const held = [...fields].filter((field) => !restoring(field)).map((field) => [field, record[field] ?? null] as const);
  const all = [...kept, ...held];
  return all.length === 0 ? null : Object.fromEntries(all);
}

/**
 * What a write's answer gives of a tablet's record the map holds (`known`):
 * the fields of its content the write did not set that the tablet edited
 * since its last report (`editedContent`), each with its value; whether any
 * other such field differs from the record known only as set back to its
 * value before an earlier write of the server's (`stale`), as by a page
 * opened before that write or that write lost, so the item's value is due to
 * be written again; and what `before_write` holds after it (`heldBefore`),
 * forgetting for a field the write did not set a value the tablet has since
 * set to one of its own (`beforeWriteAfter`).
 */
export function answeredEquipment(
  known: Readonly<Record<string, unknown>>,
  answered: Readonly<Record<string, unknown>>,
  written: ReadonlySet<string>,
  beforeWrite: Readonly<Record<string, unknown>> | null,
): { values: Record<string, unknown>; stale: boolean; beforeWrite: Record<string, unknown> | null } {
  const unwritten = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).filter(([field]) => !written.has(field)));
  const changed = unwritten(changedFields(equipmentContent(known), equipmentContent(answered)));
  const values = unwritten(editedContent(known, answered, beforeWrite));
  const pick = (writtenFields: boolean) => Object.fromEntries(Object.entries(beforeWrite ?? {}).filter(([field]) => written.has(field) === writtenFields));
  // A field the write set keeps its value before the previous write, for `heldBefore` to tell a write over a stale save.
  const previous = { ...(beforeWriteAfter(pick(false), known, answered) ?? {}), ...pick(true) };
  return { values, stale: Object.keys(changed).length > Object.keys(values).length, beforeWrite: heldBefore(known, written, previous) };
}

/**
 * What a report changes. Records whose item is known come first, in the
 * order reported, so no record matched by name can take their item. A
 * record the tablet's map holds by its local id stays that item whatever
 * global id it carries, so one whose global id another app wiped is not
 * taken for a new one (ADR-0006); it replaces the record known when it
 * differs, and each field of its content it changed is an edit
 * (`editedContent`). Otherwise a record carrying a Library item's global id
 * is that item, as on a tablet whose answer to the write was lost.
 *
 * Every other record is new, and comes next, in the order reported: it is
 * linked to a Library item of the same name that is not Archived, the oldest
 * first, or joins the Library (ADR-0018). An item another record the tablet
 * still reports is already is neither mapped nor linked again, so it never
 * gets two records on one tablet.
 *
 * Last, each record the map holds whose id the list no longer holds
 * (`listed`, every id the reported list holds, read or not), unless another
 * record it reports is that item now: deleted on the tablet if a report
 * listed it before, and otherwise lost to another app rewriting the list as
 * the server wrote it, which the map forgets. A new or reset tablet's map
 * holds nothing, so it deletes nothing (ADR-0019).
 */
export function planEquipmentIntake(
  reported: readonly ReportedEquipment[],
  mapped: readonly MappedEquipment[],
  library: readonly LibraryEquipment[],
  listed: ReadonlySet<string> = new Set(reported.map((record) => record.localId)),
): EquipmentIntakeStep[] {
  const byLocalId = new Map(mapped.map((record) => [record.localId, record]));
  const reportedIds = new Set(reported.map((record) => record.localId));
  /** Library items one of the tablet's reported records is, or is about to be. */
  const held = new Set(mapped.filter((record) => reportedIds.has(record.localId)).map((record) => record.itemId));
  const known = new Map(library.map((item) => [item.id, item]));
  const steps: EquipmentIntakeStep[] = [];
  const unknown: ReportedEquipment[] = [];
  for (const record of reported) {
    const mine = byLocalId.get(record.localId);
    if (mine) {
      if (!sameValue(mine.record, record.record)) {
        steps.push({ kind: "update", itemId: mine.itemId, reported: record, content: editedContent(mine.record, record.record, mine.beforeWrite) });
      }
      continue;
    }
    const named = record.globalId === null ? undefined : known.get(record.globalId);
    if (named && !held.has(named.id)) {
      held.add(named.id);
      steps.push({ kind: "map", itemId: named.id, reported: record });
      continue;
    }
    unknown.push(record);
  }
  for (const record of unknown) {
    const match = library.find((candidate) => candidate.matchKey === record.matchKey && !candidate.archived && !held.has(candidate.id));
    if (match) {
      held.add(match.id);
      steps.push({ kind: "link", itemId: match.id, reported: record });
    } else {
      steps.push({ kind: "add", reported: record });
    }
  }
  for (const record of mapped) {
    if (listed.has(record.localId) || held.has(record.itemId)) continue;
    steps.push(
      record.listed
        ? { kind: "delete", itemId: record.itemId, localId: record.localId, updatedAt: record.updatedAt }
        : { kind: "forget", itemId: record.itemId, localId: record.localId },
    );
  }
  return steps;
}
