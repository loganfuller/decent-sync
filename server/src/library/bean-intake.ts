import { beanMatchKey, globalIdOf, isRecordId } from "@decent-sync/protocol";
import { isObject } from "./listed.js";

// How a tablet's report of its beans is taken into the Library (ADR-0006,
// ADR-0018), and what it means at the tablet's Location (ADR-0008,
// ADR-0019), decided from the report, the tablet's map and the Library Beans
// the report may name. Pure, so module tests can drive it; beans.ts reads
// what it needs and carries the plan out.

/** A bean as a tablet reported it, one Decent Sync can take in. */
export interface ReportedBean {
  /** Decaid's id for it on that tablet. */
  localId: string;
  /** The global id its `extras` carry, if any. */
  globalId: string | null;
  /** Whether it is archived on the tablet. */
  archived: boolean;
  /** Its roaster and name as Beans are matched. */
  matchKey: string;
  /** Its `updatedAt`, placed in UTC by the plugin. */
  updatedAt: Date;
  /** The record, as Decaid sent it. */
  record: Record<string, unknown>;
}

/** A Library Bean the tablet's map holds a record of. */
export interface MappedBean {
  beanId: string;
  localId: string;
  /** When the record known was updated, by the tablet's clock; null if its time could not be read. */
  updatedAt: Date | null;
  /** The global id the record known carries, if any. */
  globalId: string | null;
  /** Whether the record known is archived on the tablet. */
  archived: boolean;
}

/** A Library Bean the report may name, by the global id a record carries or by roaster and name. */
export interface LibraryBean {
  id: string;
  matchKey: string;
  archived: boolean;
}

/** One thing a report changes. */
export type IntakeStep =
  /**
   * The tablet's record of a Bean the map holds is newer than the one known,
   * which it replaces. With `archived`, the tablet archived the record since
   * (true), so the Bean leaves its Location, or un-archived it (false), so it
   * is offered there again.
   */
  | { kind: "update"; beanId: string; bean: ReportedBean; archived?: boolean }
  /** The tablet holds a Library Bean the map did not know it held, by the global id its record carries. */
  | { kind: "map"; beanId: string; bean: ReportedBean }
  /** A bean new to the Library whose roaster and name match a Library Bean's: it is that Bean. */
  | { kind: "link"; beanId: string; bean: ReportedBean }
  /** A bean new to the Library, which joins it. */
  | { kind: "add"; bean: ReportedBean }
  /**
   * A record the map holds is gone from the tablet's list: the tablet deleted
   * the Bean, which leaves its Location (ADR-0019), and holds it no more.
   */
  | { kind: "delete"; beanId: string; localId: string; updatedAt: Date | null };

/**
 * The beans of a reported `beans` list that Decent Sync can take in, each
 * with its time in UTC as the plugin placed it beside the list. A record
 * without what every supported Decaid sends (its id, roaster, name and
 * `updatedAt`) is left out.
 */
export function readReportedBeans(value: unknown, updatedAt: readonly (string | null)[] | undefined): ReportedBean[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record: unknown, index) => {
    const time = updatedAt?.[index];
    if (!isObject(record) || !isRecordId(record.id) || typeof record.roaster !== "string" || typeof record.name !== "string" || !time) return [];
    return [
      {
        localId: record.id,
        globalId: globalIdOf(record),
        archived: record.archived === true,
        matchKey: beanMatchKey(record.roaster, record.name),
        updatedAt: new Date(time),
        record,
      },
    ];
  });
}

/**
 * A Bean's content, from a tablet's record of it: Decaid's fields, those
 * this server does not know included, but its id, times, archived flag and
 * `extras`, which belong to that tablet's record.
 */
export function beanContent(record: Record<string, unknown>): Record<string, unknown> {
  const { id, createdAt, updatedAt, archived, extras, ...content } = record;
  return content;
}

/**
 * What a report changes. Records whose Bean is known come first, in the
 * order reported, so no record matched by roaster and name can take their
 * Bean. A record the tablet's map holds by its local id stays that Bean
 * whatever global id it carries, so a record whose global id another plugin
 * wiped is not taken for a new one (ADR-0006). Its record replaces the one
 * known when it is newer, or when it no longer carries the Bean's global id
 * while the one known does, whatever its time: a tablet's clock can go back,
 * and the id is still to be written back. One as old as the record known
 * replaces it too when it was archived or un-archived since, within the
 * millisecond the plugin reads times to. A record replacing one known with
 * another archived flag was archived or un-archived on the tablet since.
 * Otherwise a record carrying a Library Bean's global id is that Bean, as on
 * a tablet whose answer to the write was lost, or that was restored from a
 * backup.
 *
 * Every other record is new, and comes next, in the order reported: it is
 * linked to a Library Bean with the same roaster and name, the oldest first,
 * or joins the Library (ADR-0018), archived on the tablet or not. Archived
 * Beans, which are offered nowhere, are never matched. A Bean already held by
 * another record the tablet still reports is neither mapped nor linked
 * again, so it never gets two records on one tablet.
 *
 * Last, each record the map holds whose id the list no longer holds
 * (`listed`, every id the reported list holds, read or not) was deleted on
 * the tablet, unless another record it reports is that Bean now. A tablet's
 * map holds only what it was known to hold, so a new or reset tablet deletes
 * nothing (ADR-0019).
 */
export function planIntake(
  reported: readonly ReportedBean[],
  mapped: readonly MappedBean[],
  library: readonly LibraryBean[],
  listed: ReadonlySet<string> = new Set(reported.map((bean) => bean.localId)),
): IntakeStep[] {
  const byLocalId = new Map(mapped.map((bean) => [bean.localId, bean]));
  const reportedIds = new Set(reported.map((bean) => bean.localId));
  /** Library Beans one of the tablet's reported records is, or is about to be. */
  const held = new Set(mapped.filter((bean) => reportedIds.has(bean.localId)).map((bean) => bean.beanId));
  const known = new Map(library.map((bean) => [bean.id, bean]));
  const seen = new Set<string>();
  const steps: IntakeStep[] = [];
  const unknown: ReportedBean[] = [];
  for (const bean of reported) {
    if (seen.has(bean.localId)) continue;
    seen.add(bean.localId);
    const mine = byLocalId.get(bean.localId);
    if (mine) {
      const newer = mine.updatedAt === null || bean.updatedAt.getTime() > mine.updatedAt.getTime();
      // Times are read to the millisecond, so one as old that was archived or un-archived since was changed within it.
      const sameTime = mine.updatedAt !== null && bean.updatedAt.getTime() === mine.updatedAt.getTime() && bean.archived !== mine.archived;
      const lostId = bean.globalId !== mine.beanId && mine.globalId === mine.beanId;
      if (newer || sameTime || lostId) {
        steps.push({ kind: "update", beanId: mine.beanId, bean, ...(bean.archived === mine.archived ? {} : { archived: bean.archived }) });
      }
      continue;
    }
    const named = bean.globalId === null ? undefined : known.get(bean.globalId);
    if (named && !held.has(named.id)) {
      held.add(named.id);
      steps.push({ kind: "map", beanId: named.id, bean });
      continue;
    }
    unknown.push(bean);
  }
  for (const bean of unknown) {
    const match = library.find((candidate) => candidate.matchKey === bean.matchKey && !candidate.archived && !held.has(candidate.id));
    if (match) {
      held.add(match.id);
      steps.push({ kind: "link", beanId: match.id, bean });
    } else {
      steps.push({ kind: "add", bean });
    }
  }
  for (const bean of mapped) {
    // A Bean another of its records is now, as one made again under another id, is still held.
    if (!listed.has(bean.localId) && !held.has(bean.beanId)) steps.push({ kind: "delete", beanId: bean.beanId, localId: bean.localId, updatedAt: bean.updatedAt });
  }
  return steps;
}

/**
 * Whether the record Decaid returned for one of the server's writes shows
 * the tablet archived the Bean since its last report (true) or un-archived
 * it (false), as `editsInAnswer` reads a batch's: undefined if the write set
 * `archived` itself, the record known agrees, or none is known.
 */
export function archivingInAnswer(knownArchived: boolean | null, record: Record<string, unknown>, written: ReadonlySet<string>): boolean | undefined {
  if (knownArchived === null || written.has("archived")) return undefined;
  const archived = record.archived === true;
  return archived === knownArchived ? undefined : archived;
}
