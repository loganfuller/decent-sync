import { RECIPE_SETTINGS, type RecipeSetting, dye2GlobalIdOf, workflowValueAt } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeNamedInWorkflow, syncingTablet, workflowCauses } from "./support/loaded-tablets.js";
import { SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, openDye2RecipeEditor, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #374 and #394: turning steam back on takes the Loaded
// Recipe's steam temperature and steam time, as turning it off is no edit
// (ADR-0022, Steam on and off). Steam turned back on at another temperature
// or time, by each way Streamline v0.2.23 has of doing so that does not take
// the Recipe's, ends with the Machine's Workflow at the Recipe's steam
// temperature and time, and those it came back with saved nowhere: not into
// the tablet's record, the Recipe or another Machine. Other changes in the
// same Workflow change are saved as usual, and a steam temperature changed
// once steam is on is the Recipe's edit, as before; steam turned off and
// back on while a write of the plugin's is under way is turned back on too,
// and one DYE2's editor saves, turning steam back on while a save of the
// plugin's is reading the Workflow, is the Recipe's edit.
// Through the built plugin in simulated tablets running DYE2 v0.1.35 and
// Streamline v0.2.23 as recorded (fixtures/decaid/dye2-v0.1.26/ and
// fixtures/decaid/streamline-v0.2.23/), Machine A on one server instance and
// C, where Streamline turns steam on, on another sharing one database, with
// assertions through the REST API and what each simulated tablet holds.
// Serials are made up, from 49201.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record id of its library recipe, in slot 1. */
const LIBRARY = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";

/** The steam settings the library recipe's Recipe is given: a steam temperature and time other than any Streamline turns steam on with here. */
const STEAM = { steamTemperature: 160, steamDuration: 40, steamFlow: 1.5 } satisfies Partial<Record<RecipeSetting, number>>;

describe("Steam turned back on takes the Loaded Recipe's steam temperature and steam time", { timeout: 120_000 }, () => {
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
  const record = (tablet: SimulatedTablet) => records(tablet).find((entry) => entry.id === LIBRARY);
  /** One setting the tablet's Workflow holds. */
  const setting = (tablet: SimulatedTablet, name: RecipeSetting) => workflowValueAt(tablet.workflow(), RECIPE_SETTINGS[name].workflow);
  /** One setting the tablet's record of the library recipe holds. */
  const recorded = (tablet: SimulatedTablet, name: RecipeSetting) => ((record(tablet)?.dashboardVariables ?? {}) as Record_)[RECIPE_SETTINGS[name].dye2];
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  /** How many of the Recipe's versions set the field. */
  const editsOf = async (id: string, field: string) =>
    (await api.get<{ versions: { fields: Record_ }[] }>(`/recipes/${id}/history`)).versions.filter((version) => field in version.fields).length;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /**
   * A second between two events timed by different clocks, as `docs/AI_BUILD_NOTES.md` (Seam 1) asks: the tablet times
   * what it reports by the host's clock, and the server times an edit by PostgreSQL's, which drift apart.
   */
  const apart = () => new Promise((resolve) => setTimeout(resolve, 1_000));

  /**
   * From now on, each steam temperature and steam time C's DYE2 saved into a
   * record, and each A's and C's Workflows changed to: so a check after a
   * step sees one saved, or written into A, even where it was written over
   * again before the check.
   */
  function watchSteam(dye2: SimulatedDye2, tablets: { a: SimulatedTablet; c: SimulatedTablet }) {
    const saves = dye2.recorded.length;
    const watched = (name: RecipeSetting) => {
      const taken = { a: [] as unknown[], c: [] as unknown[] };
      for (const tablet of ["a", "c"] as const) {
        let last = setting(tablets[tablet], name);
        tablets[tablet].onWorkflowChange((workflow) => {
          const value = workflowValueAt(workflow, RECIPE_SETTINGS[name].workflow);
          if (value !== last) taken[tablet].push(value);
          last = value;
        });
      }
      return taken;
    };
    const savedOf = (field: string) => () => dye2.recorded.slice(saves).flatMap(({ patch }) => (field in patch ? [patch[field]] : []));
    return {
      /** Each steam temperature C's DYE2 saved since. */
      saved: savedOf(RECIPE_SETTINGS.steamTemperature.dye2),
      /** Each steam time C's DYE2 saved since. */
      savedTimes: savedOf(RECIPE_SETTINGS.steamDuration.dye2),
      /** Each steam temperature the tablet's Workflow changed to since. */
      taken: watched("steamTemperature"),
      /** Each steam time the tablet's Workflow changed to since. */
      times: watched("steamDuration"),
    };
  }

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, on
   * one instance, and C, a tablet where DYE2 was never used, on the other,
   * each running DYE2 with its machine connected. A brings its recipes, and
   * the library recipe's Recipe is given STEAM before C joins, so both
   * records hold it. It is applied on DYE2's dashboard on A, and on C unless
   * `loadC` is false, which each loads. It returns once both tablets and the
   * server have nothing left to do (`quiet()`); `quiet()` resolves once both
   * tablets and Machines, and the Streamlines given, have nothing left under
   * way (`quiesced`), so a wrong write a step set off has landed before a
   * check after it that it did not happen.
   */
  async function lab(scenario: string, serial: number, options: { loadC?: boolean } = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = { a: await api.createMachine(`${scenario} lab A`, here.id), c: await api.createMachine(`${scenario} lab C`, here.id) };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: new SimulatedDye2() });
    await api.waitForOnline(machines.a);
    await expect.poll(() => dye2GlobalIdOf(record(a)), { timeout: 15_000 }).not.toBeNull();
    const one = dye2GlobalIdOf(record(a))!;
    await patch(one, STEAM);
    await expect.poll(() => recorded(a, "steamTemperature"), { timeout: 15_000 }).toBe(STEAM.steamTemperature);
    const dye2 = new SimulatedDye2();
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 1)), dye2 });
    await api.waitForOnline(machines.c);
    await expect.poll(() => [dye2GlobalIdOf(record(c)), record(c)?.beanBatchId ?? null, recorded(c, "steamTemperature") ?? null], { timeout: 15_000 }).not.toContain(null);
    // Decaid writes the steam settings to the machine, and refuses them without one.
    for (const tablet of [a, c]) tablet.connectMachine();
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine) => {
      expect((await (await openDye2Dashboard(tablet)).applyRecipe(LIBRARY)).workflow?.status).toBe(200);
      await expect.poll(() => recipeNamedInWorkflow(tablet), { timeout: 15_000 }).toBe(one);
      await expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(one);
    };
    await load(a, machines.a);
    if (options.loadC !== false) await load(c, machines.c);
    const quiet = (streamlines: Record<string, SimulatedStreamline> = {}) => quiesced(api, { tablets: { a, c }, machines, streamlines });
    await quiet();
    return { machines, a, c, one, dye2, load, quiet };
  }

  it("has Streamline's heater switch, with its DYE2 switch off, turn C's steam back on at the Recipe's steam temperature and time, edited while it was off, not the ones Streamline remembers, which are saved nowhere", async () => {
    const { machines, a, c, one, dye2, load, quiet } = await lab("Maintenance", 49201, { loadC: false });
    // Streamline's own DYE2 switch off, as it is by default: its heater switch reads no selection, and the Recipe applied on
    // DYE2's dashboard stays loaded.
    const streamline = await startStreamline(c, { "last-steam-temp": 140 }, { dye2Enabled: false });
    await load(c, machines.c);
    await expect.poll(() => [setting(c, "steamTemperature"), setting(c, "steamDuration")], { timeout: 15_000 }).toEqual([160, 40]);
    // Once C's load is done.
    await quiet({ streamline });

    // C's barista turns the heater off in Streamline, which writes a steam time of 0 with a temperature of 0, keeping both
    // as they were, and the Recipe's steam temperature and time are edited meanwhile.
    await streamline.setSteamHeater(false);
    // Once C's report of the heater off, and Streamline's reply, are done; then a second, as the edit after it is timed by
    // the server's clock.
    await quiet({ streamline });
    await apart();
    await patch(one, { steamTemperature: 155, steamDuration: 45 });
    await expect.poll(() => [setting(a, "steamTemperature"), setting(a, "steamDuration")], { timeout: 15_000 }).toEqual([155, 45]);
    await expect.poll(() => [recorded(c, "steamTemperature"), recorded(c, "steamDuration")], { timeout: 15_000 }).toEqual([155, 45]);
    // Once the Loaded Recipe write into C is done; then a second, as C's change after it is timed by the tablet's clock.
    await quiet({ streamline });
    await apart();
    // Neither written into C's Workflow while its steam is off. Streamline took the shot-settings frame's steam time of 0
    // as one set elsewhere and kept it (`resyncIfDrifted`, which v0.2.23 runs whatever the heater).
    expect([setting(c, "steamTemperature"), setting(c, "steamDuration")]).toEqual([0, 0]);
    expect([streamline.remembered("last-steam-temp"), streamline.remembered("last-steam-duration")]).toEqual([160, 0]);
    const edits = { temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") };
    const watch = watchSteam(dye2, { a, c });
    const causes = (await workflowCauses(api, machines.c)).length;

    // Turned back on in Streamline, at the 160 °C and the shortest time it takes from the 0 it kept: C takes the Recipe's
    // 155 °C and 45 s instead.
    await streamline.setSteamHeater(true);
    await expect.poll(() => [setting(c, "steamTemperature"), setting(c, "steamDuration")], { timeout: 15_000 }).toEqual([155, 45]);
    // Once C's report of the heater on, the plugin's write, its save and Streamline's reply are done.
    await quiet({ streamline });
    // One change, the plugin's (#434): Streamline's turning steam back on is held back while the plugin writes the Recipe's
    // steam temperature and time, and released with that write.
    expect((await workflowCauses(api, machines.c)).slice(causes)).toEqual(["plugin:steamOn"]);
    expect([watch.taken.c, watch.times.c]).toEqual([
      [160, 155],
      [1, 45],
    ]);
    const content = (await recipe(one)).content;
    expect([content.steamTemperature, content.steamDuration]).toEqual([155, 45]);
    expect({ temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") }).toEqual(edits);
    expect([watch.saved(), watch.savedTimes(), watch.taken.a, watch.times.a]).toEqual([[], [], [], []]);
    expect([setting(a, "steamTemperature"), setting(a, "steamDuration"), recorded(c, "steamTemperature"), recorded(c, "steamDuration")]).toEqual([155, 45, 155, 45]);
  });

  it("has Streamline's Settings › Calibration › Steam switch turn C's steam back on at the Recipe's steam temperature and time, not 150 °C and 30 s, even with another temperature picked in the same Save, which a later Save makes the Recipe's", async () => {
    const { a, c, one, dye2, quiet } = await lab("Calibration", 49211);
    let streamline = await startStreamline(c);
    // C's steam turned off on Decaid's own screen, its steam time left: the settings page holds no temperature of its own to
    // turn it back on at, and takes the Workflow's time.
    await c.changeSettings({ steamSettings: { targetTemperature: 0 } });
    // Once C's report of steam off, and Streamline's reply, are done.
    await quiet({ streamline });
    const edits = { temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") };
    const watch = watchSteam(dye2, { a, c });

    let page = await streamline.openSettings();
    page.steamHeater(true);
    await page.save();
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    // Once C's report of the heater on, the plugin's write, its save and Streamline's reply are done.
    await quiet({ streamline });
    expect([watch.taken.c, watch.times.c]).toEqual([[150, 160], []]);
    expect(streamline.remembered("last-steam-temp")).toBe(150);

    // Turned off on the page, which writes a steam time of 0 too, and back on with 145 °C picked as it is turned on, on the
    // page loaded afresh: at 30 s, as it knows no time to come back to but the 0 Streamline kept from the machine's echo of
    // steam off, which it skips. The Recipe's again.
    page = await streamline.openSettings();
    page.steamHeater(false);
    await page.save();
    // Once C's report of the heater off, and Streamline's reply, are done.
    await quiet({ streamline });
    expect(streamline.remembered("last-steam-duration")).toBe(0);
    streamline.stop();
    streamline = await startStreamline(c);
    page = await streamline.openSettings();
    page.steamHeater(true);
    page.steamTemperature(145);
    await page.save();
    await expect.poll(() => [watch.taken.c.slice(2), watch.times.c], { timeout: 15_000 }).toEqual([
      [0, 145, 160],
      [0, 30, 40],
    ]);
    // Once C's report of the heater on, the plugin's write, its save and Streamline's reply are done.
    await quiet({ streamline });
    const content = (await recipe(one)).content;
    expect([content.steamTemperature, content.steamDuration]).toEqual([160, 40]);
    expect({ temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") }).toEqual(edits);
    expect([watch.saved(), watch.savedTimes(), watch.taken.a, watch.times.a]).toEqual([[], [], [], []]);
    expect([setting(a, "steamTemperature"), recorded(c, "steamTemperature"), recorded(c, "steamDuration")]).toEqual([160, 160, 40]);

    // 145 picked once steam is on: the Recipe's edit, saved and written into A, as before.
    await apart();
    page = await streamline.openSettings();
    page.steamTemperature(145);
    await page.save();
    await expect.poll(async () => (await recipe(one)).content.steamTemperature, { timeout: 15_000 }).toBe(145);
    await expect.poll(() => [setting(a, "steamTemperature"), recorded(a, "steamTemperature")], { timeout: 15_000 }).toEqual([145, 145]);
    // Once C's report of the change, DYE2's save of it and the write into A are done.
    await quiet({ streamline });
    expect([setting(c, "steamTemperature"), recorded(c, "steamTemperature"), await editsOf(one, "steamTemperature")]).toEqual([145, 145, edits.temperature + 1]);
    expect(watch.saved()).toEqual([145]);
  });

  it("has a steam time set on Streamline's main page while C's heater is off bring steam back with it, which takes the Recipe's, and one set once steam is on is the Recipe's edit", async () => {
    const { a, c, one, dye2, quiet } = await lab("Steam time", 49241);
    const streamline = await startStreamline(c);
    await streamline.setSteamHeater(false);
    // Once C's report of the heater off, and Streamline's reply, are done.
    await quiet({ streamline });
    const edits = { temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") };
    const watch = watchSteam(dye2, { a, c });

    // 25 s picked with the heater off turns it back on with it (`setTargetSteamDuration` with `rearm`), at the recipe's
    // temperature, its DYE2 switch on: C takes the Recipe's 40 s instead.
    await streamline.set("last-steam-duration", 25);
    await expect.poll(() => [setting(c, "steamTemperature"), setting(c, "steamDuration")], { timeout: 15_000 }).toEqual([160, 40]);
    // Once C's report of the heater on, the plugin's write, its save and Streamline's reply are done.
    await quiet({ streamline });
    expect([watch.taken.c, watch.times.c]).toEqual([[160], [25, 40]]);
    const content = (await recipe(one)).content;
    expect([content.steamTemperature, content.steamDuration]).toEqual([160, 40]);
    expect({ temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") }).toEqual(edits);
    expect([watch.saved(), watch.savedTimes(), watch.taken.a, watch.times.a]).toEqual([[], [], [], []]);

    // 25 s picked again once steam is on: the Recipe's edit, saved and written into A, as before.
    await apart();
    await streamline.set("last-steam-duration", 25);
    await expect.poll(async () => (await recipe(one)).content.steamDuration, { timeout: 15_000 }).toBe(25);
    await expect.poll(() => [setting(a, "steamDuration"), recorded(a, "steamDuration")], { timeout: 15_000 }).toEqual([25, 25]);
    // Once C's report of the change, DYE2's save of it and the write into A are done.
    await quiet({ streamline });
    expect([setting(c, "steamDuration"), await editsOf(one, "steamDuration"), watch.savedTimes()]).toEqual([25, edits.duration + 1, [25]]);
  });

  it("takes C's steam turned off and back on at another temperature while a write of the plugin's into its Workflow waits for Decaid as turned back on, saving nothing of it", async () => {
    const { a, c, one, dye2, quiet } = await lab("During write", 49231);
    expect(setting(c, "steamTemperature")).toBe(160);
    const edits = await editsOf(one, "steamTemperature");
    const watch = watchSteam(dye2, { a, c });
    // A Recipe edit, whose write into C's Workflow, made once the plugin has read it, Decaid holds.
    const held = c.holdRequests("PUT", "/workflow");
    await patch(one, { hotWaterVolume: 130 });
    // Within Decaid's 30 s fetch timeout at the tablet's pace, under a second here.
    await expect.poll(() => held.arrived, { timeout: 15_000, interval: 5 }).toBeGreaterThan(0);
    // Meanwhile C's barista turns steam off and back on at 140 °C: the plugin hears of both during its write, and decides on
    // them together once it is done.
    await c.changeSettings({ steamSettings: { targetTemperature: 0 } });
    await c.changeSettings({ steamSettings: { targetTemperature: 140 } });
    held.release();
    await expect.poll(() => setting(c, "hotWaterVolume"), { timeout: 15_000 }).toBe(130);
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    // Once C's report of the change, the plugin's write, its save and the write into A are done.
    await quiet();
    expect(watch.taken.c).toEqual([0, 140, 160]);
    expect([(await recipe(one)).content.steamTemperature, await editsOf(one, "steamTemperature")]).toEqual([160, edits]);
    expect([watch.saved(), watch.taken.a, recorded(c, "steamTemperature"), setting(a, "hotWaterVolume")]).toEqual([[], [], 160, 130]);
  });

  it("keeps a steam temperature DYE2's editor on C saves while C's steam is off as the Recipe's edit, its apply turning steam back on while a save of the plugin's waits for Decaid's read of C's Workflow", async () => {
    const { a, c, one, quiet } = await lab("During save", 49251);
    await c.changeSettings({ steamSettings: { targetTemperature: 0 } });
    await quiet();
    const edits = await editsOf(one, "steamTemperature");
    // A feed rate typed on C, which the plugin saves into the Recipe once it has read C's Workflow, a read Decaid holds.
    const held = c.holdRequests("GET", "/workflow");
    await c.changeSettings({ context: { extras: { feedRate: "MF" } } });
    await expect.poll(() => held.arrived, { timeout: 15_000, interval: 5 }).toBeGreaterThan(0);
    // Meanwhile DYE2's editor on C saves a steam temperature, and applies the recipe again, which turns steam back on with it.
    await (await openDye2RecipeEditor(c, { id: LIBRARY })).set({ steamTempC: 150 }).save();
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(150);
    held.release();
    await expect.poll(async () => (await recipe(one)).content.feedRate, { timeout: 15_000 }).toBe("MF");
    // Once C's report, the plugin's save and the write into A are done.
    await quiet();
    expect([(await recipe(one)).content.steamTemperature, await editsOf(one, "steamTemperature")]).toEqual([150, edits + 1]);
    expect([setting(c, "steamTemperature"), recorded(c, "steamTemperature"), recorded(a, "steamTemperature")]).toEqual([150, 150, 150]);
  });

  it("has Auto Steam, choosing a pitcher with C's heater off, turn its steam back on at the Recipe's steam temperature and time, not the one Streamline remembers or the pitcher's, while the pitcher's flow, in the same change, is saved into the Recipe", async () => {
    const { a, c, one, dye2, quiet } = await lab("Pitcher", 49221);
    const streamline = await startStreamline(c, { "last-steam-temp": 140 });
    // C's steam turned off on Decaid's own screen, which leaves the temperature Streamline remembers.
    await c.changeSettings({ steamSettings: { targetTemperature: 0 } });
    // Once C's report of steam off, and Streamline's reply, are done.
    await quiet({ streamline });
    const edits = { temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") };
    const watch = watchSteam(dye2, { a, c });

    // The Auto Steam Calculator works out 24 s at 1.2 ml/s for the pitcher. Steam comes back on with both, as steam
    // comes back on with a time from anywhere, and the Recipe's 40 s is put back with its temperature (#394).
    await streamline.autoSteam({ duration: 24, flow: 1.2 });
    await expect.poll(() => [setting(c, "steamTemperature"), setting(c, "steamDuration")], { timeout: 15_000 }).toEqual([160, 40]);
    await expect.poll(async () => (await recipe(one)).content.steamFlow, { timeout: 15_000 }).toBe(1.2);
    await expect.poll(() => setting(a, "steamFlow"), { timeout: 15_000 }).toBe(1.2);
    // Once C's report of the pitcher, the plugin's write, its save, the write into A and Streamline's reply are done.
    await quiet({ streamline });
    // Auto Steam's entry turns the steam timer off, before the pitcher brings steam back on.
    expect([watch.taken.c, watch.times.c]).toEqual([
      [140, 160],
      [0, 24, 40],
    ]);
    const content = (await recipe(one)).content;
    expect([content.steamTemperature, content.steamDuration]).toEqual([160, 40]);
    expect({ temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") }).toEqual(edits);
    expect([watch.saved(), watch.savedTimes(), watch.taken.a, watch.times.a, recorded(c, "steamTemperature"), recorded(c, "steamDuration")]).toEqual([[], [], [], [], 160, 40]);
    expect([setting(c, "steamFlow"), setting(a, "steamTemperature"), setting(a, "steamDuration")]).toEqual([1.2, 160, 40]);
  });
});
