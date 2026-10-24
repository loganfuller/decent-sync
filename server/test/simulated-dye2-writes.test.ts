import { afterAll, describe, expect, it } from "vitest";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  dye2Keys,
  dye2Library,
  dye2List,
  dye2MachineSettingsLibrary,
  dye2Recording,
  dye2StoreExchanges,
  saveInDye2,
} from "./support/simulated-dye2.js";
import { SimulatedTablet, de1ProOnDecaid090 } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated tablet's plugin storage, and the helper that replays DYE2's
// pages' saves on it (`saveInDye2`), against what DYE2's pages were recorded
// writing on Decaid v0.9.0's Linux release (fixtures/decaid/dye2-2cf631c/,
// recorded from DYE2 `main` at 2cf631c, whose equipment and baskets pages
// save as v0.1.26's do). No settings are given, so the plugin does not
// connect, and only Decaid's API is used.

type Record_ = Record<string, unknown>;

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

function load(api = dye2Library()): SimulatedTablet {
  // Recorded on Decaid's simulated machine, which keeps no flush time or temperature written to it.
  const tablet = SimulatedTablet.load({ settings: {}, api, keepsFlushSettings: false });
  tablets.push(tablet);
  return tablet;
}

/** The list a step's last write posted. */
function posted(step: Dye2Exchange[]): unknown {
  return step.filter(({ request }) => request.method === "POST" && request.path.startsWith(`/store/${DYE2_NAMESPACE}/`)).at(-1)!.request.body;
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
    const tablet = load({ ...dye2Library(), "/store/dye2.reaplugin/recipes": de1ProOnDecaid090()["/store/dye2.reaplugin/recipes"] });
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

describe("DYE2's pages replayed on a simulated tablet", () => {
  runAsSteps();
  const tablet = load();
  const tools = dye2Recording("tools");
  const baskets = dye2Recording("baskets");
  const recipes = dye2Recording("recipes");

  it("DYE2's equipment and baskets pages leave the tools and baskets they were recorded writing", async () => {
    for (const step of Object.values(tools)) expect(await saveInDye2(tablet, step)).toEqual(posted(step));
    for (const step of Object.values(baskets)) expect(await saveInDye2(tablet, step)).toEqual(posted(step));
    expect(dye2List(tablet, "equipment")).toEqual(dye2Keys().equipment);
    expect(dye2List(tablet, "baskets")).toEqual(dye2Keys().baskets);
  });

  it("DYE2's recipe editor saves each slot as recorded, leaving blank fields out", async () => {
    for (const step of Object.values(recipes)) {
      expect(await saveInDye2(tablet, step)).toEqual(posted(step));
      expect(dye2List(tablet, "recipes")).toEqual(posted(step));
    }
    const blank = (dye2List(tablet, "recipes") as { id: string; dashboardVariables: Record_ }[]).find((recipe) => recipe.id === "3")!;
    for (const field of ["dose", "drink", "brewC", "steamFlowMls", "flushS", "hotWaterMl", "grind", "rpm", "steamTempC"]) expect(blank.dashboardVariables).not.toHaveProperty(field);
  });
});

describe("DYE2's Machine Settings replayed on a simulated tablet", () => {
  runAsSteps();
  const recorded = dye2Recording("machine-settings");
  const tablet = load(dye2MachineSettingsLibrary());
  const slot1 = () => (dye2List(tablet, "recipes") as { id: string; dashboardVariables: Record_; workflow: Record_ }[]).find((recipe) => recipe.id === "1")!;

  it("DYE2's recipe editor saves every machine setting as recorded: both values of each mode, Off as 0 and a blank as null", async () => {
    const save = async (name: "saveMachineSettings" | "editMachineSettings" | "switchModeOnly" | "steamOff" | "steamBackOn" | "clearMilkStopTyped" | "clearMilkStop") => {
      const step = recorded[name];
      expect(await saveInDye2(tablet, step), name).toEqual(posted(step));
      expect(dye2List(tablet, "recipes"), name).toEqual(posted(step));
      return slot1();
    };
    let slot = await save("saveMachineSettings");
    expect(slot.dashboardVariables).toMatchObject({
      steamMode: "flow",
      steamTimeS: 30,
      steamFlowMls: 1.2,
      hotWaterMode: "temp",
      hotWaterMl: 150,
      hotWaterTempC: 85,
      steamTempC: 150,
      steamStopAtTempC: 60,
      hotWaterTimeS: 30,
      hotWaterFlowMls: 4,
      flushTempC: 90,
      flushS: 5,
      flushFlowMls: 6,
    });
    expect([slot.workflow.steamSettings, slot.workflow.hotWaterData, slot.workflow.rinseData]).toEqual([
      { targetTemperature: 150, duration: 30, flow: 1.2, stopAtTemperature: 60 },
      { targetTemperature: 85, duration: 30, volume: 150, flow: 4 },
      { targetTemperature: 90, duration: 5, flow: 6 },
    ]);
    slot = await save("editMachineSettings");
    expect(slot.dashboardVariables).toMatchObject({ steamMode: "time", steamTimeS: 32, steamFlowMls: 1.2, flushFlowMls: 5 });
    // A mode switched alone changes only the mode.
    const before = slot.dashboardVariables;
    slot = await save("switchModeOnly");
    expect(slot.dashboardVariables).toEqual({ ...before, hotWaterMode: "vol" });
    slot = await save("steamOff");
    expect([slot.dashboardVariables.steamTempC, (slot.workflow.steamSettings as Record_).targetTemperature]).toEqual([0, 0]);
    slot = await save("steamBackOn");
    expect(slot.dashboardVariables.steamTempC).toBe(150);
    // An empty value typed puts back the one shown: the save changes nothing but when it was made.
    const typed = slot.dashboardVariables;
    slot = await save("clearMilkStopTyped");
    expect(slot.dashboardVariables).toEqual(typed);
    slot = await save("clearMilkStop");
    expect(slot.dashboardVariables).toHaveProperty("steamStopAtTempC", null);
    expect(slot.workflow.steamSettings).toEqual({ targetTemperature: 150, duration: 32, flow: 1.2 });
  });
});

describe("DYE2's pages replayed on a tablet holding other data", () => {
  type Recipe = { id: string; name: string; dashboardVariables: Record_ };
  const recipe = (tablet: SimulatedTablet, id: string) => (dye2List(tablet, "recipes") as Recipe[]).find((item) => item.id === id);

  /** Derived from the recorded lists: a slot 4 copied from slot 3, and a tool the recording never made. */
  function loadDerived(): SimulatedTablet {
    const keys = dye2Keys();
    const recipes = keys.recipes as Recipe[];
    const slot4 = { ...recipes.find((item) => item.id === "3")!, id: "4", name: "Fixture Derived Recipe" };
    const tool = { ...keys.equipment[1], id: "fixture-derived-tool", name: "Fixture Derived Tamper" };
    return load({
      ...dye2Library(),
      "/store/dye2.reaplugin/recipes": [...recipes, slot4],
      "/store/dye2.reaplugin/equipment": [...keys.equipment, tool],
    });
  }

  it("DYE2's edit and deletion of tools another tablet holds under its own ids change those, keeping when each was made", async () => {
    // Derived: the tools as DYE2 read them before editing one, under ids of another tablet's DYE2, made earlier there.
    const tools = dye2Recording("tools");
    const elsewhere = (tool: Record_) => ({ ...tool, id: `elsewhere-${String(tool.id)}` });
    const read = tools.editWdtTool[0]!.response.body as Record_[];
    const held: Record_[] = read.map((tool) => ({ ...elsewhere(tool), createdAt: "2026-01-02T03:04:05.000Z" }));
    const tablet = load({ ...dye2Library(), "/store/dye2.reaplugin/equipment": held });
    await saveInDye2(tablet, tools.editWdtTool, elsewhere);
    const edited = (posted(tools.editWdtTool) as Record_[]).find((tool) => tool.name === "Fixture WDT Tool")!;
    const afterEdit = held.map((tool) => (tool.name === "Fixture WDT Tool" ? { ...tool, custom: edited.custom } : tool));
    expect(dye2List(tablet, "equipment")).toEqual(afterEdit);
    await saveInDye2(tablet, tools.deleteSpareTamper, elsewhere);
    expect(dye2List(tablet, "equipment")).toEqual(afterEdit.filter((tool) => tool.name !== "Fixture Spare Tamper"));
  });

  it("DYE2's saves keep the items they do not touch, and a new tool named as one held is not written", async () => {
    const tablet = loadDerived();
    const recipes = dye2Recording("recipes");
    const tools = dye2Recording("tools");
    const slot4 = recipe(tablet, "4");
    await saveInDye2(tablet, recipes.editSlot1);
    expect(recipe(tablet, "4")).toEqual(slot4);
    expect(recipe(tablet, "1")!.dashboardVariables).toMatchObject({ dose: 18.5, grind: 2.7, hotWaterTempC: 88 });
    const equipment = dye2List(tablet, "equipment");
    await saveInDye2(tablet, tools.createWdtTool);
    expect(dye2List(tablet, "equipment")).toEqual(equipment);
    await saveInDye2(tablet, tools.editWdtTool);
    expect((dye2List(tablet, "equipment") as { name: string }[]).map((tool) => tool.name)).toEqual(["Fixture WDT Tool", "Fixture Puck Screen", "Fixture Derived Tamper"]);
  });
});
