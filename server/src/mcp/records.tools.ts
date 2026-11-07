import { BadRequestException, Injectable } from "@nestjs/common";
import { Tool } from "@nestjs/mcp";
import { SHOT_CURVES, STEAM_CURVES, shotSamples, steamSamples, steamStopAt } from "@decent-sync/protocol";
import * as z from "zod";
import { READ } from "../connected-apps/oauth.js";
import { readRecordFilters } from "../record-filters.js";
import { number, object, string } from "../shots/extraction.js";
import { readShotFilters } from "../shots/filters.js";
import { ShotsService } from "../shots/shots.service.js";
import { SteamRecordsService } from "../steam-records/steam-records.service.js";
import { curveSchema, curvesOf, shadedSchema } from "./curves.js";
import { timeBound, timeRange, zonedTime } from "./times.js";

// Shots and Steam Records, found and read through an assistant as the REST
// API lists and reads them, calling the same services (#408, ADR-0026).
// Every account reads every one, as through the REST API.

/** At most this many records a page, as #405 sets for every list through the endpoint. */
const MAX_PAGE = 50;

const page = {
  limit: z.number().int().min(1).max(MAX_PAGE).default(20).describe(`How many to list, from 1 to ${MAX_PAGE}.`),
  offset: z.number().int().min(0).max(1 << 30).default(0).describe("How many to skip, newest first: the previous page's offset plus its length."),
};
const pageOutput = {
  total: z.number().int().describe("How many match."),
  offset: z.number().int(),
  more: z.boolean().describe("Whether more match after this page."),
};

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
  duration: seconds("How long its profile ran, leaving out its Preheat"),
  enjoyment: z.number().nullable().describe("As rated on the tablet."),
  barista: z.string().nullable(),
  peakPressure: z.number().nullable().describe("In bar, leaving out its Preheat."),
  peakFlow: z.number().nullable().describe("In ml/s, leaving out its Preheat."),
});

const shotDetails = shotSummary.extend({
  grinderSetting: z.string().nullable().describe("Its Grinder's setting, as its Workflow recorded it."),
  grinderBurrs: z.string().nullable().describe("The burrs its Grinder had fitted."),
  tds: z.number().nullable().describe("Total dissolved solids, in %."),
  extractionYield: z.number().nullable().describe("In %."),
  notes: z.string().nullable().describe("As typed on the tablet."),
  stopReason: z.string().nullable().describe("What stopped it, as Decaid recorded it."),
  previousShot: z
    .object({ id, pulledAt: z.string() })
    .nullable()
    .describe("The Shot pulled just before it on the same Machine, its time with this Shot's Location's offset."),
  curves: z
    .object({
      shaded: shadedSchema("Its Preheat, the Machine heating its water before the profile starts, as the management interface shades it: before 0 s, with the heater test's targets, left out of its duration and peaks."),
      pressure: curveSchema("Pressure."),
      flow: curveSchema("Flow."),
      weight: curveSchema("The scale's weight."),
      temperature: curveSchema("The group temperature, measured at the group head, the closest to the coffee."),
    })
    .optional()
    .describe("Only when asked for. Seconds from the start of its profile, after its Preheat."),
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
      milkTemperature: curveSchema("The milk temperature its probe reported; its target is the temperature its Workflow stops at."),
      steamTemperature: curveSchema("The steam heater's temperature."),
      pressure: curveSchema("The steam's pressure."),
      flow: curveSchema("The steam's flow."),
    })
    .optional()
    .describe("Only when asked for. Seconds from when it started steaming."),
});

const curvesInput = z.boolean().default(false).describe("Whether to include its curves, each cut to about 100 points.");
const timeZoneNote = "Times are ISO 8601, with the offset of the record's Location's time zone, or UTC's when its Location is unknown.";

const findShotsInput = z.object({
  locationId: id.optional().describe("Shots pulled at this Location."),
  machineId: id.optional().describe("Shots credited to this Machine."),
  beanId: id.optional().describe("Shots that used any Bean Batch of this Library Bean."),
  beanBatchId: id.optional().describe("Shots that used this Library Bean Batch."),
  profileId: id.optional().describe("Shots pulled with this Library Profile."),
  grinderId: id.optional().describe("Shots that used this Library Grinder."),
  basketId: id.optional().describe("Shots that used this Library Basket."),
  recipeId: id.optional().describe("Shots pulled with this Recipe loaded."),
  barista: z.string().optional().describe("Shots by this Barista, named exactly as each Shot records it."),
  beanRoaster: z.string().optional().describe("Shots whose Bean's roaster is this, exactly as each Shot records it, linked to the Library or not."),
  beanName: z.string().optional().describe("Shots whose Bean's name is this, exactly as each Shot records it, linked to the Library or not."),
  profileTitle: z.string().optional().describe("Shots whose profile's title is this, exactly as each Shot records it."),
  from: timeBound("Shots pulled from this time on."),
  to: timeBound("Shots pulled up to this time, through the end of a day given as a date."),
  ...page,
});
const findShotsOutput = z.object({ shots: z.array(shotSummary), ...pageOutput });

const findSteamRecordsInput = z.object({
  locationId: id.optional().describe("Steam Records at this Location."),
  machineId: id.optional().describe("Steam Records credited to this Machine."),
  from: timeBound("Steam Records from this time on."),
  to: timeBound("Steam Records up to this time, through the end of a day given as a date."),
  ...page,
});
const findSteamRecordsOutput = z.object({ steamRecords: z.array(steamSummary), ...pageOutput });

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

  @Tool({
    name: "find_shots",
    title: "Find Shots",
    description: `Finds Shots, newest first, a page at a time, by Location, Machine, Library item, the Bean, profile and Barista each recorded, and time. ${timeZoneNote}`,
    inputSchema: findShotsInput,
    outputSchema: findShotsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async findShots(input: z.infer<typeof findShotsInput>): Promise<z.infer<typeof findShotsOutput>> {
    const { from, to, limit, offset, beanRoaster, beanName, ...named } = input;
    const times = timeRange(from, to);
    const filters = { ...readShotFilters({ ...named, coffeeRoaster: beanRoaster, coffeeName: beanName, ...times.query }), ...times.filters };
    const found = await this.shots.list(limit, offset, filters);
    return { shots: found.shots.map(shotSummaryOf), total: found.total, offset, more: offset + found.shots.length < found.total };
  }

  @Tool({
    name: "get_shot",
    title: "Get a Shot",
    description: `Reads a Shot: what it used, how it turned out, and its curves when asked for, with its Preheat marked. ${timeZoneNote}`,
    inputSchema: z.object({ id: id.describe("The Shot's id."), curves: curvesInput }),
    outputSchema: shotDetails,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async getShot({ id, curves }: { id: string; curves: boolean }): Promise<z.infer<typeof shotDetails>> {
    const shot = await this.shots.get(id);
    const record = object(shot.record);
    const context = object(object(record.workflow).context);
    const annotations = object(record.annotations);
    const timeZone = shot.location?.timeZone;
    return {
      ...shotSummaryOf(shot),
      grinderSetting: text(context.grinderSetting),
      grinderBurrs: shot.grinderBurrs,
      tds: number(annotations.drinkTds),
      extractionYield: number(annotations.drinkEy),
      notes: text(annotations.espressoNotes),
      stopReason: text(record.stopReason),
      previousShot: shot.previousShot && { id: shot.previousShot.id, pulledAt: zonedTime(shot.previousShot.pulledAt, timeZone) },
      ...(curves && {
        curves: curvesOf(shotSamples(await this.shots.measurements(id), object(record.workflow).profile), SHOT_CURVES, { pressure: shot.peakPressure, flow: shot.peakFlow }),
      }),
    };
  }

  @Tool({
    name: "find_steam_records",
    title: "Find Steam Records",
    description: `Finds Steam Records, newest first, a page at a time, by Location, Machine and time. ${timeZoneNote}`,
    inputSchema: findSteamRecordsInput,
    outputSchema: findSteamRecordsOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async findSteamRecords(input: z.infer<typeof findSteamRecordsInput>): Promise<z.infer<typeof findSteamRecordsOutput>> {
    const { from, to, limit, offset, ...named } = input;
    const times = timeRange(from, to);
    const problems: string[] = [];
    const filters = { ...readRecordFilters({ ...named, ...times.query }, problems), ...times.filters };
    if (problems.length > 0) throw new BadRequestException(problems);
    const found = await this.steamRecords.list(limit, offset, filters);
    return { steamRecords: found.steamRecords.map(steamSummaryOf), total: found.total, offset, more: offset + found.steamRecords.length < found.total };
  }

  @Tool({
    name: "get_steam_record",
    title: "Get a Steam Record",
    description: `Reads a Steam Record: its milk temperatures, steam settings, and its curves when asked for, with the steam starting up, its pauses, puffs and purge marked. ${timeZoneNote}`,
    inputSchema: z.object({ id: id.describe("The Steam Record's id."), curves: curvesInput }),
    outputSchema: steamDetails,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async getSteamRecord({ id, curves }: { id: string; curves: boolean }): Promise<z.infer<typeof steamDetails>> {
    const steamRecord = await this.steamRecords.get(id);
    const settings = object(object(object(steamRecord.record).workflow).steamSettings);
    return {
      ...steamSummaryOf(steamRecord),
      steamSettings: {
        steamTemperature: number(settings.targetTemperature),
        duration: number(settings.duration),
        flow: number(settings.flow),
        stopAtMilkTemperature: steamStopAt(steamRecord.record),
      },
      ...(curves && {
        curves: curvesOf(steamSamples(await this.steamRecords.measurements(id), steamStopAt(steamRecord.record)), STEAM_CURVES, {
          milkTemperature: steamRecord.peakMilkTemperature,
        }),
      }),
    };
  }
}

/** A Shot as the REST API lists it, in the glossary's words, with its time on its Location's clock. */
function shotSummaryOf(shot: ListedShot | ShownShot): z.infer<typeof shotSummary> {
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

/** Text Decaid recorded, or a number as its text, as the management interface shows it; null for none or blank. */
function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const recorded = string(value);
  return recorded !== null && recorded.trim() !== "" ? recorded : null;
}
