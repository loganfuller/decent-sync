import { randomUUID } from "node:crypto";
import {
  SHOT_CURVES,
  STEAM_CURVES,
  flowAtStop,
  globalIdOf,
  lastRecordedWeight,
  shadedSpans,
  shotSamples,
  steamPhases,
  steamSamples,
  steamStopAt,
  stepSpans,
  timeToFirstDrip,
} from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, asTools, serveTestApp } from "./support/assistants.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { derivedShot, preheatShotFixture, shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, derivedProfile, helloWith } from "./support/simulated-tablet.js";
import { derivedSteam, liveSteamFixture, milkProbeSteamFixture } from "./support/steam-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Reading Shots and Steam Records through an assistant (#408; #405, ADR-0026)
// at Seam 1: a test app on the MCP SDK's client, connected as a Connected
// App, finds and reads them, and each result is checked against the REST
// API's for the same thing. Records are derived from real ones Decaid
// recorded, changing only their ids, times, recorded hardware, Barista and
// what a test names, and are sent as raw frames by each Machine's
// connection, but for one Shot a simulated tablet pulls, linked to the
// Library. Baristas and hardware ids are made up.

type Fields = Record<string, unknown>;

/** A Shot as the REST API lists or shows it, as far as the tools read it. */
interface RestShot {
  id: string;
  pulledAt: string | null;
  machine: { id: string; name: string } | null;
  machineInferred: boolean;
  location: LocationView | null;
  locationInferred: boolean;
  recipe: { id: string; name: string | null } | null;
  profile: { id: string; title: string | null } | null;
  profileTitle: string | null;
  coffeeRoaster: string | null;
  coffeeName: string | null;
  beanBatch: { id: string; bean: { id: string; roaster: string | null; name: string | null }; roastDate: string | null } | null;
  grinder: { id: string; model: string | null } | null;
  grinderModel: string | null;
  grinderSetting: string | null;
  basket: { id: string; name: string | null } | null;
  basketName: string | null;
  grinderBurrs: string | null;
  targetDose: number | null;
  actualDose: number | null;
  targetYield: number | null;
  actualYield: number | null;
  duration: number | null;
  enjoyment: number | null;
  barista: string | null;
  peakPressure: number | null;
  peakFlow: number | null;
  stopReason: string | null;
  tds: number | null;
  extractionYield: number | null;
  notes: string | null;
  /** As stored with the Shot, and in a Shot read on its own, the step from its samples. */
  timeToFirstDrip: number | null;
  lastStep: { frame: number; name: string } | null;
  record?: Fields;
  previousShot?: { id: string; pulledAt: string } | null;
  /** Only in a Shot read on its own. */
  steps?: { frame: number; name: string; from: number; until: number }[];
  lastRecordedWeight?: { weight: number; seconds: number } | null;
  flowAtStop?: number | null;
}

/** A Steam Record as the REST API lists or shows it. */
interface RestSteamRecord {
  id: string;
  steamedAt: string;
  machine: { id: string; name: string } | null;
  location: LocationView | null;
  duration: number | null;
  peakMilkTemperature: number | null;
  finalMilkTemperature: number | null;
  barista: string | null;
  steamSettings: { steamTemperature: number | null; duration: number | null; flow: number | null; stopAtMilkTemperature: number | null };
  record?: Fields;
}

type Point = [number, number];
interface Curve {
  unit: string;
  values: Point[];
  targets: Point[];
}
interface Shaded {
  phase: string;
  from: number;
  until: number;
}

interface ToolShot {
  id: string;
  pulledAt: string | null;
  [field: string]: unknown;
}
interface ToolSteamRecord {
  id: string;
  steamedAt: string;
  [field: string]: unknown;
}
interface Page {
  total: number;
  offset: number;
  more: boolean;
}

/** What a tool's summary of a Shot holds, from the REST API's, but for its time, which `sameTimes` compares, its numbers to hundredths. */
function shotSummary(shot: RestShot): Fields {
  return asTools({
    id: shot.id,
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
  });
}

/** A Shot's steps as a tool gives them, from the REST API's, their seconds to hundredths. */
function toolSteps(steps: NonNullable<RestShot["steps"]>): Fields[] {
  return steps.map((step) => ({ ...step, from: hundredths(step.from), until: hundredths(step.until) }));
}

/**
 * What find_shots gives of a Shot, from the fields the REST API lists, but for its time, which `sameTimes` compares:
 * each Library item by the Library's id and name, or else by a null id and the name the Shot recorded, and its
 * credit's inference only where inferred, its amounts to two decimal places and its roast date as a day, each field
 * with no value left out, but an item's id. These tests' names and notes are short enough to be given whole.
 */
function shotRow(shot: RestShot): Fields {
  const recorded = (text: string | null) => (text?.trim() ? text : null);
  const hundredths = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  const present = (fields: Fields) => Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== null || key === "id"));
  const item = (id: string | undefined, names: Fields) => (id === undefined && Object.values(names).every((name) => name === null) ? null : present({ id: id ?? null, ...names }));
  const batch = shot.beanBatch;
  return present({
    id: shot.id,
    machine: shot.machine,
    ...(shot.machineInferred && { machineInferred: true }),
    location: shot.location && { id: shot.location.id, name: shot.location.name },
    ...(shot.locationInferred && { locationInferred: true }),
    recipe: shot.recipe && present(shot.recipe),
    profile: item(shot.profile?.id, { title: recorded(shot.profile ? shot.profile.title : shot.profileTitle) }),
    beanBatch: item(
      batch?.id,
      batch ? { roaster: recorded(batch.bean.roaster), name: recorded(batch.bean.name), roastDate: batch.roastDate?.slice(0, 10) ?? null } : { roaster: recorded(shot.coffeeRoaster), name: recorded(shot.coffeeName) },
    ),
    grinder: item(shot.grinder?.id, { model: recorded(shot.grinder ? shot.grinder.model : shot.grinderModel) }),
    grinderSetting: shot.grinderSetting,
    basket: item(shot.basket?.id, { name: recorded(shot.basket ? shot.basket.name : shot.basketName) }),
    targetDose: hundredths(shot.targetDose),
    actualDose: hundredths(shot.actualDose),
    targetYield: hundredths(shot.targetYield),
    actualYield: hundredths(shot.actualYield),
    duration: hundredths(shot.duration),
    timeToFirstDrip: hundredths(shot.timeToFirstDrip),
    peakPressure: hundredths(shot.peakPressure),
    peakFlow: hundredths(shot.peakFlow),
    stopReason: shot.stopReason,
    lastStep: shot.lastStep,
    enjoyment: shot.enjoyment,
    barista: recorded(shot.barista),
    tds: hundredths(shot.tds),
    extractionYield: hundredths(shot.extractionYield),
    notes: shot.notes,
  });
}

/** What a tool's summary of a Steam Record holds, from the REST API's, but for its time, which `sameTimes` compares, its numbers to hundredths. */
function steamSummary(steamRecord: RestSteamRecord): Fields {
  return asTools({
    id: steamRecord.id,
    machine: steamRecord.machine,
    location: steamRecord.location,
    duration: steamRecord.duration,
    peakMilkTemperature: steamRecord.peakMilkTemperature,
    finalMilkTemperature: steamRecord.finalMilkTemperature,
    barista: steamRecord.barista,
    steamSettings: steamRecord.steamSettings,
  });
}

const OFFSET = /(?:Z|[+-]\d\d:\d\d)$/;

/** Each tool time is the REST API's moment, as ISO 8601 with an offset. */
function sameTimes(tool: (string | null)[], rest: (string | null)[]): void {
  expect(tool.map((time) => time !== null && OFFSET.test(time))).toEqual(rest.map((time) => time !== null));
  expect(tool.map((time) => time && Date.parse(time))).toEqual(rest.map((time) => time && Date.parse(time)));
}

/** A value as the tool rounds it, and JSON then sends it, -0 as 0. */
const hundredths = (value: number) => Math.round(value * 100) / 100 || 0;

const peak = (readings: number[]) => hundredths(Math.max(...readings));

describe("reading Shots and Steam Records through an assistant", () => {
  let server: TestServer;
  let api: AdminApi;
  let adminCookie: string;
  let app: TestApp;
  let assistant: Assistant;
  let uptown: LocationView;
  let harbor: LocationView;
  let uptown1: CreatedMachine;
  let harbor1: CreatedMachine;
  let roaming: CreatedMachine;
  const raws: RawConnection[] = [];

  const hardware = {
    uptown1: { model: "DE1Pro", serial: "40801" },
    harbor1: { model: "DE1XL", serial: "40802" },
    roaming: { model: "DE1Pro", serial: "40804" },
  };

  beforeAll(async () => {
    server = await startTestServer({ env: { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    adminCookie = await signIn(server.url, admin);
    app = await serveTestApp();
    // Chicago is 6 hours behind UTC in February, and Tokyo 9 ahead.
    uptown = await api.createLocation("Uptown", "America/Chicago");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
    uptown1 = await api.createMachine("Uptown 1");
    harbor1 = await api.createMachine("Harbor 1");
    // Never at a Location.
    roaming = await api.createMachine("Roaming");
    for (const [machine, location] of [[uptown1, uptown], [harbor1, harbor]] as const) {
      const moved = await api.call("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" });
      expect(moved.status).toBe(201);
    }

    await deliverShots(uptown1, hardware.uptown1, [
      // 06:00 on the 10th in Chicago.
      shotAt("uptown-dawn", "2026-02-10T12:00:00Z", hardware.uptown1, "Ann"),
      // 23:30 on the 10th in Chicago, the 11th in UTC.
      shotAt("uptown-night", "2026-02-11T05:30:00Z", hardware.uptown1, "Ben"),
      // 21:00 on the 9th in Chicago, the 10th in UTC.
      shotAt("uptown-before", "2026-02-10T03:00:00Z", hardware.uptown1, "Ann", { roaster: "Other Roaster" }),
    ]);
    await deliverShots(harbor1, hardware.harbor1, [
      // 01:00 on the 10th in Tokyo, the 9th in UTC.
      shotAt("harbor-early", "2026-02-09T16:00:00Z", hardware.harbor1, "Ann"),
      // Noon on the 10th in Tokyo.
      shotAt("harbor-noon", "2026-02-10T03:00:00Z", hardware.harbor1, "Cat", { bean: "Kenya Nyeri" }),
      // 01:00 on the 11th in Tokyo, the 10th in UTC.
      shotAt("harbor-next", "2026-02-10T16:00:00Z", hardware.harbor1, "Cat", { bean: "Kenya Nyeri", profile: "Blooming" }),
    ]);
    // 19:00 on the 5th in Chicago, but at no Location: the 6th in UTC.
    await deliverShots(roaming, hardware.roaming, [shotAt("roaming-late", "2026-03-06T01:00:00Z", hardware.roaming, "Dee")]);
    await deliverSteams(uptown1, hardware.uptown1, { "steam-uptown-dawn": "2026-02-10T12:00:00Z", "steam-uptown-night": "2026-02-11T05:30:00Z", "steam-uptown-before": "2026-02-10T03:00:00Z" });
    await deliverSteams(harbor1, hardware.harbor1, { "steam-harbor-early": "2026-02-09T16:00:00Z", "steam-harbor-next": "2026-02-10T16:00:00Z" });
    await deliverSteams(roaming, hardware.roaming, { "steam-roaming-late": "2026-03-06T01:00:00Z" });

    assistant = await Assistant.connect(server.url, app, adminCookie, { allowed: ["read"] });
  });
  afterAll(async () => {
    await assistant?.close();
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await app?.close();
    await server?.stop();
  });

  /** A Shot pulled at a UTC time on the hardware given, by the Barista given, recording the Bean's roaster and name and profile's title given, or the fixture's. */
  function shotAt(
    id: string,
    pulledAt: string,
    recorded: { model: string; serial: string },
    barista: string,
    { roaster, bean, profile }: { roaster?: string; bean?: string; profile?: string } = {},
  ): Fields {
    const { machine, context, profile: recordedProfile, ...workflow } = shotFixture().workflow as Record<string, Fields>;
    return derivedShot(id, {
      timestamp: pulledAt,
      workflow: {
        ...workflow,
        context: { ...context, baristaName: barista, ...(roaster && { coffeeRoaster: roaster }), ...(bean && { coffeeName: bean }) },
        profile: { ...recordedProfile, ...(profile && { title: profile }) },
        machine: { ...machine, model: recorded.model, serialNumber: recorded.serial },
      },
    });
  }

  /** Sends the Shots through a connection with the Machine's token reporting its hardware, and waits for each to be stored. */
  async function deliverShots(machine: CreatedMachine, reported: { model: string; serial: string }, shots: Fields[]) {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: reported }));
    raws.push(raw);
    await Promise.all(shots.map((shot) => raw.deliver({ type: "shot", id: randomUUID(), shotId: shot.id, shot })));
  }

  /** Sends Steam Records, by id with the UTC time each was recorded at, as `deliverShots` sends Shots; derived from the fixture given. */
  async function deliverSteams(machine: CreatedMachine, reported: { model: string; serial: string }, steamedAt: Record<string, string>, fixture?: Fields) {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: reported }));
    raws.push(raw);
    await Promise.all(
      Object.entries(steamedAt).map(([steamId, at]) =>
        raw.deliver({ type: "steam", id: randomUUID(), steamId, steamedAt: new Date(at).toISOString(), steam: derivedSteam(steamId, {}, fixture) }),
      ),
    );
  }

  /**
   * Derived: the real Steam Record stopped on time, with milk temperatures from a probe, as a Bengle records them: its
   * first three readings carried over from the Steam Record before, at 65 °C, then rising from 5 °C to 60 °C while it
   * steams, and 60.3 °C after the stop but for 60.4 °C at the second sample after it, as the probe catches up. Its peak
   * is that 60.4 °C, which leaves out the readings carried over, and which a cut that keeps only the curve's highest
   * reading and its highest while steaming loses.
   */
  function milkAfterStop(): Fields {
    const fixture = liveSteamFixture("steam-record-timed-stop");
    const measurements = fixture.measurements as Fields[];
    const phases = steamPhases(measurements);
    const [first, last] = [phases.indexOf("steaming"), phases.lastIndexOf("steaming")];
    const milk = (n: number) =>
      n < 3 ? 65 : n <= last ? Math.round((5 + (55 * Math.max(0, n - first)) / (last - first)) * 100) / 100 : n === last + 2 ? 60.4 : 60.3;
    return { ...fixture, measurements: measurements.map((sample, n) => ({ ...sample, milkTemperature: milk(n) })) };
  }

  async function restShots(query: Record<string, string>, at = api): Promise<{ shots: RestShot[]; total: number }> {
    return at.get(`/shots?${new URLSearchParams(query)}`);
  }
  async function restSteamRecords(query: Record<string, string>): Promise<{ steamRecords: RestSteamRecord[]; total: number }> {
    return api.get(`/steam-records?${new URLSearchParams(query)}`);
  }

  /** find_shots, checked against the REST API's list for the same filters and page, matching words as find_shots does, returning the ids it found. */
  async function findShotsAsRest(input: Fields, query: Record<string, string>, by = assistant, at = api): Promise<string[]> {
    const found = await by.call<{ shots: ToolShot[] } & Page>("find_shots", input);
    const rest = await restShots({ match: "words", ...query }, at);
    expect(found.shots.map(({ pulledAt: _, ...row }) => row)).toEqual(rest.shots.map(shotRow));
    sameTimes(found.shots.map((shot) => shot.pulledAt), rest.shots.map((shot) => shot.pulledAt));
    expect(found.total).toBe(rest.total);
    return found.shots.map((shot) => shot.id);
  }

  /** A tool's error, which a call must answer with. */
  async function toolError(name: string, args: Fields): Promise<string> {
    const result = await assistant.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { type: string; text: string }[]).map((block) => block.text).join("\n");
  }

  it("finds Shots as the REST API lists them, newest first, with their times on each Location's clock", async () => {
    const uptownShots = await findShotsAsRest({ locationId: uptown.id }, { locationId: uptown.id });
    expect(uptownShots).toEqual(["uptown-night", "uptown-dawn", "uptown-before"]);
    const { shots } = await assistant.call<{ shots: ToolShot[] }>("find_shots", { machineId: harbor1.machine.id });
    expect(shots.map((shot) => [shot.id, shot.pulledAt])).toEqual([
      ["harbor-next", "2026-02-11T01:00:00.000+09:00"],
      ["harbor-noon", "2026-02-10T12:00:00.000+09:00"],
      ["harbor-early", "2026-02-10T01:00:00.000+09:00"],
    ]);
    expect((await assistant.call<{ shots: ToolShot[] }>("find_shots", { locationId: uptown.id, limit: 1 })).shots[0]!.pulledAt).toBe("2026-02-10T23:30:00.000-06:00");

    expect(await findShotsAsRest({ machineId: uptown1.machine.id, barista: "Ann" }, { machineId: uptown1.machine.id, barista: "Ann" })).toEqual(["uptown-dawn", "uptown-before"]);
    expect(await findShotsAsRest({ barista: "Cat" }, { barista: "Cat" })).toEqual(["harbor-next", "harbor-noon"]);
    // The Bean and profile each Shot recorded, as the Shots page filters them, linked to the Library or not.
    expect(await findShotsAsRest({ beanName: "Kenya Nyeri" }, { coffeeName: "Kenya Nyeri" })).toEqual(["harbor-next", "harbor-noon"]);
    const february = { from: "2026-02-09", to: "2026-02-11" };
    expect(await findShotsAsRest({ ...february, beanRoaster: "Roux Bakehouse", locationId: uptown.id }, { ...february, coffeeRoaster: "Roux Bakehouse", locationId: uptown.id })).toEqual([
      "uptown-night",
      "uptown-dawn",
    ]);
    expect(await findShotsAsRest({ beanRoaster: "Other Roaster" }, { coffeeRoaster: "Other Roaster" })).toEqual(["uptown-before"]);
    expect(await toolError("find_shots", { beanName: "x".repeat(501) })).toContain("beanName");
    expect(await findShotsAsRest({ profileTitle: "Blooming" }, { profileTitle: "Blooming" })).toEqual(["harbor-next"]);
    // A well-formed id names nothing, as through the REST API.
    const nothing = randomUUID();
    expect(await findShotsAsRest({ beanBatchId: nothing }, { beanBatchId: nothing })).toEqual([]);
  });

  it("counts a day given as a date per Location, in each one's own time zone, as the REST API does, and a time with its offset as that moment", async () => {
    const day = { from: "2026-02-10", to: "2026-02-10" };
    expect(new Set(await findShotsAsRest(day, day))).toEqual(new Set(["uptown-dawn", "uptown-night", "harbor-early", "harbor-noon"]));
    expect(await findShotsAsRest({ ...day, locationId: harbor.id }, { ...day, locationId: harbor.id })).toEqual(["harbor-noon", "harbor-early"]);
    const later = { from: "2026-02-11", to: "2026-02-28" };
    expect(await findShotsAsRest(later, later)).toEqual(["harbor-next"]);

    const ids = async (input: Fields) => (await assistant.call<{ shots: ToolShot[] }>("find_shots", input)).shots.map((shot) => shot.id);
    // From 06:00 in Chicago, which is noon in UTC, up to 16:00 in UTC, which leaves that moment out.
    expect(await ids({ from: "2026-02-10T06:00:00-06:00", to: "2026-02-10T16:00:00Z" })).toEqual(["uptown-dawn"]);
    expect(await ids({ from: "2026-02-10T16:00:00.000Z", to: "2026-02-28" })).toEqual(["uptown-night", "harbor-next"]);
    // From the start of the 10th at each Location, up to noon in UTC.
    expect(await ids({ from: "2026-02-10", to: "2026-02-10T12:00:00+00:00" })).toEqual(["harbor-noon", "harbor-early"]);

    expect(await toolError("find_shots", { from: "2026-02-10T12:00:00Z", to: "2026-02-10T12:00:00Z" })).toBe("Choose an end after the start");
    expect(await toolError("find_shots", { from: "2026-02-11", to: "2026-02-10" })).toBe("Choose an end after the start");
    // A time without its offset names no moment, and a day the calendar lacks none either.
    const unparsed = "Enter a date, such as 2026-11-06, or a time with its seconds and offset, such as 2026-11-06T14:30:00-05:00";
    for (const bound of [{ from: "2026-02-10T06:00:00" }, { from: "2026-02-10T06:00-06:00" }, { to: "2026-02-30" }]) expect(await toolError("find_shots", bound)).toContain(unparsed);
    // ISO 8601 allows a moment PostgreSQL can't read: an offset past 15:59, or year 0.
    const unread = "Enter from as a time from year 1 with an offset of at most 15:59, such as 2026-11-06T14:30:00-05:00, or as a date";
    for (const tool of ["find_shots", "find_steam_records"]) {
      expect(await toolError(tool, { from: "2026-11-06T14:30:00+16:00" })).toBe(unread);
      expect(await toolError(tool, { from: "0000-01-01T00:00:00Z" })).toBe(unread);
      expect(await toolError(tool, { to: "2026-11-06T14:30:00-23:00" })).toBe(unread.replace("from", "to"));
    }
    // From 20:01 on the 9th up to 04:59 on the 11th, in UTC; two Shots at one moment are ordered by id.
    expect(await ids({ from: "2026-02-10T12:00:00+15:59", to: "2026-02-10T13:00:00-15:59" })).toEqual(["harbor-next", "uptown-dawn", "harbor-noon", "uptown-before"]);
  });

  it("gives a record whose Location is unknown its time in UTC, and reads a date as a UTC day for it, as the REST API does", async () => {
    const { shots } = await assistant.call<{ shots: ToolShot[] }>("find_shots", { machineId: roaming.machine.id });
    expect(shots).toEqual([expect.objectContaining({ id: "roaming-late", pulledAt: "2026-03-06T01:00:00.000Z" })]);
    expect(shots[0]).not.toHaveProperty("location");
    expect(shots[0]).not.toHaveProperty("locationInferred");
    for (const day of ["2026-03-06", "2026-03-05"]) {
      const query = { machineId: roaming.machine.id, from: day, to: day };
      expect(await findShotsAsRest(query, query)).toEqual(day === "2026-03-06" ? ["roaming-late"] : []);
    }
    const { steamRecords } = await assistant.call<{ steamRecords: ToolSteamRecord[] }>("find_steam_records", { machineId: roaming.machine.id, from: "2026-03-06", to: "2026-03-06" });
    expect(steamRecords).toEqual([expect.objectContaining({ id: "steam-roaming-late", steamedAt: "2026-03-06T01:00:00.000Z", location: null })]);
  });

  it("pages as the REST API does, at most 50 a page, saying whether there are more", async () => {
    const range = { from: "2026-02-09", to: "2026-02-11" };
    const pages: string[][] = [];
    for (let offset = 0; ; offset += 4) {
      const page = await assistant.call<{ shots: ToolShot[] } & Page>("find_shots", { ...range, limit: 4, offset });
      const rest = await restShots({ ...range, limit: "4", offset: String(offset) });
      expect(page.shots.map((shot) => shot.id)).toEqual(rest.shots.map((shot) => shot.id));
      expect(page).toMatchObject({ total: 6, offset, more: offset + 4 < 6 });
      pages.push(page.shots.map((shot) => shot.id));
      if (!page.more) break;
    }
    expect(pages.map((page) => page.length)).toEqual([4, 2]);
    expect(await findShotsAsRest({ ...range, limit: 50 }, { ...range, limit: "50" })).toHaveLength(6);
    // 20 by default, as through the REST API.
    await findShotsAsRest({}, {});
    expect(await toolError("find_shots", { limit: 51 })).toContain("limit");
    expect(await toolError("find_shots", { limit: 0 })).toContain("limit");
  });

  it("refuses a malformed id with the REST API's message", async () => {
    // A Profile's id is Decaid's, any text but none.
    for (const [field, message, malformed = "not-an-id"] of [
      ["locationId", "No such Location"],
      ["machineId", "No such Machine"],
      ["beanId", "No such Bean"],
      ["beanBatchId", "No such Bean Batch"],
      ["profileId", "No such Profile", ""],
      ["grinderId", "No such Grinder"],
      ["basketId", "No such Basket"],
      ["recipeId", "No such Recipe"],
    ] as const) {
      const rest = await api.call("GET", `/shots?${new URLSearchParams({ [field]: malformed })}`);
      expect(rest.status, field).toBe(404);
      expect(((await rest.json()) as { message: string }).message).toBe(message);
      expect(await toolError("find_shots", { [field]: malformed })).toBe(message);
    }
    expect(await toolError("find_steam_records", { machineId: "not-an-id" })).toBe("No such Machine");
    expect(await toolError("get_shot", { id: "no-such-shot" })).toBe("Shot not found");
    expect(await toolError("get_steam_record", { id: "no-such-steam" })).toBe("Steam Record not found");
  });

  it("finds a Shot by the Library's Bean, Bean Batch, Grinder and Profile it is linked to, as the REST API does", async () => {
    const lab = await api.createLocation("Linked lab", "America/Denver");
    const machine = await api.createMachine("Linked lab 1", lab.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary("40803") });
    await api.waitForOnline(machine);
    const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Assistant Guji" } }, 201)).bean;
    const batch = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean.id, content: { roastDate: "2026-10-01" }, locations: [{ locationId: lab.id }] }, 201)).batch;
    const grinder = (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: lab.id, content: { model: "Assistant EK43" } }, 201)).grinder;
    const held = (records: Fields[], id: string) => records.find((record) => globalIdOf(record) === id);
    await expect.poll(() => held(tablet.batches(), batch.id)).toBeTruthy();
    await expect.poll(() => held(tablet.grinders(), grinder.id)).toBeTruthy();
    const profile = (await tablet.addProfile(derivedProfile("Assistant bloom", 7.5))).profile as Fields;
    const libraryProfile = async () => (await api.get<{ profiles: { id: string; title: string }[] }>("/profiles")).profiles.find((found) => found.title === "Assistant bloom")?.id;
    await expect.poll(libraryProfile).toBeTruthy();
    const profileId = (await libraryProfile())!;

    // The Shot names the batch and Grinder by the tablet's ids, and holds the Profile as Decaid does.
    const fixture = shotFixture();
    const workflow = fixture.workflow as Fields;
    tablet.pullShot({
      ...fixture,
      id: "assistant-linked",
      workflow: {
        ...workflow,
        profile,
        machine: { ...(workflow.machine as Fields), serialNumber: "40803" },
        context: { ...(workflow.context as Fields), beanBatchId: held(tablet.batches(), batch.id)!.id, grinderId: held(tablet.grinders(), grinder.id)!.id },
      },
    });
    await expect.poll(async () => (await api.call("GET", "/shots/assistant-linked")).status).toBe(200);

    for (const filter of [{ beanId: bean.id }, { beanBatchId: batch.id }, { grinderId: grinder.id }, { profileId }] as Record<string, string>[]) {
      expect(await findShotsAsRest(filter, filter)).toEqual(["assistant-linked"]);
    }
    const linked = await assistant.call<Fields>("get_shot", { id: "assistant-linked" });
    expect(linked).toMatchObject({
      beanBatch: { id: batch.id, bean: { id: bean.id, roaster: "Roux", name: "Assistant Guji" } },
      grinder: { id: grinder.id, model: "Assistant EK43" },
      profile: { id: profileId, title: "Assistant bloom" },
    });
    // Listed, each item it is linked to is named as the Library names it, not as the Shot recorded it, and the Basket
    // DYE2 recorded, which isn't in the Library, as the Shot recorded it.
    const { shots } = await assistant.call<{ shots: Fields[] }>("find_shots", { beanBatchId: batch.id });
    expect(shots).toEqual([
      expect.objectContaining({
        beanBatch: { id: batch.id, roaster: "Roux", name: "Assistant Guji", roastDate: "2026-10-01" },
        grinder: { id: grinder.id, model: "Assistant EK43" },
        profile: { id: profileId, title: "Assistant bloom" },
        basket: { id: null, name: "Decent 18g Ridgeless" },
      }),
    ]);
    // Its Workflow named no Recipe.
    expect(shots[0]).not.toHaveProperty("recipe");
  });

  it("lists each Shot compactly, with how it went, from the fields the REST API lists, naming nothing twice and leaving out what has no value", async () => {
    // Derived: a Shot the Machine ended after a few seconds, with no yield, as one on a Machine at Roux did on
    // 2026-11-08; one with a refractometer's readings and notes; and one that recorded no hardware, so it is credited
    // to Uptown 1, whose tablet reported it, and its Location by inference.
    const aborted = shotAt("assistant-aborted", "2026-04-01T13:00:00Z", hardware.uptown1, "Ann");
    const { actualYield: _, ...unweighed } = aborted.annotations as Fields;
    const measured = shotAt("assistant-measured", "2026-04-01T13:05:00Z", hardware.uptown1, "Ben");
    const inferred = shotAt("assistant-inferred", "2026-04-01T13:10:00Z", hardware.uptown1, "Cat");
    const { machine: _machine, ...unidentified } = inferred.workflow as Fields;
    await deliverShots(uptown1, hardware.uptown1, [
      { ...aborted, stopReason: "machineEnded", annotations: unweighed, measurements: (aborted.measurements as unknown[]).slice(0, 25) },
      { ...measured, annotations: { ...(measured.annotations as Fields), drinkTds: 9.4, drinkEy: 20.1, espressoNotes: "Sweet, a little sharp at the end" } },
      { ...inferred, workflow: unidentified },
    ]);
    const april = { from: "2026-04-01", to: "2026-04-01" };
    expect(await findShotsAsRest(april, april)).toEqual(["assistant-inferred", "assistant-measured", "assistant-aborted"]);
    const { shots } = await assistant.call<{ shots: Fields[] }>("find_shots", april);
    const [inferredRow, measuredRow, abortedRow] = shots as [Fields, Fields, Fields];
    expect(abortedRow).toMatchObject({ stopReason: "machineEnded", grinderSetting: "8" });
    // Unweighed, untasted and unmeasured, it gives no yield, notes or readings.
    for (const none of ["actualYield", "notes", "tds", "extractionYield", "enjoyment", "recipe"]) expect(abortedRow, none).not.toHaveProperty(none);
    expect(measuredRow).toMatchObject({
      machine: { id: uptown1.machine.id, name: "Uptown 1" },
      location: { id: uptown.id, name: "Uptown" },
      // Linked to none of the Library's items, each is named as the Shot recorded it, with a null id, and no roast date.
      beanBatch: { id: null, roaster: "Roux Bakehouse", name: "Ethiopia Generic 100g Sample" },
      grinder: { id: null, model: "DF64 v2" },
      basket: { id: null, name: "Decent 18g Ridgeless" },
      stopReason: "targetWeight",
      barista: "Ben",
      tds: 9.4,
      extractionYield: 20.1,
      notes: "Sweet, a little sharp at the end",
    });
    // Its time carries its Location's offset, so the Location gives no time zone; credit by inference is given only
    // where inferred; it was pulled with no Recipe loaded and rated with no enjoyment, so neither is given.
    expect(Object.keys(measuredRow)).toEqual([
      "id", "pulledAt", "machine", "location", "profile", "beanBatch", "grinder", "grinderSetting", "basket", "targetDose", "actualDose",
      "targetYield", "actualYield", "duration", "timeToFirstDrip", "peakPressure", "peakFlow", "stopReason", "lastStep", "barista", "tds",
      "extractionYield", "notes",
    ]);
    // Its scale first read 1 g or more 21.45 s into its profile, which ended in its fifth step.
    expect(measuredRow).toMatchObject({ timeToFirstDrip: 21.45, lastStep: { frame: 4, name: "Pressure Decline" } });
    expect(Object.keys(measuredRow.beanBatch as Fields)).toEqual(["id", "roaster", "name"]);
    expect(inferredRow).toMatchObject({ machine: { id: uptown1.machine.id }, machineInferred: true, location: { id: uptown.id }, locationInferred: true });
  });

  it("lists names over 60 characters and notes over 200 cut and marked, saying so first, and reads them whole one Shot at a time", async () => {
    const barista = "Annabelle from the morning shift, training on the second grinder this week";
    const notes = "Sweet and syrupy up front with stone fruit, then a little sharp at the end. ".repeat(4).trim();
    const roaster = "Roux Bakehouse and Coffee Roasters of the Upper East Side Neighbourhood";
    const shot = shotAt("assistant-long", "2026-04-02T13:00:00Z", hardware.uptown1, barista, { roaster, profile: "Londonium, a little longer at the start, for the lighter roasts" });
    await deliverShots(uptown1, hardware.uptown1, [{ ...shot, annotations: { ...(shot.annotations as Fields), espressoNotes: notes } }]);
    const day = { from: "2026-04-02", to: "2026-04-02" };
    const found = await assistant.call<{ cut?: string; shots: Fields[] }>("find_shots", day);
    expect(Object.keys(found)[0]).toBe("cut");
    expect(found.cut).toContain("get_shot");
    const [row] = found.shots as [Fields & { beanBatch: Fields; profile: Fields }];
    expect(row.barista).toBe(`${barista.slice(0, 60)}…[cut]`);
    expect(row.beanBatch.roaster).toBe(`${roaster.slice(0, 60)}…[cut]`);
    expect(row.notes).toBe(`${notes.slice(0, 200)}…[cut]`);
    // A name of 63 characters is given whole, as its cut, with its mark, would be no shorter.
    expect(row.profile.title).toBe("Londonium, a little longer at the start, for the lighter roasts");
    expect(row.beanBatch.name).toBe("Ethiopia Generic 100g Sample");
    expect(await assistant.call<Fields>("get_shot", { id: "assistant-long" })).toMatchObject({ barista, notes, profileTitle: "Londonium, a little longer at the start, for the lighter roasts", bean: { roaster }, grinderModel: "DF64 v2", basketName: "Decent 18g Ridgeless" });
    // A cut name is no name a Shot recorded, so a filter holding one is refused, as a change is; a few of its words find it.
    expect(await toolError("find_shots", { barista: row.barista as string })).toBe(
      "A value holds …[cut], so it is text a response cut short: matching words, a few of its words find its Shots, get_shot reads a Shot's names whole, and a linked item's Shots are found by its id",
    );
    expect((await assistant.call<{ shots: Fields[] }>("find_shots", { ...day, barista: "annabelle morning" })).shots.map((shot) => shot.id)).toEqual(["assistant-long"]);
    // A page whose names and notes are short says nothing of a cut.
    expect(await assistant.call<Fields>("find_shots", { from: "2026-04-01", to: "2026-04-01" })).not.toHaveProperty("cut");
  });

  it("reads a Shot as the REST API does, and its curves only when asked, each cut to at most 100 points, its peak kept, and its Preheat marked as the management interface shows it", async () => {
    const fixture = preheatShotFixture();
    const workflow = fixture.workflow as Record<string, Fields>;
    // A real Shot with a Preheat, pulled on Uptown 1, with a refractometer's readings and notes added.
    const shot = {
      ...fixture,
      id: "assistant-preheat",
      workflow: { ...workflow, machine: { ...workflow.machine, ...{ model: hardware.uptown1.model, serialNumber: hardware.uptown1.serial } } },
      annotations: { ...(fixture.annotations as Fields), drinkTds: 9.4, drinkEy: 20.1, espressoNotes: "Bright, a little thin" },
    };
    await deliverShots(uptown1, hardware.uptown1, [shot]);
    const rest = (await api.get<{ shot: RestShot }>("/shots/assistant-preheat")).shot;
    const { measurements } = await api.get<{ measurements: unknown }>("/shots/assistant-preheat/measurements");

    const read = await assistant.call<ToolShot>("get_shot", { id: "assistant-preheat" });
    expect(read).not.toHaveProperty("curves");
    const { pulledAt, previousShot, grinderModel, basketName, grinderSetting, grinderBurrs, tds, extractionYield, notes, stopReason, steps, lastStep, timeToFirstDrip: firstDrip, flowAtStop: flow, ...summary } = read;
    expect(summary).toEqual(shotSummary(rest));
    expect({ grinderModel, basketName }).toEqual({ grinderModel: rest.grinderModel, basketName: rest.basketName });
    expect({ steps, lastStep }).toEqual({ steps: toolSteps(rest.steps!), lastStep: rest.lastStep });
    // As stored with the Shot, to hundredths: its scale first read 1 g 7.945 s into its profile, and its last reading landed at 2.819 g/s.
    expect({ timeToFirstDrip: rest.timeToFirstDrip, flowAtStop: rest.flowAtStop }).toEqual({ timeToFirstDrip: 7.945, flowAtStop: 2.8189155419461156 });
    expect({ firstDrip, flow }).toEqual({ firstDrip: hundredths(rest.timeToFirstDrip!), flow: 2.82 });
    sameTimes([pulledAt], [rest.pulledAt]);
    expect(pulledAt).toMatch(/-0[56]:00$/);
    expect({ grinderSetting, grinderBurrs, tds, extractionYield, notes, stopReason }).toEqual({
      grinderSetting: "6.50",
      grinderBurrs: rest.grinderBurrs,
      tds: 9.4,
      extractionYield: 20.1,
      notes: "Bright, a little thin",
      stopReason: "targetWeight",
    });
    expect(rest.grinderBurrs).toBe("SSP MP");
    expect((previousShot as { id: string }).id).toBe(rest.previousShot!.id);
    sameTimes([(previousShot as { pulledAt: string }).pulledAt], [rest.previousShot!.pulledAt]);

    const { curves } = await assistant.call<{ curves: Record<string, Curve> & { shaded: Shaded[] } }>("get_shot", { id: "assistant-preheat", curves: true });
    // The management interface reads the same samples, and shades the same Preheat, 7.36 s before the profile starts.
    const samples = shotSamples(measurements, workflow.profile);
    expect(samples.length).toBeGreaterThan(100);
    expect(curves.shaded).toEqual(shadedSpans(samples).map(({ name, from, until }) => ({ phase: name, from: hundredths(from), until: hundredths(until) })));
    expect(curves.shaded).toEqual([{ phase: "Preheat", from: -7.36, until: 0 }]);
    for (const [name, { unit }] of Object.entries(SHOT_CURVES) as [keyof typeof SHOT_CURVES, { unit: string }][]) {
      const curve = curves[name]!;
      expect(curve.unit).toBe(unit);
      for (const [series, readingOf] of [[curve.values, (sample: (typeof samples)[number]) => sample.values[name]], [curve.targets, (sample: (typeof samples)[number]) => sample.targets[name]]] as const) {
        const read = samples.filter((sample) => readingOf(sample) !== null);
        const readings = read.map((sample) => readingOf(sample)!);
        // Every reading when there are at most 100; otherwise at most 100, and only 2 fewer for room left for the peaks.
        if (readings.length <= 100) expect(series).toHaveLength(readings.length);
        else expect(series.length).toBeGreaterThanOrEqual(98);
        expect(series.length).toBeLessThanOrEqual(100);
        if (readings.length === 0) continue;
        expect(Math.max(...series.map(([, value]) => value))).toBe(peak(readings));
        // In order, from the first reading to the last.
        expect(series.map(([seconds]) => seconds)).toEqual([...series.map(([seconds]) => seconds)].sort((a, b) => a - b));
        expect(series[0]).toEqual([hundredths(read[0]!.seconds), hundredths(readings[0]!)]);
        expect(series.at(-1)).toEqual([hundredths(read.at(-1)!.seconds), hundredths(readings.at(-1)!)]);
      }
    }
    // The peaks the Shot shows, which leave out its Preheat, are kept too.
    expect(Math.max(...curves.pressure!.values.filter(([seconds]) => seconds >= 0).map(([, value]) => value))).toBe(hundredths(rest.peakPressure!));
    expect(Math.max(...curves.flow!.values.filter(([seconds]) => seconds >= 0).map(([, value]) => value))).toBe(hundredths(rest.peakFlow!));
    // Its weight flow, from the scale, with no target: 0 in its Preheat, before Decaid tares the scale.
    expect(curves.weightFlow!.targets).toEqual([]);
    expect(curves.weightFlow!.values.filter(([seconds]) => seconds < 0).every(([, value]) => value === 0)).toBe(true);
  });

  it("gives only the curves listed, and a Shot's within a window at every reading there, a window alone asking for every curve, as get_steam_record gives a list", async () => {
    const fixture = preheatShotFixture();
    const workflow = fixture.workflow as Record<string, Fields>;
    const recorded = { ...workflow, machine: { ...workflow.machine, model: hardware.uptown1.model, serialNumber: hardware.uptown1.serial } };
    await deliverShots(uptown1, hardware.uptown1, [{ ...fixture, id: "assistant-window", workflow: recorded }]);
    const { measurements } = await api.get<{ measurements: unknown }>("/shots/assistant-window/measurements");
    const samples = shotSamples(measurements, workflow.profile);
    type Read = { curves: Record<string, Curve> & { shaded: Shaded[]; thinnedTo: number | null } };

    const all = await assistant.call<Read>("get_shot", { id: "assistant-window", curves: true });
    expect(Object.keys(all.curves)).toEqual(["shaded", "thinnedTo", "pressure", "flow", "weight", "weightFlow", "temperature"]);
    // 168 samples, so its series are thinned to the 100 points of the default.
    expect(all.curves.thinnedTo).toBe(100);
    // Listed in any order, those given are the same, in their usual order.
    const listed = await assistant.call<Read>("get_shot", { id: "assistant-window", curves: ["weightFlow", "weight"] });
    expect(listed.curves).toEqual({ shaded: all.curves.shaded, thinnedTo: 100, weight: all.curves.weight, weightFlow: all.curves.weightFlow });

    // The last 3 s before its stop, where its last weight is: every reading there.
    const end = hundredths(samples.at(-1)!.seconds);
    const window = { from: hundredths(end - 3), until: end };
    const near = await assistant.call<Read>("get_shot", { id: "assistant-window", curves: ["weight", "weightFlow"], window });
    expect(Object.keys(near.curves)).toEqual(["shaded", "thinnedTo", "weight", "weightFlow"]);
    expect(near.curves.thinnedTo).toBeNull();
    const shown = samples.filter((sample) => hundredths(sample.seconds) >= window.from && hundredths(sample.seconds) <= window.until);
    expect(shown.length).toBeGreaterThan(10);
    for (const name of ["weight", "weightFlow"] as const) {
      expect(near.curves[name]!.values).toEqual(shown.map((sample) => [hundredths(sample.seconds), hundredths(sample.values[name]!)]));
    }
    // A window alone asks for every curve within it; one ending before it starts is refused.
    const alone = await assistant.call<Read>("get_shot", { id: "assistant-window", window });
    expect(Object.keys(alone.curves)).toEqual(Object.keys(all.curves));
    expect(alone.curves.weight).toEqual(near.curves.weight);
    expect(await toolError("get_shot", { id: "assistant-window", window: { from: 5, until: 1 } })).toBe("Choose a window's until at or after its from");
    // A bound named as other tools' ranges name theirs is refused, rather than dropped to run the window to the Shot's end.
    expect(await toolError("get_shot", { id: "assistant-window", window: { from: 20, to: 25 } })).toContain('window: Unrecognized key: "to"');
    // An empty list or a curve it doesn't have is refused as an invalid input.
    for (const curves of [[], ["mixTemperature"]]) expect(await toolError("get_shot", { id: "assistant-window", curves })).toMatch(/curves/);

    await deliverSteams(uptown1, hardware.uptown1, { "steam-listed": "2026-02-12T13:00:00Z" }, milkProbeSteamFixture());
    const steam = await assistant.call<Read>("get_steam_record", { id: "steam-listed", curves: true });
    const milk = await assistant.call<Read>("get_steam_record", { id: "steam-listed", curves: ["milkTemperature"] });
    expect(milk.curves).toEqual({ shaded: steam.curves.shaded, thinnedTo: steam.curves.thinnedTo, milkTemperature: steam.curves.milkTemperature });
  });

  it("gives the steps of its Profile a Shot ran, the one it ended in, its last recorded weight, its time to first drip and its flow at the stop, without curves, as the REST API does, timed as its curves", async () => {
    const fixture = preheatShotFixture();
    const workflow = fixture.workflow as Record<string, Fields>;
    const measurements = fixture.measurements as Fields[];
    const recorded = { ...workflow, machine: { ...workflow.machine, model: hardware.uptown1.model, serialNumber: hardware.uptown1.serial } };
    // Derived from the real Shot with a Preheat, which ran to its Profile's last step: stopped in Pressurize, before
    // its Profile's last two steps; stopped in its Preheat; and pulled without a scale.
    const shots: Record<string, Fields[]> = {
      "assistant-stopped-early": measurements.slice(0, 120),
      "assistant-stopped-in-preheat": measurements.slice(0, 43),
      "assistant-no-scale": measurements.map((sample) => ({ ...sample, scale: null })),
    };
    await deliverShots(uptown1, hardware.uptown1, Object.entries(shots).map(([id, samples]) => ({ ...fixture, id, workflow: recorded, measurements: samples })));
    type Read = { steps: Fields[]; lastStep: Fields | null; lastRecordedWeight: { weight: number; seconds: number } | null; timeToFirstDrip: number | null; flowAtStop: number | null };
    const reads: Record<string, Read> = {};
    for (const [id, samples] of Object.entries(shots)) {
      // The REST API's, from the samples the Shot page reads, and the tool's the same, to hundredths.
      const rest = (await api.get<{ shot: RestShot }>(`/shots/${id}`)).shot;
      const read = shotSamples(samples, workflow.profile);
      const steps = stepSpans(read);
      expect(rest.steps, id).toEqual(steps);
      expect(rest.lastStep, id).toEqual(steps.length === 0 ? null : { frame: steps.at(-1)!.frame, name: steps.at(-1)!.name });
      expect(rest.lastRecordedWeight, id).toEqual(lastRecordedWeight(read));
      // Its stored values, as the same samples show them.
      expect({ timeToFirstDrip: rest.timeToFirstDrip, flowAtStop: rest.flowAtStop }, id).toEqual({ timeToFirstDrip: timeToFirstDrip(read), flowAtStop: flowAtStop(read) });
      const tool = await assistant.call<ToolShot & Read>("get_shot", { id });
      expect(tool).not.toHaveProperty("curves");
      expect(tool.steps, id).toEqual(toolSteps(rest.steps!));
      expect(tool.lastStep, id).toEqual(rest.lastStep);
      expect(tool.lastRecordedWeight, id).toEqual(shotSummary(rest).lastRecordedWeight);
      expect({ timeToFirstDrip: tool.timeToFirstDrip, flowAtStop: tool.flowAtStop }, id).toEqual(asTools({ timeToFirstDrip: rest.timeToFirstDrip, flowAtStop: rest.flowAtStop }));
      reads[id] = tool;
    }
    const early = reads["assistant-stopped-early"]!;
    expect(early.steps.map((step) => step.name)).toEqual(["Prefill", "Compressing", "Dripping", "Pressurize"]);
    expect(early.steps[0]).toMatchObject({ frame: 0, from: 0 });
    expect(early.lastStep).toEqual({ frame: 4, name: "Pressurize" });
    // Its last weight is its weight curve's last point.
    expect(early.lastRecordedWeight).toEqual({ weight: 4.6, seconds: early.steps.at(-1)!.until });
    const { curves } = await assistant.call<{ curves: { weight: Curve; weightFlow: Curve } }>("get_shot", { id: "assistant-stopped-early", curves: true });
    expect(curves.weight.values.at(-1)).toEqual([early.lastRecordedWeight!.seconds, early.lastRecordedWeight!.weight]);
    // Its flow at the stop is its weight flow curve's last point, and its time to first drip the first of its weight curve's
    // readings at 1 g or more, each reading up to it given by a window.
    expect({ timeToFirstDrip: early.timeToFirstDrip, flowAtStop: early.flowAtStop }).toEqual({ timeToFirstDrip: 7.95, flowAtStop: 0.98 });
    expect(curves.weightFlow.values.at(-1)).toEqual([early.lastRecordedWeight!.seconds, early.flowAtStop]);
    const { curves: before } = await assistant.call<{ curves: { weight: Curve } }>("get_shot", { id: "assistant-stopped-early", window: { until: early.timeToFirstDrip! } });
    expect(before.weight.values.at(-1)).toEqual([early.timeToFirstDrip, 1]);
    expect(before.weight.values.slice(0, -1).every(([, weight]) => weight < 1)).toBe(true);
    // Stopped in its Preheat, it ran no step, and has no last weight: Decaid records 0 for the scale until it tares it.
    const preheat = reads["assistant-stopped-in-preheat"]!;
    expect({ steps: preheat.steps, lastStep: preheat.lastStep, lastRecordedWeight: preheat.lastRecordedWeight }).toEqual({ steps: [], lastStep: null, lastRecordedWeight: null });
    expect({ timeToFirstDrip: preheat.timeToFirstDrip, flowAtStop: preheat.flowAtStop }).toEqual({ timeToFirstDrip: null, flowAtStop: null });
    // Without a scale, it has its steps but no last weight, first drip or flow at the stop.
    const unweighed = reads["assistant-no-scale"]!;
    expect(unweighed.lastStep).toEqual({ frame: 6, name: "Extraction" });
    expect({ lastRecordedWeight: unweighed.lastRecordedWeight, timeToFirstDrip: unweighed.timeToFirstDrip, flowAtStop: unweighed.flowAtStop }).toEqual({
      lastRecordedWeight: null,
      timeToFirstDrip: null,
      flowAtStop: null,
    });
    // Listed, each gives its time to first drip and the step it ended in, and leaves out the one it has none of.
    const { shots: rows } = await assistant.call<{ shots: Fields[] }>("find_shots", { machineId: uptown1.machine.id, from: "2026-10-25", to: "2026-10-26", limit: 50 });
    const row = (id: string) => rows.find((shot) => shot.id === id)!;
    expect(row("assistant-stopped-early")).toMatchObject({ timeToFirstDrip: 7.95, lastStep: { frame: 4, name: "Pressurize" } });
    expect(row("assistant-no-scale")).toMatchObject({ lastStep: { frame: 6, name: "Extraction" } });
    expect(row("assistant-no-scale")).not.toHaveProperty("timeToFirstDrip");
    for (const none of ["timeToFirstDrip", "lastStep"]) expect(row("assistant-stopped-in-preheat"), none).not.toHaveProperty(none);
  });

  it("finds Steam Records as the REST API lists them, counting a day per Location, and reads one with its curves only when asked, its start-up, pauses, puffs and purge marked as the management interface shows them", async () => {
    const day = { from: "2026-02-10", to: "2026-02-10" };
    const found = await assistant.call<{ steamRecords: ToolSteamRecord[] } & Page>("find_steam_records", day);
    const rest = await restSteamRecords(day);
    expect(found.steamRecords.map(({ steamedAt: _, ...summary }) => summary)).toEqual(rest.steamRecords.map(steamSummary));
    sameTimes(found.steamRecords.map((steam) => steam.steamedAt), rest.steamRecords.map((steam) => steam.steamedAt));
    expect(new Set(found.steamRecords.map((steam) => steam.id))).toEqual(new Set(["steam-uptown-dawn", "steam-uptown-night", "steam-harbor-early"]));
    expect(found).toMatchObject({ total: 3, offset: 0, more: false });
    const byMachine = await assistant.call<{ steamRecords: ToolSteamRecord[] } & Page>("find_steam_records", { machineId: harbor1.machine.id, limit: 1 });
    expect(byMachine.steamRecords.map((steam) => [steam.id, steam.steamedAt])).toEqual([["steam-harbor-next", "2026-02-11T01:00:00.000+09:00"]]);
    expect(byMachine).toMatchObject({ total: 2, more: true });

    // A real Steam Record stopped on time and then by a tap, one from a Bengle whose milk probe reported temperatures,
    // and one derived from the first with a probe's readings.
    await deliverSteams(uptown1, hardware.uptown1, { "steam-timed-stop": "2026-02-12T12:00:00Z" }, liveSteamFixture("steam-record-timed-stop"));
    await deliverSteams(uptown1, hardware.uptown1, { "steam-milk-probe": "2026-02-12T12:05:00Z" }, milkProbeSteamFixture());
    await deliverSteams(uptown1, hardware.uptown1, { "steam-milk-after-stop": "2026-02-12T12:10:00Z" }, milkAfterStop());
    for (const id of ["steam-timed-stop", "steam-milk-probe", "steam-milk-after-stop"]) {
      const shown = (await api.get<{ steamRecord: RestSteamRecord }>(`/steam-records/${id}`)).steamRecord;
      const { measurements } = await api.get<{ measurements: unknown }>(`/steam-records/${id}/measurements`);
      const settings = (shown.record!.workflow as Record<string, Fields>).steamSettings!;

      const read = await assistant.call<ToolSteamRecord>("get_steam_record", { id });
      expect(read).not.toHaveProperty("curves");
      const { steamedAt, ...summary } = read;
      expect(summary).toEqual(steamSummary(shown));
      sameTimes([steamedAt], [shown.steamedAt]);
      // The REST API's settings are its Workflow's, as the Steam Record page shows them.
      expect(shown.steamSettings).toEqual({
        steamTemperature: settings.targetTemperature,
        duration: settings.duration,
        flow: settings.flow,
        stopAtMilkTemperature: steamStopAt(shown.record),
      });

      const { curves } = await assistant.call<{ curves: Record<string, Curve> & { shaded: Shaded[] } }>("get_steam_record", { id, curves: true });
      const samples = steamSamples(measurements, steamStopAt(shown.record));
      expect(curves.shaded).toEqual(shadedSpans(samples).map(({ name, from, until }) => ({ phase: name, from: hundredths(from), until: hundredths(until) })));
      for (const [name, { unit }] of Object.entries(STEAM_CURVES) as [keyof typeof STEAM_CURVES, { unit: string }][]) {
        const curve = curves[name]!;
        expect(curve.unit).toBe(unit);
        const readings = samples.flatMap((sample) => (sample.values[name] === null ? [] : [sample.values[name]!]));
        expect(curve.values.length).toBeLessThanOrEqual(100);
        expect(curve.targets.length).toBeLessThanOrEqual(100);
        if (readings.length > 0) expect(Math.max(...curve.values.map(([, value]) => value))).toBe(peak(readings));
        else expect(curve.values).toEqual([]);
      }
      // The peak milk temperature it shows is kept too, though it leaves out a reading carried over from the Steam Record before.
      if (shown.peakMilkTemperature !== null) expect(curves.milkTemperature!.values.map(([, value]) => value)).toContain(hundredths(shown.peakMilkTemperature));
    }
    // Its milk peaked at 60.4 °C after the stop, below the 65 °C carried over, among more readings than a series keeps.
    const afterStop = await assistant.call<{ peakMilkTemperature: number; curves: { milkTemperature: Curve } }>("get_steam_record", { id: "steam-milk-after-stop", curves: true });
    expect(afterStop.peakMilkTemperature).toBe(60.4);
    expect(afterStop.curves.milkTemperature.values).toHaveLength(100);
    // Stopped on time, then by a tap: it starts up, pauses, puffs, pauses again and purges, over more samples than a series keeps.
    const timed = (await assistant.call<{ curves: { shaded: Shaded[]; flow: Curve } }>("get_steam_record", { id: "steam-timed-stop", curves: true })).curves;
    expect(timed.shaded.map((shaded) => shaded.phase)).toEqual(["Preparing", "Paused", "Puffing", "Paused", "Purge"]);
    expect(timed.shaded[0]).toMatchObject({ phase: "Preparing", until: 0 });
    expect(timed.flow.values).toHaveLength(100);
    // The Bengle's probe: milk heading for the 60 °C its Workflow stops at.
    const probe = await assistant.call<{ peakMilkTemperature: number; steamSettings: Fields; curves: { milkTemperature: Curve } }>("get_steam_record", { id: "steam-milk-probe", curves: true });
    expect(probe.steamSettings).toMatchObject({ stopAtMilkTemperature: 60 });
    expect(new Set(probe.curves.milkTemperature.targets.map(([, value]) => value))).toEqual(new Set([60]));
    expect(Math.max(...probe.curves.milkTemperature.values.map(([, value]) => value))).toBeGreaterThanOrEqual(hundredths(probe.peakMilkTemperature));
  });

  it("finds Shots by each word of the Bean, profile and Barista each recorded, anywhere and ignoring case, as find_library_items matches names, or by one value exactly", async () => {
    // Derived: one recording a Bean by a name an assistant spells its own way, its decaf, and one recording no Bean or Barista.
    const gao = shotAt("assistant-gao", "2026-05-01T13:00:00Z", hardware.roaming, "Dee", { bean: "China Gao's Honey", profile: "Gao's Bloom" });
    const decaf = shotAt("assistant-gao-decaf", "2026-05-01T12:55:00Z", hardware.roaming, "Ann", { bean: "China Gao's Honey Decaf" });
    const blank = shotAt("assistant-blank", "2026-05-01T13:05:00Z", hardware.roaming, "Dee");
    const { coffeeName: _, coffeeRoaster: _roaster, baristaName: _barista, ...unnamed } = (blank.workflow as { context: Fields }).context;
    await deliverShots(roaming, hardware.roaming, [gao, decaf, { ...blank, workflow: { ...(blank.workflow as Fields), context: unnamed } }]);
    const day = { from: "2026-05-01", to: "2026-05-01" };
    for (const beanName of ["china gao's honey", "gao honey", "GAO", "honey china"]) {
      expect(await findShotsAsRest({ ...day, beanName }, { ...day, coffeeName: beanName }), beanName).toEqual(["assistant-gao", "assistant-gao-decaf"]);
    }
    expect(await findShotsAsRest({ ...day, beanName: "gao kenya" }, { ...day, coffeeName: "gao kenya" })).toEqual([]);
    expect(await findShotsAsRest({ ...day, beanRoaster: "BAKEHOUSE", profileTitle: "bloom", barista: "dee" }, { ...day, coffeeRoaster: "BAKEHOUSE", profileTitle: "bloom", barista: "dee" })).toEqual([
      "assistant-gao",
    ]);
    // An empty one, or one of spaces alone, finds the Shots that recorded none.
    for (const none of ["", "  "]) {
      expect(await findShotsAsRest({ ...day, beanName: none, beanRoaster: none, barista: none }, { ...day, coffeeName: none, coffeeRoaster: none, barista: none })).toEqual(["assistant-blank"]);
    }
    // Exactly, one value as list_shot_values gives it alone, not its decaf, case included.
    const exact = { ...day, match: "exact" };
    expect(await findShotsAsRest({ ...exact, beanName: "China Gao's Honey" }, { ...exact, coffeeName: "China Gao's Honey" })).toEqual(["assistant-gao"]);
    expect(await findShotsAsRest({ ...exact, beanName: "china gao's honey" }, { ...exact, coffeeName: "china gao's honey" })).toEqual([]);
    expect((await assistant.call<{ beans: { entries: Fields[] } }>("list_shot_values", { kinds: ["beans"], limit: 50 })).beans.entries).toEqual(
      expect.arrayContaining([{ roaster: "Roux Bakehouse", name: "China Gao's Honey" }, { roaster: "Roux Bakehouse", name: "China Gao's Honey Decaf" }]),
    );
    // At most 20 words each, and no NUL, which no Shot recorded.
    expect(await toolError("find_shots", { beanName: Array.from({ length: 21 }, (_, n) => `w${n}`).join(" ") })).toBe("Use at most 20 words in each text filter");
    expect(await toolError("find_shots", { barista: "Dee\u0000" })).toBe("Use text filters without NUL characters");
    expect(await toolError("find_shots", { match: "loose" })).toContain("match");
  });

  it("lists what Shots recorded and the Library items they are linked to, as the REST API does, a page of each list at a time", async () => {
    type Named = { id: string; name: string | null; location?: (LocationView & { timeZone?: string }) | null };
    type Batch = { id: string; bean: Fields; roastDate: string | null };
    interface Options {
      beans: { coffeeRoaster: string | null; coffeeName: string | null }[];
      baristas: (string | null)[];
      profiles: (string | null)[];
      beanBatches: (Batch | null)[];
      grinders: ((Omit<Named, "name"> & { model: string | null }) | null)[];
      recipes: (Named | null)[];
      baskets: (Named | null)[];
    }
    type Values = Record<string, Page & { entries: unknown[] }>;
    const rest = await api.get<Options>("/shots/filters");
    const located = (location: LocationView | null | undefined) => location && { id: location.id, name: location.name };
    const expected: Record<string, unknown[]> = {
      beans: rest.beans.map((bean) => ({ roaster: bean.coffeeRoaster, name: bean.coffeeName })),
      baristas: rest.baristas,
      profileTitles: rest.profiles,
      // A roast date as a day, as find_shots gives it.
      beanBatches: rest.beanBatches.map((batch) => batch && { ...batch, roastDate: batch.roastDate && batch.roastDate.slice(0, 10) }),
      grinders: rest.grinders.map((grinder) => grinder && { ...grinder, location: located(grinder.location) }),
      recipes: rest.recipes.map((recipe) => recipe && { ...recipe, location: located(recipe.location) }),
      baskets: rest.baskets,
    };
    const all = await assistant.call<Values>("list_shot_values", { limit: 50 });
    expect(Object.keys(all)).toEqual(Object.keys(expected));
    for (const [kind, entries] of Object.entries(expected)) expect(all[kind], kind).toEqual({ total: entries.length, offset: 0, more: false, entries });
    // These tests' Shots recorded Beans, Baristas and titles, one recorded none, and one is linked to a Bean Batch
    // and a Grinder of the Library's, at their Location; none to a Recipe or Basket.
    expect(expected.beans).toContainEqual({ roaster: null, name: null });
    expect(expected.baristas).toEqual(expect.arrayContaining(["Ann", "Cat", null]));
    expect(expected.beanBatches).toEqual([{ id: expect.any(String), bean: { id: expect.any(String), roaster: "Roux", name: "Assistant Guji" }, roastDate: "2026-10-01" }, null]);
    expect(expected.grinders).toEqual([{ id: expect.any(String), model: "Assistant EK43", location: { id: expect.any(String), name: "Linked lab" } }, null]);
    expect([expected.recipes, expected.baskets]).toEqual([[null], [null]]);

    // Each list paged alone, two at a time, as the next page's offset is the last's plus its length.
    for (const [kind, entries] of Object.entries(expected)) {
      const paged: unknown[] = [];
      for (let offset = 0; ; offset += 2) {
        const page = await assistant.call<Values>("list_shot_values", { kinds: [kind], limit: 2, offset });
        expect(Object.keys(page)).toEqual([kind]);
        expect(page[kind]).toMatchObject({ total: entries.length, offset, more: offset + 2 < entries.length });
        paged.push(...page[kind]!.entries);
        if (!page[kind]!.more) break;
      }
      expect(paged, kind).toEqual(entries);
    }
    // 20 of each by default.
    expect((await assistant.call<Values>("list_shot_values", {})).beans!.entries).toEqual(expected.beans!.slice(0, 20));
    expect(await toolError("list_shot_values", { kinds: ["machines"] })).toContain("kinds");
    expect(await toolError("list_shot_values", { kinds: [] })).toContain("kinds");
  });

  it("summarises the Shots find_shots finds as the REST API's summary does, its numbers to hundredths", async () => {
    interface Group {
      counts: { shots: number; cleaningAndCalibration: number };
      numbers: Record<string, Fields>;
    }
    // Derived: three Shots on one day, at 12:00, 13:00 and 14:00 UTC: one 2.5 g over its target that its Machine ended,
    // the real Shot, 0.1 g under and stopped on weight, and one pulled with a cleaning profile.
    const over = shotAt("assistant-over", "2026-06-01T12:00:00Z", hardware.roaming, "Ann");
    const cleaning = shotAt("assistant-cleaning", "2026-06-01T14:00:00Z", hardware.roaming, "Ann");
    const cleaningWorkflow = cleaning.workflow as Record<string, Fields>;
    await deliverShots(roaming, hardware.roaming, [
      { ...over, stopReason: "machineEnded", annotations: { ...(over.annotations as Fields), actualYield: 38.5 } },
      shotAt("assistant-under", "2026-06-01T13:00:00Z", hardware.roaming, "Ann"),
      { ...cleaning, workflow: { ...cleaningWorkflow, profile: { ...cleaningWorkflow.profile, beverage_type: "cleaning" } } },
    ]);

    /** summarise_shots, checked against the REST API's summary for the same filters, matching words as the tool does, and against find_shots' total: its one group. */
    async function summarisedAsRest(input: Fields, query: Record<string, string>, by = assistant, at = api): Promise<Group> {
      const summarised = await by.call<{ groups: Group[] }>("summarise_shots", input);
      expect(summarised).toEqual(asTools(await at.get(`/shots/summary?${new URLSearchParams({ match: "words", ...query })}`)));
      expect(summarised.groups).toHaveLength(1);
      const [group] = summarised.groups;
      expect(group!.counts.shots + group!.counts.cleaningAndCalibration).toBe((await by.call<Page>("find_shots", { ...input, limit: 1 })).total);
      return group!;
    }

    const day = { from: "2026-06-01", to: "2026-06-01" };
    expect(await summarisedAsRest(day, day)).toEqual({
      counts: { shots: 2, cleaningAndCalibration: 1 },
      numbers: {
        // −0.1 and 2.5, and 23.549 s twice.
        yieldAgainstTarget: { shots: 2, median: 1.2, p25: 0.55, p75: 1.85 },
        duration: { shots: 2, median: 23.55, p25: 23.55, p75: 23.55 },
        stoppedOnWeight: { shots: 2, share: 0.5 },
      },
    });
    // Every filter find_shots takes, as it takes it.
    const all = (await summarisedAsRest({}, {})).counts;
    expect(all).toEqual({ shots: expect.any(Number), cleaningAndCalibration: 1 });
    const atUptown = (await summarisedAsRest({ locationId: uptown.id }, { locationId: uptown.id })).counts;
    expect(atUptown.shots).toBeGreaterThan(0);
    expect(atUptown.shots).toBeLessThan(all.shots);
    expect((await summarisedAsRest({ machineId: roaming.machine.id, ...day }, { machineId: roaming.machine.id, ...day })).counts.shots).toBe(2);
    // A date as each Location's day, as the earlier test's four Shots of the 10th.
    const february = { from: "2026-02-10", to: "2026-02-10", locationId: harbor.id };
    expect((await summarisedAsRest(february, february)).counts.shots).toBe(2);
    expect((await summarisedAsRest({ beanName: "gao honey", barista: "DEE" }, { coffeeName: "gao honey", barista: "DEE" })).counts.shots).toBe(1);
    const exact = { match: "exact", beanName: "China Gao's Honey" };
    expect((await summarisedAsRest(exact, { match: "exact", coffeeName: "China Gao's Honey" })).counts.shots).toBe(1);
    const nothing = randomUUID();
    expect(await summarisedAsRest({ recipeId: nothing }, { recipeId: nothing })).toEqual({
      counts: { shots: 0, cleaningAndCalibration: 0 },
      numbers: { yieldAgainstTarget: { shots: 0, median: null, p25: null, p75: null }, duration: { shots: 0, median: null, p25: null, p75: null }, stoppedOnWeight: { shots: 0, share: null } },
    });
    // A time with its offset is that moment: from 12:30 UTC the Shot at 13:00 and the cleaning one, up to 14:00 the first alone.
    const summarised = async (input: Fields) => (await assistant.call<{ groups: Group[] }>("summarise_shots", { machineId: roaming.machine.id, ...input })).groups[0]!.counts;
    expect(await summarised({ from: "2026-06-01T12:30:00Z", to: "2026-06-02" })).toEqual({ shots: 1, cleaningAndCalibration: 1 });
    expect(await summarised({ from: "2026-06-01T06:30:00-06:00", to: "2026-06-01T14:00:00Z" })).toEqual({ shots: 1, cleaningAndCalibration: 0 });

    // Refused as find_shots refuses them.
    expect(await toolError("summarise_shots", { from: "2026-02-11", to: "2026-02-10" })).toBe("Choose an end after the start");
    expect(await toolError("summarise_shots", { machineId: "not-an-id" })).toBe("No such Machine");
    expect(await toolError("summarise_shots", { beanName: Array.from({ length: 21 }, (_, n) => `w${n}`).join(" ") })).toBe("Use at most 20 words in each text filter");
    expect(await toolError("summarise_shots", { barista: "Ann…[cut]" })).toContain("…[cut]");
  });

  it("answers a Viewer's read-only Connected App as it answers an Admin's", async () => {
    const { link } = await api.invite("viewer-408@example.com", "viewer", []);
    const cookie = await acceptInvite(server.url, link, { name: "Viewer", password: "a password for apps" });
    const viewer = await Assistant.connect(server.url, app, cookie, { allowed: ["read"] });
    try {
      expect(await findShotsAsRest({ locationId: harbor.id }, { locationId: harbor.id }, viewer, AdminApi.signedInAs(server.url, cookie))).toEqual(["harbor-next", "harbor-noon", "harbor-early"]);
      expect(await viewer.call<Fields>("list_shot_values", {})).toEqual(await assistant.call<Fields>("list_shot_values", {}));
      expect(await viewer.call<Fields>("summarise_shots", {})).toEqual(await assistant.call<Fields>("summarise_shots", {}));
      expect(await viewer.call<Fields>("get_steam_record", { id: "steam-harbor-early" })).toMatchObject({ id: "steam-harbor-early", location: harbor });
    } finally {
      await viewer.close();
    }
  });
});
