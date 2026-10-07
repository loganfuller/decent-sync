import { globalIdOf, isRecordId } from "@decent-sync/protocol";

// How a tablet's report of its beans is taken into the Library (ADR-0006,
// ADR-0018), decided from the report, the tablet's map and the Library Beans
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
}

/** A Library Bean the report may name, by the global id a record carries or by roaster and name. */
export interface LibraryBean {
  id: string;
  matchKey: string;
  archived: boolean;
}

/** One thing a report changes. */
export type IntakeStep =
  /** The tablet's record of a Bean the map holds is newer than the one known, which it replaces. */
  | { kind: "update"; beanId: string; bean: ReportedBean }
  /** The tablet holds a Library Bean the map did not know it held, by the global id its record carries. */
  | { kind: "map"; beanId: string; bean: ReportedBean }
  /** A bean new to the Library whose roaster and name match a Library Bean's: it is that Bean. */
  | { kind: "link"; beanId: string; bean: ReportedBean }
  /** A bean new to the Library, which joins it. */
  | { kind: "add"; bean: ReportedBean };

/**
 * The key two Beans with the same roaster and name share, ignoring case and
 * white space at either end (ADR-0018).
 */
export function beanMatchKey(roaster: string, name: string): string {
  return JSON.stringify([roaster.trim().toLowerCase(), name.trim().toLowerCase()]);
}

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
 * What a report changes, in the order reported. A record the tablet's map
 * holds by its local id stays that Bean whatever global id it carries, so a
 * record whose global id another plugin wiped is not taken for a new one
 * (ADR-0006); its record is replaced if it is newer. Otherwise a record
 * carrying a Library Bean's global id is that Bean, as on a tablet whose
 * answer to the write was lost, or that was restored from a backup. Any other
 * record is new: it is linked to a Library Bean with the same roaster and
 * name, the oldest first, or joins the Library (ADR-0018). A Bean already
 * held by another record the tablet still reports is neither mapped nor
 * linked again, so it never gets two records on one tablet.
 *
 * A new record archived on the tablet is left until archiving has its
 * meaning at a Location (ADR-0008), and so is not matched against Archived
 * Beans, which are offered nowhere.
 */
export function planIntake(reported: readonly ReportedBean[], mapped: readonly MappedBean[], library: readonly LibraryBean[]): IntakeStep[] {
  const byLocalId = new Map(mapped.map((bean) => [bean.localId, bean]));
  const reportedIds = new Set(reported.map((bean) => bean.localId));
  /** Library Beans one of the tablet's reported records is, or is about to be. */
  const held = new Set(mapped.filter((bean) => reportedIds.has(bean.localId)).map((bean) => bean.beanId));
  const known = new Map(library.map((bean) => [bean.id, bean]));
  const seen = new Set<string>();
  const steps: IntakeStep[] = [];
  for (const bean of reported) {
    if (seen.has(bean.localId)) continue;
    seen.add(bean.localId);
    const mine = byLocalId.get(bean.localId);
    if (mine) {
      if (mine.updatedAt === null || bean.updatedAt.getTime() > mine.updatedAt.getTime()) steps.push({ kind: "update", beanId: mine.beanId, bean });
      continue;
    }
    const named = bean.globalId === null ? undefined : known.get(bean.globalId);
    if (named && !held.has(named.id)) {
      held.add(named.id);
      steps.push({ kind: "map", beanId: named.id, bean });
      continue;
    }
    if (bean.archived) continue;
    const match = library.find((candidate) => candidate.matchKey === bean.matchKey && !candidate.archived && !held.has(candidate.id));
    if (match) {
      held.add(match.id);
      steps.push({ kind: "link", beanId: match.id, bean });
    } else {
      steps.push({ kind: "add", bean });
    }
  }
  return steps;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
