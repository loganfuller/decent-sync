import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { type LibraryKind, SETTINGS_KIND, type VersionedKind, isLibraryKind } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { mayResolve } from "./conflict-access.js";
import { editContent, lockItems } from "./content-edits.js";
import { type ConflictView, HistoryService } from "./history.service.js";
import { type EditSource, type LibraryItemRef, accountSource } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { editSettings, lockSettings } from "./location-settings.js";
import { KINDS, idSql, isVersionedKind } from "./kinds.js";
import { lockLocation } from "./location-state.js";

// Resolving a Conflict (ADR-0020): using its value, which makes it a new edit
// in the management interface, timed by PostgreSQL's clock (ADR-0016), and
// written to every tablet that holds the item; or dismissing it, which
// changes nothing else. Either closes it, under its row lock, so it is
// resolved once, on any instance. A value is used only over the value the
// account was shown as the field's value now, named by the version that set
// it, so an edit decided since is never replaced unseen. Using a value takes the Location's lock,
// for a Location's state or a Grinder, then the item's, as a tablet's edit
// does after its own locks; a tablet's report never locks a Conflict, so
// neither waits on the other in turn.

/** A Conflict as resolving it reads it, under its row lock. */
interface LockedConflict {
  state: "OPEN" | "USED" | "DISMISSED";
  kind: string;
  itemId: string;
  field: string;
  value: unknown;
  locationId: string | null;
}

/** Uses Conflicts' values and dismisses them, for Admins and for Staff on items they can edit. */
@Injectable()
export class ConflictsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: HistoryService,
  ) {}

  /**
   * Uses the Conflict's value: it becomes the field's latest edit, made by
   * the account over the field's value now, which it was shown, set by
   * version `seen` (null if none is known), so it applies whatever the times
   * of the edits before it, and is written to every tablet that holds the
   * item. The Conflict is closed as used. 409 if the field was decided
   * since, as by a tablet's edit, which the account has not seen.
   */
  async use(id: string, seen: string | null, accountId: string, scope: Scope): Promise<ConflictView> {
    await this.prisma.$transaction(async (tx) => {
      const conflict = await this.lockOpen(tx, readConflictId(id), scope);
      await useValue(tx, conflict, seen, accountSource(accountId));
      await tx.$executeRaw`UPDATE conflicts SET state = 'USED' WHERE id = ${id}::uuid`;
    }, INTAKE_TRANSACTION);
    return this.history.conflict(id, scope);
  }

  /** Dismisses the Conflict, closing it with nothing else changed. */
  async dismiss(id: string, scope: Scope): Promise<ConflictView> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpen(tx, readConflictId(id), scope);
      await tx.$executeRaw`UPDATE conflicts SET state = 'DISMISSED' WHERE id = ${id}::uuid`;
    }, INTAKE_TRANSACTION);
    return this.history.conflict(id, scope);
  }

  /**
   * The open Conflict, under its row lock: 404 if there is none, 403 if the
   * account may not resolve it, 409 if it is closed already. With the
   * Location its item belongs to, for a kind whose items belong to one
   * (`belongsToLocation`): a Grinder's Location never changes.
   */
  private async lockOpen(tx: Prisma.TransactionClient, id: string, scope: Scope): Promise<LockedConflict & { kind: VersionedKind; itemLocationId?: string | null }> {
    const [conflict] = await tx.$queryRaw<LockedConflict[]>`
      SELECT state::text AS state, kind, item_id AS "itemId", field, value, location_id AS "locationId"
      FROM conflicts WHERE id = ${id}::uuid
      FOR UPDATE`;
    if (!conflict || !isVersionedKind(conflict.kind)) throw new NotFoundException("No such Conflict");
    const kind = conflict.kind;
    const itemLocationId = isLibraryKind(kind) && KINDS[kind].belongsToLocation ? await itemLocation(tx, kind, conflict.itemId) : undefined;
    if (!mayResolve(scope, { locationId: conflict.locationId, field: conflict.field, itemLocationId })) {
      throw new ForbiddenException("Staff resolve Conflicts about a Location's state or a Grinder only at their own Locations");
    }
    if (conflict.state !== "OPEN") throw new ConflictException(`This Conflict was ${conflict.state === "USED" ? "used" : "dismissed"} already`);
    return { ...conflict, kind, itemLocationId };
  }
}

/** The Location an item of a kind that belongs to one belongs to, null if it has none or no longer exists. */
async function itemLocation(tx: Prisma.TransactionClient, kind: LibraryKind, id: string): Promise<string | null> {
  const description = KINDS[kind];
  const [row] = await tx.$queryRaw<{ locationId: string | null }[]>`
    SELECT location_id AS "locationId" FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, id)}`;
  return row?.locationId ?? null;
}

/**
 * Makes the Conflict's value the field's latest edit, by `source`, over the
 * value version `seen` set, and tells every instance its tablets are to be
 * written.
 */
async function useValue(
  tx: Prisma.TransactionClient,
  conflict: LockedConflict & { kind: VersionedKind; itemLocationId?: string | null },
  seen: string | null,
  source: EditSource,
): Promise<void> {
  const { field, value, locationId } = conflict;
  // Timed by PostgreSQL's clock (ADR-0016), as the version's `received_at` is, to the millisecond it keeps.
  const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT now()::timestamptz(3) AS at`;
  if (conflict.kind === SETTINGS_KIND) {
    // A Location's settings are edited under their own row lock, as a tablet's edits of them are.
    const settings = await lockSettings(tx, conflict.itemId);
    if (!settings) throw new NotFoundException("No such Conflict");
    checkSeen(Object.prototype.hasOwnProperty.call(settings.fieldEdits, field) ? settings.fieldEdits[field]!.versionId : null, seen);
    const edited = await editSettings(tx, settings.id, { values: { [field]: value ?? null }, at, seenAt: "everything" }, source);
    if (edited.writesDue) await notify(tx, "library_changes", settings.locationId);
    return;
  }
  const item: LibraryItemRef = { kind: conflict.kind, id: conflict.itemId };
  const description = KINDS[item.kind];
  const state = locationId === null ? undefined : description.state;
  if (state === undefined) {
    // The Archived state of an item that belongs to a Location changes only under that Location's lock, which never changes.
    if (conflict.itemLocationId !== undefined && conflict.itemLocationId !== null) await lockLocation(tx, conflict.itemLocationId);
    await lockItems(tx, item.kind, [item.id]);
    const [row] = await tx.$queryRaw<{ versionId: string | null }[]>`
      SELECT field_edits -> ${field} ->> 'versionId' AS "versionId" FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, item.id)}`;
    checkSeen(row?.versionId ?? null, seen);
    const edited = await editContent(tx, item, { values: { [field]: value ?? null }, at, seenAt: "everything" }, source);
    // Every Location's tablets may hold the item; each writer reads what its tablet is due.
    if (edited.writesDue) await notify(tx, "library_changes", item.id);
    return;
  }
  await lockLocation(tx, locationId!);
  const [current] = await state.current(tx, [{ itemId: item.id, locationId: locationId!, field }]);
  checkSeen(current!.versionId, seen);
  // Under the Location's lock, every decision of its state was made before now, and the account was shown the latest.
  const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
  // Conflicts of a Location's state are only ever about values its fields take.
  await state.use(tx, item.id, locationId!, field, value, at, seenAt, source);
  await notify(tx, "library_changes", locationId!);
}

/** Refuses to use a value over one the account was not shown: the field was decided since. */
function checkSeen(versionId: string | null, seen: string | null): void {
  if (versionId !== seen) {
    throw new ConflictException("The field has changed since this Conflict was shown. Look at its value now before using this one.");
  }
}

/** What a request to use a Conflict's value names: the version of the field's value now that the account was shown (`current.versionId`), or null. */
export function readSeen(body: unknown): string | null {
  const seen = typeof body === "object" && body !== null ? (body as { seen?: unknown }).seen : undefined;
  if (seen === null) return null;
  // PostgreSQL returns ids in lower case.
  if (typeof seen === "string" && UUID.test(seen)) return seen.toLowerCase();
  throw new BadRequestException("Name the version of the field's value now that you were shown (seen), or null if it has none");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readConflictId(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException("No such Conflict");
  return id;
}
