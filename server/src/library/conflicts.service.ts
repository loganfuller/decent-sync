import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Scope } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { mayResolve } from "./conflict-access.js";
import { ITEM_TABLES, editContent, lockItems } from "./content-edits.js";
import { type ConflictView, HistoryService } from "./history.service.js";
import { type EditSource, type ItemRef, accountSource } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { addBatchAt, enterRemainingWeight, finishBatchAt, lockLocation, showProfileAt } from "./location-state.js";

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
  field: string;
  value: unknown;
  locationId: string | null;
  beanId: string | null;
  batchId: string | null;
  grinderId: string | null;
  profileId: string | null;
  /** The Location of the Grinder it is about, if it is about one. */
  grinderLocationId: string | null;
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

  /** The open Conflict, under its row lock: 404 if there is none, 403 if the account may not resolve it, 409 if it is closed already. */
  private async lockOpen(tx: Prisma.TransactionClient, id: string, scope: Scope): Promise<LockedConflict> {
    const [conflict] = await tx.$queryRaw<LockedConflict[]>`
      SELECT conflict.state::text AS state, conflict.field, conflict.value, conflict.location_id AS "locationId", conflict.bean_id AS "beanId",
        conflict.batch_id AS "batchId", conflict.grinder_id AS "grinderId", conflict.profile_id AS "profileId", grinder.location_id AS "grinderLocationId"
      FROM conflicts AS conflict LEFT JOIN grinders AS grinder ON grinder.id = conflict.grinder_id
      WHERE conflict.id = ${id}::uuid
      FOR UPDATE OF conflict`;
    if (!conflict) throw new NotFoundException("No such Conflict");
    const grinderLocationId = conflict.grinderId === null ? undefined : conflict.grinderLocationId;
    if (!mayResolve(scope, { locationId: conflict.locationId, field: conflict.field, grinderLocationId })) {
      throw new ForbiddenException("Staff resolve Conflicts about a Location's state or a Grinder only at their own Locations");
    }
    if (conflict.state !== "OPEN") throw new ConflictException(`This Conflict was ${conflict.state === "USED" ? "used" : "dismissed"} already`);
    return conflict;
  }
}

/**
 * Makes the Conflict's value the field's latest edit, by `source`, over the
 * value version `seen` set, and tells every instance its tablets are to be
 * written.
 */
async function useValue(tx: Prisma.TransactionClient, conflict: LockedConflict, seen: string | null, source: EditSource): Promise<void> {
  const item = itemOf(conflict);
  const { field, value, locationId } = conflict;
  // Timed by PostgreSQL's clock (ADR-0016), as the version's `received_at` is, to the millisecond it keeps.
  const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT now()::timestamptz(3) AS at`;
  if (locationId === null) {
    // A Grinder's Archived state changes only under its Location's lock. A Grinder's Location never changes.
    if (conflict.grinderLocationId !== null) await lockLocation(tx, conflict.grinderLocationId);
    await lockItems(tx, item.kind, [item.id]);
    const { table, cast } = ITEM_TABLES[item.kind];
    const [row] = await tx.$queryRaw<{ versionId: string | null }[]>`
      SELECT field_edits -> ${field} ->> 'versionId' AS "versionId" FROM ${Prisma.raw(table)} WHERE id = ${item.id}::${Prisma.raw(cast)}`;
    checkSeen(row?.versionId ?? null, seen);
    const edited = await editContent(tx, item, { values: { [field]: value ?? null }, at, seenAt: "everything" }, source);
    // Every Location's tablets may hold the item; each writer reads what its tablet is due.
    if (edited.writesDue) await notify(tx, "library_changes", item.id);
    return;
  }
  await lockLocation(tx, locationId);
  checkSeen(await stateVersion(tx, item, field, locationId), seen);
  // Under the Location's lock, every decision of its state was made before now, and the account was shown the latest.
  const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
  if (item.kind === "profile" && field === "shown" && typeof value === "boolean") {
    await showProfileAt(tx, item.id, locationId, source, value, at, seenAt);
  } else if (item.kind === "beanBatch" && field === "atLocation" && typeof value === "boolean") {
    await (value ? addBatchAt : finishBatchAt)(tx, item.id, locationId, at, seenAt, source);
  } else if (item.kind === "beanBatch" && field === "remainingWeight" && (typeof value === "number" || value === null)) {
    const [here] = await tx.$queryRaw<{ weight: number | null }[]>`
      SELECT remaining_weight AS weight FROM batch_locations WHERE batch_id = ${item.id}::uuid AND location_id = ${locationId}::uuid`;
    await enterRemainingWeight(tx, item.id, locationId, { value, had: here?.weight ?? null }, at, source);
  } else {
    // Conflicts of a Location's state are only ever about these fields.
    throw new Error(`A Conflict about ${field} at a Location cannot be used`);
  }
  await notify(tx, "library_changes", locationId);
}

/** The version that set a Location's state of the item that the field is, or null if none is known. */
async function stateVersion(tx: Prisma.TransactionClient, item: ItemRef, field: string, locationId: string): Promise<string | null> {
  if (item.kind === "profile") {
    const [here] = await tx.$queryRaw<{ versionId: string | null }[]>`
      SELECT version_id AS "versionId" FROM profile_locations WHERE profile_id = ${item.id} AND location_id = ${locationId}::uuid`;
    return here?.versionId ?? null;
  }
  const [here] = await tx.$queryRaw<{ presence: string | null; weight: string | null }[]>`
    SELECT presence_version_id AS presence, remaining_weight_version_id AS weight
    FROM batch_locations WHERE batch_id = ${item.id}::uuid AND location_id = ${locationId}::uuid`;
  return (field === "remainingWeight" ? here?.weight : here?.presence) ?? null;
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

function itemOf(conflict: LockedConflict): ItemRef {
  if (conflict.beanId !== null) return { kind: "bean", id: conflict.beanId };
  if (conflict.batchId !== null) return { kind: "beanBatch", id: conflict.batchId };
  if (conflict.grinderId !== null) return { kind: "grinder", id: conflict.grinderId };
  return { kind: "profile", id: conflict.profileId! };
}

export function readConflictId(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException("No such Conflict");
  return id;
}
