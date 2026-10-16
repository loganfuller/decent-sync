import { Injectable, NotFoundException } from "@nestjs/common";
import { type LibraryKind, isLibraryKind } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import type { ConflictState, Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { mayResolve } from "./conflict-access.js";
import { type ItemRef, itemKey } from "./history.js";
import { KINDS, type LocationStateDescription, type StateValue, type VersionedItem } from "./kinds.js";
import { isObject } from "./listed.js";

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
  /**
   * For an item copied in the management interface, as a Recipe is copied to
   * a Location (ticket #144), its first version names the item it was copied
   * from: its id, its name now (null where it has none, or the Library no
   * longer has it), and its Location when it was copied, if that still
   * exists. Null for every other version.
   */
  copiedFrom: { id: string; name: string | null; location: LocationView | null } | null;
}

/** A Library item a Conflict is about. */
export interface ConflictItemView {
  kind: LibraryKind;
  /** Its global id, or a Profile's id. */
  id: string;
  /**
   * What the management interface names it by: a Bean's roaster and name, a
   * batch's Bean and roast date, a Grinder's model, a Profile's title; null
   * where its content has none.
   */
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

/** Each Library item's history and its Conflicts (ADR-0020), which Staff read as Admins do. */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The item's versions, the latest taken in first; 404 if the Library does not have it. */
  async versions(item: ItemRef, scope: Scope): Promise<VersionView[]> {
    const [versions, exists] = await Promise.all([
      this.prisma.itemVersion.findMany({
        where: itemKey(item),
        include: { ...withSource, copiedFromLocation: true },
        orderBy: [{ receivedAt: "desc" }, { seq: "desc" }],
      }),
      this.exists(item),
    ]);
    if (!exists) throw new NotFoundException(`No such ${KINDS[item.kind].name}`);
    // The items copies were copied from, read as the item's kind reads them, so a copy names its original as it is named now.
    const copiedFromIds = [...new Set(versions.flatMap((version) => (version.copiedFromId === null ? [] : [version.copiedFromId])))];
    const originals = copiedFromIds.length === 0 ? new Map<string, VersionedItem>() : await KINDS[item.kind].read(this.prisma, copiedFromIds);
    return versions.map((version) => ({
      id: version.id,
      fields: isObject(version.fields) ? version.fields : {},
      location: version.location ? viewLocation(version.location) : null,
      source: viewSource(version, scope),
      editedAt: version.editedAt.toISOString(),
      receivedAt: version.receivedAt.toISOString(),
      copiedFrom:
        version.copiedFromId === null
          ? null
          : {
              id: version.copiedFromId,
              name: originals.get(version.copiedFromId)?.name ?? null,
              location: version.copiedFromLocation ? viewLocation(version.copiedFromLocation) : null,
            },
    }));
  }

  /** The open Conflicts, the latest first: all of them, or those about one item, 404 if the Library does not have it. */
  async openConflicts(scope: Scope, item?: ItemRef): Promise<ConflictView[]> {
    if (item && !(await this.exists(item))) throw new NotFoundException(`No such ${KINDS[item.kind].name}`);
    return this.conflicts({ state: "OPEN", ...(item ? itemKey(item) : {}) }, scope);
  }

  /** One Conflict, open or not; 404 if there is no such Conflict. */
  async conflict(id: string, scope: Scope): Promise<ConflictView> {
    const [conflict] = await this.conflicts({ id }, scope);
    if (!conflict) throw new NotFoundException("No such Conflict");
    return conflict;
  }

  private async conflicts(where: Prisma.ConflictWhereInput, scope: Scope): Promise<ConflictView[]> {
    const conflicts = (
      await this.prisma.conflict.findMany({ where, include: withSource, orderBy: [{ createdAt: "desc" }, { seq: "desc" }] })
    ).filter((conflict): conflict is typeof conflict & { kind: LibraryKind } => isLibraryKind(conflict.kind));
    const items = await readItems(this.prisma, conflicts);
    const currents = await currentValues(this.prisma, conflicts, items);
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
      const item = items.get(`${conflict.kind}:${conflict.itemId}`);
      return {
        id: conflict.id,
        item: { kind: conflict.kind, id: conflict.itemId, name: item?.name ?? null },
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
        resolvable: mayResolve(scope, { locationId: conflict.locationId, field: conflict.field, itemLocationId: item?.locationId }),
      };
    });
  }

  /** Whether the Library has the item: it keeps versions while it does (`versioned_items`). */
  private async exists(item: ItemRef): Promise<boolean> {
    return (await this.prisma.versionedItem.count({ where: itemKey(item) })) > 0;
  }
}

const STATES: Readonly<Record<ConflictState, ConflictView["state"]>> = { OPEN: "open", USED: "used", DISMISSED: "dismissed" };

/** A Conflict as its item and its field's value now are read for it. */
interface ConflictAbout {
  kind: LibraryKind;
  itemId: string;
  field: string;
  locationId: string | null;
}

/** The items the Conflicts are about, each as its kind reads it, by `kind:id`; an item the server no longer has is absent. */
async function readItems(db: PrismaService, conflicts: readonly ConflictAbout[]): Promise<Map<string, VersionedItem>> {
  const items = new Map<string, VersionedItem>();
  for (const [kind, ids] of grouped(conflicts, (conflict) => conflict.kind)) {
    const read = await KINDS[kind].read(db, [...new Set(ids.map((conflict) => conflict.itemId))]);
    for (const [id, item] of read) items.set(`${kind}:${id}`, item);
  }
  return items;
}

/**
 * Each Conflict's field's value now, and the version that set it, if one is
 * known, in order: of a Location's state of its item, for a kind that has
 * one (`LocationStateDescription`), at the Location it names; otherwise of
 * its item's content.
 */
async function currentValues(db: PrismaService, conflicts: readonly ConflictAbout[], items: ReadonlyMap<string, VersionedItem>): Promise<StateValue[]> {
  const values: StateValue[] = conflicts.map((conflict) => {
    const item = items.get(`${conflict.kind}:${conflict.itemId}`);
    const versionId = item && Object.prototype.hasOwnProperty.call(item.fieldEdits, conflict.field) ? item.fieldEdits[conflict.field]!.versionId : null;
    return { value: item?.values[conflict.field] ?? null, versionId };
  });
  const atLocations = conflicts.flatMap((conflict, index) => {
    const state = conflict.locationId === null ? undefined : versionedState(conflict.kind);
    return state ? [{ index, state, itemId: conflict.itemId, locationId: conflict.locationId!, field: conflict.field }] : [];
  });
  for (const [state, wanted] of grouped(atLocations, (conflict) => conflict.state)) {
    const current = await state.current(db, wanted);
    wanted.forEach(({ index }, at) => (values[index] = current[at]!));
  }
  return values;
}

/** A kind's Location's state, if it has one. */
function versionedState(kind: LibraryKind): LocationStateDescription | undefined {
  return KINDS[kind].state;
}

/** Values grouped by a key, in the order each key is first met. */
function grouped<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const group = groups.get(key(value));
    if (group) group.push(value);
    else groups.set(key(value), [value]);
  }
  return groups;
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
