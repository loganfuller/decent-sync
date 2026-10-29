import { GLOBAL_ID_KEY, RECIPE_SETTINGS, dye2GlobalIdOf, dye2RecipeIdOf, workflowValueAt } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { recipeIdInWorkflow, recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import {
  DYE2_NAMESPACE,
  type Dye2Key,
  type Dye2Step,
  SimulatedDye2,
  dye2Library,
  dye2List,
  dye2NeverUsed,
  dye2PagesKeys,
  dye2Recording,
  openDye2Dashboard,
  openDye2RecipeEditor,
  recordedDye2MainTablet,
  replayWrites,
  selectRecipeInDye2,
} from "./support/simulated-dye2.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import type { SimulatedTablet, SimulatedTabletOptions } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #147, #189 and #216: each Shot is linked to the Recipe
// whose record id its Workflow's `recipeId` names, through the reporting
// tablet's map, in a Recipe Slot or not, where its Machine had it loaded as
// it was pulled, a Shot pulled while the tablet was offline included, and
// not to one that was not the Machine's Loaded Recipe then, as on a
// Capture-only Machine; a recipe Streamline's strip saves through DYE2's
// `save-recipe` joins the Location's Recipes under its id and slot, is
// written to every tablet there, and is loaded, the Shots pulled before its
// record was taken in linked to it; and each Shot is linked to the Basket
// DYE2 recorded, the Workflow's or the one its Edit Shot page sets, through
// the reporting tablet's map. The Shots list filters by both, and an Admin
// hard-deletes a Recipe no Shot is linked to, and a Basket or Tool no Shot or
// Recipe names, from every tablet. Through the built plugin in simulated
// tablets acting as DYE2 v0.1.32 and Streamline `main` at cec5664 do, with
// the steps recorded from them (fixtures/decaid/dye2-v0.1.26/), on two
// server instances sharing one database, with assertions through the REST
// API and what each simulated tablet holds. Serials are made up, from 49001.

type Record_ = Record<string, unknown>;

interface Link {
  id: string;
  name: string | null;
}

interface ShotView {
  id: string;
  recipe: Link | null;
  basket: Link | null;
}

interface FilterOptions {
  recipes: ((Link & { location: LocationView | null }) | null)[];
  baskets: (Link | null)[];
}

interface RecipeView {
  id: string;
  name: string | null;
  slot: number | null;
  content: Record_;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The time between a pulled Shot's samples. */
const SAMPLE_MS = 100;

/** The record ids of the recording's recipes (fixtures/decaid/dye2-v0.1.26/library.json): the library recipe in slot 1, the Brazil in slot 2, under the slot-number id DYE2 gave it before v0.1.25, and the Ethiopia, `1`, in no slot. */
const LIBRARY = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";
const BRAZIL = "2";
const ETHIOPIA = "1";
/** The recording tablet's id of the 18g Basket, which the Ethiopia names. */
const BASKET_18 = "8f9702df-a615-4942-84db-882137fedcce";
const CLASSIC = "profile:39e939592679fb194706";

/** DYE2's recipes route in Decaid's store. */
const RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;

describe("Shots linked to their Recipe and Basket, and the hard deletes those links decide", { timeout: 120_000 }, () => {
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

  const recording = dye2Recording<Record<string, Dye2Step>>("recording");

  const list = (tablet: SimulatedTablet, key: Dye2Key) => (Array.isArray(dye2List(tablet, key)) ? (dye2List(tablet, key) as Record_[]) : []);
  /** The tablet's DYE2 record of the recipe with that record id. */
  const recordWithId = (tablet: SimulatedTablet, id: string) => list(tablet, "recipes").find((record) => record.id === id);
  /** The tablet's DYE2 record of the item, by the global id it carries. */
  const recordOf = (tablet: SimulatedTablet, key: Dye2Key, id: string) => list(tablet, key).find((record) => dye2GlobalIdOf(record) === id);
  /** Each of the tablet's recipes as its record id, the Recipe it carries the global id of and its strip slot, by record id. */
  const recipeRecords = (tablet: SimulatedTablet) =>
    list(tablet, "recipes")
      .map((record) => [record.id, dye2GlobalIdOf(record), record.stripSlot ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const extras = (tablet: SimulatedTablet) => (((tablet.workflow().context ?? {}) as Record_).extras ?? {}) as Record_;
  /** The Recipe the tablet's Workflow names by its `recipeId`, through the tablet's records, or null. */
  const named = recipeNamedInWorkflow;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const recipesAt = async (location: LocationView) => (await api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`)).recipes;
  /** The Shot as the REST API reads it, once it is stored. */
  async function storedShot(id: string): Promise<ShotView> {
    await expect.poll(async () => (await api.call("GET", `/shots/${id}`)).status, { timeout: 15_000 }).toBe(200);
    return (await api.get<{ shot: ShotView }>(`/shots/${id}`)).shot;
  }
  /** The ids of the Shots a filtered list holds, in list order. */
  const listed = async (query: string) => (await api.get<{ shots: ShotView[] }>(`/shots?${query}`)).shots.map((shot) => shot.id);
  /** Whether the server has acknowledged a Workflow delivery from the tablet naming that record id. */
  const namedDelivered = (tablet: SimulatedTablet, recordId: string) =>
    tablet.acknowledgedSome((frame: Record_) => frame.type === "workflow" && dye2RecipeIdOf(frame.workflow) === recordId);

  /**
   * Holds the plugin's reads of DYE2's recipes back, for a tablet given its
   * `tabletOptions`: from `hold()`, which resolves as the plugin's
   * collection poll next sends one, that read answered at once, each later
   * one times out, until `release()`. Each is answered from Decaid's store
   * as it arrives (`answerOnArrival`), so the poll's read, the last before
   * the hold, never brings what DYE2 saves once it resolves, as a read
   * answered after its delay would (#235). The poll's read is told apart by
   * the plugin's function on the stack (`readCollection`), so timing the
   * hold adds no request.
   */
  function recipeReadsHold() {
    let held = false;
    let begin: (() => void) | undefined;
    const apiDelayMs = (method: string, path: string) => {
      if (method !== "GET" || path !== RECIPES) return 0;
      if (begin && new Error().stack?.includes("readCollection")) {
        begin();
        begin = undefined;
        held = true;
        return 0;
      }
      return held ? 30_000 : 0;
    };
    return {
      tabletOptions: { apiDelayMs, answerOnArrival: true },
      hold: () => new Promise<void>((resolve) => (begin = resolve)),
      release: () => {
        held = false;
      },
    };
  }

  /**
   * A Shot the tablet's Decaid saves as one pulled now ends: the fixture's
   * curves, recorded on the Machine of that serial, with the tablet's
   * Workflow as it stands, which Decaid copies onto it, and the changes given.
   * Its samples are a tenth of a second apart, so it started a moment ago.
   */
  function pull(tablet: SimulatedTablet, id: string, serial: number, changes: Record_ = {}): Record_ {
    const shot = pulledNow(tablet, id, serial, changes);
    tablet.pullShot(shot);
    return shot;
  }

  /** The Shot `pull` saves, not saved yet. */
  function pulledNow(tablet: SimulatedTablet, id: string, serial: number, changes: Record_ = {}): Record_ {
    const fixture = shotFixture();
    const samples = fixture.measurements as Record_[];
    const startedAt = Date.now() - (samples.length - 1) * SAMPLE_MS;
    const measurements = samples.map((sample, index) => ({
      ...sample,
      machine: { ...(sample.machine as Record_), timestamp: new Date(startedAt + index * SAMPLE_MS).toISOString().slice(0, -1) },
    }));
    const machine = { ...((fixture.workflow as Record_).machine as Record_), serialNumber: String(serial) };
    const workflow = { ...structuredClone(tablet.workflow()), machine };
    return { ...fixture, id, timestamp: new Date(startedAt).toISOString(), workflow, measurements, ...changes };
  }

  /**
   * The recording's tablet with this serial, as DYE2 v0.1.26's pages left it
   * (recordedDye2MainTablet): its eight recipes, some under the slot-number
   * ids DYE2 gave them before v0.1.25 and the rest under opaque ones, in
   * slots or not, and its two baskets, with the tools DYE2's equipment page
   * made at 2cf631c beside them; its beans' names begun with `scenario`, as
   * Beans are matched by name across a file's tests.
   */
  function recordedTablet(serial: number, scenario: string) {
    return { ...recordedDye2MainTablet(String(serial), scenario), [`/store/${DYE2_NAMESPACE}/equipment`]: dye2PagesKeys().equipment };
  }

  /**
   * A Location with a Machine whose tablet is the recording's
   * (`recordedTablet`), running DYE2 v0.1.32, on the first instance, the
   * first at the Location, so its recipes join its Recipes with their ids and
   * slots, and another whose tablet has never used DYE2, on the other, which
   * is written every one of them under the same id. Resolves with the
   * Recipes the library recipe, the Brazil and the Ethiopia are.
   */
  async function lab(scenario: string, serial: number, tabletOptions: Pick<SimulatedTabletOptions, "apiDelayMs" | "answerOnArrival"> = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machine = await api.createMachine(`${scenario} lab A`, here.id);
    const second = await api.createMachine(`${scenario} lab B`, here.id);
    const tablet = syncingTablet(machine, server, { api: recordedTablet(serial, scenario), dye2: new SimulatedDye2(), ...tabletOptions });
    const neverUsed = syncingTablet(second, other, { api: dye2NeverUsed(String(serial + 1)), dye2: new SimulatedDye2() });
    await api.waitForOnline(machine, second);
    await expect.poll(async () => (await recipesAt(here)).length, { timeout: 15_000 }).toBe(8);
    await expect.poll(() => recipeRecords(tablet).every(([, id]) => id !== null)).toBe(true);
    await expect.poll(() => recipeRecords(neverUsed)).toEqual(recipeRecords(tablet));
    const idOf = (recordId: string) => dye2GlobalIdOf(recordWithId(tablet, recordId))!;
    /**
     * Resolves once both tablets, their DYE2s, both Machines and the Streamlines given have nothing left under way
     * (`quiesced`), so a wrong write or load a step set off has landed before a check after it that it did not happen.
     * While `recipeReadsHold` holds reads, a read is under way by design, so a site there waits on its own event instead.
     */
    const quiet = (streamlines: Record<string, SimulatedStreamline> = {}) => quiesced(api, { tablets: { tablet, neverUsed }, machines: { machine, second }, streamlines });
    return { here, machine, second, tablet, neverUsed, library: idOf(LIBRARY), brazil: idOf(BRAZIL), ethiopia: idOf(ETHIOPIA), quiet };
  }

  /** Applies the recipe's pill on DYE2's dashboard, and resolves once the Machine has its Recipe loaded. */
  async function load(tablet: SimulatedTablet, machine: CreatedMachine, recordId: string, recipeId: string): Promise<void> {
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(recordId)).workflow?.status).toBe(200);
    await expect.poll(() => named(tablet)).toBe(recipeId);
    await loads(machine, recipeId);
  }

  it("links a Shot pulled with a Recipe loaded to it and its Basket, in a slot or not, one pulled while the tablet was offline included, and filters by them", async () => {
    const { here, machine, tablet, library, ethiopia } = await lab("Linked", 49001);
    await load(tablet, machine, LIBRARY, library);
    const basket = (await recipe(library)).content.basketId as string;
    expect(basket).toEqual(expect.any(String));
    pull(tablet, "recipe-linked-online", 49001);
    expect(await storedShot("recipe-linked-online")).toMatchObject({ recipe: { id: library }, basket: { id: basket } });

    // Offline, the Ethiopia, in no slot, applied from DYE2's Select Recipe and a Shot pulled with it: both reach the server as
    // the tablet reconnects.
    tablet.loseNetwork();
    await api.waitForMachine(machine.machine.name, (viewed) => !viewed.online, 15_000);
    expect((await selectRecipeInDye2(tablet, ETHIOPIA)).applied?.workflow?.status).toBe(200);
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBe(ETHIOPIA);
    // DYE2 applies no Basket: the plugin's load writes the Ethiopia's, which the Shot then records.
    await expect.poll(() => extras(tablet).basketId).toBe(BASKET_18);
    pull(tablet, "recipe-linked-offline", 49001);
    tablet.restoreNetwork();
    await loads(machine, ethiopia);
    // The link is read from the Machine's Loaded Recipes, which the Workflow held back as the Shot was pulled brings.
    await expect.poll(async () => (await storedShot("recipe-linked-offline")).recipe?.id, { timeout: 15_000 }).toBe(ethiopia);
    const offline = await storedShot("recipe-linked-offline");
    expect(offline.recipe).toMatchObject({ id: ethiopia, name: "Fixture Ethiopia Espresso" });
    expect(offline.basket).toMatchObject({ id: (await recipe(ethiopia)).content.basketId });

    // A Shot pulled with no Recipe loaded, as after the Workflow's profile changed, which DYE2 clears the recipe on.
    const classic = (dye2Library()["/profiles"] as Record_[]).find((profile) => profile.id === CLASSIC)!.profile as Record_;
    await tablet.changeSettings({ profile: classic });
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);
    pull(tablet, "recipe-linked-none", 49001);
    expect((await storedShot("recipe-linked-none")).recipe).toBeNull();

    expect(await listed(`recipeId=${library}`)).toEqual(["recipe-linked-online"]);
    expect(await listed(`recipeId=${ethiopia}`)).toEqual(["recipe-linked-offline"]);
    expect(await listed(`recipeId=none&machineId=${machine.machine.id}`)).toEqual(["recipe-linked-none"]);
    expect(await listed(`basketId=${basket}`)).toContain("recipe-linked-online");
    const options = await api.get<FilterOptions>("/shots/filters");
    expect(options.recipes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: library, location: expect.objectContaining({ id: here.id }) }), expect.objectContaining({ id: ethiopia })]),
    );
    expect(options.recipes.at(-1)).toBeNull();
    expect(options.baskets).toEqual(expect.arrayContaining([expect.objectContaining({ id: basket })]));
    // A malformed id names nothing, as in a path.
    expect((await api.call("GET", "/shots?recipeId=not-a-recipe")).status).toBe(404);
    expect((await api.call("GET", "/shots?basketId=not-a-basket")).status).toBe(404);
  });

  it("does not link a Shot to the Recipe its Workflow names where it was not its Machine's Loaded Recipe as it was pulled, as on a Capture-only Machine", async () => {
    const { machine, tablet, library, brazil, quiet } = await lab("Capture-only", 49011);
    await load(tablet, machine, LIBRARY, library);
    expect((await api.call("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);

    // The Brazil applied from Streamline's strip while capture-only stays named in the Workflow, but is not its Loaded Recipe:
    // the plugin writes nothing there.
    const streamline = await startStreamline(tablet);
    const applied = await streamline.applyRecipe(2);
    expect(applied.workflow?.status).toBe(200);
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBe(BRAZIL);
    // Once the apply's report, Streamline's replies and anything they set off are done.
    await quiet({ streamline });
    const shot = pull(tablet, "recipe-capture-only", 49011);
    expect(dye2RecipeIdOf(shot.workflow)).toBe(BRAZIL);
    expect((await storedShot("recipe-capture-only")).recipe).toBeNull();

    // Sharing again, it is the Machine's Loaded Recipe from then on: the Shot pulled before stays unlinked.
    expect((await api.call("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: true })).status).toBe(200);
    await loads(machine, brazil);
    expect((await storedShot("recipe-capture-only")).recipe).toBeNull();
    expect(await listed(`recipeId=${brazil}`)).not.toContain("recipe-capture-only");
    pull(tablet, "recipe-sharing-again", 49011);
    expect((await storedShot("recipe-sharing-again")).recipe).toMatchObject({ id: brazil });
  });

  it("keeps a Shot linked to its Recipe through an edit sent after its record id passes to another Recipe, as its Machine moves to a Location holding that id", async () => {
    const { machine, tablet, brazil } = await lab("Id reused", 49091);
    await load(tablet, machine, BRAZIL, brazil);
    const shot = pull(tablet, "recipe-id-reused", 49091);
    expect((await storedShot("recipe-id-reused")).recipe).toMatchObject({ id: brazil });
    // Uptown's first Machine brings the recording's recipes too, so its Brazil's record id is `2` as well.
    const uptown = await api.createLocation("Id reused Uptown", "America/Chicago");
    const uptownMachine = await api.createMachine("Id reused Uptown A", uptown.id);
    const uptownTablet = syncingTablet(uptownMachine, other, { api: recordedTablet(49093, "Id reused Uptown"), dye2: new SimulatedDye2() });
    await api.waitForOnline(uptownMachine);
    await expect.poll(() => dye2GlobalIdOf(recordWithId(uptownTablet, BRAZIL)), { timeout: 15_000 }).toEqual(expect.any(String));
    const uptownBrazil = dye2GlobalIdOf(recordWithId(uptownTablet, BRAZIL))!;
    expect(uptownBrazil).not.toBe(brazil);

    await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: uptown.id }, 201);
    await expect.poll(() => dye2GlobalIdOf(recordWithId(tablet, BRAZIL)), { timeout: 15_000 }).toBe(uptownBrazil);
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
    // Rated on DYE2's Edit Shot page: the Shot still names `2`, which the tablet's map gives Uptown's Brazil now.
    const { measurements: _measurements, ...metadata } = shot;
    tablet.fire("shotUpdated", { id: shot.id, shot: { ...metadata, updatedAt: "2026-11-01T12:01:00Z", annotations: { enjoyment: 80 } } });
    await expect.poll(() => tablet.acknowledgedSome((frame: Record_) => frame.type === "shotUpdated" && frame.shotId === shot.id)).toBe(true);
    expect((await storedShot("recipe-id-reused")).recipe).toMatchObject({ id: brazil });
    expect(await listed(`recipeId=${uptownBrazil}`)).not.toContain("recipe-id-reused");
  });

  it("takes in a recipe Streamline's strip saves through save-recipe under its id and slot, writes it to every tablet at the Location, and loads it, linking the Shots pulled before its record was taken in", async () => {
    // The plugin's reads of DYE2's recipes time out while held, so the server is told of the Workflow naming the new recipe,
    // and of the Shot pulled with it, before its record.
    const unread = recipeReadsHold();
    const { here, machine, tablet, neverUsed } = await lab("Saved", 49101, unread.tabletOptions);
    const streamline = await startStreamline(tablet);

    // "Save to recipe 5" on the strip's empty fifth button: DYE2 makes a recipe of the Workflow there and names it in the Workflow.
    await unread.hold();
    const saved = await streamline.saveToRecipe(5);
    expect(saved.status).toBe(200);
    const { id: savedId } = saved.body as { id: string; name: string };
    expect(savedId).toMatch(/^recipe-/);
    expect(recipeIdInWorkflow(tablet)).toBe(savedId);
    // The site's own wait, as the recipe reads are held: the server has the Workflow naming the new recipe, which its map
    // holds no record of yet.
    await expect.poll(() => namedDelivered(tablet, savedId), { timeout: 15_000 }).toBe(true);
    pull(tablet, "recipe-saved-before-intake", 49101);
    expect((await storedShot("recipe-saved-before-intake")).recipe).toBeNull();
    expect(await loadedRecipe(machine)).toBeNull();

    // Read again: it joins the Location's Recipes in slot 5, is written to the other tablet under the same id and slot, is the
    // Machine's Loaded Recipe, and the Shot pulled before is linked to it.
    unread.release();
    await expect.poll(() => dye2GlobalIdOf(recordWithId(tablet, savedId)), { timeout: 15_000 }).toEqual(expect.any(String));
    const savedRecipe = dye2GlobalIdOf(recordWithId(tablet, savedId))!;
    expect((await recipe(savedRecipe)).slot).toBe(5);
    await expect.poll(() => recordWithId(neverUsed, savedId)).toMatchObject({ stripSlot: 5 });
    expect(dye2GlobalIdOf(recordWithId(neverUsed, savedId))).toBe(savedRecipe);
    await loads(machine, savedRecipe);
    await expect.poll(async () => (await storedShot("recipe-saved-before-intake")).recipe?.id, { timeout: 15_000 }).toBe(savedRecipe);
    expect(recipeIdInWorkflow(tablet)).toBe(savedId);

    // "Replace <name>" on the fourth button: the new recipe takes slot 4, and the one there leaves it, on every tablet, staying
    // at the Location.
    const newerSlot4 = dye2GlobalIdOf(list(tablet, "recipes").find((record) => record.stripSlot === 4))!;
    const replaced = await streamline.saveToRecipe(4);
    expect(replaced.status).toBe(200);
    const { id: replacingId } = replaced.body as { id: string };
    pull(tablet, "recipe-replacing", 49101);
    await expect.poll(() => dye2GlobalIdOf(recordWithId(tablet, replacingId)), { timeout: 15_000 }).toEqual(expect.any(String));
    const replacing = dye2GlobalIdOf(recordWithId(tablet, replacingId))!;
    await expect.poll(async () => (await recipesAt(here)).map((held) => [held.id, held.slot]).filter(([id]) => id === replacing || id === newerSlot4)).toEqual(
      expect.arrayContaining([
        [replacing, 4],
        [newerSlot4, null],
      ]),
    );
    await expect.poll(() => recordWithId(neverUsed, replacingId)).toMatchObject({ stripSlot: 4 });
    expect(recordOf(neverUsed, "recipes", newerSlot4)).toMatchObject({ stripSlot: null });
    await loads(machine, replacing);
    await expect.poll(async () => (await storedShot("recipe-replacing")).recipe?.id, { timeout: 15_000 }).toBe(replacing);
    // Every recipe, whatever its id, is on both tablets under the same id.
    expect(await recipesAt(here)).toHaveLength(10);
    await expect.poll(() => recipeRecords(neverUsed)).toEqual(recipeRecords(tablet));
  });

  it("writes the settings Streamline's strip leaves out of a recipe made in DYE2's editor and applied before its record was taken in, which the Machine's next change keeps", async () => {
    const unread = recipeReadsHold();
    const { machine, tablet, quiet } = await lab("Made then applied", 49111, unread.tabletOptions);
    tablet.connectMachine();
    const streamline = await startStreamline(tablet);
    const hotWater = () => workflowValueAt(tablet.workflow(), RECIPE_SETTINGS.hotWaterDuration.workflow);
    const own = hotWater();
    expect(own).not.toBe(47);

    // Before the plugin reads it: a new recipe saved in DYE2's editor in slot 5, applied from Streamline's strip, which applies
    // no hot water time (decentespresso/streamline-js#154).
    await unread.hold();
    const { saved } = await (await openDye2RecipeEditor(tablet, { slot: 5 })).set({ name: "Made then applied", hotWaterTimeS: 47 }).save();
    const savedId = String(saved.id);
    await streamline.applyRecipe(5);
    expect([recipeIdInWorkflow(tablet), hotWater()]).toEqual([savedId, own]);
    // The site's own wait, as the recipe reads are held: the server has the Workflow naming the new recipe, so its report,
    // timed by the tablet's clock as the host's, comes before the dial change timed from here on.
    await expect.poll(() => namedDelivered(tablet, savedId), { timeout: 15_000 }).toBe(true);
    // Then a change of the dial, which the load gains the Recipe, timed as the plugin observed it, not as the recipe was named.
    const dialledAt = new Date().toISOString();
    await tablet.changeSettings({ context: { grinderSetting: "3.1" } });
    const dialled = (frame: Record_) => frame.type === "workflow" && ((frame.workflow as Record_).context as Record_).grinderSetting === "3.1";
    await expect.poll(() => tablet.acknowledgedSome(dialled)).toBe(true);

    // Taken in, it is loaded, and the load writes its hot water time, which DYE2's save of the next change keeps.
    unread.release();
    await expect.poll(() => dye2GlobalIdOf(recordWithId(tablet, savedId)), { timeout: 15_000 }).toEqual(expect.any(String));
    const savedRecipe = dye2GlobalIdOf(recordWithId(tablet, savedId))!;
    await loads(machine, savedRecipe);
    const versions = async () => (await api.get<{ versions: { fields: Record_; editedAt: string }[] }>(`/recipes/${savedRecipe}/history`)).versions;
    const gained = (await versions()).find((version) => version.fields.grindSetting === 3.1);
    expect(gained).toBeDefined();
    expect(gained!.editedAt >= dialledAt).toBe(true);
    await expect.poll(hotWater, { timeout: 15_000 }).toBe(47);
    await tablet.changeSettings({ context: { grinderSetting: "3.4" } });
    await expect.poll(async () => (await recipe(savedRecipe)).content.grindSetting, { timeout: 15_000 }).toBe(3.4);
    // Once the change's report, DYE2's save of it and anything else they set off are done, the reads no longer held.
    await quiet({ streamline });
    const recorded = (recordWithId(tablet, savedId)?.dashboardVariables ?? {}) as Record_;
    expect([(await recipe(savedRecipe)).content.hotWaterDuration, hotWater(), recorded.hotWaterTimeS]).toEqual([47, 47, 47]);
  });

  it("links a Shot to the Basket its Workflow named, and to the one DYE2's Edit Shot page sets", async () => {
    const { tablet } = await lab("Basket", 49021);
    // The 18g Basket written into the Workflow on the tablet, as recorded, with no Recipe loaded.
    for (const answer of await replayWrites(tablet, recording.basket!)) expect(answer.status).toBe(200);
    const picked = extras(tablet).basketId as string;
    expect(picked).toEqual(expect.any(String));
    const pickedBasket = dye2GlobalIdOf(list(tablet, "baskets").find((record) => record.id === picked));
    expect(pickedBasket).toEqual(expect.any(String));
    pull(tablet, "basket-picked", 49021);
    expect((await storedShot("basket-picked")).basket).toMatchObject({ id: pickedBasket });

    // A Shot pulled with no Basket, given one on DYE2's Edit Shot page, which records it in the annotations' extras.
    await tablet.changeSettings({ context: { extras: { basketId: null, basketName: null } } });
    const shot = pull(tablet, "basket-edited", 49021);
    expect((await storedShot("basket-edited")).basket).toBeNull();
    const other = list(tablet, "baskets").find((record) => record.id !== picked && dye2GlobalIdOf(record) !== null)!;
    const { measurements: _measurements, ...metadata } = shot;
    tablet.fire("shotUpdated", {
      id: shot.id,
      shot: { ...metadata, updatedAt: "2026-11-01T12:01:00Z", annotations: { extras: { basketId: other.id, basketName: other.name } } },
    });
    await expect.poll(async () => (await storedShot("basket-edited")).basket?.id).toBe(dye2GlobalIdOf(other));
    // Each test's recorded tablet brings the same Baskets, matched by name.
    expect(await listed(`basketId=${dye2GlobalIdOf(other)}`)).toContain("basket-edited");
    expect(await listed(`basketId=${dye2GlobalIdOf(other)}`)).not.toContain("basket-picked");
  });

  it("hard-deletes a Recipe no Shot is linked to from every tablet, but not one a Shot is linked to, and only for an Admin", async () => {
    const { here, machine, tablet, neverUsed, library, brazil } = await lab("Deleted", 49031);
    await load(tablet, machine, LIBRARY, library);
    pull(tablet, "recipe-deleted-shot", 49031);
    expect((await storedShot("recipe-deleted-shot")).recipe).toMatchObject({ id: library });

    const staff = await api.staffAt("deleted-recipes-staff@example.com", here);
    expect((await staff.call("DELETE", `/recipes/${brazil}`)).status).toBe(403);
    const refused = await api.call("DELETE", `/recipes/${library}`);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("A Shot names this Recipe");

    // The Brazil, loaded on the Machine but with no Shot pulled with it, goes from both tablets, and from the Workflow naming it.
    await load(tablet, machine, BRAZIL, brazil);
    expect((await api.call("DELETE", `/recipes/${brazil}`)).status).toBe(204);
    expect((await api.call("GET", `/recipes/${brazil}`)).status).toBe(404);
    for (const each of [tablet, neverUsed]) await expect.poll(() => recordWithId(each, BRAZIL)).toBeUndefined();
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);
    expect(recordOf(tablet, "recipes", library)).toBeDefined();
  });

  it("stores a Shot's full record after its early edit under its Recipe's lock, so a delete racing it finds the Shot linked", async () => {
    const { machine, tablet, library } = await lab("Early edit", 49051);
    await load(tablet, machine, LIBRARY, library);
    // DYE2's Edit Shot page saves the Shot before the plugin has sent it: its edit reaches the server first.
    const shot = pulledNow(tablet, "recipe-early-edit", 49051);
    const { measurements: _measurements, ...metadata } = shot;
    tablet.fire("shotUpdated", { id: shot.id, shot: metadata });
    await expect.poll(() => tablet.acknowledgedSome((frame: Record_) => frame.type === "shotUpdated" && frame.shotId === shot.id)).toBe(true);

    // A delete holding the Recipe's row, as it does once it has looked for linked Shots, holds back the full record's storage.
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM recipes WHERE id = $1 FOR UPDATE", [library]);
      tablet.pullShot(shot);
      await waitForLockWaits(server);
      expect((await api.call("GET", `/shots/${shot.id}`)).status).toBe(404);
      await database.query("ROLLBACK");
    } finally {
      await database.end();
    }
    expect((await storedShot("recipe-early-edit")).recipe).toMatchObject({ id: library });
    expect((await api.call("DELETE", `/recipes/${library}`)).status).toBe(409);
  });

  it("deletes a Basket from a tablet whose Shot named it until DYE2's Edit Shot page set another", async () => {
    const { here, tablet, neverUsed } = await lab("Basket edited", 49061);
    const create = async (name: string) => (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: here.id, content: { name } }, 201)).basket.id;
    const [picked, edited] = [await create("Basket edited 18 g"), await create("Basket edited 20 g")];
    for (const id of [picked, edited]) await expect.poll(() => recordOf(tablet, "baskets", id)).toBeDefined();
    const local = (id: string) => recordOf(tablet, "baskets", id)!.id as string;
    await tablet.changeSettings({ context: { extras: { basketId: local(picked), basketName: "Basket edited 18 g" } } });
    const shot = pull(tablet, "basket-edited-away", 49061);
    expect((await storedShot("basket-edited-away")).basket).toMatchObject({ id: picked });
    const { measurements: _measurements, ...metadata } = shot;
    tablet.fire("shotUpdated", {
      id: shot.id,
      shot: { ...metadata, updatedAt: "2026-11-01T12:01:00Z", annotations: { extras: { basketId: local(edited), basketName: "Basket edited 20 g" } } },
    });
    await expect.poll(async () => (await storedShot("basket-edited-away")).basket?.id).toBe(edited);

    // The Shot names the other Basket now, on the server and on the tablet, so the first goes from both tablets.
    expect((await api.call("DELETE", `/baskets/${picked}`)).status).toBe(204);
    for (const each of [tablet, neverUsed]) await expect.poll(() => recordOf(each, "baskets", picked)).toBeUndefined();
    expect((await api.call("DELETE", `/baskets/${edited}`)).status).toBe(409);
  });

  it("deletes a Basket from a tablet whose Shot's record, read slowly, named it after a newer edit named another", async () => {
    let edit: (() => void) | undefined;
    // The plugin's read of the Shot is answered from what Decaid held as it arrived, 25 s of the tablet's time later
    // (half a second here), and DYE2's Edit Shot page sets another Basket meanwhile.
    const apiDelayMs = (method: string, path: string) => {
      if (method !== "GET" || path !== "/shots/basket-slow-read" || !edit) return 0;
      setTimeout(edit, 0);
      edit = undefined;
      return 25_000;
    };
    const { here, tablet, neverUsed } = await lab("Slow read", 49071, { apiDelayMs, answerOnArrival: true });
    const create = async (name: string) => (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: here.id, content: { name } }, 201)).basket.id;
    const [picked, edited] = [await create("Slow read 18 g"), await create("Slow read 20 g")];
    for (const id of [picked, edited]) await expect.poll(() => recordOf(tablet, "baskets", id)).toBeDefined();
    const local = (id: string) => recordOf(tablet, "baskets", id)!.id as string;
    await tablet.changeSettings({ context: { extras: { basketId: local(picked), basketName: "Slow read 18 g" } } });
    const shot = pulledNow(tablet, "basket-slow-read", 49071);
    const { measurements: _measurements, ...metadata } = shot;
    edit = () =>
      tablet.fire("shotUpdated", {
        id: shot.id,
        shot: { ...metadata, updatedAt: "2026-11-01T12:01:00.000002Z", annotations: { extras: { basketId: local(edited), basketName: "Slow read 20 g" } } },
      });
    tablet.pullShot(shot);
    await expect.poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);
    await expect.poll(async () => (await storedShot(shot.id as string)).basket?.id).toBe(edited);

    expect((await api.call("DELETE", `/baskets/${picked}`)).status).toBe(204);
    for (const each of [tablet, neverUsed]) await expect.poll(() => recordOf(each, "baskets", picked)).toBeUndefined();
  });

  it("keeps a Tool named by a Shot stored before its tablet reported it, through the Shot's edits, once Archived, until an edit drops it", async () => {
    const { tablet, neverUsed } = await lab("Late Tool", 49081);
    // A Shot names a tool DYE2's equipment page saves only afterwards, before the plugin reports it.
    const shot = pull(tablet, "tool-named-late", 49081, { annotations: { extras: { equipmentIds: ["eqp-late-wdt"], equipmentNames: ["Late Tool WDT"] } } });
    await storedShot(shot.id as string);
    const { [GLOBAL_ID_KEY]: _globalId, ...shape } = list(tablet, "equipment")[0]!;
    const route = `/store/${DYE2_NAMESPACE}/equipment`;
    expect((await tablet.callApi("POST", route, [...list(tablet, "equipment"), { ...shape, id: "eqp-late-wdt", name: "Late Tool WDT" }])).status).toBe(200);
    const libraryTool = async () => (await api.get<{ tools: { id: string; name: string }[] }>("/tools")).tools.find((tool) => tool.name === "Late Tool WDT")?.id;
    await expect.poll(libraryTool).toBeDefined();
    const tool = (await libraryTool())!;

    // Archived, it leaves both tablets, and the Shot still names it.
    expect((await api.call("PUT", `/tools/${tool}/archived`, { archived: true })).status).toBe(200);
    for (const each of [tablet, neverUsed]) await expect.poll(() => list(each, "equipment").some((record) => record.id === "eqp-late-wdt")).toBe(false);
    expect((await api.call("DELETE", `/tools/${tool}`)).status).toBe(409);

    // An edit that still names it keeps its link; one that drops it lets it go.
    const { measurements: _measurements, ...metadata } = shot;
    const edit = async (updatedAt: string, equipmentIds: string[]) => {
      tablet.fire("shotUpdated", { id: shot.id, shot: { ...metadata, updatedAt, annotations: { extras: { equipmentIds } } } });
      await expect.poll(() => tablet.acknowledgedSome((frame: Record_) => frame.type === "shotUpdated" && (frame.shot as Record_).updatedAt === updatedAt)).toBe(true);
    };
    await edit("2026-11-01T12:01:00Z", ["eqp-another", "eqp-late-wdt"]);
    expect((await api.call("DELETE", `/tools/${tool}`)).status).toBe(409);
    await edit("2026-11-01T12:02:00Z", ["eqp-another"]);
    expect((await api.call("DELETE", `/tools/${tool}`)).status).toBe(204);
  });

  it("hard-deletes a Basket or Tool no Shot or Recipe names from every tablet, and refuses one either names", async () => {
    const { here, tablet, neverUsed, library } = await lab("Equipment", 49041);
    const create = async (kind: "baskets" | "tools", name: string) =>
      Object.values(await api.send<Record<string, { id: string }>>("POST", `/${kind}`, { locationId: here.id, content: { name } }, 201))[0]!.id;
    const key = (kind: "baskets" | "tools"): Dye2Key => (kind === "baskets" ? "baskets" : "equipment");
    const held = async (kind: "baskets" | "tools", id: string) => {
      for (const each of [tablet, neverUsed]) await expect.poll(() => recordOf(each, key(kind), id)).toBeDefined();
      return recordOf(tablet, key(kind), id)!.id as string;
    };

    // Named by a Recipe.
    const recipeBasket = await create("baskets", "Deleted lab 18 g");
    const recipeTool = await create("tools", "Deleted lab puck screen");
    await held("baskets", recipeBasket);
    await held("tools", recipeTool);
    expect((await api.call("PATCH", `/recipes/${library}`, { content: { basketId: recipeBasket, toolIds: [recipeTool] } })).status).toBe(200);
    const refusedBasket = await api.call("DELETE", `/baskets/${recipeBasket}`);
    expect(refusedBasket.status).toBe(409);
    expect(await refusedBasket.text()).toContain("A Recipe names this Basket");
    expect((await api.call("DELETE", `/tools/${recipeTool}`)).status).toBe(409);

    // Named by a Shot, by the tablet's ids.
    const shotBasket = await create("baskets", "Deleted lab 22 g");
    const shotTool = await create("tools", "Deleted lab WDT");
    const [shotBasketId, shotToolId] = [await held("baskets", shotBasket), await held("tools", shotTool)];
    pull(tablet, "equipment-named", 49041, { annotations: { extras: { basketId: shotBasketId, equipmentIds: [shotToolId], equipmentNames: ["Deleted lab WDT"] } } });
    expect((await storedShot("equipment-named")).basket).toMatchObject({ id: shotBasket });
    const refusedTool = await api.call("DELETE", `/tools/${shotTool}`);
    expect(refusedTool.status).toBe(409);
    expect(await refusedTool.text()).toContain("A Shot names this Tool");
    expect((await api.call("DELETE", `/baskets/${shotBasket}`)).status).toBe(409);
    // Still named once their records leave the tablets, the Tool Archived and the Basket hidden at the Location.
    expect((await api.call("PUT", `/tools/${shotTool}/archived`, { archived: true })).status).toBe(200);
    expect((await api.call("PUT", `/baskets/${shotBasket}/locations/${here.id}`, { shown: false })).status).toBe(200);
    for (const each of [tablet, neverUsed]) {
      await expect.poll(() => recordOf(each, "equipment", shotTool)).toBeUndefined();
      await expect.poll(() => recordOf(each, "baskets", shotBasket)).toBeUndefined();
    }
    expect((await api.call("DELETE", `/tools/${shotTool}`)).status).toBe(409);
    expect((await api.call("DELETE", `/baskets/${shotBasket}`)).status).toBe(409);

    // Named by neither: gone from the Library and from both tablets.
    const unusedBasket = await create("baskets", "Deleted lab 15 g");
    const unusedTool = await create("tools", "Deleted lab tamper");
    await held("baskets", unusedBasket);
    await held("tools", unusedTool);
    const staff = await api.staffAt("deleted-equipment-staff@example.com", here);
    expect((await staff.call("DELETE", `/baskets/${unusedBasket}`)).status).toBe(403);
    expect((await api.call("DELETE", `/baskets/${unusedBasket}`)).status).toBe(204);
    expect((await api.call("DELETE", `/tools/${unusedTool}`)).status).toBe(204);
    expect((await api.call("GET", `/baskets/${unusedBasket}`)).status).toBe(404);
    for (const each of [tablet, neverUsed]) {
      await expect.poll(() => recordOf(each, "baskets", unusedBasket)).toBeUndefined();
      await expect.poll(() => recordOf(each, "equipment", unusedTool)).toBeUndefined();
    }
    expect((await api.call("GET", `/baskets/${shotBasket}`)).status).toBe(200);
  });
});
