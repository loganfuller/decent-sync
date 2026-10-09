import { isRecordId } from "@decent-sync/protocol";
import { isObject } from "./listed.js";
import { changedFields } from "./merge.js";

// How a tablet's report of its profiles is taken into the Library (ADR-0006,
// ADR-0018), and what each change means at the tablet's Location (ADR-0008,
// ADR-0019): the mapping from tablet records to per-Location state. A
// Profile keeps Decaid's id, a hash of what the machine executes, so a
// record's id is its Profile's on every tablet. Decided from the report, the
// tablet's map, the Library Profiles the report may name, whether the
// Location shows them and when the tablet joined it. Pure, so module tests
// can drive it; profiles.ts reads what it needs and carries the plan out.

/** A profile as a tablet reported it, one Decent Sync can take in. */
export interface ReportedProfile {
  /** Decaid's id for it: its Profile's, the same on every tablet. */
  id: string;
  /** Whether it is visible on the tablet, neither hidden nor deleted: shown at the tablet's Location (ADR-0008). */
  visible: boolean;
  /** Whether Decaid's delete marked it deleted, as it does a user's Profile. */
  deleted: boolean;
  /** Whether it is one of Decaid's bundled Profiles (`isDefault`). */
  bundled: boolean;
  /** Its `updatedAt`, placed in UTC by the plugin: the time of its edits. */
  updatedAt: Date;
  /** The record, as Decaid sent it. */
  record: Record<string, unknown>;
}

/** A Library Profile the tablet's map holds a record of: the record as the tablet last had it. */
export interface MappedProfile {
  profileId: string;
  /** When the record known was updated, by the tablet's clock; null if its time could not be read. */
  updatedAt: Date | null;
  /** Whether the record known is visible. */
  visible: boolean;
  /** Whether the record known is marked deleted. */
  deleted: boolean;
  /** The record known, as the tablet reported it or Decaid returned the plugin's write of it. */
  record: Record<string, unknown>;
}

/** Whether the Location shows a Profile it has decided, and the time of the edit that decided it last. */
export interface LocationProfile {
  shown: boolean;
  changedAt: Date;
  /** Whether the reporting tablet's own edit decided it last: what the tablet reports of it now, it changed after that. */
  byTablet: boolean;
}

/**
 * One thing a report changes. A `shown` is an edit the tablet made to whether
 * the Profile is shown at its Location, timed by its record: it wins over the
 * Location's state unless that was decided later, by an edit the tablet had
 * not seen (ADR-0020). A `decide` is whether it is shown there where the
 * Location has decided nothing of it yet, as checked again when it is
 * carried out.
 */
export type ProfileIntakeStep =
  /**
   * The tablet's record of a Profile the map holds is newer than the one
   * known, which it replaces. With `shown`, the tablet made it visible since
   * (true), so it is shown at its Location, or hid or deleted it (false), so it
   * is hidden there, deleting one it had hidden included. `content` holds
   * its title, author and notes where the tablet changed them since, each
   * with its value: its edit (ADR-0020). Decaid refuses to change a bundled
   * Profile's, so a bundled Profile has none.
   */
  | { kind: "update"; profileId: string; profile: ReportedProfile; shown?: boolean; content: Record<string, unknown> }
  /**
   * The tablet holds a Library Profile the map did not know it held. Where
   * the Location has decided nothing of it yet, the record's visibility
   * decides it (`decide`). Otherwise the Location's state stands, and is
   * written to the tablet, unless the tablet made the record visible after
   * both that state was decided and the tablet joined the Location, as a
   * barista re-creating a Profile hidden there does (`shown`). Shown there
   * already, that is the field's latest edit still.
   */
  | { kind: "map"; profileId: string; profile: ReportedProfile; decide?: boolean; shown?: true }
  /** A Profile new to the Library, which joins it, created at the tablet's Location, shown there if visible on the tablet. */
  | { kind: "add"; profile: ReportedProfile; decide: boolean }
  /**
   * One of Decaid's bundled Profiles the map holds, which the tablet's
   * Location has decided nothing of, as when its Machine moved there: the
   * record decides it, as it would have on the tablet's first report there.
   */
  | { kind: "decide"; profileId: string; shown: boolean; at: Date }
  /**
   * A record the map holds is gone from the tablet's list, as when Decaid
   * replaced it with one of new steps under another id, or purged it: the
   * tablet holds it no more, and it is hidden at its Location (ADR-0019),
   * whether the record known was visible or not.
   */
  | { kind: "delete"; profileId: string; updatedAt: Date | null; shown: false };

/** The fields of a Profile's `profile` that are its content's edits: outside its id (ADR-0006). */
export const PROFILE_TEXT = ["title", "author", "notes"] as const;

/** A Profile's title, author and notes, from its record or its content: each null where it has none. */
export function profileText(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const profile = isObject(record.profile) ? record.profile : {};
  return Object.fromEntries(PROFILE_TEXT.map((field) => [field, profile[field] ?? null]));
}

/**
 * The profiles of a reported `profiles` list that Decent Sync can take in,
 * each with its time in UTC as the plugin placed it beside the list. A record
 * without what every supported Decaid sends (its id, its profile, its
 * visibility and an `updatedAt` the plugin could place) is left out.
 */
export function readReportedProfiles(value: unknown, updatedAt: readonly (string | null)[] | undefined): ReportedProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record: unknown, index) => {
    const time = updatedAt?.[index];
    if (!isObject(record) || !isRecordId(record.id) || !isObject(record.profile) || typeof record.visibility !== "string" || !time) return [];
    const { visibility } = record;
    return [{ id: record.id, visible: visibility === "visible", deleted: visibility === "deleted", bundled: record.isDefault === true, updatedAt: new Date(time), record }];
  });
}

/**
 * A Profile's content, from a tablet's record of it: Decaid's fields, those
 * this server does not know included, but its id, times and visibility, which
 * belong to that tablet's record or to each Location (ADR-0008).
 */
export function profileContent(record: Record<string, unknown>): Record<string, unknown> {
  const { id, createdAt, updatedAt, visibility, ...content } = record;
  return content;
}

/**
 * What a report changes. A record the tablet's map holds replaces the one
 * known when it is newer, or as old but of another visibility, changed within
 * the millisecond the plugin reads times to. One made visible since is shown
 * at the tablet's Location; one hidden or deleted since is hidden there
 * (ADR-0019), one the tablet had hidden and deleted since too, or had
 * deleted and hidden since, as another tablet may have shown it there
 * meanwhile. Only a Profile the tablet held
 * can be hidden this way. Each is an edit timed by its record, which loses to
 * a later one the tablet had not seen (ADR-0020), and so is a change of its
 * title, author or notes, which are outside its id, so the Profile is the
 * same (ADR-0006).
 *
 * Every other record is one the map does not hold yet: one the tablet
 * created, or held before it joined its Location, or was written by a write
 * whose answer was lost. A Profile is never matched otherwise, since its id
 * is the same on every tablet (ADR-0018). One the Library holds (`library`)
 * is that Profile, and one it does not joins it, created at the tablet's
 * Location. Where the Location has decided nothing of the Profile yet
 * (`located`), the record's visibility decides it, so an identical Profile
 * created at two Locations is shown at both. Otherwise the Location's state
 * wins (ADR-0008), and the tablet is written it, so a new tablet's bundled
 * Profiles do not show those its Location hid; but a record of a user's
 * Profile made visible after both that state was decided and the tablet
 * joined the Location (`joinedAt`, null if it is not known) is an edit made
 * there, and shows it, as when a barista re-creates a Profile, under its old
 * steps, that the Location hid when they changed it; shown there already, it
 * is the field's latest edit still (ADR-0020).
 *
 * Where the Location has decided nothing of a bundled Profile the map holds,
 * as after the tablet's Machine moved there, its record decides it as on a
 * first report there, so a moved tablet keeps Decaid's bundled Profiles as it
 * had them at a Location that has none of its own. A user's Profile the map
 * holds stays as the Location has it: hidden there until someone shows it
 * there, as it belonged to the Location the tablet held it at (ADR-0008).
 *
 * Last, each record the map holds whose id the list no longer holds
 * (`listed`, every id the reported list holds, read or not) is gone from the
 * tablet, and hidden at its Location, as deleting it there does. A new or
 * reset tablet's map holds nothing, so it hides nothing (ADR-0019).
 */
export function planProfileIntake(
  reported: readonly ReportedProfile[],
  mapped: readonly MappedProfile[],
  library: ReadonlySet<string>,
  located: ReadonlyMap<string, LocationProfile>,
  joinedAt: Date | null,
  listed: ReadonlySet<string> = new Set(reported.map((profile) => profile.id)),
): ProfileIntakeStep[] {
  const byId = new Map(mapped.map((profile) => [profile.profileId, profile]));
  const seen = new Set<string>();
  const steps: ProfileIntakeStep[] = [];
  for (const profile of reported) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    const mine = byId.get(profile.id);
    const decided = located.get(profile.id);
    if (mine) {
      const content = profile.bundled ? {} : changedFields(profileText(mine.record), profileText(profile.record));
      const newer = mine.updatedAt === null || profile.updatedAt.getTime() > mine.updatedAt.getTime();
      // Times are read to the millisecond, so one as old that was changed since was changed within it.
      const sameTime =
        mine.updatedAt !== null &&
        profile.updatedAt.getTime() === mine.updatedAt.getTime() &&
        (profile.visible !== mine.visible || profile.deleted !== mine.deleted || Object.keys(content).length > 0);
      if (newer || sameTime) {
        // Deleted since it was hidden, or hidden again since it was deleted, is hidden still, as an edit: another tablet may have shown it meanwhile.
        const shown = profile.visible !== mine.visible ? profile.visible : profile.deleted !== mine.deleted ? false : undefined;
        steps.push({ kind: "update", profileId: profile.id, profile, ...(shown === undefined ? {} : { shown }), content });
      }
      if (!decided && profile.bundled) steps.push({ kind: "decide", profileId: profile.id, shown: profile.visible, at: profile.updatedAt });
      continue;
    }
    if (!library.has(profile.id)) steps.push({ kind: "add", profile, decide: profile.visible });
    else if (!decided) steps.push({ kind: "map", profileId: profile.id, profile, decide: profile.visible });
    else if (profile.visible && !profile.bundled && madeThere(profile, decided, joinedAt)) steps.push({ kind: "map", profileId: profile.id, profile, shown: true });
    else steps.push({ kind: "map", profileId: profile.id, profile });
  }
  for (const profile of mapped) {
    if (!listed.has(profile.profileId)) {
      steps.push({ kind: "delete", profileId: profile.profileId, updatedAt: profile.updatedAt, shown: false });
    }
  }
  return steps;
}

/**
 * Whether a record was changed at the tablet's Location after both it joined
 * there and the Location's state was decided: by their times, or, where the
 * tablet's own edit decided it, as when it deleted the Profile there, by
 * construction, as a tablet reports in order, so a clock behind PostgreSQL's,
 * which timed that delete, does not matter.
 */
function madeThere(profile: ReportedProfile, decided: LocationProfile, joinedAt: Date | null): boolean {
  if (decided.byTablet) return true;
  const at = profile.updatedAt.getTime();
  return joinedAt !== null && at > joinedAt.getTime() && at >= decided.changedAt.getTime();
}

/**
 * Whether the record Decaid returned for one of the server's writes shows
 * the tablet showed the Profile since its last report (true), or hid or
 * deleted it (false), as a report would (`planProfileIntake`): undefined if
 * the write set its visibility itself, the record known agrees, or none is
 * known. A write of a Profile's title, author or notes alone, or one whose
 * visibility the plugin left as the tablet had changed it, keeps the
 * tablet's, and the next report holds the record as answered.
 */
export function visibilityInAnswer(
  known: Pick<MappedProfile, "visible" | "deleted"> | null,
  record: Record<string, unknown>,
  written: ReadonlySet<string>,
): boolean | undefined {
  if (known === null || written.has("visibility")) return undefined;
  const visible = record.visibility === "visible";
  const deleted = record.visibility === "deleted";
  return visible !== known.visible ? visible : deleted !== known.deleted ? false : undefined;
}
