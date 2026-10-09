import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Scope } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { mayResolve } from "./conflict-access.js";
import { editContent } from "./content-edits.js";
import { type ConflictView, HistoryService } from "./history.service.js";
import { type EditSource, type ItemRef, accountSource } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { addBatchAt, enterRemainingWeight, finishBatchAt, lockLocation, showProfileAt } from "./location-state.js";

// Resolving a Conflict (ADR-0020): using its value, which makes it a new edit
// in the management interface, timed by PostgreSQL's clock (ADR-0016), and
// written to every tablet that holds the item; or dismissing it, which
// changes nothing else. Either closes it, under its row lock, so it is
// resolved once, on any instance. Using a value takes the Location's lock,
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
   * the account, which has seen the field's value now, so it applies
   * whatever the times of the edits before it, and is written to every
   * tablet that holds the item. The Conflict is closed as used.
   */
  async use(id: string, accountId: string, scope: Scope): Promise<ConflictView> {
    await this.prisma.$transaction(async (tx) => {
      const conflict = await this.lockOpen(tx, readConflictId(id), scope);
      await useValue(tx, conflict, accountSource(accountId));
      await tx.$executeRaw`UPDATE conflicts SET state = 'USED' WHERE id = ${id}::uuid`;
    }, INTAKE_TRANSACTION);
    return this.history.conflict(id, scope);
  }

  /** Dismisses the Conflict, closing it with nothing else changed. */
  async dismiss(id: string, scope: Scope): Promise<ConflictView> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpen(tx, readConflictId(id), scope);
      await tx.$executeRaw`UPDATE conflicts SET state = 'DISMISSED' WHERE id = ${id}::uuid`;
    });
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

/** Makes the Conflict's value the field's latest edit, by `source`, and tells every instance its tablets are to be written. */
async function useValue(tx: Prisma.TransactionClient, conflict: LockedConflict, source: EditSource): Promise<void> {
  const item = itemOf(conflict);
  const { field, value, locationId } = conflict;
  // Timed by PostgreSQL's clock (ADR-0016), as the version's `received_at` is, to the millisecond it keeps.
  const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT now()::timestamptz(3) AS at`;
  if (locationId === null) {
    // A Grinder's Archived state changes only under its Location's lock. A Grinder's Location never changes.
    if (conflict.grinderLocationId !== null) await lockLocation(tx, conflict.grinderLocationId);
    const edited = await editContent(tx, item, { values: { [field]: value ?? null }, at, seenAt: "everything" }, source);
    // Every Location's tablets may hold the item; each writer reads what its tablet is due.
    if (edited.writesDue) await notify(tx, "library_changes", item.id);
    return;
  }
  await lockLocation(tx, locationId);
  // Under the Location's lock, every decision of its state was made before now: the account has seen each.
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
    throw new ConflictException(`A Conflict about ${field} at a Location cannot be used`);
  }
  await notify(tx, "library_changes", locationId);
}

function itemOf(conflict: LockedConflict): ItemRef {
  if (conflict.beanId !== null) return { kind: "bean", id: conflict.beanId };
  if (conflict.batchId !== null) return { kind: "beanBatch", id: conflict.batchId };
  if (conflict.grinderId !== null) return { kind: "grinder", id: conflict.grinderId };
  return { kind: "profile", id: conflict.profileId! };
}

export function readConflictId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException("No such Conflict");
  return id;
}
