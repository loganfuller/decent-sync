import { afterAll, describe, expect, it } from "vitest";
import type { DecaidAnswer } from "./support/decaid-beans.js";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  type Dye2Step,
  SimulatedDye2,
  dye2Keys,
  dye2Library,
  dye2List,
  dye2MachineSettingsLibrary,
  dye2MainRecording,
  dye2Recording,
  dye2StoreExchanges,
  openDye2Dashboard,
  replayWrites,
  saveInDye2,
} from "./support/simulated-dye2.js";
import { SimulatedTablet, de1ProOnDecaid090 } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated tablet's plugin storage, and the helpers that act as DYE2
// `main` (2cf631c) on it, against what DYE2's pages were recorded writing on
// Decaid v0.9.0's Linux release (fixtures/decaid/dye2-2cf631c/). No settings
// are given, so the plugin does not connect, and only Decaid's API is used.

/** How much faster the tablet's clock runs: DYE2's 1.5 s wait and 3 s echo window shrink with it. */
const TIME_SCALE = 20;

type Record_ = Record<string, unknown>;

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

function load(api = dye2Library(), dye2?: SimulatedDye2): SimulatedTablet {
  // Recorded on Decaid's simulated machine, which keeps no flush time or temperature written to it.
  const tablet = SimulatedTablet.load({ settings: {}, api, dye2, timeScale: TIME_SCALE, keepsFlushSettings: false });
  tablets.push(tablet);
  return tablet;
}

/** Waits that long on the tablet's clock. */
const waitTablet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms / TIME_SCALE));

/** The list a step's last write posted. */
function posted(step: Dye2Exchange[]): unknown {
  return step.filter(({ request }) => request.method === "POST" && request.path.startsWith(`/store/${DYE2_NAMESPACE}/`)).at(-1)!.request.body;
}

/**
 * Checks a step made again on the tablet: its reads once DYE2 would have
 * recorded, the pushes DYE2 made since `pushes` and the context of each
 * Workflow change since `changes`, as recorded.
 */
async function expectAfter(tablet: SimulatedTablet, dye2: SimulatedDye2, events: unknown[], step: Dye2Step, pushes: number, changes: number): Promise<void> {
  await waitTablet(2000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const answers: DecaidAnswer[] = [];
  for (const { request } of step.after) answers.push(await tablet.callApi(request.method, request.path));
  expect(answers).toEqual(step.after.map(({ response }) => response));
  expect(dye2.pushes.slice(pushes)).toEqual(step.pushes);
  expect(events.slice(changes)).toEqual(step.events);
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
  const library = dye2MainRecording<{ profiles: { profile: { title: string } }[]; machineSettings: unknown }>("library");
  const dye2 = new SimulatedDye2();
  // The recording's simulated machine's settings, which DYE2 reads the flush temperature and flow from.
  const tablet = load({ ...dye2Library(), "/machine/settings": library.machineSettings }, dye2);
  const events: unknown[] = [];
  tablet.onWorkflowChange((workflow) => events.push(structuredClone(workflow.context ?? null)));
  const tools = dye2Recording("tools");
  const baskets = dye2Recording("baskets");
  const recipes = dye2Recording("recipes");
  const dye2Applies = dye2Recording("dye2-applies");

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

  const checkAfter = (step: Dye2Step, pushes: number, changes: number) => expectAfter(tablet, dye2, events, step, pushes, changes);

  it("applying a recipe on DYE2's dashboard sends the Workflow recorded, then selects it, which marks the Workflow", async () => {
    // As the recording did before saving slot 2: the Workflow's profile set to the one slot 2 reads.
    await tablet.callApi("PUT", "/workflow", { profile: library.profiles.find((record) => record.profile.title === "Classic Italian espresso")!.profile });
    for (const [name, slot] of [
      ["applySlot1", "1"],
      ["applySlot2", "2"],
      ["applyBlankSlot3", "3"],
      ["applySlot1Again", "1"],
    ] as const) {
      const step = dye2Applies[name];
      const [pushes, changes] = [dye2.pushes.length, events.length];
      const page = await openDye2Dashboard(tablet);
      const applied = await page.applyRecipe(slot);
      const writes = step.exchanges.filter(({ request }) => request.method !== "GET");
      expect(page.lastSent, name).toEqual(writes[0]!.request.body);
      expect([applied.workflow, applied.selection], name).toEqual(writes.map(({ response }) => response));
      await checkAfter(step, pushes, changes);
      // Past DYE2's echo window, as the recording opened the dashboard afresh for each.
      await waitTablet(3000);
    }
  });

  it("a basket picked for the next Shot, and one picked in Edit Shot, are recorded into the recipe selected, leaving the lists recorded", async () => {
    const step = dye2Applies.pickBasket;
    const [pushes, changes] = [dye2.pushes.length, events.length];
    expect(await replayWrites(tablet, step)).toEqual(step.exchanges.filter(({ request }) => request.method === "PUT").map(({ response }) => response));
    await checkAfter(step, pushes, changes);
    const shot = dye2MainRecording<{ pickShotBasket: Dye2Exchange[] }>("shot");
    for (const answer of await replayWrites(tablet, shot.pickShotBasket)) expect(answer.status).toBe(200);
    await waitTablet(2500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dye2List(tablet, "recipes")).toEqual(dye2Keys().recipes);
  });
});

describe("DYE2's Machine Settings replayed on a simulated tablet", () => {
  runAsSteps();
  const recorded = dye2Recording("machine-settings");
  const dye2 = new SimulatedDye2();
  const tablet = load(dye2MachineSettingsLibrary(), dye2);
  const events: unknown[] = [];
  tablet.onWorkflowChange((workflow) => events.push(structuredClone(workflow.context ?? null)));
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

  it("applying it on DYE2's dashboard sends every machine setting it holds, turning on steam the Workflow had off, then selects it", async () => {
    const off = recorded.steamOffInWorkflow;
    let [pushes, changes] = [dye2.pushes.length, events.length];
    expect(await replayWrites(tablet, off)).toEqual(off.exchanges.map(({ response }) => response));
    await expectAfter(tablet, dye2, events, off, pushes, changes);
    const step = recorded.applyMachineSettings;
    [pushes, changes] = [dye2.pushes.length, events.length];
    const page = await openDye2Dashboard(tablet);
    const applied = await page.applyRecipe("1");
    const writes = step.exchanges.filter(({ request }) => request.method !== "GET");
    expect(page.lastSent).toEqual(writes[0]!.request.body);
    expect(page.lastSent).toMatchObject({
      steamSettings: { targetTemperature: 150, duration: 32, flow: 1.2, stopAtTemperature: 0 },
      hotWaterData: { targetTemperature: 85, duration: 30, volume: 150, flow: 4 },
      rinseData: { targetTemperature: 90, duration: 5, flow: 5 },
    });
    expect([applied.workflow, applied.selection]).toEqual(writes.map(({ response }) => response));
    await expectAfter(tablet, dye2, events, step, pushes, changes);
  });

  it("a Workflow change once it is selected is recorded with the flush temperature the machine reports", async () => {
    // Past DYE2's echo window, as recorded.
    await waitTablet(3000);
    const step = recorded.changeAfterApply;
    const [pushes, changes] = [dye2.pushes.length, events.length];
    expect(await replayWrites(tablet, step)).toEqual(step.exchanges.map(({ response }) => response));
    await expectAfter(tablet, dye2, events, step, pushes, changes);
    expect(dye2.recorded.at(-1)).toEqual({ kind: "recipe", id: "1", patch: { grind: 2.6, flushTempC: 25 } });
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
