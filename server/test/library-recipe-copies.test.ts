import { GLOBAL_ID_KEY, RECIPE_FIELD, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { dye2List } from "./support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #144: a Recipe copied to another
// Location is a new Recipe there, in the slot chosen, with a Grinder of that
// Location's, keeping its Bean Batch, added there, unless another is chosen,
// and its Profile, Basket and Tools shown there. That Location's tablets,
// through the built plugin in simulated tablets on two server instances
// sharing PostgreSQL, hold it by their own ids. Its history names the Recipe
// copied, which is not changed. Serials are made up, from 46001.

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

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Library and DYE2's lists empty. */
  function load(machine: CreatedMachine, serial: number, instance: TestServer): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: 5 },
      api: { ...derivedDe1Pro({ serial: String(serial) }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  /** A Location with a Machine whose tablet is online through each instance given. */
  async function locationWith(name: string, serial: number, instances: TestServer[]): Promise<{ location: LocationView; tablets: SimulatedTablet[] }> {
    const location = await api.createLocation(name, "America/Chicago");
    const loaded: SimulatedTablet[] = [];
    for (const [index, instance] of instances.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      loaded.push(load(machine, serial + index, instance));
      await api.waitForMachine(machine.machine.name, (viewed) => viewed.online);
    }
    return { location, tablets: loaded };
  }

  async function send<T>(method: string, path: string, body?: unknown, as: AdminApi = api, status = 200): Promise<T> {
    const response = await as.call(method, path, body);
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }
  const create = (location: LocationView, slot: number | null, content: Record_) =>
    send<{ recipe: RecipeView }>("POST", "/recipes", { locationId: location.id, slot, content }, api, 201).then((created) => created.recipe);
  const copy = (id: string, body: Record_, as: AdminApi = api) =>
    send<{ recipe: RecipeView }>("POST", `/recipes/${id}/copies`, body, as, 201).then((copied) => copied.recipe);
  const recipe = (id: string) => send<{ recipe: RecipeView }>("GET", `/recipes/${id}`).then((read) => read.recipe);
  const recipesAt = (location: LocationView) => send<{ recipes: RecipeView[] }>("GET", `/locations/${location.id}/recipes`).then((read) => read.recipes);
  const versions = async (id: string) => (await send<{ versions: VersionView[] }>("GET", `/recipes/${id}/history`)).versions;

  /** A batch, roasted on 2026-10-01, of a new Bean of that name, at each Location given. */
  async function batchAt(name: string, ...locations: LocationView[]) {
    const bean = (await send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name } }, api, 201)).bean;
    const batch = (
      await send<{ batch: { id: string } }>(
        "POST",
        "/bean-batches",
        { beanId: bean.id, content: { roastDate: "2026-10-01" }, locations: locations.map((location) => ({ locationId: location.id })) },
        api,
        201,
      )
    ).batch;
    return { bean, batch };
  }
  const grinderAt = async (location: LocationView, model: string) =>
    (await send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: location.id, content: { model } }, api, 201)).grinder;

  /** The tablet's recipe in a slot, if it holds one there. */
  const slotOn = (tablet: SimulatedTablet, slot: number): Record_ | undefined => {
    const list = dye2List(tablet, "recipes");
    return Array.isArray(list) ? (list as Record_[]).find((record) => record.id === String(slot)) : undefined;
  };
  /** The tablet's own id for its record of a Library item, by the global id the record carries. */
  const localId = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id || record[GLOBAL_ID_KEY] === id)?.id;
  const poll = <T>(read: () => T) => expect.poll(read, { timeout: 15_000 });

  async function staffAt(email: string, ...locations: LocationView[]): Promise<AdminApi> {
    const { link } = await api.invite(email, "staff", locations.map((location) => location.id));
    return AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Staff", password: "staff password 1" }));
  }

  it("copies a lab Recipe to a cafe's slot 1 with a cafe Grinder: the cafe's tablets hold it by their own ids, its batch added and its Profile, Basket and Tool shown there", async () => {
    const lab = await locationWith("Copied lab", 46001, [server]);
    const cafe = await locationWith("Copied cafe", 46002, [server, other]);
    const { bean, batch } = await batchAt("Copied Guji", lab.location);
    const labGrinder = await grinderAt(lab.location, "Copied EK43");
    const cafeGrinder = await grinderAt(cafe.location, "Copied EK43");
    const profile = await lab.tablets[0]!.addProfile(derivedProfile("Copied Bloom", 7.25));
    const profileId = String(profile.id);
    await poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(profileId)}`)).status).toBe(200);
    const basket = (await send<{ basket: { id: string } }>("POST", "/baskets", { locationId: lab.location.id, content: { name: "Copied 20g" } }, api, 201)).basket;
    const tool = (await send<{ tool: { id: string } }>("POST", "/tools", { locationId: lab.location.id, content: { name: "Copied WDT" } }, api, 201)).tool;

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
      hotWaterMode: "temp",
      hotWaterVolume: 120,
      hotWaterTemperature: 85,
      hotWaterDuration: 30,
      hotWaterFlow: 6,
    });
    await poll(() => slotOn(lab.tablets[0]!, 2)?.[GLOBAL_ID_KEY]).toBe(original.id);
    const originalHistory = await versions(original.id);
    const before = await create(cafe.location, 1, { name: "Cafe House" });
    for (const tablet of cafe.tablets) await poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(before.id);

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
    expect((await send<{ batch: { locations: { location: { id: string } }[] } }>("GET", `/bean-batches/${batch.id}`)).batch.locations.some(atCafe)).toBe(true);
    for (const path of [`/profiles/${encodeURIComponent(profileId)}`, `/baskets/${basket.id}`, `/tools/${tool.id}`]) {
      const read = Object.values(await send<Record<string, { shownAt: { location: { id: string } }[] }>>("GET", path))[0]!;
      expect(read.shownAt.some(atCafe), path).toBe(true);
    }

    // Each cafe tablet holds the copy in slot 1, naming its Grinder, batch, Basket and Tool by its own ids.
    for (const tablet of cafe.tablets) {
      await poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(copied.id);
      await poll(() => localId(tablet.grinders(), cafeGrinder.id)).toBeDefined();
      const toolId = String(localId(dye2List(tablet, "equipment") as Record_[], tool.id));
      expect(slotOn(tablet, 1)).toMatchObject({
        name: "Copied Espresso",
        beanId: localId(tablet.beans(), bean.id),
        profileId,
        dashboardVariables: {
          dose: 18,
          drink: 40,
          grind: 2.5,
          rpm: 1000,
          hotWaterMode: "temp",
          grinderId: localId(tablet.grinders(), cafeGrinder.id),
          basketId: localId(dye2List(tablet, "baskets") as Record_[], basket.id),
          equipmentIds: [toolId],
          equipmentCustom: { [toolId]: [{ key: "Needles", value: "10" }] },
        },
        [RECIPE_FIELD]: { beanBatchId: localId(tablet.batches(), batch.id), hotWaterData: { targetTemperature: 85, duration: 30, volume: 120, flow: 6 } },
      });
      expect(localId(tablet.grinders(), labGrinder.id)).toBeUndefined();
    }
    // The lab's tablet keeps the original in slot 2 alone.
    expect(slotOn(lab.tablets[0]!, 2)?.[GLOBAL_ID_KEY]).toBe(original.id);
    expect(slotOn(lab.tablets[0]!, 1)).toBeUndefined();

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
    expect(none.content).toEqual({ name: "Choices Espresso", dose: 18, steamMode: "flow", hotWaterMode: "vol", showOnDashboard: true });
    // The lab's batch, not chosen, was not added at the cafe.
    expect((await send<{ batch: { locations: { location: { id: string } }[] } }>("GET", `/bean-batches/${batch.id}`)).batch.locations.map((here) => here.location.id)).toEqual([
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
    expect((await recipesAt(cafe)).map((listed) => listed.id).sort()).toEqual([other_.id, none.id].sort());
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
    const sam = await staffAt("sam.copies@example.com", home);
    const theirs = await create(elsewhere, 1, { name: "Elsewhere Espresso" });

    const copied = await copy(theirs.id, { locationId: home.id, slot: 1, grinderId: null }, sam);
    expect(copied).toMatchObject({ location: { id: home.id }, slot: 1 });
    expect((await sam.call("POST", `/recipes/${copied.id}/copies`, { locationId: elsewhere.id, slot: 1, grinderId: null })).status).toBe(403);
    expect((await recipesAt(elsewhere)).map((listed) => [listed.id, listed.slot])).toEqual([[theirs.id, 1]]);
  });
});
