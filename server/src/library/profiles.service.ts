import { Injectable, NotFoundException } from "@nestjs/common";
import { isRecordId } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";

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
  /** The Locations showing it (ADR-0008), by name, each since it was last shown there. None while it is Archived. */
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
  /** The Profile it was saved from, as Streamline saves one whose steps changed, if the Library has it. */
  parent: { id: string; title: string | null } | null;
}

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
    return { ...summary(profile), content, parent: parent ? { id: parent.id, title: titled(parent.content).title } : null };
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
          .map((here) => ({ location: viewLocation(here.location), since: here.changedAt.toISOString() }))
          .sort((a, b) => a.location.name.localeCompare(b.location.name)),
    createdAt: profile.createdAt.toISOString(),
    createdLocation: profile.createdLocation ? viewLocation(profile.createdLocation) : null,
  };
}

/** The title, author and beverage type a Profile's content names. */
function titled(content: Prisma.JsonValue): Pick<ProfileSummary, "title" | "author" | "beverageType"> {
  const profile = object(object(content).profile as Prisma.JsonValue);
  return { title: text(profile.title), author: text(profile.author), beverageType: text(profile.beverage_type) };
}

function object(value: Prisma.JsonValue | undefined): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
