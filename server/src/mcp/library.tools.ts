import { BadRequestException, Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import type { Scope } from "../accounts/scope.js";
import {
  BEVERAGE_TYPES,
  EXIT_CONDITIONS,
  EXIT_TYPES,
  type LibraryKind,
  MACHINE_MODELS,
  MAX_SHOT_RATING,
  STEP_SENSORS,
  STEP_TRANSITIONS,
} from "@decent-sync/protocol";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { type BatchAtLocation, type BatchHere, type BeanBatchSummary, type BeanBatchView, BeanBatchesService, readBeanBatchId } from "../library/bean-batches.service.js";
import { type BeanSummary, type BeanView, BeansService, readBeanId } from "../library/beans.service.js";
import { type EquipmentSummary, type EquipmentView, EquipmentService, readEquipmentId } from "../library/equipment.service.js";
import { type GrinderSummary, type GrinderView, GrindersService, readGrinderId } from "../library/grinders.service.js";
import { MAX_BATCH_CODE_LENGTH } from "../library/item-input.js";
import { HistoryService, type LostEditView, MAX_HISTORY_FIELD, type SourceView, type VersionView } from "../library/history.service.js";
import { type ProfileSummary, type ProfileVersionView, type ProfileView, ProfilesService, readProfileId } from "../library/profiles.service.js";
import { type RecipeOnProfileView, type RecipeView, RecipesService, readRecipeId } from "../library/recipes.service.js";
import { locationNotFound, readLocationId } from "../locations/input.js";
import { type LocationView, LocationsService, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { BudgetedTool } from "./budget.js";
import { PAGED, page, pageOf, pageOutput } from "./paging.js";
import { zonedTime } from "./times.js";
import { callerOf } from "./token-verifier.js";

// The Library, read through an assistant as the REST API reads it, calling
// the same services (#409, ADR-0026): its items of each kind, each one with
// its history, Lost Edits among it. Every account reads every item, as
// through the REST API; who made an edit, applied or lost, is named as the
// REST API names it to the account.

const id = z.string();

/** Each Library kind by its glossary name, so a kind added to the Library is added to these tools, whose switches then fail to compile until they read it. */
export const KIND_NAMES: Readonly<Record<LibraryKind, string>> = {
  bean: "a Bean",
  beanBatch: "a Bean Batch",
  profile: "a Profile",
  grinder: "a Grinder",
  basket: "a Basket",
  tool: "a Tool",
  recipe: "a Recipe",
};
export const kind = z
  .enum(Object.keys(KIND_NAMES) as [LibraryKind, ...LibraryKind[]])
  .describe(`The kind of Library item: ${Object.entries(KIND_NAMES).map(([key, name]) => `${key} (${name})`).join(", ")}.`);

const location = z.object({ id, name: z.string(), timeZone: z.string().describe("Its IANA time zone. A day at the Location is a day in this zone.") });
const content = (what: string) => z.record(z.string(), z.unknown()).describe(what);
const RECORD_FIELDS = "Decaid's record fields, as the tablet that created it sent them and as edited since, those Decent Sync doesn't know included.";

/** Each time's offset, which every tool's description states. */
export const TIMES =
  "Times are ISO 8601 with a Location's offset: an item's createdAt with that of the Location it joined the Library at; a time of its state at a Location, such as a Bean Batch added there, and each edit of that state, applied or lost, with that Location's; and a Grinder's or Recipe's other times and edits with that of the Location it belongs to, but a Recipe's Reference Shot's pulledAt, with that of the Location it was pulled at. Others, such as a Bean's content edits, are in UTC.";

/** What the Library's items hold, for the descriptions of the tools that read or change them. */
export const ITEMS =
  "An item's content is its record's fields, as the tablet that created it sent them and as edited since, Decaid's names for a Bean's, Bean Batch's, Grinder's and Profile's, and DYE2's for a Basket's and Tool's. A Grinder's also holds, under DYE2's names, its feedRate note and the range and default of its setting and of its RPM (settingMin, settingMax, settingDefault, rpmMin, rpmMax, rpmDefault), where 0 is a value: a tablet's steppers stop at the range, and a Machine takes the default, or the middle of the range, as a barista picks the Grinder on it. A Recipe's content is in the Library's terms: dose and yield in grams, brewTemperature in °C, grindSetting as typed, and any steam, hot water and flush settings in °C, seconds, ml/s and ml. A Bean Batch's remainingWeight at a Location is its Remaining Weight there, in grams, worked out as it is read: the weight its count there starts from (entered), which is the weight last entered there or the amount a Batch Move brought where it had none, less the dose of each Shot linked to the batch that was pulled there since (used), plus what Batch Moves have brought there since and less what they have taken away (moved), never below 0. One with no weight at a Location is untracked there: its remainingWeight there is null, not 0, and Shots take nothing from it. A Batch Move takes a batch from one Location it is at to another, all of it or part of its weight, and never changes the batch's total. A Profile marked bundled is one of Decaid's own, which every tablet has. A Bean's likelyDuplicates are other Beans with the same roaster and name, ignoring case, never merged.";

const time = (what: string) => z.string().describe(what);
const joinedAt = time("When it joined the Library.");
const createdLocation = location.nullable().describe("The Location it joined the Library at, as a tablet there reported it or as it was created for; null for none, such as a Bean created in the management interface.");
const shownAt = z
  .array(z.object({ location, since: time("When the Location last decided to show it.") }))
  .describe("The Locations showing it, by name. None while it is Archived.");
const decidedAt = z
  .array(z.object({ location, shown: z.boolean(), since: time("When that was last decided.") }))
  .describe("Each Location that has decided whether it shows it, by name, kept while it is Archived, so restoring it shows it again where it is shown. A Location not listed doesn't show it.");

const beanSummary = z.object({
  id,
  roaster: z.string().nullable(),
  name: z.string().nullable(),
  archived: z.boolean(),
  offeredAt: z
    .array(location)
    .describe("The Locations offering it, by name: each where one of its Bean Batches is, and each where it has no batch yet but a tablet there created, linked or un-archived it. None while it is Archived."),
  createdAt: joinedAt,
  createdLocation,
  likelyDuplicates: z
    .array(z.object({ id, roaster: z.string().nullable(), name: z.string().nullable() }))
    .describe("Other Beans with the same roaster and name, ignoring case: likely duplicates, never merged."),
});

export const source = z
  .object({
    machine: z.object({ id, name: z.string() }).nullable().describe("The Machine whose tablet made it, if one did and it still exists."),
    tabletId: z.string().nullable().describe("The id of the tablet that made it, if one did; with no Machine, a tablet whose Machine has since been removed."),
    barista: z
      .string()
      .nullable()
      .describe("The barista the tablet's Workflow named as it was made, for a Bean Batch brought to the Machine's Location by a scan of its QR code on the tablet; null for every other edit, and where the Workflow named none."),
    account: z
      .object({ id, name: z.string().nullable().describe("Shown to Admins only.") })
      .nullable()
      .describe("The account that made it, in the management interface or through a Connected App."),
    connectedApp: z
      .object({ id, name: z.string().describe("The name the app gave itself."), host: z.string().describe("The host its client id is published at, which no app chooses.") })
      .nullable()
      .describe("The Connected App, such as an assistant, the account made it through; null for the management interface."),
  })
  .describe("Where it came from: a Machine's tablet, or an account, in the management interface or through a Connected App.");

const batchSummary = z.object({
  id,
  bean: z.object({ id, roaster: z.string().nullable(), name: z.string().nullable() }).describe("The Bean it is a roast of."),
  roastDate: z.string().nullable().describe("As Decaid recorded it."),
  batchCode: z.string().nullable().describe("Its Batch Code, the roaster's own identifier for it, which no other Bean Batch that is not Archived holds; null for none."),
  archived: z.boolean(),
  locations: z
    .array(
      z.object({
        location,
        remainingWeight: z
          .number()
          .nullable()
          .describe("Its Remaining Weight there, in grams: the weight its count there starts from, less what the Shots pulled there since have used, plus what Batch Moves have brought there since, less what they have taken away, never below 0; null where it is untracked there."),
        entered: z
          .object({
            weight: z.number().describe("In grams."),
            at: time("When it was entered, or arrived."),
            by: source.nullable().describe("Who entered it, or moved it there: the Machine whose tablet it was entered on, or the account; null where unknown."),
            arrivedFrom: location.nullable().describe("For a count that started with a Batch Move, the Location the weight arrived from; null for a weight entered, and where that Location has been deleted since."),
          })
          .nullable()
          .describe("The weight its count there starts from: the weight last entered there, or, where the batch had none there when a Batch Move brought some, the amount that arrived; null where it is untracked there."),
        used: z
          .object({ shots: z.number().describe("How many Shots linked to it were pulled there since its count started."), weight: z.number().describe("The coffee they used, in grams: each Shot's measured dose, else the dose its Workflow was set to.") })
          .nullable()
          .describe("What the Shots pulled there since its count started have used; null where it is untracked there."),
        moved: z
          .object({
            in: z.number().describe("The weight moved there since its count started, in grams."),
            from: z.array(z.object({ location, weight: z.number().describe("In grams.") })).describe("That weight by the Location it came from."),
            away: z.number().describe("The weight moved away from there since its count started, in grams."),
            to: z.array(z.object({ location, weight: z.number().describe("In grams.") })).describe("That weight by the Location it went to."),
          })
          .nullable()
          .describe("What Batch Moves have brought there and taken from there since its count started; null where it is untracked there."),
        since: time("When it was last added there."),
      }),
    )
    .describe("The Locations it is at, by name, kept while it or its Bean is Archived, though neither is offered anywhere then."),
  totalRemainingWeight: z.number().nullable().describe("The sum of its Remaining Weights over the Locations that track it, in grams; null where none does."),
  createdAt: joinedAt,
  createdLocation,
});

/** A profile step's fields but its pump and target, which differ by what the pump controls. */
const stepFields = {
  name: z.string(),
  transition: z.enum(STEP_TRANSITIONS).describe("fast: it gets to its target at once; smooth: over the whole step, from the value measured as it begins."),
  exit: z
    .object({ type: z.enum(EXIT_TYPES), condition: z.enum(EXIT_CONDITIONS), value: z.number() })
    .nullable()
    .describe("It moves on to the next step once the pressure (bar) or flow (ml/s) goes over or under the value; null for none."),
  volume: z.number().describe("The water it may pump, in ml; 0 for no limit."),
  seconds: z.number().describe("Its maximum time, in seconds."),
  weight: z.number().nullable().describe("The weight in the cup that ends it, in grams, which needs a scale; null or 0 for none."),
  temperature: z.number().describe("°C, measured where sensor says."),
  sensor: z.enum(STEP_SENSORS).describe("Where its temperature is measured: coffee, in the puck, or water, at the group."),
  limiter: z
    .object({ value: z.number(), range: z.number() })
    .nullable()
    .describe("The cap on what its pump does not control, a flow limit (ml/s) on a pressure step or a pressure limit (bar) on a flow step, eased into over range; null for none."),
};

/** A profile as Decaid reads it (`Profile` in protocol/src/profile.ts), each field as Decaid names it. Its steps are never cut. */
export const profileShape = z
  .object({
    version: z.string().nullable(),
    title: z.string(),
    notes: z.string(),
    author: z.string(),
    beverage_type: z.enum(BEVERAGE_TYPES).describe("What kind of drink it makes; Decaid reads any other as espresso."),
    steps: z.array(
      z.discriminatedUnion("pump", [
        z.object({ ...stepFields, pump: z.literal("pressure").describe("The pump controls pressure."), pressure: z.number().describe("Its target, in bar.") }),
        z.object({ ...stepFields, pump: z.literal("flow").describe("The pump controls flow."), flow: z.number().describe("Its target, in ml/s.") }),
      ]),
    ),
    target_volume: z.number().nullable().describe("The volume pumped, in ml, that stops a Shot with no scale, counted from the step at target_volume_count_start; null or 0 for none."),
    target_weight: z.number().nullable().describe("The weight in the cup, in grams, that stops a Shot; null or 0 for none. A Recipe's yield replaces it."),
    target_volume_count_start: z.number().describe("How many steps, from the first, are preinfusion."),
    tank_temperature: z.number().describe("The water tank's temperature, °C; 0 for none."),
  })
  .describe("Its profile as Decaid reads it: what the machine executes, and its title, author and notes.");

const profileSummary = z.object({
  id: id.describe("Decaid's id of the Profile Version read, the same on every tablet: the Profile's current version unless another was asked for."),
  profileId: id.nullable().describe("The Profile's own id, which stays as it gains versions and names it wherever a Profile's id is asked for; null until Decent Sync has placed the version in a Profile."),
  versions: z.number().describe("How many Profile Versions it has had, which get_profile_versions lists."),
  startedFrom: z
    .object({ profileId: id, id, title: z.string().nullable() })
    .nullable()
    .describe("The Profile it was started from, as a Duplicate is: that Profile's own id, and its current version's Decaid id and title; null where it was started from none or the Library no longer has it."),
  title: z.string().nullable(),
  author: z.string().nullable(),
  beverageType: z.string().nullable(),
  bundled: z.boolean().describe("Whether it is one of Decaid's bundled Profiles, which every tablet has already."),
  archived: z.boolean(),
  shownAt,
  createdAt: joinedAt,
  createdLocation,
});

const grinderSummary = z.object({
  id,
  model: z.string().nullable(),
  burrs: z.string().nullable(),
  burrType: z.string().nullable(),
  archived: z.boolean(),
  location: location.nullable().describe("The Location it belongs to, the only one offering it unless it is Archived."),
  createdAt: joinedAt,
});

const equipmentSummary = z.object({
  id,
  name: z.string().nullable(),
  archived: z.boolean(),
  shownAt,
  createdAt: joinedAt,
  createdLocation,
  content: content(`DYE2's record fields, as the tablet that created it sent them and as edited since, such as a Basket's size and a Tool's attributes.`),
});

const named = <T extends z.ZodRawShape>(what: T) => z.object({ id, ...what }).nullable();

const recipe = z.object({
  id,
  name: z.string().nullable(),
  location: location.nullable().describe("The Location it belongs to."),
  slot: z.number().int().nullable().describe("Its Recipe Slot at its Location; null for none."),
  archived: z.boolean(),
  createdAt: joinedAt,
  content: content(
    "What it holds, in the Library's terms: name, beverage, beanId, beanBatchId, profileId, grinderId, basketId, toolIds and toolAttributes (a Tool's attributes for this Recipe, by the Tool's id), dose and yield in grams, ratio, grindSetting (a number, or text as typed), rpm, feedRate, brewTemperature in °C, and any steam, hot water and flush settings it holds (steamTemperature, steamDuration, steamFlow, steamStopTemperature, hotWaterTemperature, hotWaterDuration, hotWaterVolume, hotWaterFlow, flushTemperature, flushDuration and flushFlow, in °C, seconds, ml/s and ml), with DYE2's display modes steamMode and hotWaterMode. Each is left out where it holds none.",
  ),
  uses: z
    .object({
      bean: named({ roaster: z.string().nullable(), name: z.string().nullable() }),
      beanBatch: named({
        roastDate: z.string().nullable(),
        batchCode: batchSummary.shape.batchCode,
        atLocation: z.boolean().describe("Whether it is at the Recipe's Location now, neither it nor its Bean Archived."),
      }),
      profile: named({ title: z.string().nullable() }),
      grinder: named({ model: z.string().nullable() }),
      basket: named({ name: z.string().nullable() }),
      tools: z.array(z.object({ id, name: z.string().nullable() })),
    })
    .describe("The items its content names, with what names each; one the Library no longer has by its id alone."),
  batchFinished: z.boolean().describe("Whether it isn't Archived and names a Bean Batch that isn't at its Location now: a Recipe whose dial needs the next roast."),
  referenceShot: z
    .object({
      id: id.describe("The Shot's id, as find_shots and get_shot give it."),
      pulledAt: time("When it was pulled, with the offset of the Location it was pulled at.").nullable(),
      machine: z.object({ id, name: z.string() }).nullable().describe("The Machine it is credited to; null while it waits for an Admin to name the Machine that recorded it."),
      location: location.nullable().describe("The Location its Machine was at then; null when unknown."),
      profileTitle: z.string().nullable().describe("Its profile's title, as the Shot recorded it."),
      profile: z.object({ id, title: z.string().nullable() }).nullable().describe("The Library's Profile it was pulled with."),
      targetDose: z.number().nullable().describe("In grams."),
      actualDose: z.number().nullable().describe("Weighed, in grams."),
      targetYield: z.number().nullable().describe("In grams."),
      actualYield: z.number().nullable().describe("Weighed, in grams."),
      duration: z.number().nullable().describe("How long its profile ran, leaving out its Preheat, in seconds."),
      enjoyment: z.number().nullable().describe(`Its rating, from 0 to ${MAX_SHOT_RATING}, where 0 is unrated.`),
      grinderSetting: z.string().nullable().describe("Its Grinder's setting, as its Workflow recorded it."),
      profileDiffers: z
        .boolean()
        .describe("Whether it was pulled on another Profile than the Recipe's: the Recipe names a Profile, and the Shot's is another, or matches none in the Library."),
    })
    .nullable()
    .describe(
      "Its Reference Shot: the one Shot chosen to show how its Shots should go, from any Machine or Location, kept until someone chooses another or clears it (set_reference_shot); get_shot reads it whole. Null for none, as for one held by hardware an Admin dismissed, until that hardware is named as a Machine.",
    ),
});

const version = z.object({
  id,
  fields: content(
    "The fields it set, each with its value: of the item's content, by Decaid's names, or of its state at its Location (atLocation, remainingWeight, shown), or a Recipe's referenceShotId, its Reference Shot's id, null when cleared. The first version is the item joining the Library. A Batch Move's are what it set at the Location joined, with movedFrom, the id of the Location left, movedAmount and movedAll, which move reads out.",
  ),
  location: location.nullable().describe("The Location whose state of the item it changed; null for its content."),
  source,
  editedAt: time("When it was made: a tablet's edit by the tablet's clock."),
  receivedAt: time("When the server took it in."),
  copiedFrom: z
    .object({ id, name: z.string().nullable(), location: location.nullable() })
    .nullable()
    .describe("For a copy, as a Recipe copied to a Location, its first version names the item it was copied from, and that item's Location then."),
  move: z
    .object({
      from: location.nullable().describe("The Location it left; null if deleted since."),
      to: location.nullable().describe("The Location it joined; null if deleted since."),
      amount: z.number().nullable().describe("The weight moved, in grams; null for a batch with no weight where it was, which moved none."),
      all: z.boolean().describe("Whether all of it was moved, which finished it at the Location left."),
    })
    .nullable()
    .describe("For a Batch Move, one entry of a Bean Batch's history: where it was moved from and to, and how much; null for every other entry."),
});

/** An entry of an item's history as get_library_item reads it: a version, or a Lost Edit. */
const historyEntry = version.extend({
  lost: z
    .boolean()
    .describe(
      "Whether this is a Lost Edit: an edit that did not apply, because it lost to another edit of the same field made without seeing it, or because a record entered on a tablet, of an item the Library already had, held another value; a tablet joining a Location keeps none, as the Location's values are written over its own. Its fields hold the one field with the value that lost, and receivedAt is when it lost. It is kept to be read: to bring its value back, edit the item.",
    ),
  lostTo: z
    .object({
      versionId: id.describe("That edit's id, as the history lists it."),
      value: z.unknown().describe("The value it set the field to; null where it cleared it."),
      source,
      editedAt: time("When it was made."),
    })
    .nullable()
    .describe("For a Lost Edit, the edit it lost to, null where that is not known; null for an edit that applied."),
});

const findInput = z.object({
  kind,
  locationId: id
    .optional()
    .describe(
      "Those this Location offers: a Bean offered there, a Bean Batch at it, and a Profile, Basket or Tool shown there, none of them while Archived, nor a Bean Batch whose Bean is; and a Grinder or Recipe belonging to it, Archived or not.",
    ),
  name: z
    .string()
    .max(500)
    .optional()
    .describe("Those whose name has each of these words in it, ignoring case: a Bean's roaster and name, a Bean Batch's Bean's and its Batch Code, a Profile's title, a Grinder's model, and a Basket's, Tool's or Recipe's name."),
  batchCode: z
    .string()
    .min(1)
    .max(MAX_BATCH_CODE_LENGTH)
    .optional()
    .describe("For Bean Batches only: those holding exactly this Batch Code, ignoring case and the spaces around it. At most one that is not Archived holds a code; an Archived one that held it comes too unless archived is false."),
  archived: z.boolean().optional().describe("true for those Archived alone, false for those not Archived alone; both if not given."),
  ...page,
  offset: page.offset.describe("How many to skip: the previous page's offset plus its length."),
});

const findOutput = z.object({
  ...pageOutput,
  beans: z.array(beanSummary).optional(),
  beanBatches: z.array(batchSummary).optional(),
  profiles: z.array(profileSummary).optional(),
  grinders: z.array(grinderSummary).optional(),
  baskets: z.array(equipmentSummary).optional(),
  tools: z.array(equipmentSummary).optional(),
  recipes: z.array(recipe).optional(),
});

const getInput = z.object({
  kind,
  id: id.describe("Its id, as find_library_items gives it."),
  history: z
    .boolean()
    .default(false)
    .describe("Whether to include its history: each edit accepted, and each Lost Edit, one that did not apply, the latest taken in first, with the fields it set, who or which Machine made it, and when."),
  historyField: z
    .string()
    .min(1)
    .max(MAX_HISTORY_FIELD)
    .optional()
    .describe("Only the edits of its history that set this field, to a value or cleared: of its content, by its name there, such as a Recipe's grindSetting, or of a Location's state of it (atLocation, remainingWeight, shown). Given alone, it asks for its history."),
  ...page,
});

const listed = <T extends z.ZodType>(entry: T, what: string) => z.object({ ...pageOutput, entries: z.array(entry) }).optional().describe(what);

/** A Bean as get_library_item reads it, and as the tools changing one return it. */
export const beanItem = beanSummary.extend({ content: content(RECORD_FIELDS), batches: z.array(batchSummary).describe("Its Bean Batches, the latest roasted first.") });

/** A Bean Batch as get_library_item reads it, and as the tools changing one return it. */
export const beanBatchItem = batchSummary.extend({
  content: content(`${RECORD_FIELDS} Its remaining weight and whether it is Archived are each Location's, so left out.`),
  finished: z
    .array(z.object({ location, remainingWeight: z.number().nullable().describe("The weight its count there last started from, in grams, which went with it: 0 where a Batch Move took all of it."), finishedAt: time("When it was finished there.") }))
    .describe("The Locations it was at and has been finished at since, by name."),
  beanArchived: z.boolean().describe("Whether its Bean is Archived, which takes it out of every Location as its own archived does."),
  recipes: z
    .array(
      z.object({
        id,
        name: z.string().nullable(),
        location: location.nullable().describe("The Location it belongs to."),
        slot: z.number().int().nullable().describe("Its Recipe Slot at its Location; null for none."),
        dose: z.number().nullable().describe("Its dose, in grams; null for none."),
        yield: z.number().nullable().describe("Its yield, in grams; null for none."),
        batchFinished: z.boolean().describe("Whether the batch isn't at the Recipe's Location now, as one finished there or moved away from it entirely: a Recipe whose dial needs the next roast."),
      }),
    )
    .describe("The Recipes, not Archived, that name it, at any Location, the batch there now or not, by Location, slot and name, as its page lists them. None names another batch of its Bean. get_library_item reads each whole."),
});

const locationBatchesInput = z.object({ locationId: id.describe("The Location whose Bean Batches to list, as list_locations gives it."), ...page });

const locationBatchesOutput = z.object({
  ...pageOutput,
  beanBatches: z
    .array(
      batchSummary.shape.locations.element.omit({ location: true }).extend({
        id,
        bean: batchSummary.shape.bean,
        roastDate: batchSummary.shape.roastDate,
        batchCode: batchSummary.shape.batchCode,
        recipes: z
          .array(z.object({ id, name: z.string().nullable(), slot: z.number().int().nullable().describe("Its Recipe Slot at the Location; null for none.") }))
          .describe("The Recipes at the Location, not Archived, that name it, in slot order, then those in no slot, by name."),
      }),
    )
    .describe("The batches at the Location, the latest roasted first, each with the Location's own Remaining Weight, count and moves, never another Location's."),
});

/** One Library item, under its kind's key, as get_library_item reads it and the tools changing one return it. */
export const itemOutput = z.object({
  bean: beanItem.optional(),
  beanBatch: beanBatchItem.optional(),
  profile: profileSummary
    .extend({
      content: content(`${RECORD_FIELDS} Its visibility is each Location's, so left out.`),
      profile: profileShape.nullable().describe("Its profile, as Decaid reads it: what the machine executes, and its title, author and notes; null where Decaid would not read it."),
      version: z.number().nullable().describe("The number of the version read among the Profile's, as in Version 2; null until placed."),
      current: z.object({ id, version: z.number().nullable() }).describe("The Profile's current version, by Decaid's id and number: the one read where its id is the same."),
      parent: z.object({ id, title: z.string().nullable() }).nullable().describe("The version or Profile these steps were saved from, as Streamline saves one whose steps changed, if the Library has it."),
      locations: decidedAt,
      machineModel: z
        .enum(MACHINE_MODELS)
        .describe("The Machine model simulate_profile runs it as where none is asked for: Bengle where every Machine at the Locations showing it is one, otherwise DE1."),
      refusedOn: z
        .array(z.object({ machine: z.object({ id, name: z.string() }), error: z.string(), refusedAt: z.string() }))
        .describe("The Machines whose tablets refused its write, the latest first, with why: as Decaid answering under another id, which means Decaid computes its id otherwise than Decent Sync, or a model that can't run it."),
    })
    .optional(),
  grinder: grinderSummary.extend({ content: content(RECORD_FIELDS) }).optional(),
  basket: equipmentSummary.extend({ locations: decidedAt }).optional(),
  tool: equipmentSummary.extend({ locations: decidedAt }).optional(),
  recipe: recipe.optional(),
});

const getOutput = itemOutput.extend({
  history: listed(historyEntry, "Only when asked for: its versions, each an edit accepted, and its Lost Edits (lost), each an edit that did not apply, the latest taken in first. limit and offset page it."),
});

const profileVersionsInput = z.object({ profileId: id.describe("The Library Profile whose versions to read: its own id (profileId) or Decaid's id of any of its versions, as find_library_items gives them.") });

const profileVersionsOutput = z.object({
  profile: z.object({ profileId: id.nullable(), currentVersionId: id }).describe("The Profile: its own id, null until Decent Sync has placed it, and its current version's Decaid id."),
  versions: z
    .array(
      z.object({
        id,
        number: z.number().nullable().describe("Its number among the Profile's versions, as in Version 2, in the order they joined it, never given again; null until placed."),
        current: z.boolean().describe("Whether it is the Profile's current version."),
        title: z.string().nullable(),
        bundled: z.boolean().describe("One of Decaid's own Profiles, which every tablet has."),
        archived: z.boolean(),
        parentId: id.nullable().describe("The version it was saved from, where that is among these; else null."),
        savedAt: time("When it was saved: by the record its first tablet sent, else when it joined the Library."),
        savedBy: source.nullable().describe("Who saved it: the Machine whose tablet saved it, or the account that published it; null where unknown."),
        shownAt,
        shots: z.number().describe("How many Shots are on it, as the Shots list's profileId filter counts them."),
      }),
    )
    .describe("Every Profile Version the Profile has had, the latest to join first. A Duplicate is a Profile of its own, among no other's versions, and one of Decaid's bundled Profiles has one version."),
  earlierOn: z
    .array(z.object({ machine: z.object({ id, name: z.string() }), version: z.object({ id, number: z.number().nullable() }) }))
    .describe("The Machines whose Workflow holds the steps of an earlier version while they have no Loaded Recipe, each with that version, by name. A Machine with a Loaded Recipe follows that Recipe, so is never listed. Decent Sync sets no Workflow because of this."),
  recipes: z
    .array(
      z.object({
        recipe: z.object({ id, name: z.string().nullable(), location: location.nullable(), slot: z.number().nullable() }),
        loadedOn: z.array(z.object({ id, name: z.string() })).describe("The Machines whose Loaded Recipe it is now."),
      }),
    )
    .describe("The Recipes, not Archived, that name the Profile, by Location, slot and name, each with the Machines that have it loaded now."),
});

type FindInput = z.infer<typeof findInput>;
type FindOutput = z.infer<typeof findOutput>;
type GetOutput = z.infer<typeof getOutput>;
export type ItemOutput = z.infer<typeof itemOutput>;

/**
 * What Decaid hashes of a Profile for its id (`profileId`), in its record
 * and in its profile as Decaid reads it, given as it is (`Budget.whole`):
 * rounded or cut, it would be another profile, with another id. Its title,
 * author and notes are free text still.
 */
export const PROFILE_WHOLE = ["/profile/content/profile", "/profile/profile"].flatMap(profileWhole);

/** The `Budget.whole` paths of what Decaid hashes of a profile, as Decaid holds it, at `profile`, a path such as `/profile`. */
export function profileWhole(profile: string): string[] {
  return ["version", "beverage_type", "steps", "tank_temperature", "target_weight", "target_volume", "target_volume_count_start"].map((field) => `${profile}/${field}`);
}

/**
 * The Library, read through an assistant: each kind's items as the REST API
 * lists them, filtered by Location, name and whether Archived and paged, one
 * item as the REST API returns it, with its history, Lost Edits among it,
 * when asked for. Times are given with the offset of the
 * Location they happened at (`TIMES`).
 */
@Injectable()
export class LibraryTools {
  constructor(
    private readonly beans: BeansService,
    private readonly batches: BeanBatchesService,
    private readonly profiles: ProfilesService,
    private readonly grinders: GrindersService,
    private readonly equipment: EquipmentService,
    private readonly recipes: RecipesService,
    private readonly history: HistoryService,
    private readonly locations: LocationsService,
    private readonly prisma: PrismaService,
  ) {}

  @BudgetedTool({
    name: "find_library_items",
    title: "Find Library items",
    description: `Finds the Library's items of one kind, a page at a time, as the management interface lists them, by Location, name and whether Archived, and a Bean Batch by its Batch Code: Beans, Bean Batches, Profiles, Grinders, Baskets, Tools or Recipes. Recipes come by Location, in Recipe Slot order, then those in no slot, each with its Reference Shot, and its Bean Batch (uses.beanBatch) by its roast date and batchCode, its Batch Code, null where it has none. list_location_batches lists one Location's Bean Batches with the Recipes there that name each. ${ITEMS} ${PAGED} ${TIMES}`,
    inputSchema: findInput,
    outputSchema: findOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "get_library_item reads one item with more of it." },
  })
  async findLibraryItems(input: FindInput, context: McpContext): Promise<FindOutput> {
    const { scope } = callerOf(context);
    if (input.batchCode !== undefined && input.kind !== "beanBatch") throw new BadRequestException("Only a Bean Batch has a Batch Code: ask for it with kind beanBatch");
    const at = await this.locationOf(input.locationId);
    const paged = <T, R>(items: readonly T[], filtered: (item: T) => Filtered, view: (item: T) => R) => {
      const found = chosen(items, input, at, filtered);
      const shown = found.slice(input.offset, input.offset + input.limit);
      return { ...pageOf(found.length, input.offset, shown.length), entries: shown.map(view) };
    };
    switch (input.kind) {
      case "bean": {
        const { entries, ...rest } = paged(await this.beans.list(), (bean) => ({ archived: bean.archived, names: [bean.roaster, bean.name], at: bean.offeredAt }), beanOf);
        return { ...rest, beans: entries };
      }
      case "beanBatch": {
        // A batch keeps the Locations it is at while it or its Bean is Archived, but no Location offers it then (LIBRARY.md).
        const archivedBeans = at === undefined ? new Set<string>() : await this.archivedBeans();
        const { entries, ...rest } = paged(
          await this.batches.list(scope, input.batchCode),
          (batch) => ({
            archived: batch.archived,
            names: [batch.bean.roaster, batch.bean.name, batch.batchCode],
            at: batch.archived || archivedBeans.has(batch.bean.id) ? [] : batch.locations.map((here) => here.location),
          }),
          batchOf,
        );
        return { ...rest, beanBatches: entries };
      }
      case "profile": {
        const { entries, ...rest } = paged(await this.profiles.list(), (profile) => ({ archived: profile.archived, names: [profile.title], at: shownLocations(profile) }), profileOf);
        return { ...rest, profiles: entries };
      }
      case "grinder": {
        const { entries, ...rest } = paged(await this.grinders.list(), (grinder) => ({ archived: grinder.archived, names: [grinder.model], at: grinder.location ? [grinder.location] : [] }), grinderOf);
        return { ...rest, grinders: entries };
      }
      case "basket":
      case "tool": {
        const { entries, ...rest } = paged(await this.equipment.list(input.kind), (item) => ({ archived: item.archived, names: [item.name], at: shownLocations(item) }), equipmentOf);
        return input.kind === "basket" ? { ...rest, baskets: entries } : { ...rest, tools: entries };
      }
      case "recipe": {
        // A Recipe belongs to one Location: those of each, as the REST API lists a Location's.
        const locationIds = at === undefined ? (await this.locations.list()).map((location) => location.id) : [at];
        const recipes = (await Promise.all(locationIds.map((locationId) => this.recipes.atLocation(locationId)))).flat();
        const { entries, ...rest } = paged(recipes, (item) => ({ archived: item.archived, names: [item.name], at: item.location ? [item.location] : [] }), recipeOf);
        return { ...rest, recipes: entries };
      }
    }
  }

  @BudgetedTool({
    name: "get_library_item",
    title: "Get a Library item",
    description: `Reads one Library item as the management interface shows it, by its kind and id, and when asked for, its history, such as what changed on a Recipe today and who changed it. A Bean Batch comes with the Recipes that name it (recipes), at any Location, each with its Location and Recipe Slot: what a Batch Move or a finish affects. A Recipe names its Bean Batch (uses.beanBatch) by its roast date and batchCode, its Batch Code, null where it has none, beside its Bean (uses.bean). ${ITEMS} Each version of its history gives the fields an edit set, its first the item joining the Library; a Lost Edit among them (lost) gives the value of a field that did not apply and the edit it lost to (lostTo). historyField gives only the edits that set one field, such as a Recipe's grindSetting, its first among them. limit and offset page its history. ${PAGED} ${TIMES}`,
    inputSchema: getInput,
    outputSchema: getOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { whole: PROFILE_WHOLE, rest: "Asked for without its history, or fewer of its entries at a time, it has more of its text." },
  })
  async getLibraryItem(input: z.infer<typeof getInput>, context: McpContext): Promise<GetOutput> {
    const { scope } = callerOf(context);
    const { item, ref, itemLocation } = await this.item(input.kind, input.id, scope);
    // A field alone asks for its history.
    if (!input.history && input.historyField === undefined) return item;
    const { versions, lostEdits } = await this.history.history(ref, scope, input.historyField);
    // Each by when the server took it in or it lost, the latest first: both are PostgreSQL's times, read as ISO 8601 in UTC.
    const all = [
      ...versions.map((entry) => ({ at: entry.receivedAt, view: () => versionOf(entry, itemLocation) })),
      ...lostEdits.map((entry) => ({ at: entry.lostAt, view: () => lostEditOf(entry, itemLocation) })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const entries = all.slice(input.offset, input.offset + input.limit);
    return { ...item, history: { ...pageOf(all.length, input.offset, entries.length), entries: entries.map((entry) => entry.view()) } };
  }

  @BudgetedTool({
    name: "get_profile_versions",
    title: "Get a Profile's versions",
    description: `Reads a Profile's Profile Versions, as its page in the management interface lists them: each set of steps the Profile has had, numbered in the order they joined it, with which is current, when and by whom each was saved, where each is shown and how many Shots are on each; the Recipes that name the Profile, with the Machines that have each loaded now; and the Machines whose Workflow still holds an earlier version with no Recipe loaded. The Profile is named by its own id or by Decaid's id of any of its versions. get_library_item reads each version's steps by its Decaid id, and simulate_profile runs each on the same puck to compare them. Times are in UTC.`,
    inputSchema: profileVersionsInput,
    outputSchema: profileVersionsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "get_library_item reads one version whole." },
  })
  async getProfileVersions({ profileId }: z.infer<typeof profileVersionsInput>, context: McpContext): Promise<z.infer<typeof profileVersionsOutput>> {
    const id = readProfileId(profileId);
    const read = await this.profiles.versions(id, callerOf(context).scope);
    const recipes = await this.recipes.namingProfile(read.versions.map((version) => version.id));
    return { profile: read.profile, versions: read.versions.map(profileVersionOf), earlierOn: read.earlierOn, recipes: recipes.map(recipeOnProfileOf) };
  }

  @BudgetedTool({
    name: "list_location_batches",
    title: "List a Location's Bean Batches",
    description: `Lists the Bean Batches at one Location, a page at a time, as the Location's page in the management interface lists them: those there now, none finished there or moved away from it entirely, Archived or of an Archived Bean, the latest roasted first. Each has its Bean, roast date and Batch Code; its Remaining Weight there (remainingWeight), null where it is untracked there, which is not 0; the weight its count there starts from (entered); the Shots pulled there since and the coffee they used (used); what Batch Moves have brought there and taken away since (moved); and the Recipes at the Location that name it, with each one's Recipe Slot. Every number is that Location's own: a batch at two Locations is in each one's list with that Location's weight, Shots and moves. find_shots with beanBatchId and locationId lists a batch's Shots there, get_library_item reads a batch at every Location it is at, with every Recipe that names it, and find_library_items lists batches across Locations. ${PAGED} Times are ISO 8601 with the Location's offset.`,
    inputSchema: locationBatchesInput,
    outputSchema: locationBatchesOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "get_library_item reads one batch with more of it." },
  })
  async listLocationBatches(input: z.infer<typeof locationBatchesInput>, context: McpContext): Promise<z.infer<typeof locationBatchesOutput>> {
    const { location, batches } = await this.batches.atLocation(readLocationId(input.locationId).toLowerCase(), callerOf(context).scope);
    const shown = batches.slice(input.offset, input.offset + input.limit);
    return { ...pageOf(batches.length, input.offset, shown.length), beanBatches: shown.map((batch) => batchHereOf(batch, location)) };
  }

  /** One item as get_library_item reads it, without its history: 404's message, as the REST API's, for none. */
  async read(kind: LibraryKind, itemId: string, scope: Scope): Promise<ItemOutput> {
    return (await this.item(kind, itemId, scope)).item;
  }

  /** A Location a list is filtered by, by its id in lower case, as the REST API reads one; refused as no Location if there is none. */
  private async locationOf(locationId: string | undefined): Promise<string | undefined> {
    if (locationId === undefined) return undefined;
    const id = readLocationId(locationId).toLowerCase();
    if ((await this.prisma.location.count({ where: { id } })) === 0) throw locationNotFound();
    return id;
  }

  /** The ids of the Archived Beans. */
  private async archivedBeans(): Promise<Set<string>> {
    return new Set((await this.prisma.bean.findMany({ where: { archived: true }, select: { id: true } })).map((bean) => bean.id));
  }

  /** One item as the REST API returns it, with how its history names it and the Location it belongs to, if one. */
  private async item(kind: LibraryKind, itemId: string, scope: Scope): Promise<{ item: ItemOutput; ref: { kind: LibraryKind; id: string }; itemLocation: LocationView | null }> {
    switch (kind) {
      case "bean": {
        const bean = await this.beans.get(readBeanId(itemId), scope);
        return { item: { bean: { ...beanOf(bean), content: bean.content, batches: bean.batches.map(batchOf) } }, ref: { kind, id: bean.id }, itemLocation: null };
      }
      case "beanBatch": {
        const batch = await this.batches.get(readBeanBatchId(itemId), scope);
        return { item: { beanBatch: batchViewOf(batch) }, ref: { kind, id: batch.id }, itemLocation: null };
      }
      case "profile": {
        const profile = await this.profiles.get(readProfileId(itemId));
        return { item: { profile: profileViewOf(profile) }, ref: { kind, id: profile.id }, itemLocation: null };
      }
      case "grinder": {
        const grinder = await this.grinders.get(readGrinderId(itemId));
        return { item: { grinder: { ...grinderOf(grinder), content: grinder.content } }, ref: { kind, id: grinder.id }, itemLocation: grinder.location };
      }
      case "basket":
      case "tool": {
        const item = equipmentViewOf(await this.equipment.get(kind, readEquipmentId(kind, itemId)));
        return { item: kind === "basket" ? { basket: item } : { tool: item }, ref: { kind, id: item.id }, itemLocation: null };
      }
      case "recipe": {
        const found = await this.recipes.get(readRecipeId(itemId));
        return { item: { recipe: recipeOf(found) }, ref: { kind, id: found.id }, itemLocation: found.location };
      }
    }
  }
}

/** What find_library_items filters an item by: whether it is Archived, its names, and the Locations it is at. */
interface Filtered {
  archived: boolean;
  names: (string | null)[];
  at: readonly LocationView[];
}

/** The items at the Location, if one is given, whose names have each word of the name given, ignoring case, and Archived or not as asked. */
function chosen<T>(items: readonly T[], input: FindInput, locationId: string | undefined, filtered: (item: T) => Filtered): T[] {
  const words = (input.name ?? "").toLowerCase().split(/\s+/).filter((word) => word !== "");
  return items.filter((item) => {
    const { archived, names, at } = filtered(item);
    const text = names.filter((name) => name !== null).join(" ").toLowerCase();
    return (
      (input.archived === undefined || archived === input.archived) &&
      (locationId === undefined || at.some((here) => here.id === locationId)) &&
      words.every((word) => text.includes(word))
    );
  });
}

function shownLocations(item: { shownAt: { location: LocationView }[] }): LocationView[] {
  return item.shownAt.map((here) => here.location);
}

/** A time the REST API gives, given again with the offset of the Location it happened at, or in UTC for none. */
function timeAt(at: string, where: LocationView | null): string {
  return zonedTime(new Date(at), where?.timeZone);
}

function locationOf({ id, name, timeZone }: LocationView): z.infer<typeof location> {
  return { id, name, timeZone };
}

function maybeLocation(where: LocationView | null): z.infer<typeof location> | null {
  return where && locationOf(where);
}

function beanOf(bean: BeanSummary | BeanView): z.infer<typeof beanSummary> {
  return {
    id: bean.id,
    roaster: bean.roaster,
    name: bean.name,
    archived: bean.archived,
    offeredAt: bean.offeredAt.map(locationOf),
    createdAt: timeAt(bean.createdAt, bean.createdLocation),
    createdLocation: maybeLocation(bean.createdLocation),
    likelyDuplicates: bean.likelyDuplicates.map(({ id, roaster, name }) => ({ id, roaster, name })),
  };
}

function batchOf(batch: BeanBatchSummary | BeanBatchView): z.infer<typeof batchSummary> {
  return {
    id: batch.id,
    bean: { id: batch.bean.id, roaster: batch.bean.roaster, name: batch.bean.name },
    roastDate: batch.roastDate,
    batchCode: batch.batchCode,
    archived: batch.archived,
    locations: batch.locations.map((here) => ({ location: locationOf(here.location), ...stateOf(here, here.location) })),
    totalRemainingWeight: batch.totalRemainingWeight,
    createdAt: timeAt(batch.createdAt, batch.createdLocation),
    createdLocation: maybeLocation(batch.createdLocation),
  };
}

/** A Location's state of a batch, its times with that Location's offset. */
function stateOf(here: Omit<BatchAtLocation, "location">, where: LocationView): Omit<z.infer<typeof batchSummary>["locations"][number], "location"> {
  return {
    remainingWeight: here.remainingWeight,
    entered: here.entered && {
      weight: here.entered.weight,
      at: timeAt(here.entered.at, where),
      by: here.entered.by && sourceOf(here.entered.by),
      arrivedFrom: maybeLocation(here.entered.arrivedFrom),
    },
    used: here.used,
    moved: here.moved && {
      in: here.moved.in,
      from: here.moved.from.map((other) => ({ location: locationOf(other.location), weight: other.weight })),
      away: here.moved.away,
      to: here.moved.to.map((other) => ({ location: locationOf(other.location), weight: other.weight })),
    },
    since: timeAt(here.since, where),
  };
}

/** A batch at a Location as list_location_batches lists it. */
function batchHereOf(batch: BatchHere, where: LocationView): z.infer<typeof locationBatchesOutput>["beanBatches"][number] {
  return {
    id: batch.id,
    bean: { id: batch.bean.id, roaster: batch.bean.roaster, name: batch.bean.name },
    roastDate: batch.roastDate,
    batchCode: batch.batchCode,
    ...stateOf(batch, where),
    recipes: batch.recipes.map(({ id, name, slot }) => ({ id, name, slot })),
  };
}

function batchViewOf(batch: BeanBatchView): NonNullable<GetOutput["beanBatch"]> {
  return {
    ...batchOf(batch),
    content: batch.content,
    finished: batch.finished.map((here) => ({ location: locationOf(here.location), remainingWeight: here.remainingWeight, finishedAt: timeAt(here.finishedAt, here.location) })),
    beanArchived: batch.beanArchived,
    recipes: batch.recipes.map((recipe) => ({ ...recipe, location: maybeLocation(recipe.location) })),
  };
}

function shownOf(item: { shownAt: { location: LocationView; since: string }[] }): z.infer<typeof shownAt> {
  return item.shownAt.map((here) => ({ location: locationOf(here.location), since: timeAt(here.since, here.location) }));
}

function decidedOf(item: { locations: { location: LocationView; shown: boolean; since: string }[] }): z.infer<typeof decidedAt> {
  return item.locations.map((here) => ({ location: locationOf(here.location), shown: here.shown, since: timeAt(here.since, here.location) }));
}

function profileOf(profile: ProfileSummary | ProfileView): z.infer<typeof profileSummary> {
  return {
    id: profile.id,
    profileId: profile.profileId,
    versions: profile.versions,
    startedFrom: profile.startedFrom,
    title: profile.title,
    author: profile.author,
    beverageType: profile.beverageType,
    bundled: profile.bundled,
    archived: profile.archived,
    shownAt: shownOf(profile),
    createdAt: timeAt(profile.createdAt, profile.createdLocation),
    createdLocation: maybeLocation(profile.createdLocation),
  };
}

function profileViewOf(profile: ProfileView): NonNullable<GetOutput["profile"]> {
  return {
    ...profileOf(profile),
    content: profile.content,
    profile: profile.profile,
    version: profile.version,
    current: profile.current,
    parent: profile.parent && { id: profile.parent.id, title: profile.parent.title },
    locations: decidedOf(profile),
    machineModel: profile.machineModel,
    refusedOn: profile.refusedOn,
  };
}

function grinderOf(grinder: GrinderSummary | GrinderView): z.infer<typeof grinderSummary> {
  return {
    id: grinder.id,
    model: grinder.model,
    burrs: grinder.burrs,
    burrType: grinder.burrType,
    archived: grinder.archived,
    location: maybeLocation(grinder.location),
    createdAt: timeAt(grinder.createdAt, grinder.location),
  };
}

function equipmentOf(item: EquipmentSummary | EquipmentView): z.infer<typeof equipmentSummary> {
  return {
    id: item.id,
    name: item.name,
    archived: item.archived,
    shownAt: shownOf(item),
    createdAt: timeAt(item.createdAt, item.createdLocation),
    createdLocation: maybeLocation(item.createdLocation),
    content: item.content,
  };
}

function equipmentViewOf(item: EquipmentView): NonNullable<GetOutput["basket"]> {
  return { ...equipmentOf(item), locations: decidedOf(item) };
}

function recipeOf(found: RecipeView): z.infer<typeof recipe> {
  const { bean, beanBatch, profile, grinder, basket, tools } = found.uses;
  const shot = found.referenceShot;
  return {
    id: found.id,
    name: found.name,
    location: maybeLocation(found.location),
    slot: found.slot,
    archived: found.archived,
    createdAt: timeAt(found.createdAt, found.location),
    content: found.content,
    uses: {
      bean: bean && { id: bean.id, roaster: bean.roaster, name: bean.name },
      beanBatch: beanBatch && { id: beanBatch.id, roastDate: beanBatch.roastDate, batchCode: beanBatch.batchCode, atLocation: beanBatch.atLocation },
      profile: profile && { id: profile.id, title: profile.title },
      grinder: grinder && { id: grinder.id, model: grinder.model },
      basket: basket && { id: basket.id, name: basket.name },
      tools: tools.map((tool) => ({ id: tool.id, name: tool.name })),
    },
    batchFinished: found.batchFinished,
    // Its time is given with the offset of the Location it was pulled at.
    referenceShot: shot && {
      id: shot.id,
      pulledAt: shot.pulledAt && timeAt(shot.pulledAt, shot.location),
      machine: shot.machine,
      location: maybeLocation(shot.location),
      profileTitle: shot.profileTitle,
      profile: shot.profile,
      targetDose: shot.targetDose,
      actualDose: shot.actualDose,
      targetYield: shot.targetYield,
      actualYield: shot.actualYield,
      duration: shot.duration,
      enjoyment: shot.enjoyment,
      grinderSetting: shot.grinderSetting,
      profileDiffers: shot.profileDiffers,
    },
  };
}

function profileVersionOf(version: ProfileVersionView): z.infer<typeof profileVersionsOutput>["versions"][number] {
  return {
    id: version.id,
    number: version.number,
    current: version.current,
    title: version.title,
    bundled: version.bundled,
    archived: version.archived,
    parentId: version.parentId,
    savedAt: timeAt(version.savedAt, null),
    savedBy: version.savedBy && sourceOf(version.savedBy),
    shownAt: shownOf(version),
    shots: version.shots,
  };
}

function recipeOnProfileOf({ recipe, loadedOn }: RecipeOnProfileView): z.infer<typeof profileVersionsOutput>["recipes"][number] {
  return { recipe: { id: recipe.id, name: recipe.name, location: maybeLocation(recipe.location), slot: recipe.slot }, loadedOn };
}

function sourceOf({ machine, tabletId, barista, account, connectedApp }: SourceView): z.infer<typeof source> {
  return {
    machine: machine && { id: machine.id, name: machine.name },
    tabletId,
    barista,
    account: account && { id: account.id, name: account.name },
    connectedApp: connectedApp && { id: connectedApp.id, name: connectedApp.name, host: connectedApp.host },
  };
}

/** A version, its times with the offset of the Location whose state it changed, or else of the one its item belongs to. */
function versionOf(entry: VersionView, itemLocation: LocationView | null): z.infer<typeof historyEntry> {
  const where = entry.location ?? itemLocation;
  return {
    id: entry.id,
    fields: entry.fields,
    location: maybeLocation(entry.location),
    source: sourceOf(entry.source),
    editedAt: timeAt(entry.editedAt, where),
    receivedAt: timeAt(entry.receivedAt, where),
    copiedFrom: entry.copiedFrom && { id: entry.copiedFrom.id, name: entry.copiedFrom.name, location: maybeLocation(entry.copiedFrom.location) },
    move: entry.move && { from: maybeLocation(entry.move.from), to: maybeLocation(entry.move.to), amount: entry.move.amount, all: entry.move.all },
    lost: false,
    lostTo: null,
  };
}

/** A Lost Edit as an entry of its item's history, its times with the offset of the Location whose state it is of, or else of the one its item belongs to. */
function lostEditOf(entry: LostEditView, itemLocation: LocationView | null): z.infer<typeof historyEntry> {
  const where = entry.location ?? itemLocation;
  return {
    id: entry.id,
    fields: { [entry.field]: entry.value ?? null },
    location: maybeLocation(entry.location),
    source: sourceOf(entry.source),
    editedAt: timeAt(entry.editedAt, where),
    receivedAt: timeAt(entry.lostAt, where),
    copiedFrom: null,
    move: null,
    lost: true,
    lostTo: entry.lostTo && {
      versionId: entry.lostTo.versionId,
      value: entry.lostTo.value ?? null,
      source: sourceOf(entry.lostTo.source),
      editedAt: timeAt(entry.lostTo.editedAt, where),
    },
  };
}
