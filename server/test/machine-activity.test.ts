import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, asTools, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { SimulatedDye2, recordedDye2MainTablet, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: a Machine's activity over a time range (#476), through the REST
// API, each read checked against what `get_machine_activity` gives an
// assistant for the same range. Workflow and Machine State changes are
// stored through simulated tablets running the built plugin, each made with
// the plugin's clock set to the time given, which the plugin observes it at
// within a few milliseconds; a third tablet, running DYE2 as recorded in
// fixtures/decaid/dye2-v0.1.26/, loads a Recipe and has its grind changed as
// the test runs. Hardware ids are made up.
//
// The Lab is in Denver, 7 hours behind UTC in February, and the Harbor in
// Tokyo, 9 hours ahead.

type Record_ = Record<string, unknown>;

interface Recipe {
  id: string;
  name: string | null;
}

/** An entry of a dial-in trail, as the REST API gives it: what doesn't apply to its kind null, or empty. */
interface TrailEntry {
  kind: "inEffect" | "loaded" | "unloaded" | "recipeUpdated" | "changed";
  observedAt: string;
  lastObservedAt: string | null;
  cause: string;
  pluginWrite: string | null;
  loadedRecipe: Recipe | null;
  replaced: Recipe | null;
  workflow: Record_ | null;
  changes: { field: string; before: unknown; after: unknown }[];
}

interface LoadedRecipe {
  id: string;
  recipe: Record_ & { id: string };
  loadedAt: string;
  unloadedAt: string | null;
}

interface StateEvent {
  id: string;
  state: string;
  substate: string;
  observedAt: string;
  receivedAt: string;
}

interface Listed<T> {
  entries: T[];
  total: number;
}

/** A Machine's activity, as the REST API's route gives it. */
interface Activity {
  workflowChanges?: Listed<TrailEntry>;
  loadedRecipes?: Listed<LoadedRecipe>;
  machineStates?: Listed<StateEvent>;
  limit: number;
  offset: number;
}

const LAB_SERIAL = "47601";
const MOVER_SERIAL = "47602";
const BAR_SERIAL = "47603";

/** The recording's tablet's record id of the Ethiopia's recipe. */
const ETHIOPIA = "1";

/** A change a tablet reports, and when its plugin observes it: a Machine State, or parts of the Workflow's context. */
type Change = readonly [at: string, state: string, substate: string] | readonly [at: string, context: Record_];

/**
 * The Lab's Machine, in the Lab's time, each with its time in UTC. On Monday
 * 9 February 2026 its dose is set to 17 g at 20:00 and it is put to sleep at
 * 22:00. On Tuesday the 10th it wakes at 06:20; its dose goes to 18 g at
 * 07:30; it pulls a Shot of 30 s at 08:00; its grind goes to 2.8 at 09:00
 * and to 2.6 two seconds later; and it is put to sleep at 23:30, which is
 * the 11th in UTC. On the 11th it wakes at 09:00, and its dose goes to
 * 18.5 g at 09:30.
 */
const LAB_DAYS: Change[] = [
  ["2026-02-10T03:00:00Z", { targetDoseWeight: 17 }],
  ["2026-02-10T05:00:00Z", "sleeping", "idle"],
  ["2026-02-10T13:20:00Z", "idle", "idle"],
  ["2026-02-10T14:30:00Z", { targetDoseWeight: 18 }],
  ["2026-02-10T15:00:00Z", "espresso", "preinfusion"],
  ["2026-02-10T15:00:10Z", "espresso", "pouring"],
  ["2026-02-10T15:00:30Z", "idle", "idle"],
  ["2026-02-10T16:00:00Z", { grinderSetting: "2.8" }],
  ["2026-02-10T16:00:02Z", { grinderSetting: "2.6" }],
  ["2026-02-11T06:30:00Z", "sleeping", "idle"],
  ["2026-02-11T16:00:00Z", "idle", "idle"],
  ["2026-02-11T16:30:00Z", { targetDoseWeight: 18.5 }],
];

/**
 * The Machine that moved. At the Lab on the 10th it wakes at 11:00, and its
 * dose is set to 16 g at 11:30. It leaves for the Harbor at 13:00, which is
 * 05:00 on the 11th there, where it flushes for 10 s at 06:00, its dose goes
 * to 19 g at 07:00, and it is put to sleep at 21:00.
 */
const MOVER_DAYS: Change[] = [
  ["2026-02-10T18:00:00Z", "idle", "idle"],
  ["2026-02-10T18:30:00Z", { targetDoseWeight: 16 }],
  ["2026-02-10T21:00:00Z", "flush", "pouring"],
  ["2026-02-10T21:00:10Z", "idle", "idle"],
  ["2026-02-10T22:00:00Z", { targetDoseWeight: 19 }],
  ["2026-02-11T12:00:00Z", "sleeping", "idle"],
];
const MOVED_AT = "2026-02-10T20:00:00Z";

function withoutId<T extends { id: string }>({ id: _, ...rest }: T): Omit<T, "id"> {
  return rest;
}

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** The value with each ISO 8601 time as its instant: the REST API gives times in UTC, the tool with the offset of the Location the Machine was at then. */
function instants(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "string" && ISO_TIME.test(field) ? Date.parse(field) : field));
}

/**
 * What the REST API gave, as `get_machine_activity` gives the same: each
 * list with its total, offset and whether more follow, a trail entry with
 * what applies to its kind alone, and a Loaded Recipe and a Machine State
 * without the ids the REST API's lists key them by.
 */
function asTool({ workflowChanges, loadedRecipes, machineStates, offset }: Activity): Record_ {
  const paged = <T, R>(list: Listed<T> | undefined, view: (entry: T) => R) =>
    list && { total: list.total, offset, more: offset + list.entries.length < list.total, entries: list.entries.map(view) };
  return asTools({
    workflowChanges: paged(workflowChanges, ({ lastObservedAt, replaced, workflow, changes, ...entry }) => ({
      ...entry,
      ...(lastObservedAt !== null && { lastObservedAt }),
      ...(replaced !== null && { replaced }),
      ...(workflow !== null ? { workflow } : { changes }),
    })),
    loadedRecipes: paged(loadedRecipes, withoutId),
    machineStates: paged(machineStates, withoutId),
  });
}

describe("a Machine's activity", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: LocationView;
  let harbor: LocationView;
  let lab1: CreatedMachine;
  let mover: CreatedMachine;
  let bar: CreatedMachine;
  /** The Recipe the bar loaded, and a moment before it did. */
  let ethiopia: string;
  let beforeLoad: string;
  const tablets = new LoadedTablets();

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env: { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    lab = await api.createLocation("Lab", "America/Denver");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
    lab1 = await api.createMachine("Lab 1");
    mover = await api.createMachine("Mover");
    bar = await api.createMachine("Lab bar");
    for (const machine of [lab1, mover, bar]) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: lab.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    await api.send("POST", `/machines/${mover.machine.id}/location-history`, { locationId: harbor.id, effectiveFrom: MOVED_AT }, 201);
  });
  afterAll(async () => {
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  it("has the Lab's Machine and the one that moved report their days, and the bar load a Recipe and have its grind changed", async () => {
    const labTablet = tablets.syncing(lab1, server, { api: emptyLibrary(LAB_SERIAL) });
    const moverTablet = tablets.syncing(mover, server, { api: emptyLibrary(MOVER_SERIAL) });
    const barTablet = tablets.syncing(bar, server, { api: recordedDye2MainTablet(BAR_SERIAL, "Activity"), dye2: new SimulatedDye2() });
    await api.waitForOnline(lab1, mover, bar);
    // Each has joined its Location, and nothing of that is left under way to be timed with what follows.
    await quiesced(api, { tablets: { labTablet, moverTablet, barTablet }, machines: { lab1, mover, bar } });
    await Promise.all([report(lab1, labTablet, LAB_DAYS), report(mover, moverTablet, MOVER_DAYS)]);

    // The bar, as the test runs: the Ethiopia's applied from DYE2's Select Recipe page, then its grind changed.
    beforeLoad = new Date().toISOString();
    // The load is observed to the millisecond, so not in the one the range starts at, which would have it in effect then.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await selectRecipeInDye2(barTablet, ETHIOPIA);
    const loaded = async () => (await api.get<{ machine: { loadedRecipe: LoadedRecipe | null } }>(`/machines/${bar.machine.id}`)).machine.loadedRecipe;
    await expect.poll(loaded, { timeout: 15_000 }).not.toBeNull();
    ethiopia = (await loaded())!.recipe.id;
    await quiesced(api, { tablets: { barTablet }, machines: { bar } });
    await barTablet.changeSettings({ context: { grinderSetting: "1.9" } });
    await quiesced(api, { tablets: { barTablet }, machines: { bar } });
  });

  /**
   * Has a Machine's tablet make each change with its plugin's clock set to
   * the change's time, one stored before the next is made, each observed
   * within a second after its time.
   */
  async function report(machine: CreatedMachine, tablet: SimulatedTablet, changes: readonly Change[]): Promise<void> {
    type Stored = { events: { observedAt: string }[]; total: number };
    const stored = (list: string) => api.get<Stored>(`/machines/${machine.machine.id}/${list}?limit=1`);
    for (const change of changes) {
      const list = change.length === 3 ? "machine-state-events" : "workflow-events";
      const before = (await stored(list)).total;
      tablet.setPluginClockOffset(Date.parse(change[0]) - Date.now());
      if (change.length === 3) tablet.reportState(change[1], change[2]);
      else await tablet.changeSettings({ context: change[1] });
      await expect.poll(async () => (await stored(list)).total, { timeout: 15_000 }).toBe(before + 1);
      const late = Date.parse((await stored(list)).events[0]!.observedAt) - Date.parse(change[0]);
      expect(late, change[0]).toBeGreaterThanOrEqual(0);
      expect(late, change[0]).toBeLessThan(1_000);
    }
    tablet.setPluginClockOffset(0);
  }

  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/activity`;

  /** A Machine's activity through the REST API, for a query given as its parts or whole. */
  const read = (machine: CreatedMachine, query: Record<string, string> | string = {}, as = api) => as.get<Activity>(`${path(machine)}?${new URLSearchParams(query)}`);

  /** The same through `get_machine_activity`. */
  const tool = (machine: CreatedMachine, args: Record_ = {}, through = assistant) => through.call<Record_>("get_machine_activity", { machineId: machine.machine.id, ...args });

  const refusal = async (path: string) => {
    const response = await api.call("GET", path);
    return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
  };

  /** Each Machine State of a read, latest first, as Decaid's state and substate with the time it was reported for. */
  const states = (activity: Activity) => activity.machineStates!.entries.map(({ state, substate, observedAt }) => [state, substate, observedAt.slice(0, 19)]);

  /** Each entry of a read's trail, latest first: its kind, what changed, as field, before and after, and the second it began in. */
  const trail = (activity: Activity) =>
    activity.workflowChanges!.entries.map(({ kind, changes, observedAt }) => [kind, changes.map(({ field, before, after }) => [field, before, after]), observedAt.slice(0, 19)]);

  it("gives a day's dial-in trail, Loaded Recipes and Machine States, each latest first, with how many there are: each change's before and after, who made it, and what was in effect as the day began", async () => {
    const day = await read(lab1, { from: "2026-02-10", to: "2026-02-10" });
    expect(day).toMatchObject({ limit: 20, offset: 0 });
    // The 10th at the Lab, which ends at 07:00 on the 11th in UTC: the night's sleep at 23:30 is in it, and the last
    // entry is the sleep it began in, from the evening before.
    expect(states(day)).toEqual([
      ["sleeping", "idle", "2026-02-11T06:30:00"],
      ["idle", "idle", "2026-02-10T15:00:30"],
      ["espresso", "pouring", "2026-02-10T15:00:10"],
      ["espresso", "preinfusion", "2026-02-10T15:00:00"],
      ["idle", "idle", "2026-02-10T13:20:00"],
      ["sleeping", "idle", "2026-02-10T05:00:00"],
    ]);
    expect(day.machineStates!.total).toBe(6);
    // The two grind steps 2 s apart as one change, from the grind before them to the last; and the Workflow in effect
    // as the day began, from the evening before, whole.
    const grind = (await api.get<{ events: { workflow: { context: Record_ } }[] }>(`/machines/${lab1.machine.id}/workflow-events?limit=100`)).events.at(-1)!.workflow.context.grinderSetting;
    expect(trail(day)).toEqual([
      ["changed", [["grindSetting", grind, "2.6"]], "2026-02-10T16:00:00"],
      ["changed", [["dose", 17, 18]], "2026-02-10T14:30:00"],
      ["inEffect", [], "2026-02-10T03:00:00"],
    ]);
    expect(day.workflowChanges!.total).toBe(3);
    const [dialled, dosed, inEffect] = day.workflowChanges!.entries as [TrailEntry, TrailEntry, TrailEntry];
    expect(dialled.lastObservedAt?.slice(0, 19)).toBe("2026-02-10T16:00:02");
    expect(inEffect.workflow).toMatchObject({ dose: 17, grindSetting: grind, recipe: null, recipeId: null });
    // Each made on the tablet, by anyone but Decent Sync, with no Recipe loaded; what doesn't apply to a kind is null.
    for (const entry of day.workflowChanges!.entries) expect(entry).toMatchObject({ cause: "other", pluginWrite: null, loadedRecipe: null, replaced: null });
    expect([dosed.lastObservedAt, dosed.workflow, dialled.workflow, inEffect.lastObservedAt]).toEqual([null, null, null, null]);
    // No Recipe was loaded on it.
    expect(day.loadedRecipes).toEqual({ entries: [], total: 0 });
  });

  it("gives what get_machine_activity gives for the same range, from the same service", async () => {
    const ranges: Record<string, string>[] = [
      { from: "2026-02-10", to: "2026-02-10" },
      { from: "2026-02-11" },
      { to: "2026-02-10" },
      { from: "2026-02-10T08:00:05-07:00", to: "2026-02-10T09:00:01-07:00" },
      {},
    ];
    for (const machine of [lab1, mover]) {
      for (const range of ranges) {
        const rest = await read(machine, range);
        expect(instants(await tool(machine, range)), JSON.stringify(range)).toEqual(instants(asTool(rest)));
        // Each list alone, as it is among the three.
        for (const kind of ["workflowChanges", "loadedRecipes", "machineStates"] as const) {
          const alone = await read(machine, { ...range, kind });
          expect(alone, kind).toEqual({ [kind]: rest[kind], limit: 20, offset: 0 });
          expect(instants(await tool(machine, { ...range, kinds: [kind] })), kind).toEqual(instants(asTool(alone)));
        }
      }
    }
    // The tool's times carry the offset of where the Machine was then, and the REST API's are UTC's.
    const moved = await tool(mover, { from: "2026-02-10", to: "2026-02-11", kinds: ["machineStates"] });
    expect((moved.machineStates as Listed<StateEvent>).entries.map((entry) => entry.observedAt.slice(0, 19) + entry.observedAt.slice(-6))).toEqual([
      "2026-02-11T21:00:00+09:00",
      "2026-02-11T06:00:10+09:00",
      "2026-02-11T06:00:00+09:00",
      "2026-02-10T11:00:00-07:00",
    ]);
  });

  it("gives a Recipe loaded and a grind changed after it, with the Recipe loaded then, as the tool does, and the Loaded Recipes as the paged route lists them", async () => {
    const rest = await read(bar, { from: beforeLoad });
    expect(instants(await tool(bar, { from: beforeLoad }))).toEqual(instants(asTool(rest)));
    const { name } = (await api.get<{ recipe: { content: { name: string } } }>(`/recipes/${ethiopia}`)).recipe.content;
    const recipe = { id: ethiopia, name };
    const entries = rest.workflowChanges!.entries;
    // Latest first: the grind, the load, and the Workflow in effect before it, which named no Recipe.
    expect(entries.map(({ kind, loadedRecipe }) => [kind, loadedRecipe])).toEqual([
      ["changed", recipe],
      ["loaded", recipe],
      ["inEffect", null],
    ]);
    const [dialled, loaded, inEffect] = entries as [TrailEntry, TrailEntry, TrailEntry];
    expect(dialled).toMatchObject({ cause: "other", pluginWrite: null, changes: [{ field: "grindSetting", after: "1.9" }] });
    expect(dialled.changes).toHaveLength(1);
    // The load names the Recipe, by the Library's name and id, where the Workflow before it named none.
    expect(loaded.changes).toEqual(expect.arrayContaining([{ field: "recipe", before: null, after: name }, { field: "recipeId", before: null, after: ethiopia }]));
    expect(loaded.replaced).toBeNull();
    expect(inEffect.workflow).toMatchObject({ recipe: null, recipeId: null });
    expect(Date.parse(inEffect.observedAt)).toBeLessThan(Date.parse(beforeLoad));

    const history = await api.get<Listed<LoadedRecipe>>(`/machines/${bar.machine.id}/loaded-recipes`);
    expect(rest.loadedRecipes).toEqual({ entries: history.entries, total: 1 });
    expect(rest.loadedRecipes!.entries[0]).toMatchObject({ recipe: { id: ethiopia, name }, loadedAt: loaded.observedAt, unloadedAt: null });
    // Up to a moment before the load, it had none loaded.
    expect((await read(bar, { to: beforeLoad, kind: "loadedRecipes" })).loadedRecipes).toEqual({ entries: [], total: 0 });
  });

  it("reads a date as that day at the Location the Machine was at, in its time zone, through its end for the range's end, and a time with its offset as that moment", async () => {
    const day = await read(lab1, { from: "2026-02-10", to: "2026-02-10" });
    // The same day as its two midnights in Denver, and as those moments in UTC.
    for (const range of [
      { from: "2026-02-10T00:00:00-07:00", to: "2026-02-11T00:00:00-07:00" },
      { from: "2026-02-10T07:00:00Z", to: "2026-02-11T07:00:00.000Z" },
    ]) {
      expect(await read(lab1, range), JSON.stringify(range)).toEqual(day);
    }
    // UTC's 10th would leave the night's sleep out, and have the evening before's as a change in it.
    expect(states(await read(lab1, { from: "2026-02-10T00:00:00Z", to: "2026-02-11T00:00:00Z", kind: "machineStates" })).map(([state]) => state)).toEqual([
      "idle",
      "espresso",
      "espresso",
      "idle",
      "sleeping",
    ]);
    // The 11th at the Lab begins asleep, since 23:30 the night before, with the dose and grind of the day before.
    const next = await read(lab1, { from: "2026-02-11", to: "2026-02-11" });
    expect(states(next)).toEqual([
      ["idle", "idle", "2026-02-11T16:00:00"],
      ["sleeping", "idle", "2026-02-11T06:30:00"],
    ]);
    expect(trail(next)).toEqual([
      ["changed", [["dose", 18, 18.5]], "2026-02-11T16:30:00"],
      ["inEffect", [], "2026-02-10T16:00:02"],
    ]);
    expect(next.workflowChanges!.entries[1]!.workflow).toMatchObject({ dose: 18, grindSetting: "2.6" });
    // A date and a time mix: the 10th until the Shot began.
    expect(states(await read(lab1, { from: "2026-02-10", to: "2026-02-10T08:00:00-07:00" })).map(([state]) => state)).toEqual(["idle", "sleeping"]);
    // Before anything was reported, nothing: no state was in effect, and no Workflow.
    expect(await read(lab1, { from: "2026-01-05", to: "2026-01-05" })).toEqual({
      workflowChanges: { entries: [], total: 0 },
      loadedRecipes: { entries: [], total: 0 },
      machineStates: { entries: [], total: 0 },
      limit: 20,
      offset: 0,
    });
  });

  it("reads each date by where the Machine was that day across a move to another time zone: the day it left by the Location it left, and the day it arrived by the one it came to", async () => {
    // The 10th began at the Lab, where the Machine was at noon UTC, and the 11th ends at the Harbor: from 07:00 on the
    // 10th to 15:00 on the 11th, in UTC.
    const both = await read(mover, { from: "2026-02-10", to: "2026-02-11" });
    expect(await read(mover, { from: "2026-02-10T07:00:00Z", to: "2026-02-11T15:00:00Z" })).toEqual(both);
    expect(states(both)).toEqual([
      ["sleeping", "idle", "2026-02-11T12:00:00"],
      ["idle", "idle", "2026-02-10T21:00:10"],
      ["flush", "pouring", "2026-02-10T21:00:00"],
      ["idle", "idle", "2026-02-10T18:00:00"],
    ]);
    // No Workflow was in effect as the range began, so the first in it is.
    expect(trail(both)).toEqual([
      ["changed", [["dose", 16, 19]], "2026-02-10T22:00:00"],
      ["inEffect", [], "2026-02-10T18:30:00"],
    ]);
    // The 10th alone is the Lab's, to 07:00 on the 11th in UTC, before the Harbor's evening.
    expect(states(await read(mover, { from: "2026-02-10", to: "2026-02-10" })).map(([state]) => state)).toEqual(["idle", "flush", "idle"]);
    // The 11th alone is the Harbor's, from 15:00 on the 10th in UTC, three hours before the Machine woke at the Lab.
    const arrived = await read(mover, { from: "2026-02-11", to: "2026-02-11" });
    expect(await read(mover, { from: "2026-02-11T00:00:00+09:00", to: "2026-02-12T00:00:00+09:00" })).toEqual(arrived);
    expect(states(arrived)).toEqual(states(both));
    // The 12th there begins asleep, with the dose it was left at.
    const after = await read(mover, { from: "2026-02-12", to: "2026-02-12" });
    expect([states(after), trail(after)]).toEqual([[["sleeping", "idle", "2026-02-11T12:00:00"]], [["inEffect", [], "2026-02-10T22:00:00"]]]);
  });

  it("pages each list by limit and offset, gives only the kinds asked for, and keeps the Workflow changes of one cause", async () => {
    const day = { from: "2026-02-10", to: "2026-02-10" };
    const all = await read(lab1, day);
    const first = await read(lab1, { ...day, limit: "2" });
    expect(first).toEqual({
      workflowChanges: { entries: all.workflowChanges!.entries.slice(0, 2), total: 3 },
      loadedRecipes: { entries: [], total: 0 },
      machineStates: { entries: all.machineStates!.entries.slice(0, 2), total: 6 },
      limit: 2,
      offset: 0,
    });
    const second = await read(lab1, { ...day, limit: "2", offset: "2" });
    expect([second.workflowChanges!.entries, second.machineStates!.entries, second.offset]).toEqual([all.workflowChanges!.entries.slice(2), all.machineStates!.entries.slice(2, 4), 2]);
    expect(await read(lab1, { ...day, limit: "2", offset: "6", kind: "machineStates" })).toEqual({ machineStates: { entries: [], total: 6 }, limit: 2, offset: 6 });
    // Two kinds, given by naming kind twice.
    const two = await read(lab1, "from=2026-02-10&to=2026-02-10&kind=machineStates&kind=loadedRecipes");
    expect(two).toEqual({ loadedRecipes: all.loadedRecipes, machineStates: all.machineStates, limit: 20, offset: 0 });

    // Every change here was made on the tablet; the Workflow in effect is given whoever made it.
    expect((await read(lab1, { ...day, cause: "other" })).workflowChanges).toEqual(all.workflowChanges);
    const plugin = await read(lab1, { ...day, cause: "plugin" });
    expect([plugin.workflowChanges!.entries.map((entry) => entry.kind), plugin.workflowChanges!.total]).toEqual([["inEffect"], 1]);
    expect(plugin.machineStates).toEqual(all.machineStates);
    expect(instants(await tool(lab1, { ...day, cause: "plugin", limit: 2, offset: 0 }))).toEqual(instants(asTool(await read(lab1, { ...day, cause: "plugin", limit: "2" }))));
  });

  it("refuses a range it can't read, one that ends at or before its start, and a kind, cause or page it doesn't know, and a Machine that doesn't exist", async () => {
    const entered = (name: string) => `Enter ${name} as a date, such as 2026-11-06, or a time with its offset, such as 2026-11-06T14:30:00-05:00`;
    const at = path(lab1);
    expect(await refusal(`${at}?from=2026-02-30`)).toEqual({ status: 400, message: [entered("from")] });
    // A time needs its offset.
    expect(await refusal(`${at}?to=2026-02-10T08:00:00`)).toEqual({ status: 400, message: [entered("to")] });
    expect(await refusal(`${at}?from=2026-02-10&from=2026-02-11&kind=shots&kind=machineStates&cause=barista`)).toEqual({
      status: 400,
      message: ["Give from once", "Choose each kind from workflowChanges, loadedRecipes, machineStates", "Choose cause as plugin, other, unknown"],
    });
    for (const range of ["from=2026-02-11&to=2026-02-10", "from=2026-02-10T08:00:00Z&to=2026-02-10T08:00:00Z"]) {
      expect(await refusal(`${at}?${range}`), range).toEqual({ status: 400, message: "Choose an end after the start" });
    }
    for (const range of ["from=0000-06-01", "to=9999-12-31T23:30:00-01:00"]) {
      expect(await refusal(`${at}?${range}`), range).toEqual({ status: 400, message: "Times must be in the years 1 to 9999, in UTC" });
    }
    for (const page of ["limit=101", "limit=0", "offset=-1", "limit=2&limit=3"]) {
      expect(await refusal(`${at}?${page}`), page).toEqual({ status: 400, message: expect.stringMatching(/^Pagination must be a whole number between /) });
    }
    expect(await refusal("/machines/lab-1/activity")).toMatchObject({ status: 404 });
    expect(await refusal("/machines/00000000-0000-7000-8000-000000000000/activity")).toEqual({ status: 404, message: "No such Machine" });
  });

  it("is read by Staff, at whatever Location, and by Viewers, as an Admin reads it, never signed out", async () => {
    const staff = await api.staffAt("sam@example.com", harbor);
    const { link } = await api.invite("val@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Val Viewer", password: "val's password" }));
    for (const reader of [staff, viewer]) {
      for (const [machine, range] of [
        [lab1, { from: "2026-02-10", to: "2026-02-10" }],
        [mover, { from: "2026-02-10", to: "2026-02-11" }],
        [bar, { from: beforeLoad }],
      ] as const) {
        expect(await read(machine, range, reader)).toEqual(await read(machine, range));
      }
    }
    expect((await api.call("GET", path(lab1), undefined, {})).status).toBe(401);
  });
});
