import { type LibraryKind, beanMatchKey, equipmentMatchKey } from "@decent-sync/protocol";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { lockBeanMatching } from "./beans.js";
import { editContent, lockItems, recordJoined } from "./content-edits.js";
import { type EquipmentKind, lockMatching } from "./equipment.js";
import { grinderEdit, newGrinderProblem } from "./grinder-range.js";
import { type EditSource, type Editor, type ItemRef, accountSource, recordVersion } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { KINDS, idSql } from "./kinds.js";
import { type ShownKind, addBatchAt, enterRemainingWeight, finishBatchAt, lockLocation, showAt } from "./location-state.js";

// Creating and editing Beans, Bean Batches and Grinders in the management
// interface, Archiving and restoring them, and adding and finishing batches
// at Locations with their remaining weight there (ticket #87); showing and
// hiding Profiles at Locations, and Archiving and restoring them (ticket
// #88); and showing and hiding Baskets and Tools at Locations (ticket #138),
// and creating, editing, Archiving and restoring them (ticket #139).
// A Profile's title, author and notes are edited here too (#576), outside
// the id Decaid computes from what the machine executes, so it stays the
// same Profile; a bundled Profile's are Decaid's, which it refuses to change.
// Each is an edit by the account, timed by PostgreSQL's clock (ADR-0016), made over the
// item as it stands, as using a Conflict's value is (ADR-0020): it decides
// every field it sets whatever the times of the edits before it, and keeps
// nothing it replaces as a Conflict. A tablet's edit made before it that
// arrives later loses to it. Each change commits with a `NOTIFY` on
// `library_changes`, so every tablet that holds the item, or whose Location
// offers it now, is written it.
//
// Locks are taken as a tablet's edits take them, after its own: a Location's
// lock before an item's, and new or Archived Beans, Baskets and Tools under
// the lock their kind is matched under, so a tablet never links a new record
// to an item Archived at once, and two of one name are never created at once.
//
// Staff edit the Library's shared content anywhere (a Bean's, a batch's
// details, a Basket's, a Tool's and a Profile's title, author and notes) and Archive and restore items, but add
// and finish batches, set their remaining weight, create and edit Grinders,
// create Baskets and Tools, and show and hide Profiles, Baskets and Tools
// only at their own Locations, as a Grinder belongs to one.

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
  async createBean(content: Record<string, unknown>, editor: Editor): Promise<string> {
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
      await recordJoined(tx, { kind: "bean", id: created.id }, content, await editTime(tx), accountSource(editor));
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /** Edits a Bean's content, anywhere. */
  async editBean(id: string, values: Record<string, unknown>, editor: Editor): Promise<void> {
    await this.editShared({ kind: "bean", id }, values, editor, null);
  }

  /** Archives a Bean, so it and its batches are offered nowhere, or restores it, offered where it was. */
  async archiveBean(id: string, archived: boolean, editor: Editor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockBeanMatching(tx);
      await lockItems(tx, "bean", [id]);
      const changed = await tx.bean.updateMany({ where: { id, archived: !archived }, data: { archived } });
      if (changed.count === 0) return void (await found(tx, "bean", id));
      await recordVersion(tx, { kind: "bean", id }, null, { archived }, accountSource(editor), await editTime(tx));
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
    editor: Editor,
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
      const source = accountSource(editor);
      const when = await editTime(tx);
      await recordJoined(tx, { kind: "beanBatch", id: created.id }, content, when, source);
      for (const here of places) await place(tx, created.id, here.locationId, { atLocation: true, remainingWeight: here.remainingWeight }, when, source);
      if (places.length > 0) await notify(tx, "library_changes", created.id);
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /** Edits a batch's details, anywhere: its content, not its state at any Location. */
  async editBatch(id: string, values: Record<string, unknown>, editor: Editor): Promise<void> {
    await this.editShared({ kind: "beanBatch", id }, values, editor, null);
  }

  /** Archives a batch, so it is offered nowhere, or restores it, at the Locations it is at. */
  async archiveBatch(id: string, archived: boolean, editor: Editor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockItems(tx, "beanBatch", [id]);
      const changed = await tx.beanBatch.updateMany({ where: { id, archived: !archived }, data: { archived } });
      if (changed.count === 0) return void (await found(tx, "beanBatch", id));
      await recordVersion(tx, { kind: "beanBatch", id }, null, { archived }, accountSource(editor), await editTime(tx));
      await notify(tx, "library_changes", id);
    }, INTAKE_TRANSACTION);
  }

  /**
   * Adds the batch at the Location or finishes it there, and sets its
   * remaining weight there, each an edit of the Location's state of it. 404
   * if there is no such batch or Location, 403 for Staff elsewhere, 409 for
   * a remaining weight where the batch is not and is not added.
   */
  async placeBatch(id: string, locationId: string, placement: BatchPlacement, editor: Editor, scope: Scope): Promise<void> {
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
      await place(tx, id, locationId, placement, await editTime(tx), accountSource(editor));
      await notify(tx, "library_changes", locationId);
    }, INTAKE_TRANSACTION);
  }

  /** Creates a Grinder belonging to the Location. 404 if there is no such Location, 403 for Staff elsewhere. */
  async createGrinder(locationId: string, content: Record<string, unknown>, editor: Editor, scope: Scope): Promise<string> {
    if (!includesLocation(scope, locationId)) throw staffElsewhere("create a Grinder");
    const problem = newGrinderProblem(content);
    if (problem !== null) throw new BadRequestException(problem);
    return this.prisma.$transaction(async (tx) => {
      await this.checkLocations(tx, [locationId]);
      await lockLocation(tx, locationId);
      const created = await tx.grinder.create({ data: { content: content as Prisma.InputJsonObject, locationId }, select: { id: true } });
      await recordJoined(tx, { kind: "grinder", id: created.id }, { ...content, archived: false }, await editTime(tx), accountSource(editor));
      await notify(tx, "library_changes", locationId);
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /**
   * Edits a Grinder's content: Staff only at the Location it belongs to. 400
   * for an edit that would leave a lowest above a highest, or a range or
   * default of its setting on a Grinder with named positions, judged over its
   * content under its row lock; one that gives it named positions clears
   * them (`grinderEdit`).
   */
  async editGrinder(id: string, values: Record<string, unknown>, editor: Editor, scope: Scope): Promise<void> {
    await this.editShared({ kind: "grinder", id }, values, editor, scope, (content) => {
      const edit = grinderEdit(content, values);
      if ("problem" in edit) throw new BadRequestException(edit.problem);
      return edit.values;
    });
  }

  /** Archives a Grinder, so it is offered nowhere, or restores it, at its Location: Staff anywhere. */
  async archiveGrinder(id: string, archived: boolean, editor: Editor): Promise<void> {
    await this.editShared({ kind: "grinder", id }, { archived }, editor, null);
  }

  /**
   * Shows or hides the Profile at the Location, an edit of the Location's
   * state of it, as having seen every decision made there before it. An
   * Archived Profile is shown nowhere, but keeps each Location's state of
   * it, so restoring it shows it again where it is shown. 404 if there is
   * no such Profile or Location, 403 for Staff elsewhere.
   */
  async showProfile(id: string, locationId: string, shown: boolean, editor: Editor, scope: Scope): Promise<void> {
    await this.show("profile", id, locationId, shown, editor, scope);
  }

  /**
   * Shows a Basket or Tool at a Location, or hides it there, as a Profile is
   * (ADR-0008): showing it there writes it to the Location's tablets, and
   * hiding it removes it from their lists, as DYE2 cannot hide one, and from
   * no other Location's. Staff only at their own Locations.
   */
  async showEquipment(kind: "basket" | "tool", id: string, locationId: string, shown: boolean, editor: Editor, scope: Scope): Promise<void> {
    await this.show(kind, id, locationId, shown, editor, scope);
  }

  /**
   * Creates a Basket or Tool with the content, shown at the Location only,
   * as one entered on a tablet there is (ADR-0008). 404 if there is no such
   * Location, 403 for Staff elsewhere, and 409, naming the item and whether
   * it is Archived, if the Library has one of the kind of the same name
   * already, as a Bean is refused: one not Archived is the item a tablet's
   * record of that name would be (ADR-0018), and one Archived is restored
   * rather than duplicated, but only where none of the name is current: the
   * one named is the one a tablet's record would be linked to, if any.
   * Decided under the lock the
   * kind's new records are matched under, so two are never created at once,
   * through any instance, nor one beside a tablet's new record.
   */
  async createEquipment(kind: EquipmentKind, locationId: string, content: Record<string, unknown>, editor: Editor, scope: Scope): Promise<string> {
    const description = KINDS[kind];
    if (!includesLocation(scope, locationId)) throw staffElsewhere(`create a ${description.name}`);
    return this.prisma.$transaction(async (tx) => {
      await lockMatching(tx, kind);
      await this.checkLocations(tx, [locationId]);
      await lockLocation(tx, locationId);
      const matchKey = equipmentMatchKey(String(content.name));
      const [existing] = await tx.$queryRaw<{ id: string; content: unknown; archived: boolean }[]>`
        SELECT id::text AS id, content, archived FROM ${Prisma.raw(description.table)} WHERE match_key = ${matchKey} ORDER BY archived, created_at, id LIMIT 1`;
      if (existing) {
        const name = (existing.content as { name?: unknown } | null)?.name;
        throw new ConflictException({
          statusCode: 409,
          error: "Conflict",
          message: `The Library has a ${description.name} of this name already`,
          existing: { id: existing.id, name: typeof name === "string" ? name : null, archived: existing.archived },
        });
      }
      const [created] = await tx.$queryRaw<[{ id: string }]>`
        INSERT INTO ${Prisma.raw(description.table)} (id, content, match_key, created_location_id)
        VALUES (gen_random_uuid(), ${JSON.stringify(content)}::jsonb, ${matchKey}, ${locationId}::uuid)
        RETURNING id::text AS id`;
      const source = accountSource(editor);
      const when = await editTime(tx);
      await recordJoined(tx, { kind, id: created.id }, content, when, source);
      const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
      await showAt(tx, kind, created.id, locationId, source, true, when, seenAt);
      await notify(tx, "library_changes", locationId);
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /** Edits a Basket's or Tool's content, anywhere. */
  async editEquipment(kind: EquipmentKind, id: string, values: Record<string, unknown>, editor: Editor): Promise<void> {
    await this.editShared({ kind, id }, values, editor, null);
  }

  /**
   * Archives a Basket or Tool, so it is shown nowhere and removed from every
   * tablet's list, or restores it, written again where it is shown: anywhere,
   * Staff too. Under the lock its kind is matched under, so a tablet never
   * links a new record to one Archived at once.
   */
  async archiveEquipment(kind: EquipmentKind, id: string, archived: boolean, editor: Editor): Promise<void> {
    const description = KINDS[kind];
    await this.prisma.$transaction(async (tx) => {
      await lockMatching(tx, kind);
      await lockItems(tx, kind, [id]);
      const changed = await tx.$executeRaw`
        UPDATE ${Prisma.raw(description.table)} SET archived = ${archived} WHERE id = ${id}::uuid AND archived = ${!archived}`;
      if (changed === 0) return void (await found(tx, kind, id));
      await recordVersion(tx, { kind, id }, null, { archived }, accountSource(editor), await editTime(tx));
      await notify(tx, "library_changes", id);
    }, INTAKE_TRANSACTION);
  }

  /** Shows or hides an item of a kind shown per Location, as the account's edit of the Location's state, having seen every decision made there before it. */
  private async show(kind: ShownKind, id: string, locationId: string, shown: boolean, editor: Editor, scope: Scope): Promise<void> {
    const description = KINDS[kind];
    if (!includesLocation(scope, locationId)) throw staffElsewhere(`show or hide a ${description.name}`);
    await this.prisma.$transaction(async (tx) => {
      await this.checkLocations(tx, [locationId]);
      await lockLocation(tx, locationId);
      // Under its key's lock, so it is not hard-deleted until its state here changes.
      const item = await tx.$queryRaw<unknown[]>`SELECT 1 FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, id)} FOR KEY SHARE`;
      if (item.length === 0) throw notFound(kind);
      const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
      await showAt(tx, kind, id, locationId, accountSource(editor), shown, await editTime(tx), seenAt);
      await notify(tx, "library_changes", locationId);
    }, INTAKE_TRANSACTION);
  }

  /**
   * Edits a Profile's title, author and notes, anywhere, as a Bean's content
   * is edited: merged per field (ADR-0020), and written to every tablet that
   * holds it as a tablet's edit of them is. 409 for one of Decaid's bundled
   * Profiles, whose title, author and notes Decaid refuses to change, and
   * for a title another Profile the Library has, Archived ones too, as
   * tablets keep their records hidden, compared as Streamline compares
   * titles (`sameTitle`): Streamline finds the tablet's record of the
   * Workflow's profile, and of the profile it loads at wake, by its title,
   * so would take either for the other. Judged under PROFILE_TITLE_LOCK,
   * taken after the Profile's row lock, so two edits never both take a
   * title.
   */
  async editProfile(id: string, values: Record<string, unknown>, editor: Editor): Promise<void> {
    await this.editShared({ kind: "profile", id }, values, editor, null, async (content, row, tx) => {
      if (row.bundled) throw new ConflictException(BUNDLED_PROFILE_TEXT);
      const title = values.title;
      // A title kept as it is, as an assistant may send with other fields, takes nothing from another Profile.
      if (typeof title === "string" && !(typeof content.title === "string" && sameTitle(content.title, title))) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROFILE_TITLE_LOCK}::bigint)`;
        const others = await tx.$queryRaw<{ title: string | null }[]>`SELECT content -> 'profile' ->> 'title' AS title FROM profiles WHERE id <> ${id}`;
        const other = others.find((profile) => profile.title !== null && sameTitle(profile.title, title));
        if (other) throw new ConflictException(`A Profile in the Library is titled "${other.title}" already`);
      }
      return values;
    });
  }

  /**
   * Archives a Profile, so it is shown nowhere and hidden on every tablet
   * that holds it, or restores it, shown again where it is shown: anywhere,
   * Staff too. Only the management interface Archives a Profile (ADR-0019).
   */
  async archiveProfile(id: string, archived: boolean, editor: Editor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockItems(tx, "profile", [id]);
      const changed = await tx.profile.updateMany({ where: { id, archived: !archived }, data: { archived } });
      if (changed.count === 0) {
        if ((await tx.profile.count({ where: { id } })) === 0) throw notFound("profile");
        return;
      }
      await recordVersion(tx, { kind: "profile", id }, null, { archived }, accountSource(editor), await editTime(tx));
      await notify(tx, "library_changes", id);
    }, INTAKE_TRANSACTION);
  }

  /**
   * Merges an edit of the item's content, a Grinder's Archived state
   * included, made over it as it stands, under its row lock, after its
   * Location's for a Grinder, whose Archived state changes only under it.
   * With a scope, Staff edit a Grinder only at its own Location. With
   * `over`, the edit is what it returns for the item's content as it stands,
   * and its row, read under that lock, or is refused as it throws.
   */
  private async editShared(
    item: ItemRef,
    values: Record<string, unknown>,
    editor: Editor,
    scope: Scope | null,
    over?: (content: Record<string, unknown>, row: ItemRow, tx: Prisma.TransactionClient) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<void> {
    const description = KINDS[item.kind];
    await this.prisma.$transaction(async (tx) => {
      if (description.belongsToLocation) {
        const [owned] = await tx.$queryRaw<{ locationId: string | null }[]>`
          SELECT location_id AS "locationId" FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, item.id)}`;
        if (!owned) throw notFound(item.kind);
        if (scope !== null && !includesLocation(scope, owned.locationId)) throw staffElsewhere(`edit a ${description.name}`);
        // The Location an item belongs to never changes.
        if (owned.locationId !== null) await lockLocation(tx, owned.locationId);
      }
      await lockItems(tx, item.kind, [item.id]);
      const row = await found(tx, item.kind, item.id);
      const edit = over ? await over(description.values(row.content), row, tx) : values;
      const edited = await editContent(tx, item, { values: edit, at: await editTime(tx), seenAt: "everything" }, accountSource(editor));
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

/** When an edit made now is timed: PostgreSQL's clock (ADR-0016), to the millisecond it keeps. */
export async function editTime(tx: Prisma.TransactionClient): Promise<Date> {
  const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT now()::timestamptz(3) AS at`;
  return at;
}

function notFound(kind: LibraryKind): NotFoundException {
  return new NotFoundException(`No such ${KINDS[kind].name}`);
}

/** What an edit of an item reads of its row: its content, and whether it is one of Decaid's bundled Profiles, false for any other kind. */
interface ItemRow {
  content: Record<string, unknown>;
  bundled: boolean;
}

/** The item's row, read under its row lock where the caller holds it; 404 unless the Library has the item. */
async function found(tx: Prisma.TransactionClient, kind: LibraryKind, id: string): Promise<ItemRow> {
  const description = KINDS[kind];
  const bundled = kind === "profile" ? Prisma.sql`bundled` : Prisma.sql`false`;
  const [row] = await tx.$queryRaw<{ content: unknown; bundled: boolean }[]>`
    SELECT content, ${bundled} AS bundled FROM ${Prisma.raw(description.table)} WHERE id = ${idSql(description, id)}`;
  if (!row) throw notFound(kind);
  const content = typeof row.content === "object" && row.content !== null && !Array.isArray(row.content) ? (row.content as Record<string, unknown>) : {};
  return { content, bundled: row.bundled };
}

/** Taken by an edit of a Profile's title, so two edits never both take the same title (`editProfile`). */
const PROFILE_TITLE_LOCK = 4_000_011;

/** Whether two Profile titles are one to Streamline, which finds a profile by its title trimmed and lower-cased (`resolveProfileKeyByTitle` in streamline-js:src/modules/active-profile.js, v0.2.27). */
function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Why a bundled Profile's title, author and notes are not edited. */
export const BUNDLED_PROFILE_TEXT = "Decaid's bundled Profiles keep the title, author and notes Decaid gives them";

export function staffElsewhere(what: string): ForbiddenException {
  return new ForbiddenException(`Staff ${what} only at the Locations they work at`);
}
