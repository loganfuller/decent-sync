import { globalIdOf, isRecordId } from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { changedFields } from "./merge.js";

// How a tablet's report of its grinders is taken into the Library (ADR-0006,
// ADR-0018), and what each change means for a Grinder, which belongs to one
// Location (ADR-0008, ADR-0019): the mapping from tablet records to the
// Library's state. Decided from the report, the tablet's map and the Library
// Grinders the report may name. Pure, so module tests can drive it;
// grinders.ts reads what it needs and carries the plan out.

/** A grinder as a tablet reported it, one Decent Sync can take in. */
export interface ReportedGrinder {
  /** Decaid's id for it on that tablet. */
  localId: string;
  /** The global id its `extras` carry, if any. */
  globalId: string | null;
  /** Whether it is archived on the tablet. */
  archived: boolean;
  /** Its `updatedAt`, placed in UTC by the plugin. */
  updatedAt: Date;
  /** The record, as Decaid sent it. */
  record: Record<string, unknown>;
}

/** A Library Grinder the tablet's map holds a record of: the record as the tablet last had it. */
export interface MappedGrinder {
  grinderId: string;
  localId: string;
  /** When the record known was updated, by the tablet's clock; null if its time could not be read. */
  updatedAt: Date | null;
  /** The global id the record known carries, if any. */
  globalId: string | null;
  /** Whether the record known is archived on the tablet. */
  archived: boolean;
  /** The record known, as the tablet reported it or Decaid returned the plugin's write of it. */
  record: Record<string, unknown>;
}

/** One thing a report changes. */
export type GrinderIntakeStep =
  /**
   * The tablet's record of a Grinder the map holds is newer than the one
   * known, which it replaces. With `archived`, the tablet archived the record
   * since (true), so the Grinder is Archived, or un-archived it (false), so it
   * is restored (ADR-0019). `content` holds the fields of its content the
   * tablet changed since, each with its value: its edit (ADR-0020).
   */
  | { kind: "update"; grinderId: string; grinder: ReportedGrinder; archived?: boolean; content: Record<string, unknown> }
  /** The tablet holds a Library Grinder the map did not know it held, by the global id its record carries. */
  | { kind: "map"; grinderId: string; grinder: ReportedGrinder }
  /** A grinder new to the Library, which joins it, belonging to the tablet's Location, Archived if it is archived there. */
  | { kind: "add"; grinder: ReportedGrinder }
  /**
   * A record the map holds is gone from the tablet's list: the tablet deleted
   * it, and holds it no more. With `archived`, the record known was not
   * archived, so the Grinder is Archived (ADR-0019), an edit timed when the
   * server learns of it, but no earlier than the record known (`updatedAt`).
   */
  | { kind: "delete"; grinderId: string; localId: string; updatedAt: Date | null; archived?: true };

/**
 * The grinders of a reported `grinders` list that Decent Sync can take in,
 * each with its time in UTC as the plugin placed it beside the list. A
 * record without what every supported Decaid sends (its id, its model and an
 * `updatedAt` the plugin could place) is left out.
 */
export function readReportedGrinders(value: unknown, updatedAt: readonly (string | null)[] | undefined): ReportedGrinder[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record: unknown, index) => {
    const time = updatedAt?.[index];
    if (!isObject(record) || !isRecordId(record.id) || typeof record.model !== "string" || !time) return [];
    return [{ localId: record.id, globalId: globalIdOf(record), archived: record.archived === true, updatedAt: new Date(time), record }];
  });
}

/**
 * A Grinder's content, from a tablet's record of it: Decaid's fields, those
 * this server does not know included, but its id, times, archived flag and
 * `extras`, which belong to that tablet's record.
 */
export function grinderContent(record: Record<string, unknown>): Record<string, unknown> {
  const { id, createdAt, updatedAt, archived, extras, ...content } = record;
  return content;
}

/**
 * What a report changes, as `planIntake` decides it for beans, but that
 * Grinders are never matched (ADR-0018): two grinders of one model are two
 * Grinders. A record the tablet's map holds by its local id stays that
 * Grinder whatever global id it carries; its record replaces the one known
 * when it is newer, or as old but archived or un-archived since, within the
 * millisecond the plugin reads times to, or when it no longer carries the
 * Grinder's global id while the one known does, whatever its time. Archived
 * since, the Grinder is Archived; un-archived, it is restored; each field of
 * its content that differs from the record known was edited. Otherwise a
 * record carrying a Library Grinder's global id (`library`) is that Grinder,
 * unless another record the tablet reports is it already, and changes
 * nothing: the Library's state is then written to it.
 *
 * Every other record is new, and joins the Library, Archived if it is
 * archived on the tablet.
 *
 * Last, each record the map holds whose id the list no longer holds
 * (`listed`, every id the reported list holds, read or not) was deleted on
 * the tablet, unless another record it reports is that Grinder now. If the
 * record known was not archived, the Grinder is Archived. A new or reset
 * tablet's map holds nothing, so it deletes nothing (ADR-0019).
 *
 * Whether the Grinder belongs to the tablet's Location, which an Archive or
 * restore from a tablet needs, is checked as the plan is carried out.
 */
export function planGrinderIntake(
  reported: readonly ReportedGrinder[],
  mapped: readonly MappedGrinder[],
  library: ReadonlySet<string>,
  listed: ReadonlySet<string> = new Set(reported.map((grinder) => grinder.localId)),
): GrinderIntakeStep[] {
  const byLocalId = new Map(mapped.map((grinder) => [grinder.localId, grinder]));
  const reportedIds = new Set(reported.map((grinder) => grinder.localId));
  /** Library Grinders one of the tablet's reported records is, or is about to be. */
  const held = new Set(mapped.filter((grinder) => reportedIds.has(grinder.localId)).map((grinder) => grinder.grinderId));
  const seen = new Set<string>();
  const steps: GrinderIntakeStep[] = [];
  for (const grinder of reported) {
    if (seen.has(grinder.localId)) continue;
    seen.add(grinder.localId);
    const mine = byLocalId.get(grinder.localId);
    if (mine) {
      const content = changedFields(grinderContent(mine.record), grinderContent(grinder.record));
      const newer = mine.updatedAt === null || grinder.updatedAt.getTime() > mine.updatedAt.getTime();
      // Times are read to the millisecond, so one as old that was changed since was changed within it.
      const sameTime =
        mine.updatedAt !== null &&
        grinder.updatedAt.getTime() === mine.updatedAt.getTime() &&
        (grinder.archived !== mine.archived || Object.keys(content).length > 0);
      const lostId = grinder.globalId !== mine.grinderId && mine.globalId === mine.grinderId;
      if (newer || sameTime || lostId) {
        steps.push({ kind: "update", grinderId: mine.grinderId, grinder, ...(grinder.archived === mine.archived ? {} : { archived: grinder.archived }), content });
      }
      continue;
    }
    if (grinder.globalId !== null && library.has(grinder.globalId) && !held.has(grinder.globalId)) {
      held.add(grinder.globalId);
      steps.push({ kind: "map", grinderId: grinder.globalId, grinder });
      continue;
    }
    steps.push({ kind: "add", grinder });
  }
  for (const grinder of mapped) {
    // A Grinder another of its records is now, as one made again under another id, is still held.
    if (listed.has(grinder.localId) || held.has(grinder.grinderId)) continue;
    steps.push({
      kind: "delete",
      grinderId: grinder.grinderId,
      localId: grinder.localId,
      updatedAt: grinder.updatedAt,
      ...(grinder.archived ? {} : { archived: true as const }),
    });
  }
  return steps;
}
