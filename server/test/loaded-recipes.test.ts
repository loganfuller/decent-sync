import { GLOBAL_ID_KEY, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { recipeIdInWorkflow, recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import {
  DYE2_NAMESPACE,
  SimulatedDye2,
  dye2List,
  dye2ProfileFingerprint,
  dye2RecipeIdOf,
  openDye2Dashboard,
  openDye2RecipeEditor,
  recordedDye2MainTablet,
  selectRecipeInDye2,
} from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #145, #177, #188, #189 and #216: each Machine's Loaded
// Recipe (ADR-0022) is the recipe its Workflow names by its record's id
// (`context.extras.dye.recipeId`), in a Recipe Slot or not. Applying a
// recipe, from DYE2's dashboard or Select Recipe page or Streamline's strip,
// names it there, and the plugin loads it, writing into the Workflow what
// applying it leaves out, as its Basket, or a stale copy got wrong, as its
// Profile, which it writes in one write, through which DYE2 keeps the recipe
// named (decentespresso/dye2#38, #43). A profile change, a favourite applied,
// Streamline's DYE2 switch turned off or its Clear button on the selected
// recipe clears the field, which unloads it; another batch or grinder does
// not, and nor does a restart of DYE2. The plugin has DYE2 save each change
// of the Workflow while a Recipe is loaded (`record`), and reports the recipes
// it saved at once, never into a recipe applied while the save waited its
// turn; the server unloads one by having the plugin clear the field.
// Through the built plugin in simulated tablets running DYE2 v0.1.33 and
// Streamline v0.2.21 as recorded (fixtures/decaid/dye2-v0.1.26/), on two
// server instances sharing one database, with assertions through the REST
// API and what each simulated tablet holds. Serials are made up, from 47001.

type Record_ = Record<string, unknown>;

interface LoadedView {
  id: string;
  recipe: { id: string; name: string | null; slot: number | null; locationId: string | null; archived: boolean };
  loadedAt: string;
  unloadedAt: string | null;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** All four hot water settings the Ethiopia's Recipe is given in the management interface. */
const HOT_WATER = { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 };

/** The recording's tablet's record ids: the Ethiopia's recipe, in no Recipe Slot, and the Brazil's, in slot 2. */
const ETHIOPIA = "1";
const BRAZIL = "2";
/** The recording's blank recipe, naming no Bean, hidden from the strip in its stripSlot 3, so in no slot. */
const BLANK = "3";

/** The recording's tablet's ids for its batch of the Brazil, and for the grinder its recipes name none of. */
const RECORDED_BRAZIL_BATCH = "f4d73c51-7660-48ca-8deb-4c301443f2ce";
const RECORDED_GRINDER_83 = "f3d11140-520f-4d6c-a4c9-d79c217dffc8";

/** The recording's baskets, by the tablet's ids: the Ethiopia's recipe's, and the Brazil's and the Workflow's. */
const BASKET_18 = "8f9702df-a615-4942-84db-882137fedcce";
const BASKET_20 = "9567d681-444c-4492-95cd-29ecbc48870d";

/** The Ethiopia's recipe's profile, `Adaptive v3`, by its id; the Workflow's and the Brazil's is `Classic Italian espresso`. */
const ADAPTIVE = "profile:98fa00c191551b435845";

/** What the plugin and DYE2 write to clear the recipe the Workflow names. */
const CLEARED = { context: { extras: { dye: { recipeId: null } } } };

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
    await server?.stop();
  });

  const records = (tablet: SimulatedTablet) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []);
  /** The tablet's recipe with that record id. */
  const record = (tablet: SimulatedTablet, id: string) => records(tablet).find((entry) => entry.id === id);
  const variables = (entry: Record_ | undefined) => (entry?.dashboardVariables ?? {}) as Record_;
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const extras = (tablet: SimulatedTablet) => (context(tablet).extras ?? {}) as Record_;
  const temperatures = (tablet: SimulatedTablet) => ((tablet.workflow().profile as Record_).steps as Record_[]).map((step) => step.temperature);
  /** The Recipe the tablet's Workflow names, through its records, or null. */
  const named = recipeNamedInWorkflow;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: LoadedView | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe;
  const history = async ({ machine }: CreatedMachine) =>
    (await (await api.call("GET", `/machines/${machine.id}/loaded-recipes`)).json()) as { entries: LoadedView[]; total: number };
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) =>
    expect.poll(async () => (await loadedRecipe(machine))?.recipe.id ?? null, { timeout: 15_000 }).toBe(recipeId);
  const recipe = async (id: string) => (await api.get<{ recipe: { slot: number | null; content: Record_ } }>(`/recipes/${id}`)).recipe;
  /** The writes of DYE2's stored selection the plugin made, besides DYE2's own mirror of it: none. */
  const storedByPlugin = (tablet: SimulatedTablet) => tablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "selection");
  /** How many times the plugin posted to one of DYE2's routes. */
  const posts = (tablet: SimulatedTablet, route: "selection" | "record") => tablet.writes.filter((write) => write === `POST /plugins/${DYE2_NAMESPACE}/${route}`).length;
  /** The global id of the Library item the tablet holds under that id, by the global id its record carries. */
  const globalOf = async (tablet: SimulatedTablet, route: string, localId: string) => {
    const listed = (await tablet.callApi("GET", `${route}?includeArchived=true`)).body as Record_[];
    return (listed.find((entry) => entry.id === localId)?.extras as Record_ | undefined)?.[GLOBAL_ID_KEY];
  };
  /** The Machine's latest Workflow as the server holds it, or null. */
  const storedWorkflow = async ({ machine }: CreatedMachine) =>
    (await api.get<{ workflow: { workflow: Record_ } | null }>(`/machines/${machine.id}/workflow`)).workflow?.workflow ?? null;
  /** Whether the plugin has answered every write of a Loaded Recipe the server sent the tablet from `from` on, one at least, and the server has acknowledged each answer. */
  const answeredWrites = (tablet: SimulatedTablet, from: number) => {
    const writes = (tablet.received.slice(from) as Record_[]).filter((frame) => frame.type === "write" && frame.kind === "loadedRecipe");
    return writes.length > 0 && writes.every((write) => tablet.acknowledgedSome((frame: Record_) => frame.id === write.id && (frame.type === "written" || frame.type === "writeRefused")));
  };

  /**
   * A Location with a Machine whose tablet is the v0.1.26 recording's, its
   * DYE2 loaded, on the instance given: joining a Location with no Recipes,
   * it brings its eight recipes, each written back with its Recipe's id under
   * its own record id, and the Ethiopia's Recipe is given all four hot water
   * settings (`HOT_WATER`) in the management interface. `quiet()` resolves
   * once the tablet, its DYE2, the Machine and the Streamlines given have
   * nothing left under way (`quiesced`), so a wrong write a step set off has
   * landed before a check after it that it did not happen. A lab given a
   * `pollSeconds` polls too seldom to wait for, so its `quiet()` waits for no
   * poll, and a site there waits first for what its change causes.
   */
  async function lab(
    scenario: string,
    serial: number,
    options: {
      instance?: TestServer;
      pollSeconds?: number;
      dye2?: SimulatedDye2;
      apiDelayMs?: (method: string, path: string) => number;
      answerOnArrival?: boolean;
      timeScale?: number;
    } = {},
  ) {
    const here: LocationView = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machine = await api.createMachine(`${scenario} lab 1`, here.id);
    const dye2 = options.dye2 ?? new SimulatedDye2();
    const tablet = syncingTablet(machine, options.instance ?? server, {
      api: recordedDye2MainTablet(String(serial), scenario),
      dye2,
      pollSeconds: options.pollSeconds,
      apiDelayMs: options.apiDelayMs,
      answerOnArrival: options.answerOnArrival,
      timeScale: options.timeScale,
    });
    await api.waitForOnline(machine);
    await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => dye2GlobalIdOf(record(tablet, id))), { timeout: 15_000 }).not.toContain(null);
    const ethiopia = dye2GlobalIdOf(record(tablet, ETHIOPIA))!;
    const brazil = dye2GlobalIdOf(record(tablet, BRAZIL))!;
    const edit = async (recipeId: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${recipeId}`, { content })).status).toBe(200);
    await edit(ethiopia, { hotWaterVolume: HOT_WATER.volume, hotWaterTemperature: HOT_WATER.targetTemperature, hotWaterDuration: HOT_WATER.duration, hotWaterFlow: HOT_WATER.flow });
    await expect
      .poll(() => {
        const held = variables(record(tablet, ETHIOPIA));
        return { targetTemperature: held.hotWaterTempC, duration: held.hotWaterTimeS, volume: held.hotWaterMl, flow: held.hotWaterFlowMls };
      })
      .toEqual(HOT_WATER);
    const quiet = (streamlines: Record<string, SimulatedStreamline> = {}) =>
      quiesced(api, { tablets: { tablet }, machines: { machine }, streamlines, polls: options.pollSeconds === undefined });
    return { here, machine, tablet, dye2, ethiopia, brazil, edit, quiet };
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

  it("loads a recipe in no slot applied from DYE2's Select Recipe page, which applies its batch, brew temperature and hot water and names it in the Workflow, with its Basket, which a Shot pulled then carries", async () => {
    const { machine, tablet, ethiopia } = await lab("Select", 47001);
    const applied = record(tablet, ETHIOPIA)!;
    expect(applied.stripSlot).toBeNull();
    const held = variables(applied);
    expect(applied.beanBatchId).toEqual(expect.any(String));
    expect(await loadedRecipe(machine)).toBeNull();
    // Another Bean's batch, and another Basket, are in the Workflow as it is applied.
    await tablet.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH, extras: { basketId: BASKET_20 } } });

    const writes = workflowWrites(tablet);
    const page = await selectRecipeInDye2(tablet, ETHIOPIA);
    expect(page.applied?.workflow?.status).toBe(200);
    await loads(machine, ethiopia);
    expect([recipeIdInWorkflow(tablet), named(tablet)]).toEqual([ETHIOPIA, ethiopia]);
    expect(context(tablet)).toMatchObject({ beanBatchId: applied.beanBatchId, grinderId: held.grinderId, targetDoseWeight: held.dose, targetYield: held.drink });
    // DYE2 never applies the Basket: the plugin's load writes it.
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_18);
    expect(extras(tablet).rpm).toBe(held.rpm);
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
    // Adaptive v3 at the Recipe's 92 °C: its first step at 92, every other a degree cooler than its own, as DYE2 applies it
    // (decentespresso/dye2#26). The plugin's load writes no profile, nor the recipe's id, which DYE2 named.
    expect(temperatures(tablet).slice(0, 3)).toEqual([92, 92, 87]);
    expect(writes.some((write) => "hotWaterData" in write)).toBe(false);
    expect(writes.some((write) => "profile" in write)).toBe(false);
    expect(writes.some((write) => "beanBatchId" in ((write.context as Record_ | undefined) ?? {}))).toBe(false);
    expect(JSON.stringify(writes)).not.toContain("recipeId");
    expect(await history(machine)).toMatchObject({ total: 1, entries: [{ recipe: { id: ethiopia, slot: null, archived: false }, unloadedAt: null }] });

    tablet.pullShot(shotOf(tablet, "loaded-recipe-shot-47001", 47001));
    await expect.poll(async () => (await api.call("GET", "/shots/loaded-recipe-shot-47001")).status, { timeout: 15_000 }).toBe(200);
    expect((await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/loaded-recipe-shot-47001")).shot.recipe?.id).toBe(ethiopia);
  });

  it("loads a recipe in a slot applied from Streamline's strip on a tablet on the other instance, which applies its batch, Grinder and Basket and names it twice", async () => {
    const { machine, tablet, brazil, quiet } = await lab("Strip", 47011, { instance: other });
    // The Workflow on another Basket and no batch, which the strip applies the Recipe's of from the record's embedded Workflow.
    await tablet.changeSettings({ context: { beanBatchId: null, extras: { basketId: BASKET_18 } } });
    const writes = workflowWrites(tablet);
    const streamline = await startStreamline(tablet);
    expect(streamline.cells().find((cell) => cell.slot === 2)?.recipe?.id).toBe(BRAZIL);
    const workflows: Record_[] = [];
    tablet.onWorkflowChange((workflow) => workflows.push(workflow));
    const applied = await streamline.applyRecipe(2);
    expect([applied.workflow?.status, applied.selection?.status, applied.refused]).toEqual([200, 200, undefined]);
    await loads(machine, brazil);
    // Its patch names the recipe, and DYE2's selection route names it again.
    expect(workflows.filter((workflow) => dye2RecipeIdOf(workflow) === BRAZIL).length).toBeGreaterThanOrEqual(2);
    expect(named(tablet)).toBe(brazil);
    const held = variables(record(tablet, BRAZIL));
    expect(extras(tablet)).toMatchObject({ basketId: held.basketId, rpm: held.rpm });
    expect(context(tablet)).toMatchObject({ beanBatchId: record(tablet, BRAZIL)!.beanBatchId, grinderId: held.grinderId });
    expect(writes.some((write) => "profile" in write)).toBe(false);
    // Once the load's write, its report and Streamline's replies are done.
    await quiet({ streamline });
    expect((await loadedRecipe(machine))?.recipe.id).toBe(brazil);
    expect((await history(machine)).total).toBe(1);
  });

  it("keeps the Recipe loaded through a dial tap and Done on DYE2's dashboard, which send only the page's own edits, the tap's grind saved into the Recipe", async () => {
    const { machine, tablet, brazil, quiet } = await lab("Copy", 47021);
    // The tablet's Workflow holds the other Recipe's Basket as the page opens, which DYE2's apply leaves and the load writes.
    await tablet.changeSettings({ context: { extras: { basketId: BASKET_18 } } });
    const dashboard = await openDye2Dashboard(tablet);
    expect(dashboard.recipePills().map((pill) => pill.id)).toContain(BRAZIL);
    await dashboard.applyRecipe(BRAZIL);
    await loads(machine, brazil);
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_20);

    // The tap sends its grind alone, over the page's copy of the Workflow from before the load's write (decentespresso/dye2#31).
    expect((await dashboard.tap("grind", 2.6))?.status).toBe(200);
    expect(dashboard.lastSent).toEqual({ context: { grinderSetting: "2.6" } });
    await expect.poll(async () => (await recipe(brazil)).content.grindSetting, { timeout: 15_000 }).toBe(2.6);
    expect(await dashboard.done()).toBeUndefined();
    // Once the tap's report, DYE2's save of it and anything Done set off are done.
    await quiet();
    expect(extras(tablet).basketId).toBe(BASKET_20);
    expect(context(tablet).grinderSetting).toBe("2.6");
    expect((await loadedRecipe(machine))?.recipe.id).toBe(brazil);
    expect(named(tablet)).toBe(brazil);
    expect(context(tablet).beanBatchId).toBe(record(tablet, BRAZIL)!.beanBatchId);
    expect((await recipe(brazil)).content).toMatchObject({ basketId: expect.any(String), hotWaterVolume: 150 });
  });

  it("keeps a grinder a barista switches to while the plugin's load write is under way, which the Recipe takes, and keeps it loaded", async () => {
    let slow = false;
    // 25 s at the tablet's pace, within Decaid's 30 s fetch timeout: half a second here.
    const { machine, tablet, dye2, ethiopia, quiet } = await lab("Switched", 47101, { apiDelayMs: (method, path) => (slow && method === "PUT" && path === "/workflow" ? 25_000 : 0) });
    const grinder83 = await globalOf(tablet, "/grinders", RECORDED_GRINDER_83);
    expect(grinder83).toEqual(expect.any(String));
    // The Workflow on another Basket, which the plugin's load write is to write.
    await tablet.changeSettings({ context: { extras: { basketId: BASKET_20 } } });
    slow = true;
    const reads = tablet.requests.filter((route) => route === "/workflow").length;
    await selectRecipeInDye2(tablet, ETHIOPIA);
    // The plugin's write, slowed, lands after the barista's switch, which it leaves as the write sets no grinder.
    await expect.poll(() => tablet.requests.filter((route) => route === "/workflow").length).toBeGreaterThan(reads + 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await tablet.changeSettings({ context: { grinderId: RECORDED_GRINDER_83, grinderModel: "Fixture Grinder 83" } });
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_18);
    slow = false;
    await expect.poll(async () => (await recipe(ethiopia)).content.grinderId, { timeout: 15_000 }).toBe(grinder83);
    // Once the slowed load write's report, the switch's and DYE2's save of it are done.
    await quiet();
    expect(context(tablet).grinderId).toBe(RECORDED_GRINDER_83);
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    expect((await loadedRecipe(machine))?.recipe.id).toBe(ethiopia);
    expect((await history(machine)).total).toBe(1);
  });

  it("keeps the Recipe named after Decaid refused the server's write of its Profile, and unloads it on a barista's own profile, never naming it again", async () => {
    const { machine, tablet, dye2, ethiopia, quiet } = await lab("Refused profile", 47121, { pollSeconds: 3600 });
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    // Decaid refuses the Workflow write carrying the Recipe's new Profile, the one write the plugin makes of it.
    tablet.refuseWrites = ({ method, route, body }) =>
      method === "PUT" && route === "/workflow" && typeof body === "object" && body !== null && "profile" in body ? { status: 400, body: { error: "refused" } } : undefined;
    const classic = "profile:39e939592679fb194706";
    const written = tablet.writes.length;
    const received = tablet.received.length;
    expect((await api.call("PATCH", `/recipes/${ethiopia}`, { content: { profileId: classic } })).status).toBe(200);
    await expect.poll(() => tablet.writes.slice(written).filter((write) => write === "PUT /workflow").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    // The site's own wait, as the tablet polls too seldom to wait for: the plugin's answers to the server's writes,
    // acknowledged, and then nothing else under way.
    await expect.poll(() => answeredWrites(tablet, received), { timeout: 15_000 }).toBe(true);
    await quiet();
    tablet.refuseWrites = undefined;
    // The Workflow still names the recipe, on its old profile: DYE2 cleared nothing, and the server recorded no unload.
    expect(recipeIdInWorkflow(tablet)).toBe(ETHIOPIA);
    expect((tablet.workflow().profile as Record_).title).toBe("Adaptive v3");
    expect(dye2.cleared).toEqual([]);
    expect(await history(machine)).toMatchObject({ total: 1, entries: [{ unloadedAt: null }] });
    // The barista's own profile, which DYE2 clears the recipe on.
    const own = { ...(tablet.workflow().profile as Record_), title: "Barista's own" };
    expect((await tablet.callApi("PUT", "/workflow", { profile: own })).status).toBe(200);
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);
    // The site's own wait is the unload above, the server's reading of the Workflow DYE2 cleared; then nothing else under
    // way.
    await quiet();
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    expect((tablet.workflow().profile as Record_).title).toBe("Barista's own");
  });

  it("loads nothing for a Recipe's dial dialled in by hand, with no recipe named", async () => {
    const { machine, tablet, dye2, quiet } = await lab("Hand", 47041);
    const held = variables(record(tablet, ETHIOPIA));
    const adaptive = (((await tablet.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((profile) => profile.id === ADAPTIVE)!).profile;
    await tablet.changeSettings({ profile: adaptive as Record_, context: { targetDoseWeight: held.dose, targetYield: held.drink, grinderId: held.grinderId, grinderSetting: String(held.grind) } });
    // Once the change's report, and DYE2's checks of it, are done.
    await quiet();
    expect(dye2.selected()).toBeNull();
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    expect(await loadedRecipe(machine)).toBeNull();
    expect(posts(tablet, "record")).toBe(0);
  });

  it("unloads the Recipe as a favourite is applied, in DYE2 or Streamline, or the profile changes, which DYE2 clears it on and pushes", async () => {
    const { machine, tablet, dye2, ethiopia, brazil } = await lab("Unloads", 47051);
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    // A recent favourite's pill on DYE2's dashboard, the only favourites DYE2 makes.
    const dashboard = await openDye2Dashboard(tablet);
    expect((await dashboard.applyFavourite({ id: "recent:47051", auto: true, snapshot: { dose: 17.5 } })).workflow?.status).toBe(200);
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);

    // A favourite applied from Streamline's strip.
    const streamline = await startStreamline(tablet);
    await streamline.applyRecipe(2);
    await loads(machine, brazil);
    expect((await streamline.applyFavourite({ id: "favourite-47051", snapshot: { dose: 17.5 } })).workflow?.status).toBe(200);
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);

    // A change of profile, which DYE2 clears the recipe on, pushing once (decentespresso/dye2#24).
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    await dye2.settled();
    const pushed = dye2.pushes.length;
    const classic = (((await tablet.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((profile) => profile.id !== ADAPTIVE)!).profile;
    expect((await tablet.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    await dye2.settled();
    expect(dye2.cleared).toEqual([{ id: ETHIOPIA, cold: false }]);
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);
    expect(dye2.pushes.length).toBe(pushed + 1);
    // DYE2 mirrors the selection it derives into its storage itself; the plugin writes none.
    await expect.poll(() => tablet.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    expect(storedByPlugin(tablet)).toEqual([]);
    expect(posts(tablet, "selection")).toBe(0);
    expect((await history(machine)).total).toBe(3);
  });

  it("unloads the Recipe as Streamline's DYE2 switch is turned off, or its Clear button is used on the selected recipe, both of which clear the Workflow's recipe", async () => {
    const { machine, tablet, brazil } = await lab("Strip off", 47061, { pollSeconds: 3600 });
    const streamline = await startStreamline(tablet);
    await streamline.applyRecipe(2);
    await loads(machine, brazil);
    expect((await streamline.switchDye2Off())?.status).toBe(200);
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);

    const again = await startStreamline(tablet);
    await again.applyRecipe(2);
    await loads(machine, brazil);
    expect(await again.clearButton(2)).toBe(true);
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);
    // Hidden from the strip, it is taken out of its slot at its Location, as it is on the strip exactly while in one (DYE2 v0.1.32).
    await expect.poll(async () => (await recipe(brazil)).slot, { timeout: 15_000 }).toBeNull();
    // Its records are written so: hidden, in no slot.
    await expect.poll(() => (dye2List(tablet, "recipes") as Record<string, unknown>[]).find((record) => record.id === BRAZIL), { timeout: 15_000 }).toMatchObject({
      stripSlot: null,
      showOnStreamlineDashboard: false,
    });
  });

  it("takes a Recipe out of its slot as DYE2's editor hides it from the strip, as it holds no slot hidden", async () => {
    const { tablet, brazil, quiet } = await lab("Editor hide", 47301);
    expect((await recipe(brazil)).slot).toBe(2);
    // Once the server's first writes of the recording's records are done: the plugin posts DYE2's list whole, so one read
    // before the editor's save and posted after it would put the recipe back.
    await quiet();
    const { saved } = await (await openDye2RecipeEditor(tablet, { id: BRAZIL })).set({ showOnStreamlineDashboard: false }).save();
    expect([saved.stripSlot, saved.showOnStreamlineDashboard]).toEqual([null, false]);
    await expect.poll(async () => (await recipe(brazil)).slot, { timeout: 15_000 }).toBeNull();
    // As it is put in a slot again in the management interface, its record is written shown there.
    expect((await api.call("PUT", `/recipes/${brazil}/slot`, { slot: 2 })).status).toBe(200);
    await expect.poll(() => record(tablet, BRAZIL), { timeout: 15_000 }).toMatchObject({ stripSlot: 2, showOnStreamlineDashboard: true });
    expect((await recipe(brazil)).content).not.toHaveProperty("showOnDashboard");
  });

  it("keeps a Recipe in the slot DYE2's editor put it in while the server's write hiding it, as it left its last slot, waited for the plugin's read", async () => {
    // At 5x, so that Decaid's 30 s fetch timeout lets the plugin's reads be held for 6 s of real time; polling every hour,
    // so only DYE2's pushes have the plugin read its recipes.
    const { tablet, brazil, quiet } = await lab("Slot again", 47331, { timeScale: 5, pollSeconds: 3600 });
    const route = `/store/${DYE2_NAMESPACE}/recipes`;
    expect((await recipe(brazil)).slot).toBe(2);
    await quiet();
    // Tapping its own slot's tab in DYE2's editor takes it out of its slot, still shown, which the plugin reads at DYE2's
    // push, held.
    const report = tablet.holdRequests("GET", route);
    const received = tablet.received.length;
    const { saved } = await (await openDye2RecipeEditor(tablet, { id: BRAZIL })).tapSlot(2).save();
    expect([saved.stripSlot, saved.showOnStreamlineDashboard]).toEqual([null, true]);
    tablet.pushOnSocket(DYE2_NAMESPACE, "changed", { what: "workflow" });
    await expect.poll(() => report.arrived, { timeout: 15_000 }).toBeGreaterThan(0);
    // The server takes it out of its slot and writes it hidden. Every read of the list from then on is held, so the plugin
    // reads it for that write only after the barista has put the recipe in slot 3.
    const later = tablet.holdRequests("GET", route);
    report.release();
    const hiding = () =>
      tablet.received.slice(received).some((frame) => {
        const { type, kind, fields } = frame as { type?: unknown; kind?: unknown; fields?: Record_ };
        return type === "write" && kind === "recipe" && fields?.showOnStreamlineDashboard === false;
      });
    await expect.poll(hiding, { timeout: 15_000 }).toBe(true);
    await (await openDye2RecipeEditor(tablet, { id: BRAZIL })).tapSlot(3).save();
    later.release();
    tablet.pushOnSocket(DYE2_NAMESPACE, "changed", { what: "workflow" });
    await expect.poll(async () => (await recipe(brazil)).slot, { timeout: 15_000 }).toBe(3);
    await quiet();
    expect((await recipe(brazil)).slot).toBe(3);
    expect(record(tablet, BRAZIL)).toMatchObject({ stripSlot: 3, showOnStreamlineDashboard: true });
    // The write left it shown: the plugin never posted it hidden in slot 3.
    const hiddenInSlot = tablet.storeWrites.some(
      (write) => write.key === "recipes" && Array.isArray(write.value) && (write.value as Record_[]).some((entry) => entry.id === BRAZIL && entry.stripSlot === 3 && entry.showOnStreamlineDashboard === false),
    );
    expect(hiddenInSlot).toBe(false);
  });

  it("loads a Recipe naming no Bean, applied from DYE2's Select Recipe page or Streamline's strip, with no bean batch, which it takes none of, its records written the nulls for one where a tablet's lacks them, and takes a batch picked then", async () => {
    const { machine, tablet, ethiopia, edit, quiet } = await lab("No bean", 47311);
    await expect.poll(() => dye2GlobalIdOf(record(tablet, BLANK)), { timeout: 15_000 }).not.toBeNull();
    const blank = dye2GlobalIdOf(record(tablet, BLANK))!;
    expect((await recipe(blank)).content).not.toHaveProperty("beanId");
    const batchSet = () => tablet.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH, coffeeName: "No bean Fixture Brazil", coffeeRoaster: "Fixture Roasters" } });

    // From DYE2's Select Recipe page, which sends the nulls (DYE2 v0.1.32, ce38984): the load takes no batch into it.
    await batchSet();
    await selectRecipeInDye2(tablet, BLANK);
    await loads(machine, blank);
    expect([context(tablet).beanBatchId, context(tablet).coffeeName]).toEqual([undefined, undefined]);
    await quiet();
    expect((await recipe(blank)).content).not.toHaveProperty("beanId");
    expect((await recipe(blank)).content).not.toHaveProperty("beanBatchId");
    expect((await loadedRecipe(machine))?.recipe.id).toBe(blank);

    // Its record, as the server wrote it before DYE2 v0.1.32 and took the answer to that write in, lacks the nulls: it is
    // written them once, at the next write planned for the tablet, the plugin posting a record that differs in them alone.
    await quiet();
    const held = record(tablet, BLANK)!;
    const { coffeeName: _c, coffeeRoaster: _r, beanBatchId: _b, ...bare } = (held.workflow as { context: Record_ }).context;
    await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, records(tablet).map((entry) => (entry.id === BLANK ? { ...entry, workflow: { ...(entry.workflow as Record_), context: bare } } : entry)));
    const database = await server.connectDatabase();
    try {
      await database.query(`UPDATE tablet_recipes SET record = jsonb_set(record, '{workflow,context}', (record #> '{workflow,context}') - 'coffeeName' - 'coffeeRoaster' - 'beanBatchId') WHERE recipe_id = $1`, [blank]);
    } finally {
      await database.end();
    }
    await edit(ethiopia, { name: "No bean Ethiopia renamed" });
    await expect
      .poll(() => (record(tablet, BLANK)?.workflow as { context: Record_ }).context, { timeout: 15_000 })
      .toMatchObject({ coffeeName: null, coffeeRoaster: null, beanBatchId: null });

    // Put in a slot, Streamline's strip applies its embedded Workflow as it is, the nulls clearing the batch.
    expect((await api.call("PUT", `/recipes/${blank}/slot`, { slot: 5 })).status).toBe(200);
    await expect.poll(() => record(tablet, BLANK), { timeout: 15_000 }).toMatchObject({ stripSlot: 5, showOnStreamlineDashboard: true });
    await tablet.changeSettings(CLEARED);
    await loads(machine, null);
    await batchSet();
    const streamline = await startStreamline(tablet);
    await streamline.applyRecipe(5);
    await loads(machine, blank);
    expect([context(tablet).beanBatchId, context(tablet).coffeeName, context(tablet).coffeeRoaster]).toEqual([undefined, undefined, undefined]);
    await quiet({ streamline });
    expect((await recipe(blank)).content).not.toHaveProperty("beanId");
    // A batch picked while it is loaded is a change like any other: the Recipe takes it, with its Bean.
    await batchSet();
    await expect.poll(async () => (await recipe(blank)).content.beanBatchId, { timeout: 15_000 }).toEqual(expect.any(String));
    expect((await recipe(blank)).content.beanId).toEqual(expect.any(String));
    expect((await loadedRecipe(machine))?.recipe.id).toBe(blank);
  });

  it("saves a grind setting typed as text into the Recipe as typed, through DYE2 or itself, and keeps comparing numbers as numbers", async () => {
    const { machine, tablet, brazil, edit, quiet } = await lab("Grind text", 47321);
    const dashboard = await openDye2Dashboard(tablet);
    await dashboard.applyRecipe(BRAZIL);
    await loads(machine, brazil);
    // DYE2 saves it, as the Recipe's record holds a grind setting (DYE2 v0.1.32, d858b73).
    expect((await dashboard.tap("grind", "1.5."))?.status).toBe(200);
    await expect.poll(async () => (await recipe(brazil)).content.grindSetting, { timeout: 15_000 }).toBe("1.5.");
    // A Recipe holding none takes it from the Workflow itself, as typed.
    await edit(brazil, { grindSetting: null });
    await expect.poll(() => variables(record(tablet, BRAZIL)).grind ?? null, { timeout: 15_000 }).toBeNull();
    await tablet.changeSettings({ context: { grinderSetting: "fine" } });
    await expect.poll(async () => (await recipe(brazil)).content.grindSetting, { timeout: 15_000 }).toBe("fine");
    // A number set in the management interface reaches the Workflow, "3" there being the same as 3.
    await edit(brazil, { grindSetting: "3" });
    expect((await recipe(brazil)).content.grindSetting).toBe(3);
    await expect.poll(() => context(tablet).grinderSetting, { timeout: 15_000 }).toBe("3");
    await quiet();
    expect((await recipe(brazil)).content.grindSetting).toBe(3);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(brazil);
  });

  it("reports a dial change it has DYE2 save into the Recipe at once, long before the plugin's next poll of the tablet's lists", async () => {
    // Polling every hour, 72 s at the tablet's time scale: only the save's own report has the plugin read its recipes sooner.
    const { machine, tablet, dye2, brazil } = await lab("Recorded", 47141, { pollSeconds: 3600 });
    const dashboard = await openDye2Dashboard(tablet);
    await dashboard.applyRecipe(BRAZIL);
    await loads(machine, brazil);
    expect((await dashboard.tap("grind", 2.8))?.status).toBe(200);
    await expect.poll(async () => (await recipe(brazil)).content.grindSetting, { timeout: 10_000 }).toBe(2.8);
    expect(dye2.recorded.at(-1)).toMatchObject({ id: BRAZIL, patch: { grind: 2.8 } });
  });

  it("has DYE2 save a Workflow change only while a Recipe is loaded, not its load or the plugin's own writes, and unloads one Archived by clearing the recipe from the Workflow", async () => {
    const { machine, tablet, dye2, ethiopia, quiet } = await lab("Saves", 47151, { pollSeconds: 3600 });
    // Nothing loaded: a change of the Workflow is sent as it is, and nothing is saved.
    await tablet.changeSettings({ context: { targetDoseWeight: 19 } });
    await tablet.changeSettings({ context: { targetDoseWeight: 19.5 } });
    // The site's own wait, as the tablet polls too seldom to wait for: the server holds the Workflow the second change
    // made; then nothing else under way.
    await expect.poll(async () => ((await storedWorkflow(machine))?.context as Record_ | undefined)?.targetDoseWeight, { timeout: 15_000 }).toBe(19.5);
    await quiet();
    expect(posts(tablet, "record")).toBe(0);

    // The change that loads a Recipe, a stale copy's maybe, and the plugin's load write are saved into nothing.
    await tablet.changeSettings({ context: { extras: { basketId: BASKET_20 } } });
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_18);
    // The site's own wait is the load's write above; then its report and anything else under way.
    await quiet();
    expect(posts(tablet, "record")).toBe(0);
    // With it loaded, each change is.
    await tablet.changeSettings({ context: { targetDoseWeight: 18.8 } });
    await expect.poll(() => posts(tablet, "record")).toBe(1);
    await expect.poll(async () => (await recipe(ethiopia)).content.dose, { timeout: 15_000 }).toBe(18.8);
    expect(dye2.recorded.at(-1)).toMatchObject({ id: ETHIOPIA, patch: { dose: 18.8 } });

    // Archived, the server unloads it: the plugin clears the recipe from the Workflow, as DYE2 does, posting no selection.
    const writes = workflowWrites(tablet);
    expect((await api.call("PUT", `/recipes/${ethiopia}/archived`, { archived: true })).status).toBe(200);
    await expect.poll(() => recipeIdInWorkflow(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);
    expect(writes).toContainEqual(CLEARED);
    expect(posts(tablet, "selection")).toBe(0);
    expect(dye2.cleared).toEqual([]);
    await expect.poll(() => record(tablet, ETHIOPIA), { timeout: 15_000 }).toBeUndefined();
    expect((await history(machine)).total).toBe(1);
  });

  it("loads a recipe named with none of its values applied, as through DYE2's selection route, writing its Profile in one write that keeps it named", async () => {
    const { machine, tablet, dye2, ethiopia, quiet } = await lab("Named", 47071, { pollSeconds: 3600 });
    expect((tablet.workflow().profile as Record_).title).toBe("Classic Italian espresso");
    const writes = workflowWrites(tablet);
    // A recipe named with no change of anything else, as Streamline's strip names one again: the load writes it all.
    expect((await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: ETHIOPIA })).status).toBe(200);
    await loads(machine, ethiopia);
    await expect.poll(() => (tablet.workflow().profile as Record_).title, { timeout: 15_000 }).toBe("Adaptive v3");
    await dye2.settled();
    // The site's own wait is the load's Profile above, and DYE2 settled; then the load's reports and anything else under way.
    await quiet();
    // Its Profile is written with the rest in one write, naming no recipe, through which DYE2 keeps the recipe the
    // Workflow names, as the profile is its record's own, and takes it as the profile it was named on
    // (decentespresso/dye2#38, #43). Nothing clears the recipe: a write of the server's that may follow, planned from the
    // Workflow the load wrote over, writes the same profile again.
    expect(writes[0]).toHaveProperty("profile");
    expect(((writes[0]!.context as Record_).extras as Record_).dye).toBeUndefined();
    expect(writes).not.toContainEqual(CLEARED);
    expect(dye2.cleared).toEqual([]);
    expect(dye2.baseline()?.profileFingerprint).toBe(dye2ProfileFingerprint(tablet.workflow().profile));
    expect(recipeIdInWorkflow(tablet)).toBe(ETHIOPIA);
    expect(temperatures(tablet)[0]).toBe(92);
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 18, grinderSetting: "2.5" });
    expect(extras(tablet)).toMatchObject({ basketId: BASKET_18, rpm: 900 });
    // The server read no unload.
    expect(await history(machine)).toMatchObject({ total: 1, entries: [{ recipe: { id: ethiopia }, unloadedAt: null }] });
  });

  it("saves nothing of a change made on one Recipe into another applied while that save waited its turn, which loads with its own Basket and dial", async () => {
    let slow = false;
    // The plugin's reads of DYE2's recipes, which its save into the Loaded Recipe takes its turn among, each half a second.
    const { machine, tablet, dye2, ethiopia, brazil, quiet } = await lab("Next recipe", 47161, { apiDelayMs: (method, path) => (slow && method === "GET" && path === `/store/${DYE2_NAMESPACE}/recipes` ? 25_000 : 0) });
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_18);
    // Once the load's write and its report are done, before the reads are slowed.
    await quiet();
    const held = (await recipe(brazil)).content;
    expect(held).toMatchObject({ dose: 19, grindSetting: 3 });
    slow = true;
    // A read under way: the save the grind change asks for waits behind it, and the Brazil's recipe is applied meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await tablet.changeSettings({ context: { grinderSetting: "3.4" } });
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
    slow = false;
    await loads(machine, brazil);
    // Its load writes its own Basket, and the Ethiopia's dial is saved into it nowhere.
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_20);
    // Once the save that waited its turn, the Brazil's load and their reports are done.
    await quiet();
    expect(dye2.recorded.filter((recorded) => recorded.id === BRAZIL)).toEqual([]);
    expect((await recipe(brazil)).content).toEqual(held);
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 19, grinderSetting: "3" });
  });

  it("saves nothing into another Recipe applied while a save's read of the Workflow, which still named the first, was on its way back", async () => {
    let slow = false;
    // The save's read of the Workflow is answered as it arrives, naming the Ethiopia, but reaches the plugin half a second
    // later (25 s of the tablet's clock, which runs 50 times faster).
    const { machine, tablet, dye2, ethiopia, brazil, quiet } = await lab("Late read", 47171, {
      answerOnArrival: true,
      apiDelayMs: (method, path) => (slow && method === "GET" && path === "/workflow" ? 25_000 : 0),
    });
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_18);
    // Once the load's write and its report are done, before the read of the Workflow is slowed.
    await quiet();
    const held = (await recipe(brazil)).content;
    slow = true;
    await tablet.changeSettings({ context: { grinderSetting: "3.4" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
    // A race test's ordering sleep, which #297 leaves as it is: the save's slowed read comes back, naming the Ethiopia, before
    // reads are answered at once again.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    slow = false;
    await loads(machine, brazil);
    await expect.poll(() => extras(tablet).basketId, { timeout: 15_000 }).toBe(BASKET_20);
    // Once the save whose read came back late, the Brazil's load and their reports are done.
    await quiet();
    expect(dye2.recorded.filter((recorded) => recorded.id === BRAZIL)).toEqual([]);
    expect((await recipe(brazil)).content).toEqual(held);
  });

  it("saves nothing of another Recipe applied while a load's read of the Workflow, which still named the first, was on its way back, as the load's write names no recipe over it", async () => {
    let slow = false;
    // The load's read of the Workflow is answered as it arrives, naming the Ethiopia, but reaches the plugin half a second
    // later (25 s of the tablet's clock, which runs 50 times faster).
    const { tablet, dye2, ethiopia, brazil, quiet } = await lab("Late load", 47181, {
      answerOnArrival: true,
      apiDelayMs: (method, path) => (slow && method === "GET" && path === "/workflow" ? 25_000 : 0),
    });
    const [held, heldBrazil] = [(await recipe(ethiopia)).content, (await recipe(brazil)).content];
    // The Ethiopia applied from an out-of-date copy: its dial, on the Workflow's other profile, which its load writes over.
    const dial = variables(record(tablet, ETHIOPIA));
    const brazilDose = variables(record(tablet, BRAZIL)).dose;
    expect(brazilDose).not.toBe(dial.dose);
    const workflows: Record_[] = [];
    tablet.onWorkflowChange((workflow) => workflows.push(workflow));
    slow = true;
    expect((await tablet.callApi("PUT", "/workflow", { context: { targetDoseWeight: dial.dose, grinderSetting: String(dial.grind), extras: { dye: { recipeId: ETHIOPIA } } } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
    // A race test's ordering sleep: the load's slowed read comes back, naming the Ethiopia, and its write lands on the
    // Brazil's Workflow, before reads are answered at once again.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    slow = false;
    // The window was hit: the load's write of the Ethiopia's profile landed on the Brazil's Workflow, its dose the Brazil's,
    // which the write left as the read it was planned from held the Ethiopia's.
    const landed = (workflow: Record_) => (workflow.profile as Record_).title === "Adaptive v3" && (workflow.context as Record_).targetDoseWeight === brazilDose;
    await expect.poll(() => workflows.some(landed), { timeout: 15_000 }).toBe(true);
    // Once the load's write, what it set off and their reports are done.
    await quiet();
    // The Brazil's values, which the write left, are saved into no Recipe, and the Ethiopia is not named over the Brazil.
    expect(dye2.recorded.filter((recorded) => recorded.id === ETHIOPIA)).toEqual([]);
    expect((await recipe(ethiopia)).content).toEqual(held);
    expect((await recipe(brazil)).content).toEqual(heldBrazil);
    expect(recipeIdInWorkflow(tablet)).not.toBe(ETHIOPIA);
  });

  it("keeps the Recipe loaded through another grinder, a batch of another Bean and a batch cleared, which DYE2 clears nothing on, a Shot pulled on another Bean's batch linked to it", async () => {
    const { machine, tablet, dye2, ethiopia, quiet } = await lab("Bean", 47081);
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    const changes: Record_[] = [{ grinderId: RECORDED_GRINDER_83, grinderModel: "Fixture Grinder 83" }, { beanBatchId: RECORDED_BRAZIL_BATCH }, { beanBatchId: null }, { beanBatchId: RECORDED_BRAZIL_BATCH }];
    for (const change of changes) {
      await tablet.changeSettings({ context: change });
      await dye2.settled();
      expect(dye2.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
      expect(recipeIdInWorkflow(tablet)).toBe(ETHIOPIA);
    }
    // Once the last change's report, and DYE2's checks of it, are done.
    await quiet();
    expect((await loadedRecipe(machine))?.recipe.id).toBe(ethiopia);
    expect(dye2.cleared).toEqual([]);
    expect((await history(machine)).total).toBe(1);
    // The Machine's own batch of another Bean stays.
    expect(context(tablet).beanBatchId).toBe(RECORDED_BRAZIL_BATCH);
    tablet.pullShot(shotOf(tablet, "loaded-recipe-shot-47081", 47081));
    await expect.poll(async () => (await api.call("GET", "/shots/loaded-recipe-shot-47081")).status, { timeout: 15_000 }).toBe(200);
    expect((await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/loaded-recipe-shot-47081")).shot.recipe?.id).toBe(ethiopia);
  });

  it("keeps a loaded Recipe loaded across a DYE2 restart, saving a change after it, and loads it again as DYE2 comes back from being away", async () => {
    const { machine, tablet, dye2, ethiopia, quiet } = await lab("Restart", 47131);
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    // An update of DYE2, as Decaid's auto-update makes every 12 hours: Decaid sends DYE2 the Workflow as it loads it, which
    // DYE2 takes as its baseline, so its restart check keeps the recipe named.
    await dye2.reload();
    // Once DYE2's restart checks, and anything they set off, are done.
    await quiet();
    expect(dye2.cleared).toEqual([]);
    expect(recipeIdInWorkflow(tablet)).toBe(ETHIOPIA);
    expect(await history(machine)).toMatchObject({ total: 1, entries: [{ unloadedAt: null }] });
    await tablet.changeSettings({ context: { targetDoseWeight: 21 } });
    await expect.poll(async () => (await recipe(ethiopia)).content.dose, { timeout: 15_000 }).toBe(21);

    // Away for longer than twice the poll, the Machine has no Loaded Recipe; back, the Workflow still names it, which loads it.
    dye2.unload();
    await loads(machine, null);
    await dye2.load();
    await loads(machine, ethiopia);
    expect(named(tablet)).toBe(ethiopia);
    expect(dye2.cleared).toEqual([]);
    expect((await history(machine)).total).toBe(2);
    expect(storedByPlugin(tablet)).toEqual([]);
  });

  it("unloads nothing while DYE2 answers 404 for a moment as it restarts, and saves a change made then at the next change", async () => {
    // Polling every hour, so the plugin finds DYE2 away only by calling it.
    const { machine, tablet, dye2, ethiopia, quiet } = await lab("Reload", 47091, { pollSeconds: 3600 });
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await loads(machine, ethiopia);
    const dose = (await recipe(ethiopia)).content.dose;
    dye2.unload();
    // 404 meanwhile, through a change of the Workflow, which the plugin's call of DYE2 cannot save.
    await tablet.changeSettings({ context: { targetDoseWeight: 18.1 } });
    await expect.poll(() => posts(tablet, "record")).toBe(1);
    // The site's own wait is the plugin's call of DYE2 above, which Decaid answered 404; then the change's report and
    // anything else under way.
    await quiet();
    expect((await recipe(ethiopia)).content.dose).toBe(dose);
    await dye2.load();
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    // The next change has DYE2 save every value it holds that the Workflow holds otherwise, the dose set while it was away
    // included.
    await tablet.changeSettings({ context: { grinderSetting: "2.7" } });
    await expect.poll(async () => (await recipe(ethiopia)).content, { timeout: 15_000 }).toMatchObject({ dose: 18.1, grindSetting: 2.7 });
    expect((await loadedRecipe(machine))?.recipe.id).toBe(ethiopia);
    expect(named(tablet)).toBe(ethiopia);
    expect((await history(machine)).total).toBe(1);
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
