import { afterAll, describe, expect, it } from "vitest";
import { recipeIdInWorkflow } from "./support/loaded-tablets.js";
import {
  DYE2_NAMESPACE,
  SimulatedDye2,
  dye2List,
  dye2MainRecording,
  dye2Migrated,
  dye2ProfileFingerprint,
  dye2Selection,
  openDye2Dashboard,
  openDye2RecipeEditor,
  recordedDye2MainTablet,
  selectRecipeInDye2,
} from "./support/simulated-dye2.js";
import { recipeStripCells, startStreamline } from "./support/simulated-streamline.js";
import { SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated DYE2 v0.1.26 and Streamline `main` at cec5664 against what
// their source does (dye2:dye2-plugin/src/plugin.ts, utils/workflow-record.ts,
// utils/recent-favs.ts, utils/dev-api.ts and pages/; streamline-js:
// src/modules/dyeStrip.js, dye-selection.js, workflow-fields.js and api.js),
// on one simulated tablet holding the 2cf631c recording's library, as each
// step leaves it for the next. No settings are given, so the plugin does not
// connect.

type Record_ = Record<string, unknown>;

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

function load(dye2: SimulatedDye2, api = recordedDye2MainTablet("10001")): SimulatedTablet {
  // The recording's machine keeps no flush settings written to it.
  const tablet = SimulatedTablet.load({ settings: {}, api, dye2, keepsFlushSettings: false });
  tablets.push(tablet);
  return tablet;
}

const recipes = (tablet: SimulatedTablet) => dye2List(tablet, "recipes") as Record_[];
const recipe = (tablet: SimulatedTablet, id: string) => recipes(tablet).find((row) => row.id === id);
const slots = (tablet: SimulatedTablet) => Object.fromEntries(recipes(tablet).map((row) => [String(row.id), row.stripSlot]));
const library = dye2MainRecording<{ profiles: { id: string; profile: Record_ }[]; beanBatches: Record_[] }>("library");
const profile = (title: string) => library.profiles.find((record) => record.profile.title === title)!.profile;

describe("The simulated DYE2 v0.1.26, against its source", () => {
  runAsSteps();
  const dye2 = new SimulatedDye2();
  const tablet = load(dye2);
  const selection = async () => (await tablet.callApi("GET", `/plugins/${DYE2_NAMESPACE}/selection`)).body;
  const mirrored = () => tablet.storeValue(DYE2_NAMESPACE, "selection");

  it("migrates as it loads: slots from ids 1 to 5, the stored selection and its Workflow marker cleared, each flag set, pushing after each refresh", async () => {
    await dye2.settled();
    expect(slots(tablet)).toEqual({ "1": 1, "2": 2, "3": 3 });
    expect(mirrored()).toEqual({});
    for (const flag of ["selectionMigrated", "recipesMigrated", "favSlotsMigrated", "favProfilesMigrated"]) expect(tablet.storeValue(DYE2_NAMESPACE, flag)).toBe(true);
    expect((((tablet.workflow().context as Record_).extras as Record_).dye as Record_).selection).toBeNull();
    // On load, after the recipe migration and after the favourites' slot migration.
    expect(dye2.pushes).toHaveLength(3);
    expect(await selection()).toBeNull();
  });

  it("applies a recipe on its dashboard as a patch with its recipeId, taking a baseline and mirroring the selection", async () => {
    const page = await openDye2Dashboard(tablet);
    expect(page.recipePills().map((row) => row.id)).toEqual(["1", "2", "3"]);
    const pushes = dye2.pushes.length;
    const applied = await page.applyRecipe("1");
    expect(applied.workflow?.status).toBe(200);
    const sent = page.lastSent!;
    // `v` and its flags the Workflow holds already.
    expect(((sent.context as Record_).extras as Record_).dye).toEqual({ recipeId: "1" });
    expect((sent.profile as Record_).title).toBe("Adaptive v3");
    // Only what the page changed: none of the Workflow's own fields it holds as they were.
    expect(Object.keys(sent)).not.toContain("name");
    expect((sent.context as Record_).coffeeName).toBeUndefined();
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBe("1");
    expect(dye2.baseline()).toMatchObject({ id: "1", profileFingerprint: dye2ProfileFingerprint(tablet.workflow().profile), armedBrewC: 92 });
    expect(await selection()).toEqual({ kind: "recipe", id: "1", modified: false });
    expect(mirrored()).toEqual({ kind: "recipe", id: "1", modified: false });
    expect(dye2.pushes.length).toBe(pushes + 1);
  });

  it("marks the recipe modified on a dial tap, and records it into the recipe when asked, pushing", async () => {
    const page = await openDye2Dashboard(tablet);
    await page.tap("grind", 2.9);
    await dye2.settled();
    expect(await selection()).toEqual({ kind: "recipe", id: "1", modified: true });
    const pushes = dye2.pushes.length;
    expect(await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/record`)).toEqual({ status: 200, body: { saved: true, kind: "recipe", id: "1" } });
    expect(dye2.recorded.at(-1)).toEqual({ id: "1", patch: { grind: 2.9 } });
    expect((recipe(tablet, "1")!.dashboardVariables as Record_).grind).toBe(2.9);
    expect(((recipe(tablet, "1")!.workflow as Record_).context as Record_).grinderSetting).toBe("2.9");
    expect(mirrored()).toEqual({ kind: "recipe", id: "1", modified: false });
    // The record's push, and the mirror's.
    expect(dye2.pushes.length).toBe(pushes + 2);
    expect(await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/record`)).toEqual({ status: 200, body: { saved: false, kind: "recipe", id: "1" } });
  });

  it("never records steam turned off, and keeps the recipe on another batch", async () => {
    await tablet.changeSettings({ steamSettings: { targetTemperature: 0 } });
    await dye2.settled();
    expect(await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/record`)).toEqual({ status: 200, body: { saved: false, kind: "recipe", id: "1" } });
    const other = library.beanBatches.find((batch) => batch.id !== (tablet.workflow().context as Record_).beanBatchId)!;
    await tablet.callApi("PUT", "/workflow", { context: { beanBatchId: other.id } });
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBe("1");
  });

  it("keeps the recipe across a restart where its own profile is the Workflow's", async () => {
    await dye2.reload();
    expect(dye2.cleared).toEqual([]);
    expect(recipeIdInWorkflow(tablet)).toBe("1");
    expect(dye2.baseline()).toMatchObject({ id: "1" });
  });

  it("clears recipeId on a profile change, even one sent with the same id", async () => {
    await tablet.callApi("PUT", "/workflow", { profile: profile("Classic Italian espresso"), context: { extras: { dye: { recipeId: "1" } } } });
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    expect(dye2.cleared).toEqual([{ id: "1", cold: false }]);
    expect(await selection()).toBeNull();
    expect(mirrored()).toEqual({});
  });

  it("writes recipeId for a POST to its selection, and clears it on a restart where the recipe's own profile is another", async () => {
    expect(await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: "1" })).toEqual({ status: 200, body: { kind: "recipe", id: "1", modified: expect.any(Boolean) } });
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBe("1");
    await dye2.reload();
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    expect(dye2.cleared.at(-1)).toEqual({ id: "1", cold: true });
  });

  it("saves the Workflow as a recipe in a slot, its previous holder kept out of it, and puts its id in the Workflow", async () => {
    const answer = await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/save-recipe`, { slot: 2 });
    expect(answer.status).toBe(200);
    const { id, name } = answer.body as { id: string; name: string };
    expect(id).toMatch(/^recipe-[0-9a-z]+$/);
    // Steam is off, and the Workflow holds a hot water time (`proposeRecipeName`).
    expect(name).toBe("Classic Americano");
    expect(slots(tablet)).toEqual({ "1": 1, "2": null, "3": 3, [id]: 2 });
    expect(recipe(tablet, id)).toMatchObject({ name, title: name, stripSlot: 2, profileTitle: "Classic Italian espresso" });
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBe(id);
    expect(dye2.baseline()).toMatchObject({ id });
    const unslotted = await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/save-recipe`, { name: "Fixture Library Recipe" });
    expect(recipe(tablet, (unslotted.body as { id: string }).id)).toMatchObject({ name: "Fixture Library Recipe", stripSlot: null });
  });

  it("applies a recipe in no slot from Select Recipe, which the dashboard then shows first; a favourite applied clears recipeId", async () => {
    const page = await selectRecipeInDye2(tablet, "2");
    expect(page.applied?.workflow?.status).toBe(200);
    expect(((page.lastSent!.context as Record_).extras as Record_).dye).toMatchObject({ recipeId: "2" });
    await dye2.settled();
    expect(dye2Selection(tablet)).toEqual({ kind: "recipe", id: "2" });
    expect(page.recipePills()[0]!.id).toBe("2");
    await page.applyFavourite({ id: "favourite-1", snapshot: { dose: 17.5 } });
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBeNull();
  });

  it("creates a recipe in its editor under a UUID, in the slot it targets, and moves one to another slot, each taking it from its holder", async () => {
    const created = await (await openDye2RecipeEditor(tablet, { slot: 1 })).set({ name: "Fixture Editor Recipe", dose: 19 }).save();
    expect(created.saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(created.saved).toMatchObject({ stripSlot: 1, title: "Fixture Editor Recipe", dashboardVariables: { dose: 19 } });
    expect(recipe(tablet, "1")!.stripSlot).toBeNull();
    const moved = await (await openDye2RecipeEditor(tablet, { id: "3" })).tapSlot(1).save();
    expect(moved.patch).toMatchObject({ stripSlot: 1 });
    expect(recipe(tablet, "3")!.stripSlot).toBe(1);
    expect(recipe(tablet, String(created.saved.id))!.stripSlot).toBeNull();
    const out = await (await openDye2RecipeEditor(tablet, { id: "3" })).tapSlot(1).save();
    expect(out.saved.stripSlot).toBeNull();
  });

  it("saves only what its form changed over the recipe read afresh, steam Off as 0", async () => {
    const editor = await openDye2RecipeEditor(tablet, { id: "1" });
    // Written meanwhile, as a record would.
    await tablet.callApi(
      "POST",
      `/store/${DYE2_NAMESPACE}/recipes`,
      recipes(tablet).map((row) => (row.id === "1" ? { ...row, dashboardVariables: { ...(row.dashboardVariables as Record_), rpm: 950 } } : row)),
    );
    const { saved, patch } = await editor.set({ steamTempC: 0, dose: 18 }).save();
    expect(patch.dashboardVariables).toMatchObject({ steamTempC: 0, dose: 18 });
    expect(patch.dashboardVariables).not.toHaveProperty("rpm");
    expect(saved.dashboardVariables).toMatchObject({ steamTempC: 0, dose: 18, rpm: 950 });
    expect((saved.workflow as Record_).steamSettings).toMatchObject({ targetTemperature: 0 });
  });
});

describe("The simulated Streamline main at cec5664, against its source", () => {
  runAsSteps();
  const dye2 = new SimulatedDye2();
  const tablet = load(dye2, { ...recordedDye2MainTablet("10002"), ...dye2Migrated() });
  let streamline: Awaited<ReturnType<typeof startStreamline>>;

  it("places recipes by stripSlot once any row has the key, else by ids 1 to 5", () => {
    expect(recipeStripCells([{ id: "a", stripSlot: 2 }, { id: "b", stripSlot: null }, { id: "1" }]).map((cell) => cell.recipe?.id ?? null)).toEqual([null, "a", null, null, null]);
    expect(recipeStripCells([{ id: "2" }, { id: "x" }]).map((cell) => cell.recipe?.id ?? null)).toEqual(["x", "2", null, null, null]);
    expect(recipeStripCells([{ id: "a", stripSlot: 1, showOnStreamlineDashboard: false }]).map((cell) => cell.recipe?.id ?? null)).toEqual([null, null, null, null, null]);
  });

  it("applies a recipe from its strip as one patch with its recipeIdPatch, then posts DYE2's selection", async () => {
    await dye2.settled();
    streamline = await startStreamline(tablet);
    // Not migrated, so placed by id.
    expect(streamline.cells().map((cell) => cell.recipe?.id ?? null)).toEqual(["1", "2", "3", null, null]);
    const applied = await streamline.applyRecipe(2);
    expect([applied.workflow?.status, applied.selection?.status]).toEqual([200, 200]);
    const sent = streamline.sent.at(-1)!;
    expect(((sent.context as Record_).extras as Record_).dye).toEqual({ v: 1, recipeId: "2" });
    expect(dye2.asked.at(-1)).toBe("2");
    await streamline.settled();
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBe("2");
  });

  it("saves the dial-in into the selected recipe, and refuses to offer it on another cell", async () => {
    await streamline.setDose(19.5);
    await dye2.settled();
    expect(streamline.sent.at(-1)).toEqual({ context: { targetDoseWeight: 19.5, targetYield: 36 }, profile: { target_weight: 36 } });
    expect(await streamline.saveChanges("2")).toEqual({ status: 200, body: { saved: true, kind: "recipe", id: "2" } });
    expect((recipe(tablet, "2")!.dashboardVariables as Record_).dose).toBe(19.5);
    await expect(streamline.saveChanges("1")).rejects.toThrow("not the one selected");
  });

  it("clears only the note once a Shot is stored", async () => {
    await tablet.callApi("PUT", "/workflow", { context: { baristaName: "Fixture Barista", extras: { note: "Fixture note" } } });
    expect(await streamline.shotStored()).toEqual({ extras: { note: null } });
    const context = tablet.workflow().context as Record_;
    expect([context.baristaName, (context.extras as Record_).note, recipeIdInWorkflow(tablet)]).toEqual(["Fixture Barista", null, "2"]);
    expect(await streamline.shotStored()).toBeUndefined();
  });

  it("takes a steam time of 0 as no timer, and switches the heater on its own, back on at the selected recipe's steam temperature or the one kept", async () => {
    await streamline.set("last-steam-duration", 0);
    expect(tablet.workflow().steamSettings).toMatchObject({ duration: 0, targetTemperature: 150 });
    await streamline.setSteamHeater(false);
    expect(tablet.workflow().steamSettings).toMatchObject({ duration: 0, targetTemperature: 0 });
    expect(streamline.remembered("last-steam-temp")).toBe(150);
    await streamline.keep("last-steam-temp", 140);
    await streamline.setSteamHeater(true);
    expect(tablet.workflow().steamSettings).toMatchObject({ targetTemperature: 140 });
  });

  it("frees the selected cell with its Clear button, clearing DYE2's selection", async () => {
    await streamline.applyRecipe(2);
    await dye2.settled();
    expect(await streamline.clearButton(2)).toBe(true);
    expect(recipe(tablet, "2")!.showOnStreamlineDashboard).toBe(false);
    await dye2.settled();
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    expect(streamline.cells()[1]!.recipe).toBeNull();
  });

  it("refuses its own wake before the PUT, its writer not owning the profile, and taps a profile with recipeId null", async () => {
    const classic = library.profiles.find((record) => record.profile.title === "Classic Italian espresso")!;
    const sent = streamline.sent.length;
    expect(await streamline.wake(classic.id)).toBeUndefined();
    expect(streamline.refused.at(-1)).toContain("'profile.wake' sent undeclared field(s) profile.");
    expect(streamline.sent.length).toBe(sent);
    expect((await streamline.tapProfile(classic.id))?.status).toBe(200);
    expect(((streamline.sent.at(-1)!.context as Record_).extras as Record_).dye).toEqual({ v: 1, recipeId: null });
  });
  it("saves the Workflow as a recipe in a cell's slot; a recipe holding a field the strip's writer does not own is refused before the PUT", async () => {
    await tablet.callApi("PUT", "/workflow", { context: { extras: { note: "Fixture note" } } });
    const saved = await streamline.saveToRecipe(4);
    expect(saved.status).toBe(200);
    const { id } = saved.body as { id: string };
    expect(streamline.cells()[3]!.recipe?.id).toBe(id);
    const applied = await streamline.applyRecipe(4);
    expect(applied.refused).toContain("context.extras.note");
    expect(applied.workflow).toBeUndefined();
  });

});
