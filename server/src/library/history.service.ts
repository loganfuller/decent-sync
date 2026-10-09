import { Injectable, NotFoundException } from "@nestjs/common";
import type { LibraryKind } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import type { BatchLocation, ConflictState, Prisma, ProfileLocation } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import type { ItemRef } from "./history.js";
import { mayResolve } from "./conflict-access.js";
import { isObject } from "./listed.js";
import { readFieldEdits } from "./merge.js";

/**
 * Where a version or a Conflict came from: a Machine's tablet, or an account
 * in the management interface. An account is named to Admins; to Staff by
 * its id only, as other accounts' names are personal information that Staff
 * do not see.
 */
export interface SourceView {
  /** The Machine whose tablet made it, if one did and it still exists. */
  machine: { id: string; name: string } | null;
  /** That tablet's id. */
  tabletId: string | null;
  /** The account that made it here; its name null but to Admins. */
  account: { id: string; name: string | null } | null;
}

/** One accepted edit of a Library item, as the REST API returns it. */
export interface VersionView {
  id: string;
  /**
   * The fields it set, each with its value: of the item's content, by
   * Decaid's names, or of its state at `location` (`atLocation`,
   * `remainingWeight`, `shown`). The first version is the item joining the
   * Library.
   */
  fields: Record<string, unknown>;
  /** The Location whose state of the item it changed; null for its content. */
  location: LocationView | null;
  source: SourceView;
  /** When it was made: a tablet's by its record's `updatedAt` in UTC; a delete on a tablet when the server learned of it. */
  editedAt: string;
  /** When the server took it in, by PostgreSQL's clock. */
  receivedAt: string;
}

/** A Library item a Conflict is about. */
export interface ConflictItemView {
  kind: LibraryKind;
  /** Its global id, or a Profile's id. */
  id: string;
  /** What the management interface names it by: a Bean's roaster and name, a batch's Bean and roast date, a Grinder's model, a Profile's title; null where its content has none. */
  name: string | null;
}

/** A Conflict, as the REST API returns it. */
export interface ConflictView {
  id: string;
  item: ConflictItemView;
  field: string;
  /** The losing value; null where the edit cleared the field. */
  value: unknown;
  /** The Location whose state of the item the field is; null for the item's content. */
  location: LocationView | null;
  source: SourceView;
  /** When the losing edit was made. */
  editedAt: string;
  /** When it became a Conflict, by PostgreSQL's clock. */
  createdAt: string;
  /** Open, or closed: its value used, which made it a new edit, or dismissed. */
  state: "open" | "used" | "dismissed";
  /** The field's value now, which the losing value lost to or was replaced by, and where and when it came from. */
  current: CurrentValueView;
  /**
   * Whether the signed-in account may use its value or dismiss it: an Admin
   * may any, and Staff one about an item's shared content anywhere, or about
   * a Location's state or a Grinder's content only at their own Locations.
   */
  resolvable: boolean;
}

/** A field's value now, and the edit that set it. */
export interface CurrentValueView {
  /** Null where nothing set it, or the edit that set it last cleared it. A batch never added at the Location is not there (false), as is a Profile its Location never decided (not shown). */
  value: unknown;
  /** Where the edit that set it came from; null if that is not known, as for a field nothing has set. */
  source: SourceView | null;
  /** When that edit was made; null if it is not known. */
  editedAt: string | null;
  /** That edit's version, which using the Conflict's value names as the value it replaces (`seen`); null if it is not known. */
  versionId: string | null;
}

const withSource = { machine: { select: { id: true, name: true } }, account: { select: { name: true } }, location: true } as const;

/** The column each kind of item is named by in a version or Conflict. */
const ITEM_WHERE: Readonly<Record<LibraryKind, (id: string) => { beanId?: string; batchId?: string; grinderId?: string; profileId?: string }>> = {
  bean: (id) => ({ beanId: id }),
  beanBatch: (id) => ({ batchId: id }),
  grinder: (id) => ({ grinderId: id }),
  profile: (id) => ({ profileId: id }),
};

const KIND_NAMES: Readonly<Record<LibraryKind, string>> = { bean: "Bean", beanBatch: "Bean Batch", grinder: "Grinder", profile: "Profile" };

/** Each Library item's history and its Conflicts (ADR-0020), which Staff read as Admins do. */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The item's versions, the latest taken in first; 404 if the Library does not have it. */
  async versions(item: ItemRef, scope: Scope): Promise<VersionView[]> {
    const [versions, exists] = await Promise.all([
      this.prisma.itemVersion.findMany({ where: ITEM_WHERE[item.kind](item.id), include: withSource, orderBy: [{ receivedAt: "desc" }, { seq: "desc" }] }),
      this.exists(item),
    ]);
    if (!exists) throw new NotFoundException(`No such ${KIND_NAMES[item.kind]}`);
    return versions.map((version) => ({
      id: version.id,
      fields: isObject(version.fields) ? version.fields : {},
      location: version.location ? viewLocation(version.location) : null,
      source: viewSource(version, scope),
      editedAt: version.editedAt.toISOString(),
      receivedAt: version.receivedAt.toISOString(),
    }));
  }

  /** The open Conflicts, the latest first: all of them, or those about one item, 404 if the Library does not have it. */
  async openConflicts(scope: Scope, item?: ItemRef): Promise<ConflictView[]> {
    if (item && !(await this.exists(item))) throw new NotFoundException(`No such ${KIND_NAMES[item.kind]}`);
    return this.conflicts({ state: "OPEN", ...(item ? ITEM_WHERE[item.kind](item.id) : {}) }, scope);
  }

  /** One Conflict, open or not; 404 if there is no such Conflict. */
  async conflict(id: string, scope: Scope): Promise<ConflictView> {
    const [conflict] = await this.conflicts({ id }, scope);
    if (!conflict) throw new NotFoundException("No such Conflict");
    return conflict;
  }

  private async conflicts(where: Prisma.ConflictWhereInput, scope: Scope): Promise<ConflictView[]> {
    const conflicts = await this.prisma.conflict.findMany({
      where,
      include: {
        ...withSource,
        bean: { select: { content: true, fieldEdits: true } },
        batch: { select: { content: true, fieldEdits: true, bean: { select: { content: true } } } },
        grinder: { select: { content: true, fieldEdits: true, archived: true, locationId: true } },
        profile: { select: { content: true, fieldEdits: true } },
      },
      orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
    });
    const states = await this.locationStates(conflicts);
    const currents = conflicts.map((conflict) => currentValue(conflict, states));
    const versionIds = [...new Set(currents.flatMap((current) => (current.versionId === null ? [] : [current.versionId])))];
    const versions = new Map(
      (
        await this.prisma.itemVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, editedAt: true, tabletId: true, accountId: true, machine: { select: { id: true, name: true } }, account: { select: { name: true } } },
        })
      ).map((version) => [version.id, version]),
    );
    return conflicts.map((conflict, index) => {
      const { value, versionId } = currents[index]!;
      const version = versionId === null ? undefined : versions.get(versionId);
      return {
        id: conflict.id,
        item: conflictItem(conflict),
        field: conflict.field,
        value: conflict.value,
        location: conflict.location ? viewLocation(conflict.location) : null,
        source: viewSource(conflict, scope),
        editedAt: conflict.editedAt.toISOString(),
        createdAt: conflict.createdAt.toISOString(),
        state: STATES[conflict.state],
        current: {
          value,
          source: version ? viewSource(version, scope) : null,
          editedAt: version ? version.editedAt.toISOString() : null,
          versionId: version ? version.id : null,
        },
        resolvable: mayResolve(scope, { locationId: conflict.locationId, field: conflict.field, grinderLocationId: conflict.grinder?.locationId }),
      };
    });
  }

  /** Each Location's state of the batches and Profiles the Conflicts about a Location's state are about. */
  private async locationStates(conflicts: { batchId: string | null; profileId: string | null; locationId: string | null }[]): Promise<LocationStates> {
    const at = conflicts.filter((conflict) => conflict.locationId !== null);
    const batches = at.flatMap(({ batchId, locationId }) => (batchId === null ? [] : [{ batchId, locationId: locationId! }]));
    const profiles = at.flatMap(({ profileId, locationId }) => (profileId === null ? [] : [{ profileId, locationId: locationId! }]));
    const [batchRows, profileRows] = await Promise.all([
      batches.length === 0 ? [] : this.prisma.batchLocation.findMany({ where: { OR: batches } }),
      profiles.length === 0 ? [] : this.prisma.profileLocation.findMany({ where: { OR: profiles } }),
    ]);
    return {
      batches: new Map(batchRows.map((row) => [`${row.batchId}/${row.locationId}`, row])),
      profiles: new Map(profileRows.map((row) => [`${row.profileId}/${row.locationId}`, row])),
    };
  }

  private async exists(item: ItemRef): Promise<boolean> {
    const where = { where: { id: item.id } };
    switch (item.kind) {
      case "bean":
        return (await this.prisma.bean.count(where)) > 0;
      case "beanBatch":
        return (await this.prisma.beanBatch.count(where)) > 0;
      case "grinder":
        return (await this.prisma.grinder.count(where)) > 0;
      case "profile":
        return (await this.prisma.profile.count(where)) > 0;
    }
  }
}

const STATES: Readonly<Record<ConflictState, ConflictView["state"]>> = { OPEN: "open", USED: "used", DISMISSED: "dismissed" };

interface LocationStates {
  batches: Map<string, BatchLocation>;
  profiles: Map<string, ProfileLocation>;
}

type EditedContent = { content: Prisma.JsonValue; fieldEdits: Prisma.JsonValue } | null;

/** A Conflict's field's value now, and the version that set it, if one is known. */
function currentValue(
  conflict: {
    field: string;
    locationId: string | null;
    beanId: string | null;
    batchId: string | null;
    grinderId: string | null;
    profileId: string | null;
    bean: EditedContent;
    batch: EditedContent;
    grinder: (EditedContent & { archived: boolean }) | null;
    profile: EditedContent;
  },
  states: LocationStates,
): { value: unknown; versionId: string | null } {
  const { field, locationId } = conflict;
  if (locationId !== null) {
    if (conflict.profileId !== null) {
      const here = states.profiles.get(`${conflict.profileId}/${locationId}`);
      return { value: here?.shown ?? false, versionId: here?.versionId ?? null };
    }
    const here = states.batches.get(`${conflict.batchId}/${locationId}`);
    if (field === "remainingWeight") return { value: here?.remainingWeight ?? null, versionId: here?.remainingWeightVersionId ?? null };
    return { value: here !== undefined && here.addedAt !== null && here.finishedAt === null, versionId: here?.presenceVersionId ?? null };
  }
  const item = conflict.bean ?? conflict.batch ?? conflict.grinder ?? conflict.profile;
  const edits = readFieldEdits(item?.fieldEdits);
  const versionId = Object.prototype.hasOwnProperty.call(edits, field) ? edits[field]!.versionId : null;
  if (conflict.grinder && field === "archived") return { value: conflict.grinder.archived, versionId };
  const content = fields(item?.content);
  const values = conflict.profile ? fields(content.profile) : content;
  return { value: values[field] ?? null, versionId };
}

function viewSource(
  row: { machine: { id: string; name: string } | null; tabletId: string | null; accountId: string | null; account: { name: string } | null },
  scope: Scope,
): SourceView {
  if (row.accountId === null) return { machine: row.machine, tabletId: row.tabletId, account: null };
  // Other accounts' names are personal information that Staff do not see.
  const name = scope.kind === "everything" ? (row.account?.name ?? null) : null;
  return { machine: row.machine, tabletId: row.tabletId, account: { id: row.accountId, name } };
}

type ItemContent = { content: Prisma.JsonValue } | null;

function conflictItem(conflict: {
  beanId: string | null;
  batchId: string | null;
  grinderId: string | null;
  profileId: string | null;
  bean: ItemContent;
  batch: { content: Prisma.JsonValue; bean: { content: Prisma.JsonValue } } | null;
  grinder: ItemContent;
  profile: ItemContent;
}): ConflictItemView {
  if (conflict.beanId !== null) {
    const bean = fields(conflict.bean?.content);
    return { kind: "bean", id: conflict.beanId, name: joined([text(bean.roaster), text(bean.name)]) };
  }
  if (conflict.batchId !== null) {
    // As the Bean Batches list names it: its Bean, and the day a barista picked as its roast date.
    const bean = text(fields(conflict.batch?.bean.content).name);
    const roastDate = text(fields(conflict.batch?.content).roastDate);
    const roasted = roastDate !== null && /^\d{4}-\d\d-\d\d/.test(roastDate) ? `roasted ${roastDate.slice(0, 10)}` : null;
    return { kind: "beanBatch", id: conflict.batchId, name: bean === null && roasted === null ? null : `${bean ?? "Unnamed Bean"}, ${roasted ?? "no roast date"}` };
  }
  if (conflict.grinderId !== null) return { kind: "grinder", id: conflict.grinderId, name: text(fields(conflict.grinder?.content).model) };
  const profile = fields(fields(conflict.profile?.content).profile);
  return { kind: "profile", id: conflict.profileId!, name: text(profile.title) };
}

function fields(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function joined(parts: (string | null)[]): string | null {
  const present = parts.filter((part) => part !== null);
  return present.length === 0 ? null : present.join(" ");
}
