import { RECIPE_SETTINGS, RECIPE_SETTING_NAMES, type RecipeSetting, dye2GlobalIdOf, workflowValueAt } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { selectedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #173: a Recipe holds any of the eleven steam, hot water
// and flush settings, in DYE2's own recipe fields, and a Machine follows them
// while it has the Recipe loaded (ADR-0022). A load writes each the Recipe
// holds into the Workflow, and leaves the rest as the Machine had them; a
// change on a Machine that DYE2 records into the recipe is the Recipe's edit,
// written into every Machine with it loaded; and steam on and off stays each
// Machine's own: steam turned off is no edit, no steam temperature is written
// into a Workflow whose steam is off, and Streamline's remembered steam
// temperature is kept at the Recipe's (ADR-0021). With no Recipe loaded, a
// change of them stays on its Machine (#190). Through the built plugin in
// simulated tablets running DYE2 at 2cf631c and Streamline at c006dac as
// recorded (fixtures/decaid/dye2-2cf631c/), Machines A and B on one server
// instance and C on another sharing one database, with assertions through the
// REST API and what each simulated tablet holds. Serials are made up, from
// 49001.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** What slot 1's Recipe holds of the settings: all but the milk stop, hot water flow and flush flow, each Machine's own. */
const HELD = {
  steamTemperature: 150,
  steamDuration: 30,
  steamFlow: 1.5,
  hotWaterTemperature: 85,
  hotWaterDuration: 35,
  hotWaterVolume: 120,
  flushTemperature: 92,
  flushDuration: 8,
} satisfies Partial<Record<RecipeSetting, number>>;

describe("A Recipe's steam, hot water and flush settings", { timeout: 120_000 }, () => {
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

  const records = (tablet: SimulatedTablet) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []);
  const inSlot = (tablet: SimulatedTablet, slot: string) => records(tablet).find((record) => record.id === slot);
  const variables = (record: Record_ | undefined) => (record?.dashboardVariables ?? {}) as Record_;
  /** Each setting the tablet's Workflow holds, by its name. */
  const settingsOf = (tablet: SimulatedTablet) => Object.fromEntries(RECIPE_SETTING_NAMES.map((setting) => [setting, workflowValueAt(tablet.workflow(), RECIPE_SETTINGS[setting].workflow)]));
  /** One setting the tablet's Workflow holds. */
  const setting = (tablet: SimulatedTablet, name: RecipeSetting) => workflowValueAt(tablet.workflow(), RECIPE_SETTINGS[name].workflow);
  /** One setting the tablet's record of slot 1 holds. */
  const recorded = (tablet: SimulatedTablet, name: RecipeSetting) => variables(inSlot(tablet, "1"))[RECIPE_SETTINGS[name].dye2];
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: { fields: Record_ }[] }>(`/recipes/${id}/history`)).versions;
  /** How many of the Recipe's versions set the field. */
  const editsOf = async (id: string, field: string) => (await versions(id)).filter((version) => field in version.fields).length;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  /** The latest Workflow the server stored for the Machine. */
  const latestWorkflow = async ({ machine }: CreatedMachine) =>
    (await api.get<{ events: { workflow: Record_ }[] }>(`/machines/${machine.id}/workflow-events?limit=1`)).events[0]?.workflow;
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** The writes of the Workflow the server sent the tablet's plugin from `from` on. */
  const workflowWritesTo = (tablet: SimulatedTablet, from: number) =>
    (tablet.received.slice(from).filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "loadedRecipe") as { fields: Record_ }[]).map(
      ({ fields }) => fields,
    );
  /** Waits a while for what should not happen, as a write of a setting back. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));
  /** The Machine's first espresso since the load, which ends the window in which a part set back to what the load replaced is stale. */
  const pullEspresso = (tablet: SimulatedTablet) => {
    tablet.reportState("espresso", "pour");
    tablet.reportState("idle", "ready");
  };

  /**
   * A Location with Machines A, whose tablet is the 2cf631c recording's, and
   * B on one instance, and C on the other, both tablets where DYE2 was never
   * used, each running DYE2 with its machine connected. A brings slots 1 and
   * 2, and slot 1 is given HELD's settings before B and C join, so every
   * tablet's record holds them. Slot 1 is applied on DYE2's dashboard on A
   * and C (unless `loadC` is false), and slot 2 on B, which each loads.
   */
  async function lab(scenario: string, serial: number, options: { loadC?: boolean } = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      b: await api.createMachine(`${scenario} lab B`, here.id),
      c: await api.createMachine(`${scenario} lab C`, here.id),
    };
    const dye2 = { a: new SimulatedDye2(), b: new SimulatedDye2(), c: new SimulatedDye2() };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: dye2.a });
    await api.waitForOnline(machines.a);
    await expect.poll(() => ["1", "2"].map((slot) => dye2GlobalIdOf(inSlot(a, slot))), { timeout: 15_000 }).not.toContain(null);
    const one = dye2GlobalIdOf(inSlot(a, "1"))!;
    const two = dye2GlobalIdOf(inSlot(a, "2"))!;
    await patch(one, HELD);
    await expect.poll(() => recorded(a, "hotWaterDuration"), { timeout: 15_000 }).toBe(HELD.hotWaterDuration);
    const b = syncingTablet(machines.b, server, { api: dye2NeverUsed(String(serial + 1)), dye2: dye2.b });
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 2)), dye2: dye2.c });
    await api.waitForOnline(machines.b, machines.c);
    for (const tablet of [b, c]) {
      await expect
        .poll(() => ["1", "2"].map((slot) => [dye2GlobalIdOf(inSlot(tablet, slot)), inSlot(tablet, slot)?.beanBatchId ?? null]).flat(), { timeout: 15_000 })
        .not.toContain(null);
      await expect.poll(() => recorded(tablet, "flushTemperature")).toBe(HELD.flushTemperature);
    }
    // Decaid writes the steam, hot water and flush settings to the machine, and refuses them without one.
    for (const tablet of [a, b, c]) tablet.connectMachine();
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, slot: string, recipeId: string) => {
      expect((await (await openDye2Dashboard(tablet)).applyRecipe(slot)).selection?.status).toBe(200);
      await expect.poll(() => selectedInWorkflow(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
    };
    await load(a, machines.a, "1", one);
    if (options.loadC !== false) await load(c, machines.c, "1", one);
    await load(b, machines.b, "2", two);
    await settle();
    return { here, machines, dye2, a, b, c, one, two, load };
  }

  it("loads every setting a Recipe holds into the Workflow, applied by Streamline's strip, leaving each it holds none of as the Machine had it, and writes them into each record and its embedded Workflow", async () => {
    const { machines, c, one } = await lab("Loaded", 49001, { loadC: false });
    // C's own milk stop, hot water flow and flush flow, which the Recipe holds none of.
    await c.changeSettings({ steamSettings: { stopAtTemperature: 55 }, hotWaterData: { flow: 9 }, rinseData: { flow: 5 } });
    // Streamline's strip applies only the values of the recipe's modes (decentespresso/streamline-js#154): the plugin's load
    // writes the rest.
    const streamline = await startStreamline(c);
    expect((await streamline.applyRecipe("1")).selection?.status).toBe(200);
    await loads(machines.c, one);
    await expect.poll(() => settingsOf(c), { timeout: 15_000 }).toEqual({ ...HELD, steamStopTemperature: 55, hotWaterFlow: 9, flushFlow: 5 });

    // Each record holds the settings the Recipe holds in DYE2's fields, blank where it holds none, and none of its own field.
    const record = inSlot(c, "1")!;
    expect(record).not.toHaveProperty("decentSyncRecipe");
    expect(Object.fromEntries(RECIPE_SETTING_NAMES.map((name) => [name, recorded(c, name) ?? null]))).toEqual({
      ...HELD,
      steamStopTemperature: null,
      hotWaterFlow: null,
      flushFlow: null,
    });
    // Its embedded Workflow carries each it holds, as DYE2's record builder does, and none it does not.
    expect(record.workflow).toMatchObject({
      steamSettings: { targetTemperature: 150, duration: 30, flow: 1.5 },
      hotWaterData: { targetTemperature: 85, duration: 35, volume: 120 },
      rinseData: { targetTemperature: 92, duration: 8 },
    });
    const embedded = record.workflow as Record<string, Record_>;
    expect([embedded.steamSettings, embedded.hotWaterData, embedded.rinseData].map((part) => Object.keys(part ?? {}).sort())).toEqual([
      ["duration", "flow", "targetTemperature"],
      ["duration", "targetTemperature", "volume"],
      ["duration", "targetTemperature"],
    ]);
    expect(JSON.stringify(records(c))).not.toContain("decentSyncRecipe");
  });

  it("takes a steam time change on A that DYE2 records as the Recipe's, writing it into C's Workflow and record, but not B's, which has another Recipe loaded", async () => {
    const { a, b, c, one } = await lab("Steamed", 49011);
    const ownOnB = setting(b, "steamDuration");
    const edits = await editsOf(one, "steamDuration");
    const received = a.received.length;
    await a.changeSettings({ steamSettings: { duration: 27 } });
    await expect.poll(async () => (await recipe(one)).content.steamDuration, { timeout: 15_000 }).toBe(27);
    await expect.poll(() => [setting(c, "steamDuration"), recorded(c, "steamDuration")], { timeout: 15_000 }).toEqual([27, 27]);
    expect(await editsOf(one, "steamDuration")).toBe(edits + 1);
    await settle();
    expect(setting(b, "steamDuration")).toBe(ownOnB);
    // A's record, which DYE2 recorded the steam time into, embedding it as the server derives it, is not written again.
    const recipeWrites = a.received.slice(received).filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "recipe");
    expect(recipeWrites).toEqual([]);
  });

  it("takes a held flush time changed 10, 6, 10 and 6 on C past its first espresso since the load each time, writing nothing back", async () => {
    const { machines, a, c, one } = await lab("Purge", 49021);
    pullEspresso(c);
    await expect.poll(async () => (await latestWorkflow(machines.c))?.rinseData).toBeDefined();
    const received = c.received.length;
    const edits = await editsOf(one, "flushDuration");
    for (const duration of [10, 6, 10, 6]) {
      await c.changeSettings({ rinseData: { duration } });
      await expect.poll(async () => (await recipe(one)).content.flushDuration, { timeout: 15_000 }).toBe(duration);
      await expect.poll(() => setting(a, "flushDuration"), { timeout: 15_000 }).toBe(duration);
      await settle();
      expect([setting(c, "flushDuration"), recorded(c, "flushDuration")]).toEqual([duration, duration]);
    }
    // One edit of each, from C, and nothing written into C's Workflow of the flush.
    expect(await editsOf(one, "flushDuration")).toBe(edits + 4);
    expect(workflowWritesTo(c, received).filter((fields) => "rinseData.duration" in fields)).toEqual([]);
  });

  it("takes no steam turned off on A as an edit, by a steam temperature of 0 or below 135 °C, or Streamline's steam time of 0, nor a steam time of 0 then, and writes no steam temperature into A's Workflow", async () => {
    const { a, c, one } = await lab("Off", 49031);
    const steamEdits = { temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") };
    const off = (temperature: number) => expect.poll(() => setting(a, "steamTemperature"), { timeout: 15_000 }).toBe(temperature);

    await a.changeSettings({ steamSettings: { targetTemperature: 0 } });
    await settle();
    await off(0);
    // DYE2 records it as 0, and the record is written back with the Recipe's.
    await expect.poll(() => recorded(a, "steamTemperature"), { timeout: 15_000 }).toBe(150);
    await a.changeSettings({ steamSettings: { targetTemperature: 120 } });
    await settle();
    await off(120);
    await a.changeSettings({ steamSettings: { targetTemperature: 150 } });
    await settle();

    // Streamline's dashboard turns steam off with a steam time of 0 and a temperature of 0.
    const streamline = await startStreamline(a);
    await streamline.set("last-steam-duration", 0);
    await settle();
    await off(0);
    // The Recipe's steam time is written back into A's Workflow, which keeps steam off; a steam time of 0 set again is no edit.
    await expect.poll(() => setting(a, "steamDuration"), { timeout: 15_000 }).toBe(30);
    await a.changeSettings({ steamSettings: { duration: 0 } });
    await settle();
    await expect.poll(() => setting(a, "steamDuration"), { timeout: 15_000 }).toBe(30);
    await off(0);

    expect((await recipe(one)).content).toMatchObject({ steamTemperature: 150, steamDuration: 30 });
    expect({ temperature: await editsOf(one, "steamTemperature"), duration: await editsOf(one, "steamDuration") }).toEqual(steamEdits);
    // C kept steaming.
    expect(settingsOf(c)).toMatchObject({ steamTemperature: 150, steamDuration: 30 });
  });

  it("writes a steam time edited on A into C's Workflow while C's steam is off, without turning it on, where it survives C's next change", async () => {
    const { a, c, one } = await lab("Kept off", 49041);
    await c.changeSettings({ steamSettings: { targetTemperature: 0 } });
    await settle();
    await a.changeSettings({ steamSettings: { duration: 22 } });
    await expect.poll(async () => (await recipe(one)).content.steamDuration, { timeout: 15_000 }).toBe(22);
    await expect.poll(() => setting(c, "steamDuration"), { timeout: 15_000 }).toBe(22);
    expect(setting(c, "steamTemperature")).toBe(0);
    // C's next change, which DYE2 records with steam still off.
    await c.changeSettings({ hotWaterData: { volume: 130 } });
    await expect.poll(async () => (await recipe(one)).content.hotWaterVolume, { timeout: 15_000 }).toBe(130);
    await settle();
    expect([setting(c, "steamDuration"), setting(c, "steamTemperature")]).toEqual([22, 0]);
    expect((await recipe(one)).content).toMatchObject({ steamDuration: 22, steamTemperature: 150 });
  });

  it("keeps Streamline's remembered steam temperature at the Recipe's on a load and a Loaded Recipe write while steam is off, so steam turned back on there takes the Recipe's", async () => {
    const { machines, a, c, one, load } = await lab("Remembered", 49051, { loadC: false });
    const streamline = await startStreamline(c, { "last-steam-temp": 140 });
    await load(c, machines.c, "1", one);
    await expect.poll(() => streamline.remembered("last-steam-temp"), { timeout: 15_000 }).toBe(150);

    // C's barista turns steam off in Streamline, and the Recipe's steam temperature is edited meanwhile.
    await streamline.set("last-steam-duration", 0);
    await settle();
    expect(setting(c, "steamTemperature")).toBe(0);
    await patch(one, { steamTemperature: 155 });
    await expect.poll(() => setting(a, "steamTemperature"), { timeout: 15_000 }).toBe(155);
    await expect.poll(() => streamline.remembered("last-steam-temp"), { timeout: 15_000 }).toBe(155);
    expect(setting(c, "steamTemperature")).toBe(0);
    const edits = await editsOf(one, "steamTemperature");

    // Turned back on from Streamline's dashboard, at the Recipe's: no edit.
    await streamline.set("last-steam-duration", 30);
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(155);
    await settle();
    expect((await recipe(one)).content.steamTemperature).toBe(155);
    expect(await editsOf(one, "steamTemperature")).toBe(edits);
  });

  it("keeps Streamline's remembered steam temperature at an edit made while C was offline with steam off, where DYE2 recorded steam off again meanwhile", async () => {
    const { machines, a, c, one, load } = await lab("Missed", 49111, { loadC: false });
    const streamline = await startStreamline(c, { "last-steam-temp": 140 });
    await load(c, machines.c, "1", one);
    await expect.poll(() => streamline.remembered("last-steam-temp"), { timeout: 15_000 }).toBe(150);
    await streamline.set("last-steam-duration", 0);
    await expect.poll(() => recorded(c, "steamTemperature"), { timeout: 15_000 }).toBe(150);

    // Offline, C's next change has DYE2 record steam off again, and the Recipe's steam temperature is edited meanwhile.
    c.loseNetwork();
    await c.changeSettings({ hotWaterData: { volume: 130 } });
    await expect.poll(() => recorded(c, "steamTemperature"), { timeout: 15_000 }).toBe(0);
    await patch(one, { steamTemperature: 160 });
    await expect.poll(() => setting(a, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    c.restoreNetwork();
    await expect.poll(() => recorded(c, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    await expect.poll(() => streamline.remembered("last-steam-temp"), { timeout: 15_000 }).toBe(160);
    expect(setting(c, "steamTemperature")).toBe(0);
    const edits = await editsOf(one, "steamTemperature");

    // Turned back on from Streamline's dashboard, at the Recipe's: no edit.
    await streamline.set("last-steam-duration", 30);
    await expect.poll(() => setting(c, "steamTemperature"), { timeout: 15_000 }).toBe(160);
    await settle();
    expect([(await recipe(one)).content.steamTemperature, await editsOf(one, "steamTemperature")]).toEqual([160, edits]);
  });

  it("takes a steam temperature of Off saved in DYE2's editor as no edit, writing the Recipe's back into the record", async () => {
    const { c, one } = await lab("Editor", 49061);
    const edits = await editsOf(one, "steamTemperature");
    // DYE2's editor saves the fields changed over a fresh read, stamping `capturedAt` anew (decentespresso/dye2#28).
    const saved = records(c).map((record) =>
      record.id === "1" ? { ...record, dashboardVariables: { ...variables(record), steamTempC: 0, flushS: 9 }, capturedAt: new Date().toISOString() } : record,
    );
    expect((await c.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, saved)).status).toBe(200);
    // Its flush time is an edit, written into C's Workflow; its steam off is not.
    await expect.poll(async () => (await recipe(one)).content.flushDuration, { timeout: 15_000 }).toBe(9);
    await expect.poll(() => recorded(c, "steamTemperature"), { timeout: 15_000 }).toBe(150);
    await expect.poll(() => setting(c, "flushDuration"), { timeout: 15_000 }).toBe(9);
    expect([(await recipe(one)).content.steamTemperature, await editsOf(one, "steamTemperature")]).toEqual([150, edits]);
    expect(setting(c, "steamTemperature")).toBe(150);
  });

  it("brings a Machine that applied an out-of-date copy of the Recipe to its current settings", async () => {
    const { machines, c, one } = await lab("Stale", 49071, { loadC: false });
    // C's record is written nothing while it is offline: it applies the copy it holds.
    c.loseNetwork();
    await patch(one, { steamDuration: 40, hotWaterVolume: 140, flushDuration: 6 });
    expect((await (await openDye2Dashboard(c)).applyRecipe("1")).selection?.status).toBe(200);
    expect([setting(c, "steamDuration"), setting(c, "hotWaterVolume"), setting(c, "flushDuration")]).toEqual([30, 120, 8]);
    c.restoreNetwork();
    await loads(machines.c, one);
    await expect.poll(() => settingsOf(c), { timeout: 15_000 }).toMatchObject({ ...HELD, steamDuration: 40, hotWaterVolume: 140, flushDuration: 6 });
    await settle();
    expect((await recipe(one)).content).toMatchObject({ steamDuration: 40, hotWaterVolume: 140, flushDuration: 6 });
  });

  it("takes a setting the Recipe holds none of as its own once DYE2 records a change of it, and writes it into C's Workflow", async () => {
    const { a, c, one } = await lab("Adopted", 49081);
    expect((await recipe(one)).content).not.toHaveProperty("hotWaterFlow");
    const ownOnC = setting(c, "hotWaterFlow");
    await a.changeSettings({ hotWaterData: { flow: 4.5 } });
    await expect.poll(async () => (await recipe(one)).content.hotWaterFlow, { timeout: 15_000 }).toBe(4.5);
    expect(ownOnC).not.toBe(4.5);
    await expect.poll(() => [setting(c, "hotWaterFlow"), recorded(c, "hotWaterFlow")], { timeout: 15_000 }).toEqual([4.5, 4.5]);
  });

  it("takes a steam mode switched in a recipe record into the Recipe and every tablet's record, writing nothing into any Workflow", async () => {
    const { a, b, c, one } = await lab("Mode", 49091);
    const received = { a: a.received.length, b: b.received.length, c: c.received.length };
    expect(variables(inSlot(c, "1")).steamMode).toBe("time");
    const saved = records(a).map((record) =>
      record.id === "1" ? { ...record, dashboardVariables: { ...variables(record), steamMode: "flow" }, capturedAt: new Date().toISOString() } : record,
    );
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, saved)).status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content.steamMode, { timeout: 15_000 }).toBe("flow");
    for (const tablet of [b, c]) await expect.poll(() => variables(inSlot(tablet, "1")).steamMode, { timeout: 15_000 }).toBe("flow");
    await settle();
    for (const [tablet, from] of [
      [a, received.a],
      [b, received.b],
      [c, received.c],
    ] as const) {
      expect(workflowWritesTo(tablet, from)).toEqual([]);
    }
  });

  it("changes nothing on the server but the Machine's events for a steam, hot water or flush change with no Recipe loaded", async () => {
    const { machines, a, b, c, one, two } = await lab("Unloaded", 49101);
    // A's selection cleared, as Streamline's strip switched off does: A has no Recipe loaded.
    expect((await a.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, {})).status).toBe(200);
    await loads(machines.a, null);
    const before = { one: await recipe(one), two: await recipe(two), versions: [(await versions(one)).length, (await versions(two)).length] };
    const elsewhere = { b: settingsOf(b), c: settingsOf(c) };
    await a.changeSettings({ steamSettings: { duration: 44, targetTemperature: 145 }, hotWaterData: { volume: 90 }, rinseData: { duration: 3 } });
    await expect.poll(async () => (await latestWorkflow(machines.a))?.rinseData, { timeout: 15_000 }).toMatchObject({ duration: 3 });
    await settle();
    expect({ one: await recipe(one), two: await recipe(two), versions: [(await versions(one)).length, (await versions(two)).length] }).toEqual(before);
    expect({ b: settingsOf(b), c: settingsOf(c) }).toEqual(elsewhere);
    expect(settingsOf(a)).toMatchObject({ steamDuration: 44, steamTemperature: 145, hotWaterVolume: 90, flushDuration: 3 });
  });

  it("maps none of the Location settings endpoints, which answer 404 (#190)", async () => {
    const here = await api.createLocation("Gone lab", "America/Chicago");
    const machines = { a: await api.createMachine("Gone lab A", here.id) };
    const routes = [...server.output().matchAll(/Mapped \{(\/\S+), (\w+)\} route/g)].map(([, path, method]) => `${method} ${path}`);
    const gone = [
      ["GET", `/locations/${here.id}/settings`, "GET /api/locations/:id/settings"],
      ["PATCH", `/location-settings/${here.id}`, "PATCH /api/location-settings/:id"],
      ["PUT", `/machines/${machines.a.machine.id}/settings-sharing`, "PUT /api/machines/:id/settings-sharing"],
      ["GET", `/location-settings/${here.id}/history`, "GET /api/location-settings/:id/history"],
      ["GET", `/location-settings/${here.id}/conflicts`, "GET /api/location-settings/:id/conflicts"],
    ] as const;
    for (const [method, path, route] of gone) {
      expect(routes).not.toContain(route);
      expect((await api.call(method, path, method === "GET" ? undefined : {})).status, route).toBe(404);
    }
  });
});
