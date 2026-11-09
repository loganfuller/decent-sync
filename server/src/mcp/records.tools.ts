import { BadRequestException, Injectable } from "@nestjs/common";
import { SHOT_CURVES, STEAM_CURVES, steamSamples, steamStopAt } from "@decent-sync/protocol";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { readRecordFilters } from "../record-filters.js";
import { number, object, recordedText } from "../shots/extraction.js";
import { readShotFilters } from "../shots/filters.js";
import { ShotsService } from "../shots/shots.service.js";
import { SteamRecordsService } from "../steam-records/steam-records.service.js";
import { type Budget, BudgetedTool, CUT_MARK, MIN_CUT, cut, cutNoteOf, refuseCutText } from "./budget.js";
import { askedCurves, curveSchema, curvesInput, hundredths, shadedSchema, thinnedToSchema, withCurves } from "./curves.js";
import { PAGED, page, pageOf, pageOutput } from "./paging.js";
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

const shotSummary = z.object({
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

const shotDetails = shotSummary.extend({
  grinderModel: z.string().nullable().describe("Its Grinder's model, as the Shot recorded it, linked to the Library or not."),
  basketName: z.string().nullable().describe("Its Basket's name, as the Shot recorded it, linked to the Library or not."),
  grinderSetting: z.string().nullable().describe("Its Grinder's setting, as its Workflow recorded it."),
  grinderBurrs: z.string().nullable().describe("The burrs its Grinder had fitted."),
  tds: z.number().nullable().describe("Total dissolved solids, in %."),
  extractionYield: z.number().nullable().describe("In %."),
  notes: z.string().nullable().describe("As typed on the tablet."),
  stopReason: z.string().nullable().describe("What stopped it, as Decaid recorded it."),
  lastStep: step.nullable().describe("The step of its Profile it ended in; null when it stopped in its Preheat, or its samples name no step."),
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
  peakPressure: amount("In bar, leaving out its Preheat."),
  peakFlow: amount("In ml/s, leaving out its Preheat."),
  stopReason: text.describe("What stopped it, as Decaid recorded it."),
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
});

const steamDetails = steamSummary.extend({
  steamSettings: z
    .object({
      steamTemperature: celsius("Its target temperature"),
      duration: seconds("How long it steams before stopping by itself"),
      flow: z.number().nullable().describe("In ml/s."),
      stopAtMilkTemperature: celsius("The milk temperature it stops at; null when off"),
    })
    .describe("What its Workflow set when it started."),
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

const shotCurves = curvesInput(SHOT_CURVES);
const curveWindow = z
  .object({
    from: z.number().optional().describe("In seconds on its curves' axis; from its first sample when left out."),
    until: z.number().optional().describe("In seconds on its curves' axis; until its last sample when left out."),
  })
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

/** What get_shot's steps, lastStep and lastRecordedWeight are. */
const SHOT_STEPS =
  "steps are the steps of its Profile it ran, in order, each with its frame, its index among the Profile's steps from 0, its name, Step N, from 1, where the Profile names none, and from and until, where the next starts or the Shot ends; a step that ended between two samples is left out. lastStep is the one it ended in, null when it stopped in its Preheat or its samples name no step; get_library_item gives a linked Profile's steps, to see which it never reached. lastRecordedWeight is the scale's last weight sample after its Preheat, in grams, at its seconds, null without one. Decaid records no sample after the stop, so it is just before the stop, not at it. actualYield, which Decaid keeps weighing after the stop until the flow settles, minus it is roughly what arrived after the stop; that difference is wrong if the yield was edited on the tablet, which the server can't tell.";

/** What a Steam Record's numbers mean. */
const STEAM_UNITS =
  "duration is in seconds, counting only the steaming, not the steam starting up, its pauses, puffs or purge. Milk temperatures are in °C, peakMilkTemperature leaving out a reading carried over from the Steam Record before.";

/** What a record's curves mean. */
const CURVES_NOTE =
  "curves is true for all of them, or a list of those to give. Each gives its unit, its readings as [seconds, value] points, and its targets, the targets the Machine reported, which the management interface draws dashed, empty where it reported none. A series of more than 100 readings is thinned to 100, keeping its shape and peaks; thinnedTo gives the most points one was thinned to, null where every reading is given.";

const findShotsInput = z.object({
  locationId: id.optional().describe("Shots pulled at this Location."),
  machineId: id.optional().describe("Shots credited to this Machine."),
  beanId: id.optional().describe("Shots that used any Bean Batch of this Library Bean."),
  beanBatchId: id.optional().describe("Shots that used this Library Bean Batch."),
  profileId: id.optional().describe("Shots pulled with this Library Profile."),
  grinderId: id.optional().describe("Shots that used this Library Grinder."),
  basketId: id.optional().describe("Shots that used this Library Basket."),
  recipeId: id.optional().describe("Shots pulled with this Recipe loaded."),
  barista: z.string().optional().describe("Shots by this Barista, named exactly as each Shot records it. An empty one finds Shots that recorded none."),
  beanRoaster: z.string().max(500).optional().describe("Shots whose Bean's roaster is this, exactly as each Shot records it, linked to the Library or not. An empty one finds Shots that recorded none."),
  beanName: z.string().max(500).optional().describe("Shots whose Bean's name is this, exactly as each Shot records it, linked to the Library or not. An empty one finds Shots that recorded none."),
  profileTitle: z.string().optional().describe("Shots whose profile's title is this, exactly as each Shot records it. An empty one finds Shots that recorded none."),
  from: timeBound("Shots pulled from this time on."),
  to: timeBound("Shots pulled up to this time, through the end of a day given as a date."),
  ...page,
});
const findShotsOutput = z.object({ ...pageOutput, shots: z.array(shotRow) });
const findShotsBudget: Budget = { rest: "get_shot reads one Shot whole, with more of it." };

/** What a find_shots row's fields mean, for its description. */
const SHOT_ROW = `Each Shot gives its machine and location; its recipe, profile, beanBatch (its Bean's roaster and name, and its roast date), grinder and basket, each with the Library's id and name, or, where the Shot isn't linked to the Library's, a null id and the name it recorded, a recipe being only the Library's; and grinderSetting, as its Workflow recorded it. A field with no value, such as notes where none were typed, is left out, but an item's id, given null where it isn't linked. Doses and yields are in grams, targets as set and actuals as weighed. duration is in seconds, peakPressure in bar and peakFlow in ml/s, each leaving out the Preheat, the Machine heating its water before the profile starts. enjoyment is as rated on the tablet; tds (total dissolved solids) and extractionYield are in %. Amounts are to two decimal places, and roastDate a day. machineInferred, given only when true: it recorded no machine hardware, so it is credited to the Machine whose tablet reported it; locationInferred, only when true: its Location comes from that Machine's Location History. Names over about ${ROW_NAME} characters and notes over about ${ROW_NOTES} end in ${CUT_MARK}, and get_shot reads them whole.`;

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
    description: `Finds Shots, newest first, a page at a time, by Location, Machine, Library item, the Bean, profile and Barista each recorded, and time, each with how it went. ${SHOT_ROW} ${STOP_REASONS} Each filter's id is one these Shots give, or one get_shot or find_library_items gives, such as a Bean's. A linked item's name is the Library's, which may differ from what the Shot recorded and the beanRoaster, beanName and profileTitle filters match, so find a linked item's Shots by its id. ${PAGED} ${timeZoneNote}`,
    inputSchema: findShotsInput,
    outputSchema: findShotsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: findShotsBudget,
  })
  async findShots(input: z.infer<typeof findShotsInput>): Promise<z.infer<typeof findShotsOutput> & { cut?: string }> {
    // A name a row cut matches no Shot, as the filters match whole names.
    refuseCutText(input, "get_shot reads a Shot's names whole, and a linked item's Shots are found by its id");
    const { from, to, limit, offset, beanRoaster, beanName, ...named } = input;
    const times = timeRange(from, to);
    const filters = { ...readShotFilters({ ...named, coffeeRoaster: beanRoaster, coffeeName: beanName, ...times.query }), ...times.filters };
    const found = await this.shots.list(limit, offset, filters);
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
    name: "get_shot",
    title: "Get a Shot",
    description: `Reads a Shot: what it used, how it turned out, the steps of its Profile it ran, its last recorded weight, and its curves when asked for, with its Preheat marked. ${SHOT_UNITS} grinderModel and basketName are its Grinder's model and Basket's name as it recorded them, as bean is its Bean's. grinderSetting is as its Workflow recorded it. tds (total dissolved solids) and extractionYield are in %. ${STOP_REASONS} ${SHOT_STEPS} Its steps, lastRecordedWeight and curves are timed in seconds from the start of its profile, after its Preheat, which shaded marks before 0 s, with the heater test's targets, left out of its duration and peaks. Its curves give pressure in bar, flow in ml/s, the pump's, weight in grams as the scale weighed it, weightFlow in g/s, the rate coffee lands in the cup as the scale measured it, and temperature in °C, the group temperature, measured at the group head, the closest to the coffee. ${CURVES_NOTE} window, from and until in seconds on the curves' axis, each included and defaulting to the first or last sample, gives only the readings in it, none for a window outside the Shot: every one if the response fits, otherwise each series thinned to as many as fit, as thinnedTo says. With curves false or left out, it gives all of them. Ask for a few seconds, such as those around the stop, to see every reading there. ${timeZoneNote}`,
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
      ...shotSummaryOf(shot),
      grinderModel: shot.grinderModel,
      basketName: shot.basketName,
      grinderSetting: shot.grinderSetting,
      grinderBurrs: shot.grinderBurrs,
      tds: shot.tds,
      extractionYield: shot.extractionYield,
      notes: shot.notes,
      stopReason: shot.stopReason,
      lastStep: shot.lastStep,
      steps: shot.steps.map(({ from, until, ...step }) => ({ ...step, from: hundredths(from), until: hundredths(until) })),
      previousShot: shot.previousShot && { id: shot.previousShot.id, pulledAt: zonedTime(shot.previousShot.pulledAt, timeZone) },
    };
    // A window alone asks for every curve within it.
    const asked = askedCurves(SHOT_CURVES, window && curves === false ? true : curves);
    return asked ? withCurves(details, samples, asked, { pressure: shot.peakPressure, flow: shot.peakFlow }, window) : details;
  }

  @BudgetedTool({
    name: "find_steam_records",
    title: "Find Steam Records",
    description: `Finds Steam Records, newest first, a page at a time, by Location, Machine and time. ${STEAM_UNITS} ${PAGED} ${timeZoneNote}`,
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
    description: `Reads a Steam Record: its milk temperatures, steam settings, and its curves when asked for, with the steam starting up, its pauses, puffs and purge marked. ${STEAM_UNITS} steamSettings are what its Workflow set as it started: steamTemperature in °C, duration in seconds, how long it steams before stopping by itself, flow in ml/s, and stopAtMilkTemperature in °C, the milk temperature it stops at, null when off. Its curves are timed in seconds from when it started steaming; shaded marks the time that isn't steaming, left out of its duration: Preparing, before 0 s, the steam starting up; Paused, the flow falling after a stop; Puffing, small puffs that keep the wand clear; Purge, clearing the wand after the last stop. milkTemperature is its probe's, in °C, its target the temperature its Workflow stops at; steamTemperature is the steam heater's, in °C; pressure is the steam's, in bar, and flow in ml/s. ${CURVES_NOTE} ${timeZoneNote}`,
    inputSchema: z.object({ id: id.describe("The Steam Record's id."), curves: steamCurves }),
    outputSchema: steamDetails,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { rest: "Asked for without curves, it has more of its text." },
  })
  async getSteamRecord({ id, curves }: { id: string; curves: z.infer<typeof steamCurves> }): Promise<z.infer<typeof steamDetails>> {
    const steamRecord = await this.steamRecords.get(id);
    const settings = object(object(object(steamRecord.record).workflow).steamSettings);
    const details = {
      ...steamSummaryOf(steamRecord),
      steamSettings: {
        steamTemperature: number(settings.targetTemperature),
        duration: number(settings.duration),
        flow: number(settings.flow),
        stopAtMilkTemperature: steamStopAt(steamRecord.record),
      },
    };
    const asked = askedCurves(STEAM_CURVES, curves);
    if (!asked) return details;
    const samples = steamSamples(await this.steamRecords.measurements(id), steamStopAt(steamRecord.record));
    return withCurves(details, samples, asked, { milkTemperature: steamRecord.peakMilkTemperature });
  }
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
  const hundredths = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;
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
    targetDose: hundredths(shot.targetDose),
    actualDose: hundredths(shot.actualDose),
    targetYield: hundredths(shot.targetYield),
    actualYield: hundredths(shot.actualYield),
    duration: hundredths(shot.duration),
    peakPressure: hundredths(shot.peakPressure),
    peakFlow: hundredths(shot.peakFlow),
    stopReason: shot.stopReason,
    enjoyment: shot.enjoyment,
    barista: shorten(recordedText(shot.barista), ROW_NAME),
    tds: hundredths(shot.tds),
    extractionYield: hundredths(shot.extractionYield),
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
function shotSummaryOf(shot: ShownShot): z.infer<typeof shotSummary> {
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
    lastRecordedWeight: shot.lastRecordedWeight && { weight: hundredths(shot.lastRecordedWeight.weight), seconds: hundredths(shot.lastRecordedWeight.seconds) },
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
  };
}
