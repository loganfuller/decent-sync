import { GLOBAL_ID_KEY, RECIPE_FIELD } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import {
  DYE2_NAMESPACE,
  type Dye2Key,
  applyInDye2,
  applyInStreamline,
  autoSaveInStreamline,
  dye2Keys,
  dye2Library,
  dye2List,
  dye2Recording,
  replayWrites,
  saveInDye2,
} from "./support/simulated-dye2.js";
import { type DecaidApi, SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #140: Recipes in their Recipe Slots, which DYE2 keeps in
// its `recipes` list in Decaid's store (ADR-0005), reach every tablet at
// their Location. A recipe saved in a slot on one tablet is written to that
// slot on the Location's other tablets, naming its Bean, Grinder, Basket and
// Tools by each tablet's own ids, and to no other Location's; edits merge per
// field with Conflicts (ADR-0020); a recipe gone from a tablet's list is taken
// out of its slot there (ADR-0019). And for ticket #142, a save from a DYE2
// page opened before another tablet's change keeps that change (ADR-0005).
// Through the built plugin in simulated tablets, acting as DYE2 v0.1.19 and
// Streamline v0.2.13 do with the steps recorded from them
// (fixtures/decaid/dye2-v0.1.19/), on two server instances sharing one
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

/** The recording's tablet's ids for what its recipes name (fixtures/decaid/dye2-v0.1.19/library.json, keys.json). */
const RECORDED = {
  brazil: "6b16db38-425e-48ec-93b7-e03e1d8707cd",
  ethiopia: "8ee8ac01-bf2b-47d6-b4e2-292bd7ef5ada",
  brazilBatch: "086d9a50-63c5-4add-837b-738c88897849",
  ethiopiaBatch: "b850e4f2-89cf-400f-9d43-ec1080ad595b",
  grinder: "f9e3cee6-4fd0-4843-a959-b263b4e4411a",
  basket18: "5a792f42-b6ff-44e0-a58c-ed165741b789",
  basket20: "1749fba2-86b3-43e2-badf-97af64ae888b",
  wdtTool: "f204e0d6-cfa8-4fd9-9316-de2e6f0ae8e6",
  puckScreen: "57f7f897-1ecf-4f31-90f8-5f1363d8dfc2",
} as const;

/** Decaid's bundled Profiles the recorded recipes use. */
const ADAPTIVE = "profile:98fa00c191551b435845";
const CLASSIC = "profile:39e939592679fb194706";

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Recipes in their slots reach every tablet at their Location", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  /** A DE1Pro's Decaid with an empty library, and DYE2's keys never written, as on a tablet where DYE2 was never used. */
  function emptyDecaid(serial: string): DecaidApi {
    const decaidApi: DecaidApi = { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };
    for (const key of ["recipes", "baskets", "equipment"] as const) delete decaidApi[`/store/${DYE2_NAMESPACE}/${key}`];
    return decaidApi;
  }

  /**
   * The recording's tablet: its beans, their batches, its grinder and the
   * bundled profiles its recipes use, and DYE2's baskets and tools as the
   * recording left them, but no recipes. The beans are named as the test's
   * own, as Beans are matched by roaster and name across the file's tests.
   */
  function recordedDecaid(serial: string, scenario: string): DecaidApi {
    const library = dye2Library();
    const keys = dye2Keys();
    const decaidApi: DecaidApi = {
      ...emptyDecaid(serial),
      ...library,
      "/beans": (library["/beans"] as Record_[]).map((bean) => ({ ...bean, name: `${scenario} ${String(bean.name)}` })),
      [`/store/${DYE2_NAMESPACE}/baskets`]: keys.baskets,
      [`/store/${DYE2_NAMESPACE}/equipment`]: keys.equipment,
    };
    return decaidApi;
  }

  /** The built plugin on a tablet of the Machine, connected to an instance, polling every 5 s (0.1 s here). */
  function load(machine: CreatedMachine, decaidApi: DecaidApi, instance: TestServer = server): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: 5 },
      api: decaidApi,
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  /** A Location with two Machines, the first's tablet the recording's, on one instance, the second's empty, on the other, and a cafe with an empty tablet. */
  async function lab(scenario: string, serials: number) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const cafe = await api.createLocation(`${scenario} cafe`, "America/Chicago");
    const machines = [
      await api.createMachine(`${scenario} lab 1`, here.id),
      await api.createMachine(`${scenario} lab 2`, here.id),
      await api.createMachine(`${scenario} cafe 1`, cafe.id),
    ] as const;
    const one = load(machines[0], recordedDecaid(String(serials), scenario));
    const two = load(machines[1], emptyDecaid(String(serials + 1)), other);
    const cafeTablet = load(machines[2], emptyDecaid(String(serials + 2)));
    await online(...machines);
    return { here, cafe, machines, one, two, cafeTablet };
  }

  const recipesAt = async (location: LocationView) =>
    ((await (await api.call("GET", `/locations/${location.id}/recipes`)).json()) as { recipes: RecipeView[] }).recipes;
  const recipe = async (id: string) => ((await (await api.call("GET", `/recipes/${id}`)).json()) as { recipe: RecipeView }).recipe;
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
    (((await (await api.call("GET", `/machines/${machine.machine.id}/collections/dye2Recipes`)).json()) as { collection: { value: Record_[] } | null }).collection?.value ?? []).map(
      (record) => record.id,
    );

  const recipes = dye2Recording("recipes");
  const streamline = dye2Recording("streamline");

  it("writes a recipe saved in DYE2 in slot 2 to slot 2 on the Location's other tablets, under their own ids, and to no other Location's", async () => {
    const { here, cafe, one, two, cafeTablet } = await lab("Saved", 42001);

    await saveInDye2(one, recipes.saveSlot2);
    await expect.poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot]), { timeout: 15_000 }).toEqual([["Fixture Brazil Espresso", 2]]);
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
        brewTemperature: 93,
        showOnDashboard: true,
        steamMode: "flow",
        hotWaterMode: "vol",
        hotWaterVolume: 150,
      }),
    );
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
    await expect.poll(async () => (await Promise.all(Object.values(ids).map((id) => id()))).every((id) => id !== undefined), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => inSlot(two, "2"), { timeout: 15_000 }).toMatchObject({
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
    await expect.poll(() => inSlot(one, "2")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toBe(saved!.id);
    expect(dye2List(cafeTablet, "recipes")).toBeNull();
    expect(cafeTablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "recipes")).toEqual([]);
  });

  it("keeps edits of different fields on two tablets, keeps two edits of one field made without seeing each other as a Conflict, and never shares a barista", async () => {
    const { here, machines, one, two } = await lab("Edited", 42011);
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => inSlot(two, "1")?.name, { timeout: 15_000 }).toBe("Fixture Ethiopia Espresso");
    const [saved] = await recipesAt(here);
    // The barista and drinker saved with it are written back blank, and reach no other tablet nor the Recipe.
    await expect.poll(() => [inSlot(one, "1")?.barista, inSlot(one, "1")?.drinker], { timeout: 15_000 }).toEqual(["", ""]);
    expect([inSlot(two, "1")!.barista, inSlot(two, "1")!.drinker]).toEqual(["", ""]);
    expect((inSlot(two, "1")!.workflow as { context: Record_ }).context).not.toHaveProperty("baristaName");
    expect(saved!.content).not.toHaveProperty("barista");
    expect(saved!.content).not.toHaveProperty("drinker");

    // Each tablet changes another field, each from the record it holds: both survive, everywhere.
    await editInDye2(one, "1", { "dashboardVariables.dose": 18.2 });
    await editInDye2(two, "1", { "dashboardVariables.grind": 2.6 });
    for (const tablet of [one, two]) {
      await expect.poll(() => [variables(inSlot(tablet, "1")).dose, variables(inSlot(tablet, "1")).grind], { timeout: 15_000 }).toEqual([18.2, 2.6]);
    }
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.2, grindSetting: 2.6 });

    // Offline, the second tablet misses the first's dose of 18.4, then sets 18.6. Neither saw the other's.
    two.loseNetwork();
    await api.waitForMachine(machines[1].machine.name, (viewed) => !viewed.online, 15_000);
    await editInDye2(one, "1", { "dashboardVariables.dose": 18.4 });
    await expect.poll(async () => (await recipe(saved!.id)).content.dose, { timeout: 15_000 }).toBe(18.4);
    await editInDye2(two, "1", { "dashboardVariables.dose": 18.6 });
    // Back online, its edit, made and read after the other's, wins, and the other's value is kept as a Conflict.
    two.restoreNetwork();
    for (const tablet of [one, two]) await expect.poll(() => variables(inSlot(tablet, "1")).dose, { timeout: 15_000 }).toBe(18.6);
    const conflicts = ((await (await api.call("GET", `/recipes/${saved!.id}/conflicts`)).json()) as { conflicts: { field: string; value: unknown; item: Record_ }[] }).conflicts;
    expect(conflicts).toEqual([expect.objectContaining({ field: "dose", value: 18.4, item: { kind: "recipe", id: saved!.id, name: "Fixture Ethiopia Espresso" } })]);
    // Its history holds each accepted edit, the first its joining the Library from the tablet that saved it.
    const versions = ((await (await api.call("GET", `/recipes/${saved!.id}/history`)).json()) as { versions: { fields: Record_; source: { machine: { name: string } | null } }[] }).versions;
    expect(versions.at(-1)).toMatchObject({ fields: { name: "Fixture Ethiopia Espresso", dose: 18 }, source: { machine: { name: "Edited lab 1" } } });
  });

  it("keeps another tablet's change of a recipe saved from a DYE2 recipe page opened before it, and spreads what the save changed", async () => {
    const { here, one, two } = await lab("Stale", 42081);
    // The first tablet's recipe editor opens on slot 1 as saved: the values the recorded edit of it was made from.
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => inSlot(two, "1")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toEqual(expect.any(String));
    await expect.poll(() => inSlot(one, "1")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    expect(saved!.content).toMatchObject({ dose: 18, grindSetting: 2.5, hotWaterTemperature: 85 });

    // The second tablet changes the grind setting from 2.5 to 2.6, which the first is written.
    await editInDye2(two, "1", { "dashboardVariables.grind": 2.6 });
    await expect.poll(() => variables(inSlot(one, "1")).grind, { timeout: 15_000 }).toBe(2.6);

    // The first tablet's page, loaded before that, saves its barista's dose of 18.5: the recorded editor save, but with the
    // grind setting and hot water temperature the page loaded rather than those the recording changed.
    const fromPage = (grind: number) => (item: Record_) => ({ ...item, dashboardVariables: { ...variables(item), grind, hotWaterTempC: 85 } });
    await saveInDye2(one, recipes.editSlot1, fromPage(2.5));
    // The grind setting it set back is no edit: the second tablet's is kept, and written to the first again. The dose reaches
    // every tablet.
    await expect.poll(async () => (await recipe(saved!.id)).content.dose, { timeout: 15_000 }).toBe(18.5);
    for (const tablet of [one, two]) {
      await expect.poll(() => [variables(inSlot(tablet, "1")).dose, variables(inSlot(tablet, "1")).grind], { timeout: 15_000 }).toEqual([18.5, 2.6]);
    }
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.5, grindSetting: 2.6, hotWaterTemperature: 85 });
    expect(((await (await api.call("GET", `/recipes/${saved!.id}/conflicts`)).json()) as { conflicts: unknown[] }).conflicts).toEqual([]);

    // The second tablet changes the grind setting again, to 2.7, so the first held 2.6 just before the server's latest write
    // of it. Saved again from that page with 2.8, another value than that, it is an edit as usual.
    await editInDye2(two, "1", { "dashboardVariables.grind": 2.7 });
    await expect.poll(() => variables(inSlot(one, "1")).grind, { timeout: 15_000 }).toBe(2.7);
    await saveInDye2(one, recipes.editSlot1, fromPage(2.8));
    for (const tablet of [one, two]) await expect.poll(() => variables(inSlot(tablet, "1")).grind, { timeout: 15_000 }).toBe(2.8);
    expect((await recipe(saved!.id)).content).toMatchObject({ dose: 18.5, grindSetting: 2.8 });
  });

  it("takes a Streamline auto-save into a recipe in, and writes it to every tablet at the Location", async () => {
    const { here, one, two } = await lab("Autosaved", 42021);
    await saveInDye2(one, recipes.saveSlot2);
    await expect.poll(() => inSlot(two, "2")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toEqual(expect.any(String));
    await expect.poll(() => inSlot(one, "2")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toEqual(expect.any(String));

    // Streamline's DYE strip applies slot 2, then saves the barista's dose change into it: 19 g to 20 g, with the
    // Profile's first step's temperature as its brew temperature.
    await replayWrites(one, streamline.applySlot2);
    expect(await autoSaveInStreamline(one, streamline.autoSaveDose)).toBeDefined();
    expect(variables(inSlot(one, "2")).dose).toBe(20);
    await expect.poll(async () => (await recipesAt(here))[0]?.content.dose, { timeout: 15_000 }).toBe(20);
    expect((await recipesAt(here))[0]!.content).toMatchObject({ dose: 20, brewTemperature: 94 });
    await expect.poll(() => variables(inSlot(two, "2")).dose, { timeout: 15_000 }).toBe(20);
    // Streamline leaves the embedded Workflow as it was: the server regenerates it, on every tablet.
    for (const tablet of [one, two]) {
      await expect.poll(() => (inSlot(tablet, "2")?.workflow as { context: Record_ } | undefined)?.context.targetDoseWeight, { timeout: 15_000 }).toBe(20);
    }
  });

  it("writes Recipes in slots 1, 3 and 7 in slot order, with no slot 2", async () => {
    const { here, one, two } = await lab("Ordered", 42031);
    await saveInDye2(one, recipes.saveSlot1);
    await saveInDye2(one, recipes.saveBlankSlot3, (item) => ({ ...item, id: "7", name: "Fixture Slot 7" }));
    await saveInDye2(one, recipes.saveBlankSlot3);
    await expect.poll(async () => (await recipesAt(here)).map(({ slot }) => slot), { timeout: 15_000 }).toEqual([1, 3, 7]);
    for (const tablet of [two, one]) {
      await expect
        .poll(() => records(tablet, "recipes").map((record) => [record.id, record.name, typeof record[GLOBAL_ID_KEY]]), { timeout: 15_000 })
        .toEqual([
          ["1", "Fixture Ethiopia Espresso", "string"],
          ["3", "Fixture Blank Recipe", "string"],
          ["7", "Fixture Slot 7", "string"],
        ]);
    }
  });

  it("gives a Recipe whose Bean is picked in DYE2 that Bean's batch most recently added at the Location", async () => {
    const { here, one, two } = await lab("Picked", 42041);
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(async () => (await recipesAt(here))[0]?.content.beanBatchId, { timeout: 15_000 }).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    const brazil = await localGlobal(here, "beans", "Picked Fixture Brazil");
    // A later roast of the Brazil is added at the lab, after the one the tablet brought.
    const created = await api.call("POST", "/bean-batches", { beanId: brazil, content: { roastDate: "2026-10-10" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const latest = ((await created.json()) as { batch: { id: string } }).batch.id;

    // DYE2's editor picks the Brazil for slot 1, by the tablet's id for it.
    await editInDye2(one, "1", { beanId: RECORDED.brazil, beanName: "Picked Fixture Brazil" });
    await expect.poll(async () => (await recipe(saved!.id)).content.beanId, { timeout: 15_000 }).toBe(brazil);
    expect((await recipe(saved!.id)).content.beanBatchId).toBe(latest);
    // Each tablet holds that batch in the record's own field, by its id for it, once it holds the batch.
    for (const tablet of [one, two]) {
      await expect.poll(() => localId(tablet, "/bean-batches", latest), { timeout: 15_000 }).toEqual(expect.any(String));
      await expect.poll(async () => (inSlot(tablet, "1")?.[RECIPE_FIELD] as Record_ | undefined)?.beanBatchId, { timeout: 15_000 }).toBe(await localId(tablet, "/bean-batches", latest));
      await expect.poll(() => inSlot(tablet, "1")?.beanId, { timeout: 15_000 }).toBe(await localId(tablet, "/beans", brazil));
    }
  });

  it("writes a recipe's full Profile where the Profile is hidden, which applying it the DYE2 way and the Streamline way loads", async () => {
    const { here, one, two } = await lab("Hidden", 42051);
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => inSlot(two, "1")?.profileId, { timeout: 15_000 }).toBe(ADAPTIVE);
    // The lab hides the Recipe's Profile: the second tablet, which never had it, holds none.
    expect((await api.call("PUT", `/profiles/${encodeURIComponent(ADAPTIVE)}/locations/${here.id}`, { shown: false })).status).toBe(200);
    expect(asList((await two.callApi("GET", "/profiles?includeHidden=true")).body).map((profile) => profile.id)).not.toContain(ADAPTIVE);
    const library = ((await (await api.call("GET", `/profiles/${encodeURIComponent(ADAPTIVE)}`)).json()) as { profile: { content: { profile: Record_ } } }).profile.content.profile;
    expect(inSlot(two, "1")!.profileSnapshot).toEqual(library);
    expect((inSlot(two, "1")!.workflow as Record_).profile).toEqual(library);

    // Another Profile loaded, applying the recipe DYE2's way loads its own.
    const classic = (dye2Library()["/profiles"] as Record_[]).find((profile) => profile.id === CLASSIC)!.profile;
    expect((await two.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect((await applyInDye2(two, "1")).status).toBe(200);
    const loaded = async () => ((await two.callApi("GET", "/workflow")).body as { profile: Record_ }).profile;
    expect(await loaded()).toMatchObject({ title: "Adaptive v3", steps: library.steps });
    // And so does applying it Streamline's way.
    expect((await two.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    expect((await loaded()).title).toBe("Classic Italian espresso");
    expect((await applyInStreamline(two, "1")).status).toBe(200);
    expect(await loaded()).toMatchObject({ title: "Adaptive v3", steps: library.steps });
  });

  it("takes a Recipe gone from a tablet's list out of its slot at the Location, keeping it, and empties the slot on the other tablets", async () => {
    const { here, machines, one, two } = await lab("Removed", 42061);
    await saveInDye2(one, recipes.saveSlot2);
    await expect.poll(() => inSlot(two, "2")?.[GLOBAL_ID_KEY], { timeout: 15_000 }).toEqual(expect.any(String));
    const [saved] = await recipesAt(here);
    // Removed on the second tablet once a report has listed it there, as another app might: DYE2 cannot remove one.
    await expect.poll(() => reportedSlots(machines[1]), { timeout: 15_000 }).toContain("2");
    const list = records(two, "recipes").filter((record) => record.id !== "2");
    expect((await two.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);

    await expect.poll(async () => (await recipe(saved!.id)).slot, { timeout: 15_000 }).toBeNull();
    expect(await recipesAt(here)).toEqual([expect.objectContaining({ id: saved!.id, slot: null, archived: false })]);
    await expect.poll(() => inSlot(one, "2"), { timeout: 15_000 }).toBeUndefined();
    expect(inSlot(two, "2")).toBeUndefined();
    const versions = ((await (await api.call("GET", `/recipes/${saved!.id}/history`)).json()) as { versions: { fields: Record_; location: LocationView | null }[] }).versions;
    expect(versions[0]).toMatchObject({ fields: { slot: null }, location: { name: "Removed lab" } });
  });

  it("writes nothing to a tablet's recipes whose ids are not slot numbers, and shows them in its sharing status", async () => {
    const here = await api.createLocation("Unrecognised lab", "America/Chicago");
    const machines = [await api.createMachine("Unrecognised lab 1", here.id), await api.createMachine("Unrecognised lab 2", here.id)] as const;
    const one = load(machines[0], recordedDecaid("42071", "Unrecognised"));
    const odd = [{ id: "favourite-1", name: "Not a slot" }];
    const two = load(machines[1], { ...emptyDecaid("42072"), [`/store/${DYE2_NAMESPACE}/recipes`]: odd }, other);
    await online(...machines);
    const status = async () =>
      ((await (await api.call("GET", `/machines/${machines[1].machine.id}/sharing-status`)).json()) as { status: { unrecognisedLists: { list: string }[] } }).status;
    await expect.poll(async () => (await status()).unrecognisedLists.map(({ list }) => list), { timeout: 15_000 }).toEqual(["dye2Recipes"]);

    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(async () => (await recipesAt(here)).length, { timeout: 15_000 }).toBe(1);
    // Its other lists keep syncing: the basket the Recipe names reaches it, but its recipes stay as they were.
    await expect.poll(() => records(two, "baskets").length, { timeout: 15_000 }).toBe(2);
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
          const beans = ((await (await api.call("GET", `/${kind}`)).json()) as { beans: { id: string; name: string; offeredAt: LocationView[] }[] }).beans;
          id = beans.find((bean) => bean.name === name && bean.offeredAt.some((offered) => offered.id === location.id))?.id;
          return id;
        },
        { timeout: 15_000 },
      )
      .toEqual(expect.any(String));
    return id!;
  }
});

function asList(value: unknown): Record_[] {
  return Array.isArray(value) ? (value as Record_[]) : [];
}
