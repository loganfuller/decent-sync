import { GLOBAL_ID_KEY, RECIPE_FIELD, profileAtBrewTemperature } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { beforeWriteAfter, editedContent, heldBefore } from "../src/library/equipment-intake.js";
import {
  EDITED_PATHS,
  type IntakeContext,
  type MappedKind,
  type MappedRecipe,
  type WriteContext,
  editedPaths,
  heldBeforeReplaced,
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
// derives regenerated, its hot water value of its mode, and the steam and
// rinse settings it mirrors; and what a report of a tablet's recipes
// changes, by slot. Through the pure module's
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

  it("changes only the hot water value of the record's mode, and keeps a Recipe's Tools the tablet holds no record of", () => {
    // Saved by temperature, the record leaves its volume out, which stays as it is.
    const byTemperature = recipeView(slot1);
    expect(libraryValues(byTemperature, ["dashboardVariables.hotWaterMl", "dashboardVariables.hotWaterTempC", "dashboardVariables.hotWaterMode"], {}, intake())).toEqual({
      hotWaterMode: "temp",
      hotWaterTemperature: 88,
    });
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

  it("writes a Recipe to a tablet under its own ids, with its full Profile, a blank barista, its hot water volume and temperature, and what DYE2 derives, its embedded Workflow's Profile at its brew temperature", () => {
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
      [RECIPE_FIELD]: { hotWaterData: { targetTemperature: 88, duration: null, volume: null, flow: null } },
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
          extras: { rpm: 900, basketId: "other-basket", basketName: "Fixture 18g Precision", decentSyncRecipeId: GLOBAL.recipe },
          // Applying it clears a batch the Workflow held, as DYE2's dashboard does.
          coffeeName: "Fixture Ethiopia",
          coffeeRoaster: "Fixture Roasters",
          beanBatchId: null,
        },
        // Streamline's strip applies it as it is.
        profile: adaptiveAt92,
      },
    });
    // Its batch is named by the tablet's id where it holds it; a nameless one is called by its slot; hot water by volume
    // keeps the temperature too, as DYE2 holds both once each moves.
    const recorded = recipeRecord({ ...slot1Content, beanBatchId: GLOBAL.ethiopiaBatch, name: "", hotWaterMode: "vol", hotWaterVolume: 120 }, 4, writing(recordedIds), GLOBAL.recipe);
    expect(recorded.beanBatchId).toEqual(LOCAL.ethiopiaBatch);
    expect((recorded.workflow as { context: Record_ }).context.beanBatchId).toEqual(LOCAL.ethiopiaBatch);
    expect(recorded[RECIPE_FIELD]).toEqual({ hotWaterData: { targetTemperature: 88, duration: null, volume: 120, flow: null } });
    expect([recorded.title, recorded["dashboardVariables.hotWaterMl"], recorded["dashboardVariables.hotWaterTempC"]]).toEqual(["Recipe 4", 120, 88]);
  });

  it("builds a recipe's embedded Workflow as DYE2 2cf631c does, from its yield or its dose times its ratio, with a Profile's id and title where it has no steps", () => {
    const keptWorkflow = slot1.workflow as Record_;
    // DYE2's own, as it saved slot 1, holds the same dial, grinder, Basket, coffee, roaster, batch, people and Profile at
    // the recipe's brew temperature. It holds its field flags and machine settings too, which Streamline does not apply.
    const view = recipeView(slot1);
    const { context } = keptWorkflow as { context: Record_ };
    const { dye: _flags, ...extras } = context.extras as Record_;
    expect(recipeWorkflow({ ...view, profileSnapshot: adaptive }, GLOBAL.recipe)).toEqual({
      profile: keptWorkflow.profile,
      context: { ...context, extras: { ...extras, decentSyncRecipeId: GLOBAL.recipe } },
    });
    const ratio = recipeWorkflow({ ...view, "dashboardVariables.drink": null, "dashboardVariables.ratio": 2.2, profileSnapshot: null }, GLOBAL.recipe);
    expect(ratio).toMatchObject({ context: { targetDoseWeight: 18.5, targetYield: 40.7 }, profile: { id: ADAPTIVE, title: "Adaptive v3" } });
    expect(recipeWorkflow(recipeView(blank), GLOBAL.recipe)).not.toHaveProperty("profile");
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

  it("takes a recipe's field set back to what the tablet held just before the server's latest write to it as unchanged, as by an editor opened before it", () => {
    const record: Record_ = { ...slot1, id: "1", [GLOBAL_ID_KEY]: GLOBAL.recipe };
    const dial = (changes: Record_, fields: Record_ = {}) =>
      recipeView({ ...record, ...fields, dashboardVariables: { ...(record.dashboardVariables as Record_), ...changes } });
    // The server wrote another tablet's grind setting of 2.6 over the tablet's 2.7, which the tablet reported.
    const before = heldBefore(recipeView(record), ["dashboardVariables.grind"]);
    expect(before).toEqual({ "dashboardVariables.grind": 2.7 });
    const known = dial({ grind: 2.6 });
    const standing = beforeWriteAfter(before, known, known);
    // DYE2's editor, loaded before that write, saves a dose of 18.8 with every other field as it loaded them, its capture
    // time rewritten: only the dose is an edit.
    const saved = dial({ dose: 18.8 }, { capturedAt: "2026-10-12T21:00:00.000Z" });
    expect(editedPaths(editedContent(known, saved, standing))).toEqual(["dashboardVariables.dose"]);
    // A grind setting of another value is an edit as usual, and so is a field the server never wrote set back to an
    // earlier value of the tablet's.
    expect(editedPaths(editedContent(known, dial({ dose: 18.8, grind: 2.8 }), standing)).sort()).toEqual(["dashboardVariables.dose", "dashboardVariables.grind"]);
    expect(editedPaths(editedContent(dial({ grind: 2.6, rpm: 1000 }), dial({ rpm: 900 }), standing))).toEqual(["dashboardVariables.rpm"]);
  });

  it("takes a record created in a slot the server removed another from as holding before the write each field that one held otherwise", () => {
    const earlier = recipeView({ ...slot1, id: "1", [GLOBAL_ID_KEY]: GLOBAL.recipe });
    const created = { ...earlier, name: "Brand new", "dashboardVariables.grind": 3.3, "dashboardVariables.rpm": null };
    // A field both hold, as the dose, is left out; one only the earlier record held is kept with its value.
    expect(heldBeforeReplaced(earlier, created)).toEqual({ name: earlier.name, "dashboardVariables.grind": 2.7, "dashboardVariables.rpm": 900 });
    // A page opened on the earlier record saving its dose of 18.8 over the new one changes only the dose.
    const saved = { ...earlier, "dashboardVariables.dose": 18.8 };
    expect(editedPaths(editedContent(created, saved, heldBeforeReplaced(earlier, created)))).toEqual(["dashboardVariables.dose"]);
    expect(heldBeforeReplaced(earlier, earlier)).toBeNull();
  });

  it("neither writes nor takes in a recipe's steam and flush values, which are the tablet's own, but keeps its steam mode", () => {
    const steamAndFlush = ["dashboardVariables.steamTimeS", "dashboardVariables.steamFlowMls", "dashboardVariables.flushS"];
    // Written, a record holds none of them, so the plugin's write leaves those the tablet's record holds.
    const written = recipeRecord(slot1Content, 1, writing(recordedIds), GLOBAL.recipe);
    for (const path of steamAndFlush) expect(written).not.toHaveProperty(path);
    expect(written["dashboardVariables.steamMode"]).toBe("time");
    expect(recordOf(written).dashboardVariables).not.toHaveProperty("flushS");
    // Reported, they are no part of the record's view, and a change of one is no edit of the Recipe.
    const record = recordOf(written);
    const steamed = recipeView({ ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), steamTimeS: 25, steamFlowMls: 1.3, flushS: 3 } });
    for (const path of steamAndFlush) expect(steamed).not.toHaveProperty(path);
    expect(editedContent(written, steamed, null)).toEqual({});
    expect(holdsRecipe(steamed, written)).toBe(true);
    // Nor are they part of what DYE2 embeds, nor of a new Recipe's content.
    expect(recipeWorkflow(written, GLOBAL.recipe)).not.toHaveProperty("steamSettings");
    expect(recipeContent(recipeView(blank), intake())).not.toHaveProperty("flushS");
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
    // A save in a slot whose Recipe has left it since, as taken out of it or Archived, is still that Recipe's edit, whether
    // the slot is empty now or holds another Recipe, never an edit of that one; the writer then removes the record.
    // Unchanged, it is that Recipe's record still.
    const left = new Set([GLOBAL.recipe, other]);
    const unslotted = new Map([["3", other]]);
    expect(planRecipeIntake([edited], [known], unslotted, undefined, left)).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: edited }]);
    expect(planRecipeIntake([edited], [known], new Map([["1", other]]), undefined, left)).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: edited }]);
    expect(planRecipeIntake([at(slot1)], [known], unslotted, undefined, left)).toEqual([]);
    // A record with no global id over one the map knew to carry its id, as another app's new save there, is no edit of it.
    const idless = at({ ...slot1, name: "No id" });
    delete (idless.record as Record_)[GLOBAL_ID_KEY];
    const unmarked = { ...idless, globalId: null };
    const carried: MappedRecipe = { ...known, record: { ...slot1, [GLOBAL_ID_KEY]: GLOBAL.recipe } };
    expect(planRecipeIntake([unmarked], [carried], unslotted, undefined, left)).toEqual([{ kind: "add", reported: unmarked }]);
    const neverCarried: MappedRecipe = { ...known, record: Object.fromEntries(Object.entries(slot1).filter(([key]) => key !== GLOBAL_ID_KEY)) };
    expect(planRecipeIntake([unmarked], [neverCarried], unslotted, undefined, left)).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: unmarked }]);
    // A record carrying another item's global id there is no edit of it, and in a slot another Recipe holds now, that one's
    // as any record saved there.
    const restoredThere = at({ ...slot1, name: "Restored there", [GLOBAL_ID_KEY]: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect(planRecipeIntake([restoredThere], [known], new Map([["1", other]]), undefined, left)).toEqual([{ kind: "edit", itemId: other, reported: restoredThere }]);
    // Another Location's, as before a move, it stays that Recipe's record, but is no edit of it: it is written over. So is
    // one carrying another item's global id, as a backup restored.
    expect(planRecipeIntake([edited], [known], unslotted, undefined, new Set([other]))).toEqual([{ kind: "map", itemId: GLOBAL.recipe, reported: edited }]);
    const restored = at({ ...slot1, name: "Restored", [GLOBAL_ID_KEY]: other });
    expect(planRecipeIntake([restored], [known], slots)).toEqual([{ kind: "map", itemId: GLOBAL.recipe, reported: restored }]);
    // Moved to another slot since, as by a swap the tablet has not yet been written, its record saved in the slot it left
    // is still its edit, whether that slot holds another Recipe now or none; the writer then moves the record.
    const otherKnown: MappedRecipe = { ...known, itemId: other, localId: "3", record: { ...slot2, id: "3" } };
    const swapped = new Map([
      ["1", other],
      ["3", GLOBAL.recipe],
    ]);
    const unchangedOther = at({ ...slot2, id: "3" });
    expect(planRecipeIntake([edited, unchangedOther], [known, otherKnown], swapped)).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: edited }]);
    expect(planRecipeIntake([edited], [known], new Map([["4", GLOBAL.recipe]]))).toEqual([{ kind: "update", itemId: GLOBAL.recipe, reported: edited }]);
    // One carrying another item's global id is not its edit.
    expect(planRecipeIntake([restored], [known], new Map([["4", GLOBAL.recipe]]))).toEqual([{ kind: "add", reported: restored }]);
  });
});
