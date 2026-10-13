import { GLOBAL_ID_KEY, RECIPE_FIELD } from "@decent-sync/protocol";
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
  tabletIds,
} from "../src/library/recipe-intake.js";
import { dye2Keys, dye2Library } from "./support/simulated-dye2.js";

// How a DYE2 recipe record maps to a Recipe, both ways (ADR-0005): its
// fields in the Library's terms, read through the tablet's map, and the
// record a tablet is to hold of a Recipe, under its own ids, with what DYE2
// derives regenerated and its hot water value of its mode; and what a
// report of a tablet's recipes changes, by slot. Through the pure module's
// interface. Records are DYE2 v0.1.19's, as it saved them
// (fixtures/decaid/dye2-v0.1.19/keys.json), with made-up global ids.

type Record_ = Record<string, unknown>;

const [slot1, slot2, blank] = dye2Keys().recipes as [Record_, Record_, Record_];
const READ = "2026-10-12T20:30:00.000Z";

/** The recording's tablet's ids for what its recipes name (fixtures/decaid/dye2-v0.1.19/library.json, keys.json), and made-up global ids for them. */
const LOCAL = {
  brazil: "6b16db38-425e-48ec-93b7-e03e1d8707cd",
  ethiopia: "8ee8ac01-bf2b-47d6-b4e2-292bd7ef5ada",
  ethiopiaBatch: "b850e4f2-89cf-400f-9d43-ec1080ad595b",
  grinder: "f9e3cee6-4fd0-4843-a959-b263b4e4411a",
  basket18: "5a792f42-b6ff-44e0-a58c-ed165741b789",
  basket20: "1749fba2-86b3-43e2-badf-97af64ae888b",
  wdtTool: "f204e0d6-cfa8-4fd9-9316-de2e6f0ae8e6",
  puckScreen: "57f7f897-1ecf-4f31-90f8-5f1363d8dfc2",
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
  hotWaterTemperature: 88,
  grindSetting: 2.7,
  rpm: 900,
  grinderId: GLOBAL.grinder,
  basketId: GLOBAL.basket18,
  toolIds: [GLOBAL.wdtTool, GLOBAL.puckScreen],
  toolAttributes: { [GLOBAL.wdtTool]: [{ key: "Needles", value: "12" }, { key: "Needle size", value: "0.3 mm" }] },
};

describe("DYE2's recipes as Recipes", () => {
  it("reads each record in a slot with the global id its own field carries, and when the plugin first read it", () => {
    const carrying = { ...slot2, [GLOBAL_ID_KEY]: GLOBAL.recipe.toUpperCase() };
    expect(readReportedRecipes([slot1, carrying], [null, READ])).toEqual([{ localId: "2", globalId: GLOBAL.recipe, updatedAt: new Date(READ), record: carrying }]);
    // A list whose ids are not all slot numbers is in a shape that is not recognised, and gives none.
    expect(readReportedRecipes([slot1, { ...slot2, id: "favourite-2" }], [READ, READ])).toEqual([]);
  });

  it("takes a record's content in in the Library's terms, through the tablet's map, ignoring what DYE2 derives and the barista", () => {
    const content = recipeContent(recipeView(slot1), intake());
    expect(content).toEqual(slot1Content);
    // A blank recipe names nothing; DYE2 saved its numbers as 0, which are its values.
    expect(recipeContent(recipeView(blank), intake())).toEqual({
      name: "Fixture Blank Recipe",
      beverage: "",
      showOnDashboard: true,
      dose: 0,
      yield: 0,
      brewTemperature: 93,
      steamMode: "flow",
      hotWaterMode: "vol",
      hotWaterVolume: 0,
      grindSetting: 0,
      rpm: 0,
      grinderId: GLOBAL.grinder,
      basketId: GLOBAL.basket18,
      toolIds: [],
      toolAttributes: {},
    });
    // A Profile read from the Workflow is named by its whole profile alone: it is the Library's Profile that profile is.
    expect(recipeContent(recipeView(slot2), intake({ snapshotProfile: "profile:39e939592679fb194706" })).profileId).toBe("profile:39e939592679fb194706");
    expect(recipeContent(recipeView(slot2), intake())).not.toHaveProperty("profileId");
    // A Bean with no batch at the Location gives the Recipe none; a Grinder of another Location, or one the map does not
    // hold, is none of its; and a Tool the map does not hold is left out.
    expect(recipeContent(recipeView(slot2), intake())).toMatchObject({ beanId: GLOBAL.brazil, basketId: GLOBAL.basket20, toolIds: [GLOBAL.puckScreen] });
    expect(recipeContent(recipeView(slot2), intake())).not.toHaveProperty("beanBatchId");
    expect(recipeContent(recipeView(slot1), intake({ grinders: new Set() }))).not.toHaveProperty("grinderId");
    const unmapped = { ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), equipmentIds: ["tool-of-its-own", LOCAL.wdtTool] } };
    expect(recipeContent(recipeView(unmapped), intake()).toolIds).toEqual([GLOBAL.wdtTool]);
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

  it("changes only the hot water value of the record's mode, and keeps a Recipe's Tools the tablet holds no record of", () => {
    // Saved by temperature, the record leaves its volume out, which stays as it is.
    const byTemperature = recipeView(slot1);
    expect(libraryValues(byTemperature, ["dashboardVariables.hotWaterMl", "dashboardVariables.hotWaterTempC", "dashboardVariables.hotWaterMode"], {}, intake())).toEqual({
      hotWaterMode: "temp",
      hotWaterTemperature: 88,
    });
    // A tablet that holds no record of the WDT Tool could never name it: picking another Tool keeps it.
    const other = recipeView({ ...slot1, dashboardVariables: { ...(slot1.dashboardVariables as Record_), equipmentIds: ["other-puck-screen"], equipmentCustom: {} } });
    const current = { toolIds: [GLOBAL.wdtTool], toolAttributes: { [GLOBAL.wdtTool]: [{ key: "Needles", value: "12" }] } };
    expect(libraryValues(other, ["dashboardVariables.equipmentIds", "dashboardVariables.equipmentCustom"], current, intake({ ids: otherIds }))).toEqual({
      toolIds: [GLOBAL.puckScreen, GLOBAL.wdtTool],
      toolAttributes: current.toolAttributes,
    });
  });

  it("writes a Recipe to a tablet under its own ids, with its full Profile, a blank barista, its hot water value of its mode, and what DYE2 derives", () => {
    const view = recipeRecord(slot1Content, 1, writing());
    expect(view).toEqual({
      name: "Fixture Ethiopia Espresso",
      beverage: "Fixture Flat White",
      barista: "",
      drinker: "",
      beanId: "other-ethiopia",
      beanName: "Fixture Ethiopia",
      profileId: ADAPTIVE,
      profileTitle: "Adaptive v3",
      profileSnapshot: adaptive,
      showOnStreamlineDashboard: true,
      "dashboardVariables.dose": 18.5,
      "dashboardVariables.drink": 36,
      "dashboardVariables.ratio": null,
      "dashboardVariables.brewC": 92,
      "dashboardVariables.steamMode": "time",
      "dashboardVariables.hotWaterMode": "temp",
      "dashboardVariables.hotWaterMl": null,
      "dashboardVariables.hotWaterTempC": 88,
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
      [RECIPE_FIELD]: { beanBatchId: null, hotWaterData: { targetTemperature: 88, duration: null, volume: null, flow: null } },
      title: "Fixture Ethiopia Espresso",
      subtitle: "Fixture Ethiopia",
      workflow: {
        context: {
          targetDoseWeight: 18.5,
          targetYield: 36,
          grinderSetting: "2.7",
          grinderId: "other-grinder",
          grinderModel: "Fixture Grinder 64",
          extras: { rpm: 900, basketId: "other-basket", basketName: "Fixture 18g Precision" },
          coffeeName: "Fixture Ethiopia",
        },
        profile: adaptive,
      },
    });
    // Its batch is named by the tablet's id where it holds it; a nameless one is called by its slot; hot water by volume
    // keeps the volume.
    const recorded = recipeRecord({ ...slot1Content, beanBatchId: GLOBAL.ethiopiaBatch, name: "", hotWaterMode: "vol", hotWaterVolume: 120 }, 4, writing(recordedIds));
    expect(recorded[RECIPE_FIELD]).toEqual({ beanBatchId: LOCAL.ethiopiaBatch, hotWaterData: { targetTemperature: 88, duration: null, volume: 120, flow: null } });
    expect([recorded.title, recorded["dashboardVariables.hotWaterMl"], recorded["dashboardVariables.hotWaterTempC"]]).toEqual(["Recipe 4", 120, null]);
  });

  it("builds a recipe's embedded Workflow as DYE2 does, from its yield or its dose times its ratio, with a Profile's id and title where it has no steps", () => {
    const keptWorkflow = slot1.workflow as Record_;
    // DYE2's own, as it saved slot 1, is what this builds from the record DYE2 saved, with its full Profile.
    const view = recipeView(slot1);
    expect(recipeWorkflow({ ...view, profileSnapshot: (keptWorkflow as { profile: unknown }).profile })).toEqual(keptWorkflow);
    const ratio = recipeWorkflow({ ...view, "dashboardVariables.drink": null, "dashboardVariables.ratio": 2.2, profileSnapshot: null });
    expect(ratio).toMatchObject({ context: { targetDoseWeight: 18.5, targetYield: 40.7 }, profile: { id: ADAPTIVE, title: "Adaptive v3" } });
    expect(recipeWorkflow(recipeView(blank))).not.toHaveProperty("profile");
  });

  it("writes a record a tablet holds where it differs, and takes back as written what the server wrote it", () => {
    const written = recipeRecord(slot1Content, 1, writing(recordedIds));
    const record: Record_ = { ...recordOf(written), id: "1", [GLOBAL_ID_KEY]: GLOBAL.recipe };
    expect(recipeView(record)).toEqual(written);
    // Taken back in, it changes nothing of the Recipe.
    expect(holdsRecipe(recipeView(record), written)).toBe(true);
    expect(recipeContent(recipeView(record), intake())).toEqual({ ...slot1Content, beanBatchId: GLOBAL.laterEthiopiaBatch });
    // A barista's change of what DYE2 derives, the barista or a value of steam or flush is no edit of the Recipe.
    const derived = recipeView({ ...record, title: "Retitled", barista: "Someone", dashboardVariables: { ...(record.dashboardVariables as Record_), steamTimeS: 25, flushS: 3 } });
    expect(editedPaths(editedContent(recipeView(record), derived, null))).toEqual([]);
    expect(holdsRecipe(derived, written)).toBe(true);
    const dosed = recipeView({ ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), dose: 19 } });
    expect(editedPaths(editedContent(recipeView(record), dosed, null))).toEqual(["dashboardVariables.dose"]);
    expect(holdsRecipe(dosed, written)).toBe(false);
    expect([...EDITED_PATHS]).not.toContain("barista");
  });

  it("decides a report by slot: an edit of the Recipe in it, a new Recipe in an empty one, and a removal that takes one out", () => {
    const at = (record: Record_, id = record.id as string) => readReportedRecipes([{ ...record, id }], [READ])[0]!;
    const known: MappedRecipe = { itemId: GLOBAL.recipe, localId: "1", updatedAt: new Date(READ), record: slot1, beforeWrite: null, listed: true };
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const slots = new Map([
      ["1", GLOBAL.recipe],
      ["3", other],
    ]);
    // The map's record as known changes nothing; changed, it is the barista's edit of its Recipe.
    expect(planRecipeIntake([at(slot1)], [known], slots)).toEqual([]);
    const edited = at({ ...slot1, name: "Renamed" });
    expect(planRecipeIntake([edited], [known], slots)).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: edited }]);
    // A record in the slot of a Recipe the map does not hold there: its record if it carries its global id, as after a lost
    // answer, and otherwise saved there, an edit of it. One in an empty slot is a new Recipe.
    const carrying = at({ ...blank, [GLOBAL_ID_KEY]: other });
    const saved = at(slot2, "3");
    const added = at(slot2);
    expect(planRecipeIntake([carrying], [], slots)).toEqual([{ kind: "map", itemId: other, reported: carrying }]);
    expect(planRecipeIntake([saved], [], slots)).toEqual([{ kind: "edit", itemId: other, reported: saved }]);
    expect(planRecipeIntake([added], [], slots)).toEqual([{ kind: "add", reported: added }]);
    // Gone from the list, a record a report listed before is the tablet's removal; one never listed was a write lost.
    expect(planRecipeIntake([], [known], slots)).toEqual([{ kind: "delete", itemId: GLOBAL.recipe, localId: "1", updatedAt: new Date(READ) }]);
    expect(planRecipeIntake([], [{ ...known, listed: false }], slots)).toEqual([{ kind: "forget", itemId: GLOBAL.recipe, localId: "1" }]);
    // Listed but unreadable, it is no removal.
    expect(planRecipeIntake([], [known], slots, new Set(["1"]))).toEqual([]);
    // A tablet still holding the slot's Recipe in another slot, written first, does not take the slot's new record as its.
    const elsewhere: MappedRecipe = { ...known, itemId: other, localId: "2", record: slot2 };
    expect(planRecipeIntake([at(slot2), saved], [elsewhere], slots)).toEqual([]);
  });
});
