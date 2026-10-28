import { GLOBAL_ID_KEY, RECIPE_SLOT_FIELD, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { DYE2_NAMESPACE, dye2List } from "./support/simulated-dye2.js";
import { syncingTablet, emptyLibrary } from "./support/loaded-tablets.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #144: a Recipe copied to another
// Location is a new Recipe there, in the slot chosen, with a Grinder of that
// Location's, keeping its Bean Batch, added there, unless another is chosen,
// and its Profile, Basket and Tools shown there. That Location's tablets,
// through the built plugin in simulated tablets on two server instances
// sharing PostgreSQL, hold it by their own ids, under a record id of its own
// (ticket #216), the Recipe its slot took it from kept there in none. Its
// history names the Recipe copied, which is not changed. Serials are made
// up, from 46001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  name: string | null;
  location: LocationView | null;
  slot: number | null;
  archived: boolean;
  content: Record_;
  uses: {
    bean: { id: string } | null;
    beanBatch: { id: string; atLocation: boolean } | null;
    grinder: { id: string } | null;
  };
}

interface VersionView {
  fields: Record_;
  location: LocationView | null;
  source: { machine: unknown; account: { id: string } | null };
  copiedFrom: { id: string; name: string | null; location: LocationView | null } | null;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Recipes copied to a Location", { timeout: 90_000 }, () => {
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

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Library and DYE2's lists empty. */
  function load(machine: CreatedMachine, serial: number, instance: TestServer): SimulatedTablet {
    return syncingTablet(machine, instance, { api: emptyLibrary(serial) });
  }

  /** A Location with a Machine whose tablet is online through each instance given. */
  async function locationWith(name: string, serial: number, instances: TestServer[]): Promise<{ location: LocationView; tablets: SimulatedTablet[] }> {
    const location = await api.createLocation(name, "America/Chicago");
    const loaded: SimulatedTablet[] = [];
    for (const [index, instance] of instances.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      loaded.push(load(machine, serial + index, instance));
      await api.waitForOnline(machine);
    }
    return { location, tablets: loaded };
  }

  const create = (location: LocationView, slot: number | null, content: Record_) =>
    api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId: location.id, slot, content }, 201).then((created) => created.recipe);
  const copy = (id: string, body: Record_, as: AdminApi = api) =>
    as.send<{ recipe: RecipeView }>("POST", `/recipes/${id}/copies`, body, 201).then((copied) => copied.recipe);
  const recipe = (id: string) => api.get<{ recipe: RecipeView }>(`/recipes/${id}`).then((read) => read.recipe);
  const recipesAt = (location: LocationView) => api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`).then((read) => read.recipes);
  const versions = async (id: string) => (await api.get<{ versions: VersionView[] }>(`/recipes/${id}/history`)).versions;

  /** A batch, roasted on 2026-10-01, of a new Bean of that name, at each Location given. */
  async function batchAt(name: string, ...locations: LocationView[]) {
    const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name } }, 201)).bean;
    const locationIds = locations.map((location) => ({ locationId: location.id }));
    const batch = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean.id, content: { roastDate: "2026-10-01" }, locations: locationIds }, 201)).batch;
    return { bean, batch };
  }
  const grinderAt = async (location: LocationView, model: string) =>
    (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: location.id, content: { model } }, 201)).grinder;

  /** The tablet's recipe records, in its list's order. */
  const recordsOn = (tablet: SimulatedTablet): Record_[] => {
    const list = dye2List(tablet, "recipes");
    return Array.isArray(list) ? (list as Record_[]) : [];
  };
  /** The tablet's recipe in a slot, by its `stripSlot`, if it holds one there. */
  const slotOn = (tablet: SimulatedTablet, slot: number): Record_ | undefined => recordsOn(tablet).find((record) => record[RECIPE_SLOT_FIELD] === slot);
  /** The tablet's record of a Recipe, by the global id it carries. */
  const recordOf = (tablet: SimulatedTablet, recipeId: string): Record_ | undefined => recordsOn(tablet).find((record) => record[GLOBAL_ID_KEY] === recipeId);
  /** The tablet's own id for its record of a Library item, by the global id the record carries. */
  const localId = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id || record[GLOBAL_ID_KEY] === id)?.id;

  it("copies a lab Recipe to a cafe's slot 1 with a cafe Grinder: the cafe's tablets hold it by their own ids, its batch added and its Profile, Basket and Tool shown there", async () => {
    const lab = await locationWith("Copied lab", 46001, [server]);
    const cafe = await locationWith("Copied cafe", 46002, [server, other]);
    const { bean, batch } = await batchAt("Copied Guji", lab.location);
    const labGrinder = await grinderAt(lab.location, "Copied EK43");
    const cafeGrinder = await grinderAt(cafe.location, "Copied EK43");
    const profile = await lab.tablets[0]!.addProfile(derivedProfile("Copied Bloom", 7.25));
    const profileId = String(profile.id);
    await expect.poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(profileId)}`)).status).toBe(200);
    const basket = (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: lab.location.id, content: { name: "Copied 20g" } }, 201)).basket;
    const tool = (await api.send<{ tool: { id: string } }>("POST", "/tools", { locationId: lab.location.id, content: { name: "Copied WDT" } }, 201)).tool;

    const original = await create(lab.location, 2, {
      name: "Copied Espresso",
      beanBatchId: batch.id,
      profileId,
      dose: 18,
      yield: 40,
      grinderId: labGrinder.id,
      grindSetting: 2.5,
      rpm: 1000,
      basketId: basket.id,
      toolIds: [tool.id],
      toolAttributes: { [tool.id]: [{ key: "Needles", value: "10" }] },
      steamTemperature: 150,
      steamStopTemperature: 0,
      hotWaterVolume: 120,
      hotWaterTemperature: 85,
      hotWaterDuration: 30,
      hotWaterFlow: 6,
      flushDuration: 4,
    });
    await expect.poll(() => slotOn(lab.tablets[0]!, 2)?.[GLOBAL_ID_KEY]).toBe(original.id);
    const originalHistory = await versions(original.id);
    const before = await create(cafe.location, 1, { name: "Cafe House" });
    for (const tablet of cafe.tablets) await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(before.id);

    const copied = await copy(original.id, { locationId: cafe.location.id, slot: 1, grinderId: cafeGrinder.id });
    expect(copied.id).not.toBe(original.id);
    expect(copied).toMatchObject({ name: "Copied Espresso", location: { id: cafe.location.id }, slot: 1, archived: false });
    // Its content is the original's but for its Grinder, its grind setting kept as a starting point.
    expect(copied.content).toEqual({ ...original.content, grinderId: cafeGrinder.id });
    expect(copied.uses).toMatchObject({ bean: { id: bean.id }, beanBatch: { id: batch.id, atLocation: true }, grinder: { id: cafeGrinder.id } });
    // The Recipe that was in slot 1 is kept at the cafe in no slot.
    expect((await recipesAt(cafe.location)).map((listed) => [listed.name, listed.slot])).toEqual([
      ["Copied Espresso", 1],
      ["Cafe House", null],
    ]);

    // The batch is at the cafe now, and the Profile, Basket and Tool shown there.
    const atCafe = (here: { location: { id: string } }) => here.location.id === cafe.location.id;
    expect((await api.get<{ batch: { locations: { location: { id: string } }[] } }>(`/bean-batches/${batch.id}`)).batch.locations.some(atCafe)).toBe(true);
    for (const path of [`/profiles/${encodeURIComponent(profileId)}`, `/baskets/${basket.id}`, `/tools/${tool.id}`]) {
      const read = Object.values(await api.get<Record<string, { shownAt: { location: { id: string } }[] }>>(path))[0]!;
      expect(read.shownAt.some(atCafe), path).toBe(true);
    }

    // Each cafe tablet holds the copy in slot 1, naming its Grinder, batch, Basket and Tool by its own ids.
    for (const tablet of cafe.tablets) {
      await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(copied.id);
      await expect.poll(() => localId(tablet.grinders(), cafeGrinder.id)).toBeDefined();
      const toolId = String(localId(dye2List(tablet, "equipment") as Record_[], tool.id));
      expect(slotOn(tablet, 1)).toMatchObject({
        name: "Copied Espresso",
        beanId: localId(tablet.beans(), bean.id),
        beanBatchId: localId(tablet.batches(), batch.id),
        profileId,
        dashboardVariables: {
          dose: 18,
          drink: 40,
          grind: 2.5,
          rpm: 1000,
          steamTempC: 150,
          steamStopAtTempC: 0,
          hotWaterTempC: 85,
          hotWaterTimeS: 30,
          hotWaterMl: 120,
          hotWaterFlowMls: 6,
          flushS: 4,
          grinderId: localId(tablet.grinders(), cafeGrinder.id),
          basketId: localId(dye2List(tablet, "baskets") as Record_[], basket.id),
          equipmentIds: [toolId],
          equipmentCustom: { [toolId]: [{ key: "Needles", value: "10" }] },
        },
      });
      expect(localId(tablet.grinders(), labGrinder.id)).toBeUndefined();
      // The cafe's Recipe it took slot 1 from is still there, in no slot.
      await expect.poll(() => recordOf(tablet, before.id)?.[RECIPE_SLOT_FIELD]).toBeNull();
    }
    // The copy has a record id of its own, the same on both cafe tablets, which is neither the original's nor that of the
    // Recipe it took the slot from.
    const copyIds = cafe.tablets.map((tablet) => recordOf(tablet, copied.id)!.id);
    expect(copyIds[1]).toBe(copyIds[0]);
    expect(copyIds[0]).not.toBe(recordOf(lab.tablets[0]!, original.id)!.id);
    expect(copyIds[0]).not.toBe(recordOf(cafe.tablets[0]!, before.id)!.id);
    // The lab's tablet keeps the original in slot 2 alone.
    expect(slotOn(lab.tablets[0]!, 2)?.[GLOBAL_ID_KEY]).toBe(original.id);
    expect(recordsOn(lab.tablets[0]!).map((record) => record[GLOBAL_ID_KEY])).toEqual([original.id]);

    // The copy's history starts with it, naming the Recipe it was copied from and its Location.
    const history = await versions(copied.id);
    expect(history.map((version) => version.fields)).toEqual([{ slot: 1 }, expect.objectContaining({ name: "Copied Espresso", grinderId: cafeGrinder.id })]);
    expect(history[1]).toMatchObject({
      location: null,
      source: { machine: null, account: { id: expect.any(String) } },
      copiedFrom: { id: original.id, name: "Copied Espresso", location: { id: lab.location.id } },
    });
    expect(history[0]!.copiedFrom).toBeNull();
    // The original is not changed.
    expect(await recipe(original.id)).toEqual(original);
    expect(await versions(original.id)).toEqual(originalHistory);
    expect(originalHistory.every((version) => version.copiedFrom === null)).toBe(true);
  });

  it("keeps the Recipe's batch unless another at the Location, or none, is chosen, and refuses what the copy cannot use there", async () => {
    const lab = await api.createLocation("Copy choices lab", "America/Chicago");
    const cafe = await api.createLocation("Copy choices cafe", "America/Chicago");
    const { batch } = await batchAt("Copy choices Guji", lab);
    const { bean: cafeBean, batch: cafeBatch } = await batchAt("Copy choices Kenya", cafe);
    const labGrinder = await grinderAt(lab, "Copy choices EK43");
    const original = await create(lab, 1, { name: "Choices Espresso", beanBatchId: batch.id, grinderId: labGrinder.id, dose: 18 });

    // Another batch at the cafe, its Bean the copy's; and none, with no Grinder, in no slot.
    const other_ = await copy(original.id, { locationId: cafe.id, slot: "next", grinderId: null, beanBatchId: cafeBatch.id });
    expect(other_).toMatchObject({ slot: 1, content: { beanBatchId: cafeBatch.id, beanId: cafeBean.id, dose: 18 } });
    expect(other_.content).not.toHaveProperty("grinderId");
    const none = await copy(original.id, { locationId: cafe.id, grinderId: null, beanBatchId: null });
    expect(none.slot).toBeNull();
    // Copied through its id in upper case, its copy's history still names it.
    const upper = await copy(original.id.toUpperCase(), { locationId: cafe.id, grinderId: null, beanBatchId: null });
    expect((await versions(upper.id)).at(-1)!.copiedFrom).toMatchObject({ id: original.id, name: "Choices Espresso" });
    expect(none.content).toEqual({ name: "Choices Espresso", dose: 18, steamMode: "flow", hotWaterMode: "vol", showOnDashboard: true });
    // The lab's batch, not chosen, was not added at the cafe.
    expect((await api.get<{ batch: { locations: { location: { id: string } }[] } }>(`/bean-batches/${batch.id}`)).batch.locations.map((here) => here.location.id)).toEqual([
      lab.id,
    ]);

    const refusal = async (body: Record_, id = original.id) => (await api.call("POST", `/recipes/${id}/copies`, body)).status;
    // The lab's Grinder, a Grinder the Library does not have, and no Grinder chosen.
    expect(await refusal({ locationId: cafe.id, grinderId: labGrinder.id })).toBe(409);
    expect(await refusal({ locationId: cafe.id, grinderId: "00000000-0000-4000-8000-000000000000" })).toBe(400);
    expect(await refusal({ locationId: cafe.id })).toBe(400);
    // No such Location or Recipe, and a slot that is none.
    expect(await refusal({ locationId: "00000000-0000-4000-8000-000000000000", grinderId: null })).toBe(404);
    expect(await refusal({ locationId: cafe.id, grinderId: null }, "00000000-0000-4000-8000-000000000000")).toBe(404);
    expect(await refusal({ locationId: cafe.id, grinderId: null, slot: 0 })).toBe(400);
    // Its batch Archived since: kept, it is refused, but another may be chosen.
    expect((await api.call("PUT", `/bean-batches/${batch.id}/archived`, { archived: true })).status).toBe(200);
    expect(await refusal({ locationId: cafe.id, grinderId: null })).toBe(409);
    expect((await recipesAt(cafe)).map((listed) => listed.id).sort()).toEqual([other_.id, none.id, upper.id].sort());
  });

  it("offers a Bean the Recipe names with no batch at the Location, or takes its batch there, and copies only to another Location", async () => {
    const lab = await locationWith("Bean-only copy lab", 46010, [server]);
    const cafe = await locationWith("Bean-only copy cafe", 46011, [server]);
    const uptown = await api.createLocation("Bean-only copy Uptown", "America/Chicago");
    const labTablet = lab.tablets[0]!;
    const original = await create(lab.location, 1, { name: "Bean-only Espresso" });
    await expect.poll(() => slotOn(labTablet, 1)?.[GLOBAL_ID_KEY]).toBe(original.id);
    // A Bean added on the lab's tablet, with no batch anywhere, picked in DYE2's editor for the recipe in slot 1, once it has joined the Library.
    const added = await labTablet.addBean({ roaster: "Roux", name: "Bean-only copy Sidamo" });
    await expect.poll(() => globalIdOf(labTablet.beans().find((held) => held.id === added.id) ?? {})).toBeTruthy();
    const bean = { id: String(globalIdOf(labTablet.beans().find((held) => held.id === added.id)!)) };
    const list = recordsOn(labTablet).map((record) => (record[GLOBAL_ID_KEY] === original.id ? { ...record, beanId: added.id } : record));
    expect((await labTablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);
    await expect.poll(async () => (await recipe(original.id)).content.beanId).toBe(bean.id);
    const uptownBatch = (
      await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean.id, content: { roastDate: "2026-10-01" }, locations: [{ locationId: uptown.id }] }, 201)
    ).batch;
    const offeredAt = async () => (await api.get<{ bean: { offeredAt: { id: string }[] } }>(`/beans/${bean.id}`)).bean.offeredAt.map((at) => at.id);
    expect(await offeredAt()).toContain(lab.location.id);

    // At the cafe, with no batch of it, the Bean is offered, so the cafe's tablet names it by its own id.
    const atCafe = await copy(original.id, { locationId: cafe.location.id, slot: 1, grinderId: null });
    expect(atCafe.content).toMatchObject({ beanId: bean.id });
    expect(atCafe.content).not.toHaveProperty("beanBatchId");
    expect(await offeredAt()).toContain(cafe.location.id);
    const tablet = cafe.tablets[0]!;
    await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(atCafe.id);
    await expect.poll(() => slotOn(tablet, 1)?.beanId).toBe(localId(tablet.beans(), bean.id));
    expect(slotOn(tablet, 1)?.beanId).toBeDefined();
    // At Uptown, it takes the Bean's batch there.
    expect((await copy(original.id, { locationId: uptown.id, grinderId: null })).content).toMatchObject({ beanId: bean.id, beanBatchId: uptownBatch.id });

    // Not to its own Location, where the slot chosen could be its own.
    expect((await api.call("POST", `/recipes/${original.id}/copies`, { locationId: lab.location.id, slot: 1, grinderId: null })).status).toBe(400);
    expect(await recipe(original.id)).toMatchObject({ slot: 1, location: { id: lab.location.id } });
    expect((await recipesAt(lab.location)).map((listed) => listed.id)).toEqual([original.id]);
  });

  it("leaves out of the copy an item the Library no longer has, which a hard delete left the Recipe naming", async () => {
    const lab = await api.createLocation("Deleted copy lab", "America/Chicago");
    const cafe = await api.createLocation("Deleted copy cafe", "America/Chicago");
    const { bean, batch } = await batchAt("Deleted copy Guji", lab);
    const original = await create(lab, 1, { name: "Deleted Espresso", beanBatchId: batch.id, dose: 18 });
    expect((await api.call("DELETE", `/bean-batches/${batch.id}`)).status).toBe(204);
    expect((await recipe(original.id)).content).toMatchObject({ beanBatchId: batch.id });

    // Its batch is gone, so the copy keeps its Bean alone, offered at the cafe.
    const copied = await copy(original.id, { locationId: cafe.id, slot: 1, grinderId: null });
    expect(copied.content).toMatchObject({ name: "Deleted Espresso", beanId: bean.id, dose: 18 });
    expect(copied.content).not.toHaveProperty("beanBatchId");
  });

  it("puts one copy in a slot when two are copied into it at once through two instances", async () => {
    const lab = await api.createLocation("Raced copy lab", "America/Chicago");
    const cafe = await api.createLocation("Raced copy cafe", "America/Chicago");
    const original = await create(lab, 1, { name: "Raced Espresso" });
    const [first, second] = await Promise.all([
      copy(original.id, { locationId: cafe.id, slot: 3, grinderId: null }),
      copy(original.id, { locationId: cafe.id, slot: 3, grinderId: null }, api.at(other.url)),
    ]);
    const listed = await recipesAt(cafe);
    expect(listed.map((one) => one.slot)).toEqual([3, null]);
    expect([first.id, second.id].sort()).toEqual(listed.map((one) => one.id).sort());
  });

  it("lets Staff copy a Recipe from any Location only to the Locations they work at", async () => {
    const home = await api.createLocation("Staff copy home", "America/Chicago");
    const elsewhere = await api.createLocation("Staff copy elsewhere", "America/Chicago");
    const sam = await api.staffAt("sam.copies@example.com", home);
    const theirs = await create(elsewhere, 1, { name: "Elsewhere Espresso" });

    const copied = await copy(theirs.id, { locationId: home.id, slot: 1, grinderId: null }, sam);
    expect(copied).toMatchObject({ location: { id: home.id }, slot: 1 });
    expect((await sam.call("POST", `/recipes/${copied.id}/copies`, { locationId: elsewhere.id, slot: 1, grinderId: null })).status).toBe(403);
    expect((await recipesAt(elsewhere)).map((listed) => [listed.id, listed.slot])).toEqual([[theirs.id, 1]]);
  });
});
