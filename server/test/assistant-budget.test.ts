import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, RESPONSE_BUDGET, type SummaryGroup, type TestApp, asTools, serveTestApp, toolSummary } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { preheatShotFixture, shotFixture } from "./support/shot-fixtures.js";
import {
  RawConnection,
  type SimulatedTablet,
  de1ProOnDecaid091,
  derivedProfile,
  derivedWorkflow,
  helloWith,
  manyProfiles,
  pluginsAndSkinsAt,
  simulatedDevices,
} from "./support/simulated-tablet.js";
import { derivedSteam, liveSteamFixture, milkProbeSteamFixture } from "./support/steam-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #431 (ADR-0028): every read tool, called as a client calls it,
// keeps its response within the budget: its text block, the one compact
// JSON copy the budget counts, at most 45,000 characters
// (`Assistant.callWithinBudget`). Each runs at its largest options on
// realistic data, derived from what Decaid, DYE2 and the management interface
// record, in the numbers a busy cafe makes, and on hostile data: names and
// notes far longer than any typed, and strings heavy with what JSON escapes.
// Records are sent as raw frames, but for a simulated tablet's Machine, whose
// Workflow, settings and Profiles its plugin reports; Library items are made
// through the REST API; Settings Edits and Conflicts, which a tablet makes one
// at a time, are copied in PostgreSQL from ones made the usual way. Serials
// are made up, from 43101.

type Fields = Record<string, unknown>;

interface Page {
  total: number;
  offset: number;
  more: boolean;
}

/** What ends text the budget cut. */
const CUT_MARK = "…[cut]";

/** Text heavy with what JSON escapes, emoji included, about `length` characters long. */
function hostile(length: number): string {
  const piece = 'Quote " backslash \\ newline \n tab \t bell \u0007 emoji \u{1F600}\u{1F375} ';
  return piece.repeat(Math.ceil(length / piece.length));
}

/** That a page's `total`, `offset` and `more` come before its list in the text sent, so a client that cuts the end of it keeps them. */
function pagingFirst(text: string, list: string): void {
  const at = text.indexOf(`"${list}":`);
  expect(at, list).toBeGreaterThan(-1);
  for (const field of ["total", "offset", "more"]) expect(text.indexOf(`"${field}":`), field).toBeLessThan(at);
}

const cut = (value: unknown) => typeof value === "string" && value.endsWith(CUT_MARK);

/** Every number summarise_shots gives, asked for at once. */
const EVERY_NUMBER = ["yieldAgainstTarget", "duration", "stoppedOnWeight", "ratio", "peakPressure", "peakFlow", "rating", "grindSetting", "tds", "extractionYield", "timeToFirstDrip", "lastStep"];

/** A Machine's use, as get_machine_use and the REST API's route give it. */
interface Use {
  by: "day" | "hour";
  from: string;
  to: string;
  buckets: { date: string; hour?: number; shots: number; steamRecords: number; flushes: number; hotWaterPours: number; states: { state: string; name: string; seconds: number }[] }[];
}

/** list_shot_values' lists, and the REST API's names for them in `GET /api/shots/filters`. */
const SHOT_VALUES = { beans: "beans", baristas: "baristas", profileTitles: "profiles", beanBatches: "beanBatches", grinders: "grinders", recipes: "recipes", baskets: "baskets" } as const;

/** That each list of a response holding several gives its `total`, `offset` and `more` before its entries, as pagingFirst checks a page. */
function eachPagingFirst(text: string, lists: readonly string[]): void {
  const found = [...text.matchAll(new RegExp(`"(${lists.join("|")})":\\{(.*?)"entries"`, "g"))];
  expect(found.map((list) => list[1])).toEqual(lists);
  for (const list of found) expect(list[2], list[1]).toMatch(/^"total":\d+,"offset":\d+,"more":(true|false),$/);
}

/** A plugin's entry in Decaid's plugin list, shaped as DYE2's (fixtures/decaid/dye2-v0.1.26/plugins.json), about 1.8 KB. */
function pluginListing(): Fields {
  return (JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/dye2-v0.1.26/plugins.json", import.meta.url), "utf8")) as { listed: Fields[] }).listed[0]!;
}

/** The serial the bar's tablet reports, which the Shots it pulls record (de1ProOnDecaid091). */
const BAR_SERIAL = "10001";

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("every read tool's response within the budget", { timeout: 240_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: LocationView;
  let harbor: LocationView;
  const tablets = new LoadedTablets();
  const raws: RawConnection[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env: { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
    lab = await api.createLocation("Lab", "America/Chicago");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
  });
  afterAll(async () => {
    await assistant?.close();
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  /** A Machine at a Location since 2025, so that the records it took then, as those these tests send, are at that Location. */
  async function machineAt(name: string, location: LocationView): Promise<CreatedMachine> {
    const machine = await api.createMachine(name);
    await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    return machine;
  }

  /** A connection with the Machine's token reporting its hardware, kept open until the file ends. */
  async function connectionOf(machine: CreatedMachine, serial: string): Promise<RawConnection> {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: { model: "DE1Pro", serial } }));
    raws.push(raw);
    return raw;
  }

  /** A Shot pulled `minutes` after 06:00 UTC on 2 November 2026, derived from `fixture`, with the changes given to its Workflow's context, profile and annotations. */
  function shotAt(id: string, minutes: number, serial: string, changes: { context?: Fields; profile?: Fields; annotations?: Fields } = {}, fixture = shotFixture()): Fields {
    const workflow = fixture.workflow as Record<string, Fields>;
    return {
      ...fixture,
      id,
      timestamp: new Date(Date.UTC(2026, 10, 2, 6, minutes)).toISOString(),
      workflow: {
        ...workflow,
        context: { ...workflow.context, ...changes.context },
        profile: { ...workflow.profile, ...changes.profile },
        machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
      },
      annotations: { ...(fixture.annotations as Fields), ...changes.annotations },
    };
  }

  async function deliverShots(raw: RawConnection, shots: Fields[]): Promise<void> {
    await Promise.all(shots.map((shot) => raw.deliver({ type: "shot", id: randomUUID(), shotId: shot.id, shot })));
  }

  /** The ids of a list's entries, through the REST API, in its order: up to 100, two pages of 50. */
  async function restIds(path: string, list: string, query: Record<string, string>): Promise<string[]> {
    const pages = await Promise.all(["0", "50"].map((offset) => api.get<Record<string, { id: string }[]>>(`${path}?${new URLSearchParams({ ...query, limit: "50", offset })}`)));
    return pages.flatMap((page) => page[list]!.map((entry) => entry.id));
  }

  /**
   * Each page of a tool's list from the first, `limit` 50 a page, each
   * within the budget with its paging fields first, as the next page's
   * offset is the last's plus its length: the ids of every entry, and each
   * page's length.
   */
  async function everyPage(tool: string, list: string, args: Fields): Promise<{ ids: string[]; lengths: number[] }> {
    const ids: string[] = [];
    const lengths: number[] = [];
    for (let offset = 0; ; ) {
      const { result, text } = await assistant.callWithinBudget<Page & Record<string, { id: string }[]>>(tool, { ...args, limit: 50, offset });
      pagingFirst(text, list);
      expect(result.offset).toBe(offset);
      const entries = result[list]!;
      expect(entries.length, `${tool} at ${offset}`).toBeGreaterThan(0);
      ids.push(...entries.map((entry) => entry.id));
      lengths.push(entries.length);
      offset += entries.length;
      expect(result.more).toBe(offset < result.total);
      if (!result.more) return { ids, lengths };
    }
  }

  /** Each page of one kind of list of a tool that gives several, such as a Machine's activity, as everyPage reads a list: how many entries in all, and each page's length. */
  async function everyKind(tool: string, kind: string, args: Fields): Promise<{ count: number; lengths: number[] }> {
    const lengths: number[] = [];
    for (let offset = 0; ; ) {
      const { result } = await assistant.callWithinBudget<Record<string, Page & { entries: unknown[] }>>(tool, { ...args, kinds: [kind], limit: 50, offset });
      const page = result[kind]!;
      lengths.push(page.entries.length);
      offset += page.entries.length;
      expect(page.more).toBe(offset < page.total);
      if (!page.more) return { count: offset, lengths };
    }
  }

  describe("on realistic data, at each tool's largest options", () => {
    let bar: CreatedMachine;
    let tablet: SimulatedTablet;
    let roastery: CreatedMachine;
    let raw: RawConnection;

    beforeAll(async () => {
      // The Lab's bar: a tablet with the test tablet's Decaid, its Workflow, settings and DYE2's recipes and baskets, and
      // 55 Profiles, its own five eleven times over, each copy with ids of its own, which join the Library at the Lab.
      bar = await machineAt("Lab bar", lab);
      const five = JSON.stringify(manyProfiles(1).slice(0, 5)).length;
      tablet = tablets.syncing(bar, server, { api: { ...de1ProOnDecaid091(), "/profiles": manyProfiles(10 * five) } });
      await api.waitForOnline(bar);
      roastery = await machineAt("Lab roastery", lab);
      raw = await connectionOf(roastery, "43101");
    });

    it("finds Shots 50 a page, and every Shot on some page once", async () => {
      // 60 Shots the bar's tablet pulls one morning, each linked to its Library's Bean Batch, Grinder, Basket and
      // Profile, as the real one it is derived from is, by four Baristas, recording three Beans. Every third is
      // measured with a refractometer, and every other has notes, as Baristas type them while dialling in: a few
      // words, or a few lines.
      const baristas = ["Ann", "Ben", "Cat", "Dee"];
      const beans = [
        ["Roux Bakehouse", "Ethiopia Guji Hambela"],
        ["Monogram", "Colombia El Paraiso Lychee"],
        ["Pilot", "Kenya Nyeri Gatomboya AA"],
      ];
      const notes = [
        "Sour, grind finer.",
        "Sweet and balanced, a little thin; up the dose half a gram.",
        "Ran fast after the grinder was cleaned, channelled at 12 s. Bitter finish, with a dry, ashy aftertaste; went two steps finer and redistributed before tamping.",
      ];
      for (let n = 0; n < 60; n++) {
        const [roaster, name] = beans[n % 3]!;
        const measured = n % 3 === 0 && { drinkTds: 9.2 + (n % 5) / 10, drinkEy: 19.5 + (n % 7) / 10 };
        const noted = n % 2 === 0 && { espressoNotes: notes[(n / 2) % 3] };
        tablet.pullShot(
          shotAt(`morning-${String(n).padStart(2, "0")}`, n, BAR_SERIAL, {
            context: { baristaName: baristas[n % 4], coffeeRoaster: roaster, coffeeName: name },
            annotations: { ...measured, ...noted },
          }),
        );
      }
      await expect.poll(async () => (await api.get<{ total: number }>(`/shots?machineId=${bar.machine.id}`)).total).toBe(60);
      const { ids, lengths } = await everyPage("find_shots", "shots", { machineId: bar.machine.id });
      expect(ids).toEqual(await restIds("/shots", "shots", { machineId: bar.machine.id }));
      expect(lengths).toEqual([50, 10]);
      // About 870 characters a Shot, a quarter of them the ids of the items each names and 73 its time to first drip and
      // the step it ended in, so 50 still fit, uncut: about 43,400 characters of the 45,000.
      const { result, text } = await assistant.callWithinBudget<{ shots: Fields[] }>("find_shots", { machineId: bar.machine.id, limit: 50 });
      expect(result).not.toHaveProperty("cut");
      expect(result.shots).toHaveLength(50);
      expect(result.shots.every((shot) => shot.timeToFirstDrip === 21.45 && (shot.lastStep as Fields).name === "Pressure Decline")).toBe(true);
      expect(text.length).toBeGreaterThan(43_000);
      expect(result.shots[0]).toMatchObject({ location: { id: lab.id }, beanBatch: { id: expect.any(String) }, grinder: { id: expect.any(String) }, basket: { id: expect.any(String) } });
    });

    it("summarises the morning's Shots in a few hundred characters, as the REST API does", async () => {
      const { result, text } = await assistant.callWithinBudget<Fields>("summarise_shots", { machineId: bar.machine.id });
      expect(result).toEqual(toolSummary(await api.get(`/shots/summary?machineId=${bar.machine.id}`)));
      // Each derived from the real Shot, 0.1 g under its target and stopped on weight.
      expect(result).toMatchObject({
        groups: [{ counts: { shots: 60, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 }, numbers: { yieldAgainstTarget: { shots: 60, median: -0.1 }, duration: { shots: 60 }, stoppedOnWeight: { shots: 60, share: 1 } } }],
      });
      // One group's counts and numbers, whatever the number of Shots, where 50 of them listed are about 43,000.
      expect(text.length).toBeLessThan(500);
    });

    it("reads a Shot with its steps, last recorded weight and curves, all of them, a list, or within its widest window", async () => {
      const fixture = preheatShotFixture();
      const notes = { annotations: { espressoNotes: "Sweet, a little sharp at the end; try a finer grind." } };
      // Derived: the real Shot, and the same with its 168 samples repeated five times, in order and with their recorded
      // times, as a long tea shot's are.
      const long = { ...fixture, measurements: Array.from({ length: 5 }, () => fixture.measurements as unknown[]).flat() };
      await deliverShots(raw, [shotAt("preheat", 90, "43101", notes, fixture), shotAt("preheat-long", 91, "43101", notes, long)]);
      const { result } = await assistant.callWithinBudget<Fields & { curves: Fields }>("get_shot", { id: "preheat", curves: true });
      expect(result).not.toHaveProperty("cut");
      expect(Object.keys(result.curves)).toEqual(["shaded", "thinnedTo", "pressure", "flow", "weight", "weightFlow", "temperature"]);
      expect(result.steps).toHaveLength(5);
      expect(result.lastRecordedWeight).toMatchObject({ weight: 32.4 });
      expect(result).toMatchObject({ timeToFirstDrip: 7.95, flowAtStop: 2.82 });
      const listed = await assistant.callWithinBudget<{ curves: Fields }>("get_shot", { id: "preheat", curves: ["weight", "weightFlow"] });
      expect(Object.keys(listed.result.curves)).toEqual(["shaded", "thinnedTo", "weight", "weightFlow"]);
      // Its widest window, the whole Shot: every reading of the Shot, and as many of the long one's as fit.
      const whole = await assistant.callWithinBudget<{ curves: { thinnedTo: number | null; pressure: { values: unknown[] } } }>("get_shot", { id: "preheat", curves: true, window: {} });
      expect(whole.result.curves.thinnedTo).toBeNull();
      expect(whole.result.curves.pressure.values).toHaveLength(168);
      for (const window of [{}, { from: -1_000_000, until: 1_000_000 }]) {
        const widest = await assistant.callWithinBudget<Fields & { curves: { thinnedTo: number } }>("get_shot", { id: "preheat-long", curves: true, window });
        expect(widest.result).not.toHaveProperty("cut");
        expect(widest.result.curves.thinnedTo).toBeGreaterThan(100);
        expect(widest.result.curves.thinnedTo).toBeLessThan(840);
      }
    });

    it("finds Steam Records a page at a time, and reads one with its curves", async () => {
      await Promise.all(
        Array.from({ length: 55 }, (_, n) => {
          const steamId = `steam-${String(n).padStart(2, "0")}`;
          return raw.deliver({ type: "steam", id: randomUUID(), steamId, steamedAt: new Date(Date.UTC(2026, 10, 2, 7, n)).toISOString(), steam: derivedSteam(steamId, {}) });
        }),
      );
      const { ids } = await everyPage("find_steam_records", "steamRecords", { machineId: roastery.machine.id });
      expect(ids).toEqual(await restIds("/steam-records", "steamRecords", { machineId: roastery.machine.id }));
      const steamId = "steam-timed-stop";
      await raw.deliver({ type: "steam", id: randomUUID(), steamId, steamedAt: "2026-11-02T08:00:00.000Z", steam: derivedSteam(steamId, {}, liveSteamFixture("steam-record-timed-stop")) });
      const { result } = await assistant.callWithinBudget<Fields>("get_steam_record", { id: steamId, curves: true });
      expect(result).not.toHaveProperty("cut");
    });

    it("lists the Locations and Machines", async () => {
      await assistant.callWithinBudget("list_locations");
      await assistant.callWithinBudget("list_machines");
    });

    it("gives a Machine with its Workflow, summarised and whole, Machine Settings and Tablet Settings as its tablet reported them", async () => {
      await expect.poll(async () => (await assistant.call<{ workflow: unknown; machineSettings: Record<string, unknown> }>("get_machine", { machineId: bar.machine.id })).machineSettings.machineSettings).not.toBeNull();
      const summarised = await assistant.callWithinBudget<{ workflow: Fields }>("get_machine", { machineId: bar.machine.id });
      expect(summarised.result).not.toHaveProperty("cut");
      expect(summarised.result.workflow).not.toHaveProperty("raw");
      const whole = await assistant.callWithinBudget<{ workflow: Fields }>("get_machine", { machineId: bar.machine.id, raw: true });
      expect(whole.result).not.toHaveProperty("cut");
      // As Decaid sent it, but for its numbers, to hundredths, as Decaid's steam flow of 2.500000000000001 is 2.5.
      expect(whole.result.workflow.raw).toEqual(asTools(tablet.workflow()));
      expect(whole.text.length - summarised.text.length).toBeGreaterThan(JSON.stringify(asTools(tablet.workflow())).length);
    });

    it("gives a Machine's activity a page at a time, 55 Workflow changes and Machine States of each", async () => {
      const states = [
        ["espresso", "pouring"],
        ["idle", "idle"],
        ["steam", "steaming"],
        ["sleeping", "noState"],
        ["idle", "idle"],
      ] as const;
      for (let n = 0; n < 55; n++) {
        const observedAt = new Date(Date.UTC(2026, 10, 3, 6, n)).toISOString();
        const [state, substate] = states[n % states.length]!;
        await raw.deliver({ type: "machineState", id: randomUUID(), observedAt, state, substate });
        await raw.deliver({
          type: "workflow",
          id: randomUUID(),
          observedAt,
          workflow: derivedWorkflow({ targetDoseWeight: 18 + (n % 5) / 10, grinderSetting: String(2 + (n % 7) / 10), coffeeName: "Ethiopia Guji Hambela", baristaName: "Ann" }),
          // Who made it, by the plugin's write of the longest name.
          cause: "plugin",
          pluginWrite: "loadedRecipe",
        });
      }
      const range = { machineId: roastery.machine.id, from: "2026-11-03", to: "2026-11-03" };
      const { result, text } = await assistant.callWithinBudget<Record<string, Page & { entries: unknown[] }>>("get_machine_activity", { ...range, limit: 50 });
      for (const kind of ["workflowChanges", "machineStates"]) {
        expect(result[kind]!.total, kind).toBeGreaterThanOrEqual(55);
        expect(result[kind]!.more, kind).toBe(true);
      }
      for (const list of text.matchAll(/"(workflowChanges|loadedRecipes|machineStates)":\{(.*?)"entries"/g)) {
        expect(list[2], list[1]).toMatch(/^"total":\d+,"offset":\d+,"more":(true|false),$/);
      }
      for (const kind of ["workflowChanges", "machineStates"] as const) {
        const { count, lengths } = await everyKind("get_machine_activity", kind, range);
        expect(count).toBe(result[kind]!.total);
        expect(lengths.every((length) => length > 0)).toBe(true);
      }
    });

    it("gives a Machine's use over its longest ranges, 31 days by day and a day of 25 hours by hour, eleven of Decaid's states in each, as the REST API does", async () => {
      // An hour of a busy bar, in Decaid's states: a Shot, steaming with its purge, a flush, hot water, the steam wand
      // rinsed, the tank refilled, a clean and a descale begun, a wake schedule's idle and a doze. Sent for each hour
      // of 2 October 2026 in Chicago, 5 hours behind UTC, then copied in PostgreSQL to each of the 31 days after it,
      // into 2 November, so that 1 November, 25 hours long as the clocks go back there, has every hour of it: the
      // longest range of each kind takes that day in.
      const hour: [state: string, substate: string, minute: number, second: number][] = [
        ["idle", "idle", 0, 0],
        ["espresso", "preinfusion", 5, 0],
        ["espresso", "pouring", 5, 10],
        ["idle", "idle", 5, 35],
        ["steam", "pouring", 10, 0],
        ["steam", "pouringDone", 10, 40],
        ["idle", "idle", 10, 45],
        ["flush", "pouring", 15, 0],
        ["idle", "idle", 15, 5],
        ["hotWater", "pouring", 20, 0],
        ["idle", "idle", 20, 10],
        ["steamRinse", "pouring", 25, 0],
        ["idle", "idle", 25, 5],
        ["needsWater", "idle", 30, 0],
        ["idle", "idle", 31, 0],
        ["cleaning", "idle", 35, 0],
        ["idle", "idle", 36, 0],
        ["descaling", "idle", 40, 0],
        ["idle", "idle", 41, 0],
        ["schedIdle", "idle", 45, 0],
        ["sleeping", "idle", 50, 0],
      ];
      const busy = await machineAt("Lab busy", lab);
      const frames = await connectionOf(busy, "43104");
      for (let n = 0; n < 24; n++) {
        for (const [state, substate, minute, second] of hour) {
          await frames.deliver({ type: "machineState", id: randomUUID(), observedAt: new Date(Date.UTC(2026, 9, 2, 5 + n, minute, second)).toISOString(), state, substate });
        }
      }
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO machine_state_events (machine_id, observed_at, state, substate)
           SELECT machine_id, observed_at + n * interval '24 hours', state, substate
           FROM machine_state_events, generate_series(1, 31) AS n WHERE machine_id = $1 ORDER BY n, id`,
          [busy.machine.id],
        );
      } finally {
        await database.end();
      }
      const rest = async (query: Record<string, string>) => asTools(await api.get<Use>(`/machines/${busy.machine.id}/use?${new URLSearchParams(query)}`));
      /** The offsets either side of the change: the days begin 5 hours behind UTC, and 2 November 6 hours behind. */
      const ends = { from: "T00:00:00.000-05:00", to: "2026-11-02T00:00:00.000-06:00" };

      // 31 days, an hour over 31 times 24, which is as long as a range by day may be.
      const month = await assistant.callWithinBudget<Use>("get_machine_use", { machineId: busy.machine.id, from: "2026-10-02", to: "2026-11-01" });
      expect(month.result).not.toHaveProperty("cut");
      expect(month.result).toEqual({ ...(await rest({ from: "2026-10-02", to: "2026-11-01" })), from: `2026-10-02${ends.from}`, to: ends.to });
      expect(month.result.buckets).toHaveLength(31);
      for (const day of month.result.buckets) {
        // A flush and a hot water pour an hour, and every second of the day in some state.
        const hours = day.date === "2026-11-01" ? 25 : 24;
        expect([day.flushes, day.hotWaterPours, day.states.length], day.date).toEqual([hours, hours, 11]);
        expect(day.states.reduce((sum, state) => sum + state.seconds, 0), day.date).toBe(hours * 3_600);
      }
      // About 700 characters a day, so a month is about half the budget.
      expect(month.text.length).toBeGreaterThan(20_000);

      // The day of 25 hours, as long as a range by hour may be: 24 hours on the wall clock, the one repeated twice as long.
      const day = await assistant.callWithinBudget<Use>("get_machine_use", { machineId: busy.machine.id, from: "2026-11-01", to: "2026-11-01", by: "hour" });
      expect(day.result).not.toHaveProperty("cut");
      expect(day.result).toEqual({ ...(await rest({ from: "2026-11-01", to: "2026-11-01", by: "hour" })), from: `2026-11-01${ends.from}`, to: ends.to });
      expect(day.result.buckets.map((bucket) => [bucket.hour, bucket.flushes, bucket.hotWaterPours, bucket.states.length])).toEqual(
        Array.from({ length: 24 }, (_, n) => [n, n === 1 ? 2 : 1, n === 1 ? 2 : 1, 11]),
      );
      expect(day.result.buckets.reduce((sum, bucket) => sum + bucket.states.reduce((seconds, state) => seconds + state.seconds, 0), 0)).toBe(25 * 3_600);
    });

    it("lists a Machine's Settings Edits a page at a time", async () => {
      // Two made the usual way and answered by the bar's tablet, one applied and one refused as changed since, each
      // then copied in PostgreSQL 27 times, a minute apart.
      const path = `/machines/${bar.machine.id}/settings-edits`;
      for (const body of [
        { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } },
        { collection: "machineSettings", fields: { fan: 45 }, expected: { fan: 50 } },
      ]) {
        const { id } = (await api.send<{ settingsEdit: { id: string } }>("POST", path, body, 201)).settingsEdit;
        await expect.poll(async () => (await api.get<{ settingsEdit: { answeredAt: string | null } }>(`${path}/${id}`)).settingsEdit.answeredAt).not.toBeNull();
      }
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_edits (id, machine_id, session_id, tablet_id, account_id, connected_app_id, collection, schedule_action, schedule_id, fields, expected,
             made_at, sent_at, answered_at, outcome, late, refusal, machine_state, decaid_status, decaid_message, read_back)
           SELECT gen_random_uuid(), machine_id, session_id, tablet_id, account_id, connected_app_id, collection, schedule_action, schedule_id, fields, expected,
             made_at - n * interval '1 minute', sent_at - n * interval '1 minute', answered_at - n * interval '1 minute', outcome, late, refusal,
             machine_state, decaid_status, decaid_message, read_back
           FROM settings_edits, generate_series(1, 27) AS n WHERE machine_id = $1`,
          [bar.machine.id],
        );
      } finally {
        await database.end();
      }
      const { ids } = await everyPage("list_settings_edits", "settingsEdits", { machineId: bar.machine.id });
      expect(ids).toHaveLength(56);
    });

    it("lists a Machine's Settings History a page at a time, 54 updates of a plugin list as large as a cafe's, and gives its settings as last received by a time", async () => {
      // Eight plugins shaped as DYE2's listing (fixtures/decaid/dye2-v0.1.26/plugins.json), about 16 KB as Belmont's
      // tablets list theirs, one updated each minute from 06:00 on 5 November, 55 lists in all, as copied in PostgreSQL.
      const listing = pluginListing();
      const versions = Array.from({ length: 8 }, () => "1.0.0");
      const lists = Array.from({ length: 55 }, (_, n) => {
        versions[n % 8] = `1.${n}.0`;
        return versions.map((version, plugin) => ({ ...listing, id: `plugin-${plugin}.reaplugin`, version }));
      });
      expect(JSON.stringify(lists[0]).length).toBeGreaterThan(14_000);
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_history (machine_id, name, value, received_at)
           SELECT $1, 'plugins', value, '2026-11-05T06:00:00Z'::timestamptz + (n - 1) * interval '1 minute'
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS listed(value, n)`,
          [roastery.machine.id, JSON.stringify(lists)],
        );
      } finally {
        await database.end();
      }
      const { ids, lengths } = await everyPage("list_settings_history", "changes", { machineId: roastery.machine.id });
      expect(ids).toHaveLength(54);
      expect(lengths[0]).toBeLessThan(50);
      const { result } = await assistant.callWithinBudget<Fields>("get_machine", { machineId: bar.machine.id, at: new Date().toISOString() });
      expect(result).not.toHaveProperty("cut");
      expect((result.machineSettings as Fields).machineSettings).not.toBeNull();
    });

    it("gives all five collections of what a Machine's tablet reports besides its settings, its plugin list as large as a cafe's", async () => {
      // Eight plugins shaped as DYE2's listing, about 16 KB as Belmont's tablets list theirs; the Skins Decaid's Linux
      // release lists with both of Streamline's builds installed besides its bundled ones; Decaid's simulated devices and
      // sensors, without the machine only discovered nearby, as the plugin sends them, and, derived, their scale reporting
      // its firmware and battery level.
      const plugins = Array.from({ length: 8 }, (_, n) => ({ ...pluginListing(), id: `plugin-${n}.reaplugin` }));
      expect(JSON.stringify(plugins).length).toBeGreaterThan(14_000);
      const answers = pluginsAndSkinsAt("streamlineMain");
      const skins = { skins: answers["/webui/skins"]!.body, default: answers["/webui/skins/default"]!.body, server: answers["/webui/server/status"]!.body };
      const simulated = simulatedDevices();
      const reported = { scaleInfo: { firmwareVersion: "1.2.0", batteryLevel: 80 }, sensors: simulated["/sensors"], pairedDevices: (simulated["/devices"] as { state: string }[]).filter((device) => device.state !== "discovered"), plugins, skins };
      for (const [name, value] of Object.entries(reported)) await raw.deliver({ type: "collection", id: randomUUID(), name, available: true, value });
      const { result } = await assistant.callWithinBudget<Record<string, { value: unknown }>>("get_machine_reports", { machineId: roastery.machine.id });
      expect(result).not.toHaveProperty("cut");
      expect(Object.keys(result)).toEqual(Object.keys(reported));
      for (const name of ["scaleInfo", "sensors", "plugins", "skins"] as const) expect(result[name]!.value, name).toEqual(reported[name]);
      expect(result.pairedDevices).toMatchObject({ scale: { firmware: "1.2.0", batteryLevel: 80 } });
    });

    describe("the Library", () => {
      /** Each kind's ids, by its find_library_items list. */
      const made: Record<string, string[]> = {};
      let recipe: string;
      let tool: string;

      beforeAll(async () => {
        // At Harbor, which has no tablets to write to, 55 of each kind the management interface makes.
        const send = async (path: string, body: Fields) => Object.values(await api.send<Record<string, { id: string }>>("POST", path, body, 201))[0]!.id;
        const at = (n: number) => String(n).padStart(2, "0");
        const sequential = async <T>(count: number, make: (n: number) => Promise<T>) => {
          const all: T[] = [];
          for (let n = 0; n < count; n++) all.push(await make(n));
          return all;
        };
        made.beans = await sequential(55, (n) =>
          send("/beans", {
            content: { roaster: "Roux Bakehouse", name: `Ethiopia Guji Hambela lot ${at(n)}`, country: "Ethiopia", region: "Guji", processing: "Washed", variety: ["Heirloom"], notes: "Peach, jasmine and bergamot; a long, sweet finish." },
          }),
        );
        made.beanBatches = await sequential(55, (n) =>
          send("/bean-batches", { beanId: made.beans![n]!, content: { roastDate: "2026-10-28", roastLevel: "Light", weight: 1000, notes: "Rested a week." }, locations: [{ locationId: harbor.id, remainingWeight: 750 }] }),
        );
        made.grinders = await sequential(55, (n) => send("/grinders", { locationId: harbor.id, content: { model: `Mahlkönig EK43 S ${at(n)}`, burrs: "SSP Ultra Low Fines", burrType: "flat" } }));
        made.baskets = await sequential(55, (n) => send("/baskets", { locationId: harbor.id, content: { name: `VST 18g ${at(n)}` } }));
        made.tools = await sequential(55, (n) => send("/tools", { locationId: harbor.id, content: { name: `WDT ${at(n)}`, custom: [{ key: "Needles", value: "8" }] } }));
        tool = made.tools[0]!;
        // Recipes of the bar's Profiles, five of them shown at Harbor.
        await until(async () => (await api.get<{ profiles: unknown[] }>("/profiles")).profiles.length >= 55);
        const profiles = (await api.get<{ profiles: { id: string }[] }>("/profiles")).profiles.slice(0, 5);
        for (const profile of profiles) await api.send("PUT", `/profiles/${encodeURIComponent(profile.id)}/locations/${harbor.id}`, { shown: true });
        made.recipes = await sequential(55, (n) =>
          send("/recipes", {
            locationId: harbor.id,
            slot: n < 5 ? n + 1 : null,
            content: {
              name: `Harbor espresso ${at(n)}`,
              beanBatchId: made.beanBatches![n]!,
              profileId: profiles[n % profiles.length]!.id,
              dose: 18,
              yield: 40,
              grinderId: made.grinders![n]!,
              grindSetting: 2.5,
              basketId: made.baskets![n]!,
              toolIds: [tool],
              brewTemperature: 93,
              steamTemperature: 160,
              steamDuration: 30,
              hotWaterTemperature: 90,
              hotWaterVolume: 120,
            },
          }),
        );
        recipe = made.recipes[0]!;
        // A Recipe dialled in through the day: 55 edits of its dose and grind.
        for (let n = 0; n < 55; n++) await api.send("PATCH", `/recipes/${recipe}`, { content: { dose: 18 + (n % 5) / 10, grindSetting: 2 + (n % 7) / 10 } });
      });

      it("finds 55 items of each kind a page at a time", async () => {
        for (const [kind, list] of [
          ["bean", "beans"],
          ["beanBatch", "beanBatches"],
          ["profile", "profiles"],
          ["grinder", "grinders"],
          ["basket", "baskets"],
          ["tool", "tools"],
          ["recipe", "recipes"],
        ] as const) {
          const { ids } = await everyPage("find_library_items", list, { kind });
          expect(ids.length, kind).toBeGreaterThanOrEqual(55);
          if (made[list]) expect(ids, kind).toEqual(expect.arrayContaining(made[list]!));
        }
      });

      it("lists what 55 Shots recorded and the Library items they are linked to, 50 of each list a page, and every value on some page once", async () => {
        // A Machine at the Lab with no tablet, whose Shots are the bar's first copied in PostgreSQL 55 times, a minute
        // apart on 6 November, each recording a Bean, Barista and profile title of its own, linked to a Bean Batch,
        // Grinder and Basket at Harbor of its own, and pulled with a Recipe of its own loaded.
        const shelf = await machineAt("Lab copies", lab);
        const at = (n: number) => String(n + 1).padStart(2, "0");
        const each = <T>(value: (n: number) => T) => Array.from({ length: 55 }, (_, n) => value(n));
        const roasters = ["Roux Bakehouse", "Monogram", "Pilot", "Sey", "Tim Wendelboe"];
        const database = await server.connectDatabase();
        try {
          await database.query(
            `INSERT INTO shots
             SELECT (jsonb_populate_record(NULL::shots, to_jsonb(s) || jsonb_build_object(
               'id', 'copied-' || lpad(n::text, 2, '0'), 'machine_id', $1::uuid, 'tablet_id', NULL, 'pulled_at', '2026-11-06T06:00:00Z'::timestamptz + n * interval '1 minute',
               'coffee_roaster', ($2::text[])[n], 'coffee_name', ($3::text[])[n], 'barista', ($4::text[])[n], 'profile_title', ($5::text[])[n],
               'library_batch_id', ($6::uuid[])[n], 'library_grinder_id', ($7::uuid[])[n], 'library_basket_id', ($8::uuid[])[n], 'recipe_id', ($9::uuid[])[n]))).*
             FROM shots AS s, generate_series(1, 55) AS n WHERE s.id = 'morning-00'`,
            [
              shelf.machine.id,
              each((n) => roasters[n % roasters.length]),
              each((n) => `Ethiopia Guji Hambela lot ${at(n)}`),
              each((n) => `Barista ${at(n)}`),
              each((n) => `Blooming espresso ${at(n)}`),
              made.beanBatches,
              made.grinders,
              made.baskets,
              made.recipes,
            ],
          );
          await database.query(
            `INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at, unloaded_at)
             SELECT machine_id, recipe_id, pulled_at - interval '20 seconds', pulled_at + interval '30 seconds' FROM shots WHERE machine_id = $1 ORDER BY pulled_at`,
            [shelf.machine.id],
          );
        } finally {
          await database.end();
        }
        const lists = Object.keys(SHOT_VALUES);
        // About 33,000 characters, 9,500 of them the Bean Batches', so 50 of each fit, uncut.
        const { result, text } = await assistant.callWithinBudget<Record<string, Page & { entries: unknown[] }>>("list_shot_values", { limit: 50 });
        expect(result).not.toHaveProperty("cut");
        eachPagingFirst(text, lists);
        for (const list of lists) {
          expect(result[list]!.total, list).toBeGreaterThanOrEqual(55);
          expect(result[list]!.entries, list).toHaveLength(50);
        }
        // Each list alone, a page at a time, lists every value the REST API does; the Recipes and Baskets these Shots are
        // linked to as it lists them, a Location by its id and name.
        const rest = await api.get<Record<string, unknown[]>>("/shots/filters");
        for (const [list, restList] of Object.entries(SHOT_VALUES)) expect((await everyKind("list_shot_values", list, {})).count, list).toBe(rest[restList]!.length);
        type Named = { id: string; name: string | null; location?: LocationView | null } | null;
        expect(result.recipes!.entries).toEqual((rest.recipes as Named[]).slice(0, 50).map((recipe) => recipe && { ...recipe, location: recipe.location && { id: recipe.location.id, name: recipe.location.name } }));
        expect(result.baskets!.entries).toEqual(rest.baskets!.slice(0, 50));
        expect(result.recipes!.entries).toContainEqual({ id: made.recipes![0]!, name: "Harbor espresso 00", location: { id: harbor.id, name: "Harbor" } });
      });

      it("summarises those 55 Shots by two groupings, each Recipe's Reference Shot beside its group, 50 groups a page, as the REST API does, and every group on some page once", async () => {
        // Each of the 55 was pulled with a Recipe of its own and is linked to a Bean Batch of its own, so by both there
        // are 55 groups, each naming a Recipe with its Location and a Bean Batch with its Bean: the most a group names.
        // Each Recipe's Reference Shot is its own Shot, so each group gives one too (#473).
        for (const [n, id] of made.recipes!.entries()) await api.send("PUT", `/recipes/${id}/reference-shot`, { shotId: `copied-${String(n + 1).padStart(2, "0")}` });
        const day = { from: "2026-11-06", to: "2026-11-06" };
        const groupBy = ["recipe", "beanBatch"];
        const rest = (offset: number) => api.get<{ groups: SummaryGroup[]; total: number; offset: number }>(`/shots/summary?${new URLSearchParams({ ...day, groupBy: groupBy.join(), limit: "50", offset: String(offset) })}`);
        const first = await assistant.callWithinBudget<Page & { groups: SummaryGroup[] }>("summarise_shots", { ...day, groupBy, limit: 50 });
        pagingFirst(first.text, "groups");
        // About 740 characters a group, 110 of them its Reference Shot and 300 its ids, so 50 fit, uncut.
        expect(first.result).not.toHaveProperty("cut");
        expect(first.result).toEqual(toolSummary(await rest(0)));
        expect(first.result).toMatchObject({ total: 55, offset: 0, more: true });
        expect(first.result.groups).toHaveLength(50);
        // Each group's Reference Shot, with its own value of each of the default numbers, to hundredths.
        expect(first.result.groups.map((group) => group.reference)).toEqual(
          Array.from({ length: 50 }, (_, n) => ({ id: `copied-${String(n + 1).padStart(2, "0")}`, numbers: { yieldAgainstTarget: -0.1, duration: 23.55, stoppedOnWeight: true } })),
        );
        expect(first.result.groups[0]!.by).toEqual({
          recipe: { id: made.recipes![0]!, name: "Harbor espresso 00", location: { id: harbor.id, name: "Harbor" } },
          beanBatch: { id: made.beanBatches![0]!, bean: { id: made.beans![0]!, roaster: "Roux Bakehouse", name: "Ethiopia Guji Hambela lot 00" }, roastDate: "2026-10-28" },
        });
        const last = await assistant.callWithinBudget<Page & { groups: SummaryGroup[] }>("summarise_shots", { ...day, groupBy, limit: 50, offset: 50 });
        expect(last.result).toEqual(toolSummary(await rest(50)));
        expect(last.result).toMatchObject({ total: 55, offset: 50, more: false });
        expect(new Set([...first.result.groups, ...last.result.groups].map((group) => (group.by.recipe as { id: string }).id))).toEqual(new Set(made.recipes));
        // By what they recorded: 55 Baristas and 55 profile titles, 50 groups of them a page.
        const recorded = await assistant.callWithinBudget<Page & { groups: SummaryGroup[] }>("summarise_shots", { ...day, groupBy: ["barista", "profile"], limit: 50 });
        expect(recorded.result).toMatchObject({ total: 55, more: true, groups: expect.arrayContaining([expect.objectContaining({ by: { barista: "Barista 01", profile: "Blooming espresso 01" } })]) });
        expect(recorded.result.groups).toHaveLength(50);

        // Every number at once: about 1,500 characters a group, 300 of them its Reference Shot's, so a page of 50 ends
        // sooner, uncut, each page as the REST API gives those groups, and every group on some page once.
        const recipes: string[] = [];
        for (let offset = 0; ; ) {
          const { result, text } = await assistant.callWithinBudget<Page & { groups: SummaryGroup[] }>("summarise_shots", { ...day, groupBy, numbers: EVERY_NUMBER, limit: 50, offset });
          pagingFirst(text, "groups");
          expect(result).not.toHaveProperty("cut");
          // 29 of them the first page, and the other 26 the next.
          expect(result.groups.length).toBe(offset === 0 ? 29 : 26);
          const page = { ...day, groupBy: groupBy.join(), numbers: EVERY_NUMBER.join(), limit: String(result.groups.length), offset: String(offset) };
          expect(result.groups).toEqual(toolSummary(await api.get<{ groups: SummaryGroup[]; total: number; offset: number }>(`/shots/summary?${new URLSearchParams(page)}`)).groups);
          for (const group of result.groups) {
            expect(Object.keys(group.numbers)).toEqual(EVERY_NUMBER);
            expect(Object.keys(group.reference!.numbers)).toEqual(EVERY_NUMBER);
          }
          recipes.push(...result.groups.map((group) => (group.by.recipe as { id: string }).id));
          offset += result.groups.length;
          expect(result.more).toBe(offset < 55);
          if (!result.more) break;
        }
        expect([...recipes].sort()).toEqual([...made.recipes!].sort());
      });

      it("reads a Recipe with its history and its Reference Shot, a Profile, and a Bean with its batches", async () => {
        const shelf = (await api.machineNamed("Lab copies"))!;
        // Each Recipe's Reference Shot is the copied Shot pulled with it (#472).
        for (const [n, id] of made.recipes!.entries()) await api.send("PUT", `/recipes/${id}/reference-shot`, { shotId: `copied-${String(n + 1).padStart(2, "0")}` });
        const { result } = await assistant.callWithinBudget<{ recipe: { referenceShot: Fields }; history: Page & { entries: unknown[] } }>("get_library_item", {
          kind: "recipe",
          id: recipe,
          history: true,
          conflicts: true,
          limit: 50,
        });
        expect(result).not.toHaveProperty("cut");
        expect(result.history.total).toBeGreaterThanOrEqual(57);
        expect(result.recipe.referenceShot).toMatchObject({ id: "copied-01", machine: { name: "Lab copies" } });
        // find_shots names the Recipe each is the Reference Shot of. These rows, linked to every kind of item, fill a page
        // at 46 without it, so it ends sooner, at 42 measured, uncut.
        const rows = await assistant.callWithinBudget<Page & { shots: Fields[] }>("find_shots", { machineId: shelf.id, limit: 50 });
        expect(rows.result).not.toHaveProperty("cut");
        expect(rows.result).toMatchObject({ total: 55, more: true });
        expect(rows.result.shots.length).toBeGreaterThanOrEqual(40);
        for (const row of rows.result.shots) expect(row.referenceOf, row.id as string).toEqual([row.recipe]);
        const { profiles } = await api.get<{ profiles: { id: string; title: string }[] }>("/profiles");
        const adaptive = profiles.find((profile) => profile.title === "Adaptive v3")!;
        const profile = await assistant.callWithinBudget<Fields>("get_library_item", { kind: "profile", id: adaptive.id, history: true, conflicts: true, limit: 50 });
        expect(profile.result).not.toHaveProperty("cut");
        await assistant.callWithinBudget("get_library_item", { kind: "bean", id: made.beans![0]!, history: true, conflicts: true, limit: 50 });
      });

      it("lists 55 open Conflicts a page at a time", async () => {
        // A Bean's notes edited offline on a tablet, each losing to the management interface's: as list_conflicts finds
        // them, copied in PostgreSQL, one for each Bean.
        const database = await server.connectDatabase();
        try {
          await database.query(
            `INSERT INTO conflicts (id, kind, item_id, field, value, account_id, edited_at)
             SELECT gen_random_uuid(), 'bean', id::text, 'notes', to_jsonb('Peach and jasmine, a little brighter than last week.'::text),
               (SELECT id FROM accounts WHERE email = $2), transaction_timestamp() - interval '1 hour'
             FROM beans WHERE id = ANY($1::uuid[])`,
            [made.beans, admin.email],
          );
        } finally {
          await database.end();
        }
        const { ids } = await everyPage("list_conflicts", "conflicts", {});
        expect(ids.length).toBeGreaterThanOrEqual(55);
      });
    });
  });

  describe("on hostile data", () => {
    let haunted: CreatedMachine;
    let raw: RawConnection;

    beforeAll(async () => {
      haunted = await machineAt("Haunted", lab);
      raw = await connectionOf(haunted, "43102");
    });

    it("finds Shots whose names run far longer than any typed, each cut and marked, their ids whole, a page at a time", async () => {
      const extras = (shotFixture().workflow as { context: { extras: Fields } }).context.extras;
      await deliverShots(
        raw,
        Array.from({ length: 55 }, (_, n) =>
          shotAt(`haunted-${String(n).padStart(2, "0")}`, 200 + n, "43102", {
            context: {
              baristaName: hostile(3_000),
              coffeeRoaster: hostile(3_000),
              coffeeName: hostile(3_000),
              grinderModel: hostile(3_000),
              grinderSetting: hostile(3_000),
              extras: { ...extras, basketName: hostile(3_000) },
            },
            profile: { title: hostile(3_000) },
            annotations: { espressoNotes: hostile(60_000) },
          }),
        ),
      );
      const first = await assistant.callWithinBudget<Page & { cut?: string; shots: Fields[] }>("find_shots", { machineId: haunted.machine.id, limit: 50 });
      expect(Object.keys(first.result)[0]).toBe("cut");
      expect(first.result.cut).toContain("get_shot");
      expect(first.result.shots.map((shot) => shot.id)).toEqual(Array.from({ length: first.result.shots.length }, (_, n) => `haunted-${String(54 - n).padStart(2, "0")}`));
      for (const shot of first.result.shots) {
        type Row = { barista: string; profile: Fields; beanBatch: Fields; grinder: Fields; basket: Fields; notes: string; grinderSetting: string };
        const { barista, profile, beanBatch, grinder, basket, notes, grinderSetting } = shot as unknown as Row;
        // The names people type each cut to about 60 characters, and its notes to about 200.
        const names = [barista, profile.title, beanBatch.roaster, beanBatch.name, grinder.model, basket.name];
        expect(names.every((name) => cut(name) && (name as string).length <= 60 + CUT_MARK.length), shot.id as string).toBe(true);
        expect(cut(notes) && notes.length <= 200 + CUT_MARK.length).toBe(true);
        expect(cut(grinderSetting)).toBe(true);
      }
      const { ids } = await everyPage("find_shots", "shots", { machineId: haunted.machine.id });
      expect(ids).toEqual(await restIds("/shots", "shots", { machineId: haunted.machine.id }));
    });

    it("finds and reads Shots that are the Reference Shots of Recipes whose names run far longer than any typed, each name cut and marked, its id whole", async () => {
      // At Harbor, which has no tablets to write to: 55 Recipes named far longer than any typed, each the Reference Shot
      // of a Haunted Shot of its own.
      const recipes: string[] = [];
      for (let n = 0; n < 55; n++) {
        const { recipe } = await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: harbor.id, slot: null, content: { name: `${String(n).padStart(2, "0")} ${hostile(3_000)}` } }, 201);
        recipes.push(recipe.id);
        await api.send("PUT", `/recipes/${recipe.id}/reference-shot`, { shotId: `haunted-${String(n).padStart(2, "0")}` });
      }
      const { result } = await assistant.callWithinBudget<Page & { shots: Fields[] }>("find_shots", { machineId: haunted.machine.id, limit: 50 });
      for (const row of result.shots) {
        const [named] = row.referenceOf as { id: string; name: string }[];
        expect(named!.id).toBe(recipes[Number((row.id as string).slice(-2))]);
        expect(cut(named!.name) && named!.name.length <= 60 + CUT_MARK.length, row.id as string).toBe(true);
      }
      // Every one the Reference Shot of one Shot: get_shot gives the 55, their names cut to fit.
      for (const id of recipes) await api.send("PUT", `/recipes/${id}/reference-shot`, { shotId: "haunted-00" });
      const read = await assistant.callWithinBudget<{ cut?: string; referenceOf: { id: string; name: string }[] }>("get_shot", { id: "haunted-00" });
      expect(read.result.referenceOf.map((named) => named.id).sort()).toEqual([...recipes].sort());
      expect(read.result.cut).toBeDefined();
      expect(read.result.referenceOf.every((named) => cut(named.name))).toBe(true);
    });

    it("summarises Shots whose names run far longer than any typed in as few characters, as it gives none of their text", async () => {
      const { result, text } = await assistant.callWithinBudget<Fields>("summarise_shots", { machineId: haunted.machine.id });
      expect(result).toEqual(toolSummary(await api.get(`/shots/summary?machineId=${haunted.machine.id}`)));
      expect(result).toMatchObject({ groups: [{ counts: { shots: 55, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 } }] });
      expect(result).not.toHaveProperty("cut");
      expect(text.length).toBeLessThan(500);
    });

    it("lists what Shots recorded whose names run far longer than any typed, each cut and marked, a page of each list at a time", async () => {
      // 20 more, each recording a long Bean, Barista and profile title of its own.
      await deliverShots(
        raw,
        Array.from({ length: 20 }, (_, n) =>
          shotAt(`haunted-values-${String(n).padStart(2, "0")}`, 500 + n, "43102", {
            context: { baristaName: `${n} ${hostile(3_000)}`, coffeeRoaster: `${n} ${hostile(3_000)}`, coffeeName: `${n} ${hostile(3_000)}` },
            profile: { title: `${n} ${hostile(3_000)}` },
          }),
        ),
      );
      const lists = Object.keys(SHOT_VALUES);
      // With the realistic Shots' 55 of each list above, 50 of each run past the budget even with the long names cut,
      // so every list ends sooner, saying more follow.
      const { result, text } = await assistant.callWithinBudget<{ cut: string } & Record<string, Page & { entries: unknown[] }>>("list_shot_values", { limit: 50 });
      expect(Object.keys(result)[0]).toBe("cut");
      expect(result.cut).toContain("one list alone");
      eachPagingFirst(text, lists);
      for (const list of lists) {
        expect(result[list]!.entries.length, list).toBeLessThan(50);
        expect(result[list]!.more, list).toBe(true);
      }
      // Sorted first, from "0 Quote", each cut.
      const long = (value: unknown) => typeof value === "string" && value.includes("Quote");
      const beans = result.beans!.entries as { roaster: unknown; name: unknown }[];
      const named = { beans: beans.map((bean) => bean.name), baristas: result.baristas!.entries, profileTitles: result.profileTitles!.entries };
      for (const [list, names] of Object.entries(named)) {
        expect(long(names[0]), list).toBe(true);
        expect(names.filter(long).every(cut), list).toBe(true);
      }
      expect(beans.filter((bean) => long(bean.name)).every((bean) => cut(bean.roaster))).toBe(true);
      // Each list alone, a page at a time, lists every value the REST API does.
      const rest = await api.get<Record<string, unknown[]>>("/shots/filters");
      for (const [list, restList] of Object.entries(SHOT_VALUES)) expect((await everyKind("list_shot_values", list, {})).count, list).toBe(rest[restList]!.length);
    });

    it("reads a Shot with its notes cut and marked, and its steps, last recorded weight and curves whole", async () => {
      const { result } = await assistant.callWithinBudget<Fields & { cut: string }>("get_shot", { id: "haunted-00", curves: true });
      expect(result.cut).toContain("without curves");
      expect(cut(result.notes)).toBe(true);
      // Its steps, last weight and curves are those of a Shot with the same measurements and none of its text.
      await deliverShots(raw, [shotAt("plain", 300, "43102")]);
      const plain = await assistant.call<Fields>("get_shot", { id: "plain", curves: true });
      expect(result.curves).toEqual(plain.curves);
      expect(result.steps).toEqual(plain.steps);
      expect(result.lastRecordedWeight).toEqual(plain.lastRecordedWeight);
      expect([result.timeToFirstDrip, result.flowAtStop]).toEqual([plain.timeToFirstDrip, plain.flowAtStop]);
      expect(result.steps).not.toEqual([]);
    });

    it("reads a Shot whose Profile's step names run long with its steps whole, as a Profile's steps are", async () => {
      // Derived: the real Shot with a Preheat, its Profile's step names far longer than any typed, and its notes too.
      const fixture = preheatShotFixture();
      const profile = (fixture.workflow as { profile: { steps: Fields[] } }).profile;
      const steps = profile.steps.map((step, n) => ({ ...step, name: `${n} ${hostile(3_000)}` }));
      await deliverShots(raw, [shotAt("haunted-steps", 400, "43102", { profile: { steps }, annotations: { espressoNotes: hostile(60_000) } }, fixture)]);
      const { result } = await assistant.callWithinBudget<Fields & { steps: { frame: number; name: string }[] }>("get_shot", { id: "haunted-steps", curves: true });
      expect(cut(result.notes)).toBe(true);
      // The five it ran, Prefill, Compressing, Dripping, Pressurize and Extraction, each named whole, as trimmed.
      expect(result.steps.map((step) => step.frame)).toEqual([0, 2, 3, 4, 6]);
      expect(result.steps.map((step) => step.name)).toEqual([0, 2, 3, 4, 6].map((n) => steps[n]!.name.trim()));
      // Within its widest window, too long to fit even with its text cut, its curves are thinned as by default, and its text cut.
      const widest = await assistant.callWithinBudget<Fields & { curves: { thinnedTo: number } }>("get_shot", { id: "haunted-steps", curves: true, window: {} });
      expect(cut(widest.result.notes)).toBe(true);
      expect(widest.result.curves).toEqual(result.curves);
      expect(widest.result.curves.thinnedTo).toBe(100);
      expect(widest.result.steps).toEqual(result.steps);
      // Listed, the step a Shot ended in is named cut, as the names people type are, and the page says so first: of the
      // same Shot under another profile title, with nothing else long enough to cut.
      await deliverShots(raw, [shotAt("haunted-steps-alone", 401, "43102", { profile: { title: "Haunted steps", steps } }, fixture)]);
      const listed = await assistant.callWithinBudget<{ cut?: string; shots: Fields[] }>("find_shots", { machineId: haunted.machine.id, profileTitle: "Haunted steps", match: "exact" });
      expect(Object.keys(listed.result)[0]).toBe("cut");
      expect(listed.result.shots.map((shot) => shot.id)).toEqual(["haunted-steps-alone"]);
      const { lastStep, ...row } = listed.result.shots[0] as Fields & { lastStep: { frame: number; name: string } };
      expect(lastStep.frame).toBe(6);
      expect(cut(lastStep.name) && lastStep.name.startsWith("6 Quote") && lastStep.name.length <= 60 + CUT_MARK.length).toBe(true);
      expect(JSON.stringify(row)).not.toContain(CUT_MARK);
    });

    it("gives a Machine whose Workflow's text runs long with that text cut, summarised and whole, its Profile's steps and its settings whole", async () => {
      const workflow = derivedWorkflow({ coffeeName: hostile(20_000), baristaName: hostile(5_000) });
      const profile: Fields = { ...(workflow.profile as Fields), notes: hostile(60_000), title: hostile(5_000) };
      await raw.deliver({ type: "workflow", id: randomUUID(), observedAt: "2026-11-04T06:00:00.000Z", workflow: { ...workflow, profile, description: hostile(10_000) } });
      // A long string in its Tablet Settings, which are structured, and never cut.
      const appSettings = { ...(de1ProOnDecaid091()["/settings"] as Fields), webUiPath: hostile(15_000) };
      await raw.deliver({ type: "collection", id: randomUUID(), name: "appSettings", available: true, value: appSettings, utcOffsetMinutes: -360 });
      await expect.poll(async () => (await assistant.call<{ tabletSettings: { appSettings: unknown } }>("get_machine", { machineId: haunted.machine.id })).tabletSettings.appSettings).toBeTruthy();
      type Read = { cut: string; workflow: { workflow: Fields; raw: Fields }; tabletSettings: { appSettings: { value: unknown } } };
      const { result } = await assistant.callWithinBudget<Read>("get_machine", { machineId: haunted.machine.id, raw: true });
      expect(result.cut).toContain("management interface");
      const read = result.workflow.raw;
      expect([(read.profile as Fields).notes, (read.profile as Fields).title, (read.context as Fields).coffeeName, read.description].every(cut)).toBe(true);
      expect((read.profile as Fields).steps).toEqual(profile.steps);
      expect(result.tabletSettings.appSettings.value).toEqual(appSettings);
      // Its summary alone holds the same long names, the longest cut too.
      const summarised = await assistant.callWithinBudget<Read>("get_machine", { machineId: haunted.machine.id });
      expect(summarised.result.cut).toBeDefined();
      expect(cut(summarised.result.workflow.workflow.bean)).toBe(true);
      expect(summarised.result.tabletSettings.appSettings.value).toEqual(appSettings);
    });

    it("gives a Machine's activity whose Workflows' text runs long with that text cut, in the Workflow in effect and in what changed", async () => {
      for (const minute of [1, 2]) {
        await raw.deliver({
          type: "workflow",
          id: randomUUID(),
          observedAt: `2026-11-04T06:0${minute}:00.000Z`,
          // Each a change, by its dose.
          workflow: derivedWorkflow({ targetDoseWeight: 18 + minute, coffeeName: hostile(20_000), coffeeRoaster: hostile(20_000), baristaName: hostile(5_000) }),
        });
      }
      type Entry = { workflow?: Fields; changes?: { field: string; before: unknown; after: unknown }[] };
      const { result } = await assistant.callWithinBudget<{ cut: string; workflowChanges: Page & { entries: Entry[] } }>("get_machine_activity", {
        machineId: haunted.machine.id,
        from: "2026-11-04",
        to: "2026-11-04",
        limit: 50,
      });
      expect(result.cut).toContain("fewer at a time");
      expect(result.workflowChanges.total).toBe(3);
      // The Workflow in effect, the one above with its long name, whole, that name cut; then its title back to the
      // fixture's and a roaster as long, cut; then the dose alone.
      const [second, first, inEffect] = result.workflowChanges.entries as [Entry, Entry, Entry];
      expect(cut(inEffect.workflow!.bean)).toBe(true);
      const changed = Object.fromEntries(first.changes!.map((change) => [change.field, change]));
      expect(Object.keys(changed).sort()).toEqual(["dose", "profile", "roaster"]);
      expect([cut(changed.roaster!.before), cut(changed.roaster!.after)]).toEqual([false, true]);
      expect(second.changes).toEqual([{ field: "dose", before: 19, after: 20 }]);
    });

    it("gives a Machine's use whose states' names run far longer than any Decaid sends with each cut and marked, saying so, its counts and times whole, by hour and over 31 days", async () => {
      // Two states with such names, half an hour each, through 1 October 2026 in Chicago, 5 hours behind UTC, then
      // copied in PostgreSQL to each of the 30 days after it. Its days and hours aren't a page, so the guard can only
      // cut the names, to no shorter than 200 characters: four such states every day of a month would overrun, and
      // be logged, as a list within one item does (ADR-0028). Decaid sends the names of an enum, a word or two each.
      const states = [`haunting${hostile(20_000)}`, `rattling${hostile(20_000)}`];
      for (let n = 0; n < 48; n++) {
        await raw.deliver({ type: "machineState", id: randomUUID(), observedAt: new Date(Date.UTC(2026, 9, 1, 5, 30 * n)).toISOString(), state: states[n % 2], substate: "idle" });
      }
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO machine_state_events (machine_id, observed_at, state, substate)
           SELECT machine_id, observed_at + n * interval '24 hours', state, substate
           FROM machine_state_events, generate_series(1, 30) AS n WHERE machine_id = $1 ORDER BY n, id`,
          [haunted.machine.id],
        );
      } finally {
        await database.end();
      }
      for (const [args, buckets, seconds] of [
        [{ from: "2026-10-01", to: "2026-10-01", by: "hour" }, 24, 1_800],
        [{ from: "2026-10-01", to: "2026-10-31" }, 31, 43_200],
      ] as const) {
        const { result } = await assistant.callWithinBudget<Use & { cut: string }>("get_machine_use", { machineId: haunted.machine.id, ...args });
        expect(result.cut).toContain("shorter range");
        expect(result.buckets).toHaveLength(buckets);
        for (const bucket of result.buckets) {
          expect(bucket.states.map((state) => [state.state.slice(0, 8), cut(state.state), cut(state.name), state.seconds]), bucket.date).toEqual([
            ["haunting", true, true, seconds],
            ["rattling", true, true, seconds],
          ]);
        }
      }
    });

    it("lists Settings Edits whose Decaid message runs long with it cut, each value they set whole, a page at a time", async () => {
      // Refused by Decaid with a long answer, each setting a long value, as copied in PostgreSQL.
      const value = hostile(2_000);
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_edits (id, machine_id, session_id, tablet_id, collection, fields, expected, made_at, sent_at, answered_at, outcome, refusal, decaid_status, decaid_message)
           SELECT gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), 'appSettings', jsonb_build_object('webUiPath', $2::text), jsonb_build_object('webUiPath', 'streamline.js'),
             transaction_timestamp() - n * interval '1 minute', transaction_timestamp() - n * interval '1 minute', transaction_timestamp() - n * interval '1 minute',
             'REFUSED', 'DECAID', 400, $3
           FROM generate_series(1, 30) AS n`,
          [haunted.machine.id, value, hostile(5_000)],
        );
      } finally {
        await database.end();
      }
      const { ids, lengths } = await everyPage("list_settings_edits", "settingsEdits", { machineId: haunted.machine.id });
      expect(ids).toHaveLength(30);
      expect(lengths[0]).toBeLessThan(30);
      const { result } = await assistant.callWithinBudget<{ cut: string; settingsEdits: { fields: Fields; refusal: { message: unknown } }[] }>("list_settings_edits", { machineId: haunted.machine.id, limit: 50 });
      expect(result.cut).toBeDefined();
      for (const edit of result.settingsEdits) {
        expect(edit.fields).toEqual({ webUiPath: value });
        expect(cut(edit.refusal.message)).toBe(true);
      }
    });

    it("lists Settings History changes whose values run long a page at a time, each value and field whole, and gives settings as last received with theirs whole", async () => {
      // A Tablet Setting set to a long value, a different one each minute, and a plugin whose id runs long, as copied in PostgreSQL before the
      // Tablet Settings this Machine's tablet reported.
      const values = Array.from({ length: 31 }, (_, n) => ({ webUiPath: `${n} ${hostile(2_000)}` }));
      const id = hostile(1_000);
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_history (machine_id, name, value, received_at)
           SELECT $1, 'appSettings', value, '2026-11-01T06:00:00Z'::timestamptz + (n - 1) * interval '1 minute'
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS listed(value, n)`,
          [haunted.machine.id, JSON.stringify(values)],
        );
        await database.query(
          `INSERT INTO settings_history (machine_id, name, value, received_at) VALUES ($1, 'plugins', '[]', '2026-11-01T06:00:00Z'), ($1, 'plugins', $2::jsonb, '2026-11-01T06:01:00Z')`,
          [haunted.machine.id, JSON.stringify([{ id, version: "1.0.0" }])],
        );
      } finally {
        await database.end();
      }
      const { ids, lengths } = await everyPage("list_settings_history", "changes", { machineId: haunted.machine.id, collections: ["appSettings"] });
      // The 30 copied, and the change to the Tablet Settings its tablet reported.
      expect(ids).toHaveLength(31);
      expect(lengths[0]).toBeLessThan(31);
      type Changes = { changes: { fields: { field: string; before: unknown; after: unknown }[] }[] };
      const { result } = await assistant.callWithinBudget<Changes>("list_settings_history", { machineId: haunted.machine.id, collections: ["appSettings"], from: "2026-11-01", to: "2026-11-01", limit: 50 });
      // Newest first, the latest copied first.
      expect(result.changes.map(({ fields }) => fields)).toEqual(
        result.changes.map((_, n) => [{ field: "webUiPath", change: "changed", before: values[29 - n]!.webUiPath, after: values[30 - n]!.webUiPath, backAt: null }]),
      );
      const plugin = await assistant.callWithinBudget<Changes>("list_settings_history", { machineId: haunted.machine.id, collections: ["plugins"] });
      expect(plugin.result.changes[0]!.fields[0]!.field).toBe(id);
      const asOf = await assistant.callWithinBudget<{ tabletSettings: { appSettings: { value: unknown } } }>("get_machine", { machineId: haunted.machine.id, at: "2026-11-01T06:30:00Z" });
      expect(asOf.result.tabletSettings.appSettings.value).toEqual(values[30]);
    });

    it("gives what a Machine's tablet reports with its plugins' descriptions far longer than any written cut and marked, saying so, and the rest of each plugin as sent", async () => {
      const plugins: Fields[] = Array.from({ length: 8 }, (_, n) => ({ ...pluginListing(), id: `haunted-${n}.reaplugin`, version: `1.${n}.0`, description: hostile(8_000) }));
      await raw.deliver({ type: "collection", id: randomUUID(), name: "plugins", available: true, value: plugins });
      const { result } = await assistant.callWithinBudget<{ cut: string; plugins: { value: Fields[] } }>("get_machine_reports", { machineId: haunted.machine.id });
      expect(result.cut).toContain("Asked for one collection at a time");
      const listed = result.plugins.value;
      expect(listed.map(({ description: _, ...rest }) => rest)).toEqual(plugins.map(({ description: _, ...rest }) => rest));
      expect(listed.every(({ description }) => cut(description))).toBe(true);
    });

    it("finds Steam Records whose Barista runs long a page at a time, and reads one with its curves whole", async () => {
      const fixture = milkProbeSteamFixture();
      const workflow = fixture.workflow as Record<string, Fields>;
      const steam = (steamId: string) => derivedSteam(steamId, { workflow: { ...workflow, context: { ...workflow.context, baristaName: hostile(5_000) } } }, fixture);
      await Promise.all(
        Array.from({ length: 50 }, (_, n) => {
          const steamId = `haunted-steam-${String(n).padStart(2, "0")}`;
          return raw.deliver({ type: "steam", id: randomUUID(), steamId, steamedAt: new Date(Date.UTC(2026, 10, 4, 7, n)).toISOString(), steam: steam(steamId) });
        }),
      );
      const { ids, lengths } = await everyPage("find_steam_records", "steamRecords", { machineId: haunted.machine.id });
      expect(ids).toEqual(await restIds("/steam-records", "steamRecords", { machineId: haunted.machine.id }));
      expect(lengths[0]).toBe(50);
      const { result } = await assistant.callWithinBudget<{ cut: string; steamRecords: Fields[] }>("find_steam_records", { machineId: haunted.machine.id, limit: 50 });
      expect(result.cut).toContain("get_steam_record");
      expect(result.steamRecords.every((record) => cut(record.barista))).toBe(true);
      const read = await assistant.callWithinBudget<Fields>("get_steam_record", { id: "haunted-steam-00", curves: true });
      await raw.deliver({ type: "steam", id: randomUUID(), steamId: "plain-steam", steamedAt: "2026-11-04T09:00:00.000Z", steam: derivedSteam("plain-steam", {}, fixture) });
      expect(read.result.curves).toEqual((await assistant.call<Fields>("get_steam_record", { id: "plain-steam", curves: true })).curves);
    });

    it("lists Locations and Machines whose names are as long as they may be, and heavy with what JSON escapes", async () => {
      // A name has at most 100 characters (locations/input.ts, machines/input.ts).
      const longest = (prefix: string) => {
        const piece = Array.from(`${prefix} "quoted" \\ \u{1F600} `);
        let name = "";
        for (let n = 0; (name + piece[n % piece.length]!).length <= 100; n++) name += piece[n % piece.length]!;
        return name.trim();
      };
      const place = await api.createLocation(longest("Location"), "Europe/Lisbon");
      await api.createMachine(longest("Machine"), place.id);
      await assistant.callWithinBudget("list_locations");
      await assistant.callWithinBudget("list_machines");
    });

    it("lists Conflicts whose values run long with each value cut, and reads their Bean with them", async () => {
      const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: hostile(2_000), name: hostile(2_000), notes: hostile(30_000) } }, 201)).bean.id;
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO conflicts (id, kind, item_id, field, value, edited_at)
           SELECT gen_random_uuid(), 'bean', $1, 'notes', to_jsonb($2::text), transaction_timestamp() - n * interval '1 minute' FROM generate_series(1, 50) AS n`,
          [bean, hostile(5_000)],
        );
      } finally {
        await database.end();
      }
      const listed = await assistant.callWithinBudget<Page & { cut: string; conflicts: { value: unknown; item: { name: unknown } }[] }>("list_conflicts", { limit: 50 });
      expect(listed.result.cut).toBeDefined();
      const theirs = listed.result.conflicts.filter((conflict) => cut(conflict.value));
      expect(theirs.length).toBeGreaterThan(0);
      const read = await assistant.callWithinBudget<{ bean: { content: Fields; roaster: unknown }; conflicts: { entries: { value: unknown }[] } }>("get_library_item", {
        kind: "bean",
        id: bean,
        history: true,
        conflicts: true,
        limit: 50,
      });
      expect([read.result.bean.content.notes, read.result.bean.roaster].every(cut)).toBe(true);
      expect(read.result.conflicts.entries.length).toBeGreaterThan(0);

      // An assistant that edits the notes it read cut, adding to them, is refused, and the notes are kept whole.
      const changer = await Assistant.connect(server.url, app, await signIn(server.url, admin));
      try {
        const refused = await changer.client.callTool({ name: "edit_bean", arguments: { id: bean, notes: `${read.result.bean.content.notes as string} Nutty.` } });
        expect(refused.isError).toBe(true);
        expect((refused.content as { text: string }[])[0]!.text).toContain(`A value holds ${CUT_MARK}`);
      } finally {
        await changer.close();
      }
      expect((await api.get<{ bean: { content: Fields } }>(`/beans/${bean}`)).bean.content.notes).toBe(hostile(30_000));
    });

    it("summarises Shots by two groupings whose names run far longer than any typed, each name cut and marked, a page of groups at a time", async () => {
      // 60 Shots on a Machine of their own, each recording a long Bean, by roaster and name, and a long Barista of its own.
      const grouped = await machineAt("Haunted groups", lab);
      const connection = await connectionOf(grouped, "43105");
      await deliverShots(
        connection,
        Array.from({ length: 60 }, (_, n) =>
          shotAt(`haunted-group-${String(n).padStart(2, "0")}`, 600 + n, "43105", {
            context: { baristaName: `${String(n).padStart(2, "0")} ${hostile(3_000)}`, coffeeRoaster: `${String(n).padStart(2, "0")} ${hostile(3_000)}`, coffeeName: `${String(n).padStart(2, "0")} ${hostile(3_000)}` },
          }),
        ),
      );
      type Group = SummaryGroup & { by: { bean: { roaster: string; name: string }; barista: string } };
      const args = { machineId: grouped.machine.id, groupBy: ["bean", "barista"] };
      // 60 groups, each naming three names of 3,000 characters: 50 of them run past the budget even with each name cut
      // to 200, so the page ends sooner, saying more follow.
      const first = await assistant.callWithinBudget<Page & { cut: string; groups: Group[] }>("summarise_shots", { ...args, limit: 50 });
      expect(Object.keys(first.result)[0]).toBe("cut");
      expect(first.result.cut).toContain("fewer groups");
      pagingFirst(first.text, "groups");
      expect(first.result).toMatchObject({ total: 60, offset: 0, more: true });
      expect(first.result.groups.length).toBeLessThan(50);
      expect(first.result.groups.length).toBeGreaterThan(30);
      for (const group of first.result.groups) {
        expect([group.by.bean.roaster, group.by.bean.name, group.by.barista].every(cut), JSON.stringify(group.by).slice(0, 80)).toBe(true);
        expect(group.counts).toEqual({ shots: 1, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 });
      }
      // Every group on some page once, in order, the next page's offset the last's plus its length.
      const baristas: string[] = [];
      for (let offset = 0; ; ) {
        const { result } = await assistant.callWithinBudget<Page & { groups: Group[] }>("summarise_shots", { ...args, limit: 50, offset });
        expect(result.offset).toBe(offset);
        expect(result.groups.length).toBeGreaterThan(0);
        baristas.push(...result.groups.map((group) => group.by.barista.slice(0, 2)));
        offset += result.groups.length;
        expect(result.more).toBe(offset < result.total);
        if (!result.more) break;
      }
      expect(baristas).toEqual(Array.from({ length: 60 }, (_, n) => String(n).padStart(2, "0")));
      // Asked for one group at a time, it has the whole of each name. No filter takes a name this long: a text filter
      // holds 500 characters, so find_shots finds such a group's Shots by a few of its words.
      const one = await assistant.callWithinBudget<Page & { groups: Group[] }>("summarise_shots", { ...args, limit: 1 });
      expect(one.result).not.toHaveProperty("cut");
      // A Barista's name is given without the blanks around it.
      expect(one.result.groups[0]!.by).toEqual({ bean: { roaster: `00 ${hostile(3_000)}`, name: `00 ${hostile(3_000)}` }, barista: `00 ${hostile(3_000)}`.trim() });
      expect((await assistant.callWithinBudget<Page>("find_shots", { machineId: grouped.machine.id, barista: "00 Quote", limit: 1 })).result.total).toBe(1);
    });

    it("summarises every number by two groupings, where Shots ended in more steps than a group names, each named far longer than any typed", async () => {
      // 24 Shots on a Machine of their own, of one profile, its title and each of its twelve steps' names 3,000 characters
      // long, by two Baristas: each ended in a step of its own of the twelve, so each Barista's Shots ended in twelve, of
      // which a group names ten. Each recorded a grind setting of text as long, and a dose, rating, TDS and extraction yield.
      const numbered = await machineAt("Haunted numbers", lab);
      const connection = await connectionOf(numbered, "43106");
      const fixture = shotFixture();
      const profile = (fixture.workflow as Record<string, Fields>).profile!;
      const steps = Array.from({ length: 12 }, (_, frame) => ({ ...((profile.steps as Fields[])[frame % 7] as Fields), name: `${String(frame).padStart(2, "0")} ${hostile(3_000)}` }));
      await deliverShots(
        connection,
        Array.from({ length: 24 }, (_, n) => {
          const frame = n % 12;
          const shot = shotAt(
            `haunted-numbers-${String(n).padStart(2, "0")}`,
            700 + n,
            "43106",
            {
              context: { baristaName: n < 12 ? "Ann" : "Ben", grinderSetting: hostile(3_000) },
              profile: { title: hostile(3_000), steps },
              annotations: { actualDoseWeight: 18, enjoyment: 8, drinkTds: 9.5, drinkEy: 20 },
            },
            fixture,
          );
          return { ...shot, measurements: (fixture.measurements as Fields[]).map((sample, index) => (index === 0 ? sample : { ...sample, machine: { ...(sample.machine as Fields), profileFrame: frame } })) };
        }),
      );
      type Group = SummaryGroup & { by: { profile: string; barista: string }; numbers: { lastStep: { shots: number; mostCommon: { frame: number; name: string; shots: number }[] } } };
      const args = { machineId: numbered.machine.id, groupBy: ["profile", "barista"], numbers: EVERY_NUMBER, limit: 50 };
      // Two groups, each naming its profile and ten steps of 3,000 characters: cut to fit.
      const { result, text } = await assistant.callWithinBudget<Page & { cut: string; groups: Group[] }>("summarise_shots", args);
      expect(Object.keys(result)[0]).toBe("cut");
      pagingFirst(text, "groups");
      expect(result).toMatchObject({ total: 2, offset: 0, more: false });
      expect(result.groups.map((group) => group.by.barista)).toEqual(["Ann", "Ben"]);
      for (const group of result.groups) {
        expect(group.counts).toEqual({ shots: 12, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 });
        expect(Object.keys(group.numbers)).toEqual(EVERY_NUMBER);
        // A grind setting of text has no value; the rest are each Shot's.
        expect(group.numbers).toMatchObject({ grindSetting: { shots: 0, median: null }, rating: { shots: 12, median: 8, rated: 1 }, tds: { shots: 12, median: 9.5 }, ratio: { shots: 12, median: 1.99 } });
        // The ten steps of the twelve with the lowest frames, one Shot each, every name cut and marked.
        expect(group.numbers.lastStep.shots).toBe(12);
        expect(group.numbers.lastStep.mostCommon.map((step) => [step.frame, step.shots])).toEqual(Array.from({ length: 10 }, (_, frame) => [frame, 1]));
        expect(group.numbers.lastStep.mostCommon.every((step) => cut(step.name))).toBe(true);
        expect(cut(group.by.profile)).toBe(true);
      }
      // Asked for one group at a time, as the cut note says, it has the whole of more of them.
      const one = await assistant.callWithinBudget<Page & { groups: Group[] }>("summarise_shots", { ...args, limit: 1 });
      expect(one.result).toMatchObject({ total: 2, offset: 0, more: true });

      // Pulled with one Recipe loaded, whose Reference Shot is the first of them: by Recipe, each Barista's group gives
      // it too (#473), the name of the step it ended in cut and marked as the groups' are, and its numbers its own.
      const recipe = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: lab.id, content: { name: "Haunted house" } }, 201)).recipe.id;
      const database = await server.connectDatabase();
      try {
        await database.query("UPDATE shots SET recipe_id = $2 WHERE machine_id = $1", [numbered.machine.id, recipe]);
        await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at) VALUES ($1, $2, '2026-11-02T00:00:00Z')", [numbered.machine.id, recipe]);
      } finally {
        await database.end();
      }
      await api.send("PUT", `/recipes/${recipe}/reference-shot`, { shotId: "haunted-numbers-00" });
      const byRecipe = await assistant.callWithinBudget<Page & { cut: string; groups: Group[] }>("summarise_shots", { ...args, groupBy: ["recipe", "barista"] });
      expect(Object.keys(byRecipe.result)[0]).toBe("cut");
      expect(byRecipe.result.groups.map((group) => [(group.by.recipe as { id: string }).id, group.by.barista])).toEqual([[recipe, "Ann"], [recipe, "Ben"]]);
      for (const group of byRecipe.result.groups) {
        expect(group.reference!.id).toBe("haunted-numbers-00");
        expect(Object.keys(group.reference!.numbers)).toEqual(EVERY_NUMBER);
        // Its grind setting is text, so it has none; it ended in the first step.
        expect(group.reference!.numbers).toMatchObject({ grindSetting: null, rating: 8, tds: 9.5, ratio: 1.99, stoppedOnWeight: true, lastStep: { frame: 0 } });
        expect(cut((group.reference!.numbers.lastStep as { name: string }).name)).toBe(true);
      }
    });

    it("finds Beans whose names run long a page at a time, each name cut and marked", async () => {
      for (let n = 0; n < 20; n++) await api.send("POST", "/beans", { content: { roaster: hostile(2_000), name: `${hostile(2_000)} ${n}` } }, 201);
      const { ids } = await everyPage("find_library_items", "beans", { kind: "bean", name: "Quote backslash emoji" });
      expect(ids.length).toBeGreaterThanOrEqual(21);
      const { result } = await assistant.callWithinBudget<{ cut: string; beans: Fields[] }>("find_library_items", { kind: "bean", name: "Quote backslash emoji", limit: 50 });
      expect(result.cut).toContain("get_library_item");
      expect(result.beans.every((found) => cut(found.roaster) && cut(found.name))).toBe(true);
    });

    it("reads a Profile whose notes run long with them cut, its steps whole, and returns one too large to fit even so as it is, and logs it", async () => {
      // On a bench at a Location of its own, with no Library to take in first.
      const bench = await api.createMachine("Bench", (await api.createLocation("Bench", "UTC")).id);
      const tablet = tablets.syncing(bench, server, { api: emptyLibrary("43103") });
      await api.waitForOnline(bench);
      const idOf = async (title: string) => (await api.get<{ profiles: { id: string; title: string }[] }>("/profiles")).profiles.find((profile) => profile.title === title)?.id;
      const read = async (title: string) => {
        await expect.poll(() => idOf(title)).toBeTruthy();
        return assistant.client.callTool({ name: "get_library_item", arguments: { kind: "profile", id: await idOf(title), history: true } });
      };
      type ReadProfile = { cut?: string; profile: { content: { profile: { notes: unknown; steps: Fields[] } } }; history: { entries: { fields: { notes?: unknown } }[] } };
      const base = derivedProfile("Long notes", 8.5);

      // Its notes, inside its content as Decaid keeps them, and in its first version, the Profile joining the Library.
      await tablet.addProfile({ ...base, notes: hostile(60_000) });
      const noted = await read("Long notes");
      expect((noted.content as { text: string }[])[0]!.text.length).toBeLessThanOrEqual(RESPONSE_BUDGET);
      const { cut: note, profile, history } = noted.structuredContent as ReadProfile;
      expect(note).toContain("without its history");
      expect(cut(profile.content.profile.notes)).toBe(true);
      expect(cut(history.entries.at(-1)!.fields.notes)).toBe(true);
      const rest = (await api.get<{ profile: { content: { profile: { steps: Fields[] } } } }>(`/profiles/${encodeURIComponent((await idOf("Long notes"))!)}`)).profile;
      expect(profile.content.profile.steps).toEqual(rest.content.profile.steps);

      // Its steps alone, which are never cut, run past the budget.
      const steps = Array.from({ length: 300 }, (_, n) => ({ ...(base.steps as Fields[])[n % (base.steps as Fields[]).length], name: `step ${n}` }));
      await tablet.addProfile({ ...derivedProfile("Endless steps", 7.5), steps });
      const endless = await read("Endless steps");
      expect((endless.content as { text: string }[])[0]!.text.length).toBeGreaterThan(RESPONSE_BUDGET);
      expect((endless.structuredContent as ReadProfile).profile.content.profile.steps.map((step) => step.name)).toEqual(steps.map((step) => step.name));
      await expect.poll(() => server.output()).toContain("get_library_item's response is");
    });
  });
});
