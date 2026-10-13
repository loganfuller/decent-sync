import { sameValue } from "@decent-sync/protocol";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { editContent, lockItems, recordJoined } from "./content-edits.js";
import { type EditSource, accountSource, recordVersion } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import type { SlotChoice } from "./item-input.js";
import { editTime, staffElsewhere } from "./library-edits.service.js";
import { isObject } from "./listed.js";
import { type ShownKind, addBatchAt, lockLocation, showAt } from "./location-state.js";

// Recipes created and edited in the management interface, moved between the
// Recipe Slots of their Location, taken out of them, Archived and restored
// (ticket #143). A Recipe belongs to one Location, so Staff change its
// Recipes only where they work, and Admins anywhere.
//
// Each change is the account's, timed by PostgreSQL's clock (ADR-0016), and
// an edit of its content is made over the Recipe as it stands, as
// library-edits.service.ts makes one. What a Recipe uses is checked against
// its Location as it is set: its Grinder is one of the Location's, and a
// Bean Batch, Profile, Basket or Tool not offered there is offered there
// from then on, as the account's edit of the Location's state of it, so the
// Recipe can be loaded there. Its Bean is its batch's.
//
// A Recipe's slot is its Location's state, not its content: each change of
// it is a version of its own at the Location, as a tablet taking it out of
// its slot is (recipes.ts). Slots are decided under the Location's lock, as
// a tablet's report decides them, so no two Recipes are put in one slot,
// through any instance. Each change commits with a `NOTIFY` on
// `library_changes` naming the Location, so its tablets are written: a
// Recipe moved is removed from its old slot and written in its new one
// (`recipeWrites` in holdings.ts), keeping its id and history.
//
// Locks are taken as a tablet's report of its recipes takes them: the
// Location's, then the Recipe's row; then the rows of the items it is set to
// use, so none is Archived or deleted until it is offered at the Location.

/** The kinds a Recipe uses that its Location shows or hides, each with its table. */
const SHOWN: readonly { field: "profileId" | "basketId" | "toolIds"; kind: ShownKind; table: string; idType: "text" | "uuid"; name: string }[] = [
  { field: "profileId", kind: "profile", table: "profiles", idType: "text", name: "Profile" },
  { field: "basketId", kind: "basket", table: "baskets", idType: "uuid", name: "Basket" },
  { field: "toolIds", kind: "tool", table: "tools", idType: "uuid", name: "Tool" },
];

/** Where a Recipe is: its Location, and its slot there or none. */
interface Placed {
  id: string;
  locationId: string;
  slot: number | null;
  archived: boolean;
  content: Record<string, unknown>;
}

@Injectable()
export class RecipeEditsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a Recipe at the Location with the content, in the slot chosen, or
   * none: a Recipe in that slot is taken out of it, kept at the Location. 404
   * if there is no such Location, 403 for Staff elsewhere, and 400 or 409 for
   * an item it cannot use there (`setUses`).
   */
  async create(locationId: string, content: Record<string, unknown>, slot: SlotChoice, accountId: string, scope: Scope): Promise<string> {
    if (!includesLocation(scope, locationId)) throw staffElsewhere("create a Recipe");
    return this.prisma.$transaction(async (tx) => {
      if ((await tx.location.count({ where: { id: locationId } })) === 0) throw new NotFoundException("No such Location");
      await lockLocation(tx, locationId);
      const source = accountSource(accountId);
      const at = await editTime(tx);
      const values = await setUses(tx, locationId, content, {}, source, at);
      const taken = slot === null ? null : await freeSlot(tx, locationId, null, slot, source, at);
      const [created] = await tx.$queryRaw<[{ id: string }]>`
        INSERT INTO recipes (id, location_id, slot, content)
        VALUES (gen_random_uuid(), ${locationId}::uuid, ${taken}::integer, ${JSON.stringify(values)}::jsonb)
        RETURNING id::text AS id`;
      await recordJoined(tx, { kind: "recipe", id: created.id }, values, at, source);
      if (taken !== null) await recordVersion(tx, { kind: "recipe", id: created.id }, locationId, { slot: taken }, source, at);
      await notify(tx, "library_changes", locationId);
      return created.id;
    }, INTAKE_TRANSACTION);
  }

  /**
   * Edits a Recipe's content, made over it as it stands, as an edit of
   * another item is (library-edits.service.ts), the items it is set to use
   * offered at its Location (`setUses`). Its ratio is kept only while its
   * yield is its dose times it, as DYE2's editor keeps it; and a Tool's
   * attributes only while it names the Tool. 404 for no such Recipe, 403 for
   * Staff elsewhere.
   */
  async edit(id: string, values: Record<string, unknown>, accountId: string, scope: Scope): Promise<void> {
    await this.change(id, accountId, scope, "edit a Recipe", async (tx, recipe, source, at) => {
      const set = await setUses(tx, recipe.locationId, values, recipe.content, source, at);
      const ratio = keptRatio(recipe.content, set);
      const edited = await editContent(tx, { kind: "recipe", id }, { values: ratio === undefined ? set : { ...set, ratio }, at, seenAt: "everything" }, source);
      return edited.writesDue;
    });
  }

  /**
   * Moves a Recipe to the slot chosen at its Location, or takes it out of
   * its slot (null), keeping it there. A Recipe in that slot takes the moved
   * one's place: its old slot, or none. 404 for no such Recipe, 403 for Staff
   * elsewhere, 409 for one Archived, which is in no slot.
   */
  async place(id: string, slot: SlotChoice, accountId: string, scope: Scope): Promise<void> {
    await this.change(id, accountId, scope, "move a Recipe", async (tx, recipe, source, at) => {
      if (recipe.archived && slot !== null) throw new ConflictException("This Recipe is Archived: restore it before putting it in a slot");
      if (slot === null) {
        if (recipe.slot === null) return false;
        await setSlot(tx, recipe, null, source, at);
        return true;
      }
      const taken = await freeSlot(tx, recipe.locationId, recipe, slot, source, at);
      if (taken === recipe.slot) return false;
      await setSlot(tx, recipe, taken, source, at);
      return true;
    });
  }

  /**
   * Archives a Recipe, which takes it out of its slot, or restores it, kept
   * at its Location in no slot. 404 for no such Recipe, 403 for Staff
   * elsewhere.
   */
  async archive(id: string, archived: boolean, accountId: string, scope: Scope): Promise<void> {
    await this.change(id, accountId, scope, archived ? "Archive a Recipe" : "restore a Recipe", async (tx, recipe, source, at) => {
      if (recipe.archived === archived) return false;
      if (recipe.slot !== null) await setSlot(tx, recipe, null, source, at);
      await tx.$executeRaw`UPDATE recipes SET archived = ${archived} WHERE id = ${id}::uuid`;
      await recordVersion(tx, { kind: "recipe", id }, null, { archived }, source, at);
      return true;
    });
  }

  /**
   * Makes a change to a Recipe as the account, under its Location's lock and
   * then its row lock, notifying its Location's tablets if `apply` says the
   * change is to be written to them. 404 for no such Recipe, 403 for Staff at
   * a Location they do not work at.
   */
  private async change(
    id: string,
    accountId: string,
    scope: Scope,
    what: string,
    apply: (tx: Prisma.TransactionClient, recipe: Placed, source: EditSource, at: Date) => Promise<boolean>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // The Location a Recipe belongs to never changes.
      const [owned] = await tx.$queryRaw<{ locationId: string | null }[]>`SELECT location_id::text AS "locationId" FROM recipes WHERE id = ${id}::uuid`;
      if (!owned) throw new NotFoundException("No such Recipe");
      if (!includesLocation(scope, owned.locationId)) throw staffElsewhere(what);
      if (owned.locationId === null) throw new ConflictException("This Recipe's Location no longer exists");
      await lockLocation(tx, owned.locationId);
      await lockItems(tx, "recipe", [id]);
      const [row] = await tx.$queryRaw<{ slot: number | null; archived: boolean; content: unknown }[]>`
        SELECT slot, archived, content FROM recipes WHERE id = ${id}::uuid`;
      if (!row) throw new NotFoundException("No such Recipe");
      const recipe: Placed = { id, locationId: owned.locationId, slot: row.slot, archived: row.archived, content: isObject(row.content) ? row.content : {} };
      if (await apply(tx, recipe, accountSource(accountId), await editTime(tx))) {
        await notify(tx, "library_changes", owned.locationId);
      }
    }, INTAKE_TRANSACTION);
  }
}

/**
 * The values an edit of a Recipe at the Location sets (`values`), over its
 * content now (`current`, empty for a new one), with what they use checked
 * and offered there, under each item's row lock:
 *
 * - a Grinder only one of the Location's, not Archived;
 * - a Bean Batch not Archived, added at the Location if it is not there, and
 *   its Bean set as the Recipe's; none clears the Bean too;
 * - a Profile, Basket or Tool not Archived, shown at the Location if it is
 *   not shown there;
 * - each Tool's attributes only for the Tools the Recipe names then, those of
 *   a Tool it no longer names dropped.
 *
 * 400 for an item the Library does not have, or attributes of a Tool the
 * Recipe does not name; 409 for one Archived, or another Location's Grinder.
 */
async function setUses(
  tx: Prisma.TransactionClient,
  locationId: string,
  values: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  source: EditSource,
  at: Date,
): Promise<Record<string, unknown>> {
  const set: Record<string, unknown> = { ...values };
  const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;

  if (typeof values.grinderId === "string") {
    const [grinder] = await tx.$queryRaw<{ locationId: string | null; archived: boolean }[]>`
      SELECT location_id::text AS "locationId", archived FROM grinders WHERE id = ${values.grinderId}::uuid FOR SHARE`;
    if (!grinder) throw new BadRequestException("No such Grinder");
    if (grinder.locationId !== locationId || grinder.archived) throw new ConflictException("A Recipe's Grinder must be one of its Location's, not Archived");
  }

  if (values.beanBatchId === null) set.beanId = null;
  if (typeof values.beanBatchId === "string") {
    // The batch's row locked, so it is not Archived or deleted until it is added here.
    const [batch] = await tx.$queryRaw<{ beanId: string; archived: boolean; beanArchived: boolean; here: boolean }[]>`
      SELECT batch.bean_id::text AS "beanId", batch.archived, bean.archived AS "beanArchived",
        EXISTS (
          SELECT 1 FROM batch_locations AS here
          WHERE here.batch_id = batch.id AND here.location_id = ${locationId}::uuid AND here.added_at IS NOT NULL AND here.finished_at IS NULL
        ) AS here
      FROM bean_batches AS batch JOIN beans AS bean ON bean.id = batch.bean_id
      WHERE batch.id = ${values.beanBatchId}::uuid
      FOR SHARE OF batch`;
    if (!batch) throw new BadRequestException("No such Bean Batch");
    if (batch.archived || batch.beanArchived) throw new ConflictException("This Bean Batch or its Bean is Archived: restore it before a Recipe uses it");
    set.beanId = batch.beanId;
    if (!batch.here) await addBatchAt(tx, values.beanBatchId, locationId, at, seenAt, source);
  }

  for (const { field, kind, table, idType, name } of SHOWN) {
    const named = values[field];
    const ids = Array.isArray(named) ? (named as string[]) : typeof named === "string" ? [named] : [];
    for (const itemId of [...ids].sort()) {
      const [item] = await tx.$queryRaw<{ archived: boolean; shown: boolean }[]>`
        SELECT items.archived, COALESCE(here.shown, false) AS shown
        FROM ${Prisma.raw(table)} AS items
        LEFT JOIN ${Prisma.raw(`${kind}_locations`)} AS here ON here.${Prisma.raw(`${kind}_id`)} = items.id AND here.location_id = ${locationId}::uuid
        WHERE items.id = ${itemId}::${Prisma.raw(idType)}
        FOR SHARE OF items`;
      if (!item) throw new BadRequestException(`No such ${name}`);
      if (item.archived) throw new ConflictException(`This ${name} is Archived: restore it before a Recipe uses it`);
      if (!item.shown) await showAt(tx, kind, itemId, locationId, source, true, at, seenAt);
    }
  }

  const tools = new Set(
    (Array.isArray(set.toolIds) ? set.toolIds : Array.isArray(current.toolIds) ? current.toolIds : []).filter((tool): tool is string => typeof tool === "string"),
  );
  if (isObject(values.toolAttributes)) {
    const unnamed = Object.keys(values.toolAttributes).filter((tool) => !tools.has(tool));
    if (unnamed.length > 0) throw new BadRequestException("toolAttributes names a Tool the Recipe does not use");
  } else if (values.toolIds !== undefined && isObject(current.toolAttributes)) {
    // A Tool it no longer names takes its attributes with it.
    const kept = Object.fromEntries(Object.entries(current.toolAttributes).filter(([tool]) => tools.has(tool)));
    if (Object.keys(kept).length !== Object.keys(current.toolAttributes).length) set.toolAttributes = kept;
  }
  return set;
}

/**
 * The ratio a Recipe keeps after an edit setting `values` over its content
 * (`current`): DYE2's editor keeps one only while the yield is the dose times
 * it, to a tenth of a gram. Null to clear one the edit breaks; undefined
 * where it stays as it is.
 */
export function keptRatio(current: Readonly<Record<string, unknown>>, values: Readonly<Record<string, unknown>>): null | undefined {
  if (typeof current.ratio !== "number" || (values.dose === undefined && values.yield === undefined)) return undefined;
  const dose = values.dose !== undefined ? values.dose : current.dose;
  const drink = values.yield !== undefined ? values.yield : current.yield;
  if (typeof dose === "number" && typeof drink === "number" && Math.abs(drink - Math.round(dose * current.ratio * 10) / 10) < 0.05) return undefined;
  return null;
}

/**
 * The slot a Recipe (null for one being created) is to take at the
 * Location: the one chosen, or the lowest the Location leaves empty. A
 * Recipe in that slot takes the moved one's slot, or none, as a version of
 * its own. Under the Location's lock.
 */
async function freeSlot(
  tx: Prisma.TransactionClient,
  locationId: string,
  moving: Placed | null,
  choice: number | "next",
  source: EditSource,
  at: Date,
): Promise<number> {
  const slotted = await tx.$queryRaw<{ id: string; slot: number }[]>`
    SELECT id::text AS id, slot FROM recipes WHERE location_id = ${locationId}::uuid AND slot IS NOT NULL ORDER BY slot`;
  const slot = choice === "next" ? lowestFree(slotted.filter((recipe) => recipe.id !== moving?.id).map((recipe) => recipe.slot)) : choice;
  const there = slotted.find((recipe) => recipe.slot === slot && recipe.id !== moving?.id);
  if (there) {
    // The moved Recipe leaves its slot first, as each slot holds one Recipe.
    if (moving !== null && moving.slot !== null) await tx.$executeRaw`UPDATE recipes SET slot = NULL WHERE id = ${moving.id}::uuid`;
    const swapped = moving?.slot ?? null;
    await tx.$executeRaw`UPDATE recipes SET slot = ${swapped}::integer WHERE id = ${there.id}::uuid`;
    await recordVersion(tx, { kind: "recipe", id: there.id }, locationId, { slot: swapped }, source, at);
  }
  return slot;
}

/** The lowest Recipe Slot, from 1, that none of these is. */
export function lowestFree(slots: readonly number[]): number {
  const taken = new Set(slots);
  let slot = 1;
  while (taken.has(slot)) slot++;
  return slot;
}

/** Puts the Recipe in the slot, or none, as a version of its own at its Location. */
async function setSlot(tx: Prisma.TransactionClient, recipe: Placed, slot: number | null, source: EditSource, at: Date): Promise<void> {
  if (sameValue(recipe.slot, slot)) return;
  await tx.$executeRaw`UPDATE recipes SET slot = ${slot}::integer WHERE id = ${recipe.id}::uuid`;
  await recordVersion(tx, { kind: "recipe", id: recipe.id }, recipe.locationId, { slot }, source, at);
}
