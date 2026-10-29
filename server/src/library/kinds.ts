import {
  LIBRARY_ITEM_KINDS,
  type LibraryKind,
  type LibraryList,
  LOADED_RECIPE_KIND,
  WORKFLOW_KIND,
  type WrittenKind,
  beanMatchKey,
  equipmentMatchKey,
} from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";
import { shotLinkedSql, shotLinkedToRecipesSql, stepsKeySql } from "../shots/links.js";
import { batchContent } from "./batch-intake.js";
import { recordBatchWritten, takeInBatches } from "./bean-batches.js";
import { beanContent } from "./bean-intake.js";
import { type EquipmentKind, recordEquipmentWritten, takeInEquipment } from "./equipment.js";
import { equipmentContent } from "./equipment-intake.js";
import { recordBeanWritten, takeInBeans } from "./beans.js";
import { grinderContent } from "./grinder-intake.js";
import { recordGrinderWritten, takeInGrinders } from "./grinders.js";
import type { EditSource } from "./history.js";
import {
  type HeldRecord,
  type LocationBatch,
  type LocationOffer,
  type OfferedBean,
  type OfferedGrinder,
  type PlannedRemove,
  type PlannedWrite,
  type ShownEquipment,
  type ShownProfile,
  type TabletHoldings,
  beanWrites,
  equipmentWrites,
  grinderWrites,
  profileWrites,
  recipeWrites,
} from "./holdings.js";
import type { AnswerRecorded, AnsweringTablet, ReportingTablet, SeenDecision } from "./intake.js";
import type { FieldType } from "./item-input.js";
import { recordLoadedRecipeWritten } from "../machine-events/loaded-recipes.js";
import { recordWorkflowCleared } from "./joining.js";
import { isObject } from "./listed.js";
import { addBatchAt, enterRemainingWeight, finishBatchAt, showAt, showProfileAt } from "./location-state.js";
import { type FieldEdits, latestDecision, readFieldEdits } from "./merge.js";
import { profileText } from "./profile-intake.js";
import { recordProfileWritten, takeInProfiles } from "./profiles.js";
import { recipeView } from "./recipe-intake.js";
import { heldRecipes, offeredRecipes, recordRecipeWritten, takeInRecipes } from "./recipes.js";

// Each kind the server writes to tablets, described once (`LIBRARY.md`,
// Adding a Library kind): the Library's kinds, Beans, Bean Batches, Grinders,
// Profiles, Baskets, Tools and Recipes, in the order of LIBRARY_ITEM_KINDS (protocol/), the
// clearing of a Workflow's grinder, batch and Basket, and a Workflow's Loaded
// Recipe. What the server does to every kind alike
// (its versions and Conflicts, the edits of its content, what a tablet is
// due, its hard deletes, what a joining tablet brings) reads each kind's
// table, columns, content and SQL from here, and what only one kind does is
// in its own modules (beans.ts, bean-batches.ts, grinders.ts, profiles.ts,
// equipment.ts, recipes.ts, joining.ts and loaded-recipes.ts), which this binds to it.
//
// This imports those modules, which import what reads this: each binds
// them in a function, called once every module has loaded, and none of them
// reads a description as it loads, so the import cycle is harmless.

/** What a write's answer recorded as the tablet's record of an item says (`ItemWritten`), as the gateway reads it. */
export interface WrittenAnswer {
  /** The write's global id, which the record must be the item of. */
  globalId: string;
  /** The fields the write set. */
  written: ReadonlySet<string>;
  /** The record as Decaid returned it. */
  record: Record<string, unknown>;
  /** The record's `updatedAt` in UTC, or when the plugin had Decaid's answer for a Workflow, which carries none. */
  updatedAt: string | null;
  /** The decision of its Location's state the write carried, if it was awaited. */
  seen: SeenDecision | null;
  /** When the latest edit of the item's content the write carried was decided. */
  contentSeen: Date | null;
  /** Whether the plugin linked a record of the same item rather than creating one (`ItemWritten.linked`). */
  linked: boolean;
}

/** What the server says of every kind it writes to tablets. */
export interface WrittenKindDescription {
  /** What the server's log and its errors call it, such as Bean Batch. */
  name: string;
  /**
   * What the management interface names each of the items with these ids
   * by (`ChangedItemView`, `ConflictItemView`): a Bean's roaster and name, a
   * batch's Bean and roast date, a Grinder's model, a Profile's title, a
   * Workflow's "Grinder and
   * batch"; null where its content has none. A Library item the server no
   * longer has is left out.
   */
  itemNames(db: Prisma.TransactionClient, ids: readonly string[]): Promise<Map<string, string | null>>;
  /** Records a write's answer as the tablet's record of the item, as `recordAnswer` in sync.gateway.ts does for every kind. */
  recordWritten(prisma: PrismaService, tablet: AnsweringTablet, answer: WrittenAnswer): Promise<AnswerRecorded>;
}

/** An item as a Conflict about it reads it now: its name, its values as edits merge them, and their latest edits. */
export interface VersionedItem {
  name: string | null;
  /** Its content as edits merge it (`LibraryKindDescription.values`). */
  values: Record<string, unknown>;
  fieldEdits: FieldEdits;
  /** For a kind that belongs to one Location (`belongsToLocation`), that Location, null if it no longer exists; undefined otherwise. */
  locationId?: string | null;
}

/** What the server says of every kind that keeps versions and Conflicts (ADR-0020): the Library's kinds. */
export interface VersionedKindDescription extends WrittenKindDescription {
  /** Its table, whose rows `versioned_items` keeps a row for (the migration's triggers), and the type of their `id`. */
  table: string;
  idType: "uuid" | "text";
  /** The items with these ids as Conflicts about them read them; an item the server no longer has is left out. */
  read(db: Prisma.TransactionClient, ids: readonly string[]): Promise<Map<string, VersionedItem>>;
}

/**
 * A field of a Location's state of an item (ADR-0020), such as whether a
 * batch is at the Location: its value now, and the version that set it.
 */
export interface StateValue {
  value: unknown;
  versionId: string | null;
}

/** A Location's own state of the items of a kind (location-state.ts), each part a field of its own with versions and Conflicts. */
export interface LocationStateDescription {
  /** Each field of a Location's state of an item, as versions and Conflicts name it. */
  fields: readonly string[];
  /** Each field's value now at each Location, in the order given; a field the Location never decided is as it reads without a decision. */
  current(db: Prisma.TransactionClient, fields: readonly { itemId: string; locationId: string; field: string }[]): Promise<StateValue[]>;
  /**
   * Makes a value of a field of the Location's state the field's latest
   * edit, by `source`, made over the value now, which has seen every
   * decision made there before `seenAt`, under the Location's lock. Throws
   * for a value the field cannot take, which no Conflict about it holds.
   */
  use(tx: Prisma.TransactionClient, itemId: string, locationId: string, field: string, value: unknown, at: Date, seenAt: Date, source: EditSource): Promise<void>;
}

/** What the planner of a tablet's writes reads of a kind (holdings.ts): its part of what a Location offers and of what the tablet holds. */
type HoldingsKey = keyof LocationOffer & keyof TabletHoldings;

/** Reads a kind's part of what a Location offers and what the tablet holds, as holdings.ts plans their writes. */
type HoldingsReader = {
  [K in HoldingsKey]: {
    /** Its part of `LocationOffer` and `TabletHoldings`. */
    key: K;
    /** What the Location offers the tablet of that Machine, and its state of each item, in the order to write it: oldest first. */
    offered(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string): Promise<LocationOffer[K]>;
    /** The tablet's records, with the content of their items, by its map. */
    held(tx: Prisma.TransactionClient, tabletId: string, locationId: string): Promise<HeldRecord[]>;
  };
}[HoldingsKey];

/** What the management interface may set of a kind's content (item-input.ts): each field's type, and what Decaid makes a new record hold where it is not sent a value. */
export interface EditableContent {
  fields: Readonly<Record<string, FieldType>>;
  defaults: Readonly<Record<string, unknown>>;
}

/** What the server says of a kind of Library item. */
export interface LibraryKindDescription extends VersionedKindDescription {
  /** The tablet's list of its records, which is taken into the Library (`LIBRARY_ITEM_KINDS`). */
  list: LibraryList;
  /** Each tablet's map of its records (`tablet_beans` and the like), and the column there naming the item. */
  map: { table: string; column: string };
  /**
   * Whether its records carry its global id (ADR-0006), a UUID the server
   * gives it, so a kind whose records do has `idType` `uuid`, and its global
   * ids are kept as `deleted_items` keeps them once hard-deleted. A
   * Profile's do not, as its id is Decaid's, the same on every tablet, which
   * its records have as theirs.
   */
  carriesGlobalId: boolean;
  /** For a kind whose records are made under another's (`LibraryKindDescription.under` in protocol/), its column naming that item, and the field of its tablet's records naming that item's record there. */
  parent?: { column: string; recordField: string };
  /** Whether each item belongs to one Location (`location_id`), as a Grinder does, offered only there: Staff edit its content only there, and its Archived state changes only under that Location's lock. */
  belongsToLocation: boolean;
  /** Whether its Archived state is a field of its content, merged as its content is, as a Grinder's is, Archived and restored on tablets at its Location (ADR-0019). */
  archivedIsContent: boolean;
  /** The field of its content holding what edits merge, as a Profile's title, author and notes are in its `profile`; null where they are its content's own. */
  editedIn: string | null;
  /** The values edits merge, from its content as the Library keeps it. */
  values(content: Record<string, unknown>): Record<string, unknown>;
  /** The values edits merge, from a tablet's record of it, as Decaid sends it. */
  recordValues(record: Record<string, unknown>): Record<string, unknown>;
  /** Columns kept from its content, set as an edit changes it, such as a Bean's roaster and name as Beans are matched; empty for none. */
  keptColumns(content: Record<string, unknown>): Prisma.Sql;
  /** What the management interface may set of its content; null where it never sets it, as a Profile's comes from tablets. */
  editable: EditableContent | null;
  /** Its columns on a Shot, for a kind a Shot names by its id on the tablet that pulled it (shots/links.ts): that id, and the item it links to. */
  shotLink?: { local: string; link: string };
  /** Its part of what a Location offers and a tablet holds (tablet-due.ts). */
  holdings: HoldingsReader;
  /** The writes that bring a tablet's records of it to what its Location offers (holdings.ts); absent for a kind planned with the kind its records are made under, as a batch with its Bean. */
  plan?(offer: LocationOffer, held: TabletHoldings): (PlannedWrite | PlannedRemove)[];
  /** A query finding whether the Location offers any item of it, but those every tablet has, which a joining tablet does not bring (left-out.ts). */
  offersAnySql(locationId: string): Prisma.Sql;
  /** The Locations whose state of these items a hard delete changes, as `id` text. */
  stateLocationsSql(ids: readonly string[]): Prisma.Sql;
  /** Whether a Shot names one of these items, which a hard delete refuses; false SQL for a kind no Shot names but through another. */
  shotsNameSql(ids: readonly string[]): Prisma.Sql;
  /** What a hard delete refused as a Shot names it says it named. */
  namedAs: string;
  /** Whether a Recipe names one of these items, which a hard delete refuses too, for a Basket or Tool; absent for a kind whose Recipes are left naming one deleted. */
  recipesNameSql?(ids: readonly string[]): Prisma.Sql;
  /** Why the item cannot be hard-deleted at all, as one of Decaid's bundled Profiles, or null. */
  undeletable(tx: Prisma.TransactionClient, id: string): Promise<string | null>;
  /** Keeps each tablet's record of a hard-deleted item as due to be deleted there (`tablet_deletions`), and its global id (`deleted_items`) if its records carry one. */
  keepDeletion(tx: Prisma.TransactionClient, id: string): Promise<void>;
  /** Whether a delete due of the tablet's record `due` (`tablet_deletions`) is held back, its record kept on the tablet, as one a Shot names. */
  deleteHeldSql(due: Prisma.Sql): Prisma.Sql;
  /** A Location's own state of its items, for a kind whose state differs by Location; absent for one that has none. */
  state?: LocationStateDescription;
  /** Takes a tablet's report of its list into the Library, in the transaction storing it, and says where (`standing`), or null where it was taken in nowhere. */
  takeIn(tx: Prisma.TransactionClient, tablet: ReportingTablet, value: unknown, updatedAt: readonly (string | null)[] | undefined): Promise<string | null>;
}

const BEAN_FIELDS: Readonly<Record<string, FieldType>> = {
  roaster: "name",
  name: "name",
  species: "text",
  decaf: "flag",
  decafProcess: "text",
  country: "text",
  region: "text",
  producer: "text",
  variety: "texts",
  altitude: "wholeNumbers",
  processing: "text",
  notes: "text",
};

const BATCH_FIELDS: Readonly<Record<string, FieldType>> = {
  roastDate: "date",
  roastLevel: "text",
  harvestDate: "text",
  qualityScore: "number",
  price: "number",
  currency: "text",
  weight: "number",
  buyDate: "date",
  openDate: "date",
  bestBeforeDate: "date",
  freezeDate: "date",
  unfreezeDate: "date",
  frozen: "flag",
  notes: "text",
};

const GRINDER_FIELDS: Readonly<Record<string, FieldType>> = {
  model: "name",
  burrs: "text",
  burrSize: "number",
  burrType: "text",
  notes: "text",
  settingType: "settingType",
  settingValues: "texts",
  settingSmallStep: "number",
  settingBigStep: "number",
  rpmSmallStep: "number",
  rpmBigStep: "number",
};

/** A Basket's fields, as DYE2's baskets page saves them. */
const BASKET_FIELDS: Readonly<Record<string, FieldType>> = {
  name: "name",
  size: "basketSize",
  diameterMm: "number",
  notes: "text",
};

/** A Tool's fields, as DYE2's equipment page saves them: its name, and its attributes as `custom`. */
const TOOL_FIELDS: Readonly<Record<string, FieldType>> = {
  name: "name",
  custom: "attributes",
};

/**
 * A Recipe's fields the management interface sets, in the Library's terms
 * (`recipeContent` in recipe-intake.ts), as DYE2's recipe editor saves them
 * but for the barista and drinker, which a Recipe never carries, its steam
 * and hot water modes, which are only which value DYE2's stepper shows, and
 * its ratio, kept while its yield is its dose times it
 * (recipe-edits.service.ts). Its Bean is its Bean Batch's. Its grind
 * setting is a number, or text as typed, as DYE2 v0.1.32 keeps one
 * (`grindSettingOf`). Each steam, hot water and flush setting is held or
 * not, null for the Machine's own, and is checked against the range DYE2's
 * editor offers, a whole number where Decaid's field is an int: a steam
 * temperature with no "Off", and a milk stop of 0 for off. Whether it is
 * shown on Streamline's strip is no field of its own: it is shown exactly
 * while it is in a slot (recipes.ts).
 */
const RECIPE_FIELDS: Readonly<Record<string, FieldType>> = {
  name: "text",
  beverage: "text",
  beanBatchId: "id",
  profileId: "profileId",
  dose: "number",
  yield: "number",
  grinderId: "id",
  grindSetting: "grindSetting",
  rpm: "number",
  brewTemperature: "number",
  basketId: "id",
  toolIds: "ids",
  toolAttributes: "toolAttributes",
  steamTemperature: { min: 135, max: 170, whole: true },
  steamDuration: { min: 0, whole: true },
  steamFlow: { min: 0 },
  steamStopTemperature: { min: 30, max: 80, offAtZero: true },
  hotWaterTemperature: { min: 0, whole: true },
  hotWaterDuration: { min: 5, max: 120, whole: true },
  hotWaterVolume: { min: 0, whole: true },
  hotWaterFlow: { min: 0.5, max: 8 },
  flushTemperature: { min: 5, max: 95, whole: true },
  flushDuration: { min: 0, whole: true },
  flushFlow: { min: 1, max: 8 },
};

/** Each kind of Library item, described once. */
export const KINDS: { readonly [K in LibraryKind]: LibraryKindDescription } = {
  bean: {
    name: "Bean",
    list: LIBRARY_ITEM_KINDS.bean.list,
    table: "beans",
    idType: "uuid",
    map: { table: "tablet_beans", column: "bean_id" },
    carriesGlobalId: true,
    belongsToLocation: false,
    archivedIsContent: false,
    editedIn: null,
    values: (content) => content,
    recordValues: (record) => beanContent(record),
    keptColumns: (content) =>
      typeof content.roaster === "string" && typeof content.name === "string"
        ? Prisma.sql`, match_key = ${beanMatchKey(content.roaster, content.name)}`
        : Prisma.empty,
    editable: { fields: BEAN_FIELDS, defaults: { decaf: false } },
    holdings: {
      key: "beans",
      // Each with the latest decision of whether any of its batches is there: a write to the Bean carries it.
      offered: async (tx, _tablet, locationId) =>
        (
          await tx.$queryRaw<(Omit<OfferedBean, "contentDecidedAt"> & Edited)[]>`
            SELECT beans.id, beans.content, ${presenceDecidedSql(Prisma.raw("beans.id"), locationId)} AS "decidedAt", beans.field_edits AS "fieldEdits" FROM beans
            WHERE ${beanOfferedSql(locationId)}
            ORDER BY beans.created_at, beans.id`
        ).map(edited),
      held: async (tx, tabletId, locationId) =>
        (
          await tx.$queryRaw<HeldRow[]>`
            SELECT held.bean_id AS "itemId", held.local_id AS "localId", held.record, ${presenceDecidedSql(Prisma.raw("held.bean_id"), locationId)} AS "decidedAt",
              beans.content, beans.field_edits AS "fieldEdits"
            FROM tablet_beans AS held JOIN beans ON beans.id = held.bean_id WHERE held.tablet_id = ${tabletId}::uuid ORDER BY held.bean_id`
        ).map((row) => heldRecord(row)),
    },
    plan: (offer, held) => beanWrites(offer, held),
    offersAnySql: (locationId) => Prisma.sql`SELECT 1 FROM beans WHERE ${beanOfferedSql(locationId)} LIMIT 1`,
    stateLocationsSql: (ids) => Prisma.sql`SELECT location_id::text AS id FROM bean_origins WHERE bean_id = ANY(${ids}::uuid[])`,
    // Named only through its batches, which go with it.
    shotsNameSql: () => Prisma.sql`false`,
    namedAs: "one of this Bean's batches",
    undeletable: async () => null,
    keepDeletion: (tx, id) => keepRecordDeletions(tx, "bean", id),
    // Its record is deleted only once its batches' are, so it is kept while a Shot names one of them.
    deleteHeldSql: (due) => Prisma.sql`EXISTS (
      SELECT 1 FROM tablet_deletions AS batch JOIN shots ON shots.bean_batch_id = batch.local_id
      WHERE batch.tablet_id = ${due}.tablet_id AND batch.kind = 'beanBatch' AND batch.bean_local_id = ${due}.local_id
    )`,
    read: async (db, ids) =>
      versionedRows(
        await db.$queryRaw<ItemRow[]>`SELECT id::text AS id, content, field_edits AS "fieldEdits" FROM beans WHERE id = ANY(${uuids(ids)}::uuid[])`,
        (row) => ({ name: beanName(row.content), values: fields(row.content) }),
      ),
    itemNames: (db, ids) => namesOf(KINDS.bean, db, ids),
    takeIn: (tx, tablet, value, updatedAt) => takeInBeans(tx, tablet, value, updatedAt),
    recordWritten: (prisma, tablet, answer) =>
      recordBeanWritten(prisma, tablet, answer.globalId, answer.written, answer.record, answer.updatedAt, answer.seen, answer.contentSeen, answer.linked),
  },
  beanBatch: {
    name: "Bean Batch",
    list: LIBRARY_ITEM_KINDS.beanBatch.list,
    table: "bean_batches",
    idType: "uuid",
    map: { table: "tablet_bean_batches", column: "batch_id" },
    carriesGlobalId: true,
    parent: { column: "bean_id", recordField: "beanId" },
    belongsToLocation: false,
    archivedIsContent: false,
    editedIn: null,
    values: (content) => content,
    recordValues: (record) => batchContent(record),
    keptColumns: () => Prisma.empty,
    editable: { fields: BATCH_FIELDS, defaults: { frozen: false } },
    shotLink: { local: "bean_batch_id", link: "library_batch_id" },
    holdings: {
      key: "batches",
      // The batches the Location offers, then the others the tablet holds, each with its state there.
      offered: async (tx, { tabletId }, locationId) =>
        (
          await tx.$queryRaw<(Omit<LocationBatch, "remainingWeight" | "contentDecidedAt"> & Edited & { remainingWeight: number | null; entered: boolean })[]>`
            SELECT batch.id, batch.bean_id AS "beanId", batch.content, batch.field_edits AS "fieldEdits",
              (here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived) AS offered,
              here.remaining_weight AS "remainingWeight", here.remaining_weight_at IS NOT NULL AS entered, here.presence_decided_at AS "decidedAt"
            FROM bean_batches AS batch
            JOIN beans AS bean ON bean.id = batch.bean_id
            LEFT JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
            WHERE (here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived)
              OR EXISTS (SELECT 1 FROM tablet_bean_batches AS held WHERE held.batch_id = batch.id AND held.tablet_id = ${tabletId}::uuid)
            ORDER BY 5 DESC, batch.created_at, batch.id`
        ).map(({ entered, remainingWeight, ...batch }) => ({ ...edited(batch), remainingWeight: entered ? remainingWeight : undefined })),
      held: async (tx, tabletId) =>
        (
          await tx.$queryRaw<HeldRow[]>`
            SELECT held.batch_id AS "itemId", held.local_id AS "localId", held.record, batch.content, batch.field_edits AS "fieldEdits"
            FROM tablet_bean_batches AS held JOIN bean_batches AS batch ON batch.id = held.batch_id
            WHERE held.tablet_id = ${tabletId}::uuid ORDER BY held.batch_id`
        ).map((row) => heldRecord(row)),
    },
    offersAnySql: (locationId) => Prisma.sql`
      SELECT 1 FROM bean_batches AS batch
      JOIN beans AS bean ON bean.id = batch.bean_id
      JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
      WHERE here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived LIMIT 1`,
    stateLocationsSql: (ids) => Prisma.sql`SELECT location_id::text AS id FROM batch_locations WHERE batch_id = ANY(${ids}::uuid[])`,
    // A Shot names a batch by its id on the tablet that pulled it, so one whose record has that id on any tablet's map is named,
    // as is one a Shot is linked to, whose record may have left the map since.
    shotsNameSql: (ids) => Prisma.sql`(
      EXISTS (SELECT 1 FROM shots JOIN tablet_bean_batches AS held ON held.local_id = shots.bean_batch_id WHERE held.batch_id = ANY(${ids}::uuid[]))
      OR ${shotLinkedSql("beanBatch", ids)}
    )`,
    namedAs: "this Bean Batch",
    undeletable: async () => null,
    keepDeletion: (tx, id) => keepRecordDeletions(tx, "beanBatch", id),
    deleteHeldSql: (due) => Prisma.sql`EXISTS (SELECT 1 FROM shots WHERE shots.bean_batch_id = ${due}.local_id)`,
    state: {
      fields: ["atLocation", "remainingWeight"],
      current: async (db, wanted) => {
        const rows = await db.$queryRaw<{ itemId: string; locationId: string; at: boolean; remainingWeight: number | null; presenceVersionId: string | null; weightVersionId: string | null }[]>`
          SELECT batch_id::text AS "itemId", location_id::text AS "locationId", (added_at IS NOT NULL AND finished_at IS NULL) AS at, remaining_weight AS "remainingWeight",
            presence_version_id::text AS "presenceVersionId", remaining_weight_version_id::text AS "weightVersionId"
          FROM batch_locations
          WHERE (batch_id, location_id) IN (SELECT * FROM unnest(${uuidsOf(wanted, "itemId")}::uuid[], ${uuidsOf(wanted, "locationId")}::uuid[]))`;
        const states = new Map(rows.map((row) => [`${row.itemId}/${row.locationId}`, row]));
        return wanted.map(({ itemId, locationId, field }) => {
          const here = states.get(`${itemId.toLowerCase()}/${locationId.toLowerCase()}`);
          if (field === "remainingWeight") return { value: here?.remainingWeight ?? null, versionId: here?.weightVersionId ?? null };
          // A batch never added at the Location is not there.
          return { value: here?.at ?? false, versionId: here?.presenceVersionId ?? null };
        });
      },
      use: async (tx, batchId, locationId, field, value, at, seenAt, source) => {
        if (field === "atLocation" && typeof value === "boolean") {
          await (value ? addBatchAt : finishBatchAt)(tx, batchId, locationId, at, seenAt, source);
        } else if (field === "remainingWeight" && (typeof value === "number" || value === null)) {
          const [here] = await tx.$queryRaw<{ weight: number | null }[]>`
            SELECT remaining_weight AS weight FROM batch_locations WHERE batch_id = ${batchId}::uuid AND location_id = ${locationId}::uuid`;
          await enterRemainingWeight(tx, batchId, locationId, { value, had: here?.weight ?? null }, at, source);
        } else {
          throw new Error(`A Conflict about ${field} at a Location cannot be used`);
        }
      },
    },
    read: async (db, ids) =>
      versionedRows(
        await db.$queryRaw<(ItemRow & { beanContent: unknown })[]>`
          SELECT batch.id::text AS id, batch.content, batch.field_edits AS "fieldEdits", bean.content AS "beanContent"
          FROM bean_batches AS batch JOIN beans AS bean ON bean.id = batch.bean_id WHERE batch.id = ANY(${uuids(ids)}::uuid[])`,
        (row) => ({ name: batchName(row.content, row.beanContent), values: fields(row.content) }),
      ),
    itemNames: (db, ids) => namesOf(KINDS.beanBatch, db, ids),
    takeIn: (tx, tablet, value, updatedAt) => takeInBatches(tx, tablet, value, updatedAt),
    recordWritten: (prisma, tablet, answer) =>
      recordBatchWritten(prisma, tablet, answer.globalId, answer.written, answer.record, answer.updatedAt, answer.seen, answer.contentSeen),
  },
  grinder: {
    name: "Grinder",
    list: LIBRARY_ITEM_KINDS.grinder.list,
    table: "grinders",
    idType: "uuid",
    map: { table: "tablet_grinders", column: "grinder_id" },
    carriesGlobalId: true,
    belongsToLocation: true,
    archivedIsContent: true,
    editedIn: null,
    values: (content) => content,
    recordValues: (record) => grinderContent(record),
    keptColumns: () => Prisma.empty,
    editable: { fields: GRINDER_FIELDS, defaults: { settingType: "numeric" } },
    shotLink: { local: "grinder_id", link: "library_grinder_id" },
    holdings: {
      key: "grinders",
      offered: async (tx, _tablet, locationId) =>
        (
          await tx.$queryRaw<(Omit<OfferedGrinder, "contentDecidedAt"> & Edited)[]>`
            SELECT id, content, field_edits AS "fieldEdits" FROM grinders WHERE location_id = ${locationId}::uuid AND NOT archived ORDER BY created_at, id`
        ).map(edited),
      held: async (tx, tabletId) =>
        (
          await tx.$queryRaw<HeldRow[]>`
            SELECT held.grinder_id AS "itemId", held.local_id AS "localId", held.record, grinders.content, grinders.field_edits AS "fieldEdits"
            FROM tablet_grinders AS held JOIN grinders ON grinders.id = held.grinder_id WHERE held.tablet_id = ${tabletId}::uuid ORDER BY held.grinder_id`
        ).map((row) => heldRecord(row)),
    },
    plan: (offer, held) => grinderWrites(offer, held),
    offersAnySql: (locationId) => Prisma.sql`SELECT 1 FROM grinders WHERE location_id = ${locationId}::uuid AND NOT archived LIMIT 1`,
    stateLocationsSql: (ids) => Prisma.sql`SELECT location_id::text AS id FROM grinders WHERE id = ANY(${ids}::uuid[]) AND location_id IS NOT NULL`,
    shotsNameSql: (ids) => Prisma.sql`(
      EXISTS (SELECT 1 FROM shots JOIN tablet_grinders AS held ON held.local_id = shots.grinder_id WHERE held.grinder_id = ANY(${ids}::uuid[]))
      OR ${shotLinkedSql("grinder", ids)}
    )`,
    namedAs: "this Grinder",
    undeletable: async () => null,
    keepDeletion: (tx, id) => keepRecordDeletions(tx, "grinder", id),
    deleteHeldSql: (due) => Prisma.sql`EXISTS (SELECT 1 FROM shots WHERE shots.grinder_id = ${due}.local_id)`,
    read: async (db, ids) =>
      versionedRows(
        await db.$queryRaw<(ItemRow & { archived: boolean; locationId: string | null })[]>`
          SELECT id::text AS id, content, field_edits AS "fieldEdits", archived, location_id::text AS "locationId" FROM grinders WHERE id = ANY(${uuids(ids)}::uuid[])`,
        (row) => ({ name: text(fields(row.content).model), values: { ...fields(row.content), archived: row.archived }, locationId: row.locationId }),
      ),
    itemNames: (db, ids) => namesOf(KINDS.grinder, db, ids),
    takeIn: (tx, tablet, value, updatedAt) => takeInGrinders(tx, tablet, value, updatedAt),
    recordWritten: (prisma, tablet, answer) =>
      recordGrinderWritten(prisma, tablet, answer.globalId, answer.written, answer.record, answer.updatedAt, answer.contentSeen),
  },
  profile: {
    name: "Profile",
    list: LIBRARY_ITEM_KINDS.profile.list,
    table: "profiles",
    idType: "text",
    map: { table: "tablet_profiles", column: "profile_id" },
    carriesGlobalId: false,
    belongsToLocation: false,
    archivedIsContent: false,
    editedIn: "profile",
    values: (content) => profileText(content),
    recordValues: (record) => profileText(record),
    keptColumns: () => Prisma.empty,
    editable: null,
    holdings: {
      key: "profiles",
      // Each Profile's content only where the tablet lacks it, to create its record with: what a Location shows is many and large.
      offered: async (tx, { tabletId }, locationId) =>
        (
          await tx.$queryRaw<(Omit<ShownProfile, "contentDecidedAt"> & Edited)[]>`
            SELECT profiles.id, profiles.bundled, here.decided_at AS "decidedAt", profiles.field_edits AS "fieldEdits",
              CASE WHEN held.profile_id IS NULL AND NOT profiles.bundled THEN profiles.content END AS content
            FROM profiles
            JOIN profile_locations AS here ON here.profile_id = profiles.id AND here.location_id = ${locationId}::uuid AND here.shown
            LEFT JOIN tablet_profiles AS held ON held.profile_id = profiles.id AND held.tablet_id = ${tabletId}::uuid
            WHERE NOT profiles.archived
            ORDER BY profiles.created_at, profiles.id`
        ).map(edited),
      // Each with when the Location last decided whether it shows it: a write hiding it carries that decision. Only a Profile's
      // visibility and its title, author and notes are compared, of each record and of a user's Profile's content.
      held: async (tx, tabletId, locationId) =>
        (
          await tx.$queryRaw<HeldRow[]>`
            SELECT held.profile_id AS "itemId", held.profile_id AS "localId",
              jsonb_build_object('visibility', held.record -> 'visibility', 'profile', ${profileTextSql(Prisma.raw("held.record"))}) AS record,
              here.decided_at AS "decidedAt", CASE WHEN NOT profiles.bundled THEN jsonb_build_object('profile', ${profileTextSql(Prisma.raw("profiles.content"))}) END AS content,
              profiles.field_edits AS "fieldEdits"
            FROM tablet_profiles AS held
            JOIN profiles ON profiles.id = held.profile_id
            LEFT JOIN profile_locations AS here ON here.profile_id = held.profile_id AND here.location_id = ${locationId}::uuid
            WHERE held.tablet_id = ${tabletId}::uuid ORDER BY held.profile_id`
        ).map((row) => heldRecord(row, (content) => profileText(content))),
    },
    plan: (offer, held) => profileWrites(offer, held),
    // Decaid's bundled Profiles, which every tablet has, are no reason to leave a joining tablet's own out.
    offersAnySql: (locationId) => Prisma.sql`
      SELECT 1 FROM profiles
      JOIN profile_locations AS here ON here.profile_id = profiles.id AND here.location_id = ${locationId}::uuid AND here.shown
      WHERE NOT profiles.archived AND NOT profiles.bundled LIMIT 1`,
    stateLocationsSql: (ids) => Prisma.sql`SELECT location_id::text AS id FROM profile_locations WHERE profile_id = ANY(${ids}::text[])`,
    shotsNameSql: (ids) => Prisma.sql`EXISTS (
      SELECT 1 FROM profiles WHERE id = ANY(${ids}::text[])
        AND ${shotNamesProfileSql(Prisma.sql`profiles.id`, Prisma.sql`profiles.content -> 'profile' -> 'steps'`)}
    )`,
    namedAs: "this Profile",
    undeletable: async (tx, id) =>
      (await tx.profile.count({ where: { id, bundled: true } })) > 0
        ? "Decaid's bundled Profiles cannot be deleted from tablets: hide it at each Location, or Archive it"
        : null,
    // A Profile's record is named by its id, which is Decaid's, and keeps its steps, which a Shot that used it recorded. Its
    // id is not kept: one a tablet reports later, as when a barista makes it again, joins the Library anew.
    keepDeletion: async (tx, id) => {
      await tx.$executeRaw`
        INSERT INTO tablet_deletions (tablet_id, kind, local_id, item_id, profile_steps)
        SELECT held.tablet_id, 'profile', held.profile_id, held.profile_id, profiles.content -> 'profile' -> 'steps'
        FROM tablet_profiles AS held JOIN profiles ON profiles.id = held.profile_id WHERE held.profile_id = ${id}
        ON CONFLICT DO NOTHING`;
    },
    deleteHeldSql: (due) => Prisma.sql`(
      ${shotNamesProfileSql(Prisma.sql`${due}.local_id`, Prisma.sql`${due}.profile_steps`)}
      -- Joined the Library again: the record is the Library's Profile's.
      OR EXISTS (SELECT 1 FROM profiles WHERE profiles.id = ${due}.local_id)
    )`,
    state: {
      fields: ["shown"],
      current: async (db, wanted) => {
        const rows = await db.$queryRaw<{ itemId: string; locationId: string; shown: boolean; versionId: string | null }[]>`
          SELECT profile_id AS "itemId", location_id::text AS "locationId", shown, version_id::text AS "versionId"
          FROM profile_locations
          WHERE (profile_id, location_id) IN (SELECT * FROM unnest(${wanted.map((row) => row.itemId)}::text[], ${uuidsOf(wanted, "locationId")}::uuid[]))`;
        const states = new Map(rows.map((row) => [`${row.itemId}/${row.locationId}`, row]));
        // A Profile its Location never decided is not shown there.
        return wanted.map(({ itemId, locationId }) => {
          const here = states.get(`${itemId}/${locationId.toLowerCase()}`);
          return { value: here?.shown ?? false, versionId: here?.versionId ?? null };
        });
      },
      use: async (tx, profileId, locationId, field, value, at, seenAt, source) => {
        if (field !== "shown" || typeof value !== "boolean") throw new Error(`A Conflict about ${field} at a Location cannot be used`);
        await showProfileAt(tx, profileId, locationId, source, value, at, seenAt);
      },
    },
    read: async (db, ids) =>
      versionedRows(
        await db.$queryRaw<ItemRow[]>`SELECT id, content, field_edits AS "fieldEdits" FROM profiles WHERE id = ANY(${[...ids]}::text[])`,
        (row) => ({ name: text(fields(fields(row.content).profile).title), values: profileText(fields(row.content)) }),
      ),
    itemNames: (db, ids) => namesOf(KINDS.profile, db, ids),
    takeIn: (tx, tablet, value, updatedAt) => takeInProfiles(tx, tablet, value, updatedAt),
    recordWritten: (prisma, tablet, answer) =>
      recordProfileWritten(prisma, tablet, answer.globalId, answer.written, answer.record, answer.updatedAt, answer.seen, answer.contentSeen),
  },
  basket: equipmentKind("basket", "Basket", { table: "baskets", map: "tablet_baskets", column: "basket_id", shown: "basket_locations" }, { fields: BASKET_FIELDS, defaults: {} }),
  // DYE2's page saves a Tool's attributes, none if none are entered.
  tool: equipmentKind("tool", "Tool", { table: "tools", map: "tablet_tools", column: "tool_id", shown: "tool_locations" }, { fields: TOOL_FIELDS, defaults: { custom: [] } }),
  // DYE2's recipes (ADR-0005): each belongs to one Location, under one record id there, in one of its slots or none, and
  // names the items it uses.
  recipe: {
    name: "Recipe",
    list: LIBRARY_ITEM_KINDS.recipe.list,
    table: "recipes",
    idType: "uuid",
    map: { table: "tablet_recipes", column: "recipe_id" },
    carriesGlobalId: true,
    belongsToLocation: true,
    archivedIsContent: false,
    editedIn: null,
    values: (content) => content,
    // A tablet's record names what it uses by the tablet's ids, so its content is written by the paths the server writes.
    recordValues: (record) => recipeView(record),
    keptColumns: () => Prisma.empty,
    // DYE2's editor shows a new recipe's steam by flow and its hot water by volume. A new Recipe holds no steam, hot water
    // or flush setting, so a Machine loading it keeps its own.
    editable: { fields: RECIPE_FIELDS, defaults: { steamMode: "flow", hotWaterMode: "vol" } },
    holdings: { key: "recipes", offered: (tx, tablet, locationId) => offeredRecipes(tx, tablet, locationId), held: (tx, tabletId) => heldRecipes(tx, tabletId) },
    plan: (offer, held) => recipeWrites(offer, held),
    offersAnySql: (locationId) => Prisma.sql`SELECT 1 FROM recipes WHERE location_id = ${locationId}::uuid AND NOT archived LIMIT 1`,
    stateLocationsSql: (ids) => Prisma.sql`SELECT location_id::text AS id FROM recipes WHERE id = ANY(${ids}::uuid[]) AND location_id IS NOT NULL`,
    // A Shot names a Recipe by its record id, through its tablet's map as it is stored, and is linked to it only where its
    // Machine had the Recipe loaded (shots/links.ts): a Capture-only Machine's Shots name one it never had. A record of
    // one a Shot names is never held back on a tablet: only a Shot linked to it names it.
    shotsNameSql: (ids) => shotLinkedToRecipesSql(ids),
    namedAs: "this Recipe",
    undeletable: async () => null,
    keepDeletion: (tx, id) => keepRecordDeletions(tx, "recipe", id),
    deleteHeldSql: () => Prisma.sql`false`,
    read: async (db, ids) =>
      versionedRows(
        await db.$queryRaw<(ItemRow & { locationId: string | null })[]>`
          SELECT id::text AS id, content, field_edits AS "fieldEdits", location_id::text AS "locationId" FROM recipes WHERE id = ANY(${uuids(ids)}::uuid[])`,
        (row) => ({ name: text(fields(row.content).name), values: fields(row.content), locationId: row.locationId }),
      ),
    itemNames: (db, ids) => namesOf(KINDS.recipe, db, ids),
    takeIn: (tx, tablet, value, updatedAt) => takeInRecipes(tx, tablet, value, updatedAt),
    recordWritten: (prisma, tablet, answer) =>
      recordRecipeWritten(prisma, tablet, answer.globalId, answer.written, answer.record, answer.updatedAt, answer.contentSeen, answer.linked),
  },
};

/**
 * A kind DYE2 keeps in a list of Decaid's store, Baskets or Tools (ADR-0005):
 * in the Library, and shown or hidden at each Location as a Profile is
 * (ADR-0008), its records carrying their global id in a top-level field of
 * their own. Neither belongs to a Location. A Shot names each by its id on
 * the tablet that pulled it, a Basket linked to it as a batch is (#147), its
 * Tools not; and a Recipe names each by its global id.
 */
function equipmentKind(
  kind: EquipmentKind,
  name: string,
  tables: { table: string; map: string; column: string; shown: string },
  editable: EditableContent,
): LibraryKindDescription {
  const table = Prisma.raw(tables.table);
  const map = Prisma.raw(tables.map);
  const column = Prisma.raw(tables.column);
  const shown = Prisma.raw(tables.shown);
  const shownHere = (locationId: string) => Prisma.sql`
    JOIN ${shown} AS here ON here.${column} = items.id AND here.location_id = ${locationId}::uuid AND here.shown`;
  return {
    name,
    list: LIBRARY_ITEM_KINDS[kind].list,
    table: tables.table,
    idType: "uuid",
    map: { table: tables.map, column: tables.column },
    carriesGlobalId: true,
    belongsToLocation: false,
    archivedIsContent: false,
    editedIn: null,
    values: (content) => content,
    recordValues: (record) => equipmentContent(record),
    keptColumns: (content) => (typeof content.name === "string" ? Prisma.sql`, match_key = ${equipmentMatchKey(content.name)}` : Prisma.empty),
    editable,
    holdings: {
      key: kind === "basket" ? "baskets" : "tools",
      offered: async (tx, _tablet, locationId) =>
        (
          await tx.$queryRaw<(Omit<ShownEquipment, "contentDecidedAt"> & Edited)[]>`
            SELECT items.id::text AS id, items.content, here.decided_at AS "decidedAt", items.field_edits AS "fieldEdits"
            FROM ${table} AS items ${shownHere(locationId)}
            WHERE NOT items.archived ORDER BY items.created_at, items.id`
        ).map(edited),
      held: async (tx, tabletId, locationId) =>
        (
          await tx.$queryRaw<HeldRow[]>`
            SELECT held.${column}::text AS "itemId", held.local_id AS "localId", held.record, here.decided_at AS "decidedAt",
              items.content, items.field_edits AS "fieldEdits"
            FROM ${map} AS held
            JOIN ${table} AS items ON items.id = held.${column}
            LEFT JOIN ${shown} AS here ON here.${column} = held.${column} AND here.location_id = ${locationId}::uuid
            WHERE held.tablet_id = ${tabletId}::uuid ORDER BY held.${column}`
        ).map((row) => heldRecord(row)),
    },
    plan: (offer, held) => equipmentWrites(kind, offer, held),
    offersAnySql: (locationId) => Prisma.sql`SELECT 1 FROM ${table} AS items ${shownHere(locationId)} WHERE NOT items.archived LIMIT 1`,
    stateLocationsSql: (ids) => Prisma.sql`SELECT location_id::text AS id FROM ${shown} WHERE ${column} = ANY(${ids}::uuid[])`,
    ...(kind === "basket" ? { shotLink: { local: "basket_id", link: "library_basket_id" } } : {}),
    // A Shot names one by its id on the tablet that pulled it, so one whose record has that id on any tablet's map is named,
    // as is one a Shot is linked to, whose record may have left the map since, as one Archived or hidden there.
    shotsNameSql: (ids) =>
      kind === "basket"
        ? Prisma.sql`(
            EXISTS (SELECT 1 FROM shots JOIN tablet_baskets AS held ON held.local_id = shots.basket_id WHERE held.basket_id = ANY(${ids}::uuid[]))
            OR ${shotLinkedSql("basket", ids)}
          )`
        : Prisma.sql`(
            EXISTS (SELECT 1 FROM tablet_tools AS held JOIN shots ON shots.tool_ids @> ARRAY[held.local_id] WHERE held.tool_id = ANY(${ids}::uuid[]))
            OR EXISTS (SELECT 1 FROM shots WHERE shots.library_tool_ids && ${ids.map((id) => id.toLowerCase())}::text[])
          )`,
    namedAs: `this ${name}`,
    recipesNameSql: (ids) =>
      kind === "basket"
        ? Prisma.sql`EXISTS (SELECT 1 FROM recipes WHERE lower(content ->> 'basketId') = ANY(${ids}::text[]))`
        : Prisma.sql`EXISTS (
            SELECT 1 FROM recipes, jsonb_array_elements_text(CASE WHEN jsonb_typeof(content -> 'toolIds') = 'array' THEN content -> 'toolIds' ELSE '[]' END) AS tool(id)
            WHERE lower(tool.id) = ANY(${ids}::text[])
          )`,
    undeletable: async () => null,
    keepDeletion: (tx, id) => keepRecordDeletions(tx, kind, id),
    deleteHeldSql: (due) =>
      kind === "basket"
        ? Prisma.sql`EXISTS (SELECT 1 FROM shots WHERE shots.basket_id = ${due}.local_id)`
        : Prisma.sql`EXISTS (SELECT 1 FROM shots WHERE shots.tool_ids @> ARRAY[${due}.local_id])`,
    state: {
      fields: ["shown"],
      current: async (db, wanted) => {
        const rows = await db.$queryRaw<{ itemId: string; locationId: string; shown: boolean; versionId: string | null }[]>`
          SELECT ${column}::text AS "itemId", location_id::text AS "locationId", shown, version_id::text AS "versionId"
          FROM ${shown}
          WHERE (${column}, location_id) IN (SELECT * FROM unnest(${uuidsOf(wanted, "itemId")}::uuid[], ${uuidsOf(wanted, "locationId")}::uuid[]))`;
        const states = new Map(rows.map((row) => [`${row.itemId}/${row.locationId}`, row]));
        // One its Location never decided is not shown there.
        return wanted.map(({ itemId, locationId }) => {
          const here = states.get(`${itemId.toLowerCase()}/${locationId.toLowerCase()}`);
          return { value: here?.shown ?? false, versionId: here?.versionId ?? null };
        });
      },
      use: async (tx, itemId, locationId, field, value, at, seenAt, source) => {
        if (field !== "shown" || typeof value !== "boolean") throw new Error(`A Conflict about ${field} at a Location cannot be used`);
        await showAt(tx, kind, itemId, locationId, source, value, at, seenAt);
      },
    },
    read: async (db, ids) =>
      versionedRows(
        await db.$queryRaw<ItemRow[]>`SELECT id::text AS id, content, field_edits AS "fieldEdits" FROM ${table} WHERE id = ANY(${uuids(ids)}::uuid[])`,
        (row) => ({ name: text(fields(row.content).name), values: fields(row.content) }),
      ),
    itemNames: (db, ids) => namesOf(KINDS[kind], db, ids),
    takeIn: (tx, tablet, value, updatedAt) => takeInEquipment(tx, kind, tablet, value, updatedAt),
    recordWritten: (prisma, tablet, answer) =>
      recordEquipmentWritten(prisma, kind, tablet, answer.globalId, answer.written, answer.record, answer.updatedAt, answer.seen, answer.contentSeen, answer.linked),
  };
}

/** The clearing of a tablet's Workflow's grinder, batch and Basket as its Machine joins a Location that does not offer them (joining.ts), named by the tablet's id. */
const WORKFLOW: WrittenKindDescription = {
  name: "Workflow",
  itemNames: async (_db, ids) => new Map(ids.map((id) => [id, "Grinder, batch and Basket"])),
  recordWritten: (prisma, tablet, answer) => recordWorkflowCleared(prisma, tablet, answer.globalId, answer.record),
};

/**
 * A tablet's Workflow's Loaded Recipe (ADR-0022): the Recipe's fields written
 * into it, or the Recipe cleared from it, named by the Recipe's id
 * (machine-events/loaded-recipes.ts).
 */
const LOADED_RECIPE: WrittenKindDescription = {
  name: "Loaded Recipe",
  itemNames: (db, ids) => namesOf(KINDS.recipe, db, ids),
  recordWritten: (prisma, tablet, answer) =>
    recordLoadedRecipeWritten(prisma, tablet, answer.globalId, answer.written, answer.record, answer.contentSeen),
};

/** The description of a kind the server writes. */
export function writtenKind(kind: WrittenKind): WrittenKindDescription {
  if (kind === LOADED_RECIPE_KIND) return LOADED_RECIPE;
  return kind === WORKFLOW_KIND ? WORKFLOW : KINDS[kind];
}

/** The item's id as SQL of its kind's type, as `${table}.id` compares with it. */
export function idSql(kind: VersionedKindDescription, id: string): Prisma.Sql {
  return Prisma.sql`${id}::${Prisma.raw(kind.idType)}`;
}

/** The ids as an SQL array of its kind's type. */
export function idsSql(kind: VersionedKindDescription, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`${[...ids]}::${Prisma.raw(kind.idType)}[]`;
}

/**
 * Whether a Shot names a Profile, given its id and its steps, from the
 * `profile` of its content, which Decaid writes as it writes a Shot's
 * Workflow's: the Shot's Workflow's profile has the same steps, found by the
 * index on them, or a skin recorded the Profile's id there. Steps alone are
 * compared, not the rest of what Decaid hashes for a Profile's id
 * (`ProfileHash` in decaid:lib/src/models/data/profile_hash.dart): a skin
 * sets the Workflow's profile's target weight to the Shot's yield, so a
 * Shot pulled with a Profile can hold other targets. Refusing more deletes
 * than Shots used is the safe side. PostgreSQL compares JSON numbers by
 * value, so a whole double Decaid writes as `92.0` equals 92, and steps are
 * compared as they identify a profile, each step's temperature left out and
 * a limiter of value 0 as none, as a skin overrides or sends them
 * (`stepsKeySql`), so every Shot linked to the Profile names it. The id a
 * skin recorded is stale once another skin loads a profile, which only
 * refuses more deletes.
 */
function shotNamesProfileSql(id: Prisma.Sql, steps: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM shots WHERE shots.profile_id = ${id}
      OR ${stepsKeySql(Prisma.sql`shots.record -> 'workflow' -> 'profile' -> 'steps'`)} = ${stepsKeySql(steps)}
  )`;
}

/**
 * Keeps each tablet's record of a hard-deleted item whose records carry its
 * global id as due to be deleted there, a batch's with its bean's record
 * there, which is deleted only once the batch's is, as the plugin deletes a
 * bean's batches with it; and keeps the global id, so a record carrying it
 * that a tablet reports later is deleted there too.
 */
async function keepRecordDeletions(tx: Prisma.TransactionClient, kind: LibraryKind, id: string): Promise<void> {
  const description = KINDS[kind];
  const { map, parent } = description;
  const parentRecord = parent ? Prisma.sql`record ->> ${parent.recordField}` : Prisma.sql`NULL::text`;
  await tx.$executeRaw`
    INSERT INTO tablet_deletions (tablet_id, kind, local_id, item_id, bean_local_id)
    SELECT tablet_id, ${kind}, local_id, ${Prisma.raw(map.column)}::text, ${parentRecord} FROM ${Prisma.raw(map.table)}
    WHERE ${Prisma.raw(map.column)} = ${idSql(description, id)}
    ON CONFLICT DO NOTHING`;
  await tx.$executeRaw`INSERT INTO deleted_items (kind, item_id) VALUES (${kind}, ${id}::uuid) ON CONFLICT DO NOTHING`;
}

/** Whether a Location offers a Bean: one of its batches is there, or it has an origin there, and neither is Archived; of `beans`. */
function beanOfferedSql(locationId: string): Prisma.Sql {
  return Prisma.sql`NOT beans.archived AND (
    EXISTS (SELECT 1 FROM bean_origins AS origin WHERE origin.bean_id = beans.id AND origin.location_id = ${locationId}::uuid)
    OR EXISTS (
      SELECT 1 FROM bean_batches AS batch
      JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
      WHERE batch.bean_id = beans.id AND NOT batch.archived AND here.added_at IS NOT NULL AND here.finished_at IS NULL
    )
  )`;
}

/** A Profile's title, author and notes, from a record or content holding its `profile`, as a JSON object. */
function profileTextSql(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`jsonb_build_object('title', ${value} -> 'profile' -> 'title', 'author', ${value} -> 'profile' -> 'author', 'notes', ${value} -> 'profile' -> 'notes')`;
}

/** The latest decision of whether any of a Bean's batches is at the Location, by PostgreSQL's clock; null if none was ever decided. */
function presenceDecidedSql(beanId: Prisma.Sql, locationId: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT max(here.presence_decided_at) FROM batch_locations AS here JOIN bean_batches AS batch ON batch.id = here.batch_id
    WHERE batch.bean_id = ${beanId} AND here.location_id = ${locationId}::uuid
  )`;
}

/** An item's fields' latest edits, as read with it. */
interface Edited {
  fieldEdits: unknown;
}

/** An item read with its fields' latest edits, with when the latest of them was decided instead. */
function edited<T extends Edited>({ fieldEdits, ...item }: T): Omit<T, "fieldEdits"> & { contentDecidedAt: Date | null } {
  return { ...item, contentDecidedAt: latestDecision(readFieldEdits(fieldEdits)) };
}

/** A record the tablet holds, read with its item's content and its fields' latest edits. */
type HeldRow = Omit<HeldRecord, "content" | "contentDecidedAt"> & Edited & { content: Record<string, unknown> | null };

/** A record the tablet holds, with its item's content as edits merge it (`HeldRecord.content`), read by `values`. */
function heldRecord({ content, fieldEdits, ...row }: HeldRow, values: (content: Record<string, unknown>) => Record<string, unknown> = (content) => content): HeldRecord {
  return { ...row, content: content === null ? null : values(content), contentDecidedAt: latestDecision(readFieldEdits(fieldEdits)) };
}

/** An item's row as a Conflict reads it. */
interface ItemRow {
  id: string;
  content: unknown;
  fieldEdits: unknown;
}

/** Items read for Conflicts, by id. */
function versionedRows<T extends { id: string; fieldEdits: unknown }>(rows: readonly T[], read: (row: T) => Omit<VersionedItem, "fieldEdits">): Map<string, VersionedItem> {
  return new Map(rows.map((row) => [row.id, { ...read(row), fieldEdits: readFieldEdits(row.fieldEdits) }]));
}

/** The names of a kind's items, read as Conflicts read them, by the ids given, as given. */
async function namesOf(kind: LibraryKindDescription, db: Prisma.TransactionClient, ids: readonly string[]): Promise<Map<string, string | null>> {
  const items = await kind.read(db, ids);
  const names = new Map<string, string | null>();
  for (const id of ids) {
    // PostgreSQL returns ids in lower case.
    const item = items.get(kind.idType === "uuid" ? id.toLowerCase() : id);
    if (item) names.set(id, item.name);
  }
  return names;
}

/** The ids that are UUIDs, which a kind of UUID ids can have: any other, as a refusal's or a plugin's mistake may name, is none of its items. */
function uuids(ids: readonly string[]): string[] {
  return ids.filter((id) => UUID.test(id));
}

/** The UUIDs a key of each row holds, in order; anything else, which no row can match, as a UUID none has. */
function uuidsOf<K extends string>(rows: readonly Record<K, string>[], key: K): string[] {
  return rows.map((row) => (UUID.test(row[key]) ? row[key] : NO_UUID));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_UUID = "00000000-0000-0000-0000-000000000000";

/** A Bean as the management interface names it: its roaster and name. */
function beanName(content: unknown): string | null {
  const bean = fields(content);
  return joined([text(bean.roaster), text(bean.name)]);
}

/** A batch as the Bean Batches list names it: its Bean, and the day a barista picked as its roast date. */
function batchName(content: unknown, beanContent: unknown): string | null {
  const bean = text(fields(beanContent).name);
  const roastDate = text(fields(content).roastDate);
  const roasted = roastDate !== null && /^\d{4}-\d\d-\d\d/.test(roastDate) ? `roasted ${roastDate.slice(0, 10)}` : null;
  return bean === null && roasted === null ? null : `${bean ?? "Unnamed Bean"}, ${roasted ?? "no roast date"}`;
}

function fields(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function joined(parts: (string | null)[]): string | null {
  const present = parts.filter((part) => part !== null);
  return present.length === 0 ? null : present.join(" ");
}
