import { randomUUID } from "node:crypto";
import { SHOT_CURVES, STEAM_CURVES, globalIdOf, shadedSpans, shotSamples, steamSamples, steamStopAt } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
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
  recipe: unknown;
  profile: unknown;
  profileTitle: string | null;
  coffeeRoaster: string | null;
  coffeeName: string | null;
  beanBatch: unknown;
  grinder: unknown;
  basket: unknown;
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
  record?: Fields;
  previousShot?: { id: string; pulledAt: string } | null;
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

/** What a tool's summary of a Shot holds, from the REST API's, but for its time, which `sameTimes` compares. */
function shotSummary(shot: RestShot): Fields {
  return {
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
    duration: shot.duration,
    enjoyment: shot.enjoyment,
    barista: shot.barista,
    peakPressure: shot.peakPressure,
    peakFlow: shot.peakFlow,
  };
}

function steamSummary(steamRecord: RestSteamRecord): Fields {
  return {
    id: steamRecord.id,
    machine: steamRecord.machine,
    location: steamRecord.location,
    duration: steamRecord.duration,
    peakMilkTemperature: steamRecord.peakMilkTemperature,
    finalMilkTemperature: steamRecord.finalMilkTemperature,
    barista: steamRecord.barista,
  };
}

const OFFSET = /(?:Z|[+-]\d\d:\d\d)$/;

/** Each tool time is the REST API's moment, as ISO 8601 with an offset. */
function sameTimes(tool: (string | null)[], rest: (string | null)[]): void {
  expect(tool.map((time) => time !== null && OFFSET.test(time))).toEqual(rest.map((time) => time !== null));
  expect(tool.map((time) => time && Date.parse(time))).toEqual(rest.map((time) => time && Date.parse(time)));
}

/** A curve's highest reading as the tool rounds it. */
const hundredths = (value: number) => Math.round(value * 100) / 100;
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
  const raws: RawConnection[] = [];

  const hardware = {
    uptown1: { model: "DE1Pro", serial: "40801" },
    harbor1: { model: "DE1XL", serial: "40802" },
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
      shotAt("uptown-before", "2026-02-10T03:00:00Z", hardware.uptown1, "Ann"),
    ]);
    await deliverShots(harbor1, hardware.harbor1, [
      // 01:00 on the 10th in Tokyo, the 9th in UTC.
      shotAt("harbor-early", "2026-02-09T16:00:00Z", hardware.harbor1, "Ann"),
      // Noon on the 10th in Tokyo.
      shotAt("harbor-noon", "2026-02-10T03:00:00Z", hardware.harbor1, "Cat"),
      // 01:00 on the 11th in Tokyo, the 10th in UTC.
      shotAt("harbor-next", "2026-02-10T16:00:00Z", hardware.harbor1, "Cat"),
    ]);
    await deliverSteams(uptown1, hardware.uptown1, { "steam-uptown-dawn": "2026-02-10T12:00:00Z", "steam-uptown-night": "2026-02-11T05:30:00Z", "steam-uptown-before": "2026-02-10T03:00:00Z" });
    await deliverSteams(harbor1, hardware.harbor1, { "steam-harbor-early": "2026-02-09T16:00:00Z", "steam-harbor-next": "2026-02-10T16:00:00Z" });

    assistant = await Assistant.connect(server.url, app, adminCookie, { allowed: ["read"] });
  });
  afterAll(async () => {
    await assistant?.close();
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await app?.close();
    await server?.stop();
  });

  /** A Shot pulled at a UTC time on the hardware given, by the Barista given. */
  function shotAt(id: string, pulledAt: string, recorded: { model: string; serial: string }, barista: string): Fields {
    const { machine, context, ...workflow } = shotFixture().workflow as Record<string, Fields>;
    return derivedShot(id, {
      timestamp: pulledAt,
      workflow: { ...workflow, context: { ...context, baristaName: barista }, machine: { ...machine, model: recorded.model, serialNumber: recorded.serial } },
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

  async function restShots(query: Record<string, string>, at = api): Promise<{ shots: RestShot[]; total: number }> {
    return at.get(`/shots?${new URLSearchParams(query)}`);
  }
  async function restSteamRecords(query: Record<string, string>): Promise<{ steamRecords: RestSteamRecord[]; total: number }> {
    return api.get(`/steam-records?${new URLSearchParams(query)}`);
  }

  /** find_shots, checked against the REST API's list for the same filters and page, returning the ids it found. */
  async function findShotsAsRest(input: Fields, query: Record<string, string>, by = assistant, at = api): Promise<string[]> {
    const found = await by.call<{ shots: ToolShot[] } & Page>("find_shots", input);
    const rest = await restShots(query, at);
    expect(found.shots.map(({ pulledAt: _, ...summary }) => summary)).toEqual(rest.shots.map(shotSummary));
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
    expect(await toolError("find_shots", { from: "2026-02-10T06:00:00" })).toContain("from");
    expect(await toolError("find_shots", { to: "2026-02-30" })).toContain("to");
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
    const { pulledAt, previousShot, grinderSetting, grinderBurrs, tds, extractionYield, notes, stopReason, ...summary } = read;
    expect(summary).toEqual(shotSummary(rest));
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

    // A real Steam Record stopped on time and then by a tap, and one from a Bengle whose milk probe reported temperatures.
    await deliverSteams(uptown1, hardware.uptown1, { "steam-timed-stop": "2026-02-12T12:00:00Z" }, liveSteamFixture("steam-record-timed-stop"));
    await deliverSteams(uptown1, hardware.uptown1, { "steam-milk-probe": "2026-02-12T12:05:00Z" }, milkProbeSteamFixture());
    for (const id of ["steam-timed-stop", "steam-milk-probe"]) {
      const shown = (await api.get<{ steamRecord: RestSteamRecord }>(`/steam-records/${id}`)).steamRecord;
      const { measurements } = await api.get<{ measurements: unknown }>(`/steam-records/${id}/measurements`);
      const settings = (shown.record!.workflow as Record<string, Fields>).steamSettings!;

      const read = await assistant.call<ToolSteamRecord>("get_steam_record", { id });
      expect(read).not.toHaveProperty("curves");
      const { steamedAt, steamSettings, ...summary } = read;
      expect(summary).toEqual(steamSummary(shown));
      sameTimes([steamedAt], [shown.steamedAt]);
      expect(steamSettings).toEqual({
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
    }
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

  it("answers a Viewer's read-only Connected App as it answers an Admin's", async () => {
    const { link } = await api.invite("viewer-408@example.com", "viewer", []);
    const cookie = await acceptInvite(server.url, link, { name: "Viewer", password: "a password for apps" });
    const viewer = await Assistant.connect(server.url, app, cookie, { allowed: ["read"] });
    try {
      expect(await findShotsAsRest({ locationId: harbor.id }, { locationId: harbor.id }, viewer, AdminApi.signedInAs(server.url, cookie))).toEqual(["harbor-next", "harbor-noon", "harbor-early"]);
      expect(await viewer.call<Fields>("get_steam_record", { id: "steam-harbor-early" })).toMatchObject({ id: "steam-harbor-early", location: harbor });
    } finally {
      await viewer.close();
    }
  });
});
