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
import { SimulatedTablet } from "./support/simulated-tablet.js";
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
    const tablet = load({ ...dye2Library(), "/store/dye2.reaplugin/recipes": [{ id: "1" }] });
    const recipes = dye2Keys().recipes;
    expect(await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", recipes)).toEqual({ status: 200, body: {} });
    expect(await tablet.callApi("GET", "/store/dye2.reaplugin/recipes")).toEqual({ status: 200, body: recipes });
    expect(dye2List(tablet, "recipes")).toEqual(recipes);
    for (const key of ["baskets", "equipment"]) expect(await tablet.callApi("GET", `/store/dye2.reaplugin/${key}`)).toEqual({ status: 200, body: null });
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
