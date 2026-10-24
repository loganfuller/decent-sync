import { GLOBAL_ID_KEY, profileAtBrewTemperature } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { editedContent } from "../src/library/equipment-intake.js";
import {
  EDITED_PATHS,
  type IntakeContext,
  type MappedKind,
  type MappedRecipe,
  type WriteContext,
  editedPaths,
  holdsRecipe,
  libraryValues,
  planRecipeIntake,
  readReportedRecipes,
  recipeContent,
  recipeRecord,
  recipeView,
  recipeWorkflow,
  recordOf,
  slotMove,
  steamOffPaths,
  tabletIds,
  withHeldFieldFlags,
} from "../src/library/recipe-intake.js";
import { dye2Keys, dye2Library } from "./support/simulated-dye2.js";

// How a DYE2 recipe record maps to a Recipe, both ways (ADR-0005): its
// fields in the Library's terms, read through the tablet's map, and the
// record a tablet is to hold of a Recipe, under its own ids, with what DYE2
// derives regenerated, and the steam, hot water and flush settings it holds,
// a steam temperature turning steam off no edit; and what a report of a tablet's recipes
// changes, by record id, and how a record's Recipe Slot moves its Recipe. Through the pure module's
// interface. Records are DYE2 2cf631c's, as it saved them
// (fixtures/decaid/dye2-2cf631c/keys.json), with made-up global ids.

type Record_ = Record<string, unknown>;

const [slot1, slot2, blank] = dye2Keys().recipes as [Record_, Record_, Record_];
const READ = "2026-10-12T20:30:00.000Z";

/** The recording's tablet's ids for what its recipes name (fixtures/decaid/dye2-2cf631c/library.json, keys.json), and made-up global ids for them. */
const LOCAL = {
  brazil: "1497c30b-e01e-4241-b1b0-a82bdae089d3",
  ethiopia: "bdae1553-8b0f-4d37-94a1-15d61b543e74",
  ethiopiaBatch: "6f741a24-ceb9-4ec6-aa51-750c6e9fec26",
  grinder: "cc95ada6-98db-4495-8b24-a46239ad94a0",
  basket18: "b09fb95c-7e5d-4be1-a4b8-d89c79523343",
  basket20: "fa7809d4-1843-4745-8a37-ca6f43025dba",
  wdtTool: "0ee0a5bb-5e08-4a2b-9bce-3b256693a6d2",
  puckScreen: "28dc53fe-df8b-4789-9589-49ef5e45d57e",
} as const;
const GLOBAL = {
  brazil: "11111111-1111-4111-8111-111111111111",
  ethiopia: "22222222-2222-4222-8222-222222222222",
  ethiopiaBatch: "33333333-3333-4333-8333-333333333333",
  laterEthiopiaBatch: "44444444-4444-4444-8444-444444444444",
  grinder: "55555555-5555-4555-8555-555555555555",
  basket18: "66666666-6666-4666-8666-666666666666",
  basket20: "77777777-7777-4777-8777-777777777777",
  wdtTool: "88888888-8888-4888-8888-888888888888",
  puckScreen: "99999999-9999-4999-8999-999999999999",
  recipe: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;
const ADAPTIVE = "profile:98fa00c191551b435845";

/** The recording's tablet's map. */
const recordedIds = tabletIds(
  (Object.keys(LOCAL) as (keyof typeof LOCAL)[]).map((name) => ({ kind: kindOf(name), itemId: GLOBAL[name], localId: LOCAL[name] })),
);

function kindOf(name: keyof typeof LOCAL): MappedKind {
  if (name === "brazil" || name === "ethiopia") return "bean";
  if (name === "ethiopiaBatch") return "beanBatch";
  if (name === "grinder") return "grinder";
  return name.startsWith("basket") ? "basket" : "tool";
}

/** Another tablet's map: the same items under ids of its own, but the WDT Tool, which it holds no record of. */
const otherIds = tabletIds([
  { kind: "bean", itemId: GLOBAL.ethiopia, localId: "other-ethiopia" },
  { kind: "beanBatch", itemId: GLOBAL.ethiopiaBatch, localId: "other-batch" },
  { kind: "grinder", itemId: GLOBAL.grinder, localId: "other-grinder" },
  { kind: "basket", itemId: GLOBAL.basket18, localId: "other-basket" },
  { kind: "tool", itemId: GLOBAL.puckScreen, localId: "other-puck-screen" },
]);

const intake = (context: Partial<IntakeContext> = {}): IntakeContext => ({
  ids: recordedIds,
  grinders: new Set([GLOBAL.grinder]),
  batchBeans: new Map([
    [GLOBAL.ethiopiaBatch, GLOBAL.ethiopia],
    [GLOBAL.laterEthiopiaBatch, GLOBAL.ethiopia],
  ]),
  latestBatches: new Map([
    [GLOBAL.ethiopia, GLOBAL.laterEthiopiaBatch],
    [GLOBAL.brazil, null],
  ]),
  snapshotProfile: null,
  ...context,
});

const adaptive = (dye2Library()["/profiles"] as Record_[]).find((profile) => profile.id === ADAPTIVE)!.profile as Record_;

const writing = (ids = otherIds): WriteContext => ({
  ids,
  beanNames: new Map([[GLOBAL.ethiopia, "Fixture Ethiopia"]]),
  beanRoasters: new Map([[GLOBAL.ethiopia, "Fixture Roasters"]]),
  grinderModels: new Map([[GLOBAL.grinder, "Fixture Grinder 64"]]),
  basketNames: new Map([[GLOBAL.basket18, "Fixture 18g Precision"]]),
  toolNames: new Map([
    [GLOBAL.wdtTool, "Fixture WDT Tool"],
    [GLOBAL.puckScreen, "Fixture Puck Screen"],
  ]),
  profiles: new Map([[ADAPTIVE, adaptive]]),
});

/** Slot 1's content as the Library takes it in: the dial DYE2 saved, and what it names by global ids. */
const slot1Content = {
  name: "Fixture Ethiopia Espresso",
  beverage: "Fixture Flat White",
  beanId: GLOBAL.ethiopia,
  beanBatchId: GLOBAL.laterEthiopiaBatch,
  profileId: ADAPTIVE,
  showOnDashboard: true,
  dose: 18.5,
  yield: 36,
  brewTemperature: 92,
  steamMode: "time",
  hotWaterMode: "temp",
  steamDuration: 30,
  hotWaterTemperature: 88,
  flushDuration: 5,
  grindSetting: 2.7,
  rpm: 900,
  grinderId: GLOBAL.grinder,
  basketId: GLOBAL.basket18,
  toolIds: [GLOBAL.wdtTool, GLOBAL.puckScreen],
  toolAttributes: { [GLOBAL.wdtTool]: [{ key: "Needles", value: "12" }, { key: "Needle size", value: "0.3 mm" }] },
};

describe("DYE2's recipes as Recipes", () => {
  it("reads each record under its id with the global id its own field carries, and when the plugin first read it", () => {
    const carrying = { ...slot2, [GLOBAL_ID_KEY]: GLOBAL.recipe.toUpperCase() };
    expect(readReportedRecipes([slot1, carrying], [null, READ])).toEqual([{ localId: "2", globalId: GLOBAL.recipe, updatedAt: new Date(READ), record: carrying }]);
    // DYE2's ids are opaque: a UUID from its editor, `recipe-…` from its save-recipe.
    const saved = { ...slot2, id: "recipe-mh2k9x1abc", stripSlot: null };
    expect(readReportedRecipes([slot1, saved], [READ, READ]).map((record) => record.localId)).toEqual(["1", "recipe-mh2k9x1abc"]);
    // A list holding one id twice is in a shape that is not recognised, and gives none.
    expect(readReportedRecipes([slot1, { ...slot2, id: "1" }], [READ, READ])).toEqual([]);
  });

  it("takes a record's content in in the Library's terms, through the tablet's map, ignoring what DYE2 derives and the barista", () => {
    const content = recipeContent(recipeView(slot1), intake());
    expect(content).toEqual(slot1Content);
    // A blank recipe names no Bean, and holds none of the numbers DYE2 saved blank, as it leaves them out (decentespresso/dye2#29).
    expect(recipeContent(recipeView(blank), intake())).toEqual({
      name: "Fixture Blank Recipe",
      beverage: "",
      showOnDashboard: true,
      steamMode: "flow",
      hotWaterMode: "vol",
      grinderId: GLOBAL.grinder,
      basketId: GLOBAL.basket18,
      toolIds: [],
      toolAttributes: {},
    });
    // A Profile read from the Workflow is named by its whole profile alone: it is the Library's Profile that profile is.
    expect(recipeContent(recipeView(slot2), intake({ snapshotProfile: "profile:39e939592679fb194706" })).profileId).toBe("profile:39e939592679fb194706");
    expect(recipeContent(recipeView(slot2), intake())).not.toHaveProperty("profileId");
    // One that is none of the Library's changes no Recipe's Profile; a record naming no profile at all clears it.
    expect(libraryValues(recipeView(slot2), ["profileSnapshot"], { profileId: ADAPTIVE }, intake())).toEqual({});
    expect(libraryValues(recipeView(blank), ["profileId"], { profileId: ADAPTIVE }, intake())).toEqual({ profileId: null });
    // A Bean with no batch at the Location gives the Recipe none; a Grinder of another Location, or one the map does not
    // hold, is none of its; and a Tool the map does not hold is left out.
    expect(recipeContent(recipeView(slot2), intake())).toMatchObject({ beanId: GLOBAL.brazil, basketId: GLOBAL.basket20, toolIds: [GLOBAL.puckScreen] });
    expect(recipeContent(recipeView(slot2), intake())).not.toHaveProperty("beanBatchId");
    expect(recipeContent(recipeView(slot1), intake({ grinders: new Set() }))).not.toHaveProperty("grinderId");
    const unmapped = { ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), equipmentIds: ["tool-of-its-own", LOCAL.wdtTool] } };
    expect(recipeContent(recipeView(unmapped), intake()).toolIds).toEqual([GLOBAL.wdtTool]);
  });

  it("takes the batch a record holds with its Bean, as DYE2's editor picks one, but none of another Bean", () => {
    const withBatch = (batch: string | null, bean: string = LOCAL.ethiopia) => recipeView({ ...slot1, beanId: bean, beanBatchId: batch });
    // Picked with the Ethiopia, or on its own for the same Bean.
    expect(libraryValues(withBatch(LOCAL.ethiopiaBatch), ["beanId", "beanBatchId"], { beanBatchId: "brazil-batch" }, intake())).toEqual({
      beanId: GLOBAL.ethiopia,
      beanBatchId: GLOBAL.ethiopiaBatch,
    });
    expect(libraryValues(withBatch(LOCAL.ethiopiaBatch), ["beanBatchId"], { beanId: GLOBAL.ethiopia, beanBatchId: GLOBAL.laterEthiopiaBatch }, intake())).toEqual({
      beanBatchId: GLOBAL.ethiopiaBatch,
    });
    // A batch of another Bean than the record's, or one the map does not hold, is none: the Bean's rule stands.
    expect(libraryValues(withBatch(LOCAL.ethiopiaBatch, LOCAL.brazil), ["beanId", "beanBatchId"], {}, intake())).toEqual({ beanId: GLOBAL.brazil, beanBatchId: null });
    expect(libraryValues(withBatch("batch-of-its-own"), ["beanBatchId"], { beanBatchId: GLOBAL.ethiopiaBatch }, intake())).toEqual({ beanBatchId: GLOBAL.ethiopiaBatch });
    // A record holding no batch keeps the Recipe's of its Bean.
    expect(libraryValues(withBatch(null), ["beanBatchId"], { beanBatchId: GLOBAL.ethiopiaBatch }, intake())).toEqual({ beanBatchId: GLOBAL.ethiopiaBatch });
  });

  it("keeps a Recipe's batch of the Bean picked, or takes that Bean's batch most recently added at the Location, or none", () => {
    const view = recipeView(slot1);
    // The Recipe's batch is of the Ethiopia: picking the Ethiopia again keeps it.
    expect(libraryValues(view, ["beanId"], { beanBatchId: GLOBAL.ethiopiaBatch }, intake())).toEqual({ beanId: GLOBAL.ethiopia, beanBatchId: GLOBAL.ethiopiaBatch });
    // A Brazil's batch is not: the Ethiopia's latest there replaces it.
    expect(libraryValues(view, ["beanId"], { beanBatchId: "brazil-batch" }, intake())).toEqual({ beanId: GLOBAL.ethiopia, beanBatchId: GLOBAL.laterEthiopiaBatch });
    // The Brazil has no batch at the Location; a bean the map does not hold is none.
    expect(libraryValues(recipeView({ ...slot1, beanId: LOCAL.brazil }), ["beanId"], { beanBatchId: GLOBAL.ethiopiaBatch }, intake())).toEqual({
      beanId: GLOBAL.brazil,
      beanBatchId: null,
    });
    expect(libraryValues(recipeView({ ...slot1, beanId: "bean-of-its-own" }), ["beanId"], {}, intake())).toEqual({ beanId: null, beanBatchId: null });
  });

  it("takes each steam, hot water and flush setting a record holds, a blank one holding none, but no steam turned off, and keeps a Recipe's Tools the tablet holds no record of", () => {
    // Saved by temperature, the record leaves its volume out, which the Recipe then holds none of.
    const byTemperature = recipeView(slot1);
    expect(libraryValues(byTemperature, ["dashboardVariables.hotWaterMl", "dashboardVariables.hotWaterTempC", "dashboardVariables.hotWaterMode"], {}, intake())).toEqual({
      hotWaterMode: "temp",
      hotWaterTemperature: 88,
      hotWaterVolume: null,
    });
    // A steam temperature below 135 °C is steam off, as DYE2's editor saves "Off" as 0: no edit, so it is written back.
    const steaming = (steamTempC: number) => recipeView({ ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), steamTempC, steamStopAtTempC: 0 } });
    expect(libraryValues(steaming(150), ["dashboardVariables.steamTempC", "dashboardVariables.steamStopAtTempC"], {}, intake())).toEqual({ steamTemperature: 150, steamStopTemperature: 0 });
    for (const off of [0, 120]) {
      expect(libraryValues(steaming(off), ["dashboardVariables.steamTempC", "dashboardVariables.steamStopAtTempC"], {}, intake())).toEqual({ steamStopTemperature: 0 });
      expect(steamOffPaths(editedContent(recipeView(slot1), steaming(off), null))).toEqual(["dashboardVariables.steamTempC"]);
    }
    expect(steamOffPaths(editedContent(recipeView(slot1), steaming(150), null))).toEqual([]);
    expect(recipeContent(steaming(0), intake())).not.toHaveProperty("steamTemperature");
    // A tablet that holds no record of the WDT Tool could never name it: picking another Tool keeps it, where it was.
    const other = recipeView({ ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), equipmentIds: ["other-puck-screen"], equipmentCustom: {} } });
    const current = { toolIds: [GLOBAL.wdtTool], toolAttributes: { [GLOBAL.wdtTool]: [{ key: "Needles", value: "12" }] } };
    expect(libraryValues(other, ["dashboardVariables.equipmentIds", "dashboardVariables.equipmentCustom"], current, intake({ ids: otherIds }))).toEqual({
      toolIds: [GLOBAL.wdtTool, GLOBAL.puckScreen],
      toolAttributes: current.toolAttributes,
    });
    // The same Tools, some kept, keep the Recipe's order, so they are no edit; a Tool it held, taken off, goes.
    const same = { toolIds: [GLOBAL.puckScreen, GLOBAL.wdtTool] };
    expect(libraryValues(other, ["dashboardVariables.equipmentIds"], same, intake({ ids: otherIds }))).toEqual({ toolIds: same.toolIds });
    const none = recipeView({ ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), equipmentIds: [] } });
    expect(libraryValues(none, ["dashboardVariables.equipmentIds"], same, intake({ ids: otherIds }))).toEqual({ toolIds: [GLOBAL.wdtTool] });
    // A Basket it holds no record of stays the Recipe's while its record names none; one it names replaces it.
    const basketless = recipeView({ ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), basketId: null } });
    expect(libraryValues(basketless, ["dashboardVariables.basketId"], { basketId: GLOBAL.basket20 }, intake({ ids: otherIds }))).toEqual({});
    expect(libraryValues(basketless, ["dashboardVariables.basketId"], { basketId: GLOBAL.basket18 }, intake({ ids: otherIds }))).toEqual({ basketId: null });
    const picked = recipeView({ ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), basketId: "other-basket" } });
    expect(libraryValues(picked, ["dashboardVariables.basketId"], { basketId: GLOBAL.basket20 }, intake({ ids: otherIds }))).toEqual({ basketId: GLOBAL.basket18 });
  });

  it("writes a Recipe to a tablet under its own ids, with its full Profile, a blank barista, the settings it holds, and what DYE2 derives, its embedded Workflow's Profile at its brew temperature", () => {
    const view = recipeRecord(slot1Content, 1, writing(), GLOBAL.recipe);
    // Adaptive v3 starts at 93 °C: at the Recipe's 92, every step is a degree cooler.
    const adaptiveAt92 = profileAtBrewTemperature(adaptive, 92);
    expect((adaptiveAt92?.steps as Record_[]).map((step) => step.temperature)).toEqual([92, 92, 87, 87, 87, 87, 87]);
    expect(view).toEqual({
      name: "Fixture Ethiopia Espresso",
      beverage: "Fixture Flat White",
      barista: "",
      drinker: "",
      beanId: "other-ethiopia",
      beanName: "Fixture Ethiopia",
      // The tablet holds no record of the Recipe's batch.
      beanBatchId: null,
      beanRoaster: "Fixture Roasters",
      profileId: ADAPTIVE,
      profileTitle: "Adaptive v3",
      // DYE2 applies it at the Recipe's brew temperature (decentespresso/dye2#26).
      profileSnapshot: adaptive,
      showOnStreamlineDashboard: true,
      // Its Recipe Slot, the button of Streamline's strip it is on.
      stripSlot: 1,
      "dashboardVariables.dose": 18.5,
      "dashboardVariables.drink": 36,
      "dashboardVariables.ratio": null,
      "dashboardVariables.brewC": 92,
      "dashboardVariables.steamMode": "time",
      "dashboardVariables.hotWaterMode": "temp",
      // A setting the Recipe holds none of is blank, so applying it leaves the Machine's own.
      "dashboardVariables.steamTempC": null,
      "dashboardVariables.steamTimeS": 30,
      "dashboardVariables.steamFlowMls": null,
      "dashboardVariables.steamStopAtTempC": null,
      "dashboardVariables.hotWaterTempC": 88,
      "dashboardVariables.hotWaterTimeS": null,
      "dashboardVariables.hotWaterMl": null,
      "dashboardVariables.hotWaterFlowMls": null,
      "dashboardVariables.flushTempC": null,
      "dashboardVariables.flushS": 5,
      "dashboardVariables.flushFlowMls": null,
      "dashboardVariables.grind": 2.7,
      "dashboardVariables.rpm": 900,
      "dashboardVariables.grinderId": "other-grinder",
      "dashboardVariables.grinderModel": "Fixture Grinder 64",
      "dashboardVariables.basketId": "other-basket",
      "dashboardVariables.basketName": "Fixture 18g Precision",
      // The WDT Tool, which this tablet holds no record of, is left out, with its attributes.
      "dashboardVariables.equipmentIds": ["other-puck-screen"],
      "dashboardVariables.equipmentNames": ["Fixture Puck Screen"],
      "dashboardVariables.equipmentCustom": {},
      title: "Fixture Ethiopia Espresso",
      subtitle: "Fixture Ethiopia",
      workflow: {
        context: {
          targetDoseWeight: 18.5,
          targetYield: 36,
          grinderSetting: "2.7",
          grinderId: "other-grinder",
          grinderModel: "Fixture Grinder 64",
          // So a Workflow Streamline applies it to names the Recipe.
          extras: { rpm: 900, basketId: "other-basket", basketName: "Fixture 18g Precision" },
          // Applying it clears a batch the Workflow held, as DYE2's dashboard does.
          coffeeName: "Fixture Ethiopia",
          coffeeRoaster: "Fixture Roasters",
          beanBatchId: null,
        },
        // Streamline's strip applies it as it is.
        profile: adaptiveAt92,
        // Only the settings it holds, as partial parts.
        steamSettings: { duration: 30 },
        hotWaterData: { targetTemperature: 88 },
        rinseData: { duration: 5 },
      },
    });
    // Its batch is named by the tablet's id where it holds it; a nameless one is called by its slot; hot water by volume
    // keeps the temperature too, whatever the mode, which affects no load.
    const recorded = recipeRecord({ ...slot1Content, beanBatchId: GLOBAL.ethiopiaBatch, name: "", hotWaterMode: "vol", hotWaterVolume: 120 }, 4, writing(recordedIds), GLOBAL.recipe);
    expect(recorded.beanBatchId).toEqual(LOCAL.ethiopiaBatch);
    expect((recorded.workflow as { context: Record_ }).context.beanBatchId).toEqual(LOCAL.ethiopiaBatch);
    expect([recorded.title, recorded["dashboardVariables.hotWaterMl"], recorded["dashboardVariables.hotWaterTempC"]]).toEqual(["Recipe 4", 120, 88]);
    expect((recorded.workflow as Record_).hotWaterData).toEqual({ targetTemperature: 88, volume: 120 });
  });

  it("builds a recipe's embedded Workflow as DYE2 2cf631c does, from its yield or its dose times its ratio, with a Profile's id and title where it has no steps", () => {
    const keptWorkflow = slot1.workflow as Record_;
    // DYE2's own, as it saved slot 1, holds the same dial, grinder, Basket, coffee, roaster, batch, people, Profile at
    // the recipe's brew temperature, and settings it holds. It holds its field flags too.
    const view = recipeView(slot1);
    const { context } = keptWorkflow as { context: Record_ };
    const { dye: _flags, ...extras } = context.extras as Record_;
    expect(recipeWorkflow({ ...view, profileSnapshot: adaptive })).toEqual({ ...keptWorkflow, context: { ...context, extras } });
    const ratio = recipeWorkflow({ ...view, "dashboardVariables.drink": null, "dashboardVariables.ratio": 2.2, profileSnapshot: null });
    expect(ratio).toMatchObject({ context: { targetDoseWeight: 18.5, targetYield: 40.7 }, profile: { id: ADAPTIVE, title: "Adaptive v3" } });
    expect(recipeWorkflow(recipeView(blank))).not.toHaveProperty("profile");
  });

  it("keeps the field flags DYE2 saved into a tablet's record's embedded Workflow, but derives its settings from the Recipe's", () => {
    const view = recipeRecord({ ...slot1Content, hotWaterVolume: 250 }, 1, writing(), GLOBAL.recipe);
    const held = {
      workflow: {
        context: { extras: { dye: { v: 1, coffeeName: true } } },
        steamSettings: { duration: 30, targetTemperature: 0 },
        hotWaterData: { targetTemperature: 80, duration: 40, volume: 200, flow: 7.5 },
        rinseData: { duration: 5 },
      },
    };
    const kept = withHeldFieldFlags(view, held).workflow as Record_;
    // The settings the Recipe holds, as DYE2 embeds them, none of the tablet's own.
    expect(kept).toMatchObject({ steamSettings: { duration: 30 }, rinseData: { duration: 5 }, hotWaterData: { targetTemperature: 88, volume: 250 } });
    expect(kept.hotWaterData).toEqual({ targetTemperature: 88, volume: 250 });
    expect(kept.steamSettings).toEqual({ duration: 30 });
    expect(((kept.context as Record_).extras as Record_).dye).toEqual({ v: 1, coffeeName: true });
    expect((kept.context as Record_).coffeeRoaster).toBe("Fixture Roasters");
    // A record the tablet does not hold yet, or one with no flags, is written as derived.
    expect(withHeldFieldFlags(view, null)).toEqual(view);
    expect(withHeldFieldFlags(view, { workflow: { ...held.workflow, context: {} } })).toEqual(view);
  });

  it("writes a record a tablet holds where it differs, and takes back as written what the server wrote it", () => {
    const written = recipeRecord(slot1Content, 1, writing(recordedIds), GLOBAL.recipe);
    const record: Record_ = { ...recordOf(written), id: "1", [GLOBAL_ID_KEY]: GLOBAL.recipe };
    expect(recipeView(record)).toEqual(written);
    // Taken back in, it changes nothing of the Recipe.
    expect(holdsRecipe(recipeView(record), written)).toBe(true);
    expect(recipeContent(recipeView(record), intake())).toEqual({ ...slot1Content, beanBatchId: GLOBAL.laterEthiopiaBatch });
    // A barista's change of what DYE2 derives, or the barista, is no edit of the Recipe.
    const derived = recipeView({ ...record, title: "Retitled", barista: "Someone" });
    expect(editedPaths(editedContent(recipeView(record), derived, null))).toEqual([]);
    expect(holdsRecipe(derived, written)).toBe(true);
    const dosed = recipeView({ ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), dose: 19 } });
    expect(editedPaths(editedContent(recipeView(record), dosed, null))).toEqual(["dashboardVariables.dose"]);
    expect(holdsRecipe(dosed, written)).toBe(false);
    expect([...EDITED_PATHS]).not.toContain("barista");
  });

  it("writes a record's Recipe Slot as its stripSlot, null for none, which is no edit of its content", () => {
    const inSlot = recipeRecord(slot1Content, 3, writing(recordedIds), GLOBAL.recipe);
    const inNone = recipeRecord(slot1Content, null, writing(recordedIds), GLOBAL.recipe);
    expect(recordOf(inSlot).stripSlot).toBe(3);
    expect(inNone.stripSlot).toBeNull();
    expect(editedPaths(editedContent(inSlot, inNone, null))).toEqual([]);
    expect(holdsRecipe(inNone, inSlot)).toBe(true);
    // A nameless one is called by its slot, or Recipe in none.
    expect(recipeRecord({}, 4, writing(recordedIds), GLOBAL.recipe).title).toBe("Recipe 4");
    expect(recipeRecord({}, null, writing(recordedIds), GLOBAL.recipe).title).toBe("Recipe");
  });

  it("writes and takes in every steam, hot water and flush setting, and the modes, which choose only what DYE2's editor shows", () => {
    const settings = {
      steamTemperature: 150,
      steamDuration: 25,
      steamFlow: 1.3,
      steamStopTemperature: 0,
      hotWaterTemperature: 85,
      hotWaterDuration: 30,
      hotWaterVolume: 150,
      hotWaterFlow: 4,
      flushTemperature: 90,
      flushDuration: 3,
      flushFlow: 6,
    };
    const written = recipeRecord({ ...slot1Content, ...settings, steamMode: "flow" }, 1, writing(recordedIds), GLOBAL.recipe);
    expect(recordOf(written).dashboardVariables).toMatchObject({
      steamMode: "flow",
      steamTempC: 150,
      steamTimeS: 25,
      steamFlowMls: 1.3,
      steamStopAtTempC: 0,
      hotWaterTempC: 85,
      hotWaterTimeS: 30,
      hotWaterMl: 150,
      hotWaterFlowMls: 4,
      flushTempC: 90,
      flushS: 3,
      flushFlowMls: 6,
    });
    // As DYE2's record builder embeds them; a milk stop of 0 is off, a value.
    expect(recipeWorkflow(written)).toMatchObject({
      steamSettings: { targetTemperature: 150, duration: 25, flow: 1.3, stopAtTemperature: 0 },
      hotWaterData: { targetTemperature: 85, duration: 30, volume: 150, flow: 4 },
      rinseData: { targetTemperature: 90, duration: 3, flow: 6 },
    });
    // Reported back, the record is the Recipe, and each setting changed there is an edit of it, the mode included.
    const record = recordOf(written);
    expect(recipeContent(recipeView(record), intake())).toEqual({ ...slot1Content, ...settings, steamMode: "flow", beanBatchId: GLOBAL.laterEthiopiaBatch });
    const changed = recipeView({ ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), flushS: 6, steamMode: "time" } });
    expect(editedPaths(editedContent(written, changed, null)).sort()).toEqual(["dashboardVariables.flushS", "dashboardVariables.steamMode"]);
    expect(holdsRecipe(changed, written)).toBe(false);
    // A Recipe holding none embeds none of them.
    expect(recipeWorkflow(recipeView(blank))).not.toHaveProperty("steamSettings");
    expect(recipeContent(recipeView(blank), intake())).not.toHaveProperty("flushDuration");
  });

  it("decides a report by record id: an edit of the Recipe it is, a new Recipe for an id no Recipe here has, and a removal that takes one out", () => {
    const at = (record: Record_, id = record.id as string) => readReportedRecipes([{ ...record, id }], [READ])[0]!;
    const known: MappedRecipe = { itemId: GLOBAL.recipe, localId: "1", updatedAt: new Date(READ), record: slot1, listed: true };
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const recordIds = new Map([
      ["1", GLOBAL.recipe],
      ["3", other],
    ]);
    // The map's record as known changes nothing; changed, it is the barista's edit of its Recipe, moved to a slot or not.
    expect(planRecipeIntake([at(slot1)], [known], recordIds)).toEqual([]);
    const edited = at({ ...slot1, name: "Renamed" });
    expect(planRecipeIntake([edited], [known], recordIds)).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: edited }]);
    const moved = at({ ...slot1, stripSlot: 4 });
    expect(planRecipeIntake([moved], [known], recordIds)).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: moved }]);
    // A record under the record id of a Recipe the map does not hold: its record if it carries its global id, as after a
    // lost answer, and otherwise saved under it, an edit of it. One of an id no Recipe here has is a new Recipe.
    const carrying = at({ ...blank, [GLOBAL_ID_KEY]: other });
    const saved = at(slot2, "3");
    const added = at(slot2, "4b1f0a3e-6c1d-4e7a-9a52-1f0d3c7b2e81");
    expect(planRecipeIntake([carrying], [], recordIds)).toEqual([{ kind: "map", itemId: other, reported: carrying }]);
    expect(planRecipeIntake([saved], [], recordIds)).toEqual([{ kind: "edit", itemId: other, reported: saved }]);
    expect(planRecipeIntake([added], [], recordIds)).toEqual([{ kind: "add", reported: added }]);
    // Gone from the list, a record a report listed before is the tablet's removal; one never listed was a write lost.
    expect(planRecipeIntake([], [known], recordIds)).toEqual([{ kind: "delete", itemId: GLOBAL.recipe, localId: "1", updatedAt: new Date(READ), record: slot1 }]);
    expect(planRecipeIntake([], [{ ...known, listed: false }], recordIds)).toEqual([{ kind: "forget", itemId: GLOBAL.recipe, localId: "1" }]);
    // Listed but unreadable, it is no removal.
    expect(planRecipeIntake([], [known], recordIds, new Set(["1"]))).toEqual([]);
    // A tablet holding the Recipe under another id already does not take a new record under its id as its.
    const elsewhere: MappedRecipe = { ...known, itemId: other, localId: "2", record: slot2 };
    expect(planRecipeIntake([at(slot2), saved], [elsewhere], recordIds)).toEqual([]);
    // Another Location's, as before a move, it stays that Recipe's record, but is no edit of it: it is written over. So is
    // one carrying another item's global id, as a backup restored.
    expect(planRecipeIntake([edited], [known], new Map([["3", other]]), undefined, new Set([other]))).toEqual([{ kind: "map", itemId: GLOBAL.recipe, reported: edited }]);
    const restored = at({ ...slot1, name: "Restored", [GLOBAL_ID_KEY]: other });
    expect(planRecipeIntake([restored], [known], recordIds)).toEqual([{ kind: "map", itemId: GLOBAL.recipe, reported: restored }]);
    // An Archived Recipe's record id, which no Recipe here not Archived has, is a new Recipe's.
    expect(planRecipeIntake([saved], [], new Map([["1", GLOBAL.recipe]]))).toEqual([{ kind: "add", reported: saved }]);
  });

  it("moves a Recipe as its record's Recipe Slot changes, from the slot the record known was in", () => {
    const at = (record: Record_) => readReportedRecipes([record], [READ])[0]!;
    expect(slotMove(GLOBAL.recipe, { ...slot1, stripSlot: 1 }, at({ ...slot1, stripSlot: 4 }))).toEqual({ itemId: GLOBAL.recipe, from: 1, to: 4, at: new Date(READ) });
    expect(slotMove(GLOBAL.recipe, { ...slot1, stripSlot: 1 }, at({ ...slot1, stripSlot: null }))).toEqual({ itemId: GLOBAL.recipe, from: 1, to: null, at: new Date(READ) });
    expect(slotMove(GLOBAL.recipe, { ...slot1, stripSlot: 2 }, at({ ...slot1, stripSlot: 2, name: "Renamed" }))).toBeNull();
    // A new record's slot is taken from none; a slot outside 1 to 5 is none.
    expect(slotMove(GLOBAL.recipe, null, at({ ...slot1, stripSlot: 5 }))).toEqual({ itemId: GLOBAL.recipe, from: null, to: 5, at: new Date(READ) });
    expect(slotMove(GLOBAL.recipe, null, at({ ...slot1, stripSlot: 7 }))).toBeNull();
  });
});
