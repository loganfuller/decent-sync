import { Injectable, NotFoundException } from "@nestjs/common";
import { type MachineModel, type Profile, isGlobalId, isRecordId, machineModelOf, profileOf, profileTextOf } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { profileOfSql, shotListedSql, shotPulledWithSql } from "../shots/links.js";
import { type SourceView, viewSource, withSource } from "./history.service.js";
import { accountModels } from "./profile-reach.js";

/** A Profile another was started from, as a Duplicate is: its id, and its current version's Decaid id and title. */
export interface StartedFromView {
  profileId: string;
  id: string;
  title: string | null;
}

/**
 * A Profile as the REST API lists it (ADR-0038): the lasting Profile, read
 * through one of its Profile Versions, its current one in a list.
 */
export interface ProfileSummary {
  /** Decaid's id of the version read, a hash of what the machine executes, the same on every tablet: in a list, the Profile's current version. */
  id: string;
  /** The Profile's own id, the server's, which stays as the Profile gains versions; null until the server has placed the row in a Profile, when it reads as a Profile of this one version. */
  profileId: string | null;
  /** How many Profile Versions the Profile has had. */
  versions: number;
  /** The Profile it was started from, as a Duplicate is, if the Library still has it. */
  startedFrom: StartedFromView | null;
  /** Its title, author and beverage type, from its content; null where its content has none. */
  title: string | null;
  author: string | null;
  beverageType: string | null;
  /** Whether it is one of Decaid's bundled Profiles, which every tablet has already. */
  bundled: boolean;
  archived: boolean;
  /**
   * The Locations showing it (ADR-0008), by name, each with when the
   * Location last decided to show it, by PostgreSQL's clock, as when a tablet
   * there showed it again while it was shown. None while it is Archived.
   */
  shownAt: { location: LocationView; since: string }[];
  /** When it joined the Library, by PostgreSQL's clock. */
  createdAt: string;
  /** The Location of the tablet that created it, if it still exists. */
  createdLocation: LocationView | null;
}

/** A Profile with its content, as the REST API returns one. */
export interface ProfileView extends ProfileSummary {
  /** Decaid's record fields, as the tablet that created it sent them, those this server does not know included, but its visibility, which is each Location's. */
  content: Record<string, unknown>;
  /** Its profile, as Decaid reads it (`readProfile` in protocol/); null where Decaid would not. */
  profile: Profile | null;
  /** The number of the version read among its Profile's, "Version n", in the order they joined it; null until the row is placed. */
  version: number | null;
  /** The Profile's current version, by Decaid's id and its number: the version read where `id` is the same. */
  current: { id: string; version: number | null };
  /** The Profile it was saved from, as Streamline saves one whose steps changed, if the Library has it. */
  parent: { id: string; title: string | null } | null;
  /**
   * Each Location that has decided whether it shows it, by name: whether it
   * is shown there, and when that was last decided, by PostgreSQL's clock.
   * Kept while it is Archived, which shows it nowhere, so restoring it shows
   * it again where it is shown. A Location not listed does not show it.
   */
  locations: { location: LocationView; shown: boolean; since: string }[];
  /**
   * The Machine model it is simulated as unless another is asked for: a
   * Bengle where every Machine at the Locations showing it is one, and there
   * is at least one; a DE1 where it is shown nowhere, at no Location with a
   * Machine, or where a DE1 is among them (#578, #588).
   */
  machineModel: MachineModel;
  /**
   * The Machines whose tablets refused its write, the latest refusal first,
   * each with why: among them one Decaid answered under another id, as a
   * Decaid that computes a Profile's id otherwise than this server does
   * (ADR-0032), and one whose model can't run it (#588). Kept until the
   * tablet takes it or it is no longer due there (sharing-status.ts).
   */
  refusedOn: { machine: { id: string; name: string }; error: string; refusedAt: string }[];
}

/**
 * One of a Profile's Profile Versions (ADR-0038): one set of steps it has
 * had, a `profiles` row under Decaid's id, as the REST API returns one.
 */
export interface ProfileVersionView {
  id: string;
  /** Its number among the Profile's versions, "Version n", in the order they joined it, never given again; null until the row is placed. */
  number: number | null;
  /** Whether it is the Profile's current version. */
  current: boolean;
  title: string | null;
  bundled: boolean;
  archived: boolean;
  /** The version it was saved from, by Decaid's `parentId`, where that is among the Profile's versions; else null. */
  parentId: string | null;
  /**
   * When it was saved: by the record its first tablet sent, as its history's
   * first version has it, else when it joined the Library.
   */
  savedAt: string;
  /** Who saved it, its history's first version's source: the Machine whose tablet saved it, or the account that published it; null where its history has none. */
  savedBy: SourceView | null;
  /** The Locations showing it, as `ProfileSummary.shownAt` has them. */
  shownAt: { location: LocationView; since: string }[];
  /** How many Shots the Shots list lists on it, by the Library's rule for a Shot's Profile (`shotPulledWithSql`). */
  shots: number;
}

/** A Machine whose Workflow holds an earlier version of a Profile with no Recipe loaded, and that version. */
export interface EarlierOnView {
  machine: { id: string; name: string };
  version: { id: string; number: number | null };
}

/** A Profile's versions, as the REST API returns them. */
export interface ProfileVersionsView {
  /** The Profile's own id, null until placed, and its current version's Decaid id. */
  profile: { profileId: string | null; currentVersionId: string };
  /** Its versions, the latest to join first. */
  versions: ProfileVersionView[];
  /**
   * The Machines whose current Workflow holds the steps of an earlier
   * version, found as a Shot's Profile is (`profileOfSql`), while they have
   * no Loaded Recipe, by name: a Machine with a Loaded Recipe follows that
   * Recipe, so is never listed. The server sets no Workflow because of this.
   */
  earlierOn: EarlierOnView[];
}

/** The most Profile Versions a Profile's are read to, which no real Profile comes near. */
export const MAX_PROFILE_VERSIONS = 200;

/** A row read as an id addresses it: the version asked for, and its Profile, if it has been placed in one. */
export interface AddressedProfile {
  /** Decaid's id of the version addressed: the current one for a Profile's id. */
  versionId: string;
  profileId: string | null;
  /** Decaid's id of the Profile's current version: the version itself until placed. */
  currentVersionId: string;
}

const withPlaces = {
  createdLocation: true,
  locations: { where: { shown: true }, include: { location: true } },
  libraryProfile: { include: { startedFrom: true, _count: { select: { versions: true } } } },
} as const satisfies Prisma.ProfileInclude;

type ListedProfile = Prisma.ProfileGetPayload<{ include: typeof withPlaces }>;

/** A Profile's current version; one that is not its own, until the server puts it right, reads as its latest (`versions`, the latest first). */
function currentOf(profile: { currentVersionId: string; versions: readonly { id: string }[] }): string | undefined {
  return profile.versions.find((version) => version.id === profile.currentVersionId)?.id ?? profile.versions[0]?.id;
}

/** The Library's Profiles, which Staff read as Admins do. Profiles join it from tablets (`library/profiles.ts`). */
@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every Profile, by title, ignoring case: one row for each (ADR-0038), read
   * through its current version, and one for each row not yet placed in a
   * Profile, which reads as a Profile of one version.
   */
  async list(): Promise<ProfileSummary[]> {
    const rows = await this.prisma.profile.findMany({ include: withPlaces });
    const byId = new Map(rows.map((row) => [row.id, row]));
    /** The latest version of each Profile whose current version is not its own, as after the previous release deleted that row: read as current until the server puts it right. */
    const standIn = new Map<string, ListedProfile>();
    for (const row of rows) {
      const profile = row.libraryProfile;
      if (!profile || byId.get(profile.currentVersionId)?.libraryProfileId === profile.id) continue;
      const held = standIn.get(profile.id);
      if (!held || (row.versionNumber ?? 0) > (held.versionNumber ?? 0)) standIn.set(profile.id, row);
    }
    const titles = this.startedFromTitles(rows);
    return rows
      .filter((row) => row.libraryProfile === null || row.libraryProfile.currentVersionId === row.id || standIn.get(row.libraryProfile.id) === row)
      .map((row) => summary(row, titles))
      .sort((a, b) => compareText(a.title, b.title) || a.id.localeCompare(b.id));
  }

  /** The title of each Profile the rows were started from, by its current version's Decaid id, read from the rows themselves. */
  private startedFromTitles(rows: readonly ListedProfile[]): ReadonlyMap<string, string | null> {
    return new Map(rows.map((row) => [row.id, titled(row.content).title]));
  }

  /**
   * What an id addresses (ADR-0038): a Profile's own id its current version,
   * and a version's Decaid id that version, each with the Profile it belongs
   * to. 404 for neither.
   */
  async addressed(id: string): Promise<AddressedProfile> {
    const versions = { select: { id: true, versionNumber: true }, orderBy: { versionNumber: "desc" } } as const;
    if (isGlobalId(id)) {
      const profile = await this.prisma.libraryProfile.findUnique({ where: { id: id.toLowerCase() }, include: { versions } });
      const current = profile && currentOf(profile);
      if (!profile || !current) throw profileNotFound();
      return { versionId: current, profileId: profile.id, currentVersionId: current };
    }
    const row = await this.prisma.profile.findUnique({ where: { id }, select: { id: true, libraryProfile: { include: { versions } } } });
    if (!row) throw profileNotFound();
    return { versionId: row.id, profileId: row.libraryProfile?.id ?? null, currentVersionId: (row.libraryProfile && currentOf(row.libraryProfile)) ?? row.id };
  }

  /** Decaid's ids of every version of the Profile the id addresses (`addressed`): the row alone until it is placed. */
  async versionIds(id: string): Promise<string[]> {
    const { versionId, profileId, currentVersionId } = await this.addressed(id);
    if (profileId === null) return [versionId];
    // Where a Profile has more than the most read, the latest, and its current one, which a return can leave earlier.
    const latest = await this.prisma.profile.findMany({
      where: { libraryProfileId: profileId, id: { not: currentVersionId } },
      select: { id: true, versionNumber: true },
      orderBy: { versionNumber: "desc" },
      take: MAX_PROFILE_VERSIONS - 1,
    });
    const current = await this.prisma.profile.findUnique({ where: { id: currentVersionId }, select: { id: true, versionNumber: true } });
    return [...latest, ...(current ? [current] : [])].sort((a, b) => (a.versionNumber ?? 0) - (b.versionNumber ?? 0)).map((row) => row.id);
  }

  /**
   * The Profile an id addresses, read at the version it addresses
   * (`addressed`): a Profile's own id its current version, and a version's
   * Decaid id that version, which says whether it is the current one.
   */
  async get(asked: string): Promise<ProfileView> {
    const { versionId: id, currentVersionId } = await this.addressed(asked);
    const profile = await this.prisma.profile.findUnique({ where: { id }, include: withPlaces });
    if (!profile) throw profileNotFound();
    const content = object(profile.content);
    const parentId = typeof content.parentId === "string" ? content.parentId : null;
    const startedFromId = profile.libraryProfile?.startedFrom?.currentVersionId ?? null;
    const [parent, startedFrom, current] = await Promise.all([
      parentId === null ? null : this.prisma.profile.findUnique({ where: { id: parentId }, select: { id: true, content: true } }),
      startedFromId === null ? null : this.prisma.profile.findUnique({ where: { id: startedFromId }, select: { id: true, content: true } }),
      currentVersionId === id ? null : this.prisma.profile.findUnique({ where: { id: currentVersionId }, select: { versionNumber: true } }),
    ]);
    const [decided, machineModel, refused] = await Promise.all([
      this.prisma.profileLocation.findMany({ where: { profileId: id }, include: { location: true } }),
      this.machineModel(profile.archived ? [] : profile.locations.map((here) => here.locationId)),
      // The refusal of each Machine's tablet, as its sharing status picks it (sharing-status.ts): a tablet it no longer has never writes again to clear its own.
      this.prisma.$queryRaw<{ machineId: string; machineName: string; error: string; refusedAt: Date }[]>`
        SELECT m.id::text AS "machineId", m.name AS "machineName", r.error, r.refused_at AS "refusedAt"
        FROM machines m
        JOIN tablet_refusals r ON r.tablet_id = COALESCE(
          CASE WHEN m.identification <> 'MISMATCH' THEN m.connected_tablet_id END,
          (SELECT tablet_id FROM machine_tablets WHERE machine_id = m.id ORDER BY last_hello DESC NULLS LAST LIMIT 1)
        )
        WHERE r.kind = 'profile' AND r.item_id = ${id} AND r.change = 'write'
        ORDER BY r.refused_at DESC, m.name`,
    ]);
    return {
      ...summary(profile, new Map(startedFrom ? [[startedFrom.id, titled(startedFrom.content).title]] : [])),
      content,
      profile: profileOf(content.profile),
      version: profile.versionNumber,
      current: { id: currentVersionId, version: currentVersionId === id ? profile.versionNumber : (current?.versionNumber ?? null) },
      parent: parent ? { id: parent.id, title: titled(parent.content).title } : null,
      locations: decided
        .map((here) => ({ location: viewLocation(here.location), shown: here.shown, since: here.decidedAt.toISOString() }))
        .sort((a, b) => a.location.name.localeCompare(b.location.name)),
      machineModel,
      refusedOn: refused.map((row) => ({ machine: { id: row.machineId, name: row.machineName }, error: row.error, refusedAt: row.refusedAt.toISOString() })),
    };
  }

  /**
   * The Profile Versions (ADR-0038) of the Profile an id addresses, its own
   * or any of its versions' Decaid id: every `profiles` row placed in it,
   * the latest to join first, each with its number, whether it is current,
   * who saved it, where it is shown and how many Shots are on it; and the
   * Machines on an earlier version (`ProfileVersionsView.earlierOn`). A row
   * not yet placed, and each of Decaid's bundled Profiles, is itself alone.
   * 404 for no such Profile.
   */
  async versions(asked: string, scope: Scope): Promise<ProfileVersionsView> {
    const { profileId, currentVersionId } = await this.addressed(asked);
    const ids = await this.versionIds(asked);
    const [profiles, firsts, shots, earlierOn] = await Promise.all([
      this.prisma.profile.findMany({ where: { id: { in: ids } }, include: withPlaces }),
      this.prisma.itemVersion.findMany({
        where: { kind: "profile", itemId: { in: ids } },
        distinct: ["itemId"],
        orderBy: [{ itemId: "asc" }, { receivedAt: "asc" }, { seq: "asc" }],
        include: withSource,
      }),
      Promise.all(ids.map((id) => this.shotCount(id))),
      this.earlierOn(profileId, currentVersionId),
    ]);
    const among = new Set(ids);
    const firstOf = new Map(firsts.map((version) => [version.itemId, version]));
    const shotsOf = new Map(ids.map((id, index) => [id, shots[index]!]));
    const versions = profiles
      .map((profile): ProfileVersionView => {
        const parentId = object(profile.content).parentId;
        const first = firstOf.get(profile.id);
        const { shownAt, title, bundled, archived } = summary(profile, new Map());
        return {
          id: profile.id,
          number: profile.versionNumber,
          current: profile.id === currentVersionId,
          title,
          bundled,
          archived,
          parentId: typeof parentId === "string" && parentId !== profile.id && among.has(parentId) ? parentId : null,
          savedAt: (first?.editedAt ?? profile.createdAt).toISOString(),
          savedBy: first ? viewSource(first, scope) : null,
          shownAt,
          shots: shotsOf.get(profile.id) ?? 0,
        };
      })
      .sort((a, b) => (b.number ?? 0) - (a.number ?? 0) || a.id.localeCompare(b.id));
    return { profile: { profileId, currentVersionId }, versions, earlierOn };
  }

  /**
   * The rows linked to one by Decaid's `parentId`, whatever Profiles they
   * are placed in: up to the first, whose link names no row in the Library
   * or one of Decaid's bundled Profiles, and down through every row saved
   * from one of them, a fork's branches both; a bundled row's are itself
   * alone. Publishing a new version and returning to one still act on these
   * (ADR-0032), one version at a time, until they act on the Profile
   * (ADR-0038): the titles a new version may share, and the versions a
   * Profile may return to. 404 for no such row.
   */
  async lineage(id: string): Promise<{ id: string; title: string | null; bundled: boolean; parentId: string | null }[]> {
    const found = await this.prisma.profile.findUnique({ where: { id }, select: { bundled: true } });
    if (!found) throw profileNotFound();
    // UNION ALL to a depth, so a loop of links, which Decaid's hash makes all but impossible, ends; then UNION in the walk down.
    const chain = found.bundled
      ? [{ id }]
      : await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE up AS (
        SELECT id, content ->> 'parentId' AS parent, bundled, 0 AS depth FROM profiles WHERE id = ${id}
        UNION ALL
        SELECT p.id, p.content ->> 'parentId', p.bundled, up.depth + 1 FROM profiles p JOIN up ON p.id = up.parent
        WHERE NOT up.bundled AND up.depth < ${MAX_PROFILE_VERSIONS}
      ), top AS (
        SELECT id, bundled, depth FROM up ORDER BY depth DESC LIMIT 1
      ), first AS (
        SELECT coalesce((SELECT up.id FROM up, top WHERE top.bundled AND up.depth = top.depth - 1 LIMIT 1), (SELECT id FROM top)) AS id
      ), down AS (
        SELECT id FROM first
        UNION
        SELECT p.id FROM profiles p JOIN down ON p.content ->> 'parentId' = down.id WHERE NOT p.bundled
      )
      SELECT id FROM (SELECT id FROM down LIMIT ${MAX_PROFILE_VERSIONS}) AS saved
      UNION
      SELECT id FROM top WHERE bundled`;
    const ids = new Set(chain.map((row) => row.id));
    const rows = await this.prisma.profile.findMany({ where: { id: { in: [...ids] } }, select: { id: true, content: true, bundled: true } });
    return rows.map((row) => {
      const parentId = object(row.content).parentId;
      return { id: row.id, title: titled(row.content).title, bundled: row.bundled, parentId: typeof parentId === "string" && parentId !== row.id && ids.has(parentId) ? parentId : null };
    });
  }

  /**
   * The Machines whose current Workflow, the latest stored for each, holds
   * the steps of a version of the Profile other than its current one, found
   * as a Shot's Profile is (`profileOfSql`), while they have no Loaded
   * Recipe (ADR-0022): by the Machine's name. None for a row not yet placed.
   */
  private async earlierOn(profileId: string | null, currentVersionId: string): Promise<EarlierOnView[]> {
    if (profileId === null) return [];
    const rows = await this.prisma.$queryRaw<{ id: string; name: string; versionId: string; number: number | null }[]>`
      SELECT m.id::text AS id, m.name, v.id AS "versionId", v.version_number AS number
      FROM machines m
      JOIN LATERAL (SELECT workflow FROM workflow_events WHERE machine_id = m.id ORDER BY id DESC LIMIT 1) AS latest ON true
      JOIN profiles v ON v.id = ${profileOfSql(Prisma.sql`(latest.workflow -> 'profile')`)}
      WHERE v.library_profile_id = ${profileId}::uuid AND v.id <> ${currentVersionId}
        AND NOT EXISTS (SELECT 1 FROM loaded_recipes l WHERE l.machine_id = m.id AND l.unloaded_at IS NULL)
      ORDER BY m.name, m.id`;
    return rows.map((row) => ({ machine: { id: row.id, name: row.name }, version: { id: row.versionId, number: row.number } }));
  }

  /** How many Shots the Shots list lists on the Profile (`shotPulledWithSql`). */
  private async shotCount(profileId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM shots s WHERE ${shotListedSql("s")} AND ${shotPulledWithSql("s", profileId)}`;
    return row?.count ?? 0;
  }

  /** The models the account has Machines of (`accountModels`), which a Profile's checks hold it to the widest ranges of (#588). */
  async accountModels(): Promise<MachineModel[]> {
    return accountModels(this.prisma);
  }

  /** The model a Profile shown at these Locations is simulated as (`ProfileView.machineModel`): of the Machines there now, by their latest Location History entry. */
  private async machineModel(locationIds: readonly string[]): Promise<MachineModel> {
    if (locationIds.length === 0) return "DE1";
    const machines = await this.prisma.$queryRaw<{ model: string | null }[]>`
      SELECT m.model FROM machines m
      JOIN LATERAL (SELECT location_id FROM location_assignments WHERE machine_id = m.id ORDER BY effective_from DESC LIMIT 1) AS here ON true
      WHERE here.location_id = ANY(${[...locationIds]}::uuid[])`;
    return machines.length > 0 && machines.every((machine) => machineModelOf(machine.model) === "Bengle") ? "Bengle" : "DE1";
  }
}

/** A Profile id from a path: the Profile's own, a UUID, or Decaid's of one of its versions, such as profile:3c5e9f0a1b2c4d6e8f70 (`ProfilesService.addressed`). */
export function readProfileId(id: string): string {
  if (!isRecordId(id)) throw profileNotFound();
  return id;
}

function profileNotFound(): NotFoundException {
  return new NotFoundException("No such Profile");
}

/** A row as a list has it, with the title of the Profile its own was started from, by that one's current version's Decaid id. */
function summary(profile: ListedProfile, titles: ReadonlyMap<string, string | null>): ProfileSummary {
  const from = profile.libraryProfile?.startedFrom ?? null;
  return {
    id: profile.id,
    profileId: profile.libraryProfile?.id ?? null,
    versions: profile.libraryProfile?._count.versions ?? 1,
    startedFrom: from ? { profileId: from.id, id: from.currentVersionId, title: titles.get(from.currentVersionId) ?? null } : null,
    ...titled(profile.content),
    bundled: profile.bundled,
    archived: profile.archived,
    shownAt: profile.archived
      ? []
      : profile.locations
          .map((here) => ({ location: viewLocation(here.location), since: here.decidedAt.toISOString() }))
          .sort((a, b) => a.location.name.localeCompare(b.location.name)),
    createdAt: profile.createdAt.toISOString(),
    createdLocation: profile.createdLocation ? viewLocation(profile.createdLocation) : null,
  };
}

/** The title, author and beverage type a Profile's content names, as Decaid reads them: its title and author whatever its steps hold, each null where it has none. */
function titled(content: Prisma.JsonValue): Pick<ProfileSummary, "title" | "author" | "beverageType"> {
  const raw = object(content).profile;
  const { title, author } = profileTextOf(raw);
  return { title: title || null, author: author || null, beverageType: profileOf(raw)?.beverage_type ?? null };
}

function object(value: Prisma.JsonValue | undefined): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
