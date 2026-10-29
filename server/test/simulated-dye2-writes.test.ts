import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  SimulatedDye2,
  dye2ClearBeanlessRecipeWorkflows,
  dye2Generated,
  dye2Keys,
  dye2Library,
  dye2List,
  dye2PagesRecording,
  dye2Recording,
  dye2StoreExchanges,
  dye2V032Recording,
  openDye2RecipeEditor,
  recordedDye2Tablet,
  saveInDye2,
  saveRecipeFromFavouriteEditor,
} from "./support/simulated-dye2.js";
import { type DecaidApi, SimulatedTablet, de1ProOnDecaid091, derivedDe1Pro } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated tablet's plugin storage, the simulated DYE2's first load, its
// recipe editor, and the helper that replays DYE2's pages' saves on a tablet
// (`saveInDye2`), against what they were recorded doing on Decaid v0.9.0's
// Linux release: DYE2 v0.1.26 (fixtures/decaid/dye2-v0.1.26/, whose README
// says what each step was), and DYE2's equipment and baskets pages at 2cf631c
// (fixtures/decaid/dye2-2cf631c/), which save as v0.1.32's do; and on
// v0.9.1's, what DYE2 v0.1.32 does otherwise (fixtures/decaid/dye2-v0.1.32/).
// No settings are given, so the plugin does not connect.

type Record_ = Record<string, unknown>;

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

function load(api: DecaidApi = dye2Library(), dye2?: SimulatedDye2): SimulatedTablet {
  // Recorded on Decaid's simulated machine, which keeps no flush time or temperature written to it.
  const tablet = SimulatedTablet.load({ settings: {}, api, dye2, keepsFlushSettings: false });
  tablets.push(tablet);
  return tablet;
}

/** The list a step's last write posted. */
function posted(step: Dye2Exchange[]): Record_[] {
  return step.filter(({ request }) => request.method === "POST" && request.path.startsWith(`/store/${DYE2_NAMESPACE}/`)).at(-1)!.request.body as Record_[];
}

describe("The simulated tablet's plugin storage", () => {
  it("answers as Decaid v0.9.0's store did: null for a key never written, a POST read back, null again once deleted", async () => {
    const tablet = load();
    const exchanges = dye2StoreExchanges();
    const answers = [];
    for (const { request } of exchanges) answers.push(await tablet.callApi(request.method, request.path, request.body));
    expect(answers).toEqual(exchanges.map((exchange) => exchange.response));
  });

  it("keeps a POST to DYE2's recipes, replacing the value, and answers null for DYE2's keys never written", async () => {
    // Served the test tablet's recipes, in an older DYE2's shape, which the POST replaces.
    const tablet = load({ ...dye2Library(), "/store/dye2.reaplugin/recipes": de1ProOnDecaid091()["/store/dye2.reaplugin/recipes"] });
    const recipes = dye2Keys().recipes;
    expect(await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", recipes)).toEqual({ status: 200, body: {} });
    expect(await tablet.callApi("GET", "/store/dye2.reaplugin/recipes")).toEqual({ status: 200, body: recipes });
    expect(dye2List(tablet, "recipes")).toEqual(recipes);
    for (const key of ["baskets", "equipment"]) expect(await tablet.callApi("GET", `/store/dye2.reaplugin/${key}`)).toEqual({ status: 200, body: null });
  });

  it("reads a key under the name its write gave it, however the route spells it, as Decaid's router decodes both", async () => {
    const tablet = load();
    await tablet.callApi("POST", "/store/streamline-app/a:b", []);
    expect(await tablet.callApi("GET", "/store/streamline-app/a%3Ab")).toEqual({ status: 200, body: [] });
    expect(tablet.storeValue("streamline-app", "a:b")).toEqual([]);
  });
});

describe("The simulated DYE2's first load, as DYE2 v0.1.26 was recorded installing over the keys an earlier DYE2 left", () => {
  const { seeded, install } = dye2Recording<{
    seeded: { values: Record<string, unknown>; workflow: Record_ };
    install: { reads: { values: Record<string, unknown>; workflow: Record_ }[] };
  }>("loading");

  it("migrates its recipes once, clears the stored selection and its Workflow marker, and sets each flag", async () => {
    const dye2 = new SimulatedDye2();
    const api: DecaidApi = { ...dye2Library(), "/workflow": seeded.workflow, "/machine/settings": dye2Recording<Record_>("library").machineSettings };
    for (const [key, value] of Object.entries(seeded.values)) api[`/store/${DYE2_NAMESPACE}/${key}`] = value;
    const tablet = load(api, dye2);
    await dye2.settled();
    const final = install.reads.at(-1)!;
    // Recent favourites and the Shot index are not simulated.
    for (const key of ["baskets", "selection", "selectionMigrated", "recipesMigrated", "favSlotsMigrated", "favProfilesMigrated"]) {
      expect(tablet.storeValue(DYE2_NAMESPACE, key), key).toEqual(final.values[key]);
    }
    // DYE2 v0.1.32 also gives the blank recipe, naming no Bean, explicit nulls for one, and sets the flags of that migration
    // and of its favourites' (dye2-v0.1.32/loading.json).
    expect(tablet.storeValue(DYE2_NAMESPACE, "recipes")).toEqual(dye2ClearBeanlessRecipeWorkflows(final.values.recipes as Record_[]));
    expect([tablet.storeValue(DYE2_NAMESPACE, "recipeBeansMigrated"), tablet.storeValue(DYE2_NAMESPACE, "favBeansMigrated")]).toEqual([true, true]);
    expect(tablet.workflow()).toEqual(final.workflow);
  });
});

describe("DYE2's equipment and baskets pages replayed on a simulated tablet", () => {
  it("leave the tools and baskets they were recorded writing", async () => {
    const tablet = load();
    for (const file of ["tools", "baskets"] as const) {
      const steps = Object.values(dye2PagesRecording(file));
      for (const step of steps) expect(await saveInDye2(tablet, step)).toEqual(posted(step));
      expect(dye2List(tablet, file === "tools" ? "equipment" : "baskets")).toEqual(posted(steps.at(-1)!));
    }
  });

  it("keep the items they do not touch, and a new tool named as one held is not written", async () => {
    const tools = dye2PagesRecording("tools");
    const held = [...posted(tools.deleteSpareTamper!), { id: "fixture-derived-tool", name: "Fixture Derived Tamper", createdAt: "2026-01-02T03:04:05.000Z" }];
    const tablet = load({ ...dye2Library(), "/store/dye2.reaplugin/equipment": held });
    await saveInDye2(tablet, tools.createWdtTool!);
    expect(dye2List(tablet, "equipment")).toEqual(held);
    await saveInDye2(tablet, tools.editWdtTool!);
    expect((dye2List(tablet, "equipment") as { name: string }[]).map((tool) => tool.name)).toEqual(["Fixture WDT Tool", "Fixture Puck Screen", "Fixture Derived Tamper"]);
  });

  it("edit and delete tools another tablet holds under its own ids, keeping when each was made", async () => {
    const tools = dye2PagesRecording("tools");
    const elsewhere = (tool: Record_) => ({ ...tool, id: `elsewhere-${String(tool.id)}` });
    const read = tools.editWdtTool![0]!.response.body as Record_[];
    const held: Record_[] = read.map((tool) => ({ ...elsewhere(tool), createdAt: "2026-01-02T03:04:05.000Z" }));
    const tablet = load({ ...dye2Library(), "/store/dye2.reaplugin/equipment": held });
    await saveInDye2(tablet, tools.editWdtTool!, elsewhere);
    const edited = posted(tools.editWdtTool!).find((tool) => tool.name === "Fixture WDT Tool")!;
    const afterEdit = held.map((tool) => (tool.name === "Fixture WDT Tool" ? { ...tool, custom: edited.custom } : tool));
    expect(dye2List(tablet, "equipment")).toEqual(afterEdit);
    await saveInDye2(tablet, tools.deleteSpareTamper!, elsewhere);
    expect(dye2List(tablet, "equipment")).toEqual(afterEdit.filter((tool) => tool.name !== "Fixture Spare Tamper"));
  });
});

describe("DYE2's recipe editor made again as recorded", () => {
  runAsSteps();
  const steps = dye2Recording<Record<string, Dye2Exchange[]>>("recipes");
  const library = dye2Recording<{ beans: Record_[]; grinders: Record_[]; profiles: { id: string; profile: Record_ }[]; baskets: Record_[]; workflow: Record_ }>("library");
  const { install } = dye2Recording<{ install: { reads: { workflow: Record_ }[] } }>("loading");
  const first = steps.newInEmptySlot!.find(({ request }) => request.method === "GET")!.response.body;
  const tablet = load({ ...recordedDye2Tablet("10001", ""), "/beans": library.beans, "/workflow": install.reads.at(-1)!.workflow, "/store/dye2.reaplugin/recipes": first });
  const generated = { ...dye2Generated };
  afterEach(() => Object.assign(dye2Generated, generated));
  const recipeNamed = (name: string) => (dye2List(tablet, "recipes") as Record_[]).find((recipe) => recipe.name === name)!;

  /** Makes DYE2's clock and new ids what the step saved, for the recipe the step changed. */
  function asRecorded(step: Dye2Exchange[], changedId?: string): void {
    const before = (step.find(({ request }) => request.method === "GET" && request.path.endsWith("/recipes"))?.response.body ?? []) as Record_[];
    const saved = posted(step).find((recipe) => (changedId ? recipe.id === changedId : !before.some((held) => held.id === recipe.id)))!;
    dye2Generated.now = () => new Date(String(saved.capturedAt));
    dye2Generated.uuid = () => String(saved.id);
  }

  /** Checks the step's post was what the editor saved. */
  const expectPosted = (step: Dye2Exchange[]) => expect(dye2List(tablet, "recipes")).toEqual(posted(step));

  it("saves a new recipe under a UUID in the empty slot targeted, a mode switch keeping the value its form showed for the mode left", async () => {
    const step = steps.newInEmptySlot!;
    asRecorded(step);
    const ethiopia = library.beans.find((bean) => bean.name === "Fixture Ethiopia")!;
    const adaptive = library.profiles.find((record) => record.profile.title === "Adaptive v3")!;
    const editor = await openDye2RecipeEditor(tablet);
    await editor
      .tapSlot(5)
      .set({ name: "Fixture Slot Recipe", bean: { id: String(ethiopia.id), name: String(ethiopia.name), roaster: String(ethiopia.roaster) } })
      .pickProfile(adaptive.id)
      .set({
        grinderId: String(library.grinders.find((grinder) => grinder.model === "Fixture Grinder 64")!.id),
        basketId: String(library.baskets.find((basket) => basket.name === "Fixture 18g Precision")!.id),
        dose: 18,
        drink: 36,
        brewC: 92,
        steam: { mode: "time", value: 30 },
        flushS: 5,
        hotWater: { mode: "temp", value: 85 },
        grind: 2.5,
        rpm: 900,
      })
      .save();
    expectPosted(step);
  });

  it("saves the recipe read from the Workflow in no slot (replayed: Read From is not simulated)", async () => {
    const step = steps.newInNoSlot!;
    expect(await saveInDye2(tablet, step)).toEqual(posted(step));
  });

  it("moves a recipe onto a held slot, taking it from its holder, and takes one off the strip", async () => {
    const libraryRecipe = String(recipeNamed("Fixture Library Recipe").id);
    asRecorded(steps.moveToHeldSlot!, libraryRecipe);
    await (await openDye2RecipeEditor(tablet, { id: libraryRecipe })).tapSlot(1).save();
    expectPosted(steps.moveToHeldSlot!);
    const slotRecipe = String(recipeNamed("Fixture Slot Recipe").id);
    asRecorded(steps.takeOffStrip!, slotRecipe);
    await (await openDye2RecipeEditor(tablet, { id: slotRecipe })).tapSlot(5).save();
    expectPosted(steps.takeOffStrip!);
  });

  it("saves only the fields edited, and saves the Machine Settings, Off as 0", async () => {
    const libraryRecipe = String(recipeNamed("Fixture Library Recipe").id);
    const slotRecipe = String(recipeNamed("Fixture Slot Recipe").id);
    asRecorded(steps.editFields!, libraryRecipe);
    await (await openDye2RecipeEditor(tablet, { id: libraryRecipe })).set({ dose: 19.5, grind: 3.2 }).save();
    expectPosted(steps.editFields!);
    // Replayed: DYE2 v0.1.32 takes a recipe it saves hidden out of its slot, as below (dye2-v0.1.32/editor.json).
    expect(await saveInDye2(tablet, steps.hideFromStreamline!)).toEqual(posted(steps.hideFromStreamline!));
    asRecorded(steps.saveMachineSettings!, slotRecipe);
    await (await openDye2RecipeEditor(tablet, { id: slotRecipe })).set({ steamTempC: 150, steamStopAtTempC: 60, hotWaterTimeS: 30, hotWaterFlowMls: 4, flushTempC: 90, flushFlowMls: 6 }).save();
    expectPosted(steps.saveMachineSettings!);
    asRecorded(steps.steamOff!, slotRecipe);
    await (await openDye2RecipeEditor(tablet, { id: slotRecipe })).set({ steamTempC: 0 }).save();
    expectPosted(steps.steamOff!);
  });

  it("saves a recipe from the Auto Favourites page's add card, in no slot, its profile by title alone", async () => {
    const step = steps.newFromFavouriteEditor!;
    asRecorded(step);
    expect(tablet.workflow()).toEqual(step.find(({ request }) => request.path === "/workflow")!.response.body);
    await saveRecipeFromFavouriteEditor(tablet, "Fixture Favourite Recipe");
    expectPosted(step);
  });
});

describe("The simulated DYE2's first load, as DYE2 v0.1.32 was recorded installing over the keys Decent Sync's server and v0.1.26 left", () => {
  const library = dye2V032Recording<Record_>("library");
  const { seeded, install } = dye2V032Recording<{
    seeded: { values: Record<string, unknown>; workflow: Record_ };
    install: { reads: { values: Record<string, unknown>; workflow: Record_ }[] };
  }>("loading");

  it("gives each recipe naming no Bean explicit nulls for one, once, and leaves a hidden one in its slot", async () => {
    const dye2 = new SimulatedDye2();
    const api: DecaidApi = { ...derivedDe1Pro({ serial: "10003" }), "/workflow": seeded.workflow, "/machine/settings": library.machineSettings };
    for (const [key, value] of Object.entries(seeded.values)) api[`/store/${DYE2_NAMESPACE}/${key}`] = value;
    const tablet = load(api, dye2);
    await dye2.settled();
    const final = install.reads.at(-1)!;
    for (const key of ["recipes", "baskets", "selectionMigrated", "recipesMigrated", "favSlotsMigrated", "favProfilesMigrated", "recipeBeansMigrated", "favBeansMigrated"]) {
      expect(tablet.storeValue(DYE2_NAMESPACE, key), key).toEqual(final.values[key]);
    }
    expect(tablet.workflow()).toEqual(final.workflow);
    // Once: its flag set, a recipe saved since without the nulls keeps none.
    const without = (final.values.recipes as Record_[]).map((recipe) => (recipe.id === "2" ? { ...recipe, workflow: { context: {} } } : recipe));
    await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, without);
    await dye2.reload();
    expect(tablet.storeValue(DYE2_NAMESPACE, "recipes")).toEqual(without);
  });
});

describe("DYE2 v0.1.32's recipe editor made again as recorded", () => {
  runAsSteps();
  const steps = dye2V032Recording<Record<string, { opened: Record_; form: Record_; exchanges: Dye2Exchange[] }>>("editor");
  const library = dye2V032Recording<{ beans: Record_[]; grinders: Record_[]; profiles: { id: string; profile: Record_ }[] }>("library");
  const first = steps.saveCleared!.exchanges.find(({ request }) => request.method === "GET")!.response.body;
  const tablet = load({ ...derivedDe1Pro({ serial: "10004" }), "/beans": library.beans, "/grinders": library.grinders, "/profiles": library.profiles, "/store/dye2.reaplugin/recipes": first });
  const generated = { ...dye2Generated };
  afterEach(() => Object.assign(dye2Generated, generated));

  /** Opens the editor as the step did, makes the change, checks what its form showed of the strip before and after, saves as recorded, and checks the list it posted. */
  async function again(name: string, target: { id?: string }, change: (editor: Awaited<ReturnType<typeof openDye2RecipeEditor>>) => unknown, changedId = target.id): Promise<void> {
    const step = steps[name]!;
    const before = (step.exchanges.find(({ request }) => request.method === "GET")?.response.body ?? []) as Record_[];
    const saved = posted(step.exchanges).find((recipe) => (changedId ? recipe.id === changedId : !before.some((held) => held.id === recipe.id)))!;
    dye2Generated.now = () => new Date(String(saved.capturedAt));
    dye2Generated.uuid = () => String(saved.id);
    const editor = await openDye2RecipeEditor(tablet, target);
    expect(editor.strip(), `${name}: opened`).toEqual(step.opened);
    await change(editor);
    expect(editor.strip(), `${name}: form`).toEqual(step.form);
    await editor.save();
    expect(dye2List(tablet, "recipes"), name).toEqual(posted(step.exchanges));
  }

  it("opens a recipe hidden in a slot on no tab, and saves it in none", async () => {
    await again("saveCleared", { id: "1" }, (editor) => editor.set({ dose: 18.2 }));
    await again("saveHiddenInSlot", { id: "4" }, (editor) => editor.set({ dose: 18.8 }));
  });

  it("takes a recipe it hides out of its slot, and shows one put in a slot", async () => {
    await again("hideSlotted", { id: "2" }, (editor) => editor.set({ showOnStreamlineDashboard: false }));
    await again("slotHidden", { id: "4" }, (editor) => editor.tapSlot(4));
  });

  it("saves a new recipe naming no Bean with explicit nulls for one", async () => {
    const adaptive = library.profiles.find((record) => record.profile.title === "Adaptive v3")!;
    const grinder = String(library.grinders.find((candidate) => candidate.model === "Fixture Grinder 64")!.id);
    await again("newWithoutBean", {}, (editor) => editor.tapSlot(5).set({ name: "Fixture New No Bean" }).pickProfile(adaptive.id).set({ grinderId: grinder, dose: 18, drink: 36 }));
  });

  it("keeps a grind setting typed as text as typed, and one typed as a number to a tenth", async () => {
    await again("grindText", { id: "3" }, (editor) => editor.set({ grind: "1.5." }));
    await again("grindWord", { id: "3" }, (editor) => editor.set({ grind: "fine" }));
    await again("grindNumber", { id: "3" }, (editor) => editor.set({ grind: "2.75" }));
  });
});
