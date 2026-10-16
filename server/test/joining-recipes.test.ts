import { LOADED_RECIPE_KEY, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2Keys, dye2List, dye2NeverUsed, openDye2Dashboard, recordedDye2V020Tablet } from "./support/simulated-dye2.js";
import type { DecaidApi, SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #148: a Machine joining a Location takes on its Recipes,
// Baskets and Tools (ADR-0008, ADR-0018). Its tablet is written the
// Location's Recipes in their slots, and the slots the Location leaves empty
// are emptied; its records of another Location's Recipes leave its list,
// and its own recipes, baskets and tools are removed from DYE2's lists and
// not kept, unless the Location has none of that kind yet, which takes them
// in, its recipes in their slots. Its Workflow loses a Basket the Location
// does not show and its Loaded Recipe, cleared from DYE2's selection too,
// and keeps its hot water. Through the built plugin in simulated tablets
// running DYE2 v0.1.20 as recorded (fixtures/decaid/dye2-v0.1.20/), on two
// server instances sharing one database, with assertions through the REST
// API and what each simulated tablet holds. Serials are made up, from 49001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  name: string | null;
  slot: number | null;
  content: Record_;
}

interface EquipmentView {
  id: string;
  name: string | null;
  shownAt: { location: LocationView }[];
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's profile slot 2's recipe is made on, by its id. */
const CLASSIC = "profile:39e939592679fb194706";

/**
 * The v0.1.20 recording's tablet with this serial (recordedDye2V020Tablet),
 * its beans', baskets' and tools' names begun with `scenario`, as Beans,
 * Baskets and Tools are matched by name across a file's tests (ADR-0018),
 * with the recording's tool (fixtures/decaid/dye2-v0.1.19/) beside its
 * baskets.
 */
function recordedTablet(serial: string, scenario: string): DecaidApi {
  const api = recordedDye2V020Tablet(serial, scenario);
  const named = (records: unknown) => (records as Record_[]).map((record) => ({ ...record, name: `${scenario} ${String(record.name)}` }));
  return {
    ...api,
    [`/store/${DYE2_NAMESPACE}/baskets`]: named(api[`/store/${DYE2_NAMESPACE}/baskets`]),
    [`/store/${DYE2_NAMESPACE}/equipment`]: named(dye2Keys().equipment),
  };
}

describe("Joining a Location with Recipes, Baskets and Tools", { timeout: 120_000 }, () => {
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

  const records = (tablet: SimulatedTablet, key: "recipes" | "baskets" | "equipment") =>
    Array.isArray(dye2List(tablet, key)) ? (dye2List(tablet, key) as Record_[]) : [];
  /** The tablet's recipes, each by its slot and the global id it carries. */
  const slots = (tablet: SimulatedTablet) => records(tablet, "recipes").map((record) => [record.id, dye2GlobalIdOf(record)]);
  /** The names in one of the tablet's lists of DYE2's, sorted. */
  const names = (tablet: SimulatedTablet, key: "baskets" | "equipment") => records(tablet, key).map((record) => String(record.name)).sort();
  const extras = (tablet: SimulatedTablet) => (((tablet.workflow().context ?? {}) as Record_).extras ?? {}) as Record_;
  /** The Recipe id the tablet's Workflow names as loaded, or null. */
  const named = (tablet: SimulatedTablet) => extras(tablet)[LOADED_RECIPE_KEY] ?? null;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  const recipesAt = async (location: LocationView) => (await api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`)).recipes;
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: unknown[] }>(`/recipes/${id}/history`)).versions.length;
  /** The Library's Baskets or Tools whose names begin with `prefix`, each with the Locations showing it. */
  const library = async (kind: "baskets" | "tools", prefix: string) =>
    (await api.get<Record<string, EquipmentView[]>>(`/${kind}`))[kind]!
      .filter((item) => item.name?.startsWith(prefix))
      .map((item) => ({ name: item.name, shownAt: item.shownAt.map((shown) => shown.location.id) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const createRecipe = (location: LocationView, slot: number, content: Record_) =>
    api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId: location.id, slot, content }, 201).then((created) => created.recipe);
  const createEquipment = (kind: "baskets" | "tools", location: LocationView, name: string) =>
    api.send<Record<string, { id: string }>>("POST", `/${kind}`, { locationId: location.id, content: { name } }, 201);
  const move = (created: CreatedMachine, location: LocationView) =>
    api.send("POST", `/machines/${created.machine.id}/location-history`, { locationId: location.id }, 201);
  const setSharing = (created: CreatedMachine, sharing: boolean) => api.send("PUT", `/machines/${created.machine.id}/sharing`, { sharing });
  /** Waits a while for what should not happen, as DYE2 recording into a Recipe the Machine never loaded. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  it("writes a Machine moved from the lab to Uptown Uptown's Recipes in Uptown's slots, and clears its Workflow's Basket and Loaded Recipe, keeping its hot water", async () => {
    const lab = await api.createLocation("Moved lab", "America/Chicago");
    const uptown = await api.createLocation("Moved Uptown", "America/Chicago");
    const machine = await api.createMachine("Moved lab 1", lab.id);
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, other, { api: recordedTablet("49001", "Moved"), dye2 });
    await api.waitForOnline(machine);
    // The lab takes the tablet's recipes in slots 1 and 2, and its baskets.
    await expect.poll(() => slots(tablet).map(([, id]) => id), { timeout: 15_000 }).not.toContain(null);
    const [labOne, labTwo] = slots(tablet).map(([, id]) => id as string) as [string, string];
    // Uptown's own: Recipes in slots 2 and 3, slot 2's on the lab's slot 2's profile, so a selection there would hold, and a
    // Basket of its own, not the lab's.
    const uptownTwo = await createRecipe(uptown, 2, { name: "Uptown Brazil", profileId: CLASSIC, dose: 19, yield: 40 });
    const uptownThree = await createRecipe(uptown, 3, { name: "Uptown Kenya", profileId: CLASSIC, dose: 18, yield: 45 });
    await createEquipment("baskets", uptown, "Moved Uptown 21g");

    // Slot 2 applied on DYE2's dashboard loads the lab's Recipe, its Basket and hot water with it.
    tablet.connectMachine();
    expect((await (await openDye2Dashboard(tablet)).applyRecipe("2")).selection?.status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(labTwo);
    await loads(machine, labTwo);
    await expect.poll(() => extras(tablet).basketName).toBe("Moved Fixture 20g High-flow");
    const hotWater = tablet.workflow().hotWaterData;
    const edits = await versions(uptownTwo.id);

    await move(machine, uptown);
    // Uptown's Recipes in their slots, slot 1 left empty, and none of the lab's.
    await expect.poll(() => slots(tablet), { timeout: 15_000 }).toEqual([
      ["2", uptownTwo.id],
      ["3", uptownThree.id],
    ]);
    expect(slots(tablet).flat()).not.toContain(labOne);
    // Its Loaded Recipe is cleared from the Workflow and from DYE2's selection, which is kept cleared, and Uptown's in slot 2
    // is not loaded in its place.
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);
    expect(dye2.selected()).toBeNull();
    await expect.poll(() => tablet.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    // Uptown does not show the lab's Basket: it is cleared from the Workflow, which keeps its hot water.
    await expect.poll(() => [extras(tablet).basketId ?? null, extras(tablet).basketName ?? null]).toEqual([null, null]);
    expect(names(tablet, "baskets")).toEqual(["Moved Uptown 21g"]);
    expect(tablet.workflow().hotWaterData).toEqual(hotWater);
    // DYE2 records nothing into Uptown's Recipe in slot 2.
    await tablet.changeSettings({ context: { grinderSetting: "4.4" } });
    await settle();
    expect(dye2.recorded.filter((record) => record.id === "2" && record.patch.grind === 4.4)).toEqual([]);
    expect(await versions(uptownTwo.id)).toBe(edits);
    expect((await recipe(uptownTwo.id)).content.grindSetting).toBeUndefined();
    await loads(machine, null);
    // The lab's Recipes stay the lab's, in their slots.
    expect((await recipesAt(lab)).map((held) => [held.id, held.slot])).toEqual([
      [labOne, 1],
      [labTwo, 2],
    ]);
  });

  it("drops a capture-only Machine's own recipes, baskets and tools as it joins a Location that has some, leaving none in the Library", async () => {
    const cafe = await api.createLocation("Dropping cafe", "America/Chicago");
    const cafeRecipe = await createRecipe(cafe, 2, { name: "Dropping house", profileId: CLASSIC, dose: 18, yield: 38 });
    await createEquipment("baskets", cafe, "Dropping cafe 22g");
    await createEquipment("tools", cafe, "Dropping cafe WDT");
    // Its sharing is off before its tablet first connects: capture-only, its experiments there are its own.
    const machine = await api.createMachine("Dropping 1", cafe.id);
    await setSharing(machine, false);
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, server, { api: recordedTablet("49011", "Dropping own"), dye2 });
    await api.waitForOnline(machine);
    // Its own recipe in slot 2, applied while capture-only, stays selected there, on the profile the cafe's slot 2 is on.
    expect((await (await openDye2Dashboard(tablet)).applyRecipe("2")).selection?.status).toBe(200);
    await settle();
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: "2" });
    expect(slots(tablet)).toEqual([
      ["1", null],
      ["2", null],
    ]);

    await setSharing(machine, true);
    // The cafe's Recipe in slot 2, and its Basket and Tool, replace the tablet's own, which are not kept.
    await expect.poll(() => slots(tablet), { timeout: 15_000 }).toEqual([["2", cafeRecipe.id]]);
    await expect.poll(() => names(tablet, "baskets")).toEqual(["Dropping cafe 22g"]);
    await expect.poll(() => names(tablet, "equipment")).toEqual(["Dropping cafe WDT"]);
    expect(await library("baskets", "Dropping own")).toEqual([]);
    expect(await library("tools", "Dropping own")).toEqual([]);
    expect((await recipesAt(cafe)).map((held) => held.id)).toEqual([cafeRecipe.id]);
    // The selection of its own recipe, gone from slot 2, is cleared before the cafe's is put there, which is not loaded.
    await expect.poll(() => dye2.selected()).toBeNull();
    expect(tablet.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    const edits = await versions(cafeRecipe.id);
    await tablet.changeSettings({ context: { grinderSetting: "3.3" } });
    await settle();
    expect(await loadedRecipe(machine)).toBeNull();
    expect(named(tablet)).toBeNull();
    expect(await versions(cafeRecipe.id)).toBe(edits);
  });

  it("keeps a joining Machine's Workflow's Basket of a name the Location shows, and clears its own one", async () => {
    const cafe = await api.createLocation("Matching cafe", "America/Chicago");
    const shown = (await createEquipment("baskets", cafe, "Matching Fixture 20g High-flow")).basket!;
    /** A tablet whose Workflow names its record of the basket of that name, by that name as DYE2 sets it unless given another. */
    const naming = (serial: string, basket: string, named = basket): DecaidApi => {
      const tablet = recordedTablet(serial, "Matching");
      const record = (tablet[`/store/${DYE2_NAMESPACE}/baskets`] as Record_[]).find((held) => held.name === basket)!;
      const workflow = tablet["/workflow"] as Record_;
      return { ...tablet, "/workflow": { ...workflow, context: { ...(workflow.context as Record_), extras: { basketId: record.id, basketName: named } } } };
    };
    const machines = [
      await api.createMachine("Matching 1", cafe.id),
      await api.createMachine("Matching 2", cafe.id),
      await api.createMachine("Matching 3", cafe.id),
    ] as const;
    const kept = syncingTablet(machines[0], server, { api: naming("49031", "Matching Fixture 20g High-flow") });
    const cleared = syncingTablet(machines[1], other, { api: naming("49032", "Matching Fixture 18g Precision") });
    // Renamed in DYE2 since the Workflow named it: its record is the cafe's Basket all the same, and the Workflow keeps it.
    const renamed = syncingTablet(machines[2], server, { api: naming("49033", "Matching Fixture 20g High-flow", "Matching old 20g") });
    await api.waitForOnline(...machines);
    // Each tablet's record of the cafe's Basket is that Basket, and the Workflow naming it keeps it.
    for (const tablet of [kept, cleared, renamed]) {
      await expect.poll(() => records(tablet, "baskets").map((record) => [record.name, dye2GlobalIdOf(record)]), { timeout: 15_000 }).toEqual([["Matching Fixture 20g High-flow", shown.id]]);
    }
    await settle();
    expect(extras(kept).basketName).toBe("Matching Fixture 20g High-flow");
    expect(extras(kept).basketId).toBe(records(kept, "baskets")[0]!.id);
    expect(extras(renamed).basketId).toBe(records(renamed, "baskets")[0]!.id);
    // The tablet's own Basket, which the cafe leaves out, is cleared.
    await expect.poll(() => [extras(cleared).basketId ?? null, extras(cleared).basketName ?? null]).toEqual([null, null]);
    expect(await library("baskets", "Matching")).toEqual([{ name: "Matching Fixture 20g High-flow", shownAt: [cafe.id] }]);
  });

  it("has the first Machine at a new Location bring its recipes in their slots, and its baskets and tools, shown there", async () => {
    const cafe = await api.createLocation("Seeded cafe", "America/Chicago");
    const first = await api.createMachine("Seeded 1", cafe.id);
    const tablet = syncingTablet(first, other, { api: recordedTablet("49021", "Seeded"), dye2: new SimulatedDye2() });
    await api.waitForOnline(first);
    // Its recipes are the cafe's Recipes, in the slots they were in.
    await expect.poll(async () => (await recipesAt(cafe)).map((held) => [held.slot, held.name]), { timeout: 15_000 }).toEqual([
      [1, "Fixture Ethiopia Espresso"],
      [2, "Fixture Brazil Espresso"],
    ]);
    await expect.poll(() => slots(tablet).map(([, id]) => id)).not.toContain(null);
    // Its baskets and tools join the Library, shown at the cafe.
    expect(await library("baskets", "Seeded")).toEqual([
      { name: "Seeded Fixture 18g Precision", shownAt: [cafe.id] },
      { name: "Seeded Fixture 20g High-flow", shownAt: [cafe.id] },
    ]);
    const tools = await library("tools", "Seeded");
    expect(tools.map((tool) => tool.name)).toEqual(names(tablet, "equipment"));
    expect(tools.map((tool) => tool.shownAt)).toEqual(tools.map(() => [cafe.id]));
    // A second Machine there is written them.
    const second = await api.createMachine("Seeded 2", cafe.id);
    const fresh = syncingTablet(second, server, { api: dye2NeverUsed("49022"), dye2: new SimulatedDye2() });
    await api.waitForOnline(second);
    await expect.poll(() => slots(fresh), { timeout: 15_000 }).toEqual(slots(tablet));
    await expect.poll(() => names(fresh, "baskets")).toEqual(names(tablet, "baskets"));
    await expect.poll(() => names(fresh, "equipment")).toEqual(names(tablet, "equipment"));
  });
});
