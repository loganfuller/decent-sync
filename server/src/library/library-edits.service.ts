import { beanMatchKey } from "@decent-sync/protocol";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { type Scope, includesLocation } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { lockBeanMatching } from "./beans.js";
import { editContent, lockItems, recordJoined } from "./content-edits.js";
import { type EditSource, type LibraryItemRef, accountSource, recordVersion } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { addBatchAt, enterRemainingWeight, finishBatchAt, lockLocation } from "./location-state.js";

// Creating and editing Beans, Bean Batches and Grinders in the management
// interface, Archiving and restoring them, and adding and finishing batches
// at Locations with their remaining weight there (ticket #87). Each is an
// edit by the account, timed by PostgreSQL's clock (ADR-0016), made over the
// item as it stands, as using a Conflict's value is (ADR-0020): it decides
// every field it sets whatever the times of the edits before it, and keeps
// nothing it replaces as a Conflict. A tablet's edit made before it that
// arrives later loses to it. Each change commits with a `NOTIFY` on
// `library_changes`, so every tablet that holds the item, or whose Location
// offers it now, is written it.
//
// Locks are taken as a tablet's edits take them, after its own: a Location's
// lock before an item's, and new or Archived Beans under the lock beans are
// matched under, so a tablet never links a new bean to a Bean Archived at
// once, and two Beans of one roaster and name are never created at once.
//
// Staff edit the Library's shared content anywhere (a Bean's, and a batch's
// details) and Archive and restore items, but add and finish batches, set
// their remaining weight, and create and edit Grinders only at their own
// Locations, as a Grinder belongs to one.

/** A batch at a Location as a request sets it: whether it is there, and its remaining weight there, null to clear it. */
export interface BatchPlacement {
  atLocation?: boolean;
  remainingWeight?: number | null;
}

@Injectable()
export class LibraryEditsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a Bean with the content, offered nowhere until one of its
   * batches is added somewhere. 409, naming the Bean, if the Library has
   * one of the same roaster and name already, Archived or not: a Bean is
   * identified by them.
   */
  async createBean(content: Record<string, unknown>, accountId: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await lockBeanMatching(tx);
      const matchKey = beanMatchKey(String(content.roaster), String(content.name));
      const existing = await tx.bean.findFirst({ where: { matchKey }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, content: true } });
      if (existing) {
        const named = existing.content as { roaster?: unknown; name?: unknown };
        throw new ConflictException({
          statusCode: 409,
          error: "Conflict",
          message: "The Library has a Bean of this roaster and name already",
          existing: { id: existing.id, roaster: typeof named.roaster === "string" ? named.roaster : null, name: typeof named.name === "string" ? named.name : null },
        });
      }
      const created = await tx.bean.create({ data: { content: content as Prisma.InputJsonObject, matchKey }, select: { id: true } });
      await recordJoined(tx, { kind: "bean", id: created.id }, content, await editTime(tx), accountSource(accountId));
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /** Edits a Bean's content, anywhere. */
  async editBean(id: string, values: Record<string, unknown>, accountId: string): Promise<void> {
    await this.editShared({ kind: "bean", id }, values, accountId, null);
  }

  /** Archives a Bean, so it and its batches are offered nowhere, or restores it, offered where it was. */
  async archiveBean(id: string, archived: boolean, accountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBeanMatching(tx);
      await lockItems(tx, "bean", [id]);
      const changed = await tx.bean.updateMany({ where: { id, archived: !archived }, data: { archived } });
      if (changed.count === 0) return void (await found(tx, "bean", id));
      await recordVersion(tx, { kind: "bean", id }, null, { archived }, accountSource(accountId), await editTime(tx));
      await notify(tx, "library_changes", id);
    }, INTAKE_TRANSACTION);
  }

  /**
   * Creates a batch of the Bean, added at each of the Locations, each with
   * its remaining weight there if one is given. 404 if there is no such
   * Bean or Location, 409 if the Bean is Archived, 403 for Staff at a
   * Location they do not work at.
   */
  async createBatch(
    beanId: string,
    content: Record<string, unknown>,
    at: readonly { locationId: string; remainingWeight?: number | null }[],
    accountId: string,
    scope: Scope,
  ): Promise<string> {
    for (const here of at) if (!includesLocation(scope, here.locationId)) throw staffElsewhere("add a batch");
    return this.prisma.$transaction(async (tx) => {
      const places = [...at].sort((a, b) => a.locationId.localeCompare(b.locationId));
      await this.checkLocations(tx, places.map((here) => here.locationId));
      for (const here of places) await lockLocation(tx, here.locationId);
      // Under its row lock, so it is neither Archived nor hard-deleted until the batch is created.
      const [bean] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM beans WHERE id = ${beanId}::uuid FOR SHARE`;
      if (!bean) throw new NotFoundException("No such Bean");
      if (bean.archived) throw new ConflictException("This Bean is Archived: restore it before adding a batch of it");
      const created = await tx.beanBatch.create({ data: { beanId, content: content as Prisma.InputJsonObject }, select: { id: true } });
      const source = accountSource(accountId);
      const when = await editTime(tx);
      await recordJoined(tx, { kind: "beanBatch", id: created.id }, content, when, source);
      for (const here of places) await place(tx, created.id, here.locationId, { atLocation: true, remainingWeight: here.remainingWeight }, when, source);
      if (places.length > 0) await notify(tx, "library_changes", created.id);
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /** Edits a batch's details, anywhere: its content, not its state at any Location. */
  async editBatch(id: string, values: Record<string, unknown>, accountId: string): Promise<void> {
    await this.editShared({ kind: "beanBatch", id }, values, accountId, null);
  }

  /** Archives a batch, so it is offered nowhere, or restores it, at the Locations it is at. */
  async archiveBatch(id: string, archived: boolean, accountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockItems(tx, "beanBatch", [id]);
      const changed = await tx.beanBatch.updateMany({ where: { id, archived: !archived }, data: { archived } });
      if (changed.count === 0) return void (await found(tx, "beanBatch", id));
      await recordVersion(tx, { kind: "beanBatch", id }, null, { archived }, accountSource(accountId), await editTime(tx));
      await notify(tx, "library_changes", id);
    }, INTAKE_TRANSACTION);
  }

  /**
   * Adds the batch at the Location or finishes it there, and sets its
   * remaining weight there, each an edit of the Location's state of it. 404
   * if there is no such batch or Location, 403 for Staff elsewhere, 409 for
   * a remaining weight where the batch is not and is not added.
   */
  async placeBatch(id: string, locationId: string, placement: BatchPlacement, accountId: string, scope: Scope): Promise<void> {
    if (!includesLocation(scope, locationId)) throw staffElsewhere("change where a batch is");
    await this.prisma.$transaction(async (tx) => {
      await this.checkLocations(tx, [locationId]);
      await lockLocation(tx, locationId);
      // Under its key's lock, so it is not hard-deleted until its state here changes.
      const batch = await tx.$queryRaw<unknown[]>`SELECT 1 FROM bean_batches WHERE id = ${id}::uuid FOR KEY SHARE`;
      if (batch.length === 0) throw notFound("beanBatch");
      const [here] = await tx.$queryRaw<{ at: boolean }[]>`
        SELECT added_at IS NOT NULL AND finished_at IS NULL AS at FROM batch_locations WHERE batch_id = ${id}::uuid AND location_id = ${locationId}::uuid`;
      if (placement.remainingWeight !== undefined && (placement.atLocation ?? here?.at ?? false) === false) {
        throw new ConflictException("The batch is not at this Location: add it here to set its remaining weight");
      }
      await place(tx, id, locationId, placement, await editTime(tx), accountSource(accountId));
      await notify(tx, "library_changes", locationId);
    }, INTAKE_TRANSACTION);
  }

  /** Creates a Grinder belonging to the Location. 404 if there is no such Location, 403 for Staff elsewhere. */
  async createGrinder(locationId: string, content: Record<string, unknown>, accountId: string, scope: Scope): Promise<string> {
    if (!includesLocation(scope, locationId)) throw staffElsewhere("create a Grinder");
    return this.prisma.$transaction(async (tx) => {
      await this.checkLocations(tx, [locationId]);
      await lockLocation(tx, locationId);
      const created = await tx.grinder.create({ data: { content: content as Prisma.InputJsonObject, locationId }, select: { id: true } });
      await recordJoined(tx, { kind: "grinder", id: created.id }, { ...content, archived: false }, await editTime(tx), accountSource(accountId));
      await notify(tx, "library_changes", locationId);
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /** Edits a Grinder's content: Staff only at the Location it belongs to. */
  async editGrinder(id: string, values: Record<string, unknown>, accountId: string, scope: Scope): Promise<void> {
    await this.editShared({ kind: "grinder", id }, values, accountId, scope);
  }

  /** Archives a Grinder, so it is offered nowhere, or restores it, at its Location: Staff anywhere. */
  async archiveGrinder(id: string, archived: boolean, accountId: string): Promise<void> {
    await this.editShared({ kind: "grinder", id }, { archived }, accountId, null);
  }

  /**
   * Merges an edit of the item's content, a Grinder's Archived state
   * included, made over it as it stands, under its row lock, after its
   * Location's for a Grinder, whose Archived state changes only under it.
   * With a scope, Staff edit a Grinder only at its own Location.
   */
  private async editShared(item: LibraryItemRef & { kind: EditedKind }, values: Record<string, unknown>, accountId: string, scope: Scope | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (item.kind === "grinder") {
        const grinder = await tx.grinder.findUnique({ where: { id: item.id }, select: { locationId: true } });
        if (!grinder) throw notFound(item.kind);
        if (scope !== null && !includesLocation(scope, grinder.locationId)) throw staffElsewhere("edit a Grinder");
        // A Grinder's Location never changes.
        if (grinder.locationId !== null) await lockLocation(tx, grinder.locationId);
      }
      await lockItems(tx, item.kind, [item.id]);
      await found(tx, item.kind, item.id);
      const edited = await editContent(tx, item, { values, at: await editTime(tx), seenAt: "everything" }, accountSource(accountId));
      if (edited.writesDue) await notify(tx, "library_changes", item.id);
    }, INTAKE_TRANSACTION);
  }

  /** 404 unless every Location exists. */
  private async checkLocations(tx: Prisma.TransactionClient, locationIds: readonly string[]): Promise<void> {
    const ids = [...new Set(locationIds)];
    if (ids.length !== locationIds.length) throw new BadRequestException("Name each Location once");
    if ((await tx.location.count({ where: { id: { in: ids } } })) !== ids.length) throw new NotFoundException("No such Location");
  }
}

/**
 * Adds or finishes the batch at the Location, and enters its remaining
 * weight there, as the account's edits of the Location's state, under its
 * lock, having seen every decision made there before them.
 */
async function place(tx: Prisma.TransactionClient, batchId: string, locationId: string, placement: BatchPlacement, at: Date, source: EditSource): Promise<void> {
  const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
  if (placement.atLocation !== undefined) await (placement.atLocation ? addBatchAt : finishBatchAt)(tx, batchId, locationId, at, seenAt, source);
  if (placement.remainingWeight !== undefined) {
    const [here] = await tx.$queryRaw<{ weight: number | null }[]>`
      SELECT remaining_weight AS weight FROM batch_locations WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`;
    await enterRemainingWeight(tx, batchId, locationId, { value: placement.remainingWeight, had: here?.weight ?? null }, at, source);
  }
}

/** The kinds of item edited here; Profiles are ticket #88's. */
type EditedKind = "bean" | "beanBatch" | "grinder";

/** When an edit made now is timed: PostgreSQL's clock (ADR-0016), to the millisecond it keeps. */
async function editTime(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT now()::timestamptz(3) AS at`;
  return at;
}

const NAMES: Readonly<Record<string, string>> = { bean: "Bean", beanBatch: "Bean Batch", grinder: "Grinder" };

function notFound(kind: string): NotFoundException {
  return new NotFoundException(`No such ${NAMES[kind]}`);
}

/** 404 unless the Library has the item. */
async function found(tx: Prisma.TransactionClient, kind: EditedKind, id: string): Promise<void> {
  const count =
    kind === "bean"
      ? await tx.bean.count({ where: { id } })
      : kind === "beanBatch"
        ? await tx.beanBatch.count({ where: { id } })
        : await tx.grinder.count({ where: { id } });
  if (count === 0) throw notFound(kind);
}

function staffElsewhere(what: string): ForbiddenException {
  return new ForbiddenException(`Staff ${what} only at the Locations they work at`);
}
