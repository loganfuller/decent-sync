import { BadRequestException, Injectable } from "@nestjs/common";
import { SHOT_CURVES, STEAM_CURVES, steamSamples } from "@decent-sync/protocol";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { readRecordFilters } from "../record-filters.js";
import { recordedText } from "../shots/extraction.js";
import { MAX_WORDS, type ShotFilters, readShotFilters } from "../shots/filters.js";
import { ShotsService } from "../shots/shots.service.js";
import { DEFAULT_NUMBERS, GROUPINGS, LAST_STEPS, MAX_GROUPINGS, NUMBERS, groupingsOf, numbersOf } from "../shots/summary.js";
import { SteamRecordsService } from "../steam-records/steam-records.service.js";
import { type Budget, BudgetedTool, CUT_MARK, MIN_CUT, cut, cutNoteOf, refuseCutText } from "./budget.js";
import { askedCurves, curveSchema, curvesInput, shadedSchema, thinnedToSchema, withCurves } from "./curves.js";
import { MAX_PAGE, PAGED, page, pageOf, pageOutput } from "./paging.js";
import { timeBound, timeRange, zonedTime } from "./times.js";

// Shots and Steam Records, found and read through an assistant as the REST
// API lists and reads them, calling the same services (#408, ADR-0026).
// Every account reads every one, as through the REST API.

const id = z.string();
const machine = z.object({ id, name: z.string() }).nullable().describe("The Machine it is credited to; null while it waits for an Admin to name the Machine that recorded it.");
const location = z
  .object({ id, name: z.string(), timeZone: z.string() })
  .nullable()
  .describe("The Location its Machine was at then, by the Machine's Location History; null when unknown. Its times are given with this time zone's offset.");
const seconds = (what: string) => z.number().nullable().describe(`${what}, in seconds.`);
const celsius = (what: string) => z.number().nullable().describe(`${what}, in °C.`);

const shotBasics = z.object({
  id,
  pulledAt: z.string().nullable().describe("When it was pulled; null when unknown."),
  machine,
  machineInferred: z.boolean().describe("It recorded no machine hardware, so it is credited to the Machine whose tablet reported it."),
  location,
  locationInferred: z.boolean().describe("Its Location comes from the Location History of a Machine it is credited to by inference."),
  recipe: z.object({ id, name: z.string().nullable() }).nullable().describe("The Recipe its Machine had loaded as it was pulled."),
  profile: z.object({ id, title: z.string().nullable() }).nullable().describe("The Library's Profile it was pulled with."),
  profileTitle: z.string().nullable().describe("Its profile's title, as the Shot recorded it."),
  bean: z.object({ roaster: z.string().nullable(), name: z.string().nullable() }).describe("Its Bean, as the Shot recorded it."),
  beanBatch: z
    .object({ id, bean: z.object({ id, roaster: z.string().nullable(), name: z.string().nullable() }), roastDate: z.string().nullable() })
    .nullable()
    .describe("The Library's Bean Batch it used."),
  grinder: z.object({ id, model: z.string().nullable() }).nullable().describe("The Library's Grinder it used."),
  basket: z.object({ id, name: z.string().nullable() }).nullable().describe("The Library's Basket it used."),
  targetDose: z.number().nullable().describe("In grams."),
  actualDose: z.number().nullable().describe("Weighed, in grams."),
  targetYield: z.number().nullable().describe("In grams."),
  actualYield: z.number().nullable().describe("Weighed, in grams."),
  lastRecordedWeight: z
    .object({ weight: z.number(), seconds: z.number() })
    .nullable()
    .describe("The scale's last weight sample after its Preheat, in grams, at its seconds on its curves' axis, just before the stop; null without one."),
  duration: seconds("How long its profile ran, leaving out its Preheat"),
  enjoyment: z.number().nullable().describe("As rated on the tablet."),
  barista: z.string().nullable(),
  peakPressure: z.number().nullable().describe("In bar, leaving out its Preheat."),
  peakFlow: z.number().nullable().describe("In ml/s, leaving out its Preheat."),
});

const step = z.object({ frame: z.number().describe("Its index among its Profile's steps, from 0."), name: z.string() });

const shotDetails = shotBasics.extend({
  grinderModel: z.string().nullable().describe("Its Grinder's model, as the Shot recorded it, linked to the Library or not."),
  basketName: z.string().nullable().describe("Its Basket's name, as the Shot recorded it, linked to the Library or not."),
  grinderSetting: z.string().nullable().describe("Its Grinder's setting, as its Workflow recorded it."),
  grinderBurrs: z.string().nullable().describe("The burrs its Grinder had fitted."),
  tds: z.number().nullable().describe("Total dissolved solids, in %."),
  extractionYield: z.number().nullable().describe("In %."),
  notes: z.string().nullable().describe("As typed on the tablet."),
  stopReason: z.string().nullable().describe("What stopped it, as Decaid recorded it."),
  lastStep: step.nullable().describe("The step of its Profile it ended in; null when it stopped in its Preheat, or its samples name no step."),
  timeToFirstDrip: z
    .number()
    .nullable()
    .describe("From the start of its profile to the scale's first reading of 1 g or more, in seconds; null where none read that, as without a scale, and until worked out."),
  flowAtStop: z.number().nullable().describe("The scale's weight flow at its last weight sample, in g/s; null without one, or where it recorded no weight flow, and until worked out."),
  steps: z
    .array(step.extend({ from: z.number(), until: z.number() }))
    .describe("The steps of its Profile it ran, in order, each from and until in seconds on its curves' axis, until where the next starts or it ends."),
  previousShot: z
    .object({ id, pulledAt: z.string() })
    .nullable()
    .describe("The Shot pulled just before it on the same Machine, its time with this Shot's Location's offset."),
  curves: z
    .object({
      shaded: shadedSchema("Its Preheat, the Machine heating its water before the profile starts, as the management interface shades it: before 0 s, with the heater test's targets, left out of its duration and peaks."),
      thinnedTo: thinnedToSchema,
      pressure: curveSchema("Pressure."),
      flow: curveSchema("The pump's flow."),
      weight: curveSchema("The scale's weight."),
      weightFlow: curveSchema("The scale's weight flow, the rate coffee lands in the cup."),
      temperature: curveSchema("The group temperature, measured at the group head, the closest to the coffee."),
    })
    .optional()
    .describe("Only when asked for, all or those listed. Seconds from the start of its profile, after its Preheat."),
});

/** About the most characters a name typed by people keeps in a find_shots row, and its notes, each cut beyond them ending in CUT_MARK (`cut`). */
const ROW_NAME = 60;
const ROW_NOTES = MIN_CUT;

// Each of a row's fields is left out where it has no value, but an item's id, null where the Shot isn't linked to the
// Library's (`present`).
const libraryItem = <T extends z.ZodRawShape>(names: T, what: string) =>
  z
    .object({ id: id.nullable(), ...names })
    .optional()
    .describe(`${what}: the Library's id and name, or, where the Shot isn't linked to the Library's, a null id and the name it recorded; left out where it has neither.`);
const text = z.string().optional();
const amount = (unit: string) => z.number().optional().describe(unit);

/** A Shot as find_shots lists it: compact, without what a list repeats or fields without a value, and with how it went (#437). */
const shotRow = z.object({
  id,
  pulledAt: z.string().optional().describe("When it was pulled; left out when unknown."),
  machine: z.object({ id, name: z.string() }).optional().describe("The Machine it is credited to; left out while it waits for an Admin to name the Machine that recorded it."),
  machineInferred: z.literal(true).optional().describe("Only when true: it recorded no machine hardware, so it is credited to the Machine whose tablet reported it."),
  location: z.object({ id, name: z.string() }).optional().describe("The Location its Machine was at then; left out when unknown."),
  locationInferred: z.literal(true).optional().describe("Only when true: its Location comes from the Location History of a Machine it is credited to by inference."),
  recipe: z.object({ id, name: text }).optional().describe("The Recipe its Machine had loaded as it was pulled, by the Library's name."),
  profile: libraryItem({ title: text }, "The Profile it was pulled with"),
  beanBatch: libraryItem({ roaster: text, name: text, roastDate: text }, "The Bean Batch it used, by its Bean's roaster and name, and the Library's roast date"),
  grinder: libraryItem({ model: text }, "The Grinder it used"),
  grinderSetting: text.describe("As its Workflow recorded it."),
  basket: libraryItem({ name: text }, "The Basket it used"),
  targetDose: amount("In grams."),
  actualDose: amount("Weighed, in grams."),
  targetYield: amount("In grams."),
  actualYield: amount("Weighed, in grams."),
  duration: amount("How long its profile ran, leaving out its Preheat, in seconds."),
  timeToFirstDrip: amount("From the start of its profile to the scale's first reading of 1 g or more, in seconds."),
  peakPressure: amount("In bar, leaving out its Preheat."),
  peakFlow: amount("In ml/s, leaving out its Preheat."),
  stopReason: text.describe("What stopped it, as Decaid recorded it."),
  lastStep: step.optional().describe("The step of its Profile it ended in."),
  enjoyment: amount("As rated on the tablet."),
  barista: text,
  tds: amount("Total dissolved solids, in %."),
  extractionYield: amount("In %."),
  notes: text.describe(`As typed on the tablet, cut beyond about ${ROW_NOTES} characters.`),
});

const steamSummary = z.object({
  id,
  steamedAt: z.string().describe("When it started."),
  machine,
  location,
  duration: seconds("How long it steamed, leaving out the steam starting up, its pauses, puffs and purge"),
  peakMilkTemperature: celsius("The highest milk temperature, leaving out a reading carried over from the Steam Record before"),
  finalMilkTemperature: celsius("The last milk temperature"),
  barista: z.string().nullable(),
  steamSettings: z
    .object({
      steamTemperature: celsius("Its target temperature"),
      duration: seconds("How long it steams before stopping by itself"),
      flow: z.number().nullable().describe("In ml/s."),
      stopAtMilkTemperature: celsius("The milk temperature it stops at; null when off"),
    })
    .describe("What its Workflow set when it started."),
});

const steamDetails = steamSummary.extend({
  curves: z
    .object({
      shaded: shadedSchema(
        "The time that isn't steaming, as the management interface shades it, left out of its duration: Preparing, before 0 s, the steam starting up; Paused, the flow falling after a stop; Puffing, small puffs that keep the wand clear after a stop on time or Two Tap Stop's first tap; Purge, clearing the wand after the last stop.",
      ),
      thinnedTo: thinnedToSchema,
      milkTemperature: curveSchema("The milk temperature its probe reported; its target is the temperature its Workflow stops at."),
      steamTemperature: curveSchema("The steam heater's temperature."),
      pressure: curveSchema("The steam's pressure."),
      flow: curveSchema("The steam's flow."),
    })
    .optional()
    .describe("Only when asked for, all or those listed. Seconds from when it started steaming."),
});

const shotCurves = curvesInput(SHOT_CURVES, { window: true });
const curveWindow = z
  .object({
    from: z.number().optional().describe("In seconds on its curves' axis; from its first sample when left out."),
    until: z.number().optional().describe("In seconds on its curves' axis; until its last sample when left out."),
  })
  // Refuses any other key, such as the `to` other tools' ranges end with, rather than dropping it and running to the Shot's end.
  .strict()
  .optional()
  .describe("Only the curves' readings in this stretch of their axis, its bounds included: every one if the response fits, otherwise each series thinned to as many as fit (thinnedTo). With curves false or left out, it gives all of them.");
const getShotInput = z.object({ id: id.describe("The Shot's id."), curves: shotCurves, window: curveWindow });
const steamCurves = curvesInput(STEAM_CURVES);
const timeZoneNote = "Times are ISO 8601, with the offset of the record's Location's time zone, or UTC's when its Location is unknown.";

/** What a Shot's numbers mean, for the descriptions of the tools that read Shots. */
const SHOT_UNITS =
  "Doses and yields are in grams, targets as set and actuals as weighed. duration is in seconds, peakPressure in bar and peakFlow in ml/s, each leaving out the Preheat, the Machine heating its water before the profile starts. enjoyment is as rated on the tablet. A Shot's bean is as it recorded it, and beanBatch, grinder, basket, profile and recipe the Library's it is linked to. machineInferred: it recorded no machine hardware, so it is credited to the Machine whose tablet reported it; locationInferred: its Location comes from that Machine's Location History.";

/** What each stop reason Decaid records means. */
const STOP_REASONS =
  "stopReason is what Decaid recorded stopping it: targetWeight, Decaid stopping it as the scale's projected weight reached the target yield; targetVolume, Decaid stopping it at the target water volume, without a scale; machineEnded, the Machine ending it itself, as its profile finishes or it is stopped on the Machine; appStop, the Stop button in Decaid's own app; apiStop, a stop through Decaid's API, as a skin's such as Streamline's; error, the Machine going into an error state. Another value is Decaid's name for what stopped it.";

/** What get_shot's steps, lastStep, lastRecordedWeight, flowAtStop and timeToFirstDrip are. */
const SHOT_STEPS =
  "steps are the steps of its Profile it ran, in order, each with its frame, its index among the Profile's steps from 0, its name, Step N, from 1, where the Profile names none, and from and until, where the next starts or the Shot ends; a step that ended between two samples is left out. lastStep is the one it ended in, null when it stopped in its Preheat or its samples name no step; get_library_item gives a linked Profile's steps, to see which it never reached. lastRecordedWeight is the scale's last weight sample after its Preheat, in grams, at its seconds, and flowAtStop the scale's weightFlow at that sample, in g/s, each null without one. Decaid records no sample after the stop, so both are just before the stop, or earlier if the scale dropped out. actualYield, which Decaid keeps weighing after the stop until the flow settles, minus that weight is roughly what arrived after the stop; that difference is wrong if the yield was edited on the tablet, which the server can't tell. timeToFirstDrip is when the scale first read 1 g or more, null where it never did, as without a scale. It and flowAtStop are null too until the server has worked them out.";

/** What a Steam Record's numbers mean, its steam settings' included. */
const STEAM_UNITS =
  "duration is in seconds, counting only the steaming, not the steam starting up, its pauses, puffs or purge. Milk temperatures are in °C, peakMilkTemperature leaving out a reading carried over from the Steam Record before. steamSettings are what its Workflow set as it started: steamTemperature in °C, duration in seconds, how long it steams before stopping by itself, flow in ml/s, and stopAtMilkTemperature in °C, the milk temperature it stops at, null when off.";

/** What a record's curves mean. */
const CURVES_NOTE =
  "curves is true for all of them, or a list of those to give. Each gives its unit, its readings as [seconds, value] points, and its targets, the targets the Machine reported, which the management interface draws dashed, empty where it reported none. A series of more than 100 readings is thinned to 100, keeping its shape and peaks; thinnedTo gives the most points one was thinned to, null where every reading is given.";

/** A text filter of find_shots, matching as its match says (`ShotFilters.match`), with what more it does, if anything. */
const textFilter = (which: string, more = "") =>
  z
    .string()
    .max(500)
    .optional()
    .describe(`${which} matches this as match says: by default, each of up to ${MAX_WORDS} words anywhere, ignoring case. An empty one finds Shots that recorded none, and so does one of spaces alone when matching words.${more}`);

/** The filters find_shots finds Shots by, which summarise_shots takes too. */
const shotFilters = {
  locationId: id.optional().describe("Shots pulled at this Location; none for those at no Location."),
  machineId: id.optional().describe("Shots credited to this Machine."),
  beanId: id.optional().describe("Shots that used any Bean Batch of this Library Bean."),
  beanBatchId: id.optional().describe("Shots that used this Library Bean Batch; none for those linked to none."),
  profileId: id.optional().describe("Shots pulled with this Library Profile."),
  grinderId: id.optional().describe("Shots that used this Library Grinder; none for those linked to none."),
  basketId: id.optional().describe("Shots that used this Library Basket; none for those linked to none."),
  recipeId: id.optional().describe("Shots pulled with this Recipe loaded; none for those pulled with none."),
  barista: textFilter(
    "Shots whose Barista, as each Shot records it,",
    " With match exact it is one Barista's name, still ignoring case and the spaces around it, and an empty or blank one finds Shots that recorded none or a blank name.",
  ),
  beanRoaster: textFilter("Shots whose Bean's roaster, as each Shot records it, linked to the Library or not,"),
  beanName: textFilter("Shots whose Bean's name, as each Shot records it, linked to the Library or not,"),
  profileTitle: textFilter("Shots whose profile's title, as each Shot records it,"),
  match: z
    .enum(["words", "exact"])
    .default("words")
    .describe(
      "How barista, beanRoaster, beanName and profileTitle match: words, each of their words anywhere, ignoring case; or exact, the whole of what each Shot recorded, case included, to pick one value list_shot_values gives alone, but that barista still ignores case and the spaces around the name.",
    ),
  from: timeBound("Shots pulled from this time on."),
  to: timeBound("Shots pulled up to this time, through the end of a day given as a date."),
};
const shotFiltersInput = z.object(shotFilters);
const findShotsInput = z.object({ ...shotFilters, ...page });
const findShotsOutput = z.object({ ...pageOutput, shots: z.array(shotRow) });
const findShotsBudget: Budget = { rest: "get_shot reads one Shot whole, with more of it." };

/** What a find_shots row's fields mean, for its description. */
const SHOT_ROW = `Each Shot gives its machine and location; its recipe, profile, beanBatch (its Bean's roaster and name, and its roast date), grinder and basket, each with the Library's id and name, or, where the Shot isn't linked to the Library's, a null id and the name it recorded, a recipe being only the Library's; and grinderSetting, as its Workflow recorded it. A field with no value, such as notes where none were typed, is left out, but an item's id, given null where it isn't linked. Doses and yields are in grams, targets as set and actuals as weighed. duration is in seconds, peakPressure in bar and peakFlow in ml/s, each leaving out the Preheat, the Machine heating its water before the profile starts. timeToFirstDrip is the seconds from the start of its profile to the scale's first reading of 1 g or more, left out where none read that, as without a scale. lastStep is the step of its Profile it ended in, with its frame, its index among the Profile's steps from 0, and its name, Step N, from 1, where the Profile names none; it is left out for a Shot stopped in its Preheat, or whose samples name no step. Both are left out too until the server has worked them out. enjoyment is as rated on the tablet; tds (total dissolved solids) and extractionYield are in %. Amounts are to two decimal places, and roastDate a day. machineInferred, given only when true: it recorded no machine hardware, so it is credited to the Machine whose tablet reported it; locationInferred, only when true: its Location comes from that Machine's Location History. Names over about ${ROW_NAME} characters and notes over about ${ROW_NOTES} end in ${CUT_MARK}, and get_shot reads them whole.`;

/** How find_shots' filters find Shots, for the descriptions of the tools that take them. */
const SHOT_FILTERS =
  "The barista, beanRoaster, beanName and profileTitle filters match each of their words anywhere in what each Shot recorded, ignoring case, or, with match exact, the whole of it; list_shot_values lists what Shots recorded, and match exact picks one of its values alone, not those holding its words too. A Barista is one whatever the name's case and the spaces around it: with match exact, barista finds every such spelling, jules and Jules alike, and list_shot_values and summarise_shots give each Barista once, by the latest spelling. A linked item's name is the Library's, which may differ from what the Shot recorded and those filters match, so find a linked item's Shots by its id.";

const summaryNumber = <T extends z.ZodRawShape = Record<never, never>>(what: string, more?: T) =>
  z
    .object({
      shots: z.number().describe("How many Shots had a value, which the median and percentiles rest on."),
      median: z.number().nullable(),
      p25: z.number().nullable().describe("The 25th percentile."),
      p75: z.number().nullable().describe("The 75th percentile: the middle half of the Shots fall from p25 to it."),
      ...(more ?? ({} as T)),
    })
    .optional()
    .describe(`${what} Null where no Shot had a value; given only when asked for.`);

const summariseShotsInput = z.object({
  ...shotFilters,
  groupBy: z
    .array(z.enum(GROUPINGS))
    .max(MAX_GROUPINGS)
    .default([])
    .describe(`What to group the Shots by, up to ${MAX_GROUPINGS}, the first then the second, such as recipe then machine; one group of them all if none.`),
  numbers: z
    .array(z.enum(NUMBERS))
    .min(1)
    .optional()
    .describe(`Which numbers to give, each once; ${DEFAULT_NUMBERS.slice(0, -1).join(", ")} and ${DEFAULT_NUMBERS.at(-1)} if none.`),
  limit: page.limit.describe(`How many groups to give, from 1 to ${MAX_PAGE}.`),
  offset: page.offset.describe("How many groups to skip, in their order: the previous page's offset plus its length."),
});
const namedLocation = z.object({ id, name: z.string() });
const recorded = z.string().nullable();
// Null for the group of Shots with none, and left out unless grouped by.
const groupedBy = <T extends z.ZodType>(entry: T, what: string) => entry.nullable().optional().describe(what);
const summaryGroupBy = z
  .object({
    location: groupedBy(namedLocation, "The Location the Shots were pulled at."),
    machine: groupedBy(z.object({ id, name: z.string() }), "The Machine the Shots are credited to; null for a pendingMachine's."),
    pendingMachine: groupedBy(
      z.object({ id, model: z.string(), serial: z.string() }),
      "Given with machine: the hardware that recorded the Shots, where they wait for an Admin to name its Machine; null for a Machine's.",
    ),
    recipe: groupedBy(z.object({ id, name: recorded, location: namedLocation.nullable() }), "The Recipe the Shots were pulled with loaded, and the Location it belongs to."),
    bean: groupedBy(z.object({ roaster: recorded, name: recorded }), "The Bean's roaster and name, as the Shots recorded them."),
    beanBatch: groupedBy(z.object({ id, bean: z.object({ id, roaster: recorded, name: recorded }), roastDate: recorded }), "The Library's Bean Batch the Shots used."),
    profile: groupedBy(z.string(), "The profile's title, as the Shots recorded it."),
    grinder: groupedBy(z.object({ id, model: recorded, location: namedLocation.nullable() }), "The Library's Grinder the Shots used, and the Location it belongs to."),
    basket: groupedBy(z.object({ id, name: recorded }), "The Library's Basket the Shots used."),
    barista: groupedBy(z.string(), "The Barista, by the most recent spelling of the name."),
  })
  .describe("What the group is grouped by: an entry for each of groupBy, null for its group of Shots with none; empty without groupBy.");
const summariseShotsOutput = z.object({
  ...pageOutput,
  groups: z
    .array(
      z.object({
        by: summaryGroupBy,
        counts: z.object({
          shots: z.number().describe("The Shots its numbers cover."),
          unfinished: z.number().describe("The Unfinished Shots left out of them: nothing poured."),
          cleaningAndCalibration: z.number().describe("The cleaning and calibration Shots left out of them."),
          awaitingValues: z.number().describe("Of shots, those the server hasn't yet worked out timeToFirstDrip and lastStep for."),
        }),
        numbers: z.object({
          yieldAgainstTarget: summaryNumber("Each Shot's yield as weighed less its target yield, in grams, negative under target."),
          duration: summaryNumber("How long each Shot's profile ran, leaving out its Preheat, in seconds."),
          stoppedOnWeight: z
            .object({
              shots: z.number().describe("How many Shots recorded a stop reason."),
              share: z.number().nullable().describe("The part of them stopped by targetWeight, from 0 to 1; null where none recorded one."),
            })
            .optional()
            .describe("The share of Shots that stopped on weight; given only when asked for."),
          ratio: summaryNumber("Each Shot's yield weighed over its dose weighed."),
          peakPressure: summaryNumber("Each Shot's peak pressure, leaving out its Preheat, in bar."),
          peakFlow: summaryNumber("Each Shot's peak flow, leaving out its Preheat, in ml/s."),
          rating: summaryNumber("Each Shot's enjoyment as rated on its tablet, 0 to 10, where above 0.", {
            rated: z.number().nullable().describe("The part of counts.shots rated, from 0 to 1; null where there are none."),
          }),
          grindSetting: summaryNumber("Each Shot's grind setting, where it is a decimal number.", {
            lowest: z.number().nullable(),
            highest: z.number().nullable(),
          }),
          tds: summaryNumber("Each Shot's total dissolved solids, in %."),
          extractionYield: summaryNumber("Each Shot's extraction yield, in %."),
          timeToFirstDrip: summaryNumber("Seconds from the start of each Shot's profile to the scale's first reading of 1 g or more."),
          lastStep: z
            .object({
              shots: z.number().describe("How many Shots ended in a step of their Profile."),
              mostCommon: z
                .array(z.object({ frame: z.number(), name: z.string().nullable(), shots: z.number() }))
                .describe(`The steps they ended in, the ${LAST_STEPS} most of them did, most first.`),
            })
            .optional()
            .describe("The steps of their Profiles the Shots ended in; given only when asked for."),
        }),
      }),
    )
    .describe("A page of the groups, in their order; without groupBy, one group, every Shot the filters find."),
});

/** What summarise_shots' groups are, for its description. */
const SHOT_GROUPS = `groupBy takes up to ${MAX_GROUPINGS} of ${GROUPINGS.slice(0, -1).join(", ")} and ${GROUPINGS.at(-1)}, such as recipe then machine, to compare Machines on one Recipe; without it, groups holds one group, every Shot the filters find. A group's by gives an entry for each grouping, a Library item, Machine or Location by id, a recipe's and grinder's location the one it belongs to, and bean, profile and barista as the Shots recorded them, null for the group of none. By machine, Shots waiting for an Admin to name the Machine that recorded them are a group of their own: machine null, and pendingMachine, that hardware's model and serial, which find_shots has no filter for. find_shots finds a group's Shots with the same filters and the group's: its id as locationId, machineId, recipeId, beanBatchId, grinderId or basketId, each but machineId none for the group of none, or, with match exact, its bean's roaster and name as beanRoaster and beanName, its profile as profileTitle and its barista as barista, each empty for the group of none. match is one for every text filter, so to open bean, profile or barista groups, summarise with no text filter or with match exact. Groups are ordered by the first grouping, then the second, each by name, ignoring case, then id, with its group of none last, and limit and offset page them.`;

/** The lists list_shot_values gives, as `GET /api/shots/filters` gives them. */
const SHOT_VALUE_KINDS = ["beans", "baristas", "profileTitles", "beanBatches", "grinders", "recipes", "baskets"] as const;

const shotValuesInput = z.object({
  kinds: z.array(z.enum(SHOT_VALUE_KINDS)).min(1).optional().describe("Which lists to give; all of them if none."),
  ...page,
  offset: page.offset.describe("How many of each list to skip: the previous page's offset plus its length."),
});

const valuesPage = <T extends z.ZodType>(entry: T, what: string) => z.object({ ...pageOutput, entries: z.array(entry) }).optional().describe(what);
const atLocation = z.object({ id, name: z.string() }).nullable().describe("The Location it belongs to.");
const recordedNone = "null, last, for Shots that recorded none";
const linkedNone = "null, last, for Shots linked to none";

const shotValuesOutput = z.object({
  beans: valuesPage(
    z.object({ roaster: z.string().nullable(), name: z.string().nullable() }),
    "The Beans Shots recorded, by roaster and name, linked to the Library or not; one whose roaster and name are both null stands for Shots that recorded neither.",
  ),
  baristas: valuesPage(z.string().nullable(), `The Baristas Shots recorded, each once, by the most recent spelling of the name; null, last, for Shots that recorded none or a blank name.`),
  profileTitles: valuesPage(z.string().nullable(), `The profile titles Shots recorded; ${recordedNone}.`),
  beanBatches: valuesPage(
    z.object({ id, bean: z.object({ id, roaster: z.string().nullable(), name: z.string().nullable() }), roastDate: z.string().nullable() }).nullable(),
    `The Library's Bean Batches Shots are linked to, by their Bean's roaster and name and their roast date, as the Bean Batches list orders them; ${linkedNone}.`,
  ),
  grinders: valuesPage(z.object({ id, model: z.string().nullable(), location: atLocation }).nullable(), `The Library's Grinders Shots are linked to, by model, then Location; ${linkedNone}.`),
  recipes: valuesPage(
    z.object({ id, name: z.string().nullable(), location: atLocation }).nullable(),
    `The Recipes Shots were pulled with loaded, by name, then Location; ${linkedNone}.`,
  ),
  baskets: valuesPage(z.object({ id, name: z.string().nullable() }).nullable(), `The Library's Baskets Shots are linked to, by name; ${linkedNone}.`),
});

const findSteamRecordsInput = z.object({
  locationId: id.optional().describe("Steam Records at this Location."),
  machineId: id.optional().describe("Steam Records credited to this Machine."),
  from: timeBound("Steam Records from this time on."),
  to: timeBound("Steam Records up to this time, through the end of a day given as a date."),
  ...page,
});
const findSteamRecordsOutput = z.object({ ...pageOutput, steamRecords: z.array(steamSummary) });

type ListedShot = Awaited<ReturnType<ShotsService["list"]>>["shots"][number];
type ShownShot = Awaited<ReturnType<ShotsService["get"]>>;
type ShownSteamRecord = Awaited<ReturnType<SteamRecordsService["get"]>>;

/**
 * Shots and Steam Records, found and read through an assistant: each list
 * with the REST API's filters and order, a page at a time, and each record
 * with its curves when asked for, cut for an assistant (`curvesOf`).
 */
@Injectable()
export class RecordsTools {
  constructor(
    private readonly shots: ShotsService,
    private readonly steamRecords: SteamRecordsService,
  ) {}

  @BudgetedTool({
    name: "find_shots",
    title: "Find Shots",
    description: `Finds Shots, newest first, a page at a time, by Location, Machine, Library item, the Bean, profile and Barista each recorded, and time, each with how it went. ${SHOT_ROW} ${STOP_REASONS} Each filter's id is one these Shots give, or one get_shot, list_shot_values or find_library_items gives, such as a Bean's. ${SHOT_FILTERS} ${PAGED} ${timeZoneNote}`,
    inputSchema: findShotsInput,
    outputSchema: findShotsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: findShotsBudget,
  })
  async findShots(input: z.infer<typeof findShotsInput>): Promise<z.infer<typeof findShotsOutput> & { cut?: string }> {
    const { limit, offset, ...named } = input;
    const found = await this.shots.list(limit, offset, shotFiltersOf(named));
    const cuts = { any: false };
    const shorten = (text: string | null, at: number) => {
      const kept = text === null ? null : cut(text, at);
      if (kept !== text) cuts.any = true;
      return kept;
    };
    const shots = found.shots.map((shot) => shotRowOf(shot, shorten));
    // First, as the guard's note is, which says the same.
    return { ...(cuts.any && { cut: cutNoteOf(findShotsBudget) }), ...pageOf(found.total, offset, found.shots.length), shots };
  }

  @BudgetedTool({
    name: "summarise_shots",
    title: "Summarise Shots",
    description: `Summarises the Shots find_shots finds for the same filters in one call: how many there are and how they went, as one group or, with groupBy, by group, such as each Machine's. counts.shots is how many Shots a group's numbers cover. Left out of every number and counted apart are counts.unfinished, its Unfinished Shots, in which nothing poured: the Machine never reported pouring and the scale never read 1 g, as in a Shot stopped at once; and counts.cleaningAndCalibration, those whose profile's type, as recorded, is cleaning or calibrate. The three add up to find_shots' total for the same filters and the group's. counts.awaitingValues is how many of counts.shots have no timeToFirstDrip or lastStep yet, stored before the server kept them, which it is working out; they count as poured. numbers gives those numbers names, by default ${DEFAULT_NUMBERS.slice(0, -1).join(", ")} and ${DEFAULT_NUMBERS.at(-1)}, worked out as read, so an edit on the tablet shows next time: yieldAgainstTarget, yield weighed less target, in grams, negative under, none where the target is 0 or missing; duration in seconds, peakPressure in bar and peakFlow in ml/s, each leaving out the Preheat, the Machine heating its water before the profile starts; ratio, yield over dose weighed, none where the dose is 0 or missing; rating, the enjoyment rated on the tablet, 0 to 10, where above 0, as 0 is unrated, with rated, the share of counts.shots rated; grindSetting, where the whole setting recorded is a decimal number, such as 8.8, not text, with its lowest and highest; tds (total dissolved solids) and extractionYield, in %, as recorded; and timeToFirstDrip, seconds from the profile's start to the scale's first reading of 1 g or more. Each is a median with p25 and p75, between which the middle half fall, and shots, how many Shots had a value: a median of 3 says less than one of 80. They are null where none had. stoppedOnWeight is the share, 0 to 1, of the Shots that recorded a stop reason whose reason is targetWeight, Decaid stopping it as the scale's projected weight reached the target, with shots, how many recorded one. lastStep gives shots, how many ended in a step of their Profile, and mostCommon, the ${LAST_STEPS} steps most of them ended in, each with its frame, from 0, name and shots. ${SHOT_GROUPS} ${PAGED} For two time ranges, ask twice. Its filters are find_shots', and match as there.`,
    inputSchema: summariseShotsInput,
    outputSchema: summariseShotsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for fewer groups at a time, it has more of each name." },
  })
  async summariseShots(input: z.infer<typeof summariseShotsInput>): Promise<z.infer<typeof summariseShotsOutput>> {
    const { groupBy, numbers, limit, offset, ...named } = input;
    const summary = await this.shots.summary(shotFiltersOf(named), groupingsOf(groupBy), { limit, offset }, numbersOf(numbers ?? DEFAULT_NUMBERS));
    // A roast date as its day, as find_shots gives one.
    const groups = summary.groups.map(({ by, ...group }) => ({ by: by.beanBatch ? { ...by, beanBatch: { ...by.beanBatch, roastDate: dayOf(by.beanBatch.roastDate) } } : by, ...group }));
    return { ...pageOf(summary.total, offset, groups.length), groups };
  }

  @BudgetedTool({
    name: "get_shot",
    title: "Get a Shot",
    description: `Reads a Shot: what it used, how it turned out, the steps of its Profile it ran, its last recorded weight, and its curves when asked for, with its Preheat marked. ${SHOT_UNITS} grinderModel and basketName are its Grinder's model and Basket's name as it recorded them, as bean is its Bean's. grinderSetting is as its Workflow recorded it. tds (total dissolved solids) and extractionYield are in %. ${STOP_REASONS} ${SHOT_STEPS} Its steps, lastRecordedWeight, timeToFirstDrip and curves are timed in seconds from the start of its profile, after its Preheat, which shaded marks before 0 s, with the heater test's targets, left out of its duration and peaks. Its curves give pressure in bar, flow in ml/s, the pump's, weight in grams as the scale weighed it, weightFlow in g/s, the rate coffee lands in the cup as the scale measured it, and temperature in °C, the group temperature, measured at the group head, the closest to the coffee. ${CURVES_NOTE} window, from and until in seconds on the curves' axis, each included and defaulting to the first or last sample, gives only the readings in it, none for a window outside the Shot: every one if the response fits, otherwise each series thinned to as many as fit, as thinnedTo says. With curves false or left out, it gives all of them. Ask for a few seconds, such as those around the stop, to see every reading there. ${timeZoneNote}`,
    inputSchema: getShotInput,
    outputSchema: shotDetails,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for without curves, it has more of its text." },
  })
  async getShot({ id, curves, window }: z.infer<typeof getShotInput>): Promise<z.infer<typeof shotDetails>> {
    if (window?.from !== undefined && window.until !== undefined && window.until < window.from) throw new BadRequestException("Choose a window's until at or after its from");
    // One read of its measurements, for its steps, last weight and curves.
    const { shot, samples } = await this.shots.read(id);
    const timeZone = shot.location?.timeZone;
    const details = {
      ...shotBasicsOf(shot),
      grinderModel: shot.grinderModel,
      basketName: shot.basketName,
      grinderSetting: shot.grinderSetting,
      grinderBurrs: shot.grinderBurrs,
      tds: shot.tds,
      extractionYield: shot.extractionYield,
      notes: shot.notes,
      stopReason: shot.stopReason,
      lastStep: shot.lastStep,
      timeToFirstDrip: shot.timeToFirstDrip,
      flowAtStop: shot.flowAtStop,
      steps: shot.steps,
      previousShot: shot.previousShot && { id: shot.previousShot.id, pulledAt: zonedTime(shot.previousShot.pulledAt, timeZone) },
    };
    // A window alone asks for every curve within it.
    const asked = askedCurves(SHOT_CURVES, window && curves === false ? true : curves);
    return asked ? withCurves(details, samples, asked, { pressure: shot.peakPressure, flow: shot.peakFlow }, window) : details;
  }

  @BudgetedTool({
    name: "list_shot_values",
    title: "List what Shots recorded",
    description: `Lists what find_shots finds Shots by, as the management interface's Shots page offers them: the Beans, by roaster and name, Baristas and profile titles Shots recorded, which find_shots' beanRoaster, beanName, barista and profileTitle filters match, each one alone with its match exact, a Barista given once, by the most recent spelling of the name, whatever its case and the spaces around it, as barista finds every such spelling, and the Library's Bean Batches, Grinders, Recipes and Baskets Shots are linked to, whose ids its beanBatchId, grinderId, recipeId and basketId filters take. A linked item's names are the Library's. Each list is sorted ignoring case, with null last for Shots that recorded none, or are linked to none. limit and offset page each list, and kinds asks for some of them alone. ${PAGED}`,
    inputSchema: shotValuesInput,
    outputSchema: shotValuesOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for fewer at a time, or one list alone, it has more of each." },
  })
  async listShotValues(input: z.infer<typeof shotValuesInput>): Promise<z.infer<typeof shotValuesOutput>> {
    const { limit, offset } = input;
    const kinds = new Set(input.kinds ?? SHOT_VALUE_KINDS);
    const options = await this.shots.filterOptions();
    const paged = <T, R>(kind: (typeof SHOT_VALUE_KINDS)[number], list: T[], view: (entry: T) => R) => {
      if (!kinds.has(kind)) return undefined;
      const entries = list.slice(offset, offset + limit);
      return { ...pageOf(list.length, offset, entries.length), entries: entries.map(view) };
    };
    const located = (location: { id: string; name: string } | null) => location && { id: location.id, name: location.name };
    return {
      beans: paged("beans", options.beans, (bean) => ({ roaster: bean.coffeeRoaster, name: bean.coffeeName })),
      baristas: paged("baristas", options.baristas, (barista) => barista),
      profileTitles: paged("profileTitles", options.profiles, (title) => title),
      beanBatches: paged("beanBatches", options.beanBatches, (batch) => batch && { id: batch.id, bean: batch.bean, roastDate: dayOf(batch.roastDate) }),
      grinders: paged("grinders", options.grinders, (grinder) => grinder && { id: grinder.id, model: grinder.model, location: located(grinder.location) }),
      recipes: paged("recipes", options.recipes, (recipe) => recipe && { id: recipe.id, name: recipe.name, location: located(recipe.location) }),
      baskets: paged("baskets", options.baskets, (basket) => basket),
    };
  }

  @BudgetedTool({
    name: "find_steam_records",
    title: "Find Steam Records",
    description: `Finds Steam Records, newest first, a page at a time, by Location, Machine and time, each with its milk temperatures and steam settings. ${STEAM_UNITS} ${PAGED} ${timeZoneNote}`,
    inputSchema: findSteamRecordsInput,
    outputSchema: findSteamRecordsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "get_steam_record reads one Steam Record with more of it." },
  })
  async findSteamRecords(input: z.infer<typeof findSteamRecordsInput>): Promise<z.infer<typeof findSteamRecordsOutput>> {
    const { from, to, limit, offset, ...named } = input;
    const times = timeRange(from, to);
    const problems: string[] = [];
    const filters = { ...readRecordFilters({ ...named, ...times.query }, problems), ...times.filters };
    if (problems.length > 0) throw new BadRequestException(problems);
    const found = await this.steamRecords.list(limit, offset, filters);
    return { ...pageOf(found.total, offset, found.steamRecords.length), steamRecords: found.steamRecords.map(steamSummaryOf) };
  }

  @BudgetedTool({
    name: "get_steam_record",
    title: "Get a Steam Record",
    description: `Reads a Steam Record: its milk temperatures, steam settings, and its curves when asked for, with the steam starting up, its pauses, puffs and purge marked. ${STEAM_UNITS} Its curves are timed in seconds from when it started steaming; shaded marks the time that isn't steaming, left out of its duration: Preparing, before 0 s, the steam starting up; Paused, the flow falling after a stop; Puffing, small puffs that keep the wand clear; Purge, clearing the wand after the last stop. milkTemperature is its probe's, in °C, its target the temperature its Workflow stops at; steamTemperature is the steam heater's, in °C; pressure is the steam's, in bar, and flow in ml/s. ${CURVES_NOTE} ${timeZoneNote}`,
    inputSchema: z.object({ id: id.describe("The Steam Record's id."), curves: steamCurves }),
    outputSchema: steamDetails,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for without curves, it has more of its text." },
  })
  async getSteamRecord({ id, curves }: { id: string; curves: z.infer<typeof steamCurves> }): Promise<z.infer<typeof steamDetails>> {
    const steamRecord = await this.steamRecords.get(id);
    const details = steamSummaryOf(steamRecord);
    const asked = askedCurves(STEAM_CURVES, curves);
    if (!asked) return details;
    const samples = steamSamples(await this.steamRecords.measurements(id), steamRecord.steamSettings.stopAtMilkTemperature);
    return withCurves(details, samples, asked, { milkTemperature: steamRecord.peakMilkTemperature });
  }
}

/**
 * The Shots list's filters find_shots' name, as the REST API reads them
 * (`readShotFilters`), with a date for each Location's day and a moment as
 * itself (`timeRange`). A name a find_shots row cut is refused, as no Shot
 * recorded one.
 */
function shotFiltersOf({ from, to, beanRoaster, beanName, ...named }: z.infer<typeof shotFiltersInput>): ShotFilters {
  refuseCutText({ beanRoaster, beanName, ...named }, "matching words, a few of its words find its Shots, get_shot reads a Shot's names whole, and a linked item's Shots are found by its id");
  const times = timeRange(from, to);
  return { ...readShotFilters({ ...named, coffeeRoaster: beanRoaster, coffeeName: beanName, ...times.query }), ...times.filters };
}

/**
 * A Shot as find_shots lists it, from the REST API's list: each Library item
 * it names by the Library's id and names where it is linked to it, or else
 * by the names it recorded, the names people type and its notes shortened
 * as given, and its credit's inference only where inferred.
 */
function shotRowOf(shot: ListedShot, shorten: (text: string | null, at: number) => string | null): z.infer<typeof shotRow> {
  const item = (libraryId: string | undefined, names: Record<string, string | null>) => {
    const shown = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, shorten(recordedText(name), ROW_NAME)]));
    return libraryId === undefined && Object.values(shown).every((name) => name === null) ? null : present({ id: libraryId ?? null, ...shown });
  };
  const batch = shot.beanBatch;
  return present({
    id: shot.id,
    pulledAt: shot.pulledAt && zonedTime(shot.pulledAt, shot.location?.timeZone),
    machine: shot.machine,
    ...(shot.machineInferred && { machineInferred: true as const }),
    location: shot.location && { id: shot.location.id, name: shot.location.name },
    ...(shot.locationInferred && { locationInferred: true as const }),
    recipe: shot.recipe && present({ id: shot.recipe.id, name: shorten(shot.recipe.name, ROW_NAME) }),
    profile: item(shot.profile?.id, { title: shot.profile ? shot.profile.title : shot.profileTitle }),
    beanBatch: item(batch?.id, batch ? { roaster: batch.bean.roaster, name: batch.bean.name, roastDate: dayOf(batch.roastDate) } : { roaster: shot.coffeeRoaster, name: shot.coffeeName }),
    grinder: item(shot.grinder?.id, { model: shot.grinder ? shot.grinder.model : shot.grinderModel }),
    grinderSetting: shot.grinderSetting,
    basket: item(shot.basket?.id, { name: shot.basket ? shot.basket.name : shot.basketName }),
    targetDose: shot.targetDose,
    actualDose: shot.actualDose,
    targetYield: shot.targetYield,
    actualYield: shot.actualYield,
    duration: shot.duration,
    timeToFirstDrip: shot.timeToFirstDrip,
    peakPressure: shot.peakPressure,
    peakFlow: shot.peakFlow,
    stopReason: shot.stopReason,
    lastStep: shot.lastStep && { frame: shot.lastStep.frame, name: shorten(shot.lastStep.name, ROW_NAME)! },
    enjoyment: shot.enjoyment,
    barista: shorten(recordedText(shot.barista), ROW_NAME),
    tds: shot.tds,
    extractionYield: shot.extractionYield,
    notes: shorten(shot.notes, ROW_NOTES),
  }) as z.infer<typeof shotRow>;
}

/** The fields of a row, or of an item it names, that have a value: all but those null, keeping an item's id, null where it isn't linked to the Library's. */
function present(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== null || key === "id"));
}

/** The day a date the Library holds as a day names, such as a roast date, which it stores as that day's midnight. */
function dayOf(date: string | null): string | null {
  return date === null ? null : (/^\d{4}-\d\d-\d\d/.exec(date)?.[0] ?? date);
}

/** A Shot as the REST API reads it, in the glossary's words, with its time on its Location's clock. */
function shotBasicsOf(shot: ShownShot): z.infer<typeof shotBasics> {
  return {
    id: shot.id,
    pulledAt: shot.pulledAt && zonedTime(shot.pulledAt, shot.location?.timeZone),
    machine: shot.machine,
    machineInferred: shot.machineInferred,
    location: shot.location,
    locationInferred: shot.locationInferred,
    recipe: shot.recipe,
    profile: shot.profile,
    profileTitle: shot.profileTitle,
    bean: { roaster: shot.coffeeRoaster, name: shot.coffeeName },
    beanBatch: shot.beanBatch,
    grinder: shot.grinder,
    basket: shot.basket,
    targetDose: shot.targetDose,
    actualDose: shot.actualDose,
    targetYield: shot.targetYield,
    actualYield: shot.actualYield,
    lastRecordedWeight: shot.lastRecordedWeight,
    duration: shot.duration,
    enjoyment: shot.enjoyment,
    barista: shot.barista,
    peakPressure: shot.peakPressure,
    peakFlow: shot.peakFlow,
  };
}

/** A Steam Record as the REST API lists it, with its time on its Location's clock. */
function steamSummaryOf(steamRecord: ShownSteamRecord | Awaited<ReturnType<SteamRecordsService["list"]>>["steamRecords"][number]): z.infer<typeof steamSummary> {
  return {
    id: steamRecord.id,
    steamedAt: zonedTime(steamRecord.steamedAt, steamRecord.location?.timeZone),
    machine: steamRecord.machine,
    location: steamRecord.location,
    duration: steamRecord.duration,
    peakMilkTemperature: steamRecord.peakMilkTemperature,
    finalMilkTemperature: steamRecord.finalMilkTemperature,
    barista: steamRecord.barista,
    steamSettings: steamRecord.steamSettings,
  };
}
