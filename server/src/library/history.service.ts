import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Scope } from "../accounts/scope.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { queryValue } from "../record-filters.js";
import { type ItemRef, itemKey } from "./history.js";
import { KINDS, type VersionedItem } from "./kinds.js";
import { isObject } from "./listed.js";

/**
 * Where a version or a Lost Edit came from: a Machine's tablet, or an account
 * in the management interface or through a Connected App (ADR-0026). An
 * account is named to Admins; to Staff by its id only, as other accounts'
 * names are personal information that Staff do not see.
 */
export interface SourceView {
  /** The Machine whose tablet made it, if one did and it still exists. */
  machine: { id: string; name: string } | null;
  /** That tablet's id. */
  tabletId: string | null;
  /** The account that made it here; its name null but to Admins. */
  account: { id: string; name: string | null } | null;
  /**
   * The Connected App the account made it through, by the name its app gave
   * and the host of its client id as it was approved; null for the
   * management interface.
   */
  connectedApp: { id: string; name: string; host: string } | null;
}

/** One accepted edit of a Library item, as the REST API returns it. */
export interface VersionView {
  id: string;
  /**
   * The fields it set, each with its value: of the item's content, by
   * Decaid's names, or of its state at `location` (`atLocation`,
   * `remainingWeight`, `shown`). The first version is the item joining the
   * Library. A Batch Move's are what it set at the Location joined, with
   * the move itself (`movedFrom`, the id of the Location left,
   * `movedAmount` and `movedAll`), which `move` reads out.
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
  /**
   * For a Batch Move (ADR-0037), one entry of the batch's history: the
   * Location it left and the one it joined, each null if deleted since, the
   * weight moved, in grams, null for a batch with no weight where it was,
   * and whether it was all of it, which finished it at the Location left.
   * Null for every other version.
   */
  move: { from: LocationView | null; to: LocationView | null; amount: number | null; all: boolean } | null;
}

/**
 * A Lost Edit (ADR-0033), as the REST API returns it: an edit to a field of
 * a Library item that did not apply, kept in the item's history. It is
 * read, never changed: to bring its value back, someone edits the item.
 */
export interface LostEditView {
  id: string;
  field: string;
  /** The losing value; null where the edit cleared the field. */
  value: unknown;
  /** The Location whose state of the item the field is; null for the item's content. */
  location: LocationView | null;
  /** Who or which Machine made the losing edit. */
  source: SourceView;
  /** When the losing edit was made. */
  editedAt: string;
  /** When it lost, by PostgreSQL's clock. */
  lostAt: string;
  /** The edit it lost to; null where that is not known, as for one kept by the release before this one. */
  lostTo: LostToView | null;
}

/** The edit a Lost Edit lost to: one of the item's versions. */
export interface LostToView {
  /** That version's id, as the item's `versions` list it. */
  versionId: string;
  /** The value it set the field to; null where it cleared it. */
  value: unknown;
  source: SourceView;
  /** When it was made. */
  editedAt: string;
}

/** An item's history: its versions and its Lost Edits. */
export interface HistoryView {
  versions: VersionView[];
  lostEdits: LostEditView[];
}

const connectedApp = { select: { id: true, name: true, clientHost: true } } as const;
export const withSource = { machine: { select: { id: true, name: true } }, account: { select: { name: true } }, connectedApp, location: true } as const;

/** The longest field name an item's history is filtered by. */
export const MAX_HISTORY_FIELD = 200;

/**
 * The field a history route's query names, `field`, to list only the
 * versions that set it, if it names one: refused given more than once, empty
 * or longer than MAX_HISTORY_FIELD.
 */
export function readHistoryField(query: Record<string, unknown>): string | undefined {
  const problems: string[] = [];
  const field = queryValue(query, "field", problems);
  if (field !== undefined && (field === "" || field.length > MAX_HISTORY_FIELD)) problems.push(`Enter field as a field's name, of 1 to ${MAX_HISTORY_FIELD} characters`);
  if (problems.length > 0) throw new BadRequestException(problems);
  return field;
}

/** Each Library item's history (ADR-0020, ADR-0033): its versions and its Lost Edits, which Staff read as Admins do. */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The item's versions, the latest taken in first, or, given a field, those
   * that set it, to a value or cleared, of its content or of its state at a
   * Location, the first, the item joining the Library, among them for each
   * field its content had then; 404 if the Library does not have it.
   */
  async versions(item: ItemRef, scope: Scope, field?: string): Promise<VersionView[]> {
    const [all, exists] = await Promise.all([
      this.prisma.itemVersion.findMany({
        where: itemKey(item),
        include: { ...withSource, copiedFromLocation: true },
        orderBy: [{ receivedAt: "desc" }, { seq: "desc" }],
      }),
      this.exists(item),
    ]);
    if (!exists) throw new NotFoundException(`No such ${KINDS[item.kind].name}`);
    const versions = field === undefined ? all : all.filter((version) => isObject(version.fields) && Object.hasOwn(version.fields, field));
    // The items copies were copied from, read as the item's kind reads them, so a copy names its original as it is named now.
    const copiedFromIds = [...new Set(versions.flatMap((version) => (version.copiedFromId === null ? [] : [version.copiedFromId])))];
    const originals = copiedFromIds.length === 0 ? new Map<string, VersionedItem>() : await KINDS[item.kind].read(this.prisma, copiedFromIds);
    // The Locations Batch Moves left, by the ids their versions name.
    const leftIds = [...new Set(versions.flatMap((version) => movedFrom(version.fields) ?? []))];
    const left = new Map((leftIds.length === 0 ? [] : await this.prisma.location.findMany({ where: { id: { in: leftIds } } })).map((location) => [location.id, viewLocation(location)]));
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
      move: moveOf(version.fields, version.location ? viewLocation(version.location) : null, left),
    }));
  }

  /** The item's history: its versions and its Lost Edits, each as `versions` and `lostEdits` read them. */
  async history(item: ItemRef, scope: Scope, field?: string): Promise<HistoryView> {
    const versions = await this.versions(item, scope, field);
    return { versions, lostEdits: await this.lostEdits(item, scope, field) };
  }

  /**
   * The item's Lost Edits, the latest lost first, or, given a field, those
   * of it, each with the edit it lost to, of the item's content or of its
   * state at a Location; 404 if the Library does not have it.
   */
  async lostEdits(item: ItemRef, scope: Scope, field?: string): Promise<LostEditView[]> {
    const [lost, exists] = await Promise.all([
      this.prisma.lostEdit.findMany({
        where: { ...itemKey(item), ...(field === undefined ? {} : { field }) },
        include: withSource,
        orderBy: [{ createdAt: "desc" }, { seq: "desc" }],
      }),
      this.exists(item),
    ]);
    if (!exists) throw new NotFoundException(`No such ${KINDS[item.kind].name}`);
    const versionIds = [...new Set(lost.flatMap((edit) => (edit.lostToVersionId === null ? [] : [edit.lostToVersionId])))];
    const versions = new Map(
      (versionIds.length === 0
        ? []
        : await this.prisma.itemVersion.findMany({
            // Only the item's own: a version of another item is not what an edit of this one lost to.
            where: { id: { in: versionIds }, ...itemKey(item) },
            select: { id: true, seq: true, locationId: true, fields: true, editedAt: true, tabletId: true, accountId: true, machine: { select: { id: true, name: true } }, account: { select: { name: true } }, connectedApp },
          })
      ).map((version) => [version.id, version]),
    );
    const lostToValues = await Promise.all(
      lost.map((edit) => {
        const version = edit.lostToVersionId === null ? undefined : versions.get(edit.lostToVersionId);
        return version === undefined ? null : this.valueAt(item, version, edit.field, edit.locationId);
      }),
    );
    return lost.map((edit, index) => {
      const version = edit.lostToVersionId === null ? undefined : versions.get(edit.lostToVersionId);
      return {
        id: edit.id,
        field: edit.field,
        value: edit.value,
        location: edit.location ? viewLocation(edit.location) : null,
        source: viewSource(edit, scope),
        editedAt: edit.editedAt.toISOString(),
        lostAt: edit.createdAt.toISOString(),
        lostTo: version
          ? {
              versionId: version.id,
              value: lostToValues[index],
              source: viewSource(version, scope),
              editedAt: version.editedAt.toISOString(),
            }
          : null,
      };
    });
  }

  /**
   * A field's value as of one of the item's versions: the value it set, or,
   * for a field it did not set, as for a Bean that lost with its batch to a
   * version setting the batch alone (`mergeEdit`'s `together`), the value
   * the latest version up to it that set the field left; null for none.
   * `locationId` is the Location of the edit that lost to it, which a Batch
   * Move's version, kept at the Location joined, may not be: at the Location
   * it left, a move of all finished the batch and left its weight at zero.
   */
  private async valueAt(item: ItemRef, version: { seq: bigint; locationId: string | null; fields: unknown }, field: string, locationId: string | null): Promise<unknown> {
    const leftByMove = locationId !== null && locationId !== version.locationId && movedFrom(version.fields) === locationId;
    if (leftByMove && isObject(version.fields) && version.fields.movedAll === true) {
      if (field === "atLocation") return false;
      if (field === "remainingWeight" && typeof version.fields.movedAmount === "number") return 0;
    }
    if (!leftByMove && isObject(version.fields) && Object.prototype.hasOwnProperty.call(version.fields, field)) return version.fields[field] ?? null;
    const at = leftByMove ? locationId : version.locationId;
    const { kind, itemId } = itemKey(item);
    const [row] = await this.prisma.$queryRaw<{ value: unknown }[]>`
      SELECT fields -> ${field} AS value FROM item_versions
      WHERE kind = ${kind} AND item_id = ${itemId} AND location_id IS NOT DISTINCT FROM ${at}::uuid
        AND seq < ${version.seq} AND fields ? ${field}
      ORDER BY seq DESC LIMIT 1`;
    return row?.value ?? null;
  }

  /** Whether the Library has the item: it keeps versions while it does (`versioned_items`). */
  private async exists(item: ItemRef): Promise<boolean> {
    return (await this.prisma.versionedItem.count({ where: itemKey(item) })) > 0;
  }
}

/** The id of the Location a Batch Move's version says it left; undefined for any other version. */
function movedFrom(fields: unknown): string | undefined {
  return isObject(fields) && typeof fields.movedFrom === "string" ? fields.movedFrom : undefined;
}

/** A Batch Move as its version holds it, with its Locations by name, the one left from those read (`left`); null for any other version. */
function moveOf(fields: unknown, to: LocationView | null, left: ReadonlyMap<string, LocationView>): VersionView["move"] {
  const from = movedFrom(fields);
  if (from === undefined || !isObject(fields)) return null;
  return { from: left.get(from) ?? null, to, amount: typeof fields.movedAmount === "number" ? fields.movedAmount : null, all: fields.movedAll === true };
}

export function viewSource(
  row: {
    machine: { id: string; name: string } | null;
    tabletId: string | null;
    accountId: string | null;
    account: { name: string } | null;
    connectedApp: { id: string; name: string; clientHost: string } | null;
  },
  scope: Scope,
): SourceView {
  const connectedApp = row.connectedApp && { id: row.connectedApp.id, name: row.connectedApp.name, host: row.connectedApp.clientHost };
  if (row.accountId === null) return { machine: row.machine, tabletId: row.tabletId, account: null, connectedApp };
  // Other accounts' names are personal information that Staff do not see.
  const name = scope.kind === "everything" ? (row.account?.name ?? null) : null;
  return { machine: row.machine, tabletId: row.tabletId, account: { id: row.accountId, name }, connectedApp };
}
