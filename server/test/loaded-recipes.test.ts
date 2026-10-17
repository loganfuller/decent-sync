import { dye2GlobalIdOf, dye2SelectionOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { selectedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #145, #177, #188 and #189: each Machine's Loaded Recipe
// (ADR-0022) is the recipe DYE2 has selected on its tablet. Applying a
// recipe, the DYE2 way or the Streamline way, selects it, which DYE2 names in
// the Workflow, and the plugin loads it, writing into the Workflow what
// applying it leaves out, its Basket and the settings Streamline's strip does
// not apply yet (#173), but no Recipe id; the
// server reads the Loaded Recipe from DYE2's field in the Workflow it
// delivers (#189). A selection cleared or of anything else unloads it, as
// DYE2 clears it on a change of grinder or batch; one restored over such a
// change made while DYE2 was away has nothing written for it, and unloads at
// the next change (#188). DYE2's recordings reach the server on its push,
// and the plugin reads the selection after a Workflow change only while it
// holds the change. Through the built plugin in simulated
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

/** The recording's tablet's id for its batch of the Brazil, slot 2's Bean. */
const RECORDED_BRAZIL_BATCH = "837c5af9-aa43-44ed-a857-5009969e3217";

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
  /** The Recipe the tablet's Workflow names as DYE2's selection, or null. */
  const named = selectedInWorkflow;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: LoadedView | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe;
  const history = async ({ machine }: CreatedMachine) =>
    (await (await api.call("GET", `/machines/${machine.id}/loaded-recipes`)).json()) as { entries: LoadedView[]; total: number };
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) =>
    expect.poll(async () => (await loadedRecipe(machine))?.recipe.id ?? null, { timeout: 15_000 }).toBe(recipeId);
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  /** The writes of DYE2's stored selection the plugin made, besides DYE2's own: none, as DYE2 stores its selection itself. */
  const storedByPlugin = (tablet: SimulatedTablet) => tablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "selection");
  /** How many selections or clears the plugin posted to DYE2. */
  const selectionPosts = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === `POST /plugins/${DYE2_NAMESPACE}/selection`).length;

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
    await expect
      .poll(() => {
        const variables = (inSlot(tablet, "1")?.dashboardVariables ?? {}) as Record_;
        return { targetTemperature: variables.hotWaterTempC, duration: variables.hotWaterTimeS, volume: variables.hotWaterMl, flow: variables.hotWaterFlowMls };
      })
      .toEqual(HOT_WATER);
    return { here, machine, tablet, dye2, one, two, edit };
  }

  /** The plugin's writes into the tablet's Workflow from now on, as it sent them. */
  const workflowWrites = (tablet: SimulatedTablet) => {
    const writes: Record_[] = [];
    tablet.refuseWrites = ({ method, route, body }) => {
      if (method === "PUT" && route === "/workflow") writes.push(body as Record_);
      return undefined;
    };
    return writes;
  };

  it("loads a recipe applied the DYE2 way, which applies its batch, RPM, brew temperature and hot water and names it in the Workflow, with its Basket, which a Shot pulled then carries", async () => {
    const { machine, tablet, one } = await lab("Dashboard", 47001);
    const record = inSlot(tablet, "1")!;
    const variables = record.dashboardVariables as Record_;
    const batch = record.beanBatchId;
    expect(batch).toEqual(expect.any(String));
    expect(await loadedRecipe(machine)).toBeNull();
    // Another batch, of the Recipe's Bean or not, is in the Workflow as it is applied.
    await tablet.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });

    const writes = workflowWrites(tablet);
    const dashboard = await openDye2Dashboard(tablet);
    const applied = await dashboard.applyRecipe("1");
    expect([applied.workflow.status, applied.selection?.status]).toEqual([200, 200]);
    await loads(machine, one);
    expect(named(tablet)).toBe(one);
    expect(context(tablet)).toMatchObject({ beanBatchId: batch, grinderId: variables.grinderId, targetDoseWeight: variables.dose, targetYield: variables.drink });
    expect(extras(tablet)).toMatchObject({ basketId: variables.basketId, rpm: variables.rpm });
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
    // Adaptive v3 at the Recipe's 92 °C: its first step at 92, every other a degree cooler than its own, as DYE2 applies it
    // (decentespresso/dye2#26). The plugin's load write writes no profile, and DYE2's selection stands.
    expect(temperatures(tablet).slice(0, 3)).toEqual([92, 92, 87]);
    // Nothing writes a Recipe id of its own into the Workflow: DYE2's selection names the Recipe. DYE2 applies every setting
    // the recipe holds, so the plugin's load writes none of them.
    expect(writes.some((write) => "hotWaterData" in write)).toBe(false);
    expect(JSON.stringify([writes, tablet.workflow(), dye2List(tablet, "recipes")])).not.toContain("decentSyncRecipeId");
    expect(writes.some((write) => "profile" in write)).toBe(false);
    expect(writes.some((write) => "beanBatchId" in ((write.context as Record_ | undefined) ?? {}))).toBe(false);
    expect(await history(machine)).toMatchObject({ total: 1, entries: [{ recipe: { id: one, slot: 1, archived: false }, unloadedAt: null }] });

    tablet.pullShot(shotOf(tablet, "loaded-recipe-shot-47001", 47001));
    await expect.poll(async () => (await api.call("GET", "/shots/loaded-recipe-shot-47001")).status, { timeout: 15_000 }).toBe(200);
    expect((await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/loaded-recipe-shot-47001")).shot.recipe?.id).toBe(one);
  });

  it("loads a recipe applied the Streamline way on a tablet on the other instance, which applies its batch and brew temperature", async () => {
    const { machine, tablet, two } = await lab("Strip", 47011, { instance: other });
    // The Workflow on another batch than the Recipe's, which the strip applies from the record's embedded Workflow, once the
    // record names its Basket, which the tablet is written first.
    await expect.poll(() => (inSlot(tablet, "2")?.dashboardVariables as Record_ | undefined)?.basketId ?? null, { timeout: 15_000 }).not.toBeNull();
    expect(context(tablet).beanBatchId).not.toBe(inSlot(tablet, "2")!.beanBatchId);
    const writes = workflowWrites(tablet);
    const streamline = await startStreamline(tablet);
    const workflows: Record_[] = [];
    tablet.onWorkflowChange((workflow) => workflows.push(workflow));
    const applied = await streamline.applyRecipe("2");
    expect([applied.workflow.status, applied.selection?.status]).toEqual([200, 200]);
    // The Workflow embedded in the record names no Recipe, which DYE2's selection names once the strip selects it.
    expect(JSON.stringify(workflows[0])).not.toContain("decentSyncRecipeId");
    await loads(machine, two);
    expect(named(tablet)).toBe(two);
    const variables = inSlot(tablet, "2")!.dashboardVariables as Record_;
    expect(extras(tablet)).toMatchObject({ basketId: variables.basketId, rpm: variables.rpm });
    expect(temperatures(tablet)[0]).toBe(variables.brewC);
    expect(context(tablet).beanBatchId).toBe(inSlot(tablet, "2")!.beanBatchId);
    expect(writes.some((write) => "profile" in write)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await loadedRecipe(machine))?.recipe.id).toBe(two);
  });

  it("keeps the Recipe loaded through a dial tap and Done on DYE2's dashboard, which send back the page's copy, the tap's dial change the Recipe's", async () => {
    const { machine, tablet, one } = await lab("Copy", 47021);
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
    // The page's copy holds the batch its apply set, as DYE2 applies a recipe's (decentespresso/dye2#27).
    expect(context(tablet).beanBatchId).toBe(inSlot(tablet, "1")!.beanBatchId);
    expect((await recipe(one)).content.basketId).toEqual(expect.any(String));
    // Nor is the page's hot water volume, which DYE2 records too, the Recipe's.
    expect((await recipe(one)).content.hotWaterVolume).toBe(HOT_WATER.volume);
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
    const { machine, tablet, one } = await lab("Running", 47111);
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
    expect(dye2SelectionOf(tablet.workflow())).toEqual({ named: true, slot: null });

    // A change of profile, which DYE2 clears its selection on, pushing once (decentespresso/dye2#24).
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    const pushed = dye2.pushes.length;
    const classic = (((await tablet.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((profile) => profile.id !== ADAPTIVE)!).profile;
    expect((await tablet.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect(dye2.selected()).toBeNull();
    await loads(machine, null);
    expect(dye2.pushes.length).toBe(pushed + 1);
    // DYE2 keeps its cleared selection in its storage itself.
    await expect.poll(() => tablet.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    expect(storedByPlugin(tablet)).toEqual([]);
  });

  it("unloads the Recipe on DYE2's push as Streamline's strip is switched off, which DYE2's field then names nothing", async () => {
    const { machine, tablet, one } = await lab("Strip off", 47061, { pollSeconds: 3600 });
    const streamline = await startStreamline(tablet);
    await streamline.applyRecipe("1");
    await loads(machine, one);
    expect((await streamline.switchDye2Off())?.status).toBe(200);
    // DYE2 pushes its clear (decentespresso/dye2#24), long before the plugin's next poll.
    await loads(machine, null);
    expect(dye2SelectionOf(tablet.workflow())).toEqual({ named: false, slot: null });
  });

  it("reports a dial change DYE2 records into the Recipe on DYE2's push after it records, long before the plugin's next poll of the tablet's lists", async () => {
    // Polling every hour, 72 s at the tablet's time scale: only DYE2's push has the plugin read its recipes sooner.
    const { machine, tablet, one } = await lab("Recorded", 47141, { pollSeconds: 3600 });
    const dashboard = await openDye2Dashboard(tablet);
    await dashboard.applyRecipe("1");
    await loads(machine, one);
    expect((await dashboard.tap("grind", 2.8)).status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 10_000 }).toBe(2.8);
  });

  it("reads DYE2's selection after a Workflow change only while it holds the change back, and unloads a Recipe the server clears DYE2's selection of on DYE2's push", async () => {
    const { machine, tablet, dye2, one } = await lab("Reads", 47151, { pollSeconds: 3600 });
    const reads = () => tablet.requests.filter((route) => route === `/plugins/${DYE2_NAMESPACE}/selection`).length - selectionPosts(tablet);
    // Nothing loaded, and DYE2's field naming nothing: a change of the Workflow is sent as it is, with no read after it.
    const unread = reads();
    await tablet.changeSettings({ context: { targetDoseWeight: 19 } });
    await tablet.changeSettings({ context: { targetDoseWeight: 19.5 } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(reads()).toBe(unread);

    // With a Recipe loaded, one is held back until a read after it decides on it.
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    const held = reads();
    await tablet.changeSettings({ context: { targetDoseWeight: 18.8 } });
    await expect.poll(reads).toBeGreaterThan(held);

    // Archived, the server unloads it: the plugin clears DYE2's selection, writing nothing into the Workflow, and DYE2
    // writes its field and pushes its clear.
    const written = tablet.writes.length;
    expect((await api.call("PUT", `/recipes/${one}/archived`, { archived: true })).status).toBe(200);
    await expect.poll(() => dye2.selected(), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);
    expect(named(tablet)).toBeNull();
    expect(tablet.writes.slice(written)).toContain(`POST /plugins/${DYE2_NAMESPACE}/selection`);
    expect(tablet.writes.slice(written)).not.toContain("PUT /workflow");
    expect((await history(machine)).total).toBe(1);
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

  it("unloads the Recipe through DYE2's own clear on a change of grinder, a change of batch and a batch cleared, posting no clear itself", async () => {
    const { machine, tablet, dye2, one } = await lab("Bean", 47081);
    const grinder = ((await tablet.callApi("POST", "/grinders", { model: "Bean Grinder 2", settingType: "numeric" })).body as Record_).id as string;
    const brazilBatch = inSlot(tablet, "2")!.beanBatchId;
    const changes: Record_[] = [{ grinderId: grinder, grinderModel: "Bean Grinder 2" }, { beanBatchId: brazilBatch }, { beanBatchId: null }];
    for (const change of changes) {
      await (await openDye2Dashboard(tablet)).applyRecipe("1");
      await loads(machine, one);
      const posted = selectionPosts(tablet);
      await tablet.changeSettings({ context: change });
      expect(dye2.selected()).toBeNull();
      await loads(machine, null);
      expect(named(tablet)).toBeNull();
      expect(selectionPosts(tablet)).toBe(posted);
    }
    // Unloaded, a grind change edits nothing.
    const grind = (await recipe(one)).content.grindSetting;
    await tablet.changeSettings({ context: { grinderSetting: "3.3" } });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await recipe(one)).content.grindSetting).toBe(grind);
    expect(storedByPlugin(tablet)).toEqual([]);
  });

  it("loads the Recipe DYE2 restores as it comes back, and, while DYE2's field names one restored over a Bean switched while it was away, writes back no batch", async () => {
    const { machine, tablet, dye2, one } = await lab("Restored", 47131, { pollSeconds: 1 });
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    const batch = context(tablet).beanBatchId;
    // Away for longer than twice the poll, so the plugin drops the Recipe; back, it restores its selection, which loads it.
    dye2.unload();
    await loads(machine, null);
    await dye2.load();
    await loads(machine, one);
    expect(named(tablet)).toBe(one);

    // Away again, and the Brazil's batch picked meanwhile: the selection DYE2 restores was made on the other batch.
    dye2.unload();
    await loads(machine, null);
    const brazilBatch = inSlot(tablet, "2")!.beanBatchId;
    expect(brazilBatch).not.toBe(batch);
    await tablet.changeSettings({ context: { beanBatchId: brazilBatch } });
    await dye2.load();
    // DYE2's field still names it, which the server reads as loaded: the field cannot tell the selection was made on
    // another batch. The plugin, which can, writes nothing of it into the Workflow, nor lets the server's write.
    await loads(machine, one);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(context(tablet).beanBatchId).toBe(brazilBatch);
    // DYE2 keeps it until the Workflow's next change, which it clears it on, recording nothing into it, and the Recipe
    // unloads.
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: "1" });
    const dose = (await recipe(one)).content.dose;
    await tablet.changeSettings({ context: { targetDoseWeight: 21.5 } });
    expect(dye2.selected()).toBeNull();
    await loads(machine, null);
    expect(named(tablet)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await recipe(one)).content.dose).toBe(dose);
    expect(context(tablet).beanBatchId).toBe(brazilBatch);
    expect(storedByPlugin(tablet)).toEqual([]);
  });

  it("unloads nothing and writes nothing to DYE2's storage while DYE2 answers 404 as it reloads, nor on its first answer of none before it restores its selection", async () => {
    const { machine, tablet, dye2, one } = await lab("Reload", 47091);
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await loads(machine, one);
    await expect.poll(() => tablet.storeValue(DYE2_NAMESPACE, "selection")).toMatchObject({ kind: "recipe", id: "1" });
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
    expect(storedByPlugin(tablet)).toEqual([]);
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
