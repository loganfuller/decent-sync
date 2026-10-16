import { GLOBAL_ID_KEY, RECIPE_FIELD, profileAtBrewTemperature } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import {
  DYE2_NAMESPACE,
  type Dye2Key,
  dye2Library,
  dye2List,
  dye2NeverUsed,
  dye2Recording,
  openDye2Dashboard,
  recordedDye2Tablet,
  saveInDye2,
} from "./support/simulated-dye2.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { DecaidApi, SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #140: Recipes in their Recipe Slots, which DYE2 keeps in
// its `recipes` list in Decaid's store (ADR-0005), reach every tablet at
// their Location. A recipe saved in a slot on one tablet is written to that
// slot on the Location's other tablets, naming its Bean, Grinder, Basket and
// Tools by each tablet's own ids, and to no other Location's; edits merge per
// field with Conflicts (ADR-0020); a recipe gone from a tablet's list is taken
// out of its slot there (ADR-0019). And for ticket #142, a save from a DYE2
// page opened before another tablet's change keeps that change (ADR-0005).
// Through the built plugin in simulated tablets, acting as DYE2 at 2cf631c and
// Streamline at c006dac do with the steps recorded from them
// (fixtures/decaid/dye2-2cf631c/), on two server instances sharing one
// database, with assertions through the REST API and what each simulated
// tablet's store holds. Serials are made up, from 42001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  name: string | null;
  location: LocationView | null;
  slot: number | null;
  archived: boolean;
  content: Record_;
}

/** The recording's tablet's ids for what its recipes name (fixtures/decaid/dye2-2cf631c/library.json, keys.json). */
const RECORDED = {
  brazil: "1497c30b-e01e-4241-b1b0-a82bdae089d3",
  ethiopia: "bdae1553-8b0f-4d37-94a1-15d61b543e74",
  brazilBatch: "837c5af9-aa43-44ed-a857-5009969e3217",
  ethiopiaBatch: "6f741a24-ceb9-4ec6-aa51-750c6e9fec26",
  grinder: "cc95ada6-98db-4495-8b24-a46239ad94a0",
  basket18: "b09fb95c-7e5d-4be1-a4b8-d89c79523343",
  basket20: "fa7809d4-1843-4745-8a37-ca6f43025dba",
  wdtTool: "0ee0a5bb-5e08-4a2b-9bce-3b256693a6d2",
  puckScreen: "28dc53fe-df8b-4789-9589-49ef5e45d57e",
} as const;

/** Decaid's bundled Profiles the recorded recipes use. */
const ADAPTIVE = "profile:98fa00c191551b435845";
const CLASSIC = "profile:39e939592679fb194706";

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Recipes in their slots reach every tablet at their Location", { timeout: 90_000 }, () => {
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

  /** The built plugin on a tablet of the Machine, connected to an instance, polling every 5 s (0.1 s here) unless `pollSeconds` says otherwise. */
  function load(machine: CreatedMachine, decaidApi: DecaidApi, instance: TestServer = server, pollSeconds = 5): SimulatedTablet {
    return syncingTablet(machine, instance, { api: decaidApi, pollSeconds });
  }

  /** A Location with two Machines, the first's tablet the recording's, on one instance, the second's empty, on the other. */
  async function lab(scenario: string, serials: number, first: DecaidApi = recordedDye2Tablet(String(serials), scenario)) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = [await api.createMachine(`${scenario} lab 1`, here.id), await api.createMachine(`${scenario} lab 2`, here.id)] as const;
    const one = load(machines[0], first);
    const two = load(machines[1], dye2NeverUsed(String(serials + 1)), other);
    await api.waitForOnline(...machines);
    return { here, machines, one, two };
  }

  const recipesAt = async (location: LocationView) =>
    (await api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`)).recipes;
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  /** The tablet's records in DYE2's list, as its store holds them; none for a key never written. */
  const records = (tablet: SimulatedTablet, key: Dye2Key): Record_[] => {
    const value = dye2List(tablet, key);
    return Array.isArray(value) ? (value as Record_[]) : [];
  };
  const inSlot = (tablet: SimulatedTablet, slot: string) => records(tablet, "recipes").find((record) => record.id === slot);
  const variables = (record: Record_ | undefined) => (record?.dashboardVariables ?? {}) as Record_;
  /** The tablet's id for its record of a Library item, by the global id the record carries. */
  const localId = async (tablet: SimulatedTablet, route: string, globalId: string): Promise<string | undefined> => {
    if (route.startsWith("/store/")) return (asList(dye2List(tablet, route.split("/").at(-1) as Dye2Key)).find((record) => record[GLOBAL_ID_KEY] === globalId)?.id ?? undefined) as string | undefined;
    const list = asList((await tablet.callApi("GET", `${route}?includeArchived=true`)).body);
    return list.find((record) => (record.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] === globalId)?.id as string | undefined;
  };

  /**
   * Saves the tablet's recipe in that slot as DYE2's recipe editor saves one
   * opened on it: every field as the tablet holds it, with `changes` made, a
   * field of its `dashboardVariables` by its path, and `capturedAt` stamped
   * anew; the list read and posted back whole.
   */
  const editInDye2 = async (tablet: SimulatedTablet, slot: string, changes: Record_) => {
    const list = asList((await tablet.callApi("GET", `/store/${DYE2_NAMESPACE}/recipes`)).body);
    const edited = list.map((record) => {
      if (record.id !== slot) return record;
      const next: Record_ = { ...record, dashboardVariables: { ...variables(record) }, capturedAt: new Date().toISOString() };
      for (const [path, value] of Object.entries(changes)) {
        if (path.startsWith("dashboardVariables.")) (next.dashboardVariables as Record_)[path.slice("dashboardVariables.".length)] = value;
        else next[path] = value;
      }
      return next;
    });
    expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, edited)).status).toBe(200);
  };

  /** The ids of the records the tablet's latest report of its recipes listed, as the server stored it. */
  const reportedSlots = async (machine: CreatedMachine) =>
    ((await api.get<{ collection: { value: Record_[] } | null }>(`/machines/${machine.machine.id}/collections/dye2Recipes`)).collection?.value ?? []).map(
      (record) => record.id,
    );

  const recipes = dye2Recording("recipes");

  it("writes a recipe saved in DYE2 in slot 2 to slot 2 on the Location's other tablets, under their own ids, and to no other Location's", async () => {
    const { here, one, two } = await lab("Saved", 42001);
    const cafe = await api.createLocation("Saved cafe", "America/Chicago");
    const cafeMachine = await api.createMachine("Saved cafe 1", cafe.id);
    const cafeTablet = load(cafeMachine, dye2NeverUsed("42003"));
    await api.waitForOnline(cafeMachine);

    await saveInDye2(one, recipes.saveSlot2);
    await expect.poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot])).toEqual([["Fixture Brazil Espresso", 2]]);
    const [saved] = await recipesAt(here);
    // In the Library's terms: its Bean, and that Bean's batch at the Location; its Profile, read from the Workflow and named
    // by DYE2 by its whole profile alone; its Grinder, Basket and Tool; and its dial and hot water by volume.
    const bean = await localGlobal(here, "beans", `Saved Fixture Brazil`);
    expect(saved!.content).toEqual(
      expect.objectContaining({
        name: "Fixture Brazil Espresso",
        beverage: "",
        beanId: bean,
        profileId: CLASSIC,
        dose: 19,
        yield: 36,
        grindSetting: 3,
        rpm: 1100,
        showOnDashboard: true,
        steamMode: "flow",
        hotWaterMode: "vol",
        hotWaterVolume: 150,
      }),
    );
    // Its brew temperature was left blank, which DYE2's editor saves as none.
    expect(saved!.content).not.toHaveProperty("brewTemperature");
    for (const field of ["beanBatchId", "grinderId", "basketId"]) expect(saved!.content[field]).toEqual(expect.any(String));
    expect(saved!.content.toolIds).toEqual([expect.any(String)]);
    expect(saved!.content).not.toHaveProperty("barista");
    expect(await recipesAt(cafe)).toEqual([]);

    // The other tablet at the Location holds it in slot 2, under its own ids for what it names, with what DYE2 derives.
    const ids = {
      bean: () => localId(two, "/beans", bean),
      batch: () => localId(two, "/bean-batches", saved!.content.beanBatchId as string),
      grinder: () => localId(two, "/grinders", saved!.content.grinderId as string),
      basket: () => localId(two, "/store/dye2.reaplugin/baskets", saved!.content.basketId as string),
      tool: () => localId(two, "/store/dye2.reaplugin/equipment", (saved!.content.toolIds as string[])[0]!),
    };
    // Once the tablet holds a record of each, written there first.
    await expect.poll(async () => (await Promise.all(Object.values(ids).map((id) => id()))).every((id) => id !== undefined)).toBe(true);
    await expect.poll(() => inSlot(two, "2")).toMatchObject({
      id: "2",
      name: "Fixture Brazil Espresso",
      [GLOBAL_ID_KEY]: saved!.id,
      title: "Fixture Brazil Espresso",
      subtitle: "Saved Fixture Brazil",
      beanId: await ids.bean(),
      beanName: "Saved Fixture Brazil",
      profileId: CLASSIC,
      profileTitle: "Classic Italian espresso",
      barista: "",
      drinker: "",
      dashboardVariables: {
        dose: 19,
        drink: 36,
        grind: 3,
        rpm: 1100,
        grinderId: await ids.grinder(),
        grinderModel: "Fixture Grinder 64",
        basketId: await ids.basket(),
        basketName: "Fixture 20g High-flow",
        equipmentNames: ["Fixture Puck Screen"],
        hotWaterMode: "vol",
        hotWaterMl: 150,
      },
      [RECIPE_FIELD]: { beanBatchId: await ids.batch(), hotWaterData: { volume: 150, targetTemperature: null, duration: null, flow: null } },
    });
    const written = inSlot(two, "2")!;
    expect(variables(written).equipmentIds).toEqual([await ids.tool()]);
    for (const id of [written.beanId, variables(written).grinderId, variables(written).basketId, ...(variables(written).equipmentIds as string[])]) {
      expect(Object.values(RECORDED)).not.toContain(id);
    }
    // Its embedded Workflow is DYE2's, built from the record written there: the tablet's grinder and basket, and the full Profile.
    expect(written.workflow).toMatchObject({
      context: {
        targetDoseWeight: 19,
        targetYield: 36,
        grinderSetting: "3",
        grinderId: await ids.grinder(),
        grinderModel: "Fixture Grinder 64",
        coffeeName: "Saved Fixture Brazil",
        extras: { rpm: 1100, basketId: await ids.basket(), basketName: "Fixture 20g High-flow" },
      },
      profile: { title: "Classic Italian espresso" },
    });
    expect((written.profileSnapshot as Record_).steps).toEqual(expect.any(Array));

    // The tablet that saved it carries its global id in a field of its own, and nothing reaches the cafe's.
    await expect.poll(() => inSlot(one, "2")?.[GLOBAL_ID_KEY]).toBe(saved!.id);
    expect(dye2List(cafeTablet, "recipes")).toBeNull();
    expect(cafeTablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "recipes")).toEqual([]);
  });

  it("keeps edits of different fields on two tablets, keeps two edits of one field made without seeing each other as a Conflict, and never shares a barista", async () => {
    const { here, machines, one, two } = await lab("Edited", 42011);
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => inSlot(two, "1")?.name).toBe("Fixture Ethiopia Espresso");
    const [saved] = await recipesAt(here);
    // The barista and drinker saved with it are written back blank, and reach no other tablet nor the Recipe.
    await expect.poll(() => [inSlot(one, "1")?.barista, inSlot(one, "1")?.drinker]).toEqual(["", ""]);
    expect([inSlot(two, "1")!.barista, inSlot(two, "1")!.drinker]).toEqual(["", ""]);
    expect((inSlot(two, "1")!.workflow as { context: Record_ }).context).not.toHaveProperty("baristaName");
    expect(saved!.content).not.toHaveProperty("barista");
    expect(saved!.content).not.toHaveProperty("drinker");

    // Each tablet changes another field, each from the record it holds: both survive, everywhere.
    await editInDye2(one, "1", { "dashboardVariables.dose": 18.2 });
    await editInDye2(two, "1", { "dashboardVariables.grind": 2.6 });
    for (const tablet of [one, two]) {
      await expect.poll(() => [variables(inSlot(tablet, "1")).dose, variables(inSlot(tablet, "1")).grind]).toEqual([18.2, 2.6]);
    }
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.2, grindSetting: 2.6 });

    // Offline, the second tablet misses the first's dose of 18.4, then sets 18.6. Neither saw the other's.
    two.loseNetwork();
    await api.waitForMachine(machines[1].machine.name, (viewed) => !viewed.online, 15_000);
    await editInDye2(one, "1", { "dashboardVariables.dose": 18.4 });
    await expect.poll(async () => (await recipe(saved!.id)).content.dose).toBe(18.4);
    await editInDye2(two, "1", { "dashboardVariables.dose": 18.6 });
    // Back online, its edit, made and read after the other's, wins, and the other's value is kept as a Conflict.
    two.restoreNetwork();
    for (const tablet of [one, two]) await expect.poll(() => variables(inSlot(tablet, "1")).dose).toBe(18.6);
    const conflicts = (await api.get<{ conflicts: { field: string; value: unknown; item: Record_ }[] }>(`/recipes/${saved!.id}/conflicts`)).conflicts;
    expect(conflicts).toEqual([expect.objectContaining({ field: "dose", value: 18.4, item: { kind: "recipe", id: saved!.id, name: "Fixture Ethiopia Espresso" } })]);
    // Its history holds each accepted edit, the first its joining the Library from the tablet that saved it.
    const versions = (await api.get<{ versions: { fields: Record_; source: { machine: { name: string } | null } }[] }>(`/recipes/${saved!.id}/history`)).versions;
    expect(versions.at(-1)).toMatchObject({ fields: { name: "Fixture Ethiopia Espresso", dose: 18 }, source: { machine: { name: "Edited lab 1" } } });
  });

  it("keeps another tablet's change of a recipe saved from a DYE2 recipe page opened before it, and spreads what the save changed", async () => {
    const { here, one, two } = await lab("Stale", 42081);
    // The first tablet's recipe editor opens on slot 1 as saved: the values the recorded edit of it was made from.
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => inSlot(two, "1")?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    await expect.poll(() => inSlot(one, "1")?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    expect(saved!.content).toMatchObject({ dose: 18, grindSetting: 2.5, hotWaterTemperature: 85 });

    // The second tablet changes the grind setting from 2.5 to 2.6, which the first is written.
    await editInDye2(two, "1", { "dashboardVariables.grind": 2.6 });
    await expect.poll(() => variables(inSlot(one, "1")).grind).toBe(2.6);

    // The first tablet's page, loaded before that, saves its barista's dose of 18.5: the recorded editor save, but with the
    // grind setting and hot water temperature the page loaded rather than those the recording changed.
    const fromPage = (grind: number) => (item: Record_) => ({ ...item, dashboardVariables: { ...variables(item), grind, hotWaterTempC: 85 } });
    await saveInDye2(one, recipes.editSlot1, fromPage(2.5));
    // The grind setting it set back is no edit: the second tablet's is kept, and written to the first again. The dose reaches
    // every tablet.
    await expect.poll(async () => (await recipe(saved!.id)).content.dose).toBe(18.5);
    for (const tablet of [one, two]) {
      await expect.poll(() => [variables(inSlot(tablet, "1")).dose, variables(inSlot(tablet, "1")).grind]).toEqual([18.5, 2.6]);
    }
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.5, grindSetting: 2.6, hotWaterTemperature: 85 });
    expect((await api.get<{ conflicts: unknown[] }>(`/recipes/${saved!.id}/conflicts`)).conflicts).toEqual([]);

    // The second tablet changes the grind setting again, to 2.7, so the first held 2.6 just before the server's latest write
    // of it. Saved again from that page with 2.8, another value than that, it is an edit as usual.
    await editInDye2(two, "1", { "dashboardVariables.grind": 2.7 });
    await expect.poll(() => variables(inSlot(one, "1")).grind).toBe(2.7);
    await saveInDye2(one, recipes.editSlot1, fromPage(2.8));
    for (const tablet of [one, two]) await expect.poll(() => variables(inSlot(tablet, "1")).grind).toBe(2.8);
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.5, grindSetting: 2.8 });
  });

  it("keeps another tablet's new Recipe in a slot from a save on a DYE2 recipe page opened on the slot's earlier recipe", async () => {
    const { here, machines, one, two } = await lab("Replaced", 42091);
    // The first tablet's recipe editor opens on slot 1 as saved.
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => inSlot(two, "1")?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    await expect.poll(() => inSlot(one, "1")?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    const [earlier] = await recipesAt(here);

    // Another app on the second tablet removes the recipe, taking it out of its slot, so it is removed from the first tablet
    // too; the second tablet then saves a new recipe in the slot, which the first is written in its place.
    await expect.poll(() => reportedSlots(machines[1])).toContain("1");
    const { [GLOBAL_ID_KEY]: _, [RECIPE_FIELD]: __, ...held } = inSlot(two, "1")!;
    const others = records(two, "recipes").filter((record) => record.id !== "1");
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, others)).status).toBe(200);
    await expect.poll(async () => (await recipe(earlier!.id)).slot).toBeNull();
    await expect.poll(() => inSlot(one, "1")).toBeUndefined();
    const brandNew = { ...held, name: "Brand new", dashboardVariables: { ...variables(held), dose: 20, grind: 3.3 } };
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, [...others, brandNew])).status).toBe(200);
    await expect.poll(async () => (await recipesAt(here)).find((candidate) => candidate.slot === 1)?.name).toBe("Brand new");
    const replacing = (await recipesAt(here)).find((candidate) => candidate.slot === 1)!;
    await expect.poll(() => inSlot(one, "1")?.[GLOBAL_ID_KEY]).toBe(replacing.id);

    // The first tablet's page, loaded on the earlier recipe, saves its barista's dose of 18.5: DYE2 saves its fields over the
    // record in the slot, which carries the new Recipe's global id. The fields it set back to the earlier recipe's are no
    // edit of the new one; only the dose is.
    await saveInDye2(one, recipes.editSlot1, (item) => ({ ...item, dashboardVariables: { ...variables(item), grind: 2.5, hotWaterTempC: 85 } }));
    await expect.poll(async () => (await recipe(replacing.id)).content.dose).toBe(18.5);
    expect((await recipe(replacing.id)).content).toMatchObject({ name: "Brand new", dose: 18.5, grindSetting: 3.3 });
    for (const tablet of [one, two]) {
      await expect.poll(() => [inSlot(tablet, "1")?.name, variables(inSlot(tablet, "1")).dose, variables(inSlot(tablet, "1")).grind]).toEqual([
        "Brand new",
        18.5,
        3.3,
      ]);
    }
    expect((await api.get<{ conflicts: unknown[] }>(`/recipes/${replacing.id}/conflicts`)).conflicts).toEqual([]);
    // The earlier recipe, out of its slot, is as it was.
    expect((await recipe(earlier!.id)).content).toMatchObject({ name: "Fixture Ethiopia Espresso", dose: 18, grindSetting: 2.5 });
  });

  it("keeps another tablet's change of a field a slot's new Recipe shares with its earlier recipe, saved from a page opened before it", async () => {
    const here = await api.createLocation("Shared lab", "America/Chicago");
    const machines = [await api.createMachine("Shared lab 1", here.id), await api.createMachine("Shared lab 2", here.id)] as const;
    // The first tablet holds slot 1 saved, and reads its lists once an hour (72 s here), so it reports them once in this
    // test, as it connects: what its recipes hold reaches the server in its answers to writes.
    const posted = recipes.saveSlot1.find(({ request }) => request.method === "POST")!.request.body as Record_[];
    const slot1 = posted.find((record) => record.id === "1")!;
    const one = load(machines[0], { ...recordedDye2Tablet("42101", "Shared"), [`/store/${DYE2_NAMESPACE}/recipes`]: [slot1] }, server, 3600);
    const two = load(machines[1], dye2NeverUsed("42102"), other);
    await api.waitForOnline(...machines);
    await expect.poll(() => inSlot(two, "1")?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    await expect.poll(() => inSlot(one, "1")?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));

    // Another app on the second tablet removes the recipe, and that tablet saves a new one in the slot, with the same hot
    // water temperature, which the first is written in its place.
    await expect.poll(() => reportedSlots(machines[1])).toContain("1");
    const { [GLOBAL_ID_KEY]: _, [RECIPE_FIELD]: __, ...held } = inSlot(two, "1")!;
    const others = records(two, "recipes").filter((record) => record.id !== "1");
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, others)).status).toBe(200);
    await expect.poll(() => inSlot(one, "1")).toBeUndefined();
    const brandNew = { ...held, name: "Shared new", dashboardVariables: { ...variables(held), grind: 3.3 } };
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, [...others, brandNew])).status).toBe(200);
    await expect.poll(() => inSlot(one, "1")?.name).toBe("Shared new");
    const replacing = (await recipesAt(here)).find((candidate) => candidate.slot === 1)!;
    expect(variables(inSlot(one, "1")).hotWaterTempC).toBe(85);

    // The first tablet's editor opens on it. Before that tablet reports again, the second changes its hot water temperature
    // to 88, which the first is written; the page then saves a dose of 19 with the 85 it loaded.
    await editInDye2(two, "1", { "dashboardVariables.hotWaterTempC": 88 });
    await expect.poll(() => variables(inSlot(one, "1")).hotWaterTempC).toBe(88);
    await editInDye2(one, "1", { "dashboardVariables.dose": 19, "dashboardVariables.hotWaterTempC": 85 });
    // The second tablet's next change, an RPM, is written to the first, whose answer shows the save.
    await editInDye2(two, "1", { "dashboardVariables.rpm": 950 });
    await expect.poll(async () => (await recipe(replacing.id)).content.dose).toBe(19);
    // The 85 it set back is no edit: the second tablet's 88 is kept, and written to the first again.
    for (const tablet of [one, two]) {
      await expect.poll(() => [variables(inSlot(tablet, "1")).dose, variables(inSlot(tablet, "1")).hotWaterTempC]).toEqual([19, 88]);
    }
    expect((await recipe(replacing.id)).content).toMatchObject({ name: "Shared new", dose: 19, hotWaterTemperature: 88, rpm: 950, grindSetting: 3.3 });
  });

  it("writes Recipes in slots 1, 3 and 7 in slot order, with no slot 2", async () => {
    const { here, one, two } = await lab("Ordered", 42031);
    await saveInDye2(one, recipes.saveSlot1);
    await saveInDye2(one, recipes.saveBlankSlot3, (item) => ({ ...item, id: "7", name: "Fixture Slot 7" }));
    await saveInDye2(one, recipes.saveBlankSlot3);
    await expect.poll(async () => (await recipesAt(here)).map(({ slot }) => slot)).toEqual([1, 3, 7]);
    for (const tablet of [two, one]) {
      await expect
        .poll(() => records(tablet, "recipes").map((record) => [record.id, record.name, typeof record[GLOBAL_ID_KEY]]))
        .toEqual([
          ["1", "Fixture Ethiopia Espresso", "string"],
          ["3", "Fixture Blank Recipe", "string"],
          ["7", "Fixture Slot 7", "string"],
        ]);
    }
  });

  it("gives a Recipe whose Bean is picked in DYE2 that Bean's batch most recently added at the Location", async () => {
    // The tablet's batches created well before the test runs, whatever day the recording was made.
    const tablet = recordedDye2Tablet("42041", "Picked");
    const brought = { ...tablet, "/bean-batches": (tablet["/bean-batches"] as Record_[]).map((batch) => ({ ...batch, createdAt: "2026-10-01T09:00:00.000000", updatedAt: "2026-10-01T09:00:00.000000" })) };
    const { here, one, two } = await lab("Picked", 42041, brought);
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(async () => (await recipesAt(here))[0]?.content.beanBatchId).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    const brazil = await localGlobal(here, "beans", "Picked Fixture Brazil");
    // A later roast of the Brazil is added at the lab, after the one the tablet brought.
    const created = await api.call("POST", "/bean-batches", { beanId: brazil, content: { roastDate: "2026-10-10" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const latest = ((await created.json()) as { batch: { id: string } }).batch.id;

    // DYE2's editor picks the Brazil for slot 1, by the tablet's id for it.
    await editInDye2(one, "1", { beanId: RECORDED.brazil, beanName: "Picked Fixture Brazil" });
    await expect.poll(async () => (await recipe(saved!.id)).content.beanId).toBe(brazil);
    expect((await recipe(saved!.id)).content.beanBatchId).toBe(latest);
    // Each tablet holds that batch in the record's own field, by its id for it, once it holds the batch.
    for (const tablet of [one, two]) {
      await expect.poll(() => localId(tablet, "/bean-batches", latest)).toEqual(expect.any(String));
      await expect.poll(async () => (inSlot(tablet, "1")?.[RECIPE_FIELD] as Record_ | undefined)?.beanBatchId).toBe(await localId(tablet, "/bean-batches", latest));
      await expect.poll(() => inSlot(tablet, "1")?.beanId).toBe(await localId(tablet, "/beans", brazil));
    }
  });

  it("writes a recipe's full Profile where the Profile is hidden, which applying it the DYE2 way and the Streamline way loads", async () => {
    const { here, one, two } = await lab("Hidden", 42051);
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => inSlot(two, "1")?.profileId).toBe(ADAPTIVE);
    // The lab hides the Recipe's Profile: the second tablet, which never had it, holds none.
    expect((await api.call("PUT", `/profiles/${encodeURIComponent(ADAPTIVE)}/locations/${here.id}`, { shown: false })).status).toBe(200);
    expect(asList((await two.callApi("GET", "/profiles?includeHidden=true")).body).map((profile) => profile.id)).not.toContain(ADAPTIVE);
    const stored = (await api.get<{ profile: { content: { profile: Record_ } } }>(`/profiles/${encodeURIComponent(ADAPTIVE)}`)).profile.content.profile;
    // At the recipe's brew temperature, slot 1's 92 °C, its steps moved by the same amount (ADR-0022, decentespresso/dye2#26).
    const library = profileAtBrewTemperature(stored, 92, null)!;
    expect(inSlot(two, "1")!.profileSnapshot).toEqual(library);
    expect((inSlot(two, "1")!.workflow as Record_).profile).toEqual(library);

    // Another Profile loaded, applying the recipe DYE2's way loads its own.
    const classic = (dye2Library()["/profiles"] as Record_[]).find((profile) => profile.id === CLASSIC)!.profile;
    expect((await two.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect((await (await openDye2Dashboard(two)).applyRecipe("1")).workflow.status).toBe(200);
    const loaded = async () => ((await two.callApi("GET", "/workflow")).body as { profile: Record_ }).profile;
    expect(await loaded()).toMatchObject({ title: "Adaptive v3", steps: library.steps });
    // And so does applying it Streamline's way.
    expect((await two.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect((await loaded()).title).toBe("Classic Italian espresso");
    expect((await (await startStreamline(two)).applyRecipe("1")).workflow.status).toBe(200);
    // Streamline sends a step limiter of 0 as none (`updateWorkflow` in streamline-js:src/modules/api.js).
    const sanitised = (library.steps as Record_[]).map((step) => ((step.limiter as Record_ | null)?.value === 0 ? { ...step, limiter: null } : step));
    expect(await loaded()).toMatchObject({ title: "Adaptive v3", steps: sanitised });
  });

  it("takes a Recipe gone from a tablet's list out of its slot at the Location, keeping it, and empties the slot on the other tablets", async () => {
    const { here, machines, one, two } = await lab("Removed", 42061);
    await saveInDye2(one, recipes.saveSlot2);
    await expect.poll(() => inSlot(two, "2")?.[GLOBAL_ID_KEY]).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    // Removed on the second tablet once a report has listed it there, as another app might: DYE2 cannot remove one.
    await expect.poll(() => reportedSlots(machines[1])).toContain("2");
    const list = records(two, "recipes").filter((record) => record.id !== "2");
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);

    await expect.poll(async () => (await recipe(saved!.id)).slot).toBeNull();
    expect(await recipesAt(here)).toEqual([expect.objectContaining({ id: saved!.id, slot: null, archived: false })]);
    await expect.poll(() => inSlot(one, "2")).toBeUndefined();
    expect(inSlot(two, "2")).toBeUndefined();
    const versions = (await api.get<{ versions: { fields: Record_; location: LocationView | null }[] }>(`/recipes/${saved!.id}/history`)).versions;
    expect(versions[0]).toMatchObject({ fields: { slot: null }, location: { name: "Removed lab" } });
  });

  it("writes nothing to a tablet's recipes whose ids are not slot numbers, and shows them in its sharing status", async () => {
    const here = await api.createLocation("Unrecognised lab", "America/Chicago");
    const machines = [await api.createMachine("Unrecognised lab 1", here.id), await api.createMachine("Unrecognised lab 2", here.id)] as const;
    const one = load(machines[0], recordedDye2Tablet("42071", "Unrecognised"));
    const odd = [{ id: "favourite-1", name: "Not a slot" }];
    const two = load(machines[1], { ...dye2NeverUsed("42072"), [`/store/${DYE2_NAMESPACE}/recipes`]: odd }, other);
    await api.waitForOnline(...machines);
    const status = async () =>
      (await api.get<{ status: { unrecognisedLists: { list: string }[] } }>(`/machines/${machines[1].machine.id}/sharing-status`)).status;
    await expect.poll(async () => (await status()).unrecognisedLists.map(({ list }) => list)).toEqual(["dye2Recipes"]);

    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(async () => (await recipesAt(here)).length).toBe(1);
    // Its other lists keep syncing: the basket the Recipe names reaches it, but its recipes stay as they were.
    await expect.poll(() => records(two, "baskets").length).toBe(2);
    expect(dye2List(two, "recipes")).toEqual(odd);
    expect(two.storeWrites.filter((write) => write.key === "recipes")).toEqual([]);
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

  /** The global id of the Library's item of that kind with that name (a Bean's by its name alone), offered at the Location. */
  async function localGlobal(location: LocationView, kind: "beans", name: string): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          const beans = (await api.get<{ beans: { id: string; name: string; offeredAt: LocationView[] }[] }>(`/${kind}`)).beans;
          id = beans.find((bean) => bean.name === name && bean.offeredAt.some((offered) => offered.id === location.id))?.id;
          return id;
        },
      )
      .toEqual(expect.any(String));
    return id!;
  }
});

function asList(value: unknown): Record_[] {
  return Array.isArray(value) ? (value as Record_[]) : [];
}
