import { randomUUID } from "node:crypto";
import { COLLECTION_NAMES } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { LoadedTablets, type syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import {
  type DecaidApi,
  RawConnection,
  Refusal,
  type SimulatedTablet,
  type SimulatedTabletOptions,
  de1ProOnDecaid090,
  derivedDe1Pro,
  helloWith,
  manyProfiles,
  sensorCalibration,
  settingsFor,
  simulatedDevices,
  simulatedDevicesSwitchedOff,
  simulatedLibrary,
  skinsAt,
} from "./support/simulated-tablet.js";
import { SimulatedDye2, dye2Migrated } from "./support/simulated-dye2.js";
import { StandInServer } from "./support/stand-in-server.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #14: the built plugin in a simulated tablet, or raw
// frames, against real servers sharing one PostgreSQL database, with every
// assertion made through the REST API. Collections are those Decaid v0.8.7
// sent, from the test tablet or from Decaid's simulated devices (see the
// fixtures' READMEs), or derived from them by the changes named; serials are
// made up.

interface Summary { name: string; available: boolean; reportedAt: string; receivedAt: string | null; items: number | null }
interface Collection extends Summary { value: unknown; utcOffsetMinutes: number | null }
interface Device { id: string; type: string | null; model: string | null; vendor: string | null; state: string | null; firmware: string | null; batteryLevel: number | null }
interface PairedDevices {
  reportedAt: string | null;
  available: boolean | null;
  receivedAt: string | null;
  scale: Device | null;
  auxiliaryScale: Device | null;
  sensors: Device[];
  others: Device[];
}
interface Frame { type: string; id?: string; name?: string; available?: boolean; value?: unknown }

const frameType = (frame: unknown) => (frame as Frame).type;
const device = (type: string, id: string, model: string, state: string, vendor: string | null = null): Device =>
  ({ id, type, model, vendor, state, firmware: null, batteryLevel: null });

describe("Library, settings and paired devices", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets = new LoadedTablets();
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterEach(async () => {
    const used = await tablets.unloadAll();
    // The plugin only reads Decaid's API, DYE2's storage included, for a Machine at no Location, as all of these are.
    for (const tablet of used) expect(tablet.writes).toEqual([]);
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /** A simulated tablet with the Machine's token, polling every 5 s (0.1 s here), its machine reporting hardware of its own unless given an API. */
  function load(machine: CreatedMachine, options: Parameters<typeof syncingTablet>[2] = {}) {
    return tablets.syncing(machine, server, { api: derivedDe1Pro({ serial: machine.machine.id.replaceAll("-", "").slice(0, 12) }), ...options });
  }
  const summaries = async (machine: CreatedMachine, at = api) =>
    (await at.get<{ collections: Summary[] }>(`/machines/${machine.machine.id}/collections`)).collections;
  const collection = async (machine: CreatedMachine, name: string, at = api) =>
    (await at.get<{ collection: Collection | null }>(`/machines/${machine.machine.id}/collections/${name}`)).collection;
  const pairedDevices = async (machine: CreatedMachine) =>
    (await api.get<{ pairedDevices: PairedDevices }>(`/machines/${machine.machine.id}/paired-devices`)).pairedDevices;
  /** Each collection's latest report and value, by name. */
  async function collections(machine: CreatedMachine, at = api): Promise<Record<string, Pick<Collection, "available" | "value">>> {
    const found = await Promise.all((await summaries(machine, at)).map((summary) => collection(machine, summary.name, at)));
    return Object.fromEntries(found.map((found) => [found!.name, { available: found!.available, value: found!.value }]));
  }
  const allReported = async (machine: CreatedMachine) => (await summaries(machine)).length === COLLECTION_NAMES.length;

  /** The collection deliveries the plugin sent whole, of one collection or all. */
  const deliveries = (tablet: SimulatedTablet, name?: string) =>
    tablet.sent.filter((frame): frame is Frame => frameType(frame) === "collection" && (name === undefined || (frame as Frame).name === name));
  /** How many of each collection the plugin has sent. */
  const sentCounts = (tablet: SimulatedTablet) =>
    Object.fromEntries(COLLECTION_NAMES.map((name) => [name, deliveries(tablet, name).length]));
  /** Resolves once the server has acknowledged every collection delivery the plugin sent. */
  const allAcknowledged = (tablet: SimulatedTablet) => expect.poll(() => tablet.acknowledgedEvery((frame) => frameType(frame) === "collection")).toBe(true);
  /**
   * Resolves once the plugin has read `route` at least `count` more times:
   * by default the sensors, which each poll reads last, so that many polls
   * have run; for the machine's own settings, that many of their reads.
   */
  async function polls(tablet: SimulatedTablet, count: number, route = "/sensors") {
    const before = tablet.requests.filter((request) => request === route).length;
    await expect.poll(() => tablet.requests.filter((request) => request === route).length).toBeGreaterThanOrEqual(before + count);
  }
  /** When the plugin read `route`, by the tablet's clock, in order. */
  const readTimes = (tablet: SimulatedTablet, route: string) =>
    tablet.requests.flatMap((request, index) => (request === route ? [tablet.requestedAt[index]!] : []));
  /** The time between each of the times given and the next. */
  const gaps = (times: number[]) => times.slice(1).map((time, index) => time - times[index]!);
  /** Where the machine's own settings are read, which Decaid reads from the machine itself on each request. */
  const MACHINE_SETTINGS_ROUTES = ["/machine/settings", "/machine/settings/advanced", "/machine/calibration"];
  /** Where the sensor calibration is read, each route once. */
  const SENSOR_CALIBRATION_ROUTES = ["/machine/calibration/flow", "/machine/calibration/pressure", "/machine/calibration/temperature"];
  /** The sensor calibration Decaid answers from `served`, by target, as the plugin reports it. */
  const sensorCalibrationIn = (served: DecaidApi) =>
    Object.fromEntries(["flow", "pressure", "temperature"].map((target) => [target, served[`/machine/calibration/${target}`]]));

  /** The Skins Decaid answers from `served`, as the plugin reports them. */
  const skinsIn = (served: DecaidApi) => ({ skins: served["/webui/skins"], default: served["/webui/skins/default"], server: served["/webui/server/status"] });
  const tabletVersions = async (machine: CreatedMachine) =>
    (await api.get<{ tabletVersions: unknown }>(`/machines/${machine.machine.id}/tablet-versions`)).tabletVersions;

  async function connect(machine: CreatedMachine, url = server.url, hardware?: { model: string; serial: string }) {
    return RawConnection.welcomed(url, helloWith(machine.token, hardware ? { machine: hardware } : {}));
  }
  const report = (name: string, value?: unknown) =>
    value === undefined
      ? { type: "collection", id: randomUUID(), name, available: false }
      : { type: "collection", id: randomUUID(), name, available: true, value };

  const paired = (inventory: unknown) => (inventory as { state: string }[]).filter((entry) => entry.state !== "discovered");

  it("requires a Machine, and knows only the collections tablets report", async () => {
    const machine = await api.createMachine("Nothing reported");
    for (const path of ["/collections", "/collections/beans", "/paired-devices", "/tablet-versions"]) {
      for (const id of [randomUUID(), "not-a-machine"]) expect((await api.call("GET", `/machines/${id}${path}`)).status).toBe(404);
    }
    expect((await api.call("GET", `/machines/${machine.machine.id}/collections/recipes`)).status).toBe(404);
    expect(await summaries(machine)).toEqual([]);
    for (const name of COLLECTION_NAMES) expect(await collection(machine, name)).toBeNull();
    expect(await pairedDevices(machine)).toEqual({ reportedAt: null, available: null, receivedAt: null, scale: null, auxiliaryScale: null, sensors: [], others: [] });
    expect(await tabletVersions(machine)).toEqual({ dye2: { status: "notReported" }, streamline: { status: "notReported" } });
  });

  it("stores every collection on connect as Decaid sent it, archived records, hidden profiles and unavailable ones included", async () => {
    const machine = await api.createMachine("Every collection");
    const served: DecaidApi = { ...derivedDe1Pro({ serial: "30001" }), ...simulatedLibrary(), ...simulatedDevices() };
    const connectedAt = Date.now();
    load(machine, { api: served });
    await expect.poll(() => allReported(machine)).toBe(true);

    const reported = await collections(machine);
    const value = (route: string) => ({ available: true, value: served[route] });
    expect(reported).toEqual({
      beans: value("/beans"),
      beanBatches: value("/bean-batches"),
      grinders: value("/grinders"),
      profiles: value("/profiles"),
      dye2Recipes: value("/store/dye2.reaplugin/recipes"),
      // DYE2 has never written it, so Decaid answers null, which the plugin reports as DYE2 reads it: an empty list.
      dye2Equipment: { available: true, value: [] },
      dye2Baskets: value("/store/dye2.reaplugin/baskets"),
      appSettings: value("/settings"),
      presenceSettings: value("/presence/settings"),
      machineSettings: value("/machine/settings"),
      advancedSettings: value("/machine/settings/advanced"),
      machineCalibration: value("/machine/calibration"),
      sensorCalibration: { available: true, value: sensorCalibrationIn(served) },
      // Decaid lists the plugin itself, loaded; this tablet has no DYE2.
      plugins: { available: true, value: [expect.objectContaining({ id: "decent-sync.reaplugin", loaded: true, source: null })] },
      skins: { available: true, value: skinsIn(served) },
      pairedDevices: { available: true, value: paired(served["/devices"]) },
      scaleInfo: value("/scale/info"),
      sensors: value("/sensors"),
    });
    // Archived and hidden records are included.
    const archived = (name: string) => (reported[name]!.value as { archived?: boolean }[]).filter((record) => record.archived === true);
    for (const name of ["beans", "beanBatches", "grinders"]) expect(archived(name)).toHaveLength(1);
    expect((reported.profiles!.value as { visibility: string }[]).map((profile) => profile.visibility)).toContain("hidden");

    const listed = await summaries(machine);
    expect(listed.map((summary) => summary.name)).toEqual([...COLLECTION_NAMES]);
    for (const summary of listed) {
      expect(Date.parse(summary.reportedAt)).toBeGreaterThanOrEqual(connectedAt - 1_000);
      expect(summary.receivedAt === null).toBe(!summary.available);
      const value = reported[summary.name]!.value;
      expect(summary.items).toBe(Array.isArray(value) ? value.length : null);
    }
    expect(listed.find((summary) => summary.name === "beans")).toMatchObject({ items: 2 });
  });

  it("sends a changed collection at the next poll and an unchanged one never again, until a reconnect sends every one in full", async () => {
    const machine = await api.createMachine("Polled");
    let served = de1ProOnDecaid090();
    const tablet = load(machine, { api: served });
    await expect.poll(() => allReported(machine)).toBe(true);
    await allAcknowledged(tablet);
    await polls(tablet, 3);
    const initial = sentCounts(tablet);
    expect(Object.values(initial).every((count) => count === 1)).toBe(true);

    // Derived: the tablet's machine settings and flow calibration changed, read on their own interval, and its DYE2
    // recipe renamed in DYE2.
    const recalibrated = { ...(served["/machine/settings"] as object), steamFlow: 1.5 };
    const calibration = { flowMultiplier: 0.6 };
    const recipes = (served["/store/dye2.reaplugin/recipes"] as Record<string, unknown>[]).map((recipe) => ({ ...recipe, name: "Sep 26th Eth, coarser" }));
    served = { ...served, "/machine/settings": recalibrated, "/machine/calibration": calibration, "/store/dye2.reaplugin/recipes": recipes };
    tablet.serve(served);
    await expect.poll(async () => (await collection(machine, "machineSettings"))?.value).toEqual(recalibrated);
    await expect.poll(async () => (await collection(machine, "machineCalibration"))?.value).toEqual(calibration);
    await expect.poll(async () => (await collection(machine, "dye2Recipes"))?.value).toEqual(recipes);
    await polls(tablet, 5);
    expect(sentCounts(tablet)).toEqual({ ...initial, machineSettings: 2, machineCalibration: 2, dye2Recipes: 2 });
    // The library's lists were read with their ETags, which Decaid answered 304.
    expect(tablet.requests.filter((route) => route === "/beans").length).toBeGreaterThan(5);
    await allAcknowledged(tablet);

    // A reconnect sends every collection again, whole, whether or not it or its ETag changed.
    const sentBefore = tablet.sent.length;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(() => sentCounts(tablet)).toEqual(
      Object.fromEntries(COLLECTION_NAMES.map((name) => [name, initial[name]! + (["machineSettings", "machineCalibration", "dye2Recipes"].includes(name) ? 2 : 1)])),
    );
    const resent = tablet.sent.slice(sentBefore).filter((frame): frame is Frame => frameType(frame) === "collection");
    expect(resent.find((frame) => frame.name === "beans")).toMatchObject({ available: true, value: served["/beans"] });
    expect(resent.find((frame) => frame.name === "dye2Equipment")).toMatchObject({ available: true, value: [] });
    await allAcknowledged(tablet);
    expect((await collections(machine)).beans).toEqual({ available: true, value: served["/beans"] });
  });

  it("reports the plugin list and the Skins, each change at the next poll, and shows the tablet's DYE2 and Streamline", async () => {
    const machine = await api.createMachine("Plugins and Skins");
    const dye2 = new SimulatedDye2();
    const served: DecaidApi = { ...derivedDe1Pro({ serial: "30006" }), ...dye2Migrated() };
    const tablet = load(machine, { api: served, dye2 });
    await expect.poll(() => allReported(machine)).toBe(true);
    // As Decaid sent them: DYE2's entry beside the plugin's own, and the three Skins routes' answers.
    const plugins = async () => (await collection(machine, "plugins"))!.value as Record<string, unknown>[];
    expect(await plugins()).toEqual([dye2.listing(), expect.objectContaining({ id: "decent-sync.reaplugin", loaded: true })]);
    expect((await collection(machine, "skins"))!.value).toEqual(skinsIn(served));
    // The test tablet's: DYE2's release, and Streamline's release served, though its build of main is the default.
    expect(await tabletVersions(machine)).toEqual({
      dye2: { status: "installed", version: "0.1.26", loaded: true, branch: null },
      streamline: { status: "active", version: "0.2.18", build: "release" },
    });
    await allAcknowledged(tablet);
    await polls(tablet, 3);
    const initial = sentCounts(tablet);
    expect(initial).toMatchObject({ plugins: 1, skins: 1 });

    // DYE2 disabled, then installed from its dist branch, which builds main.
    dye2.disable();
    await expect.poll(async () => ((await tabletVersions(machine)) as { dye2: unknown }).dye2).toEqual({
      status: "installed",
      version: "0.1.26",
      loaded: false,
      branch: null,
    });
    await dye2.install("branch");
    await expect.poll(async () => ((await tabletVersions(machine)) as { dye2: unknown }).dye2).toEqual({
      status: "installed",
      version: "0.1.26",
      loaded: true,
      branch: "dist",
    });
    expect((await plugins())[0]).toEqual(dye2.listing());

    // Decaid serves another Skin, as Quick Settings can, without changing the default.
    const switched = { ...served, ...skinsAt("servedOther") };
    tablet.serve(switched);
    await expect.poll(async () => ((await tabletVersions(machine)) as { streamline: unknown }).streamline).toEqual({
      status: "notActive",
      activeSkin: { name: "Passione", version: "0.9.6" },
    });
    expect((await collection(machine, "skins"))!.value).toEqual(skinsIn(switched));
    // Each change was sent once, and nothing unchanged again.
    await polls(tablet, 3);
    expect(sentCounts(tablet)).toEqual({ ...initial, plugins: 3, skins: 2 });
  });

  it("reports a read that fails or has nothing to report as unavailable, keeping the value known", async () => {
    const machine = await api.createMachine("Unavailable");
    const served: DecaidApi = { ...derivedDe1Pro({ serial: "30002" }), ...simulatedDevices() };
    const tablet = load(machine, { api: served });
    await expect.poll(() => allReported(machine)).toBe(true);
    const before = await collections(machine);
    expect(before.scaleInfo).toEqual({ available: true, value: {} });
    expect((await pairedDevices(machine)).scale).toEqual(device("scale", "MockScale", "Mock Scale", "connected"));

    // The machine and the scale are switched off, and the grinders cannot be read for a while.
    tablet.machineConnected = false;
    tablet.serve({ ...served, ...simulatedDevicesSwitchedOff() });
    tablet.failNextApiReads("/grinders", 1_000);
    await expect.poll(async () => (await collection(machine, "scaleInfo"))?.available).toBe(false);
    await expect.poll(async () => (await collection(machine, "grinders"))?.available).toBe(false);
    await expect.poll(async () => (await collection(machine, "machineSettings"))?.available).toBe(false);
    const after = await collections(machine);
    for (const name of ["scaleInfo", "grinders", "machineSettings", "advancedSettings", "machineCalibration"]) {
      expect(after[name]).toEqual({ available: false, value: before[name]!.value });
    }
    const scaleInfo = (await collection(machine, "scaleInfo"))!;
    expect(Date.parse(scaleInfo.reportedAt)).toBeGreaterThan(Date.parse(scaleInfo.receivedAt!));
    // A DYE2 key never written is an empty list, not a read with nothing to report.
    expect(await collection(machine, "dye2Equipment")).toMatchObject({ available: true, value: [], items: 0 });
    // A disconnected scale shows no firmware or battery level, which only a connected one reports.
    expect((await pairedDevices(machine)).scale).toEqual(device("scale", "MockScale", "Mock Scale", "disconnected"));
    // Sent once each time the collection became unavailable.
    await polls(tablet, 3);
    expect(sentCounts(tablet)).toMatchObject({ scaleInfo: 2, grinders: 2, machineSettings: 2, advancedSettings: 2, machineCalibration: 2, dye2Equipment: 1 });
    // A DYE2 key whose read fails is unavailable, never taken as empty.
    tablet.failNextApiReads("/store/dye2.reaplugin/equipment", 1_000);
    await expect.poll(async () => (await collection(machine, "dye2Equipment"))?.available).toBe(false);
    expect(await collection(machine, "dye2Equipment")).toMatchObject({ value: [], items: 0 });
    tablet.failNextApiReads("/store/dye2.reaplugin/equipment", 0);

    // Readable again, the grinders are sent again, though unchanged.
    tablet.failNextApiReads("/grinders", 0);
    await expect.poll(async () => (await collection(machine, "grinders"))?.available).toBe(true);
    expect((await collections(machine)).grinders).toEqual(before.grinders);
  });

  it("leaves devices only discovered nearby out of the paired devices, and does not resend them as such devices come and go", async () => {
    const machine = await api.createMachine("Discovered nearby");
    const served: DecaidApi = { ...derivedDe1Pro({ serial: "30003" }), ...simulatedDevices() };
    const tablet = load(machine, { api: served });
    await expect.poll(() => allReported(machine)).toBe(true);
    const inventory = served["/devices"] as { id: string; state: string; name: string }[];
    expect(inventory.find((entry) => entry.id === "MockBengle")).toMatchObject({ state: "discovered" });

    const reported = await collection(machine, "pairedDevices");
    expect((reported!.value as { id: string }[]).map((entry) => entry.id)).toEqual(["MockScale", "MockDe1", "mockDebugPort", "mockSensorBasket"]);
    const view = await pairedDevices(machine);
    expect(view).toEqual({
      reportedAt: reported!.reportedAt,
      available: true,
      receivedAt: reported!.receivedAt,
      scale: device("scale", "MockScale", "Mock Scale", "connected"),
      auxiliaryScale: null,
      sensors: [device("sensor", "mockDebugPort", "DebugPort", "connected", "DecentEspresso"), device("sensor", "mockSensorBasket", "SensorBasket", "connected", "DecentEspresso")],
      others: [device("machine", "MockDe1", "MockDe1", "connected")],
    });
    expect(JSON.stringify(view)).not.toContain("MockBengle");

    // Derived: the nearby machine leaves, and another one comes into range.
    await allAcknowledged(tablet);
    const bengle = inventory.find((entry) => entry.id === "MockBengle")!;
    tablet.serve({ ...served, "/devices": inventory.filter((entry) => entry !== bengle) });
    await polls(tablet, 3, "/devices");
    tablet.serve({ ...served, "/devices": [...inventory, { ...bengle, id: "MockBengle2", name: "MockBengle2" }] });
    await polls(tablet, 3, "/devices");
    expect(deliveries(tablet, "pairedDevices")).toHaveLength(1);

    // Derived: the scale connected as an auxiliary scale instead, with none weighing shots.
    tablet.serve({ ...served, "/devices": inventory.map((entry) => (entry.id === "MockScale" ? { ...entry, connectionRole: "auxiliary" } : entry)) });
    await expect.poll(async () => (await pairedDevices(machine)).auxiliaryScale).toEqual(device("scale", "MockScale", "Mock Scale", "connected"));
    expect((await pairedDevices(machine)).scale).toBeNull();
  });

  it("shows the scale Decaid prefers while it is off, as the test tablet's is", async () => {
    const machine = await api.createMachine("Scale off");
    load(machine, { api: derivedDe1Pro({ serial: "30004" }) });
    await expect.poll(() => allReported(machine)).toBe(true);
    expect(await pairedDevices(machine)).toMatchObject({
      scale: device("scale", "00:00:5E:00:53:02", "Bookoo Mini Scale", "disconnected"),
      auxiliaryScale: null,
      sensors: [],
      others: [device("machine", "00:00:5E:00:53:01", "DE1", "connected")],
    });
    expect(await collection(machine, "scaleInfo")).toMatchObject({ available: false, value: null });
  });

  it("sends a profiles collection larger than 1 MiB in chunks within Decaid's limit, and stores it intact", async () => {
    const machine = await api.createMachine("Many profiles");
    const profiles = manyProfiles();
    expect(Buffer.byteLength(JSON.stringify(profiles))).toBeGreaterThan(1024 * 1024);
    const tablet = load(machine, { api: { ...derivedDe1Pro({ serial: "30005" }), "/profiles": profiles } });
    await expect.poll(async () => (await collection(machine, "profiles"))?.items).toBe(profiles.length);
    // As Decaid lists them: the most recently updated first.
    expect((await collection(machine, "profiles"))!.value).toEqual(tablet.profiles());
    expect(tablet.sent.some((frame) => frameType(frame) === "chunk")).toBe(true);
    expect(tablet.peakPendingOutboundBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(tablet.refusedSends).toBe(0);
  });

  it("gives a mismatched connection's collections to the Machine that has its hardware, leaving the token's Machine its own", async () => {
    const traveller = await api.createMachine("Traveller's own");
    const home = load(traveller, { api: derivedDe1Pro({ serial: "30101" }) });
    await expect.poll(() => allReported(traveller)).toBe(true);
    await home.unload();
    const own = await collections(traveller);

    const owner = await api.createMachine("Owner of 30102");
    await (await connect(owner, server.url, { model: "DE1Pro", serial: "30102" })).close();
    // The tablet moves onto Owner's machine, still with Traveller's token, and its library and devices differ.
    const moved = load(traveller, { api: { ...derivedDe1Pro({ serial: "30102" }), ...simulatedLibrary(), ...simulatedDevices() } });
    await api.waitForMachine("Traveller's own", (machine) => machine.online && machine.identification === "mismatch");
    await expect.poll(() => allReported(owner)).toBe(true);
    await allAcknowledged(moved);
    expect((await collections(owner)).beans).toEqual({ available: true, value: simulatedLibrary()["/beans"] });
    expect((await pairedDevices(owner)).scale).toEqual(device("scale", "MockScale", "Mock Scale", "connected"));
    expect(await collections(traveller)).toEqual(own);
  });

  it("holds a mismatched connection's collections for hardware without a Machine, and hands them to the machine entry created for it", async () => {
    const traveller = await api.createMachine("Before adoption");
    const home = load(traveller, { api: derivedDe1Pro({ serial: "30201" }) });
    await expect.poll(() => allReported(traveller)).toBe(true);
    await home.unload();
    const own = await collections(traveller);

    const moved = load(traveller, { api: { ...derivedDe1Pro({ serial: "30202" }), ...simulatedLibrary(), ...simulatedDevices() } });
    await api.waitForMachine("Before adoption", (machine) => machine.online && machine.identification === "mismatch");
    await expect.poll(() => deliveries(moved).length).toBeGreaterThanOrEqual(COLLECTION_NAMES.length);
    await allAcknowledged(moved);
    expect(await collections(traveller)).toEqual(own);
    await moved.unload();

    const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "30202")!;
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: "Adopted 30202" }));
    const handed = await collections(adopted);
    expect(Object.keys(handed)).toEqual([...COLLECTION_NAMES]);
    expect(handed.beans).toEqual({ available: true, value: simulatedLibrary()["/beans"] });
    expect(handed.machineSettings).toEqual({ available: true, value: simulatedLibrary()["/machine/settings"] });
    expect((await pairedDevices(adopted)).sensors).toHaveLength(2);
    expect(await collections(traveller)).toEqual(own);
  });

  it("merges what a Pending Machine holds into a Machine that binds its hardware: the latest report says whether each is available, and the latest value is kept", async () => {
    const machine = await api.createMachine("Binds later");
    const visitor = await api.createMachine("Visitor");
    const hardware = { model: "DE1Pro", serial: "30301" };
    const tablet = de1ProOnDecaid090();
    const simulated = { ...simulatedLibrary(), ...simulatedDevices() };
    // Derived: the tablet's machine settings as the visitor's tablet later read them, recalibrated.
    const recalibrated = { ...(tablet["/machine/settings"] as object), steamFlow: 1.5 };
    // The Machine's tablet connects before its machine is on.
    const early = await connect(machine);
    await early.deliver(report("machineSettings", tablet["/machine/settings"]));
    await early.deliver({ ...report("appSettings", tablet["/settings"]), utcOffsetMinutes: -300 });
    await early.deliver(report("scaleInfo"));
    await early.deliver(report("sensors", tablet["/sensors"]));
    await early.close();
    // The visitor's tablet, moved onto that machine, reports newer values, which its Pending Machine holds.
    await (await connect(visitor, other.url, { model: "DE1Pro", serial: "30302" })).close();
    const mismatched = await connect(visitor, other.url, hardware);
    await mismatched.deliver(report("machineSettings", recalibrated));
    // The same app settings, read after a daylight saving change.
    await mismatched.deliver({ ...report("appSettings", tablet["/settings"]), utcOffsetMinutes: -240 });
    await mismatched.deliver(report("scaleInfo", simulated["/scale/info"]));
    await mismatched.deliver(report("sensors", simulated["/sensors"]));
    await mismatched.deliver(report("advancedSettings", tablet["/machine/settings/advanced"]));
    await mismatched.close();
    // Then the Machine's tablet cannot read its sensors, after the visitor's report.
    const again = await connect(machine);
    await again.deliver(report("sensors"));
    await again.close();

    // The Machine's tablet reports the hardware: its token binds it, and the Machine takes over what was held.
    await (await connect(machine, server.url, hardware)).close();
    expect(await collections(machine)).toEqual({
      appSettings: { available: true, value: tablet["/settings"] },
      machineSettings: { available: true, value: recalibrated },
      advancedSettings: { available: true, value: tablet["/machine/settings/advanced"] },
      scaleInfo: { available: true, value: simulated["/scale/info"] },
      sensors: { available: false, value: simulated["/sensors"] },
    });
    // The UTC offset goes with the value it was read with.
    expect((await collection(machine, "appSettings"))!.utcOffsetMinutes).toBe(-240);
    expect(await summaries(visitor)).toEqual([]);
    expect((await api.pendingMachines()).some((pending) => pending.serial === hardware.serial)).toBe(false);
  });

  it("stores each delivery once, so a resend through another instance never replaces a newer value, whether the first is still being stored or arrives again last", async () => {
    const machine = await api.createMachine("Resent");
    const hardware = { model: "DE1Pro", serial: "30401" };
    const first = await connect(machine, server.url, hardware);
    // Derived: the tablet's machine settings with two fan thresholds.
    const settings = de1ProOnDecaid090()["/machine/settings"] as object;
    const older = report("machineSettings", { ...settings, fan: 40 });
    const newer = report("machineSettings", { ...settings, fan: 45 });
    const database = await server.connectDatabase();
    let second: RawConnection;
    try {
      // Holds the delivery once it has locked its Machine and recorded its id, as it writes the value.
      await database.query("BEGIN");
      await database.query("LOCK TABLE reported_collections IN SHARE MODE");
      first.send(older);
      await waitForLockWaits(server, { relation: "reported_collections" });
      // Its connection drops, and the plugin connects again through another instance. That hello waits for the
      // Machine the first delivery holds, as does releasing the dropped connection, so nothing is sent again yet.
      await first.terminate();
      second = await RawConnection.open(other.url);
      second.send(helloWith(machine.token, { machine: hardware }));
      await waitForLockWaits(server, { count: 3 });
      expect(second.messages).toEqual([]);
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
    expect(await second.message(0)).toMatchObject({ type: "welcome" });
    second.keepAlive();
    // The plugin sends it again, ahead of the newer one, as its outbox does.
    await second.deliver(older);
    await second.deliver(newer);
    expect(await collection(machine, "machineSettings", api.at(other.url))).toMatchObject({ available: true, value: newer.value });
    // Arriving again last, after other changes, it changes nothing.
    const third = await connect(machine, server.url, hardware);
    await third.deliver(older);
    expect((await collection(machine, "machineSettings"))!.value).toEqual(newer.value);
  });

  it("records when a value delivered again was reported and received, and stores a changed one", async () => {
    const machine = await api.createMachine("Reconnecting");
    const hardware = { model: "DE1Pro", serial: "31001" };
    const profiles = de1ProOnDecaid090()["/profiles"] as Record<string, unknown>[];
    const first = await connect(machine, server.url, hardware);
    await first.deliver(report("profiles", profiles));
    const before = (await collection(machine, "profiles"))!;
    await first.close();

    // A reconnect, through any instance, sends it again unchanged.
    const second = await connect(machine, other.url, hardware);
    await second.deliver(report("profiles", profiles));
    const resent = (await collection(machine, "profiles"))!;
    expect(resent).toMatchObject({ available: true, value: profiles, items: profiles.length });
    expect(Date.parse(resent.reportedAt)).toBeGreaterThan(Date.parse(before.reportedAt));
    expect(Date.parse(resent.receivedAt!)).toBeGreaterThan(Date.parse(before.receivedAt!));

    // Derived: one profile renamed, and one deleted.
    const changed = profiles.slice(1).map((profile, index) => (index === 0 ? { ...profile, title: "Londonium, longer" } : profile));
    await second.deliver(report("profiles", changed));
    expect(await collection(machine, "profiles")).toMatchObject({ available: true, value: changed, items: changed.length });
  });

  it("does not write a value delivered again, keeping the TOAST data that holds it", async (context) => {
    const database = await server.connectDatabase();
    try {
      // Writing a value again stores new TOAST chunks, under a new id, and deletes the old ones. Before
      // PostgreSQL 17, no function names that id, and only a superuser may read the TOAST relation.
      const { rows } = await database.query<{ version: number }>("SELECT current_setting('server_version_num')::int AS version");
      if (rows[0]!.version < 170000) context.skip("pg_column_toast_chunk_id() needs PostgreSQL 17 or later");

      const machine = await api.createMachine("Reconnecting to TOAST");
      const hardware = { model: "DE1Pro", serial: "31002" };
      const profiles = de1ProOnDecaid090()["/profiles"] as Record<string, unknown>[];
      const toastId = async () =>
        (
          await database.query<{ id: string | null }>(
            "SELECT pg_column_toast_chunk_id(value)::text AS id FROM reported_collections WHERE machine_id = $1 AND name = 'profiles'",
            [machine.machine.id],
          )
        ).rows[0]!.id;
      const first = await connect(machine, server.url, hardware);
      await first.deliver(report("profiles", profiles));
      const stored = await toastId();
      // Large enough to be kept out of line, as profiles usually are.
      expect(stored).not.toBeNull();
      await first.close();

      // A reconnect, through any instance, sends it again unchanged; then it is unavailable, then the same again.
      const second = await connect(machine, other.url, hardware);
      for (const again of [report("profiles", profiles), report("profiles"), report("profiles", profiles)]) {
        await second.deliver(again);
        expect(await toastId()).toBe(stored);
      }

      // Derived: one profile renamed. A changed value is written.
      await second.deliver(report("profiles", profiles.map((profile, index) => (index === 0 ? { ...profile, title: "Londonium, longer" } : profile))));
      expect(await toastId()).not.toBe(stored);
    } finally {
      await database.end();
    }
  });

  it("stores a mismatched connection's collection once, for the Machine that has its hardware or its Pending Machine, however often it arrives", async () => {
    const owner = await api.createMachine("Owner of 30901");
    await (await connect(owner, server.url, { model: "DE1Pro", serial: "30901" })).close();
    const visitor = await api.createMachine("Visitor of 30901");
    await (await connect(visitor, server.url, { model: "DE1Pro", serial: "30902" })).close();
    // Derived: the tablet's machine settings with two fan thresholds.
    const settings = de1ProOnDecaid090()["/machine/settings"] as object;
    // The visitor's tablet moves onto the owner's machine, then onto one no Machine has.
    for (const serial of ["30901", "30903"]) {
      const hardware = { model: "DE1Pro", serial };
      const older = report("machineSettings", { ...settings, fan: 40 });
      const first = await connect(visitor, server.url, hardware);
      await first.deliver(older);
      await first.close();
      // After a newer read, the first delivery again, through another instance, as after a lost acknowledgment.
      const second = await connect(visitor, other.url, hardware);
      await second.deliver(report("machineSettings", { ...settings, fan: 45 }));
      await second.deliver(older);
      await second.close();
    }
    const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "30903")!;
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: "Adopted 30903" }));
    for (const credited of [owner, adopted]) {
      expect(await collection(credited, "machineSettings")).toMatchObject({ available: true, value: { ...settings, fan: 45 } });
    }
    expect(await summaries(visitor)).toEqual([]);
  });

  it("sends a collection delivery a dropped connection left unacknowledged again, under its id, ahead of a newer read of it", async () => {
    const machine = await api.createMachine("Unacknowledged");
    let stalled = false;
    const served = derivedDe1Pro({ serial: "30501" });
    // Each read of Decaid's API takes 1 s (20 ms here), so a poll's reads, one after another, take longer than its interval.
    const tablet = load(machine, {
      api: served,
      apiDelayMs: 1_000,
      stallUpload: (frame) => stalled && frameType(frame) === "collection" && (frame as Frame).name === "appSettings",
    });
    await expect.poll(() => allReported(machine)).toBe(true);
    await allAcknowledged(tablet);

    // Derived: the tablet's app settings with two log levels, one after the other.
    const settings = served["/settings"] as Record<string, unknown>;
    const older = { ...settings, logLevel: "FINE" };
    const newer = { ...settings, logLevel: "WARNING" };
    stalled = true;
    tablet.serve({ ...served, "/settings": older });
    await expect.poll(() => deliveries(tablet, "appSettings").length).toBe(2);
    const unacknowledged = deliveries(tablet, "appSettings")[1]!;
    expect(unacknowledged.value).toEqual(older);

    // As a poll starts reading, its connection drops, and the next takes a while: the poll reads the
    // newer settings while disconnected, after the older delivery was sent and before it is sent again.
    await polls(tablet, 1, "/beans");
    tablet.serve({ ...served, "/settings": newer });
    tablet.failNextApiReads("/info", 4);
    tablet.dropConnections();
    stalled = false;
    await tablet.waitForLogs(/^Connected to /, 2, 20_000);
    await expect.poll(async () => (await collection(machine, "appSettings"))?.value).toEqual(newer);
    await allAcknowledged(tablet);
    const sent = deliveries(tablet, "appSettings").slice(2);
    expect(sent[0]).toEqual(unacknowledged);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.slice(1).every((frame) => JSON.stringify(frame.value) === JSON.stringify(newer))).toBe(true);
    expect((await collection(machine, "appSettings"))!.value).toEqual(newer);
  });

  it("keeps a value read while the outbox was busy ahead of a later read that found the collection unavailable", async () => {
    const machine = await api.createMachine("Busy outbox");
    let stalled = false;
    const served = derivedDe1Pro({ serial: "30601" });
    const tablet = load(machine, {
      api: served,
      stallUpload: (frame) => stalled && frameType(frame) === "collection" && (frame as Frame).name === "dye2Baskets",
    });
    await expect.poll(() => allReported(machine)).toBe(true);
    await allAcknowledged(tablet);

    // Derived: DYE2's basket renamed, whose delivery then waits on the network, holding up the outbox.
    stalled = true;
    const baskets = (served["/store/dye2.reaplugin/baskets"] as Record<string, unknown>[]).map((basket) => ({ ...basket, name: "Decent 18g Ridged" }));
    tablet.serve({ ...served, "/store/dye2.reaplugin/baskets": baskets });
    await expect.poll(() => deliveries(tablet, "dye2Baskets").length).toBe(2);
    // Derived: the machine recalibrated, read and queued behind it; then the machine is switched off.
    const recalibrated = { ...(served["/machine/settings"] as object), steamFlow: 1.5 };
    tablet.serve({ ...served, "/store/dye2.reaplugin/baskets": baskets, "/machine/settings": recalibrated });
    await polls(tablet, 1, "/machine/settings");
    tablet.machineConnected = false;
    await polls(tablet, 1, "/machine/settings");
    stalled = false;

    await expect.poll(async () => (await collection(machine, "machineSettings"))?.available).toBe(false);
    await allAcknowledged(tablet);
    expect(await collections(machine)).toMatchObject({
      machineSettings: { available: false, value: recalibrated },
      dye2Baskets: { available: true, value: baskets },
    });
  });

  it("shows a connected scale's firmware and battery level, and sensors only Decaid's sensor list names, only while its tablet's inventory is current, and when the devices shown were read", async () => {
    const machine = await api.createMachine("Scale information");
    const raw = await connect(machine, server.url, { model: "DE1Pro", serial: "30701" });
    const simulated = simulatedDevices();
    // Derived: the mock scale's report with the two fields scale_handler.dart writes for a scale that reports
    // them, as a Skale2 does.
    const scaleInfo = { ...(simulated["/scale/info"] as object), firmwareVersion: "1.2.0", batteryLevel: 80 };
    // Derived: the inventory without its sensors, as Decaid's leaves out sensors such as a Bengle's milk probe,
    // which only its sensor list names.
    const inventory = (paired(simulated["/devices"]) as { type?: string }[]).filter((entry) => entry.type !== "sensor");
    const listedSensors = [
      device("sensor", "mockSensorBasket", "SensorBasket", "connected", "DecentEspresso"),
      device("sensor", "mockDebugPort", "DebugPort", "connected", "DecentEspresso"),
    ];
    await raw.deliver(report("appSettings", simulated["/settings"]));
    await raw.deliver(report("sensors", simulated["/sensors"]));
    // Before the inventory is read, nothing is shown, sensors included.
    expect(await pairedDevices(machine)).toEqual({ reportedAt: null, available: null, receivedAt: null, scale: null, auxiliaryScale: null, sensors: [], others: [] });
    await raw.deliver(report("pairedDevices", inventory));
    await raw.deliver(report("scaleInfo", scaleInfo));
    const read = await pairedDevices(machine);
    expect(read).toMatchObject({ available: true, receivedAt: read.reportedAt, sensors: listedSensors });
    expect(read.scale).toEqual({ ...device("scale", "MockScale", "Mock Scale", "connected"), firmware: "1.2.0", batteryLevel: 80 });

    // The inventory cannot be read: the devices shown are the last read, the scale's report may be another
    // scale's, and the sensor list may name sensors connected since.
    await raw.deliver(report("pairedDevices"));
    const stale = await pairedDevices(machine);
    expect(stale).toMatchObject({ available: false, receivedAt: read.receivedAt, sensors: [] });
    expect(Date.parse(stale.reportedAt!)).toBeGreaterThan(Date.parse(stale.receivedAt!));
    expect(stale.scale).toEqual(device("scale", "MockScale", "Mock Scale", "connected"));

    await raw.deliver(report("pairedDevices", inventory));
    expect(await pairedDevices(machine)).toMatchObject({ sensors: listedSensors, scale: { firmware: "1.2.0", batteryLevel: 80 } });
  });

  describe("The machine's own settings, which Decaid reads from the machine on each request", () => {
    it("are read every 60 s while connected, every other collection, Steam Records and the hardware check every poll interval", async () => {
      const machine = await api.createMachine("Machine settings polled");
      const tablet = load(machine);
      await expect.poll(() => allReported(machine)).toBe(true);
      // The welcome's read of them, and two on their interval.
      await expect.poll(() => readTimes(tablet, "/machine/settings").length).toBeGreaterThanOrEqual(3);
      const read = readTimes(tablet, "/machine/settings");
      for (const route of MACHINE_SETTINGS_ROUTES) {
        // Their interval runs from the end of each read of them, so a minute passes between two.
        for (const gap of gaps(readTimes(tablet, route))) expect(gap).toBeGreaterThan(55_000);
      }
      // Over at least two minutes, 24 polls of 5 s: at least 10, however late the tablet's timers run.
      const polled = ["/beans", "/store/dye2.reaplugin/recipes", "/settings", "/presence/settings", "/devices", "/scale/info", "/sensors", "/steams/latest", "/machine/info"];
      for (const route of polled) {
        expect(readTimes(tablet, route).filter((time) => time > read[0]! && time < read.at(-1)!).length).toBeGreaterThanOrEqual(10);
      }
    });

    it("are read every poll interval where that is longer than 60 s, and no more often", async () => {
      const machine = await api.createMachine("Machine settings polled slowly");
      const tablet = load(machine, { pollSeconds: 90 });
      await expect.poll(() => allReported(machine)).toBe(true);
      await expect.poll(() => readTimes(tablet, "/machine/settings").length).toBeGreaterThanOrEqual(3);
      for (const route of MACHINE_SETTINGS_ROUTES) {
        for (const gap of gaps(readTimes(tablet, route))) expect(gap).toBeGreaterThan(85_000);
      }
    });

    it("count a full read that reaches them late or reads them slowly as their read, their interval running from its end", async () => {
      const machine = await api.createMachine("Machine settings read late");
      // As when the server's writes hold up the reads of the Library's lists: the first reads of the beans, bean batches
      // and grinders take 25 s each, so the welcome's full read reaches the machine's settings past their interval. Then
      // the first read of the machine's settings takes 25 s, and the advanced settings are read after it.
      const slow = new Set(["/beans", "/bean-batches", "/grinders", "/machine/settings"]);
      const tablet = load(machine, {
        apiDelayMs: (_method, path) => (slow.delete(path.split("?")[0]!) ? 25_000 : 0),
      });
      await expect.poll(() => allReported(machine)).toBe(true);
      await expect.poll(() => readTimes(tablet, "/machine/settings").length).toBeGreaterThanOrEqual(3);
      // Over 70 s after the plugin read Decaid's version as it connected.
      expect(readTimes(tablet, "/machine/settings")[0]).toBeGreaterThan(readTimes(tablet, "/info")[0]! + 70_000);
      for (const route of MACHINE_SETTINGS_ROUTES) {
        for (const gap of gaps(readTimes(tablet, route))) expect(gap).toBeGreaterThan(55_000);
      }
    });

    it("are read again at once after a Workflow change of the steam, hot water or flush settings, which Decaid wrote to the machine, and after no other", async () => {
      const machine = await api.createMachine("Machine settings written");
      // Its timers run only twice as fast, so their interval of a minute is 30 s, longer than a poll waits.
      const tablet = load(machine, { timeScale: 2 });
      await expect.poll(() => allReported(machine)).toBe(true);
      await allAcknowledged(tablet);

      // A barista changes the steam flow, which Decaid writes to the machine before it reports the Workflow. The new
      // value reaches the server before the poll gives up, which their interval, from the welcome's read, would not do.
      const changedAt = tablet.readClock();
      await tablet.changeSettings({ steamSettings: { flow: 1.5 } });
      await expect.poll(async () => (await collection(machine, "machineSettings"))?.value).toMatchObject({ steamFlow: 1.5 });
      for (const route of MACHINE_SETTINGS_ROUTES) expect(readTimes(tablet, route).filter((time) => time > changedAt).length).toBeGreaterThanOrEqual(1);
      expect(deliveries(tablet, "machineSettings")).toHaveLength(2);
      // Read with them, but unchanged, so not sent again.
      expect(deliveries(tablet, "machineCalibration")).toHaveLength(1);

      // Its dose, which Decaid does not write to the machine: nothing reads them but their interval, a minute after their last read.
      await allAcknowledged(tablet);
      const last = Object.fromEntries(MACHINE_SETTINGS_ROUTES.map((route) => [route, readTimes(tablet, route).at(-1)!]));
      const dosedAt = tablet.readClock();
      expect((await tablet.callApi("PUT", "/workflow", { context: { targetDoseWeight: 19 } })).status).toBe(200);
      await polls(tablet, 2);
      for (const route of MACHINE_SETTINGS_ROUTES) {
        for (const time of readTimes(tablet, route).filter((time) => time > dosedAt)) expect(time).toBeGreaterThan(last[route]! + 55_000);
      }
    });

    it("are not read while disconnected, on their interval or after a Workflow change, and are sent on the next welcome", async () => {
      const machine = await api.createMachine("Machine settings offline");
      const tablet = load(machine);
      await expect.poll(() => allReported(machine)).toBe(true);
      await allAcknowledged(tablet);

      // The connection drops, and the next cannot read Decaid's version for a while.
      tablet.failNextApiReads("/info", 1_000);
      tablet.dropConnections();
      await tablet.waitForLog(/^Disconnected: /);
      const since = tablet.requests.length;
      const from = tablet.readClock();
      await tablet.changeSettings({ steamSettings: { flow: 1.5 } });
      await expect.poll(() => tablet.readClock()).toBeGreaterThan(from + 130_000);
      const meanwhile = tablet.requests.slice(since);
      expect(meanwhile.filter((route) => MACHINE_SETTINGS_ROUTES.includes(route))).toEqual([]);
      expect(meanwhile).toContain("/machine/info");

      tablet.failNextApiReads("/info", 0);
      await tablet.waitForLogs(/^Connected to /, 2);
      await expect.poll(async () => (await collection(machine, "machineSettings"))?.value).toMatchObject({ steamFlow: 1.5 });
    });

    it("are read and sent, changed or not, whenever the server asks for everything, which restarts their interval", async () => {
      const standIn = await StandInServer.start();
      try {
        const tablet = tablets.load({
          settings: { ...settingsFor({ token: "stand-in token 32001", serverUrl: standIn.url }), PollSeconds: 5 },
          api: derivedDe1Pro({ serial: "32001" }),
          // Ten times faster, so a minute is 6 s.
          timeScale: 10,
        });
        const sent = (name: string) => standIn.received.filter((message) => message.type === "collection" && message.name === name).length;
        await expect.poll(() => [sent("machineSettings"), sent("advancedSettings"), sent("machineCalibration")]).toEqual([1, 1, 1]);
        const [welcomed] = readTimes(tablet, "/machine/settings");

        // A third of the way to their next read, which is then 4 s away.
        await expect.poll(() => tablet.readClock()).toBeGreaterThan(welcomed! + 20_000);
        const askedAt = tablet.readClock();
        standIn.send({ type: "requestCollections" });
        await expect.poll(() => [sent("machineSettings"), sent("advancedSettings"), sent("machineCalibration")]).toEqual([2, 2, 2]);
        // Their next read comes a minute after that one, not after the welcome's, and finds them unchanged.
        const since = (route: string) => readTimes(tablet, route).filter((time) => time > askedAt);
        await expect.poll(() => Math.min(...MACHINE_SETTINGS_ROUTES.map((route) => since(route).length))).toBeGreaterThanOrEqual(2);
        for (const route of MACHINE_SETTINGS_ROUTES) expect(since(route)[1]! - since(route)[0]!).toBeGreaterThan(55_000);
        await polls(tablet, 1);
        expect([sent("machineSettings"), sent("advancedSettings"), sent("machineCalibration")]).toEqual([2, 2, 2]);
      } finally {
        await standIn.stop();
      }
    });
  });

  describe("The sensor calibration, which Decaid reads from the machine on each request and which changes only when calibrated", () => {
    it("is read on every welcome and whenever the server asks for everything, and not on polls or the machine settings' interval", async () => {
      const standIn = await StandInServer.start();
      try {
        const served = derivedDe1Pro({ serial: "32002" });
        const tablet = tablets.load({
          settings: { ...settingsFor({ token: "stand-in token 32002", serverUrl: standIn.url }), PollSeconds: 5 },
          api: served,
          // Fifty times faster, so a minute is 1.2 s.
          timeScale: 50,
        });
        const sent = () => standIn.received.filter((message) => message.type === "collection" && message.name === "sensorCalibration");
        const reads = () => SENSOR_CALIBRATION_ROUTES.map((route) => readTimes(tablet, route).length);
        await expect.poll(() => sent().length).toBe(1);
        expect(sent()[0]).toMatchObject({ available: true, value: sensorCalibrationIn(served) });
        // Each target's current calibration, and not its factory one.
        expect(reads()).toEqual([1, 1, 1]);

        // Derived: its temperature sensor recalibrated. Two more reads of the machine's own settings on their interval,
        // and two minutes of polls, read it no more.
        const recalibrated = { ...served, ...sensorCalibration({ temperature: -0.5 }) };
        tablet.serve(recalibrated);
        await polls(tablet, 2, "/machine/settings");
        await polls(tablet, 1);
        expect(reads()).toEqual([1, 1, 1]);
        expect(sent()).toHaveLength(1);

        standIn.send({ type: "requestCollections" });
        await expect.poll(() => sent().length).toBe(2);
        expect(sent()[1]).toMatchObject({ available: true, value: sensorCalibrationIn(recalibrated) });
        expect(reads()).toEqual([2, 2, 2]);

        // A reconnect reads and sends it again, unchanged.
        tablet.dropConnections();
        await expect.poll(() => sent().length).toBe(3);
        expect(sent()[2]).toMatchObject({ available: true, value: sensorCalibrationIn(recalibrated) });
        expect(reads()).toEqual([3, 3, 3]);
      } finally {
        await standIn.stop();
      }
    });

    it("is reported unavailable if any one of its three reads fails, keeping the value known", async () => {
      const machine = await api.createMachine("Sensor calibration unavailable");
      const served = derivedDe1Pro({ serial: "30801" });
      const tablet = load(machine, { api: served });
      await expect.poll(() => allReported(machine)).toBe(true);
      const known = sensorCalibrationIn(served);
      expect(await collection(machine, "sensorCalibration")).toMatchObject({ available: true, value: known });

      // Derived: the machine doesn't answer the last of the three in time, which Decaid answers 504 (de1handler.dart).
      tablet.serve({ ...served, "/machine/calibration/temperature": new Refusal(504, { error: "BleTimeoutException" }) });
      tablet.dropConnections();
      await expect.poll(async () => (await collection(machine, "sensorCalibration"))?.available).toBe(false);
      expect(await collection(machine, "sensorCalibration")).toMatchObject({ value: known });

      // The first fails, and the two after it are not read.
      await allAcknowledged(tablet);
      tablet.serve(served);
      tablet.failNextApiReads("/machine/calibration/flow", 1);
      const before = SENSOR_CALIBRATION_ROUTES.map((route) => readTimes(tablet, route).length);
      const delivered = deliveries(tablet, "sensorCalibration").length;
      tablet.dropConnections();
      await expect.poll(() => deliveries(tablet, "sensorCalibration").length).toBe(delivered + 1);
      expect(deliveries(tablet, "sensorCalibration").at(-1)).toMatchObject({ available: false });
      expect(SENSOR_CALIBRATION_ROUTES.map((route) => readTimes(tablet, route).length)).toEqual([before[0]! + 1, before[1], before[2]]);

      // Read in full again, it is available.
      tablet.dropConnections();
      await expect.poll(async () => (await collection(machine, "sensorCalibration"))?.available).toBe(true);
      expect(await collection(machine, "sensorCalibration")).toMatchObject({ value: known });
    });
  });

  it("acknowledges and ignores a collection it does not know", async () => {
    const machine = await api.createMachine("Newer plugin");
    const raw = await connect(machine);
    await raw.deliver(report("recipes", de1ProOnDecaid090()["/store/dye2.reaplugin/recipes"]));
    expect(await summaries(machine)).toEqual([]);
  });
});
