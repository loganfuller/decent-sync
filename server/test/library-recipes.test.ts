import { GLOBAL_ID_KEY, RECIPE_SLOT_FIELD, profileAtBrewTemperature } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { recipeIdInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  type Dye2Key,
  type Dye2RecipeEdit,
  SimulatedDye2,
  dye2Library,
  dye2List,
  dye2Migrated,
  dye2NeverUsed,
  dye2Recording,
  openDye2Dashboard,
  openDye2RecipeEditor,
  recordedDye2MainTablet,
  recordedDye2Tablet,
  saveInDye2,
  saveRecipeFromFavouriteEditor,
  selectRecipeInDye2,
} from "./support/simulated-dye2.js";
import { recipeStripCells, startStreamline } from "./support/simulated-streamline.js";
import type { DecaidApi, SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #140: the Recipes of a Location, which DYE2 keeps in its
// `recipes` list in Decaid's store (ADR-0005), reach every tablet at their
// Location. A recipe saved on one tablet, from DYE2's recipe editor or its
// Auto Favourites page, joins the Location's Recipes under its record id,
// opaque as DYE2 makes it, in its Recipe Slot (`stripSlot`) or none, and is
// written to the Location's other tablets under the same id with its
// `stripSlot`, naming its Bean, Grinder and Basket by each tablet's own ids,
// and to no other Location's; edits merge per field with Conflicts
// (ADR-0020); a recipe whose `stripSlot` a tablet moves moves its Recipe,
// the slot's previous holder leaving it, or takes it out of its slot, and a
// recipe gone from a tablet's list is taken out of its slot there, kept
// (ADR-0019). And for ticket #216, DYE2's editor saving only what it changed
// over a fresh read keeps another tablet's change (decentespresso/dye2#28),
// which replaced ticket #142's stale-save rule. Through the built plugin in
// simulated tablets, acting as DYE2 v0.1.26 and Streamline at cec5664 do
// with the steps recorded from them (fixtures/decaid/dye2-v0.1.26/), on two
// server instances sharing one database, with assertions through the REST
// API and what each simulated tablet's store holds. Serials are made up,
// from 42001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  name: string | null;
  location: LocationView | null;
  slot: number | null;
  archived: boolean;
  content: Record_;
}

/** The recording's tablet's ids for what its recipes name (fixtures/decaid/dye2-v0.1.26/library.json). */
const RECORDED = {
  brazil: "b006ac6c-e061-44e5-9afe-9e297785257c",
  ethiopia: "2dec7277-95eb-4c35-9c95-242ced05ef58",
  brazilBatch: "f4d73c51-7660-48ca-8deb-4c301443f2ce",
  ethiopiaBatch: "78bfdaaf-0fe9-49f3-9db4-b7d6c1f514d7",
  grinder: "5099f7fa-aa07-4989-b578-25893800e507",
  grinder83: "f3d11140-520f-4d6c-a4c9-d79c217dffc8",
  basket18: "8f9702df-a615-4942-84db-882137fedcce",
  basket20: "9567d681-444c-4492-95cd-29ecbc48870d",
} as const;

/** The record ids DYE2's editor gave the recipes it saved in the recording (recipes.json): `Fixture Slot Recipe`, on tab 5, and `Fixture Library Recipe`, on none. */
const SLOT_RECIPE = "059e25fd-eccf-475c-8927-93af83760e06";
const LIBRARY_RECIPE = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";

/** Decaid's bundled Profiles the recorded recipes use. */
const ADAPTIVE = "profile:98fa00c191551b435845";
const CLASSIC = "profile:39e939592679fb194706";

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Recipes reach every tablet at their Location", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /** The built plugin on a tablet of the Machine, connected to an instance, polling every 5 s (0.1 s here) unless `pollSeconds` says otherwise, with DYE2 running where given. */
  function load(machine: CreatedMachine, decaidApi: DecaidApi, instance: TestServer = server, pollSeconds = 5, dye2?: SimulatedDye2): SimulatedTablet {
    return syncingTablet(machine, instance, { api: decaidApi, pollSeconds, dye2 });
  }

  /**
   * A Location with two Machines, the first's tablet the recording's, on one instance, the second's empty, on the other,
   * DYE2 running there where given.
   */
  async function lab(scenario: string, serials: number, first: DecaidApi = recordedDye2Tablet(String(serials), scenario), dye2?: SimulatedDye2) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = [await api.createMachine(`${scenario} lab 1`, here.id), await api.createMachine(`${scenario} lab 2`, here.id)] as const;
    const one = load(machines[0], first);
    const two = load(machines[1], { ...dye2NeverUsed(String(serials + 1)), ...(dye2 ? dye2Migrated() : {}) }, other, 5, dye2);
    await api.waitForOnline(...machines);
    return { here, machines, one, two };
  }

  const recipesAt = async (location: LocationView) =>
    (await api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`)).recipes;
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) =>
    (await api.get<{ versions: { fields: Record_; location: LocationView | null; source: { machine: { name: string } | null } }[] }>(`/recipes/${id}/history`)).versions;
  /** The Recipe the Machine has loaded, by its id, or null for none. */
  const loadedOn = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** The tablet's records in DYE2's list, as its store holds them; none for a key never written. */
  const records = (tablet: SimulatedTablet, key: Dye2Key = "recipes"): Record_[] => {
    const value = dye2List(tablet, key);
    return Array.isArray(value) ? (value as Record_[]) : [];
  };
  /** The tablet's recipe record with that id. */
  const byId = (tablet: SimulatedTablet, id: string) => records(tablet).find((record) => record.id === id);
  /** The tablet's recipe record carrying the Recipe's global id. */
  const recordOf = (tablet: SimulatedTablet, recipeId: string) => records(tablet).find((record) => record[GLOBAL_ID_KEY] === recipeId);
  const variables = (record: Record_ | undefined) => (record?.dashboardVariables ?? {}) as Record_;
  /** The tablet's id for its record of a Library item, by the global id the record carries. */
  const localId = async (tablet: SimulatedTablet, route: string, globalId: string): Promise<string | undefined> => {
    if (route.startsWith("/store/")) return (records(tablet, route.split("/").at(-1) as Dye2Key).find((record) => record[GLOBAL_ID_KEY] === globalId)?.id ?? undefined) as string | undefined;
    const list = asList((await tablet.callApi("GET", `${route}?includeArchived=true`)).body);
    return list.find((record) => (record.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] === globalId)?.id as string | undefined;
  };
  /** Saves a change of the tablet's recipe with that record id as DYE2's recipe editor saves one: what the form changed, over the recipe read afresh (dye2#28). */
  const editInDye2 = async (tablet: SimulatedTablet, id: string, edit: Dye2RecipeEdit) => (await openDye2RecipeEditor(tablet, { id })).set(edit).save();

  const recipes = dye2Recording<Record<string, Dye2Exchange[]>>("recipes");

  it("writes recipes DYE2's editor saved, in slot 5 and in no slot, to the Location's other tablets under the same ids and stripSlot and their own ids for what they name, and to no other Location's", async () => {
    const { here, one, two } = await lab("Saved", 42001);
    const cafe = await api.createLocation("Saved cafe", "America/Chicago");
    const cafeMachine = await api.createMachine("Saved cafe 1", cafe.id);
    const cafeTablet = load(cafeMachine, dye2NeverUsed("42003"));
    await api.waitForOnline(cafeMachine);

    // As recorded: a new recipe saved on the strip's empty tab 5, then one saved on no tab, each under a UUID DYE2 made.
    await saveInDye2(one, recipes.newInEmptySlot!);
    await saveInDye2(one, recipes.newInNoSlot!);
    await expect
      .poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot]))
      .toEqual([
        ["Fixture Slot Recipe", 5],
        ["Fixture Library Recipe", null],
      ]);
    const [slotted, saved] = await recipesAt(here);
    // In the Library's terms: its Bean, and that Bean's batch at the Location; its Profile, read from the Workflow and named
    // by DYE2 by its whole profile alone; its Grinder and Basket; its brew temperature, dial, steam by flow, flush and hot
    // water by volume.
    const bean = await localGlobal(here, "beans", "Saved Fixture Brazil");
    expect(saved!.content).toEqual(
      expect.objectContaining({
        name: "Fixture Library Recipe",
        beverage: "",
        beanId: bean,
        profileId: CLASSIC,
        dose: 19,
        yield: 38,
        brewTemperature: 93,
        grindSetting: 3,
        rpm: 1100,
        showOnDashboard: true,
        steamMode: "flow",
        hotWaterMode: "vol",
        steamFlow: 1.2,
        hotWaterVolume: 150,
        flushDuration: 4,
      }),
    );
    for (const field of ["beanBatchId", "grinderId", "basketId"]) expect(saved!.content[field]).toEqual(expect.any(String));
    expect(saved!.content).not.toHaveProperty("barista");
    expect(slotted!.content).toMatchObject({ name: "Fixture Slot Recipe", profileId: ADAPTIVE, dose: 18, brewTemperature: 92, steamDuration: 30, hotWaterTemperature: 85 });
    expect(await recipesAt(cafe)).toEqual([]);

    // The other tablet at the Location holds each under the record id DYE2 gave it, in its slot or none, naming what it uses
    // by its own ids, with what DYE2 derives.
    const ids = {
      bean: () => localId(two, "/beans", bean),
      batch: () => localId(two, "/bean-batches", saved!.content.beanBatchId as string),
      grinder: () => localId(two, "/grinders", saved!.content.grinderId as string),
      basket: () => localId(two, "/store/dye2.reaplugin/baskets", saved!.content.basketId as string),
    };
    // Once the tablet holds a record of each, written there first.
    await expect.poll(async () => (await Promise.all(Object.values(ids).map((id) => id()))).every((id) => id !== undefined)).toBe(true);
    await expect.poll(() => byId(two, LIBRARY_RECIPE)).toMatchObject({
      id: LIBRARY_RECIPE,
      [RECIPE_SLOT_FIELD]: null,
      name: "Fixture Library Recipe",
      [GLOBAL_ID_KEY]: saved!.id,
      title: "Fixture Library Recipe",
      subtitle: "Saved Fixture Brazil",
      beanId: await ids.bean(),
      beanName: "Saved Fixture Brazil",
      // Its batch beside its Bean, as DYE2 holds one (decentespresso/dye2#27).
      beanBatchId: await ids.batch(),
      profileId: CLASSIC,
      profileTitle: "Classic Italian espresso",
      barista: "",
      drinker: "",
      dashboardVariables: {
        dose: 19,
        drink: 38,
        brewC: 93,
        grind: 3,
        rpm: 1100,
        grinderId: await ids.grinder(),
        grinderModel: "Fixture Grinder 64",
        basketId: await ids.basket(),
        basketName: "Fixture 20g High-flow",
        hotWaterMode: "vol",
        steamFlowMls: 1.2,
        hotWaterMl: 150,
        flushS: 4,
      },
    });
    expect(Object.keys(byId(two, LIBRARY_RECIPE)!)).not.toContain("decentSyncRecipe");
    await expect.poll(() => byId(two, SLOT_RECIPE)).toMatchObject({ id: SLOT_RECIPE, [RECIPE_SLOT_FIELD]: 5, [GLOBAL_ID_KEY]: slotted!.id, name: "Fixture Slot Recipe" });
    const written = byId(two, LIBRARY_RECIPE)!;
    for (const id of [written.beanId, variables(written).grinderId, variables(written).basketId]) expect(Object.values(RECORDED)).not.toContain(id);
    // Its embedded Workflow is DYE2's, built from the record written there: the tablet's grinder and basket, and the full Profile.
    expect(written.workflow).toMatchObject({
      context: {
        targetDoseWeight: 19,
        targetYield: 38,
        grinderSetting: "3",
        grinderId: await ids.grinder(),
        grinderModel: "Fixture Grinder 64",
        coffeeName: "Saved Fixture Brazil",
        beanBatchId: await ids.batch(),
        extras: { rpm: 1100, basketId: await ids.basket(), basketName: "Fixture 20g High-flow" },
      },
      profile: { title: "Classic Italian espresso" },
    });
    expect((written.profileSnapshot as Record_).steps).toEqual(expect.any(Array));
    // Streamline's DYE strip there places the slot recipe on its fifth button, and the other on none.
    expect(recipeStripCells(dye2List(two, "recipes")).map(({ recipe: held }) => held?.id ?? null)).toEqual([null, null, null, null, SLOT_RECIPE]);

    // The tablet that saved them carries their global ids in a field of their own, under the ids it gave them, and nothing
    // reaches the cafe's.
    await expect.poll(() => [byId(one, SLOT_RECIPE)?.[GLOBAL_ID_KEY], byId(one, LIBRARY_RECIPE)?.[GLOBAL_ID_KEY]]).toEqual([slotted!.id, saved!.id]);
    expect(records(one).map((record) => [record.id, record[RECIPE_SLOT_FIELD]])).toEqual([
      [SLOT_RECIPE, 5],
      [LIBRARY_RECIPE, null],
    ]);
    expect(dye2List(cafeTablet, "recipes")).toBeNull();
    expect(cafeTablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "recipes")).toEqual([]);
  });

  it("writes a recipe saved from DYE2's Auto Favourites page, in no slot, to the Location's other tablets under the same id", async () => {
    const { here, one, two } = await lab("Favourite", 42121);
    // The Workflow the page reads: Decaid's default dial, with the tablet's Grinder at 3 and 1100 RPM.
    const dialled = { context: { grinderId: RECORDED.grinder, grinderModel: "Fixture Grinder 64", grinderSetting: "3", extras: { rpm: 1100 } } };
    expect((await one.callApi("PUT", "/workflow", dialled)).status).toBe(200);
    const saved = await saveRecipeFromFavouriteEditor(one, "Fixture Favourite Recipe");
    expect(saved).toMatchObject({ [RECIPE_SLOT_FIELD]: null });
    await expect.poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot])).toEqual([["Fixture Favourite Recipe", null]]);
    const [joined] = await recipesAt(here);
    // What the page read from the Workflow, its Grinder in the Library's terms; its profile by title alone names none.
    expect(joined!.content).toMatchObject({ name: "Fixture Favourite Recipe", dose: 18, yield: 36, grindSetting: 3, rpm: 1100, grinderId: expect.any(String) });
    expect(joined!.content).not.toHaveProperty("profileId");
    await expect.poll(() => byId(two, String(saved.id))).toMatchObject({ id: saved.id, [RECIPE_SLOT_FIELD]: null, [GLOBAL_ID_KEY]: joined!.id, name: "Fixture Favourite Recipe" });
    await expect.poll(() => byId(one, String(saved.id))?.[GLOBAL_ID_KEY]).toBe(joined!.id);
    expect(records(two)).toHaveLength(1);
  });

  it("keeps edits of different fields on two tablets, keeps two edits of one field made without seeing each other as a Conflict, and never shares a barista", async () => {
    const { here, machines, one, two } = await lab("Edited", 42011);
    // DYE2's editor saves a new recipe on tab 1 with a barista and drinker.
    const { saved: created } = await (await openDye2RecipeEditor(one, { slot: 1 }))
      .set({ name: "Edited Espresso", barista: "Edited Barista", drinker: "Edited Drinker", dose: 18, drink: 36, grind: 2.5, grinderId: RECORDED.grinder })
      .save();
    const id = String(created.id);
    await expect.poll(() => byId(two, id)?.name).toBe("Edited Espresso");
    const [saved] = await recipesAt(here);
    expect(saved).toMatchObject({ slot: 1, content: { name: "Edited Espresso", dose: 18, yield: 36, grindSetting: 2.5 } });
    // The barista and drinker saved with it are written back blank, and reach no other tablet nor the Recipe.
    await expect.poll(() => [byId(one, id)?.barista, byId(one, id)?.drinker]).toEqual(["", ""]);
    expect([byId(two, id)!.barista, byId(two, id)!.drinker]).toEqual(["", ""]);
    expect((byId(two, id)!.workflow as { context: Record_ }).context).not.toHaveProperty("baristaName");
    expect(saved!.content).not.toHaveProperty("barista");
    expect(saved!.content).not.toHaveProperty("drinker");

    // Each tablet changes another field: both survive, everywhere.
    await editInDye2(one, id, { dose: 18.2 });
    await editInDye2(two, id, { grind: 2.6 });
    for (const tablet of [one, two]) await expect.poll(() => [variables(byId(tablet, id)).dose, variables(byId(tablet, id)).grind]).toEqual([18.2, 2.6]);
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.2, grindSetting: 2.6 });

    // Offline, the second tablet misses the first's dose of 18.4, then sets 18.6. Neither saw the other's.
    two.loseNetwork();
    await api.waitForMachine(machines[1].machine.name, (viewed) => !viewed.online, 15_000);
    await editInDye2(one, id, { dose: 18.4 });
    await expect.poll(async () => (await recipe(saved!.id)).content.dose).toBe(18.4);
    await editInDye2(two, id, { dose: 18.6 });
    // Back online, its edit, made and read after the other's, wins, and the other's value is kept as a Conflict.
    two.restoreNetwork();
    for (const tablet of [one, two]) await expect.poll(() => variables(byId(tablet, id)).dose).toBe(18.6);
    const conflicts = (await api.get<{ conflicts: { field: string; value: unknown; item: Record_ }[] }>(`/recipes/${saved!.id}/conflicts`)).conflicts;
    expect(conflicts).toEqual([expect.objectContaining({ field: "dose", value: 18.4, item: { kind: "recipe", id: saved!.id, name: "Edited Espresso" } })]);
    // Its history holds each accepted edit, the first its joining the Library from the tablet that saved it.
    const history = await versions(saved!.id);
    expect(history.at(-1)).toMatchObject({ fields: { name: "Edited Espresso", dose: 18 }, source: { machine: { name: "Edited lab 1" } } });
  });

  it("keeps another tablet's change of a recipe saved from a DYE2 recipe editor opened before it, which saves only what it changed over the recipe read afresh", async () => {
    const { here, one, two } = await lab("Fresh", 42081);
    await saveInDye2(one, recipes.newInEmptySlot!);
    await expect.poll(() => byId(two, SLOT_RECIPE)?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    await expect.poll(() => byId(one, SLOT_RECIPE)?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    expect(saved!.content).toMatchObject({ dose: 18, grindSetting: 2.5, hotWaterTemperature: 85 });

    // The first tablet's editor opens on it; the second then changes its grind setting from 2.5 to 2.6, which the first is
    // written.
    const page = await openDye2RecipeEditor(one, { id: SLOT_RECIPE });
    await editInDye2(two, SLOT_RECIPE, { grind: 2.6 });
    await expect.poll(() => variables(byId(one, SLOT_RECIPE)).grind).toBe(2.6);

    // The page, loaded before that and still showing 2.5, saves its barista's dose of 18.5: only the dose, over the record
    // read afresh (decentespresso/dye2#28), so the second tablet's grind setting stands, and the dose reaches every tablet.
    const { patch } = await page.set({ dose: 18.5 }).save();
    expect(patch).toEqual({ dashboardVariables: { dose: 18.5 } });
    await expect.poll(async () => (await recipe(saved!.id)).content.dose).toBe(18.5);
    for (const tablet of [one, two]) await expect.poll(() => [variables(byId(tablet, SLOT_RECIPE)).dose, variables(byId(tablet, SLOT_RECIPE)).grind]).toEqual([18.5, 2.6]);
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.5, grindSetting: 2.6, hotWaterTemperature: 85 });
    expect((await api.get<{ conflicts: unknown[] }>(`/recipes/${saved!.id}/conflicts`)).conflicts).toEqual([]);
  });

  it("moves a Recipe to the slot DYE2's editor saves it in, the slot's previous holder leaving it, and out of its slot when its own tab is tapped off, changing only stripSlot on the other tablets and keeping it loaded there", async () => {
    const dye2 = new SimulatedDye2();
    const { here, machines, one, two } = await lab("Moved", 42091, undefined, dye2);
    await saveInDye2(one, recipes.newInEmptySlot!);
    await saveInDye2(one, recipes.newInNoSlot!);
    await expect
      .poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot]))
      .toEqual([
        ["Fixture Slot Recipe", 5],
        ["Fixture Library Recipe", null],
      ]);
    const [holder, moving] = (await recipesAt(here)) as [RecipeView, RecipeView];
    for (const tablet of [one, two]) await expect.poll(() => [recordOf(tablet, holder.id)?.id, recordOf(tablet, moving.id)?.id]).toEqual([SLOT_RECIPE, LIBRARY_RECIPE]);

    // On the second tablet, DYE2's Select Recipe page loads the recipe in no slot.
    two.connectMachine();
    await selectRecipeInDye2(two, LIBRARY_RECIPE);
    await expect.poll(() => loadedOn(machines[1])).toBe(moving.id);
    await dye2.settled();
    const before = structuredClone(records(two));

    // The first tablet's editor gives it tab 5, which the slot recipe holds: SAVE, then SAVE again on "REPLACE … ON 5?", and
    // `takeSlot` takes the slot from its holder in the same post.
    const { saved } = await (await openDye2RecipeEditor(one, { id: LIBRARY_RECIPE })).tapSlot(5).save();
    expect(saved[RECIPE_SLOT_FIELD]).toBe(5);
    expect(byId(one, SLOT_RECIPE)![RECIPE_SLOT_FIELD]).toBeNull();
    await expect
      .poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot]))
      .toEqual([
        ["Fixture Library Recipe", 5],
        ["Fixture Slot Recipe", null],
      ]);
    // Each move a version of its own, made on the first tablet at the lab.
    expect((await versions(moving.id))[0]).toMatchObject({ fields: { slot: 5 }, location: { id: here.id }, source: { machine: { name: "Moved lab 1" } } });
    expect((await versions(holder.id))[0]).toMatchObject({ fields: { slot: null }, location: { id: here.id } });

    // The second tablet's records change only their stripSlot, under the same ids, and Streamline's strip there shows the
    // moved recipe on the fifth button; it stays loaded, its Workflow naming it still.
    await expect.poll(() => [byId(two, LIBRARY_RECIPE)?.[RECIPE_SLOT_FIELD], byId(two, SLOT_RECIPE)?.[RECIPE_SLOT_FIELD]]).toEqual([5, null]);
    const withoutSlot = ({ [RECIPE_SLOT_FIELD]: _, ...rest }: Record_) => rest;
    expect(records(two).map(withoutSlot)).toEqual(before.map(withoutSlot));
    expect(recipeStripCells(dye2List(two, "recipes"))[4]!.recipe?.id).toBe(LIBRARY_RECIPE);
    expect(recipeIdInWorkflow(two)).toBe(LIBRARY_RECIPE);
    expect(await loadedOn(machines[1])).toBe(moving.id);

    // Its own tab tapped off in the editor, it leaves its slot and is kept at the lab, on every tablet in no slot (ADR-0019),
    // still loaded.
    await (await openDye2RecipeEditor(one, { id: LIBRARY_RECIPE })).tapSlot(5).save();
    await expect.poll(async () => (await recipe(moving.id)).slot).toBeNull();
    expect(await recipe(moving.id)).toMatchObject({ archived: false, location: { id: here.id } });
    expect((await versions(moving.id))[0]).toMatchObject({ fields: { slot: null }, source: { machine: { name: "Moved lab 1" } } });
    await expect.poll(() => byId(two, LIBRARY_RECIPE)?.[RECIPE_SLOT_FIELD]).toBeNull();
    expect(records(two).map(withoutSlot)).toEqual(before.map(withoutSlot));
    expect(recipeIdInWorkflow(two)).toBe(LIBRARY_RECIPE);
    expect(await loadedOn(machines[1])).toBe(moving.id);
  });

  it("gives a Recipe whose Bean is picked in DYE2 that Bean's batch most recently added at the Location, and takes a batch picked with it", async () => {
    // The tablet's batches created well before the test runs, whatever day the recording was made.
    const tablet = recordedDye2Tablet("42041", "Picked");
    const brought = { ...tablet, "/bean-batches": (tablet["/bean-batches"] as Record_[]).map((batch) => ({ ...batch, createdAt: "2026-10-01T09:00:00.000000", updatedAt: "2026-10-01T09:00:00.000000" })) };
    const { here, one, two } = await lab("Picked", 42041, brought);
    await saveInDye2(one, recipes.newInEmptySlot!);
    await expect.poll(async () => (await recipesAt(here))[0]?.content.beanBatchId).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    const brazil = await localGlobal(here, "beans", "Picked Fixture Brazil");
    // A later roast of the Brazil is added at the lab, after the one the tablet brought.
    const created = await api.call("POST", "/bean-batches", { beanId: brazil, content: { roastDate: "2026-10-10" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const latest = ((await created.json()) as { batch: { id: string } }).batch.id;

    // DYE2's editor picks the Brazil for the recipe, by the tablet's id for it, with no batch.
    await editInDye2(one, SLOT_RECIPE, { bean: { id: RECORDED.brazil, name: "Picked Fixture Brazil" } });
    await expect.poll(async () => (await recipe(saved!.id)).content.beanId).toBe(brazil);
    expect((await recipe(saved!.id)).content.beanBatchId).toBe(latest);
    // Each tablet holds that batch beside the Bean, as DYE2 does, by its id for it, once it holds the batch.
    for (const held of [one, two]) {
      await expect.poll(() => localId(held, "/bean-batches", latest)).toEqual(expect.any(String));
      await expect.poll(() => byId(held, SLOT_RECIPE)?.beanBatchId).toBe(await localId(held, "/bean-batches", latest));
      await expect.poll(() => byId(held, SLOT_RECIPE)?.beanId).toBe(await localId(held, "/beans", brazil));
    }

    // DYE2's editor picks the Brazil's earlier batch, which the tablet brought (decentespresso/dye2#27): it is the Recipe's.
    const earlier = ((await one.callApi("GET", `/bean-batches/${RECORDED.brazilBatch}`)).body as { extras: Record_ }).extras[GLOBAL_ID_KEY] as string;
    expect(earlier).not.toBe(latest);
    await editInDye2(one, SLOT_RECIPE, { bean: { id: RECORDED.brazil, name: "Picked Fixture Brazil", batchId: RECORDED.brazilBatch } });
    await expect.poll(async () => (await recipe(saved!.id)).content.beanBatchId).toBe(earlier);
    expect((await recipe(saved!.id)).content.beanId).toBe(brazil);
    await expect.poll(() => byId(two, SLOT_RECIPE)?.beanBatchId).toBe(await localId(two, "/bean-batches", earlier));
  });

  it("takes a field DYE2's editor saves as 0 as 0, not as blank (decentespresso/dye2#29)", async () => {
    const { here, one, two } = await lab("Zero", 42111);
    await saveInDye2(one, recipes.newInEmptySlot!);
    await expect.poll(() => byId(two, SLOT_RECIPE)?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    await editInDye2(one, SLOT_RECIPE, { rpm: 0, grind: 0 });
    await expect.poll(async () => (await recipe(saved!.id)).content).toMatchObject({ rpm: 0, grindSetting: 0 });
    await expect.poll(() => variables(byId(two, SLOT_RECIPE))).toMatchObject({ rpm: 0, grind: 0 });
  });

  it("writes a recipe's full Profile where the Profile is hidden, which applying it the DYE2 way and the Streamline way loads", async () => {
    const { here, one, two } = await lab("Hidden", 42051);
    await saveInDye2(one, recipes.newInEmptySlot!);
    await expect.poll(() => byId(two, SLOT_RECIPE)?.profileId).toBe(ADAPTIVE);
    // The lab hides the Recipe's Profile: the second tablet, which never had it, holds none.
    expect((await api.call("PUT", `/profiles/${encodeURIComponent(ADAPTIVE)}/locations/${here.id}`, { shown: false })).status).toBe(200);
    expect(asList((await two.callApi("GET", "/profiles?includeHidden=true")).body).map((profile) => profile.id)).not.toContain(ADAPTIVE);
    const stored = (await api.get<{ profile: { content: { profile: Record_ } } }>(`/profiles/${encodeURIComponent(ADAPTIVE)}`)).profile.content.profile;
    // As the Library holds it, and in the embedded Workflow Streamline applies at the recipe's brew temperature, 92 °C, its
    // steps moved by the same amount, as DYE2's dashboard applies it (ADR-0022, decentespresso/dye2#26).
    const library = profileAtBrewTemperature(stored, 92)!;
    expect(byId(two, SLOT_RECIPE)!.profileSnapshot).toEqual(stored);
    expect((byId(two, SLOT_RECIPE)!.workflow as Record_).profile).toEqual(library);

    // Another Profile loaded, applying the recipe DYE2's way loads its own.
    const classic = (dye2Library()["/profiles"] as Record_[]).find((profile) => profile.id === CLASSIC)!.profile;
    expect((await two.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect((await (await openDye2Dashboard(two)).applyRecipe(SLOT_RECIPE)).workflow?.status).toBe(200);
    const loaded = async () => ((await two.callApi("GET", "/workflow")).body as { profile: Record_ }).profile;
    expect(await loaded()).toMatchObject({ title: "Adaptive v3", steps: library.steps });
    // And so does applying it from Streamline's strip, on its fifth button.
    expect((await two.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect((await loaded()).title).toBe("Classic Italian espresso");
    expect((await (await startStreamline(two)).applyRecipe(5)).workflow?.status).toBe(200);
    // Streamline sends a step limiter of 0 as none (`updateWorkflow` in streamline-js:src/modules/api.js).
    const sanitised = (library.steps as Record_[]).map((step) => ((step.limiter as Record_ | null)?.value === 0 ? { ...step, limiter: null } : step));
    expect(await loaded()).toMatchObject({ title: "Adaptive v3", steps: sanitised });
  });

  it("takes a Recipe gone from a tablet's list out of its slot at the Location, keeping it, still on every tablet there in no slot", async () => {
    const { here, machines, one, two } = await lab("Removed", 42061);
    await saveInDye2(one, recipes.newInEmptySlot!);
    await expect.poll(() => byId(two, SLOT_RECIPE)?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    // Removed on the second tablet once a report has listed it there, as another app might: DYE2 cannot remove one.
    await expect.poll(() => reportedIds(machines[1])).toContain(SLOT_RECIPE);
    const list = records(two).filter((record) => record.id !== SLOT_RECIPE);
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);

    await expect.poll(async () => (await recipe(saved!.id)).slot).toBeNull();
    expect(await recipesAt(here)).toEqual([expect.objectContaining({ id: saved!.id, slot: null, archived: false })]);
    const versions_ = await versions(saved!.id);
    expect(versions_[0]).toMatchObject({ fields: { slot: null }, location: { name: "Removed lab" } });
    // Not Archived, it is on every tablet at the lab, under its record id, in no slot.
    for (const tablet of [one, two]) await expect.poll(() => byId(tablet, SLOT_RECIPE)).toMatchObject({ [GLOBAL_ID_KEY]: saved!.id, [RECIPE_SLOT_FIELD]: null });
  });

  it("takes in a joining tablet's recipes whatever their ids, in their slots, and writes them under the same ids to the Location's other tablet, but nothing to a list in a shape it does not recognise", async () => {
    const here = await api.createLocation("Opaque lab", "America/Chicago");
    const machines = [await api.createMachine("Opaque lab 1", here.id), await api.createMachine("Opaque lab 2", here.id)] as const;
    const one = load(machines[0], dye2NeverUsed("42071"));
    await api.waitForOnline(machines[0]);
    // The recording's tablet's library of eight recipes, with DYE2's slot numbers, UUIDs and its own order, joins a Location
    // that has no Recipes yet, so brings them (ADR-0018).
    const main = recordedDye2MainTablet("42072", "Opaque");
    const brought = main[`/store/${DYE2_NAMESPACE}/recipes`] as Record_[];
    const two = load(machines[1], main, other);
    await api.waitForOnline(machines[1]);
    const expected = brought.map((record) => [String(record.name), (record[RECIPE_SLOT_FIELD] as number | null | undefined) ?? null]);
    await expect.poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot]).sort()).toEqual([...expected].sort());
    const joined = await recipesAt(here);
    const status = async (machine: CreatedMachine) =>
      (await api.get<{ status: { unrecognisedLists: { list: string }[] } }>(`/machines/${machine.machine.id}/sharing-status`)).status;
    expect((await status(machines[1])).unrecognisedLists).toEqual([]);

    // Each Recipe's record on the tablet that brought it carries its global id, in the order that tablet keeps; the other
    // tablet is written each under the same record id and stripSlot.
    const globalOf = (name: unknown) => joined.find((listed) => listed.name === name)!.id;
    await expect.poll(() => records(two).map((record) => [record.id, record[GLOBAL_ID_KEY] ?? null])).toEqual(brought.map((record) => [record.id, globalOf(record.name)]));
    await expect
      .poll(() => records(one).map((record) => [record.id, record[RECIPE_SLOT_FIELD] ?? null, record[GLOBAL_ID_KEY]]).sort())
      .toEqual(brought.map((record) => [record.id, record[RECIPE_SLOT_FIELD] ?? null, globalOf(record.name)]).sort());

    // A tablet elsewhere whose list holds two records of one id is shown as such in its sharing status, its recipes left as
    // they are, while its other lists keep syncing.
    const elsewhere = await api.createLocation("Opaque cafe", "America/Chicago");
    const cafeMachine = await api.createMachine("Opaque cafe 1", elsewhere.id);
    const twice = [brought[0]!, { ...brought[1]!, id: brought[0]!.id }];
    const cafe = load(cafeMachine, { ...recordedDye2Tablet("42073", "Opaque cafe"), [`/store/${DYE2_NAMESPACE}/recipes`]: twice });
    await api.waitForOnline(cafeMachine);
    await expect.poll(async () => (await status(cafeMachine)).unrecognisedLists.map(({ list }) => list)).toEqual(["dye2Recipes"]);
    await expect.poll(() => records(cafe, "baskets").map((basket) => typeof basket[GLOBAL_ID_KEY])).toEqual(["string", "string"]);
    expect(dye2List(cafe, "recipes")).toEqual(twice);
    expect(cafe.storeWrites.filter((write) => write.key === "recipes")).toEqual([]);
    expect(await recipesAt(elsewhere)).toEqual([]);
  });

  it("lets Staff read a Location's Recipes, and answers 404 for no such Recipe or Location", async () => {
    const here = await api.createLocation("Read lab", "America/Chicago");
    const { link } = await api.invite("recipes-140@example.com", "staff", [here.id]);
    const staff = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Staff", password: "staff password 1" }));
    expect((await staff.call("GET", `/locations/${here.id}/recipes`)).status).toBe(200);
    expect((await api.call("GET", "/recipes/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await api.call("GET", "/recipes/not-a-recipe")).status).toBe(404);
    expect((await api.call("GET", "/recipes/00000000-0000-4000-8000-000000000000/history")).status).toBe(404);
    expect((await api.call("GET", "/locations/00000000-0000-4000-8000-000000000000/recipes")).status).toBe(404);
  });

  /** The ids of the records the tablet's latest report of its recipes listed, as the server stored it. */
  async function reportedIds(machine: CreatedMachine) {
    return ((await api.get<{ collection: { value: Record_[] } | null }>(`/machines/${machine.machine.id}/collections/dye2Recipes`)).collection?.value ?? []).map((record) => record.id);
  }

  /** The global id of the Library's item of that kind with that name (a Bean's by its name alone), offered at the Location. */
  async function localGlobal(location: LocationView, kind: "beans", name: string): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(async () => {
        const beans = (await api.get<{ beans: { id: string; name: string; offeredAt: LocationView[] }[] }>(`/${kind}`)).beans;
        id = beans.find((bean) => bean.name === name && bean.offeredAt.some((offered) => offered.id === location.id))?.id;
        return id;
      })
      .toEqual(expect.any(String));
    return id!;
  }
});

function asList(value: unknown): Record_[] {
  return Array.isArray(value) ? (value as Record_[]) : [];
}
