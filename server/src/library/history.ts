import type { LibraryKind } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { ReportingTablet } from "./intake.js";

// Each Library item's versions and Conflicts (ADR-0020). Every accepted edit
// is kept as a version: the fields it set, with their values, the Machine and
// tablet or the account it came from, when it was made and when the server
// took it in. An edit of a Location's state of the item names that Location.
// An edit that lost to another of the same field made without seeing it, or
// that such an edit replaced, is kept as a Conflict, open until someone uses
// its value or dismisses it (ticket #85).

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

/** The field naming each kind of item in a version or Conflict. */
const ITEM_FIELDS = { bean: "beanId", beanBatch: "batchId", grinder: "grinderId", profile: "profileId" } as const satisfies Record<LibraryKind, string>;

/** The item's field of a version or Conflict, set to its id. */
function itemField(item: ItemRef): { beanId: string } | { batchId: string } | { grinderId: string } | { profileId: string } {
  return { [ITEM_FIELDS[item.kind]]: item.id } as { beanId: string };
}

/** A value as a version or Conflict keeps it: null where the edit cleared the field. */
function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Keeps an accepted edit as a version of the item: `fields`, each with the
 * value it set, of its content, or of its state at `locationId`. Returns the
 * version's id.
 */
export async function recordVersion(
  tx: Prisma.TransactionClient,
  item: ItemRef,
  locationId: string | null,
  fields: Readonly<Record<string, unknown>>,
  source: EditSource,
  editedAt: Date,
): Promise<string> {
  const version = await tx.itemVersion.create({
    data: { ...itemField(item), locationId, fields: fields as Prisma.InputJsonObject, ...source, editedAt },
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
  await tx.conflict.create({ data: { ...itemField(item), locationId, field, value: jsonValue(value), ...source, editedAt } });
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
