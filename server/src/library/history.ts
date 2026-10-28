import type { LibraryKind } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { ReportingTablet } from "./intake.js";
import { KINDS } from "./kinds.js";

// Each Library item's versions and Conflicts (ADR-0020). Every accepted edit
// is kept as a version: the fields it set, with their values, the Machine and
// tablet or the account it came from, when it was made and when the server
// took it in. An edit of a Location's state of the item names that Location.
// An edit that lost to another of the same field made without seeing it, or
// that such an edit replaced, is kept as a Conflict, open until someone uses
// its value, which makes it a new edit, or dismisses it (conflicts.service.ts).

/** A Library item: its kind, and its global id, or a Profile's id. */
export interface ItemRef {
  kind: LibraryKind;
  id: string;
}

/** Where an edit came from: a Machine's tablet, or an account in the management interface. */
export interface EditSource {
  machineId: string | null;
  tabletId: string | null;
  accountId: string | null;
}

/** An edit made on a tablet, which its report or answer brought. */
export function tabletSource(tablet: ReportingTablet): EditSource {
  return { machineId: tablet.machineId, tabletId: tablet.tabletId, accountId: null };
}

/** An edit made in the management interface by the account. */
export function accountSource(accountId: string): EditSource {
  return { machineId: null, tabletId: null, accountId };
}

/**
 * The item's kind and id as a version or Conflict names it (`VersionedItem`
 * in the schema): an id of UUIDs in lower case, as PostgreSQL writes it.
 */
export function itemKey(item: ItemRef): { kind: LibraryKind; itemId: string } {
  return { kind: item.kind, itemId: KINDS[item.kind].idType === "uuid" ? item.id.toLowerCase() : item.id };
}

/** A value as a version or Conflict keeps it: null where the edit cleared the field. */
function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/** The item a copy was copied from (ticket #144), by its id, and its Location then. */
export interface CopiedFrom {
  id: string;
  locationId: string | null;
}

/**
 * Keeps an accepted edit as a version of the item: `fields`, each with the
 * value it set, of its content, or of its state at `locationId`; a copy's
 * first version names the item it was copied from. Returns the version's id.
 */
export async function recordVersion(
  tx: Prisma.TransactionClient,
  item: ItemRef,
  locationId: string | null,
  fields: Readonly<Record<string, unknown>>,
  source: EditSource,
  editedAt: Date,
  copiedFrom?: CopiedFrom,
): Promise<string> {
  const version = await tx.itemVersion.create({
    data: {
      ...itemKey(item),
      locationId,
      fields: fields as Prisma.InputJsonObject,
      ...source,
      editedAt,
      ...(copiedFrom ? { copiedFromId: copiedFrom.id, copiedFromLocationId: copiedFrom.locationId } : {}),
    },
    select: { id: true },
  });
  return version.id;
}

/** Keeps an edit's value of one field that lost to a later edit its maker had not seen as a Conflict. */
export async function recordConflict(
  tx: Prisma.TransactionClient,
  item: ItemRef,
  locationId: string | null,
  field: string,
  value: unknown,
  source: EditSource,
  editedAt: Date,
): Promise<void> {
  await tx.conflict.create({ data: { ...itemKey(item), locationId, field, value: jsonValue(value), ...source, editedAt } });
}

/**
 * Keeps a value an edit replaced, which version `versionId` had set without
 * seeing that edit, as a Conflict, from where and when that version came.
 * Nothing is kept if the version is not known.
 */
export async function recordReplaced(
  tx: Prisma.TransactionClient,
  item: ItemRef,
  locationId: string | null,
  field: string,
  value: unknown,
  versionId: string | null,
): Promise<void> {
  if (versionId === null) return;
  const version = await tx.itemVersion.findUnique({ where: { id: versionId }, select: { machineId: true, tabletId: true, accountId: true, editedAt: true } });
  if (!version) return;
  const { editedAt, ...source } = version;
  await recordConflict(tx, item, locationId, field, value, source, editedAt);
}
