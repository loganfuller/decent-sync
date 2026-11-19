import { Injectable, NotFoundException } from "@nestjs/common";
import { type MachineModel, type Profile, isRecordId, machineModelOf, profileOf, profileTextOf } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { shotListedSql, shotPulledWithSql } from "../shots/links.js";
import { type SourceView, viewSource, withSource } from "./history.service.js";
import { accountModels } from "./profile-reach.js";

/** A Profile as the REST API lists it. */
export interface ProfileSummary {
  /** Decaid's id, a hash of what the machine executes, the same on every tablet. */
  id: string;
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
}

/**
 * One of a Profile's Profile Versions: a Profile in the chain of Decaid's
 * `parentId` links through it, as the REST API returns one.
 */
export interface ProfileVersionView {
  id: string;
  title: string | null;
  bundled: boolean;
  archived: boolean;
  /** The Profile it was saved from, where that is in the chain; null for the first. */
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

/** The most Profiles a chain of versions is read to, which no real chain comes near. */
export const MAX_PROFILE_VERSIONS = 200;

const withPlaces = {
  createdLocation: true,
  locations: { where: { shown: true }, include: { location: true } },
} as const satisfies Prisma.ProfileInclude;

type ListedProfile = Prisma.ProfileGetPayload<{ include: typeof withPlaces }>;

/** The Library's Profiles, which Staff read as Admins do. Profiles join it from tablets (`library/profiles.ts`). */
@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every Profile, by title, ignoring case. */
  async list(): Promise<ProfileSummary[]> {
    return (await this.prisma.profile.findMany({ include: withPlaces })).map(summary).sort((a, b) => compareText(a.title, b.title) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<ProfileView> {
    const profile = await this.prisma.profile.findUnique({ where: { id }, include: withPlaces });
    if (!profile) throw profileNotFound();
    const content = object(profile.content);
    const parentId = typeof content.parentId === "string" ? content.parentId : null;
    const parent = parentId === null ? null : await this.prisma.profile.findUnique({ where: { id: parentId }, select: { id: true, content: true } });
    const [decided, machineModel] = await Promise.all([
      this.prisma.profileLocation.findMany({ where: { profileId: id }, include: { location: true } }),
      this.machineModel(profile.archived ? [] : profile.locations.map((here) => here.locationId)),
    ]);
    return {
      ...summary(profile),
      content,
      profile: profileOf(content.profile),
      parent: parent ? { id: parent.id, title: titled(parent.content).title } : null,
      locations: decided
        .map((here) => ({ location: viewLocation(here.location), shown: here.shown, since: here.decidedAt.toISOString() }))
        .sort((a, b) => a.location.name.localeCompare(b.location.name)),
      machineModel,
    };
  }

  /**
   * Its Profile Versions (ADR-0032): every Profile in the chain of `parentId`
   * links through it, up to the first, whose link names no Profile in the
   * Library or one of Decaid's bundled Profiles, and down through every
   * Profile saved from one in the chain, so a fork's branches both; the
   * latest saved first. A bundled Profile the first was saved from is listed
   * as where it was, but not walked down through, so Profiles saved from it
   * apart, as at two Locations, are not each other's versions; and a bundled
   * Profile's own are itself alone. 404 for no such Profile.
   */
  async versions(id: string, scope: Scope): Promise<ProfileVersionView[]> {
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
    const ids = chain.map((row) => row.id);
    const [profiles, firsts, shots] = await Promise.all([
      this.prisma.profile.findMany({ where: { id: { in: ids } }, include: withPlaces }),
      this.prisma.itemVersion.findMany({
        where: { kind: "profile", itemId: { in: ids } },
        distinct: ["itemId"],
        orderBy: [{ itemId: "asc" }, { receivedAt: "asc" }, { seq: "asc" }],
        include: withSource,
      }),
      Promise.all(ids.map((profileId) => this.shotCount(profileId))),
    ]);
    const inChain = new Set(ids);
    const firstOf = new Map(firsts.map((version) => [version.itemId, version]));
    const shotsOf = new Map(ids.map((profileId, index) => [profileId, shots[index]!]));
    return profiles
      .map((profile): ProfileVersionView => {
        const parentId = object(profile.content).parentId;
        const first = firstOf.get(profile.id);
        const { shownAt, title, bundled, archived } = summary(profile);
        return {
          id: profile.id,
          title,
          bundled,
          archived,
          parentId: typeof parentId === "string" && parentId !== profile.id && inChain.has(parentId) ? parentId : null,
          savedAt: (first?.editedAt ?? profile.createdAt).toISOString(),
          savedBy: first ? viewSource(first, scope) : null,
          shownAt,
          shots: shotsOf.get(profile.id) ?? 0,
        };
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
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

/** A Profile id from a path: Decaid's, such as profile:3c5e9f0a1b2c4d6e8f70. */
export function readProfileId(id: string): string {
  if (!isRecordId(id)) throw profileNotFound();
  return id;
}

function profileNotFound(): NotFoundException {
  return new NotFoundException("No such Profile");
}

function summary(profile: ListedProfile): ProfileSummary {
  return {
    id: profile.id,
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
