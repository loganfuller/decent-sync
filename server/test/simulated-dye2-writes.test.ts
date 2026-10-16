import { afterAll, describe, expect, it } from "vitest";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  autoSaveInStreamline,
  dye2Keys,
  dye2Library,
  dye2List,
  dye2Recording,
  dye2StoreExchanges,
  replayWrites,
  saveInDye2,
} from "./support/simulated-dye2.js";
import { SimulatedTablet, de1ProOnDecaid090 } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated tablet's plugin storage, and the helpers that act as DYE2
// v0.1.19 and Streamline v0.2.13 on it, against what those apps were recorded
// writing on Decaid v0.8.7's Linux release (fixtures/decaid/dye2-v0.1.19/).
// No settings are given, so the plugin does not connect, and only Decaid's
// API is used.

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

function load(api = dye2Library()): SimulatedTablet {
  const tablet = SimulatedTablet.load({ settings: {}, api });
  tablets.push(tablet);
  return tablet;
}

/** The list a step's last write posted. */
function posted(step: Dye2Exchange[]): unknown {
  return step.filter(({ request }) => request.method === "POST" && request.path.startsWith(`/store/${DYE2_NAMESPACE}/`)).at(-1)!.request.body;
}

/** The Workflow Decaid answered a step's last write of it. */
function answeredWorkflow(step: Dye2Exchange[]): unknown {
  return step.filter(({ request }) => request.method === "PUT" && request.path === "/workflow").at(-1)!.response.body;
}

describe("The simulated tablet's plugin storage", () => {
  it("answers as Decaid v0.8.7's store did: null for a key never written, a POST read back, null again once deleted", async () => {
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

describe("DYE2 and Streamline replayed on a simulated tablet", () => {
  runAsSteps();
  const tablet = load();
  const tools = dye2Recording("tools");
  const baskets = dye2Recording("baskets");
  const recipes = dye2Recording("recipes");
  const dye2Applies = dye2Recording("dye2-applies");
  const streamline = dye2Recording("streamline");

  it("DYE2's equipment and baskets pages leave the tools and baskets they were recorded writing", async () => {
    for (const step of Object.values(tools)) expect(await saveInDye2(tablet, step)).toEqual(posted(step));
    for (const step of Object.values(baskets)) expect(await saveInDye2(tablet, step)).toEqual(posted(step));
    expect(dye2List(tablet, "equipment")).toEqual(dye2Keys().equipment);
    expect(dye2List(tablet, "baskets")).toEqual(dye2Keys().baskets);
  });

  it("DYE2's recipe editor saves each slot as recorded, blank fields as 0", async () => {
    for (const step of Object.values(recipes)) {
      expect(await saveInDye2(tablet, step)).toEqual(posted(step));
      expect(dye2List(tablet, "recipes")).toEqual(posted(step));
    }
    const blank = (dye2List(tablet, "recipes") as { id: string; dashboardVariables: Record<string, unknown> }[]).find((recipe) => recipe.id === "3")!;
    expect(blank.dashboardVariables).toMatchObject({ dose: 0, drink: 0, steamFlowMls: 0, flushS: 0, hotWaterMl: 0, grind: 0 });
  });

  it("applying a recipe on DYE2's dashboard leaves the Workflow Decaid answered", async () => {
    for (const step of Object.values(dye2Applies)) {
      const answers = await replayWrites(tablet, step);
      expect(answers).toEqual(step.filter(({ request }) => request.method === "PUT").map(({ response }) => response));
      expect(tablet.workflow()).toEqual(answeredWorkflow(step));
    }
  });

  it("applying a recipe on Streamline's DYE strip, and its auto-save, leave the Workflow, values and recipes recorded", async () => {
    for (const [name, step] of Object.entries(streamline)) {
      const writes = step.filter(({ request }) => request.method !== "GET" && !request.path.startsWith(`/store/${DYE2_NAMESPACE}/`));
      if (name.startsWith("apply")) await replayWrites(tablet, step);
      else {
        const saved = await autoSaveInStreamline(tablet, step);
        expect(saved, name).toEqual(name === "noAutoSaveAfterLibraryProfile" ? undefined : posted(step));
      }
      expect(tablet.workflow(), name).toEqual(answeredWorkflow(step));
      for (const { request } of writes.filter(({ request }) => request.path.startsWith("/store/streamline-app/"))) {
        expect(tablet.storeValue("streamline-app", request.path.split("/").pop()!)).toEqual(request.body);
      }
    }
    expect(dye2List(tablet, "recipes")).toEqual(dye2Keys().recipes);
  });
});

describe("DYE2 and Streamline replayed on a tablet holding other data", () => {
  type Recipe = { id: string; name: string; dashboardVariables: Record<string, unknown> };
  const recipe = (tablet: SimulatedTablet, id: string) => (dye2List(tablet, "recipes") as Recipe[]).find((item) => item.id === id);

  /**
   * Derived from the recorded lists: slot 2 with its hot water by temperature
   * and a dose, yield and brew temperature of its own, a slot 4 copied from
   * slot 3, and a tool the recording never made.
   */
  function loadDerived(): SimulatedTablet {
    const keys = dye2Keys();
    const recipes = keys.recipes as Recipe[];
    const { hotWaterMl: _volume, ...slot2Variables } = recipes.find((item) => item.id === "2")!.dashboardVariables;
    const slot2 = { ...recipes.find((item) => item.id === "2")!, dashboardVariables: { ...slot2Variables, dose: 18, drink: 40, brewC: 90, hotWaterMode: "temp", hotWaterTempC: 80 } };
    const slot4 = { ...recipes.find((item) => item.id === "3")!, id: "4", name: "Fixture Derived Recipe" };
    const tool = { ...keys.equipment[1], id: "fixture-derived-tool", name: "Fixture Derived Tamper" };
    return load({
      ...dye2Library(),
      "/store/dye2.reaplugin/recipes": [...recipes.map((item) => (item.id === "2" ? slot2 : item)), slot4],
      "/store/dye2.reaplugin/equipment": [...keys.equipment, tool],
    });
  }

  it("Streamline's auto-save writes the fields it reads from the Workflow change into the tablet's recipe, leaving the rest", async () => {
    const tablet = loadDerived();
    const streamline = dye2Recording("streamline");
    const slot4 = recipe(tablet, "4");
    await autoSaveInStreamline(tablet, streamline.autoSaveDose);
    // The yield Streamline sent with the dose, and the Profile's first step temperature, as Streamline saves them.
    expect(recipe(tablet, "2")!.dashboardVariables).toMatchObject({ dose: 20, drink: 36, brewC: 94, hotWaterMode: "temp", hotWaterTempC: 80 });
    await autoSaveInStreamline(tablet, streamline.autoSaveHotWater);
    expect(recipe(tablet, "2")!.dashboardVariables).toMatchObject({ hotWaterMode: "vol", hotWaterMl: 155, hotWaterTempC: 80 });
    expect(recipe(tablet, "4")).toEqual(slot4);
  });

  it("Streamline saves nothing after a Workflow change Decaid refuses", async () => {
    const tablet = loadDerived();
    // With no machine connected, Decaid refuses a hot water change with a 500.
    tablet.machineConnected = false;
    const recipes = dye2List(tablet, "recipes");
    expect(await autoSaveInStreamline(tablet, dye2Recording("streamline").autoSaveHotWater)).toBeUndefined();
    expect(dye2List(tablet, "recipes")).toEqual(recipes);
  });

  it("Streamline saves nothing into a recipe the tablet no longer holds", async () => {
    const tablet = loadDerived();
    const without = (dye2List(tablet, "recipes") as Recipe[]).filter((item) => item.id !== "2");
    await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", without);
    expect(await autoSaveInStreamline(tablet, dye2Recording("streamline").autoSaveGrind)).toBeUndefined();
    expect(dye2List(tablet, "recipes")).toEqual(without);
  });

  it("DYE2's edit and deletion of tools another tablet holds under its own ids change those, keeping when each was made", async () => {
    // Derived: the tools as DYE2 read them before editing one, under ids of another tablet's DYE2, made earlier there.
    const tools = dye2Recording("tools");
    const elsewhere = (tool: Record<string, unknown>) => ({ ...tool, id: `elsewhere-${String(tool.id)}` });
    const read = tools.editWdtTool[0]!.response.body as Record<string, unknown>[];
    const held: Record<string, unknown>[] = read.map((tool) => ({ ...elsewhere(tool), createdAt: "2026-01-02T03:04:05.000Z" }));
    const tablet = load({ ...dye2Library(), "/store/dye2.reaplugin/equipment": held });
    await saveInDye2(tablet, tools.editWdtTool, elsewhere);
    const edited = (posted(tools.editWdtTool) as Record<string, unknown>[]).find((tool) => tool.name === "Fixture WDT Tool")!;
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
