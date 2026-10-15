import { LOADED_RECIPE_KEY, RECIPE_FIELD, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets } from "./support/loaded-tablets.js";
import {
  DYE2_NAMESPACE,
  applyInDye2,
  applyInStreamline,
  autoSaveInStreamline,
  dye2Library,
  dye2List,
  dye2Recording,
  recordedDye2Tablet,
  replayWrites,
  saveInDye2,
} from "./support/simulated-dye2.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #145: each Machine's Loaded Recipe (ADR-0022). Applying
// a recipe on a tablet, the DYE2 way or the Streamline way, or from a stale
// copy, loads it: the plugin works out which Recipe the Workflow matches and
// writes into the Workflow the Recipe's current values, its Bean Batch, all
// four hot water settings and its global id, and the server reads the
// Loaded Recipe from the Workflow it delivers, a load made offline
// included. Changing the profile or grinder unloads it. Through the built
// plugin in simulated tablets, acting as DYE2 v0.1.19 and Streamline do with
// the steps recorded from them (fixtures/decaid/dye2-v0.1.19/), on two server
// instances sharing one database, with assertions through the REST API and
// what each simulated tablet holds. Serials are made up, from 47001.

type Record_ = Record<string, unknown>;

interface LoadedView {
  id: string;
  recipe: { id: string; name: string | null; slot: number | null; locationId: string | null; archived: boolean };
  loadedAt: string;
  unloadedAt: string | null;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** All four hot water settings each test's Recipe is given in the management interface, apart from any tablet's own. */
const HOT_WATER = { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 };

describe("Each Machine's Loaded Recipe", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets = new LoadedTablets();

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await other?.stop();
    await server?.stop();
  });

  const recipes = dye2Recording("recipes");
  const applies = dye2Recording("dye2-applies");
  const strip = dye2Recording("streamline");

  const inSlot = (tablet: SimulatedTablet, slot: string) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []).find((record) => record.id === slot);
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const extras = (tablet: SimulatedTablet) => (context(tablet).extras ?? {}) as Record_;
  /** The Recipe id the tablet's Workflow names as loaded, or null. */
  const named = (tablet: SimulatedTablet) => extras(tablet)[LOADED_RECIPE_KEY] ?? null;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: LoadedView | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe;
  const history = async ({ machine }: CreatedMachine) =>
    (await (await api.call("GET", `/machines/${machine.id}/loaded-recipes`)).json()) as { entries: LoadedView[]; total: number };
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) =>
    expect.poll(async () => (await loadedRecipe(machine))?.recipe.id ?? null, { timeout: 15_000 }).toBe(recipeId);

  /**
   * A Location with a Machine whose tablet is the recording's, on the
   * instance given, holding slots 1 and 2 as DYE2's editor saved and edited them, each
   * written back with its Recipe's id, and slot 1's Recipe given all four
   * hot water settings (`HOT_WATER`) in the management interface.
   */
  async function lab(scenario: string, serial: number, instance: TestServer = server, apiDelayMs?: (method: string, path: string) => number) {
    const here: LocationView = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machine = await api.createMachine(`${scenario} lab 1`, here.id);
    const tablet = tablets.syncing(machine, instance, { api: recordedDye2Tablet(String(serial), scenario), apiDelayMs });
    await api.waitForOnline(machine);
    await saveInDye2(tablet, recipes.saveSlot1);
    await saveInDye2(tablet, recipes.saveSlot2);
    await saveInDye2(tablet, recipes.editSlot1);
    await expect.poll(() => ["1", "2"].map((slot) => dye2GlobalIdOf(inSlot(tablet, slot))), { timeout: 15_000 }).not.toContain(null);
    const listed = (await api.get<{ recipes: { id: string; slot: number | null }[] }>(`/locations/${here.id}/recipes`)).recipes;
    const [one, two] = [1, 2].map((slot) => listed.find((recipe) => recipe.slot === slot)!.id) as [string, string];
    const edit = async (recipeId: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${recipeId}`, { content })).status).toBe(200);
    await edit(one, { hotWaterVolume: HOT_WATER.volume, hotWaterTemperature: HOT_WATER.targetTemperature, hotWaterDuration: HOT_WATER.duration, hotWaterFlow: HOT_WATER.flow });
    await expect.poll(() => (inSlot(tablet, "1")?.[RECIPE_FIELD] as Record_ | undefined)?.hotWaterData, { timeout: 15_000 }).toEqual(HOT_WATER);
    return { here, machine, tablet, one, two, edit };
  }

  it("loads a recipe applied the DYE2 way, with its Bean Batch, all four hot water settings and its id written into the Workflow", async () => {
    const { machine, tablet, one } = await lab("Dashboard", 47001);
    const batch = (inSlot(tablet, "1")![RECIPE_FIELD] as Record_).beanBatchId;
    expect(batch).toEqual(expect.any(String));
    expect(await loadedRecipe(machine)).toBeNull();

    // DYE2's dashboard applying slot 1, as recorded: its profile, dose, yield, grinder and grind setting.
    for (const answer of await replayWrites(tablet, applies.applySlot1)) expect(answer.status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(one);
    expect(context(tablet)).toMatchObject({ beanBatchId: batch, coffeeName: "Dashboard Fixture Ethiopia", coffeeRoaster: "Fixture Roasters" });
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
    expect(extras(tablet)).toMatchObject({ basketId: (inSlot(tablet, "1")!.dashboardVariables as Record_).basketId });
    await loads(machine, one);
    expect(await history(machine)).toMatchObject({ total: 1, entries: [{ recipe: { id: one, slot: 1, archived: false }, unloadedAt: null }] });
  });

  it("loads a recipe applied the Streamline way on a tablet on the other instance, and Streamline takes its hot water as its own", async () => {
    const { machine, tablet, one } = await lab("Strip", 47011, other);
    const before = tablet.workflow().hotWaterData as Record_;
    const streamline = await startStreamline(tablet, { "last-hot-water-volume": before.volume as number, "last-hot-water-temp": before.targetTemperature as number });

    expect((await applyInStreamline(tablet, "1")).status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(one);
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
    await loads(machine, one);
    await streamline.settled();
    expect(streamline.remembered("last-hot-water-volume")).toBe(HOT_WATER.volume);
    expect(streamline.remembered("last-hot-water-temp")).toBe(HOT_WATER.targetTemperature);
    expect(streamline.pushes).toEqual([]);
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);

    // Once a Shot is stored, Streamline clears the batch, grinder, Basket and RPM: the Recipe stays loaded.
    const batch = context(tablet).beanBatchId;
    await streamline.shotStored();
    await expect.poll(async () => (await (await api.call("GET", `/machines/${machine.machine.id}/workflow`)).json()) as { workflow: { workflow: Record_ } }, { timeout: 15_000 }).toMatchObject({
      workflow: { workflow: { context: { extras: { rpm: null } } } },
    });
    expect(context(tablet).beanBatchId).toBeUndefined();
    expect(named(tablet)).toBe(one);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);
    // Applied again, the Recipe's batch is written back, its Basket and RPM with it.
    expect((await applyInStreamline(tablet, "1")).status).toBe(200);
    await expect.poll(() => context(tablet).beanBatchId, { timeout: 15_000 }).toBe(batch);
    expect(extras(tablet)).toMatchObject({ rpm: 900, basketId: (inSlot(tablet, "1")!.dashboardVariables as Record_).basketId });
    expect(named(tablet)).toBe(one);
  });

  it("loads a recipe applied from a copy read before its dial changed, and writes its current values", async () => {
    const { machine, tablet, one, edit } = await lab("Stale", 47021);
    // DYE2's dashboard reads its recipes once, as it opens.
    const copy = structuredClone(inSlot(tablet, "1")!);
    await edit(one, { dose: 19.5, grindSetting: 2.9 });
    await expect.poll(() => (inSlot(tablet, "1")?.dashboardVariables as Record_ | undefined)?.dose, { timeout: 15_000 }).toBe(19.5);

    expect((await applyInDye2(tablet, "1", copy)).status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(one);
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 19.5, grinderSetting: "2.9" });
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
    await loads(machine, one);
  });

  it("unloads a Recipe as the Workflow's profile or grinder changes, and keeps when it was loaded and unloaded", async () => {
    const { machine, tablet, one } = await lab("Unloaded", 47031);
    const classic = (dye2Library()["/profiles"] as { profile: Record_ }[]).find((record) => record.profile.title === "Classic Italian espresso")!.profile;

    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);
    // A tweak of the grind keeps it loaded.
    await tablet.changeSettings({ context: { grinderSetting: "2.8" } });
    await expect.poll(async () => (await (await api.call("GET", `/machines/${machine.machine.id}/workflow`)).json()) as { workflow: { workflow: Record_ } }, { timeout: 15_000 }).toMatchObject({
      workflow: { workflow: { context: { grinderSetting: "2.8" } } },
    });
    expect(named(tablet)).toBe(one);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);

    await tablet.changeSettings({ profile: classic });
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);

    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);
    await tablet.changeSettings({ context: { grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" } });
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);

    const { entries, total } = await history(machine);
    expect(total).toBe(2);
    for (const entry of entries) {
      expect(entry.recipe.id).toBe(one);
      expect(entry.unloadedAt).not.toBeNull();
      expect(Date.parse(entry.unloadedAt!)).toBeGreaterThanOrEqual(Date.parse(entry.loadedAt));
    }
    // Latest first.
    expect(Date.parse(entries[0]!.loadedAt)).toBeGreaterThanOrEqual(Date.parse(entries[1]!.unloadedAt!));
  });

  it("keeps a Recipe loaded through another batch of its Bean, and unloads it on a batch of another Bean, keeping the batch picked", async () => {
    const { machine, tablet, one } = await lab("Rebagged", 47051);
    const library = dye2Library();
    const beanOf = (name: string) => (library["/beans"] as Record_[]).find((bean) => String(bean.name).endsWith(name))!.id;
    const brazilBatch = (library["/bean-batches"] as Record_[]).find((batch) => batch.beanId === beanOf("Brazil"))!.id;
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);
    const loadedBatch = context(tablet).beanBatchId;

    // The next bag of the same Bean, picked with the dial as it is.
    const nextBag = await tablet.addBatch(beanOf("Ethiopia"), { roastDate: "2026-10-10", weight: 250 });
    await tablet.changeSettings({ context: { beanBatchId: nextBag.id } });
    await expect.poll(async () => (await (await api.call("GET", `/machines/${machine.machine.id}/workflow`)).json()) as { workflow: { workflow: Record_ } }, { timeout: 15_000 }).toMatchObject({
      workflow: { workflow: { context: { beanBatchId: nextBag.id } } },
    });
    expect(context(tablet).beanBatchId).toBe(nextBag.id);
    expect(named(tablet)).toBe(one);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(one);
    expect(nextBag.id).not.toBe(loadedBatch);

    // A batch of another Bean, with the dial as it is: unloaded, the batch kept.
    await tablet.changeSettings({ context: { beanBatchId: brazilBatch } });
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    expect(context(tablet).beanBatchId).toBe(brazilBatch);
    await loads(machine, null);
  });

  it.each([
    { read: "DYE2's recipes", serial: 47071, slowed: (path: string) => path === `/store/${DYE2_NAMESPACE}/recipes` },
    { read: "the Recipe's Bean", serial: 47081, slowed: (path: string) => path.startsWith("/beans/") },
  ])("keeps a batch of another Bean picked while a load of the Recipe reads $read, and unloads it", async ({ read, serial, slowed }) => {
    const library = dye2Library();
    const beanNamed = (name: string) => (library["/beans"] as Record_[]).find((bean) => String(bean.name).endsWith(name))!.id;
    const brazilBatch = (library["/bean-batches"] as Record_[]).find((batch) => batch.beanId === beanNamed("Brazil"))!.id;
    let pick: (() => void) | undefined;
    // Once set, the next such read takes 25 s of the tablet's time, half a second here, as a barista picks a batch of
    // another Bean.
    const delay = (method: string, path: string) => {
      if (!pick || method !== "GET" || !slowed(path)) return 0;
      pick();
      pick = undefined;
      return 25_000;
    };
    const { machine, tablet, one } = await lab(`Overlapped ${read}`, serial, server, delay);
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);
    // Another grinder unloads it, with the next bag of its Bean picked; applied again, it is loaded, writing its own batch.
    const nextBag = await tablet.addBatch(beanNamed("Ethiopia"), { roastDate: "2026-10-10", weight: 250 });
    await tablet.changeSettings({ context: { beanBatchId: nextBag.id, grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" } });
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);

    // Applied again, its load is being decided as a batch of another Bean is picked.
    let picked: Promise<unknown> | undefined;
    pick = () => {
      picked = tablet.changeSettings({ context: { beanBatchId: brazilBatch } });
    };
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await expect.poll(() => picked, { timeout: 15_000 }).toBeDefined();
    await picked;
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    expect(context(tablet)).toMatchObject({ beanBatchId: brazilBatch, grinderSetting: "2.7" });
    await loads(machine, null);
  });

  it("keeps a batch of another Bean picked while Decaid refuses a load's hot water for want of a machine, and unloads it", async () => {
    const { machine, tablet, one } = await lab("Refused", 47091);
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);
    const library = dye2Library();
    const beanNamed = (name: string) => (library["/beans"] as Record_[]).find((bean) => String(bean.name).endsWith(name))!.id;
    const brazilBatch = (library["/bean-batches"] as Record_[]).find((batch) => batch.beanId === beanNamed("Brazil"))!.id;
    const nextBag = await tablet.addBatch(beanNamed("Ethiopia"), { roastDate: "2026-10-10", weight: 250 });
    // Unloaded by another grinder, with the next bag and other hot water: applied again, it is loaded, writing its batch and hot water.
    await tablet.changeSettings({ context: { beanBatchId: nextBag.id, grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" }, hotWaterData: { volume: 60 } });
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);
    let picked: Promise<unknown> | undefined;
    // Decaid refuses the load's write with its hot water, as while no machine is connected, as a barista picks a batch of
    // another Bean.
    tablet.refuseWrites = ({ route, body }) => {
      const write = body as Record_;
      if (route !== "/workflow" || !write.hotWaterData || !(write.context as Record_ | undefined)?.beanBatchId) return;
      tablet.refuseWrites = undefined;
      picked = tablet.changeSettings({ context: { beanBatchId: brazilBatch } });
      return { status: 500, body: { error: "DeviceNotConnectedException" } };
    };
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await expect.poll(() => picked, { timeout: 15_000 }).toBeDefined();
    await picked;
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    expect(context(tablet).beanBatchId).toBe(brazilBatch);
    await loads(machine, null);
  });

  it("unloads a Recipe whose grinder changes, though it is set back with a dose tweak while that is being decided, as had each change been decided at once", async () => {
    let restore: (() => void) | undefined;
    // Once set, the next read of DYE2's recipes takes 25 s of the tablet's time, half a second here, as the grinder is set back.
    const delay = (method: string, path: string) => {
      if (!restore || method !== "GET" || path !== `/store/${DYE2_NAMESPACE}/recipes`) return 0;
      const call = restore;
      restore = undefined;
      call();
      return 25_000;
    };
    const { machine, tablet, one } = await lab("Set back", 47101, server, delay);
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);
    const grinderId = context(tablet).grinderId;
    let restored: Promise<unknown> | undefined;
    restore = () => {
      restored = tablet.changeSettings({ context: { grinderId, targetDoseWeight: 19.25 } });
    };
    await tablet.changeSettings({ context: { grinderId: "another-grinder" } });
    await expect.poll(() => restored, { timeout: 15_000 }).toBeDefined();
    await restored;
    await expect.poll(async () => (await (await api.call("GET", `/machines/${machine.machine.id}/workflow`)).json()) as unknown, { timeout: 15_000 }).toMatchObject({
      workflow: { workflow: { context: { grinderId, targetDoseWeight: 19.25 } } },
    });
    // The grinder's change unloaded it; set back with another dose, the Workflow matches it no longer.
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    expect(context(tablet)).toMatchObject({ grinderId, targetDoseWeight: 19.25 });
    await loads(machine, null);
  });

  it("unloads a Recipe whose grinder changes, though its dose is tweaked while that is being decided", async () => {
    let tweak: (() => void) | undefined;
    // Once set, the next read of DYE2's recipes takes 25 s of the tablet's time, half a second here, as the dose is tweaked.
    const delay = (method: string, path: string) => {
      if (!tweak || method !== "GET" || path !== `/store/${DYE2_NAMESPACE}/recipes`) return 0;
      const call = tweak;
      tweak = undefined;
      call();
      return 25_000;
    };
    const { machine, tablet, one } = await lab("Tweaked", 47111, server, delay);
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);
    let tweaked: Promise<unknown> | undefined;
    tweak = () => {
      tweaked = tablet.changeSettings({ context: { targetDoseWeight: 19.25 } });
    };
    await tablet.changeSettings({ context: { grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" } });
    await expect.poll(() => tweaked, { timeout: 15_000 }).toBeDefined();
    await tweaked;
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    expect(context(tablet)).toMatchObject({ grinderId: "a-grinder-the-recipe-does-not-name", targetDoseWeight: 19.25 });
    await loads(machine, null);
  });

  it("unloads a Recipe once Decaid answers again, after failing the read the change needed", async () => {
    const { machine, tablet, one } = await lab("Retried", 47061);
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await loads(machine, one);

    // Decaid fails every read of DYE2's recipes for a while, as the grinder changes.
    tablet.failNextApiReads(`/store/${DYE2_NAMESPACE}/recipes`, 1_000_000);
    await tablet.changeSettings({ context: { grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" } });
    await tablet.waitForLog(/^Could not work out the Loaded Recipe, trying again in /);
    // Sent meanwhile as it is, still naming the Recipe.
    await expect.poll(async () => (await (await api.call("GET", `/machines/${machine.machine.id}/workflow`)).json()) as { workflow: { workflow: Record_ } }, { timeout: 15_000 }).toMatchObject({
      workflow: { workflow: { context: { grinderId: "a-grinder-the-recipe-does-not-name" } } },
    });
    expect(named(tablet)).toBe(one);

    tablet.failNextApiReads(`/store/${DYE2_NAMESPACE}/recipes`, 0);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    await loads(machine, null);
  });

  it("leaves a barista's set-back of a tweak of the Loaded Recipe as they set it, though Streamline's auto-save made the tweak its dial", async () => {
    const { machine, tablet, two } = await lab("Set back saved", 47131);
    expect((await applyInStreamline(tablet, "2")).status).toBe(200);
    await loads(machine, two);
    // The barista moves the grind to 3.1 in Streamline, which saves it into the recipe: every tablet is written it.
    expect(await autoSaveInStreamline(tablet, strip.autoSaveGrind)).toBeDefined();
    await expect.poll(async () => ((await (await api.call("GET", `/recipes/${two}`)).json()) as { recipe: { content: Record_ } }).recipe.content.grindSetting, { timeout: 15_000 }).toBe(3.1);
    await expect.poll(() => (((inSlot(tablet, "2")?.workflow as Record_ | undefined)?.context ?? {}) as Record_).grinderSetting, { timeout: 15_000 }).toBe("3.1");

    // Set back to 3, the recipe's dial before: the plugin writes nothing over it.
    await tablet.changeSettings({ context: { grinderSetting: "3" } });
    await expect.poll(async () => (await (await api.call("GET", `/machines/${machine.machine.id}/workflow`)).json()) as { workflow: { workflow: Record_ } }, { timeout: 15_000 }).toMatchObject({
      workflow: { workflow: { context: { grinderSetting: "3" } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(context(tablet).grinderSetting).toBe("3");
    expect(named(tablet)).toBe(two);
  });

  it("records a load made while the tablet is offline in the Workflow, which reaches the server on reconnect, timed when it was made", async () => {
    const { machine, tablet, one } = await lab("Offline", 47041);
    tablet.loseNetwork();
    await api.waitForMachine(machine.machine.name, (viewed) => !viewed.online, 15_000);

    const appliedAt = Date.now();
    expect((await applyInDye2(tablet, "1")).status).toBe(200);
    await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(one);
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
    // Held well past the load before the tablet reconnects.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await loadedRecipe(machine)).toBeNull();

    const reconnectedAt = Date.now();
    tablet.restoreNetwork();
    await loads(machine, one);
    const loadedAt = Date.parse((await loadedRecipe(machine))!.loadedAt);
    expect(loadedAt).toBeGreaterThanOrEqual(appliedAt - 1_000);
    expect(loadedAt).toBeLessThan(reconnectedAt);
  });
});
