import { dye2GlobalIdOf, recipeSlotOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { recipeIdInWorkflow, recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { startStreamline } from "./support/simulated-streamline.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, dye2PagesKeys, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import type { DecaidApi, SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #148 and #216: a Machine joining a Location takes on its
// Recipes, Baskets and Tools (ADR-0008, ADR-0018). Its tablet is written
// every Recipe of the Location not Archived, under the record id it has on
// every tablet there and with its Recipe Slot as its `stripSlot`; its
// records of another Location's Recipes leave its list, and its own
// recipes, baskets and tools are removed from DYE2's lists and not kept,
// unless the Location has none of that kind yet, which takes them in, its
// recipes with their ids and slots. Its Workflow loses a Basket the Location
// does not show and its Loaded Recipe, whose `recipeId` is cleared from it,
// and keeps its hot water; and it never loads the Location's Recipe through
// a `recipeId` its Workflow still names, even where that Recipe has the same
// slot-number record id as the one it had loaded. Through the built plugin in
// simulated tablets running DYE2 v0.1.33 as recorded
// (fixtures/decaid/dye2-v0.1.26/), on two server instances sharing one
// database, with assertions through the REST API and what each simulated
// tablet holds. Serials are made up, from 49001.

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

/** The recording's profile the Brazil is made on, by its id. */
const CLASSIC = "profile:39e939592679fb194706";

/** The record id of the recording's Brazil, in slot 2, the slot-number id DYE2 gave it before v0.1.25. */
const BRAZIL = "2";

/** The recording's eight recipes (recordedDye2MainTablet), each by its name and its slot, by name. */
const RECORDED_SLOTS = [
  // Hidden from the strip, so in no slot, whatever its stripSlot 3 says (DYE2 v0.1.32's stripTargetOf).
  ["Fixture Blank Recipe", null],
  ["Fixture Brazil Espresso", 2],
  ["Fixture Ethiopia Espresso", null],
  ["Fixture Favourite Recipe", null],
  ["Fixture Library Recipe", 1],
  ["Fixture Newer Slot 4 Recipe", 4],
  ["Fixture Old Slot 4 Recipe", null],
  ["Fixture Slot Recipe", null],
];

/**
 * The v0.1.26 recording's tablet with this serial (recordedDye2MainTablet),
 * its eight recipes, some under slot-number ids and the rest under opaque
 * ones, in slots or not, its beans', baskets' and tools' names begun with
 * `scenario`, as Beans, Baskets and Tools are matched by name across a
 * file's tests (ADR-0018), with the tools DYE2's equipment page made at
 * 2cf631c (fixtures/decaid/dye2-2cf631c/) beside its baskets.
 */
function recordedTablet(serial: string, scenario: string): DecaidApi {
  const api = recordedDye2MainTablet(serial, scenario);
  const named = (records: unknown) => (records as Record_[]).map((record) => ({ ...record, name: `${scenario} ${String(record.name)}` }));
  return {
    ...api,
    [`/store/${DYE2_NAMESPACE}/baskets`]: named(api[`/store/${DYE2_NAMESPACE}/baskets`]),
    [`/store/${DYE2_NAMESPACE}/equipment`]: named(dye2PagesKeys().equipment),
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
    await server?.stop();
  });

  const records = (tablet: SimulatedTablet, key: "recipes" | "baskets" | "equipment") =>
    Array.isArray(dye2List(tablet, key)) ? (dye2List(tablet, key) as Record_[]) : [];
  /** The tablet's recipes, each as its record id, the global id it carries and its strip slot, by record id. */
  const recipeRecords = (tablet: SimulatedTablet) =>
    records(tablet, "recipes")
      .map((record) => [record.id, dye2GlobalIdOf(record), recipeSlotOf(record)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  /** The global id the tablet's record with that id carries, or null. */
  const recipeUnder = (tablet: SimulatedTablet, id: string) => dye2GlobalIdOf(records(tablet, "recipes").find((record) => record.id === id));
  /** The names in one of the tablet's lists of DYE2's, sorted. */
  const names = (tablet: SimulatedTablet, key: "baskets" | "equipment") => records(tablet, key).map((record) => String(record.name)).sort();
  const extras = (tablet: SimulatedTablet) => (((tablet.workflow().context ?? {}) as Record_).extras ?? {}) as Record_;
  /** The Recipe the tablet's Workflow names by its `recipeId`, through the tablet's records, or null. */
  const named = recipeNamedInWorkflow;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  /** Every Recipe the Machine has had loaded, latest first. */
  const loadedHistory = async ({ machine }: CreatedMachine) =>
    (await api.get<{ entries: { recipe: { id: string } }[] }>(`/machines/${machine.id}/loaded-recipes?limit=100`)).entries.map((entry) => entry.recipe.id);
  const recipesAt = async (location: LocationView) => (await api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`)).recipes;
  /** The Location's Recipes, each by its name and its slot, by name. */
  const slotsAt = async (location: LocationView) => (await recipesAt(location)).map((held) => [held.name, held.slot]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
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
  /**
   * Resolves once the tablets, their DYE2s and the Machines given have nothing left under way (`quiesced`), so a wrong write
   * or load a step set off has landed before a check after it that it did not happen.
   */
  const quiet = (tablets: Record<string, SimulatedTablet>, machines: Record<string, CreatedMachine>) => quiesced(api, { tablets, machines });

  /** A Location whose first Machine's tablet is the recording's, so its recipes are the Location's Recipes, under the same ids; resolves once its records carry their Recipes' global ids. */
  async function seeded(name: string, serial: string, scenario: string, instance: TestServer) {
    const location = await api.createLocation(name, "America/Chicago");
    const machine = await api.createMachine(`${name} 1`, location.id);
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, instance, { api: recordedTablet(serial, scenario), dye2 });
    await api.waitForOnline(machine);
    await expect.poll(async () => (await recipesAt(location)).length, { timeout: 15_000 }).toBe(8);
    await expect.poll(() => recipeRecords(tablet).every(([, id]) => id !== null), { timeout: 15_000 }).toBe(true);
    return { location, machine, tablet, dye2 };
  }

  it("writes a Machine moved from the lab to Uptown Uptown's Recipes under their ids and slots, and clears its Workflow's Basket and Loaded Recipe, keeping its hot water", async () => {
    const uptown = await api.createLocation("Moved Uptown", "America/Chicago");
    const { location: lab, machine, tablet, dye2 } = await seeded("Moved lab", "49001", "Moved", other);
    const labRecordIds = recipeRecords(tablet).map(([id]) => id);
    const labBrazil = recipeUnder(tablet, BRAZIL)!;
    // Uptown's own, made in the management interface under ids of their own: Recipes in slots 2 and 3, slot 2's on the lab's
    // Brazil's profile, and a Basket of its own, not the lab's.
    const uptownTwo = await createRecipe(uptown, 2, { name: "Uptown Brazil", profileId: CLASSIC, dose: 19, yield: 40 });
    const uptownThree = await createRecipe(uptown, 3, { name: "Uptown Kenya", profileId: CLASSIC, dose: 18, yield: 45 });
    await createEquipment("baskets", uptown, "Moved Uptown 21g");

    // The Brazil applied on DYE2's dashboard loads the lab's Recipe, with the Workflow naming its Basket, the lab's.
    tablet.connectMachine();
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(labBrazil);
    await loads(machine, labBrazil);
    const labBasket = records(tablet, "baskets").find((record) => record.name === "Moved Fixture 20g High-flow")!.id;
    await expect.poll(() => extras(tablet).basketId).toBe(labBasket);
    const hotWater = tablet.workflow().hotWaterData;
    const edits = await versions(uptownTwo.id);

    await move(machine, uptown);
    // Uptown's Recipes in their slots, under the ids Uptown gave them, and none of the lab's.
    const bySlot = () => records(tablet, "recipes").map((record) => [dye2GlobalIdOf(record), record.stripSlot ?? null]).sort((a, b) => Number(a[1]) - Number(b[1]));
    await expect.poll(bySlot, { timeout: 15_000 }).toEqual([
      [uptownTwo.id, 2],
      [uptownThree.id, 3],
    ]);
    expect(recipeRecords(tablet).filter(([id]) => labRecordIds.includes(id))).toEqual([]);
    // Its Loaded Recipe is cleared from the Workflow, which DYE2's selection follows, and Uptown's in slot 2 is not loaded in
    // its place.
    await expect.poll(() => recipeIdInWorkflow(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);
    expect(dye2.selected()).toBeNull();
    // Uptown does not show the lab's Basket: it is cleared from the Workflow, which keeps its hot water.
    await expect.poll(() => [extras(tablet).basketId ?? null, extras(tablet).basketName ?? null]).toEqual([null, null]);
    expect(names(tablet, "baskets")).toEqual(["Moved Uptown 21g"]);
    expect(tablet.workflow().hotWaterData).toEqual(hotWater);
    // Nothing is saved into Uptown's Recipe in slot 2.
    await tablet.changeSettings({ context: { grinderSetting: "4.4" } });
    // Once the change's report, and anything it set off, are done.
    await quiet({ tablet }, { machine });
    const uptownTwoRecord = String(records(tablet, "recipes").find((record) => dye2GlobalIdOf(record) === uptownTwo.id)?.id);
    expect(dye2.recorded.filter((record) => record.id === uptownTwoRecord)).toEqual([]);
    expect(await versions(uptownTwo.id)).toBe(edits);
    expect((await recipe(uptownTwo.id)).content.grindSetting).toBeUndefined();
    await loads(machine, null);
    // The lab's Recipes stay the lab's, in their slots.
    expect(await slotsAt(lab)).toEqual(RECORDED_SLOTS);
  });

  it("never loads Uptown's Recipe through the record id the Workflow still names as its Machine moves there, though it is the lab's Brazil's slot-number id too", async () => {
    const { location: lab, machine, tablet } = await seeded("Same id lab", "49041", "Same id lab", server);
    const { location: uptown, machine: uptownMachine, tablet: uptownTablet } = await seeded("Same id Uptown", "49042", "Same id Uptown", other);
    const labBrazil = recipeUnder(tablet, BRAZIL)!;
    const uptownBrazil = recipeUnder(uptownTablet, BRAZIL)!;
    expect(uptownBrazil).not.toBe(labBrazil);
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(labBrazil);
    await loads(machine, labBrazil);

    await move(machine, uptown);
    // Every record keeps its id, each now Uptown's Recipe's: the Workflow's `recipeId` is cleared, and Uptown's Brazil is
    // never loaded through it.
    await expect.poll(() => recipeRecords(tablet), { timeout: 15_000 }).toEqual(recipeRecords(uptownTablet));
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);
    // Once the move's writes, the tablet's reports of them and anything they set off are done.
    await quiet({ tablet, uptownTablet }, { machine, uptownMachine });
    expect(await loadedRecipe(machine)).toBeNull();
    expect(await loadedHistory(machine)).not.toContain(uptownBrazil);
    expect((await recipesAt(lab)).map((held) => held.id)).toContain(labBrazil);

    // Applied there from Streamline's strip, Uptown's Brazil is loaded.
    expect((await (await startStreamline(tablet)).applyRecipe(2)).workflow?.status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(uptownBrazil);
    await loads(machine, uptownBrazil);
  });

  it("drops a capture-only Machine's own recipes, baskets and tools as it joins a Location that has some, under the same ids, leaving none in the Library", async () => {
    const { location: cafe, machine: cafeMachine, tablet: cafeTablet } = await seeded("Dropping cafe", "49011", "Dropping cafe", other);
    const cafeBrazil = recipeUnder(cafeTablet, BRAZIL)!;
    const cafeRecipes = (await recipesAt(cafe)).map((held) => held.id).sort();
    // Its sharing is off before its tablet first connects: capture-only, its experiments there are its own.
    const machine = await api.createMachine("Dropping 1", cafe.id);
    await setSharing(machine, false);
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, server, { api: recordedTablet("49012", "Dropping own"), dye2 });
    await api.waitForOnline(machine);
    // Its own Brazil, applied while capture-only, stays named in the Workflow, under the id the cafe's Brazil has too.
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(BRAZIL)).workflow?.status).toBe(200);
    // Once the apply's report, and anything it set off, are done.
    await quiet({ tablet, cafeTablet }, { machine, cafeMachine });
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: BRAZIL });
    expect(recipeRecords(tablet).every(([, id]) => id === null)).toBe(true);
    const edits = await versions(cafeBrazil);

    await setSharing(machine, true);
    // The cafe's Recipes, under their ids and in their slots, and its Baskets and Tools, replace the tablet's own, which are
    // not kept.
    await expect.poll(() => recipeRecords(tablet), { timeout: 15_000 }).toEqual(recipeRecords(cafeTablet));
    await expect.poll(() => names(tablet, "baskets")).toEqual(names(cafeTablet, "baskets"));
    await expect.poll(() => names(tablet, "equipment")).toEqual(names(cafeTablet, "equipment"));
    expect(await library("baskets", "Dropping own")).toEqual([]);
    expect(await library("tools", "Dropping own")).toEqual([]);
    expect((await recipesAt(cafe)).map((held) => held.id).sort()).toEqual(cafeRecipes);
    // Its own Brazil, gone, is cleared from the Workflow before the cafe's is written under its id, which is not loaded.
    await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
    expect(dye2.selected()).toBeNull();
    await tablet.changeSettings({ context: { grinderSetting: "3.3" } });
    // Once the change's report, and anything it set off, are done.
    await quiet({ tablet, cafeTablet }, { machine, cafeMachine });
    expect(await loadedRecipe(machine)).toBeNull();
    expect(await loadedHistory(machine)).toEqual([]);
    expect(await versions(cafeBrazil)).toBe(edits);
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
    // Once the joins' writes, the tablets' reports of them and anything they set off are done.
    await quiet({ kept, cleared, renamed }, { kept: machines[0], cleared: machines[1], renamed: machines[2] });
    expect(extras(kept).basketName).toBe("Matching Fixture 20g High-flow");
    expect(extras(kept).basketId).toBe(records(kept, "baskets")[0]!.id);
    expect(extras(renamed).basketId).toBe(records(renamed, "baskets")[0]!.id);
    // The tablet's own Basket, which the cafe leaves out, is cleared.
    await expect.poll(() => [extras(cleared).basketId ?? null, extras(cleared).basketName ?? null]).toEqual([null, null]);
    expect(await library("baskets", "Matching")).toEqual([{ name: "Matching Fixture 20g High-flow", shownAt: [cafe.id] }]);
  });

  it("has the first Machine at a new Location bring its recipes under their ids and in their slots, and its baskets and tools, shown there", async () => {
    const cafe = await api.createLocation("Seeded cafe", "America/Chicago");
    const first = await api.createMachine("Seeded 1", cafe.id);
    const tablet = syncingTablet(first, other, { api: recordedTablet("49021", "Seeded"), dye2: new SimulatedDye2() });
    await api.waitForOnline(first);
    const recorded = records(tablet, "recipes").map((record) => record.id).sort();
    // Its recipes are the cafe's Recipes, in the slots they were in, each record keeping its id, slot number or opaque, and
    // carrying its Recipe's global id.
    await expect.poll(() => slotsAt(cafe), { timeout: 15_000 }).toEqual(RECORDED_SLOTS);
    await expect.poll(() => recipeRecords(tablet).every(([, id]) => id !== null)).toBe(true);
    expect(recipeRecords(tablet).map(([id]) => id)).toEqual(recorded);
    for (const [, globalId, slot] of recipeRecords(tablet)) expect((await recipe(globalId as string)).slot).toBe(slot);
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
    await expect.poll(() => recipeRecords(fresh), { timeout: 15_000 }).toEqual(recipeRecords(tablet));
    await expect.poll(() => names(fresh, "baskets")).toEqual(names(tablet, "baskets"));
    await expect.poll(() => names(fresh, "equipment")).toEqual(names(tablet, "equipment"));
  });
});
