import { randomUUID } from "node:crypto";
import { COLLECTION_NAMES } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import {
  type DecaidApi,
  RawConnection,
  SimulatedTablet,
  type SimulatedTabletOptions,
  de1ProOnDecaid087,
  derivedDe1Pro,
  helloWith,
  manyProfiles,
  settingsFor,
  simulatedDevices,
  simulatedDevicesSwitchedOff,
  simulatedLibrary,
} from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #14: the built plugin in a simulated tablet, or raw
// frames, against real servers sharing one PostgreSQL database, with every
// assertion made through the REST API. Collections are those Decaid v0.8.7
// sent, from the test tablet or from Decaid's simulated devices (see the
// fixtures' READMEs), or derived from them by the changes named; serials are
// made up.

interface Summary { name: string; available: boolean; reportedAt: string; receivedAt: string | null; items: number | null }
interface Collection extends Summary { value: unknown }
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
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    const used = tablets.splice(0);
    await Promise.all(used.map((tablet) => tablet.unload()));
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    // The plugin only ever reads Decaid's API, DYE2's storage included.
    for (const tablet of used) expect(tablet.writes).toEqual([]);
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /** A simulated tablet with the Machine's token, polling every 5 s (0.1 s here), its machine reporting hardware of its own unless given an API. */
  function load(machine: CreatedMachine, options: Omit<SimulatedTabletOptions, "settings"> = {}) {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor(machine), PollSeconds: 5 },
      api: derivedDe1Pro({ serial: machine.machine.id.replaceAll("-", "").slice(0, 12) }),
      timeScale: 50,
      ...options,
    });
    tablets.push(tablet);
    return tablet;
  }
  async function get<T>(path: string, at = api): Promise<T> {
    const response = await at.call("GET", path);
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }
  const summaries = async (machine: CreatedMachine, at = api) =>
    (await get<{ collections: Summary[] }>(`/machines/${machine.machine.id}/collections`, at)).collections;
  const collection = async (machine: CreatedMachine, name: string, at = api) =>
    (await get<{ collection: Collection | null }>(`/machines/${machine.machine.id}/collections/${name}`, at)).collection;
  const pairedDevices = async (machine: CreatedMachine) =>
    (await get<{ pairedDevices: PairedDevices }>(`/machines/${machine.machine.id}/paired-devices`)).pairedDevices;
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
  const acked = (tablet: SimulatedTablet, id: string) =>
    tablet.received.some((reply) => frameType(reply) === "ack" && (reply as Frame).id === id);
  /** Resolves once the server has acknowledged every collection delivery the plugin sent. */
  const allAcknowledged = (tablet: SimulatedTablet) =>
    expect.poll(() => deliveries(tablet).every((frame) => acked(tablet, frame.id!)), { timeout: 10_000 }).toBe(true);
  /** Resolves once the plugin has read `route` at least `count` more times: that many polls have run. */
  async function polls(tablet: SimulatedTablet, count: number, route = "/machine/settings") {
    const before = tablet.requests.filter((request) => request === route).length;
    await expect.poll(() => tablet.requests.filter((request) => request === route).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(before + count);
  }

  async function connect(machine: CreatedMachine, url = server.url, hardware?: { model: string; serial: string }) {
    const raw = await RawConnection.welcomed(url, helloWith(machine.token, hardware ? { machine: hardware } : {}));
    raws.push(raw);
    return raw;
  }
  const report = (name: string, value?: unknown) =>
    value === undefined
      ? { type: "collection", id: randomUUID(), name, available: false }
      : { type: "collection", id: randomUUID(), name, available: true, value };

  const paired = (inventory: unknown) => (inventory as { state: string }[]).filter((entry) => entry.state !== "discovered");

  it("requires a Machine, and knows only the collections tablets report", async () => {
    const machine = await api.createMachine("Nothing reported");
    for (const path of ["/collections", "/collections/beans", "/paired-devices"]) {
      for (const id of [randomUUID(), "not-a-machine"]) expect((await api.call("GET", `/machines/${id}${path}`)).status).toBe(404);
    }
    expect((await api.call("GET", `/machines/${machine.machine.id}/collections/recipes`)).status).toBe(404);
    expect(await summaries(machine)).toEqual([]);
    for (const name of COLLECTION_NAMES) expect(await collection(machine, name)).toBeNull();
    expect(await pairedDevices(machine)).toEqual({ reportedAt: null, available: null, receivedAt: null, scale: null, auxiliaryScale: null, sensors: [], others: [] });
  });

  it("stores every collection on connect as Decaid sent it, archived records, hidden profiles and unavailable ones included", async () => {
    const machine = await api.createMachine("Every collection");
    const served: DecaidApi = { ...derivedDe1Pro({ serial: "30001" }), ...simulatedLibrary(), ...simulatedDevices() };
    const connectedAt = Date.now();
    load(machine, { api: served });
    await expect.poll(() => allReported(machine), { timeout: 10_000 }).toBe(true);

    const reported = await collections(machine);
    const value = (route: string) => ({ available: true, value: served[route] });
    expect(reported).toEqual({
      beans: value("/beans"),
      beanBatches: value("/bean-batches"),
      grinders: value("/grinders"),
      profiles: value("/profiles"),
      dye2Recipes: value("/store/dye2.reaplugin/recipes"),
      // DYE2 has never written it, so Decaid answers null.
      dye2Equipment: { available: false, value: null },
      dye2Baskets: value("/store/dye2.reaplugin/baskets"),
      appSettings: value("/settings"),
      machineSettings: value("/machine/settings"),
      advancedSettings: value("/machine/settings/advanced"),
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
    let served = de1ProOnDecaid087();
    const tablet = load(machine, { api: served });
    await expect.poll(() => allReported(machine), { timeout: 10_000 }).toBe(true);
    await allAcknowledged(tablet);
    await polls(tablet, 3);
    const initial = sentCounts(tablet);
    expect(Object.values(initial).every((count) => count === 1)).toBe(true);

    // Derived: the tablet's machine settings recalibrated, and its DYE2 recipe renamed in DYE2.
    const recalibrated = { ...(served["/machine/settings"] as object), steamFlow: 1.5 };
    const recipes = (served["/store/dye2.reaplugin/recipes"] as Record<string, unknown>[]).map((recipe) => ({ ...recipe, name: "Sep 26th Eth, coarser" }));
    served = { ...served, "/machine/settings": recalibrated, "/store/dye2.reaplugin/recipes": recipes };
    tablet.serve(served);
    await expect.poll(async () => (await collection(machine, "machineSettings"))?.value, { timeout: 10_000 }).toEqual(recalibrated);
    await expect.poll(async () => (await collection(machine, "dye2Recipes"))?.value, { timeout: 10_000 }).toEqual(recipes);
    await polls(tablet, 5);
    expect(sentCounts(tablet)).toEqual({ ...initial, machineSettings: 2, dye2Recipes: 2 });
    // The library's lists were read with their ETags, which Decaid answered 304.
    expect(tablet.requests.filter((route) => route === "/beans").length).toBeGreaterThan(5);
    await allAcknowledged(tablet);

    // A reconnect sends every collection again, whole, whether or not it or its ETag changed.
    const sentBefore = tablet.sent.length;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(() => sentCounts(tablet), { timeout: 10_000 }).toEqual(
      Object.fromEntries(COLLECTION_NAMES.map((name) => [name, initial[name]! + (name === "machineSettings" || name === "dye2Recipes" ? 2 : 1)])),
    );
    const resent = tablet.sent.slice(sentBefore).filter((frame): frame is Frame => frameType(frame) === "collection");
    expect(resent.find((frame) => frame.name === "beans")).toMatchObject({ available: true, value: served["/beans"] });
    expect(resent.find((frame) => frame.name === "dye2Equipment")).toMatchObject({ available: false });
    await allAcknowledged(tablet);
    expect((await collections(machine)).beans).toEqual({ available: true, value: served["/beans"] });
  }, 30_000);

  it("reports a read that fails or has nothing to report as unavailable, keeping the value known", async () => {
    const machine = await api.createMachine("Unavailable");
    const served: DecaidApi = { ...derivedDe1Pro({ serial: "30002" }), ...simulatedDevices() };
    const tablet = load(machine, { api: served });
    await expect.poll(() => allReported(machine), { timeout: 10_000 }).toBe(true);
    const before = await collections(machine);
    expect(before.scaleInfo).toEqual({ available: true, value: {} });
    expect((await pairedDevices(machine)).scale).toEqual(device("scale", "MockScale", "Mock Scale", "connected"));

    // The machine and the scale are switched off, and the grinders cannot be read for a while.
    tablet.machineConnected = false;
    tablet.serve({ ...served, ...simulatedDevicesSwitchedOff() });
    tablet.failNextApiReads("/grinders", 1_000);
    await expect.poll(async () => (await collection(machine, "scaleInfo"))?.available, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await collection(machine, "grinders"))?.available, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await collection(machine, "machineSettings"))?.available, { timeout: 10_000 }).toBe(false);
    const after = await collections(machine);
    for (const name of ["scaleInfo", "grinders", "machineSettings", "advancedSettings"]) {
      expect(after[name]).toEqual({ available: false, value: before[name]!.value });
    }
    const scaleInfo = (await collection(machine, "scaleInfo"))!;
    expect(Date.parse(scaleInfo.reportedAt)).toBeGreaterThan(Date.parse(scaleInfo.receivedAt!));
    expect(await collection(machine, "dye2Equipment")).toMatchObject({ available: false, value: null, receivedAt: null, items: null });
    // A disconnected scale shows no firmware or battery level, which only a connected one reports.
    expect((await pairedDevices(machine)).scale).toEqual(device("scale", "MockScale", "Mock Scale", "disconnected"));
    // Sent once each time the collection became unavailable.
    await polls(tablet, 3);
    expect(sentCounts(tablet)).toMatchObject({ scaleInfo: 2, grinders: 2, machineSettings: 2, advancedSettings: 2, dye2Equipment: 1 });

    // Readable again, the grinders are sent again, though unchanged.
    tablet.failNextApiReads("/grinders", 0);
    await expect.poll(async () => (await collection(machine, "grinders"))?.available, { timeout: 10_000 }).toBe(true);
    expect((await collections(machine)).grinders).toEqual(before.grinders);
  }, 30_000);

  it("leaves devices only discovered nearby out of the paired devices, and does not resend them as such devices come and go", async () => {
    const machine = await api.createMachine("Discovered nearby");
    const served: DecaidApi = { ...derivedDe1Pro({ serial: "30003" }), ...simulatedDevices() };
    const tablet = load(machine, { api: served });
    await expect.poll(() => allReported(machine), { timeout: 10_000 }).toBe(true);
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
    await expect.poll(async () => (await pairedDevices(machine)).auxiliaryScale, { timeout: 10_000 }).toEqual(device("scale", "MockScale", "Mock Scale", "connected"));
    expect((await pairedDevices(machine)).scale).toBeNull();
  }, 30_000);

  it("shows the scale Decaid prefers while it is off, as the test tablet's is", async () => {
    const machine = await api.createMachine("Scale off");
    load(machine, { api: derivedDe1Pro({ serial: "30004" }) });
    await expect.poll(() => allReported(machine), { timeout: 10_000 }).toBe(true);
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
    await expect.poll(async () => (await collection(machine, "profiles"))?.items, { timeout: 20_000 }).toBe(profiles.length);
    expect((await collection(machine, "profiles"))!.value).toEqual(profiles);
    expect(tablet.sent.some((frame) => frameType(frame) === "chunk")).toBe(true);
    expect(tablet.peakPendingOutboundBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(tablet.refusedSends).toBe(0);
  }, 30_000);

  it("gives a mismatched connection's collections to the Machine that has its hardware, leaving the token's Machine its own", async () => {
    const traveller = await api.createMachine("Traveller's own");
    const home = load(traveller, { api: derivedDe1Pro({ serial: "30101" }) });
    await expect.poll(() => allReported(traveller), { timeout: 10_000 }).toBe(true);
    await home.unload();
    const own = await collections(traveller);

    const owner = await api.createMachine("Owner of 30102");
    await (await connect(owner, server.url, { model: "DE1Pro", serial: "30102" })).close();
    // The tablet moves onto Owner's machine, still with Traveller's token, and its library and devices differ.
    const moved = load(traveller, { api: { ...derivedDe1Pro({ serial: "30102" }), ...simulatedLibrary(), ...simulatedDevices() } });
    await api.waitForMachine("Traveller's own", (machine) => machine.online && machine.identification === "mismatch");
    await expect.poll(() => allReported(owner), { timeout: 10_000 }).toBe(true);
    await allAcknowledged(moved);
    expect((await collections(owner)).beans).toEqual({ available: true, value: simulatedLibrary()["/beans"] });
    expect((await pairedDevices(owner)).scale).toEqual(device("scale", "MockScale", "Mock Scale", "connected"));
    expect(await collections(traveller)).toEqual(own);
  }, 30_000);

  it("holds a mismatched connection's collections for hardware without a Machine, and hands them to the machine entry created for it", async () => {
    const traveller = await api.createMachine("Before adoption");
    const home = load(traveller, { api: derivedDe1Pro({ serial: "30201" }) });
    await expect.poll(() => allReported(traveller), { timeout: 10_000 }).toBe(true);
    await home.unload();
    const own = await collections(traveller);

    const moved = load(traveller, { api: { ...derivedDe1Pro({ serial: "30202" }), ...simulatedLibrary(), ...simulatedDevices() } });
    await api.waitForMachine("Before adoption", (machine) => machine.online && machine.identification === "mismatch");
    await expect.poll(() => deliveries(moved).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(COLLECTION_NAMES.length);
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
  }, 30_000);

  it("merges what a Pending Machine holds into a Machine that binds its hardware: the latest report says whether each is available, and the latest value is kept", async () => {
    const machine = await api.createMachine("Binds later");
    const visitor = await api.createMachine("Visitor");
    const hardware = { model: "DE1Pro", serial: "30301" };
    const tablet = de1ProOnDecaid087();
    const simulated = { ...simulatedLibrary(), ...simulatedDevices() };
    // Derived: the tablet's machine settings as the visitor's tablet later read them, recalibrated.
    const recalibrated = { ...(tablet["/machine/settings"] as object), steamFlow: 1.5 };
    // The Machine's tablet connects before its machine is on.
    const early = await connect(machine);
    await early.deliver(report("machineSettings", tablet["/machine/settings"]));
    await early.deliver(report("scaleInfo"));
    await early.deliver(report("sensors", tablet["/sensors"]));
    await early.close();
    // The visitor's tablet, moved onto that machine, reports newer values, which its Pending Machine holds.
    await (await connect(visitor, other.url, { model: "DE1Pro", serial: "30302" })).close();
    const mismatched = await connect(visitor, other.url, hardware);
    await mismatched.deliver(report("machineSettings", recalibrated));
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
      machineSettings: { available: true, value: recalibrated },
      advancedSettings: { available: true, value: tablet["/machine/settings/advanced"] },
      scaleInfo: { available: true, value: simulated["/scale/info"] },
      sensors: { available: false, value: simulated["/sensors"] },
    });
    expect(await summaries(visitor)).toEqual([]);
    expect((await api.pendingMachines()).some((pending) => pending.serial === hardware.serial)).toBe(false);
  });

  it("stores each delivery once, so a resend through another instance never replaces a newer value, whether the first is still being stored or arrives again last", async () => {
    const machine = await api.createMachine("Resent");
    const hardware = { model: "DE1Pro", serial: "30401" };
    const first = await connect(machine, server.url, hardware);
    // Derived: the tablet's machine settings with two fan thresholds.
    const settings = de1ProOnDecaid087()["/machine/settings"] as object;
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
      raws.push(second);
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
  }, 20_000);

  it("leaves a value delivered again as stored, not writing it again, while recording when it was reported and received", async () => {
    const machine = await api.createMachine("Reconnecting");
    const hardware = { model: "DE1Pro", serial: "31001" };
    const profiles = de1ProOnDecaid087()["/profiles"] as Record<string, unknown>[];
    const database = await server.connectDatabase();
    try {
      /** The stored profiles: the TOAST data holding their value, which writing it again replaces, and their times and count. */
      const stored = async () =>
        (
          await database.query<{ toast: string | null; reportedAt: Date; receivedAt: Date; items: number }>(
            `SELECT pg_column_toast_chunk_id(value)::text AS toast, reported_at AS "reportedAt", received_at AS "receivedAt", items
             FROM reported_collections WHERE machine_id = $1 AND name = 'profiles'`,
            [machine.machine.id],
          )
        ).rows[0]!;
      const first = await connect(machine, server.url, hardware);
      await first.deliver(report("profiles", profiles));
      const before = await stored();
      // Large enough to be kept out of line, as profiles usually are.
      expect(before.toast).not.toBeNull();
      await first.close();

      // A reconnect, through any instance, sends it again unchanged.
      const second = await connect(machine, other.url, hardware);
      await second.deliver(report("profiles", profiles));
      const resent = await stored();
      expect(resent.toast).toBe(before.toast);
      expect(resent.reportedAt.getTime()).toBeGreaterThan(before.reportedAt.getTime());
      expect(resent.receivedAt.getTime()).toBeGreaterThan(before.receivedAt.getTime());
      expect(resent.items).toBe(profiles.length);
      expect(await collection(machine, "profiles")).toMatchObject({ available: true, value: profiles, items: profiles.length });

      // An unavailable report keeps it too, and so does the same value read again after it.
      await second.deliver(report("profiles"));
      await second.deliver(report("profiles", profiles));
      expect((await stored()).toast).toBe(before.toast);

      // Derived: one profile renamed, and one deleted. A changed value is stored.
      const changed = profiles.slice(1).map((profile, index) => (index === 0 ? { ...profile, title: "Londonium, longer" } : profile));
      await second.deliver(report("profiles", changed));
      const after = await stored();
      expect(after.toast).not.toBe(before.toast);
      expect(after.items).toBe(changed.length);
      expect(await collection(machine, "profiles")).toMatchObject({ available: true, value: changed, items: changed.length });
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
    const settings = de1ProOnDecaid087()["/machine/settings"] as object;
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
      stallUpload: (frame) => stalled && frameType(frame) === "collection" && (frame as Frame).name === "machineSettings",
    });
    await expect.poll(() => allReported(machine), { timeout: 10_000 }).toBe(true);
    await allAcknowledged(tablet);

    // Derived: the tablet's machine settings with two fan thresholds, one after the other.
    const settings = served["/machine/settings"] as Record<string, unknown>;
    const older = { ...settings, fan: 40 };
    const newer = { ...settings, fan: 45 };
    stalled = true;
    tablet.serve({ ...served, "/machine/settings": older });
    await expect.poll(() => deliveries(tablet, "machineSettings").length, { timeout: 10_000 }).toBe(2);
    const unacknowledged = deliveries(tablet, "machineSettings")[1]!;
    expect(unacknowledged.value).toEqual(older);

    // As a poll starts reading, its connection drops, and the next takes a while: the poll reads the
    // newer settings while disconnected, after the older delivery was sent and before it is sent again.
    await polls(tablet, 1, "/beans");
    tablet.serve({ ...served, "/machine/settings": newer });
    tablet.failNextApiReads("/info", 4);
    tablet.dropConnections();
    stalled = false;
    await tablet.waitForLogs(/^Connected to /, 2, 20_000);
    await expect.poll(async () => (await collection(machine, "machineSettings"))?.value, { timeout: 10_000 }).toEqual(newer);
    await allAcknowledged(tablet);
    const sent = deliveries(tablet, "machineSettings").slice(2);
    expect(sent[0]).toEqual(unacknowledged);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.slice(1).every((frame) => JSON.stringify(frame.value) === JSON.stringify(newer))).toBe(true);
    expect((await collection(machine, "machineSettings"))!.value).toEqual(newer);
  }, 40_000);

  it("keeps a value read while the outbox was busy ahead of a later read that found the collection unavailable", async () => {
    const machine = await api.createMachine("Busy outbox");
    let stalled = false;
    const served = derivedDe1Pro({ serial: "30601" });
    const tablet = load(machine, {
      api: served,
      stallUpload: (frame) => stalled && frameType(frame) === "collection" && (frame as Frame).name === "dye2Baskets",
    });
    await expect.poll(() => allReported(machine), { timeout: 10_000 }).toBe(true);
    await allAcknowledged(tablet);

    // Derived: DYE2's basket renamed, whose delivery then waits on the network, holding up the outbox.
    stalled = true;
    const baskets = (served["/store/dye2.reaplugin/baskets"] as Record<string, unknown>[]).map((basket) => ({ ...basket, name: "Decent 18g Ridged" }));
    tablet.serve({ ...served, "/store/dye2.reaplugin/baskets": baskets });
    await expect.poll(() => deliveries(tablet, "dye2Baskets").length, { timeout: 10_000 }).toBe(2);
    // Derived: the machine recalibrated, read and queued behind it; then the machine is switched off.
    const recalibrated = { ...(served["/machine/settings"] as object), steamFlow: 1.5 };
    tablet.serve({ ...served, "/store/dye2.reaplugin/baskets": baskets, "/machine/settings": recalibrated });
    await polls(tablet, 1);
    tablet.machineConnected = false;
    await polls(tablet, 1);
    stalled = false;

    await expect.poll(async () => (await collection(machine, "machineSettings"))?.available, { timeout: 10_000 }).toBe(false);
    await allAcknowledged(tablet);
    expect(await collections(machine)).toMatchObject({
      machineSettings: { available: false, value: recalibrated },
      dye2Baskets: { available: true, value: baskets },
    });
  }, 30_000);

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

  it("acknowledges and ignores a collection it does not know", async () => {
    const machine = await api.createMachine("Newer plugin");
    const raw = await connect(machine);
    await raw.deliver(report("recipes", de1ProOnDecaid087()["/store/dye2.reaplugin/recipes"]));
    expect(await summaries(machine)).toEqual([]);
  });
});
