import { LOADED_RECIPE_KEY, RECIPE_FIELD, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #145 and #177: each Machine's Loaded Recipe (ADR-0022)
// is the recipe DYE2 has selected on its tablet. Applying a recipe, the DYE2
// way or the Streamline way, selects it, and the plugin loads it, writing
// into the Workflow what applying it leaves out, its brew temperature, Bean
// Batch, Basket, RPM and hot water, and its global id; the server reads the
// Loaded Recipe from the Workflow it delivers. A selection cleared or of
// anything else unloads it, as does a change of grinder or Bean, which DYE2
// clears its selection on too. Through the built plugin in simulated
// tablets running DYE2 at 2cf631c and Streamline at c006dac as recorded
// (fixtures/decaid/dye2-2cf631c/), on two server instances sharing one
// database, with assertions through the REST API and what each simulated
// tablet holds. Serials are made up, from 47001.

type Record_ = Record<string, unknown>;

interface LoadedView {
  id: string;
  recipe: { id: string; name: string | null; slot: number | null; locationId: string | null; archived: boolean };
  loadedAt: string;
  unloadedAt: string | null;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** All four hot water settings slot 1's Recipe is given in the management interface. */
const HOT_WATER = { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 };

/** The recording's Workflow's profile, and slot 2's, and slot 1's, `Adaptive v3`, by their ids. */
const ADAPTIVE = "profile:98fa00c191551b435845";

describe("Each Machine's Loaded Recipe", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  const records = (tablet: SimulatedTablet) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []);
  const inSlot = (tablet: SimulatedTablet, slot: string) => records(tablet).find((record) => record.id === slot);
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const extras = (tablet: SimulatedTablet) => (context(tablet).extras ?? {}) as Record_;
  const temperatures = (tablet: SimulatedTablet) => ((tablet.workflow().profile as Record_).steps as Record_[]).map((step) => step.temperature);
  /** The Recipe id the tablet's Workflow names as loaded, or null. */
  const named = (tablet: SimulatedTablet) => extras(tablet)[LOADED_RECIPE_KEY] ?? null;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: LoadedView | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe;
  const history = async ({ machine }: CreatedMachine) =>
    (await (await api.call("GET", `/machines/${machine.id}/loaded-recipes`)).json()) as { entries: LoadedView[]; total: number };
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) =>
    expect.poll(async () => (await loadedRecipe(machine))?.recipe.id ?? null, { timeout: 15_000 }).toBe(recipeId);
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  /** The writes of DYE2's stored selection the plugin made, besides DYE2's own. */
  const storedByPlugin = (tablet: SimulatedTablet) => tablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "selection");

  /**
   * A Location with a Machine whose tablet is the 2cf631c recording's, its
   * DYE2 loaded, on the instance given: joining a Location with no Recipes,
   * it brings slots 1 and 2, which are written back with their Recipes' ids,
   * and slot 1's Recipe is given all four hot water settings (`HOT_WATER`)
   * in the management interface.
   */
  async function lab(
    scenario: string,
    serial: number,
    options: { instance?: TestServer; pollSeconds?: number; dye2?: SimulatedDye2; apiDelayMs?: (method: string, path: string) => number } = {},
  ) {
    const here: LocationView = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machine = await api.createMachine(`${scenario} lab 1`, here.id);
    const dye2 = options.dye2 ?? new SimulatedDye2();
    const tablet = syncingTablet(machine, options.instance ?? server, { api: recordedDye2MainTablet(String(serial), scenario), dye2, pollSeconds: options.pollSeconds, apiDelayMs: options.apiDelayMs });
    await api.waitForOnline(machine);
    await expect.poll(() => ["1", "2"].map((slot) => dye2GlobalIdOf(inSlot(tablet, slot))), { timeout: 15_000 }).not.toContain(null);
    const listed = (await api.get<{ recipes: { id: string; slot: number | null }[] }>(`/locations/${here.id}/recipes`)).recipes;
    const [one, two] = [1, 2].map((slot) => listed.find((entry) => entry.slot === slot)!.id) as [string, string];
    const edit = async (recipeId: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${recipeId}`, { content })).status).toBe(200);
    await edit(one, { hotWaterVolume: HOT_WATER.volume, hotWaterTemperature: HOT_WATER.targetTemperature, hotWaterDuration: HOT_WATER.duration, hotWaterFlow: HOT_WATER.flow });
    await expect.poll(() => (inSlot(tablet, "1")?.[RECIPE_FIELD] as Record_ | undefined)?.hotWaterData).toEqual(HOT_WATER);
    /**
     * Takes slot 1's Recipe's batch away, so its load writes none: DYE2 clears its selection where the Workflow's batch moves
     * off the one it was selected on, or the first it saw since, so a dashboard send of its copy, which holds none, after a
     * load that wrote one unloads the Recipe (ADR-0022, the transitional gap until #187 and #188).
     */
    const withoutBatch = async () => {
      await edit(one, { beanBatchId: null });
      await expect.poll(() => (inSlot(tablet, "1")?.[RECIPE_FIELD] as Record_ | undefined)?.beanBatchId ?? null).toBeNull();
    };
    return { here, machine, tablet, dye2, one, two, edit, withoutBatch };
  }

  it("loads a recipe applied the DYE2 way, writing its brew temperature with the profile's shape kept, its batch, grinder, Basket, RPM, hot water and id, which a Shot pulled then carries", async () => {
    const { machine, tablet, one } = await lab("Dashboard", 47001);
    const record = inSlot(tablet, "1")!;
    const variables = record.dashboardVariables as Record_;
    const batch = (record[RECIPE_FIELD] as Record_).beanBatchId;
    expect(batch).toEqual(expect.any(String));
    expect(await loadedRecipe(machine)).toBeNull();

    const dashboard = await openDye2Dashboard(tablet);
    const applied = await dashboard.applyRecipe("1");
    expect([applied.workflow.status, applied.selection?.status]).toEqual([200, 200]);
    await expect.poll(() => named(tablet)).toBe(one);
    expect(context(tablet)).toMatchObject({ beanBatchId: batch, grinderId: variables.grinderId, targetDoseWeight: variables.dose, targetYield: variables.drink });
    expect(extras(tablet)).toMatchObject({ basketId: variables.basketId, rpm: variables.rpm });
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
    // Adaptive v3 at the Recipe's 92 °C: its first step at 92, every other a degree cooler than its own.
    expect(temperatures(tablet).slice(0, 3)).toEqual([92, 92, 87]);
    await loads(machine, one);
    expect(await history(machine)).toMatchObject({ total: 1, entries: [{ recipe: { id: one, slot: 1, archived: false }, unloadedAt: null }] });

    tablet.pullShot(shotOf(tablet, "loaded-recipe-shot-47001", 47001));
    await expect.poll(async () => (await api.call("GET", "/shots/loaded-recipe-shot-47001")).status, { timeout: 15_000 }).toBe(200);
    expect((await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/loaded-recipe-shot-47001")).shot.recipe?.id).toBe(one);
  });

  it("loads a recipe applied the Streamline way on a tablet on the other instance, which names it at once", async () => {
    const { machine, tablet, two } = await lab("Strip", 47011, { instance: other });
    // The strip leaves the Workflow's batch, which DYE2 clears its selection on once it moves: so on the Recipe's already
    // (ADR-0022, the transitional gap until #187 and #188).
    await tablet.changeSettings({ context: { beanBatchId: (inSlot(tablet, "2")![RECIPE_FIELD] as Record_).beanBatchId } });
    const streamline = await startStreamline(tablet);
    const workflows: Record_[] = [];
    tablet.onWorkflowChange((workflow) => workflows.push(workflow));
    const applied = await streamline.applyRecipe("2");
    expect([applied.workflow.status, applied.selection?.status]).toEqual([200, 200]);
    // The Workflow embedded in the record names its Recipe, and holds its profile at its brew temperature.
    expect(((workflows[0]?.context as Record_).extras as Record_)[LOADED_RECIPE_KEY]).toBe(two);
    await loads(machine, two);
    const variables = inSlot(tablet, "2")!.dashboardVariables as Record_;
    expect(extras(tablet)).toMatchObject({ basketId: variables.basketId, rpm: variables.rpm });
    expect(temperatures(tablet)[0]).toBe(variables.brewC);
    expect(context(tablet).beanBatchId).toBe((inSlot(tablet, "2")![RECIPE_FIELD] as Record_).beanBatchId);
  });

  it("keeps the Recipe loaded through a dial tap and Done on DYE2's dashboard, which send back the page's copy, the tap's dial change the Recipe's", async () => {
    const { machine, tablet, one, withoutBatch } = await lab("Copy", 47021);
    await withoutBatch();
    // The tablet's Workflow holds the other Recipe's Basket as the page opens, which DYE2's apply leaves.
    const brazil = inSlot(tablet, "2")!;
    await tablet.changeSettings({ context: { extras: { basketId: (brazil.dashboardVariables as Record_).basketId } } });
    const dashboard = await openDye2Dashboard(tablet);
    await dashboard.applyRecipe("1");
    await loads(machine, one);
    const written = extras(tablet).basketId;
    expect(written).toBe((inSlot(tablet, "1")!.dashboardVariables as Record_).basketId);

    // Each send puts back the page's copy, with the previous Recipe's Basket, which is written back.
    expect((await dashboard.tap("grind", 2.6)).status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.6);
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(written);
    expect((await dashboard.done())?.status).toBe(200);
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(written);
    expect(context(tablet).grinderSetting).toBe("2.6");
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);
    expect(named(tablet)).toBe(one);
    expect((await recipe(one)).content.basketId).toEqual(expect.any(String));
    // Nor is the page's hot water volume, which DYE2 records too, the Recipe's.
    expect((await recipe(one)).content.hotWaterVolume).toBe(HOT_WATER.volume);
  });

  it("unloads the Recipe on a dial tap on DYE2's dashboard after a load that wrote its batch, as the page's copy sends the batch cleared", async () => {
    const { machine, tablet, dye2, one } = await lab("Copy batch", 47131);
    const dashboard = await openDye2Dashboard(tablet);
    await dashboard.applyRecipe("1");
    await loads(machine, one);
    const grind = (await recipe(one)).content.grindSetting;
    expect(context(tablet).beanBatchId).toBe((inSlot(tablet, "1")![RECIPE_FIELD] as Record_).beanBatchId);
    // The page applied the recipe's Bean with no batch, so its copy holds none (ADR-0022, the transitional gap until #187).
    expect((await dashboard.tap("grind", 2.6)).status).toBe(200);
    await expect.poll(() => dye2.selected(), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);
    expect((await recipe(one)).content.grindSetting).toBe(grind);
  });

  it("delivers a dashboard tap held during the plugin's writes before an espresso started then, so its pre-load Basket is written back", async () => {
    // DYE2 records the tap's Basket too, which reaches the server only with the tablet's recipes at the plugin's poll, after
    // the espresso, and is then an edit (ADR-0022's gap until #189): a poll that never comes leaves it out here.
    const { machine, tablet, one, withoutBatch } = await lab("Espresso", 47031, { pollSeconds: 3600 });
    await withoutBatch();
    tablet.connectMachine();
    const basket2 = (inSlot(tablet, "2")!.dashboardVariables as Record_).basketId;
    await tablet.changeSettings({ context: { extras: { basketId: basket2 } } });
    const dashboard = await openDye2Dashboard(tablet);
    await dashboard.applyRecipe("1");
    await loads(machine, one);
    const basket = extras(tablet).basketId;
    expect(basket).not.toBe(basket2);
    const recipeBasket = (await recipe(one)).content.basketId;
    // The tap's Workflow, held while the plugin decides on it, and the espresso started at once.
    expect((await dashboard.tap("dose", 18.2)).status).toBe(200);
    tablet.reportState("espresso", "preinfusion");
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(basket);
    expect((await recipe(one)).content.basketId).toBe(recipeBasket);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);
    // After that espresso, a Basket set back is the barista's, and the Recipe's.
    tablet.reportState("idle", "ready");
    await tablet.changeSettings({ context: { extras: { basketId: basket2 } } });
    await expect.poll(async () => (await recipe(one)).content.basketId, { timeout: 15_000 }).not.toBe(recipeBasket);
    expect(extras(tablet).basketId).toBe(basket2);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);
  });

  it("unloads a Recipe whose grinder a barista switches while the plugin's load write is under way", async () => {
    let slow = false;
    // 25 s at the tablet's pace, within Decaid's 30 s fetch timeout: half a second here.
    const { machine, tablet, dye2 } = await lab("Switched", 47101, { apiDelayMs: (method, path) => (slow && method === "PUT" && path === "/workflow" ? 25_000 : 0) });
    const other = ((await tablet.callApi("POST", "/grinders", { model: "Switched Grinder 2", settingType: "numeric" })).body as Record_).id as string;
    slow = true;
    const reads = tablet.requests.filter((route) => route === "/workflow").length;
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    // The plugin's write, slowed, lands after the barista's switch, which it leaves as the write sets no grinder.
    await expect.poll(() => tablet.requests.filter((route) => route === "/workflow").length).toBeGreaterThan(reads);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await tablet.changeSettings({ context: { grinderId: other, grinderModel: "Switched Grinder 2" } });
    slow = false;
    await expect.poll(() => dye2.selected(), { timeout: 15_000 }).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(named(tablet)).toBeNull();
    expect(await loadedRecipe(machine)).toBeNull();
    expect(context(tablet).grinderId).toBe(other);
  });

  it("counts an espresso running as a Recipe is loaded, reported again and again and through its substates, as none started since the load", async () => {
    const { machine, tablet, one, withoutBatch } = await lab("Running", 47111);
    await withoutBatch();
    tablet.connectMachine();
    const before = { extras: { basketId: (inSlot(tablet, "2")!.dashboardVariables as Record_).basketId } };
    await tablet.changeSettings({ context: before });
    tablet.reportState("espresso", "pour");
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    const basket = extras(tablet).basketId;
    // Decaid reports the same state several times a second, and each substate of the Shot running, which the plugin sends.
    for (let report = 0; report < 3; report++) tablet.reportState("espresso", "pour");
    tablet.reportState("espresso", "pouringDone");
    tablet.reportState("idle", "ready");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await tablet.changeSettings({ context: before });
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(basket);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);
  });

  it("does not select the Recipe again over a barista's profile after Decaid refused the server's write of its Profile", async () => {
    const { machine, tablet, dye2, one } = await lab("Refused profile", 47121, { pollSeconds: 3600 });
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    // Decaid refuses the Workflow write carrying the Recipe's new Profile.
    tablet.refuseWrites = ({ method, route, body }) =>
      method === "PUT" && route === "/workflow" && typeof body === "object" && body !== null && "profile" in body ? { status: 400, body: { error: "refused" } } : undefined;
    const classic = "profile:39e939592679fb194706";
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { profileId: classic } })).status).toBe(200);
    await expect.poll(() => tablet.writes.filter((write) => write === "PUT /workflow").length, { timeout: 15_000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    tablet.refuseWrites = undefined;
    // The barista's own profile, which DYE2 clears its selection on.
    const own = { ...(tablet.workflow().profile as Record_), title: "Barista's own" };
    expect((await tablet.callApi("PUT", "/workflow", { profile: own })).status).toBe(200);
    expect(dye2.selected()).toBeNull();
    await loads(machine, null);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(dye2.selected()).toBeNull();
    expect(named(tablet)).toBeNull();
  });

  it("loads nothing for a Recipe's dial dialled in by hand, with nothing selected", async () => {
    const { machine, tablet, dye2 } = await lab("Hand", 47041);
    const variables = inSlot(tablet, "1")!.dashboardVariables as Record_;
    const adaptive = (((await tablet.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((profile) => profile.id === ADAPTIVE)!).profile;
    await tablet.changeSettings({ profile: adaptive as Record_, context: { targetDoseWeight: variables.dose, targetYield: variables.drink, grinderId: variables.grinderId, grinderSetting: String(variables.grind) } });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(dye2.selected()).toBeNull();
    expect(named(tablet)).toBeNull();
    expect(await loadedRecipe(machine)).toBeNull();
  });

  it("unloads the Recipe as a favourite is applied or the profile changes, which DYE2 pushes", async () => {
    const { machine, tablet, dye2, one } = await lab("Unloads", 47051);
    const dashboard = await openDye2Dashboard(tablet);
    await dashboard.applyRecipe("1");
    await loads(machine, one);
    // A saved favourite selected.
    expect((await dashboard.applyFavourite({ id: "favourite-47051", snapshot: { dose: 17.5 } })).selection?.status).toBe(200);
    expect(dye2.selected()).toMatchObject({ kind: "favourite" });
    await loads(machine, null);
    expect(named(tablet)).toBeNull();

    // A change of profile, which DYE2 clears its selection on, pushing once (decentespresso/dye2#24).
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    const pushed = dye2.pushes.length;
    const classic = (((await tablet.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((profile) => profile.id !== ADAPTIVE)!).profile;
    expect((await tablet.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect(dye2.selected()).toBeNull();
    await loads(machine, null);
    expect(dye2.pushes.length).toBe(pushed + 1);
    // The cleared selection is kept cleared in DYE2's storage.
    await expect.poll(() => tablet.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
  });

  it("unloads the Recipe on DYE2's push as Streamline's strip is switched off, which changes no Workflow", async () => {
    const { machine, tablet, one } = await lab("Strip off", 47061, { pollSeconds: 3600 });
    const streamline = await startStreamline(tablet);
    await streamline.applyRecipe("1");
    await loads(machine, one);
    expect((await streamline.switchDye2Off())?.status).toBe(200);
    // DYE2 pushes its clear (decentespresso/dye2#24), long before the plugin's next poll.
    await loads(machine, null);
    expect(named(tablet)).toBeNull();
  });

  it("reads the selection on a push from DYE2, without waiting for its poll", async () => {
    const { machine, tablet, one, two } = await lab("Pushed", 47071, { pollSeconds: 3600 });
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    // A selection with no change of the Workflow, as Streamline's strip re-selecting: only DYE2's push tells the plugin.
    // DYE2 takes it as made on the profile the Workflow holds, so it loads slot 2, writing its profile.
    expect((await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: "2" })).status).toBe(200);
    await loads(machine, two);
    expect((tablet.workflow().profile as Record_).title).toBe("Classic Italian espresso");
  });

  it("unloads the Recipe on a change of Bean, clearing DYE2's selection, after which a grind change edits nothing, and DYE2 reloading loads nothing and leaves the Bean", async () => {
    const { machine, tablet, dye2, one } = await lab("Bean", 47081);
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    const brazilBatch = (inSlot(tablet, "2")![RECIPE_FIELD] as Record_).beanBatchId;
    tablet.connectMachine();
    tablet.reportState("espresso", "pour");
    tablet.reportState("idle", "ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await tablet.changeSettings({ context: { beanBatchId: brazilBatch } });
    await loads(machine, null);
    expect(dye2.selected()).toBeNull();
    await expect.poll(() => tablet.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    const grind = (await recipe(one)).content.grindSetting;
    await tablet.changeSettings({ context: { grinderSetting: "3.3" } });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await recipe(one)).content.grindSetting).toBe(grind);

    // DYE2 reloads, restoring its stored selection, none, and pushes.
    await dye2.reload();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(dye2.selected()).toBeNull();
    expect(await loadedRecipe(machine)).toBeNull();
    expect(context(tablet).beanBatchId).toBe(brazilBatch);
  });

  it("unloads nothing and writes nothing to DYE2's storage while DYE2 answers 404 as it reloads, nor on its first answer of none before it restores its selection", async () => {
    const { machine, tablet, dye2, one } = await lab("Reload", 47091);
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    await expect.poll(() => tablet.storeValue(DYE2_NAMESPACE, "selection")).toMatchObject({ kind: "recipe", id: "1" });
    const stored = storedByPlugin(tablet).length;
    const release = dye2.holdRestore();
    dye2.unload();
    // 404 meanwhile, through a change of the Workflow and several reads.
    await tablet.changeSettings({ context: { targetDoseWeight: 18.1 } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const reloaded = dye2.load();
    // Loaded with nothing selected yet: the plugin's first read of none unloads nothing.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dye2.selected()).toBeNull();
    release();
    await reloaded;
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: "1" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);
    expect(named(tablet)).toBe(one);
    expect(storedByPlugin(tablet).length).toBe(stored);
  });
});

/**
 * A Shot the tablet's Decaid saves as one pulled now ends: the fixture's
 * curves, recorded on the Machine of that serial, with the tablet's Workflow
 * as it stands, which Decaid copies onto it. Its samples are a tenth of a
 * second apart.
 */
function shotOf(tablet: SimulatedTablet, id: string, serial: number): Record_ {
  const fixture = shotFixture();
  const samples = fixture.measurements as Record_[];
  const startedAt = Date.now() - (samples.length - 1) * 100;
  const measurements = samples.map((sample, index) => ({
    ...sample,
    machine: { ...(sample.machine as Record_), timestamp: new Date(startedAt + index * 100).toISOString().slice(0, -1) },
  }));
  const machine = { ...((fixture.workflow as Record_).machine as Record_), serialNumber: String(serial) };
  return { ...fixture, id, timestamp: new Date(startedAt).toISOString(), workflow: { ...structuredClone(tablet.workflow()), machine }, measurements };
}
