import { RECIPE_SLOTS, sameValue } from "@decent-sync/protocol";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { editContent, lockItems, recordJoined } from "./content-edits.js";
import { type CopiedFrom, type EditSource, accountSource, recordVersion } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import type { SlotChoice } from "./item-input.js";
import { editTime, staffElsewhere } from "./library-edits.service.js";
import { isObject } from "./listed.js";
import { NoDoseForRatio, ratioValues } from "./recipe-intake.js";
import { type ShownKind, addBatchAt, lockLocation, offerBeanAt, showAt } from "./location-state.js";

// Recipes created and edited in the management interface, moved between the
// Recipe Slots of their Location, taken out of them, Archived and restored
// (ticket #143), and copied to a Location (ticket #144). A Recipe belongs to
// one Location, so Staff change its Recipes, and copy one to it, only where
// they work, and Admins anywhere.
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
// through any instance. A Location has five, the buttons of Streamline's DYE
// strip (RECIPE_SLOTS). Each change commits with a `NOTIFY` on
// `library_changes` naming the Location, so its tablets are written: a
// Recipe moved is written its new slot (`stripSlot`), the Recipe that was
// there written its own, and each keeps its record id and history
// (`recipeWrites` in holdings.ts).
//
// Locks are taken as a tablet's report of its recipes takes them: the
// Location's, then the Recipe's row; then the rows of the items it is set to
// use, so none is Archived or deleted until it is offered at the Location.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The kinds a Recipe uses that its Location shows or hides, each with its table. */
const SHOWN: readonly { field: "profileId" | "basketId" | "toolIds"; kind: ShownKind; table: string; idType: "text" | "uuid"; name: string }[] = [
  { field: "profileId", kind: "profile", table: "profiles", idType: "text", name: "Profile" },
  { field: "basketId", kind: "basket", table: "baskets", idType: "uuid", name: "Basket" },
  { field: "toolIds", kind: "tool", table: "tools", idType: "uuid", name: "Tool" },
];

/** Where a Recipe's copy goes, and what it uses there instead of what the Recipe does (`RecipeEditsService.copy`). */
export interface RecipeCopy {
  locationId: string;
  slot: SlotChoice;
  /** Its Grinder, one of the Location's, or null for none. */
  grinderId: string | null;
  /** The Bean Batch it uses instead of the Recipe's, or null for none; undefined keeps the Recipe's. */
  beanBatchId: string | null | undefined;
}

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
      return insertRecipe(tx, locationId, values, slot, source, at);
    }, INTAKE_TRANSACTION);
  }

  /**
   * Copies a Recipe to a Location (ticket #144) as a new Recipe there, whose
   * history starts with the copy, naming the Recipe it was copied from and
   * that Recipe's Location. The copy takes the Recipe's content as it stands
   * but for its Grinder, the one chosen from the Location's, its grind
   * setting kept as a starting point, and its Bean Batch where another, or
   * none, is chosen. What it uses is checked and offered at the Location as
   * an edit's is (`recipeEditValues`): a batch not there is added there, and
   * a Profile, Basket or Tool not shown there is shown there. Its steam, hot
   * water and flush settings are the Recipe's. It goes in the slot chosen, the Recipe
   * there taken out of it and kept, or the lowest free one, or none. The
   * Recipe copied is not changed. 404 for no such Recipe or Location, 403
   * for Staff not working at the Location, 400 for the Recipe's own
   * Location, and 400 or 409 for an item the copy cannot use there; an item
   * the Library no longer has is left out of the copy (`withoutDeleted`).
   */
  async copy(id: string, to: RecipeCopy, accountId: string, scope: Scope): Promise<string> {
    if (!includesLocation(scope, to.locationId)) throw staffElsewhere("copy a Recipe to a Location");
    return this.prisma.$transaction(async (tx) => {
      if ((await tx.location.count({ where: { id: to.locationId } })) === 0) throw new NotFoundException("No such Location");
      await lockLocation(tx, to.locationId);
      // Read as it stands, without its lock: the copy is of its content then, and changes nothing of it.
      const [original] = await tx.$queryRaw<{ id: string; locationId: string | null; content: unknown }[]>`
        SELECT id::text AS id, location_id::text AS "locationId", content FROM recipes WHERE id = ${id}::uuid`;
      if (!original) throw new NotFoundException("No such Recipe");
      // A copy is for another Location; at its own, the slot chosen could be the Recipe's own, which the copy would take from it.
      if (original.locationId === to.locationId) throw new BadRequestException("Copy a Recipe to another Location than its own");
      const content = await withoutDeleted(tx, isObject(original.content) ? original.content : {});
      delete content.grinderId;
      if (to.grinderId !== null) content.grinderId = to.grinderId;
      if (to.beanBatchId !== undefined) {
        // Another batch sets the Bean as its own; none clears both.
        delete content.beanId;
        delete content.beanBatchId;
        if (to.beanBatchId !== null) content.beanBatchId = to.beanBatchId;
      }
      const source = accountSource(accountId);
      const at = await editTime(tx);
      const set = await recipeEditValues(tx, to.locationId, content, {}, source, at);
      // A new Recipe holds no field it has no value for.
      const values = Object.fromEntries(Object.entries(set).filter(([, value]) => value !== null && value !== undefined));
      // Its id as PostgreSQL writes it, as versions name items, however the request spelled it.
      return insertRecipe(tx, to.locationId, values, to.slot, source, at, { id: original.id, locationId: original.locationId });
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
      const set = await recipeEditValues(tx, recipe.locationId, values, recipe.content, source, at);
      const edited = await editContent(tx, { kind: "recipe", id }, { values: set, at, seenAt: "everything" }, source);
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
      if (taken === null) throw new ConflictException(`All ${RECIPE_SLOTS} Recipe Slots here hold a Recipe: choose one to swap with, or take a Recipe out of its slot first`);
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
      // A Recipe restored keeps its record id, unless another of its Location has taken that id since, as one a tablet
      // saved under a Recipe Slot's number: it is given a new one, which its tablets are written.
      await tx.$executeRaw`
        UPDATE recipes AS r SET archived = ${archived},
          record_id = CASE WHEN NOT ${archived} AND EXISTS (
            SELECT 1 FROM recipes AS other WHERE other.location_id = r.location_id AND other.record_id = r.record_id AND NOT other.archived AND other.id <> r.id
          ) THEN gen_random_uuid()::text ELSE r.record_id END
        WHERE r.id = ${id}::uuid`;
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
 * Inserts a new Recipe at the Location with the values, under a new record
 * id, in the slot chosen, the Recipe there taken out of it, or the lowest
 * free one, or none, as for `next` where none is free, as the Location's
 * state; it joins the Library as its first version, which names the Recipe a
 * copy was copied from. Notifies the Location's tablets, under its lock.
 * Returns its id.
 */
async function insertRecipe(
  tx: Prisma.TransactionClient,
  locationId: string,
  values: Readonly<Record<string, unknown>>,
  slot: SlotChoice,
  source: EditSource,
  at: Date,
  copiedFrom?: CopiedFrom,
): Promise<string> {
  const taken = slot === null ? null : await freeSlot(tx, locationId, null, slot, source, at);
  const [created] = await tx.$queryRaw<[{ id: string }]>`
    INSERT INTO recipes (id, location_id, record_id, slot, content)
    VALUES (gen_random_uuid(), ${locationId}::uuid, gen_random_uuid()::text, ${taken}::integer, ${JSON.stringify(values)}::jsonb)
    RETURNING id::text AS id`;
  await recordJoined(tx, { kind: "recipe", id: created.id }, values, at, source, copiedFrom);
  if (taken !== null) await recordVersion(tx, { kind: "recipe", id: created.id }, locationId, { slot: taken }, source, at);
  await notify(tx, "library_changes", locationId);
  return created.id;
}

/**
 * A Recipe's content without the items it names that the Library no longer
 * has, as an Admin's hard delete leaves them named, so a copy of it is not
 * refused for them: written to tablets, it names none of them either. A
 * Tool's attributes go with the Tool.
 */
async function withoutDeleted(tx: Prisma.TransactionClient, content: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const kept: Record<string, unknown> = { ...content };
  const id = (field: string) => (typeof content[field] === "string" ? (content[field] as string) : null);
  const exists = async (table: string, itemId: string | null) =>
    itemId === null || (UUID.test(itemId) && (await tx.$queryRaw<unknown[]>`SELECT 1 FROM ${Prisma.raw(table)} WHERE id = ${itemId}::uuid`).length > 0);
  if (!(await exists("bean_batches", id("beanBatchId")))) delete kept.beanBatchId;
  if (!(await exists("beans", id("beanId")))) delete kept.beanId;
  // A Profile's id is Decaid's, not a UUID.
  const profileId = id("profileId");
  if (profileId !== null && (await tx.$queryRaw<unknown[]>`SELECT 1 FROM profiles WHERE id = ${profileId}`).length === 0) delete kept.profileId;
  if (!(await exists("baskets", id("basketId")))) delete kept.basketId;
  if (Array.isArray(content.toolIds)) {
    const named = content.toolIds.filter((tool): tool is string => typeof tool === "string");
    const found = new Set(
      (await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM tools WHERE id = ANY(${named.filter((tool) => UUID.test(tool))}::uuid[])`).map((row) => row.id),
    );
    const tools = named.filter((tool) => found.has(tool.toLowerCase()));
    if (tools.length !== named.length) {
      kept.toolIds = tools;
      if (isObject(content.toolAttributes)) kept.toolAttributes = Object.fromEntries(Object.entries(content.toolAttributes).filter(([tool]) => tools.includes(tool)));
    }
  }
  return kept;
}

/**
 * What an account's edit of a Recipe at the Location setting `values` over
 * its content now (`current`) sets, as the management interface makes one
 * and using a Conflict's value does (conflicts.service.ts), so the Recipe's
 * fields stay consistent however they are set:
 *
 * - what it uses checked and offered at the Location (`setUses`);
 * - a Bean set alone, as a Conflict about it holds, takes the Recipe's batch
 *   if it is of that Bean, or else that Bean's batch most recently added at
 *   the Location, or none, keeping the Bean, as a Bean picked in DYE2 does
 *   (ADR-0005), and offered at the Location then (`offerBeanAt`): 400 for a
 *   Bean the Library does not have, 409 for one Archived;
 * - DYE2's ratio kept only while the yield is the dose times it, and a ratio
 *   set, as a Conflict about it holds, setting the yield (`ratioValues`).
 */
export async function recipeEditValues(
  tx: Prisma.TransactionClient,
  locationId: string,
  values: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  source: EditSource,
  at: Date,
): Promise<Record<string, unknown>> {
  const asked: Record<string, unknown> = { ...values };
  const beanAlone = Object.prototype.hasOwnProperty.call(values, "beanId") && !Object.prototype.hasOwnProperty.call(values, "beanBatchId");
  if (beanAlone) {
    if (typeof values.beanId === "string" && values.beanId !== current.beanId) {
      const [bean] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM beans WHERE id = ${values.beanId}::uuid FOR SHARE`;
      if (!bean) throw new BadRequestException("No such Bean");
      if (bean.archived) throw new ConflictException("This Bean is Archived: restore it before a Recipe uses it");
    }
    asked.beanBatchId = typeof values.beanId === "string" ? await batchOfBean(tx, locationId, values.beanId, current.beanBatchId) : null;
    // A Bean newly set with no batch at the Location is offered there, as a tablet there creating it is, so its tablets can name it.
    if (typeof values.beanId === "string" && values.beanId !== current.beanId && asked.beanBatchId === null) await offerBeanAt(tx, values.beanId, locationId);
  }
  const set = await setUses(tx, locationId, asked, current, source, at);
  // A Bean with no batch at the Location is still the Recipe's, as a tablet picking it makes it.
  if (beanAlone) set.beanId = values.beanId ?? null;
  try {
    return { ...set, ...ratioValues(current, set) };
  } catch (error) {
    if (error instanceof NoDoseForRatio) throw new ConflictException(error.message);
    throw error;
  }
}

/** The batch a Recipe naming the Bean uses: its batch now if it is of that Bean, or else the Bean's batch most recently added at the Location and still there, or none. */
async function batchOfBean(tx: Prisma.TransactionClient, locationId: string, beanId: string, currentBatch: unknown): Promise<string | null> {
  if (typeof currentBatch === "string") {
    const [same] = await tx.$queryRaw<unknown[]>`SELECT 1 FROM bean_batches WHERE id = ${currentBatch}::uuid AND bean_id = ${beanId}::uuid`;
    if (same) return currentBatch;
  }
  const [latest] = await tx.$queryRaw<{ id: string }[]>`
    SELECT batch.id::text AS id
    FROM bean_batches AS batch
    JOIN beans AS bean ON bean.id = batch.bean_id
    JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
    WHERE batch.bean_id = ${beanId}::uuid AND here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived
    ORDER BY here.added_at DESC, batch.created_at DESC, batch.id
    LIMIT 1`;
  return latest?.id ?? null;
}

/**
 * The values an edit of a Recipe at the Location sets (`values`), over its
 * content now (`current`, empty for a new one), with what they newly use
 * checked and offered there, under each item's row lock: one it uses already,
 * as an Archived Tool it keeps beside a new one, is not checked again.
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

  if (typeof values.grinderId === "string" && values.grinderId !== current.grinderId) {
    const [grinder] = await tx.$queryRaw<{ locationId: string | null; archived: boolean }[]>`
      SELECT location_id::text AS "locationId", archived FROM grinders WHERE id = ${values.grinderId}::uuid FOR SHARE`;
    if (!grinder) throw new BadRequestException("No such Grinder");
    if (grinder.locationId !== locationId || grinder.archived) throw new ConflictException("A Recipe's Grinder must be one of its Location's, not Archived");
  }

  if (values.beanBatchId === null) set.beanId = null;
  if (typeof values.beanBatchId === "string" && values.beanBatchId === current.beanBatchId) set.beanId = current.beanId ?? null;
  if (typeof values.beanBatchId === "string" && values.beanBatchId !== current.beanBatchId) {
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
    const had = current[field];
    const used = new Set(Array.isArray(had) ? had : typeof had === "string" ? [had] : []);
    for (const itemId of [...ids].filter((id) => !used.has(id)).sort()) {
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

  // The Tools it names once edited: none where the edit clears them.
  const named = Object.prototype.hasOwnProperty.call(values, "toolIds") ? values.toolIds : current.toolIds;
  const tools = new Set((Array.isArray(named) ? named : []).filter((tool): tool is string => typeof tool === "string"));
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
 * The slot a Recipe (null for one being created) is to take at the
 * Location: the one chosen, or the lowest the Location leaves empty, or
 * none (null) where every one holds a Recipe. A Recipe in that slot takes
 * the moved one's slot, or none, as a version of its own. Under the
 * Location's lock.
 */
async function freeSlot(
  tx: Prisma.TransactionClient,
  locationId: string,
  moving: Placed | null,
  choice: number | "next",
  source: EditSource,
  at: Date,
): Promise<number | null> {
  const slotted = await tx.$queryRaw<{ id: string; slot: number }[]>`
    SELECT id::text AS id, slot FROM recipes WHERE location_id = ${locationId}::uuid AND slot IS NOT NULL ORDER BY slot`;
  // The next free slot is one no Recipe is in, the moved one's own included.
  const slot = choice === "next" ? lowestFree(slotted.map((recipe) => recipe.slot)) : choice;
  if (slot === null) return null;
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

/** The lowest Recipe Slot, from 1, that none of these is, or null where they are all taken. */
function lowestFree(slots: readonly number[]): number | null {
  const taken = new Set(slots);
  for (let slot = 1; slot <= RECIPE_SLOTS; slot++) if (!taken.has(slot)) return slot;
  return null;
}

/** Puts the Recipe in the slot, or none, as a version of its own at its Location. */
async function setSlot(tx: Prisma.TransactionClient, recipe: Placed, slot: number | null, source: EditSource, at: Date): Promise<void> {
  if (sameValue(recipe.slot, slot)) return;
  await tx.$executeRaw`UPDATE recipes SET slot = ${slot}::integer WHERE id = ${recipe.id}::uuid`;
  await recordVersion(tx, { kind: "recipe", id: recipe.id }, recipe.locationId, { slot }, source, at);
}
