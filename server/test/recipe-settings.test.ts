import { RECIPE_SETTINGS, RECIPE_SETTING_NAMES, type RecipeSetting, dye2GlobalIdOf, workflowValueAt } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, openDye2RecipeEditor, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #173 and #216: a Recipe holds any of the eleven steam,
// hot water and flush settings, in DYE2's own recipe fields, and a Machine
// follows them while it has the Recipe loaded (ADR-0022). A load writes each
// the Recipe holds into the Workflow, and leaves the rest as the Machine had
// them; a change on a Machine that DYE2 saves into the recipe, at the
// plugin's call after each change, is the Recipe's edit, written into every
// other Machine with it loaded, a steam time of 0 included, which Streamline
// reads as no timer; and steam on and off stays each Machine's own: steam
// turned off is no edit, no steam temperature is written into a Workflow
// whose steam is off, and Streamline turns steam back on at the steam
// temperature of the recipe the Workflow names, with nothing of Streamline's
// set (ADR-0021). With no Recipe loaded, a change of them stays on its
// Machine (#190). Through the built plugin in simulated tablets
// running DYE2 v0.1.26 and Streamline at cec5664 as recorded
// (fixtures/decaid/dye2-v0.1.26/), Machine A, and B in the tests that use
// it, on one server instance and C on another sharing one database, with
// assertions through the REST API and what each simulated tablet holds.
// Serials are made up, from 49001.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record ids: its library recipe, in slot 1, and the Brazil's, in slot 2. */
const LIBRARY = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";
const BRAZIL = "2";

/** What the library recipe's Recipe holds of the settings: all but the milk stop, hot water flow and flush flow, each Machine's own. */
const HELD = {
  steamTemperature: 150,
  steamDuration: 30,
  steamFlow: 1.5,
  hotWaterTemperature: 85,
  hotWaterDuration: 35,
  hotWaterVolume: 120,
  flushTemperature: 92,
  flushDuration: 8,
} satisfies Partial<Record<RecipeSetting, number>>;

describe("A Recipe's steam, hot water and flush settings", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const records = (tablet: SimulatedTablet) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []);
  /** The tablet's recipe with that record id. */
  const record = (tablet: SimulatedTablet, id: string) => records(tablet).find((entry) => entry.id === id);
  const variables = (entry: Record_ | undefined) => (entry?.dashboardVariables ?? {}) as Record_;
  /** Each setting the tablet's Workflow holds, by its name. */
  const settingsOf = (tablet: SimulatedTablet) => Object.fromEntries(RECIPE_SETTING_NAMES.map((setting) => [setting, workflowValueAt(tablet.workflow(), RECIPE_SETTINGS[setting].workflow)]));
  /** One setting the tablet's Workflow holds. */
  const setting = (tablet: SimulatedTablet, name: RecipeSetting) => workflowValueAt(tablet.workflow(), RECIPE_SETTINGS[name].workflow);
  /** One setting the tablet's record of the library recipe holds. */
  const recorded = (tablet: SimulatedTablet, name: RecipeSetting) => variables(record(tablet, LIBRARY))[RECIPE_SETTINGS[name].dye2];
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: { fields: Record_ }[] }>(`/recipes/${id}/history`)).versions;
  /** How many of the Recipe's versions set the field. */
  const editsOf = async (id: string, field: string) => (await versions(id)).filter((version) => field in version.fields).length;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  /** The latest Workflow the server stored for the Machine. */
  const latestWorkflow = async ({ machine }: CreatedMachine) =>
    (await api.get<{ events: { workflow: Record_ }[] }>(`/machines/${machine.id}/workflow-events?limit=1`)).events[0]?.workflow;
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** The writes of the Workflow the server sent the tablet's plugin from `from` on. */
  const workflowWritesTo = (tablet: SimulatedTablet, from: number) =>
    (tablet.received.slice(from).filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "loadedRecipe") as { fields: Record_ }[]).map(
      ({ fields }) => fields,
    );
  /**
   * Whether the tablet has answered a write of a Loaded Recipe into its Workflow the server sent from `from` on, setting
   * that setting, by refusing it or writing that setting, and the server has acknowledged the answer.
   */
  const settledWrite = (tablet: SimulatedTablet, from: number, name: RecipeSetting) => {
    const field = RECIPE_SETTINGS[name].workflow;
    const writes = (tablet.received.slice(from) as Record_[]).filter((frame) => frame.type === "write" && frame.kind === "loadedRecipe" && field in ((frame.fields ?? {}) as Record_));
    return writes.some((write) =>
      tablet.acknowledgedSome(
        (frame: Record_) => frame.id === write.id && (frame.type === "writeRefused" || (frame.type === "written" && ((frame.writtenFields ?? []) as unknown[]).includes(field))),
      ),
    );
  };
  /**
   * A second between two events timed by different clocks, as `docs/AI_BUILD_NOTES.md` (Seam 1) asks: the tablet times
   * what it reports by the host's clock, and the server times an edit by PostgreSQL's, which drift apart.
   */
  const apart = () => new Promise((resolve) => setTimeout(resolve, 1_000));

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, and,
   * with `b`, B on one instance, and C on the other, both tablets where DYE2
   * was never used, each running DYE2 with its machine connected. A brings
   * its recipes, and the library recipe's Recipe is given HELD's settings
   * before B and C join, so every tablet's record holds them. The library
   * recipe is applied on DYE2's dashboard on A and C (unless `loadC` is
   * false), and the Brazil's on B, which each loads, in that order. It
   * returns once every tablet and the server have nothing left to do
   * (`quiet()`), so the baselines a test reads next start from rest.
   * `quiet()` resolves once every tablet and Machine of the lab, and the
   * Streamlines given, have nothing left under way (`quiesced`), so a wrong
   * write a step set off has landed before a check after it that it did
   * not happen.
   */
  async function lab<WithB extends boolean = false>(scenario: string, serial: number, options: { loadC?: boolean; b?: WithB } = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      b: options.b ? await api.createMachine(`${scenario} lab B`, here.id) : undefined,
      c: await api.createMachine(`${scenario} lab C`, here.id),
    };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: new SimulatedDye2() });
    await api.waitForOnline(machines.a);
    await expect.poll(() => [LIBRARY, BRAZIL].map((id) => dye2GlobalIdOf(record(a, id))), { timeout: 15_000 }).not.toContain(null);
    const one = dye2GlobalIdOf(record(a, LIBRARY))!;
    const two = dye2GlobalIdOf(record(a, BRAZIL))!;
    await patch(one, HELD);
    await expect.poll(() => recorded(a, "hotWaterDuration"), { timeout: 15_000 }).toBe(HELD.hotWaterDuration);
    const b = machines.b ? syncingTablet(machines.b, server, { api: dye2NeverUsed(String(serial + 1)), dye2: new SimulatedDye2() }) : undefined;
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 2)), dye2: new SimulatedDye2() });
    await api.waitForOnline(...(machines.b ? [machines.b] : []), machines.c);
    for (const tablet of b ? [b, c] : [c]) {
      await expect
        .poll(() => [LIBRARY, BRAZIL].map((id) => [dye2GlobalIdOf(record(tablet, id)), record(tablet, id)?.beanBatchId ?? null]).flat(), { timeout: 15_000 })
        .not.toContain(null);
      await expect.poll(() => recorded(tablet, "flushTemperature")).toBe(HELD.flushTemperature);
    }
    // Decaid writes the steam, hot water and flush settings to the machine, and refuses them without one.
    for (const tablet of b ? [a, b, c] : [a, c]) tablet.connectMachine();
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, id: string, recipeId: string) => {
      expect((await (await openDye2Dashboard(tablet)).applyRecipe(id)).workflow?.status).toBe(200);
      await expect.poll(() => recipeNamedInWorkflow(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
    };
    await load(a, machines.a, LIBRARY, one);
    if (options.loadC !== false) await load(c, machines.c, LIBRARY, one);
    if (b && machines.b) await load(b, machines.b, BRAZIL, two);
    const tablets: Record<string, SimulatedTablet> = b ? { a, b, c } : { a, c };
    const followed: Record<string, CreatedMachine> = machines.b ? { a: machines.a, b: machines.b, c: machines.c } : { a: machines.a, c: machines.c };
    const quiet = (streamlines: Record<string, SimulatedStreamline> = {}) => quiesced(api, { tablets, machines: followed, streamlines });
    await quiet();
    return {
      here,
      machines: machines as typeof machines & { b: WithB extends true ? CreatedMachine : undefined },
      a,
      b: b as WithB extends true ? SimulatedTablet : undefined,
      c,
      one,
      two,
      load,
      quiet,
    };
  }

  it("loads every setting a Recipe holds into the Workflow, applied by Streamline's strip, leaving each it holds none of as the Machine had it, and writes them into each record and its embedded Workflow", async () => {
    const { machines, c, one } = await lab("Loaded", 49001, { loadC: false });
    // C's own milk stop, hot water flow and flush flow, which the Recipe holds none of.
    await c.changeSettings({ steamSettings: { stopAtTemperature: 55 }, hotWaterData: { flow: 9 }, rinseData: { flow: 5 } });
    // Streamline's strip applies only the values of the recipe's modes (decentespresso/streamline-js#154): the plugin's load
    // writes the rest.
    const streamline = await startStreamline(c);
    expect((await streamline.applyRecipe(1)).selection?.status).toBe(200);
    await loads(machines.c, one);
    await expect.poll(() => settingsOf(c), { timeout: 15_000 }).toEqual({ ...HELD, steamStopTemperature: 55, hotWaterFlow: 9, flushFlow: 5 });

    // Each record holds the settings the Recipe holds in DYE2's fields, blank where it holds none, and none of its own field.
    const held = record(c, LIBRARY)!;
    expect(held).not.toHaveProperty("decentSyncRecipe");
    expect(Object.fromEntries(RECIPE_SETTING_NAMES.map((name) => [name, recorded(c, name) ?? null]))).toEqual({
      ...HELD,
      steamStopTemperature: null,
      hotWaterFlow: null,
      flushFlow: null,
    });
    // Its embedded Workflow carries each it holds, as DYE2's record builder does, and none it does not.
    expect(held.workflow).toMatchObject({
      steamSettings: { targetTemperature: 150, duration: 30, flow: 1.5 },
      hotWaterData: { targetTemperature: 85, duration: 35, volume: 120 },
      rinseData: { targetTemperature: 92, duration: 8 },
    });
    const embedded = held.workflow as Record<string, Record_>;
    expect([embedded.steamSettings, embedded.hotWaterData, embedded.rinseData].map((part) => Object.keys(part ?? {}).sort())).toEqual([
      ["duration", "flow", "targetTemperature"],
      ["duration", "targetTemperature", "volume"],
      ["duration", "targetTemperature"],
    ]);
    expect(JSON.stringify(records(c))).not.toContain("decentSyncRecipe");
  });

  it("takes a steam time change on A that DYE2 saves as the Recipe's, writing it into C's Workflow and record, but not A's or B's, which has another Recipe loaded", async () => {
    const { a, b, c, one, quiet } = await lab("Steamed", 49011, { b: true });
    const ownOnB = setting(b, "steamDuration");
    const edits = await editsOf(one, "steamDuration");
    const received = a.received.length;
    await a.changeSettings({ steamSettings: { duration: 27 } });
    await expect.poll(async () => (await recipe(one)).content.steamDuration, { timeout: 15_000 }).toBe(27);
    await expect.poll(() => [setting(c, "steamDuration"), recorded(c, "steamDuration")], { timeout: 15_000 }).toEqual([27, 27]);
    expect(await editsOf(one, "steamDuration")).toBe(edits + 1);
    // Once A's report of the steam time, DYE2's save of it and the writes into C are done.
    await quiet();
    expect(setting(b, "steamDuration")).toBe(ownOnB);
    // A's record, which DYE2 saved the steam time into, embedding it as the server derives it, is not written again, nor its
    // Workflow.
    const recipeWrites = a.received.slice(received).filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "recipe");
    expect(recipeWrites).toEqual([]);
    expect(workflowWritesTo(a, received)).toEqual([]);
  });

  it("takes a held flush time changed 10, 6 and 10 on C as the Recipe's each time, writing nothing back", async () => {
    const { a, c, one, quiet } = await lab("Purge", 49021);
    const received = c.received.length;
    const edits = await editsOf(one, "flushDuration");
    for (const duration of [10, 6, 10]) {
      await c.changeSettings({ rinseData: { duration } });
      await expect.poll(async () => (await recipe(one)).content.flushDuration, { timeout: 15_000 }).toBe(duration);
      await expect.poll(() => setting(a, "flushDuration"), { timeout: 15_000 }).toBe(duration);
      // The check after the loop, not this one, rules out a write back.
      await expect.poll(() => [setting(c, "flushDuration"), recorded(c, "flushDuration")], { timeout: 15_000 }).toEqual([duration, duration]);
    }
    // Once C's report of the last flush time, DYE2's save of it and the write into A are done.
    await quiet();
    // One edit of each, from C, C's Workflow and record left at the last, and nothing written into C's Workflow of the flush.
    expect([setting(c, "flushDuration"), recorded(c, "flushDuration")]).toEqual([10, 10]);
    expect(await editsOf(one, "flushDuration")).toBe(edits + 3);
    expect(workflowWritesTo(c, received).filter((fields) => "rinseData.duration" in fields)).toEqual([]);
  });

  it("takes no steam turned off on A as an edit, by a steam temperature of 0 or below 135 °C or Streamline's heater switch, and writes no steam temperature into A's Workflow", async () => {
    const { a, c, one, quiet } = await lab("Off", 49031);
    const steamEdits = { temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") };
    const off = (temperature: number) => expect.poll(() => setting(a, "steamTemperature"), { timeout: 15_000 }).toBe(temperature);

    await a.changeSettings({ steamSettings: { targetTemperature: 0 } });
    // Once A's report of steam off has been taken in, and any write it made the server due.
    await quiet();
    await off(0);
    // DYE2 saves nothing of steam while it is off (decentespresso/dye2#30).
    expect(recorded(a, "steamTemperature")).toBe(150);
    await a.changeSettings({ steamSettings: { targetTemperature: 120 } });
    // Once A's report of steam at 120 °C has been taken in, and any write it made the server due.
    await quiet();
    await off(120);
    expect(recorded(a, "steamTemperature")).toBe(150);
    await a.changeSettings({ steamSettings: { targetTemperature: 150 } });
    // Once A's report of steam back on at the Recipe's has been taken in.
    await quiet();

    // Streamline's heater switch turns steam off with a temperature of 0, and back on at the Recipe's.
    const streamline = await startStreamline(a);
    await streamline.setSteamHeater(false);
    // Once A's report of the heater off, and Streamline's reply, are done.
    await quiet({ streamline });
    await off(0);
    expect(setting(a, "steamDuration")).toBe(30);
    await streamline.setSteamHeater(true);
    await off(150);
    // Once A's report of the heater on, and Streamline's reply, are done.
    await quiet({ streamline });

    expect((await recipe(one)).content).toMatchObject({ steamTemperature: 150, steamDuration: 30 });
    expect({ temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") }).toEqual(steamEdits);
    // C kept steaming.
    expect(settingsOf(c)).toMatchObject({ steamTemperature: 150, steamDuration: 30 });
  });

  it("takes a steam time of 0 set on A as the Recipe's, which Streamline reads as no timer, writing it into C's with its steam left on", async () => {
    const { a, c, one, quiet } = await lab("Zero", 49121);
    const edits = await editsOf(one, "steamDuration");
    const streamline = await startStreamline(a);
    // A steam time of 0 leaves the heater alone (streamline-js bc487aa).
    await streamline.set("last-steam-duration", 0);
    expect(setting(a, "steamTemperature")).toBe(150);
    await expect.poll(async () => (await recipe(one)).content.steamDuration, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => [setting(c, "steamDuration"), recorded(c, "steamDuration")], { timeout: 15_000 }).toEqual([0, 0]);
    expect(setting(c, "steamTemperature")).toBe(150);
    expect(await editsOf(one, "steamDuration")).toBe(edits + 1);
    // Once A's report of the steam time, the writes into C and Streamline's reply are done.
    await quiet({ streamline });
    expect([setting(a, "steamDuration"), setting(a, "steamTemperature")]).toEqual([0, 150]);
  });

  it("writes a steam time edited on A into C's Workflow while C's steam is off, without turning it on, where it survives C's next change", async () => {
    const { a, c, one, quiet } = await lab("Kept off", 49041);
    await c.changeSettings({ steamSettings: { targetTemperature: 0 } });
    // Once C's report of steam off has been taken in.
    await quiet();
    await a.changeSettings({ steamSettings: { duration: 22 } });
    await expect.poll(async () => (await recipe(one)).content.steamDuration, { timeout: 15_000 }).toBe(22);
    await expect.poll(() => setting(c, "steamDuration"), { timeout: 15_000 }).toBe(22);
    expect(setting(c, "steamTemperature")).toBe(0);
    // C's next change, which DYE2 saves with steam still off.
    await c.changeSettings({ hotWaterData: { volume: 130 } });
    await expect.poll(async () => (await recipe(one)).content.hotWaterVolume, { timeout: 15_000 }).toBe(130);
    // Once C's report of the hot water volume, DYE2's save of it and the write into A are done.
    await quiet();
    expect([setting(c, "steamDuration"), setting(c, "steamTemperature")]).toEqual([22, 0]);
    expect((await recipe(one)).content).toMatchObject({ steamDuration: 22, steamTemperature: 150 });
  });

  it("has Streamline turn C's steam back on at a steam temperature edited while it was off, the named recipe's rather than the one Streamline remembers, which the plugin leaves alone", async () => {
    const { machines, a, c, one, load, quiet } = await lab("Remembered", 49051, { loadC: false });
    const streamline = await startStreamline(c, { "last-steam-temp": 140 });
    await load(c, machines.c, LIBRARY, one);
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(150);
    // Once C's load is done.
    await quiet({ streamline });
    expect(streamline.remembered("last-steam-temp")).toBe(140);

    // C's barista turns the heater off in Streamline, which keeps the temperature it was at, and the Recipe's steam
    // temperature is edited meanwhile.
    await streamline.setSteamHeater(false);
    // Once C's report of the heater off, and Streamline's reply, are done; then a second, as the edit after it is timed by
    // the server's clock.
    await quiet({ streamline });
    await apart();
    expect([setting(c, "steamTemperature"), streamline.remembered("last-steam-temp")]).toEqual([0, 150]);
    await patch(one, { steamTemperature: 155 });
    await expect.poll(() => setting(a, "steamTemperature"), { timeout: 15_000 }).toBe(155);
    await expect.poll(() => recorded(c, "steamTemperature"), { timeout: 15_000 }).toBe(155);
    // Once the Loaded Recipe write into C is done.
    await quiet({ streamline });
    expect([setting(c, "steamTemperature"), streamline.remembered("last-steam-temp")]).toEqual([0, 150]);
    const edits = await editsOf(one, "steamTemperature");

    // Turned back on in Streamline, at the Recipe's, which C's record holds: no edit.
    await streamline.setSteamHeater(true);
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(155);
    // Once C's report of the heater on, and Streamline's reply, are done.
    await quiet({ streamline });
    expect((await recipe(one)).content.steamTemperature).toBe(155);
    expect(await editsOf(one, "steamTemperature")).toBe(edits);
  });

  it("has Streamline turn C's steam back on at an edit made while C was offline with steam off, which DYE2 saves nothing of", async () => {
    const { machines, a, c, one, load, quiet } = await lab("Missed", 49111, { loadC: false });
    const streamline = await startStreamline(c, { "last-steam-temp": 140 });
    await load(c, machines.c, LIBRARY, one);
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(150);
    // Once C's load is done.
    await quiet({ streamline });
    await streamline.setSteamHeater(false);
    // Once C's report of the heater off, and Streamline's reply, are done.
    await quiet({ streamline });

    // Offline, C's next change is saved into its record with steam still off, and the Recipe's steam temperature is edited
    // meanwhile.
    c.loseNetwork();
    await c.changeSettings({ hotWaterData: { volume: 130 } });
    await expect.poll(() => recorded(c, "hotWaterVolume"), { timeout: 15_000 }).toBe(130);
    expect(recorded(c, "steamTemperature")).toBe(150);
    // A second after C's heater off and offline change, timed by the tablet's clock, as the edit is timed by the server's.
    await apart();
    await patch(one, { steamTemperature: 160 });
    await expect.poll(() => setting(a, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    c.restoreNetwork();
    await expect.poll(() => recorded(c, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    await expect.poll(async () => (await recipe(one)).content.hotWaterVolume, { timeout: 15_000 }).toBe(130);
    // Once C's reports and the Loaded Recipe write into C are done.
    await quiet({ streamline });
    expect([setting(c, "steamTemperature"), streamline.remembered("last-steam-temp")]).toEqual([0, 150]);
    const edits = await editsOf(one, "steamTemperature");

    // Turned back on in Streamline, at the Recipe's, which C's record holds, not the 150 it remembers: no edit.
    await streamline.setSteamHeater(true);
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    // Once C's report of the heater on, and Streamline's reply, are done.
    await quiet({ streamline });
    expect([(await recipe(one)).content.steamTemperature, await editsOf(one, "steamTemperature")]).toEqual([160, edits]);
  });

  it("writes a hot water setting edited while C's machine is away once it is back, never saving C's old one into the Recipe", async () => {
    const { a, c, one, quiet } = await lab("Unplugged", 49131);
    const dose = (tablet: SimulatedTablet) => workflowValueAt(tablet.workflow(), "context.targetDoseWeight");
    // Decaid refuses the hot water settings with no machine, and takes the rest of the write.
    c.machineConnected = false;
    const received = c.received.length;
    await patch(one, { dose: 19.3, hotWaterDuration: 41 });
    await expect.poll(() => [dose(c), recorded(c, "hotWaterDuration")], { timeout: 15_000 }).toEqual([19.3, 41]);
    // C's own wait: the server writes the edit, C takes it without the hot water time, then the server writes the hot water
    // time alone, which C refuses with no machine. Once that refusal is acknowledged C's Machine has nothing waiting, and
    // quiet covers the rest of what the edit set off.
    await expect.poll(() => settledWrite(c, received, "hotWaterDuration"), { timeout: 15_000 }).toBe(true);
    await quiet();
    expect(setting(c, "hotWaterDuration")).toBe(HELD.hotWaterDuration);

    // Once the machine is back, the hot water time is written, and C's next change, which DYE2 saves, keeps it.
    c.connectMachine();
    await expect.poll(() => setting(c, "hotWaterDuration"), { timeout: 15_000 }).toBe(41);
    await c.changeSettings({ context: { grinderSetting: "3.4" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.4);
    // Once C's report of the grind, DYE2's save of it and the write into A are done.
    await quiet();
    expect([(await recipe(one)).content.hotWaterDuration, setting(a, "hotWaterDuration"), setting(c, "hotWaterDuration")]).toEqual([41, 41, 41]);
  });

  it("takes a steam temperature of Off saved in DYE2's editor as no edit, writing the Recipe's back into the record", async () => {
    const { a, c, one, quiet } = await lab("Editor", 49061);
    const edits = await editsOf(one, "steamTemperature");
    // DYE2's editor on A saves the fields changed over a fresh read (decentespresso/dye2#28), the steam temperature by its
    // Off preset, and applies the recipe again, steam off with it, which is A's own.
    const saved = await (await openDye2RecipeEditor(a, { id: LIBRARY })).set({ steamTempC: 0, flushS: 9 }).save();
    expect(saved.patch.dashboardVariables).toEqual({ steamTempC: 0, flushS: 9 });
    // Its flush time is an edit, written into C's Workflow; its steam off is not.
    await expect.poll(async () => (await recipe(one)).content.flushDuration, { timeout: 15_000 }).toBe(9);
    await expect.poll(() => recorded(a, "steamTemperature"), { timeout: 15_000 }).toBe(150);
    await expect.poll(() => setting(c, "flushDuration"), { timeout: 15_000 }).toBe(9);
    // Once A's report of the editor's apply, DYE2's save and the writes into C are done.
    await quiet();
    expect([(await recipe(one)).content.steamTemperature, await editsOf(one, "steamTemperature")]).toEqual([150, edits]);
    expect([setting(c, "steamTemperature"), recorded(c, "steamTemperature")]).toEqual([150, 150]);
  });

  it("brings a Machine that applied an out-of-date copy of the Recipe to its current settings, which the copy never sets back", async () => {
    const { machines, c, one, quiet } = await lab("Stale", 49071, { loadC: false });
    // C's record is written nothing while it is offline: it applies the copy it holds.
    c.loseNetwork();
    await patch(one, { steamDuration: 40, hotWaterVolume: 140, flushDuration: 6 });
    expect((await (await openDye2Dashboard(c)).applyRecipe(LIBRARY)).workflow?.status).toBe(200);
    expect([setting(c, "steamDuration"), setting(c, "hotWaterVolume"), setting(c, "flushDuration")]).toEqual([30, 120, 8]);
    c.restoreNetwork();
    await loads(machines.c, one);
    await expect.poll(() => settingsOf(c), { timeout: 15_000 }).toMatchObject({ ...HELD, steamDuration: 40, hotWaterVolume: 140, flushDuration: 6 });
    // C's own wait: the server's write of the edit into C's record, the copy it applied, has landed, and with it anything
    // else C's return set off.
    await expect.poll(() => [recorded(c, "steamDuration"), recorded(c, "hotWaterVolume"), recorded(c, "flushDuration")], { timeout: 15_000 }).toEqual([40, 140, 6]);
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ steamDuration: 40, hotWaterVolume: 140, flushDuration: 6 });
  });

  it("takes a setting the Recipe holds none of as its own once DYE2 saves a change of it, and writes it into C's Workflow", async () => {
    const { a, c, one } = await lab("Adopted", 49081);
    expect((await recipe(one)).content).not.toHaveProperty("hotWaterFlow");
    const ownOnC = setting(c, "hotWaterFlow");
    await a.changeSettings({ hotWaterData: { flow: 4.5 } });
    await expect.poll(async () => (await recipe(one)).content.hotWaterFlow, { timeout: 15_000 }).toBe(4.5);
    expect(ownOnC).not.toBe(4.5);
    await expect.poll(() => [setting(c, "hotWaterFlow"), recorded(c, "hotWaterFlow")], { timeout: 15_000 }).toEqual([4.5, 4.5]);
  });

  it("takes a steam mode switched in DYE2's editor into the Recipe and every tablet's record, writing nothing into any Workflow", async () => {
    const { a, b, c, one, quiet } = await lab("Mode", 49091, { b: true });
    const received = { a: a.received.length, b: b.received.length, c: c.received.length };
    expect(variables(record(c, LIBRARY)).steamMode).toBe("flow");
    const saved = await (await openDye2RecipeEditor(a, { id: LIBRARY })).set({ steam: { mode: "time" } }).save();
    expect(saved.patch.dashboardVariables).toEqual({ steamMode: "time" });
    await expect.poll(async () => (await recipe(one)).content.steamMode, { timeout: 15_000 }).toBe("time");
    for (const tablet of [b, c]) await expect.poll(() => variables(record(tablet, LIBRARY)).steamMode, { timeout: 15_000 }).toBe("time");
    // Once A's report of the editor's save and the tablets' reports of their records are done.
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ steamDuration: HELD.steamDuration, steamFlow: HELD.steamFlow });
    for (const [tablet, from] of [
      [a, received.a],
      [b, received.b],
      [c, received.c],
    ] as const) {
      expect(workflowWritesTo(tablet, from)).toEqual([]);
    }
  });

  it("changes nothing on the server but the Machine's events for a steam, hot water or flush change with no Recipe loaded", async () => {
    const { machines, a, b, c, one, two, quiet } = await lab("Unloaded", 49101, { b: true });
    // A's recipe cleared, as Streamline's strip switched off clears it: A has no Recipe loaded.
    expect((await a.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, {})).status).toBe(200);
    await loads(machines.a, null);
    const before = { one: await recipe(one), two: await recipe(two), versions: [(await versions(one)).length, (await versions(two)).length] };
    const elsewhere = { b: settingsOf(b), c: settingsOf(c) };
    await a.changeSettings({ steamSettings: { duration: 44, targetTemperature: 145 }, hotWaterData: { volume: 90 }, rinseData: { duration: 3 } });
    await expect.poll(async () => (await latestWorkflow(machines.a))?.rinseData, { timeout: 15_000 }).toMatchObject({ duration: 3 });
    // Once A's report of the change, and anything it set off, are done.
    await quiet();
    expect({ one: await recipe(one), two: await recipe(two), versions: [(await versions(one)).length, (await versions(two)).length] }).toEqual(before);
    expect({ b: settingsOf(b), c: settingsOf(c) }).toEqual(elsewhere);
    expect(settingsOf(a)).toMatchObject({ steamDuration: 44, steamTemperature: 145, hotWaterVolume: 90, flushDuration: 3 });
  });

  it("maps none of the Location settings endpoints, which answer 404 (#190)", async () => {
    const here = await api.createLocation("Gone lab", "America/Chicago");
    const machines = { a: await api.createMachine("Gone lab A", here.id) };
    const routes = [...server.output().matchAll(/Mapped \{(\/\S+), (\w+)\} route/g)].map(([, path, method]) => `${method} ${path}`);
    const gone = [
      ["GET", `/locations/${here.id}/settings`, "GET /api/locations/:id/settings"],
      ["PATCH", `/location-settings/${here.id}`, "PATCH /api/location-settings/:id"],
      ["PUT", `/machines/${machines.a.machine.id}/settings-sharing`, "PUT /api/machines/:id/settings-sharing"],
      ["GET", `/location-settings/${here.id}/history`, "GET /api/location-settings/:id/history"],
      ["GET", `/location-settings/${here.id}/conflicts`, "GET /api/location-settings/:id/conflicts"],
    ] as const;
    for (const [method, path, route] of gone) {
      expect(routes).not.toContain(route);
      expect((await api.call(method, path, method === "GET" ? undefined : {})).status, route).toBe(404);
    }
  });
});
