import { randomUUID } from "node:crypto";
import { COLLECTION_NAMES } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { derivedShot } from "./support/shot-fixtures.js";
import { type DecaidApi, SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { StandInServer } from "./support/stand-in-server.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for #403: the built plugin in a simulated tablet reads the
// machine's own settings and its sensor calibration, which Decaid reads from
// the machine over its Bluetooth connection on each request, only while the
// Machine runs nothing: the latest state Decaid reported is one of
// SETTINGS_EDIT_STATES, and no Shot is yet to be stored. A read that falls
// due meanwhile waits, and runs once the Machine next runs nothing. Against
// a real server, whose REST API shows what it stored, and a stand-in, which
// asks for everything (`requestCollections`) when the test chooses. With no
// state reported, the reads run as collections.test.ts tests them.

/** Where the machine's own settings are read, which Decaid reads from the machine on each request. */
const MACHINE_SETTINGS_ROUTES = ["/machine/settings", "/machine/settings/advanced", "/machine/calibration"];
/** Where the sensor calibration is read, each route once. */
const SENSOR_CALIBRATION_ROUTES = ["/machine/calibration/flow", "/machine/calibration/pressure", "/machine/calibration/temperature"];
const FROM_MACHINE_ROUTES = [...MACHINE_SETTINGS_ROUTES, ...SENSOR_CALIBRATION_ROUTES];
/** The collections read from the machine, which wait while it runs something. */
const FROM_MACHINE = ["machineSettings", "advancedSettings", "machineCalibration", "sensorCalibration"];
/** Every other collection, read and sent whatever the Machine is doing. */
const OTHERS = COLLECTION_NAMES.filter((name) => !FROM_MACHINE.includes(name));

/** When the plugin read `route`, by the tablet's clock, in order. */
const readTimes = (tablet: SimulatedTablet, route: string) =>
  tablet.requests.flatMap((request, index) => (request === route ? [tablet.requestedAt[index]!] : []));
/** The time between each of the times given and the next. */
const gaps = (times: number[]) => times.slice(1).map((time, index) => time - times[index]!);
/** The reads from the machine the plugin made since the tablet's `since`th request. */
const fromMachineSince = (tablet: SimulatedTablet, since: number) => tablet.requests.slice(since).filter((route) => FROM_MACHINE_ROUTES.includes(route));
/** Resolves once the plugin has read the sensors, which each poll reads last, at least `count` more times. */
async function polls(tablet: SimulatedTablet, count: number) {
  const before = readTimes(tablet, "/sensors").length;
  await expect.poll(() => readTimes(tablet, "/sensors").length).toBeGreaterThanOrEqual(before + count);
}

describe("The machine's own settings and sensor calibration, read only while the Machine runs nothing", () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const collection = async (machine: CreatedMachine, name: string) =>
    (await api.get<{ collection: { value: unknown } | null }>(`/machines/${machine.machine.id}/collections/${name}`)).collection;
  const allReported = async (machine: CreatedMachine) =>
    (await api.get<{ collections: unknown[] }>(`/machines/${machine.machine.id}/collections`)).collections.length === COLLECTION_NAMES.length;

  /** A simulated tablet connected to a stand-in server, polling every 5 s, and what the stand-in received of a collection. */
  function standInTablet(standIn: StandInServer, serial: string, timeScale: number) {
    const served = derivedDe1Pro({ serial });
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: `stand-in token ${serial}`, serverUrl: standIn.url }), PollSeconds: 5 },
      api: served,
      timeScale,
    });
    const sent = (name: string) => standIn.received.filter((message) => message.type === "collection" && message.name === name);
    return { tablet, served, sent };
  }

  it("are not read on their interval while the Machine steams, pours hot water, flushes or pulls a Shot, and are read once it is idle again, with what changed meanwhile", async () => {
    const machine = await api.createMachine("Busy machine");
    let served: DecaidApi = derivedDe1Pro({ serial: "40301" });
    const tablet = syncingTablet(machine, server, { api: served });
    await expect.poll(() => allReported(machine)).toBe(true);

    const busy = [["steam", "steaming"], ["hotWater", "pouring"], ["flush", "pouring"], ["espresso", "pouring"]] as const;
    for (const [index, [state, substate]] of busy.entries()) {
      const since = tablet.requests.length;
      const from = tablet.readClock();
      tablet.reportState(state, substate);
      // Derived: the fan threshold changed meanwhile, as Streamline's settings page changes it.
      const changed = { ...(served["/machine/settings"] as object), fan: 40 + index };
      served = { ...served, "/machine/settings": changed };
      tablet.serve(served);
      // Two of their intervals pass, while every other collection is polled.
      await expect.poll(() => tablet.readClock()).toBeGreaterThan(from + 125_000);
      expect(fromMachineSince(tablet, since)).toEqual([]);
      expect(tablet.requests.slice(since).filter((route) => route === "/sensors").length).toBeGreaterThanOrEqual(10);

      tablet.reportState("idle", "idle");
      if (state === "espresso") tablet.pullShot(derivedShot("busy-machine-40301"));
      await expect.poll(async () => (await collection(machine, "machineSettings"))?.value).toEqual(changed);
      for (const route of MACHINE_SETTINGS_ROUTES) expect(tablet.requests.slice(since)).toContain(route);
    }
  });

  it("wait after a Shot leaves espresso until Decaid stores it", async () => {
    const standIn = await StandInServer.start();
    try {
      // At the tablet's pace, so Decaid has 10 s to store the Shot before the plugin stops waiting for it, far longer than
      // the full read below takes.
      const { tablet, sent } = standInTablet(standIn, "40302", 1);
      await expect.poll(() => COLLECTION_NAMES.map((name) => sent(name).length)).toEqual(COLLECTION_NAMES.map(() => 1));

      tablet.reportState("espresso", "pouring");
      tablet.reportState("idle", "idle");
      const since = tablet.requests.length;
      // A Workflow change, which has them read again at once while the Machine runs nothing, and the server asking for everything.
      await tablet.changeSettings({ steamSettings: { flow: 1.5 } });
      standIn.send({ type: "requestCollections" });
      await expect.poll(() => OTHERS.filter((name) => sent(name).length < 2)).toEqual([]);
      expect(fromMachineSince(tablet, since)).toEqual([]);

      const storedAt = tablet.readClock();
      tablet.pullShot(derivedShot("not-yet-stored-40302"));
      await expect.poll(() => FROM_MACHINE.map((name) => sent(name).length)).toEqual([2, 2, 2, 2]);
      expect(sent("machineSettings")[1]).toMatchObject({ value: { steamFlow: 1.5 } });
      for (const route of FROM_MACHINE_ROUTES) expect(readTimes(tablet, route).filter((time) => time >= storedAt)).toHaveLength(1);
    } finally {
      await standIn.stop();
    }
  });

  it("are read once the Machine is idle after a Workflow change of the settings Decaid wrote to it while it steamed or poured hot water, and not before", async () => {
    const machine = await api.createMachine("Settings written while busy");
    // Its timers run only twice as fast, so their interval of a minute is 30 s, longer than a poll waits.
    const tablet = syncingTablet(machine, server, { api: derivedDe1Pro({ serial: "40303" }), timeScale: 2 });
    await expect.poll(() => allReported(machine)).toBe(true);

    const since = tablet.requests.length;
    const changedAt = tablet.readClock();
    tablet.reportState("steam", "steaming");
    await tablet.changeSettings({ steamSettings: { flow: 1.5 } });
    tablet.reportState("hotWater", "pouring");
    await tablet.changeSettings({ hotWaterData: { flow: 7 } });
    await polls(tablet, 2);
    expect(fromMachineSince(tablet, since)).toEqual([]);

    // Read at once, not on their interval, a minute after the welcome's read of them.
    tablet.reportState("idle", "idle");
    await expect.poll(async () => (await collection(machine, "machineSettings"))?.value).toMatchObject({ steamFlow: 1.5, hotWaterFlow: 7 });
    for (const route of MACHINE_SETTINGS_ROUTES) expect(readTimes(tablet, route).filter((time) => time > changedAt)).toHaveLength(1);
  });

  it("are left out of a welcome's full read during a Shot, which sends every other collection at once, and read and sent unchanged once the Shot is stored", async () => {
    const standIn = await StandInServer.start();
    try {
      const { tablet, sent } = standInTablet(standIn, "40304", 50);
      await expect.poll(() => COLLECTION_NAMES.map((name) => sent(name).length)).toEqual(COLLECTION_NAMES.map(() => 1));

      tablet.reportState("espresso", "pouring");
      const since = tablet.requests.length;
      tablet.dropConnections();
      await expect.poll(() => OTHERS.filter((name) => sent(name).length < 2)).toEqual([]);
      await polls(tablet, 2);
      expect(fromMachineSince(tablet, since)).toEqual([]);
      expect(FROM_MACHINE.map((name) => sent(name).length)).toEqual([1, 1, 1, 1]);

      const storedAt = tablet.readClock();
      tablet.reportState("idle", "idle");
      tablet.pullShot(derivedShot("welcomed-40304"));
      await expect.poll(() => FROM_MACHINE.map((name) => sent(name).length)).toEqual([2, 2, 2, 2]);
      for (const name of FROM_MACHINE) expect(sent(name)[1]).toMatchObject({ available: true, value: sent(name)[0]!.value });
      for (const route of SENSOR_CALIBRATION_ROUTES) expect(readTimes(tablet, route).filter((time) => time >= storedAt)).toHaveLength(1);
    } finally {
      await standIn.stop();
    }
  });

  it("are read once when the Machine runs nothing again, however many reads of them fell due while it was busy", async () => {
    const standIn = await StandInServer.start();
    try {
      const { tablet, sent } = standInTablet(standIn, "40305", 50);
      await expect.poll(() => COLLECTION_NAMES.map((name) => sent(name).length)).toEqual(COLLECTION_NAMES.map(() => 1));

      // While the Machine steams: a Workflow change of its steam settings, their interval passing, and the server asking for everything.
      tablet.reportState("steam", "steaming");
      const since = tablet.requests.length;
      const from = tablet.readClock();
      await tablet.changeSettings({ steamSettings: { flow: 1.5 } });
      await expect.poll(() => tablet.readClock()).toBeGreaterThan(from + 65_000);
      standIn.send({ type: "requestCollections" });
      await expect.poll(() => OTHERS.filter((name) => sent(name).length < 2)).toEqual([]);
      expect(fromMachineSince(tablet, since)).toEqual([]);

      const idleAt = tablet.readClock();
      tablet.reportState("idle", "idle");
      // A full read's: each sent, changed or not, once.
      await expect.poll(() => FROM_MACHINE.map((name) => sent(name).length)).toEqual([2, 2, 2, 2]);
      expect(sent("machineSettings")[1]).toMatchObject({ value: { steamFlow: 1.5 } });
      for (const route of SENSOR_CALIBRATION_ROUTES) expect(readTimes(tablet, route).filter((time) => time > idleAt)).toHaveLength(1);
      // Their next read is on their interval, a minute after that one.
      for (const route of MACHINE_SETTINGS_ROUTES) {
        await expect.poll(() => readTimes(tablet, route).filter((time) => time > idleAt).length).toBeGreaterThanOrEqual(2);
        for (const gap of gaps(readTimes(tablet, route).filter((time) => time > idleAt))) expect(gap).toBeGreaterThan(55_000);
      }
    } finally {
      await standIn.stop();
    }
  });

  it("are read once when the Machine runs nothing again, though a pass under way reaches them before the full read the server asked for meanwhile", async () => {
    const standIn = await StandInServer.start();
    try {
      // Five times faster, so a held read has 6 s before the plugin's fetch gives up.
      const { tablet, sent } = standInTablet(standIn, "40308", 5);
      await expect.poll(() => COLLECTION_NAMES.map((name) => sent(name).length)).toEqual(COLLECTION_NAMES.map(() => 1));
      const workflows = () => standIn.received.filter((message) => message.type === "workflow").length;

      // While the Machine steams, a Workflow change of its steam settings.
      tablet.reportState("steam", "steaming");
      const changed = workflows();
      await tablet.changeSettings({ steamSettings: { flow: 1.5 } });
      await expect.poll(workflows).toBeGreaterThan(changed);
      // A poll is held reading the beans, as behind the server's writes, while the server asks for everything, which sends
      // the Workflow again, and the Machine then turns idle.
      const held = tablet.holdRequests("GET", "/beans");
      await expect.poll(() => held.arrived).toBe(1);
      const asked = workflows();
      standIn.send({ type: "requestCollections" });
      await expect.poll(workflows).toBeGreaterThan(asked);
      const idleAt = tablet.readClock();
      tablet.reportState("idle", "idle");
      held.release();

      // The held poll reads them, as the full read's: each sent once, changed or not, and not read again by the full read.
      await expect.poll(() => OTHERS.filter((name) => sent(name).length < 2)).toEqual([]);
      await expect.poll(() => FROM_MACHINE.map((name) => sent(name).length)).toEqual([2, 2, 2, 2]);
      expect(sent("machineSettings")[1]).toMatchObject({ value: { steamFlow: 1.5 } });
      for (const route of FROM_MACHINE_ROUTES) {
        const times = readTimes(tablet, route).filter((time) => time > idleAt);
        expect(times.length).toBeGreaterThanOrEqual(1);
        for (const gap of gaps(times)) expect(gap).toBeGreaterThan(55_000);
      }
    } finally {
      await standIn.stop();
    }
  });

  it("stop as the Machine turns busy during a pass, which finishes the read under way, and read the rest once it runs nothing", async () => {
    const standIn = await StandInServer.start();
    try {
      // Five times faster, so a held read has 6 s before the plugin's fetch gives up.
      const { tablet, sent } = standInTablet(standIn, "40306", 5);
      // A Shot starts as the welcome's full read reads the machine's settings.
      const held = tablet.holdRequests("GET", "/machine/settings");
      await expect.poll(() => held.arrived).toBe(1);
      tablet.reportState("espresso", "pouring");
      held.release();

      // The read under way is sent, and so is every collection the pass reaches after the machine's.
      const after = ["plugins", "skins", "pairedDevices", "scaleInfo", "sensors"];
      await expect.poll(() => after.filter((name) => sent(name).length < 1)).toEqual([]);
      expect(sent("machineSettings")).toHaveLength(1);
      const rest = ["advancedSettings", "machineCalibration", "sensorCalibration"];
      expect(rest.map((name) => sent(name).length)).toEqual([0, 0, 0]);
      expect(fromMachineSince(tablet, 0)).toEqual(["/machine/settings"]);

      tablet.reportState("idle", "idle");
      tablet.pullShot(derivedShot("mid-pass-40306"));
      await expect.poll(() => rest.map((name) => sent(name).length)).toEqual([1, 1, 1]);
      // The machine's settings, read before the Shot, are not read again with the rest: any later read of them is on their
      // interval, a minute after that one.
      const [first, ...later] = readTimes(tablet, "/machine/settings");
      for (const time of later) expect(time - first!).toBeGreaterThan(55_000);
    } finally {
      await standIn.stop();
    }
  });

  it("hold up nothing else while they wait: the server's Library writes are carried out, and DYE2's recipes and the Tablet Settings read and sent", async () => {
    const standIn = await StandInServer.start();
    try {
      const { tablet, served, sent } = standInTablet(standIn, "40307", 50);
      await expect.poll(() => COLLECTION_NAMES.map((name) => sent(name).length)).toEqual(COLLECTION_NAMES.map(() => 1));

      tablet.reportState("steam", "steaming");
      const since = tablet.requests.length;
      // Derived: a recipe saved in DYE2, and Decaid's own settings changed, while a read of the machine waits.
      const recipes = served["/store/dye2.reaplugin/recipes"] as Record<string, unknown>[];
      const settings = served["/settings"] as Record<string, unknown>;
      tablet.serve({ ...served, "/store/dye2.reaplugin/recipes": [{ ...recipes[0], name: "Saved while steaming" }, ...recipes.slice(1)], "/settings": { ...settings, weightFlowMultiplier: 1.5 } });
      await tablet.changeSettings({ steamSettings: { flow: 1.5 } });
      await expect.poll(() => [sent("dye2Recipes").length, sent("appSettings").length]).toEqual([2, 2]);
      const write = { type: "write", id: "basket-40307", kind: "basket", globalId: randomUUID(), localId: null, fields: { name: "Written while steaming" } } as const;
      expect(await standIn.ask(write)).toMatchObject({ type: "written" });
      expect(fromMachineSince(tablet, since)).toEqual([]);

      tablet.reportState("idle", "idle");
      await expect.poll(() => sent("machineSettings").length).toBe(2);
    } finally {
      await standIn.stop();
    }
  });
});
