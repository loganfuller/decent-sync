// Placing Profile Versions in Profiles (ADR-0038, #735): the rules that say
// which lasting Profile each `profiles` row belongs to, as a pure plan, which
// profile-placing.ts reads the rows for and carries out. The same rules
// convert the rows an upgrade finds, place a row the previous release
// inserts beside this one (ADR-0025), and place what this release's own
// publishing and tablets make, which until a later change still act on one
// version at a time:
//
// - A row saved from another, by Decaid's `parentId`, is a version of that
//   one's Profile where the one it was saved from is in use nowhere, so was
//   replaced. Where that one is still in use, as after a Duplicate or a
//   version published at some Locations only, the row starts a separate
//   Profile, which says which Profile it was started from.
// - Each of Decaid's bundled Profiles is a Profile of one version, and a row
//   saved from one starts a separate Profile.
// - Where two versions of one Profile are both in use, as a fork leaves
//   them, the later to join the Library is current and the other starts a
//   separate Profile. A Profile already made keeps its current version
//   where that is one of the two, so its id goes on naming the same line.
// - Where none is in use, the latest to join is current, and the Profile is
//   shown nowhere.
// - Version numbers are given in the order the versions joined the Library,
//   and a version already numbered keeps its number in its Profile.
//
// "In use" is shown at a Location while not Archived, or named by a Recipe
// that is not Archived: so every Location shows the steps it showed, and
// every such Recipe holds the steps it held. Only an Archived Recipe can
// then name an earlier version, and it follows to the current one.

/** One `profiles` row as the rules read it. */
export interface PlacingRow {
  /** Decaid's id. */
  id: string;
  /** The row it was saved from, by its content's `parentId`, whether or not the Library has it. */
  parentId: string | null;
  bundled: boolean;
  /** Shown at a Location while not Archived, or named by a Recipe that is not Archived. */
  inUse: boolean;
  /** When it joined the Library. */
  joinedAt: Date;
  /** The Profile it belongs to and its number there; null until placed. */
  profileId: string | null;
  versionNumber: number | null;
}

/** A Profile as the rules read it. */
export interface PlacingProfile {
  id: string;
  currentVersionId: string;
}

/** What placing changes. */
export interface PlacementPlan {
  /** Profiles to make, each with its current version and the Profile it was started from, which may be one made here. */
  created: { id: string; currentVersionId: string; startedFromId: string | null; createdAt: Date }[];
  /** Rows given a Profile and a number: those not placed before, and those that leave a Profile for one of their own. */
  placed: { id: string; profileId: string; versionNumber: number }[];
  /** Profiles the Library has whose current version changes. */
  current: { profileId: string; versionId: string }[];
  /** Profiles the Library has that no row belongs to any longer. */
  removed: string[];
  /** Every Profile whose versions or current version the plan changes, made here or not, with its versions: its Recipes follow to its current version. */
  touched: { profileId: string; currentVersionId: string; versionIds: string[] }[];
}

/** Whether a plan changes anything. */
export function isEmptyPlan(plan: PlacementPlan): boolean {
  return plan.created.length === 0 && plan.placed.length === 0 && plan.current.length === 0 && plan.removed.length === 0;
}

/** The rows in the order they joined the Library, by id where two joined at once. */
function byJoining(a: PlacingRow, b: PlacingRow): number {
  return a.joinedAt.getTime() - b.joinedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Group {
  id: string;
  /** Whether the Library has it already. */
  existing: boolean;
  /** Its current version before the plan; null for one made here, or one whose current version is no longer its own. */
  was: string | null;
  startedFromId: string | null;
  members: PlacingRow[];
  /** The members that join it here, which take the next numbers. */
  joined: PlacingRow[];
}

/**
 * Plans the placing of `rows`, which must be every row linked to one being
 * placed, by `parentId` or by sharing a Profile, and `profiles`, the Profiles
 * those rows belong to. `separate` names rows known to start a Profile of
 * their own whatever the one they were saved from is, as a Draft published
 * as a separate Profile does. `newId` makes a Profile's id.
 */
export function planPlacement(
  rows: readonly PlacingRow[],
  profiles: readonly PlacingProfile[],
  newId: () => string,
  separate: ReadonlySet<string> = new Set(),
): PlacementPlan {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, Group>();
  const groupOf = new Map<string, Group>();
  for (const profile of profiles) groups.set(profile.id, { id: profile.id, existing: true, was: profile.currentVersionId, startedFromId: null, members: [], joined: [] });
  for (const row of rows) {
    const group = row.profileId === null ? undefined : groups.get(row.profileId);
    if (!group) continue;
    group.members.push(row);
    groupOf.set(row.id, group);
  }
  const changed = new Set<Group>();
  /** The rows that leave the Profile they were placed in. */
  const left = new Set<string>();

  const start = (row: PlacingRow, from: Group | null): Group => {
    const group: Group = { id: newId(), existing: false, was: null, startedFromId: from?.id ?? null, members: [row], joined: [row] };
    groups.set(group.id, group);
    groupOf.set(row.id, group);
    changed.add(group);
    return group;
  };

  const placing = new Set<string>();
  const place = (row: PlacingRow): Group => {
    const placed = groupOf.get(row.id);
    if (placed) return placed;
    // A loop of links, which Decaid's hash makes all but impossible, ends where it began.
    placing.add(row.id);
    const parent = row.parentId === null || row.parentId === row.id || placing.has(row.parentId) ? undefined : byId.get(row.parentId);
    const from = row.bundled || !parent ? null : place(parent);
    placing.delete(row.id);
    if (from === null) return start(row, null);
    if (parent!.bundled || parent!.inUse || separate.has(row.id)) return start(row, from);
    from.members.push(row);
    from.joined.push(row);
    groupOf.set(row.id, from);
    changed.add(from);
    return from;
  };
  for (const row of [...rows].sort(byJoining)) place(row);

  // Two versions of one Profile both in use: its current one stays, where that is one of them, so a Profile the Library
  // has keeps what its id names; else the later to join stays. Each other starts a Profile of its own.
  for (const group of [...groups.values()]) {
    const used = group.members.filter((row) => row.inUse).sort(byJoining);
    const stays = used.find((row) => row.id === group.was) ?? used[used.length - 1];
    for (const row of used.filter((each) => each !== stays)) {
      group.members = group.members.filter((member) => member !== row);
      group.joined = group.joined.filter((member) => member !== row);
      changed.add(group);
      if (row.profileId === group.id) left.add(row.id);
      start(row, group);
    }
  }

  const plan: PlacementPlan = { created: [], placed: [], current: [], removed: [], touched: [] };
  for (const group of groups.values()) {
    if (group.members.length === 0) {
      if (group.existing) plan.removed.push(group.id);
      continue;
    }
    const members = [...group.members].sort(byJoining);
    const held = group.was !== null && members.some((row) => row.id === group.was) ? group.was : null;
    const used = members.find((row) => row.inUse);
    const latest = members[members.length - 1]!;
    // The one in use; else the one it had, unless a later one joined it here; else the latest to join.
    const current = used?.id ?? (held !== null && !group.joined.some((row) => byJoining(row, byId.get(held)!) > 0) ? held : latest.id);
    if (!group.existing) {
      plan.created.push({ id: group.id, currentVersionId: current, startedFromId: group.startedFromId, createdAt: members[0]!.joinedAt });
    } else if (current !== group.was) {
      plan.current.push({ profileId: group.id, versionId: current });
      changed.add(group);
    }
    let next = Math.max(0, ...members.map((row) => (row.profileId === group.id && !left.has(row.id) ? (row.versionNumber ?? 0) : 0)));
    for (const row of [...group.joined].sort(byJoining)) plan.placed.push({ id: row.id, profileId: group.id, versionNumber: ++next });
    if (changed.has(group)) plan.touched.push({ profileId: group.id, currentVersionId: current, versionIds: members.map((row) => row.id) });
  }
  // A Profile started from one that is removed here is started from none.
  const removed = new Set(plan.removed);
  for (const made of plan.created) if (made.startedFromId !== null && removed.has(made.startedFromId)) made.startedFromId = null;
  return plan;
}

/**
 * The rows gathered into those linked to one another, by `parentId` or by
 * sharing a Profile: each set is planned alone (`planPlacement`), so placing
 * can be carried out a few at a time.
 */
export function linkedRows(rows: readonly PlacingRow[]): PlacingRow[][] {
  const root = new Map<string, string>();
  const find = (key: string): string => {
    let at = key;
    while (root.get(at) !== undefined && root.get(at) !== at) at = root.get(at)!;
    root.set(key, at);
    return at;
  };
  const join = (a: string, b: string) => root.set(find(a), find(b));
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    root.set(row.id, root.get(row.id) ?? row.id);
    if (row.parentId !== null && ids.has(row.parentId)) join(row.id, row.parentId);
    if (row.profileId !== null) join(row.id, `profile ${row.profileId}`);
  }
  const sets = new Map<string, PlacingRow[]>();
  for (const row of rows) sets.set(find(row.id), [...(sets.get(find(row.id)) ?? []), row]);
  return [...sets.values()];
}

/** Whether a set of linked rows has anything to place: a row with no Profile, a version in use that is not its Profile's current one, or a Profile whose current version is not its own. */
export function needsPlacing(rows: readonly PlacingRow[], profiles: readonly PlacingProfile[]): boolean {
  const currentOf = new Map(profiles.map((profile) => [profile.id, profile.currentVersionId]));
  const ids = new Set(rows.map((row) => `${row.profileId} ${row.id}`));
  return (
    rows.some((row) => row.profileId === null || !currentOf.has(row.profileId) || (row.inUse && currentOf.get(row.profileId) !== row.id)) ||
    profiles.some((profile) => !ids.has(`${profile.id} ${profile.currentVersionId}`))
  );
}
