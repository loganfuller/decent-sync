import { randomUUID } from "node:crypto";
import { CLOSE_CODES } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type MachineView, type TakeoverView } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import {
  PluginStorage,
  RawConnection,
  SimulatedTablet,
  type SimulatedTabletOptions,
  derivedDe1Pro,
  helloWith,
  readBuiltPlugin,
  settingsFor,
} from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #62: a connection with a Machine's token from one tablet
// replacing a live one from another is a takeover, recorded on the Machine,
// and the plugin replaced waits and yields to the other tablet rather than
// stopping; a tablet reconnecting replaces its own connection without either.
// Simulated tablets run the built plugin, and raw frames stand in for what it
// sends, against two server instances on one database. Assertions go through
// the REST API. Serials are made up, from 16001, and connection ids from
// 00:00:5E:00:53:B0.

// Rare enough that a connection the tablet lost stays live, held by the
// server, for 15 s: long after the tablet has reconnected.
const HEARTBEAT_SECONDS = 5;
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) };
/** The plugin's 5-minute wait before each yielding hello takes 3 s at this pace. */
const TIME_SCALE = 100;
const de1Pro = (serial: string) => ({ model: "DE1Pro", serial, firmware: "1333" });

describe("Takeovers", { timeout: 30_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const connections: RawConnection[] = [];

  const loadTablet = (options: SimulatedTabletOptions) => {
    const tablet = SimulatedTablet.load(options);
    tablets.push(tablet);
    return tablet;
  };

  /** A raw connection to an instance, opened but sent nothing yet. */
  const opened = async (instance = server) => {
    const raw = await RawConnection.open(instance.url);
    connections.push(raw);
    return raw;
  };

  /** Opens a raw connection to an instance and sends a hello, resolving once the server welcomes it, then keeps it alive. */
  const welcomed = async (hello: Record<string, unknown>, instance = server) => {
    const raw = await RawConnection.welcomed(instance.url, hello);
    connections.push(raw);
    return raw;
  };

  const machine = async (id: string): Promise<MachineView> =>
    ((await (await api.call("GET", `/machines/${id}`)).json()) as { machine: MachineView }).machine;

  const expectRefusal = async (raw: RawConnection, code: keyof typeof CLOSE_CODES) => {
    expect(await raw.closed).toEqual({ code: CLOSE_CODES[code], reason: code });
    const error = raw.messages.at(-1) as { type: string; code: string; message: string };
    expect(error).toEqual({ type: "error", code, message: expect.any(String) });
    return error.message;
  };

  /** The hellos the plugin sent, in order. */
  const hellos = (tablet: SimulatedTablet) =>
    tablet.sent.filter((frame) => (frame as { type?: unknown }).type === "hello") as Record<string, unknown>[];

  /** Runs the steps, each sending a hello that waits for the Machine's row, held here, so they are decided in this order. */
  async function inOrder(machineId: string, steps: (() => void)[]): Promise<void> {
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM machines WHERE id = $1 FOR UPDATE", [machineId]);
      for (const [index, step] of steps.entries()) {
        step();
        await waitForLockWaits(server, { count: index + 1 });
      }
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
  }

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  describe("two tablets with one token, connected through different instances", () => {
    runAsSteps();

    let lab: CreatedMachine;
    let first: SimulatedTablet;
    let second: SimulatedTablet;
    const [firstStorage, secondStorage] = [new PluginStorage(), new PluginStorage()];
    let firstId: string;
    let secondId: string;
    let takeover: TakeoverView;

    it("the second to connect takes the Machine over, which the Machine shows with both tablets' connections", async () => {
      lab = await api.createMachine("Lab");
      const options = { settings: settingsFor(lab), timeScale: TIME_SCALE };
      first = loadTablet({ ...options, storage: firstStorage, api: derivedDe1Pro({ serial: "16001", connectionId: "00:00:5E:00:53:B1" }) });
      await first.waitForLog(/^Connected to /);
      firstId = String(firstStorage.read("tabletId"));
      // The second, an old tablet still holding the token, is switched on away from the machine and reaches the other instance.
      second = loadTablet({
        ...options,
        settings: settingsFor({ ...lab, serverUrl: other.url }),
        storage: secondStorage,
        machineConnected: false,
        api: derivedDe1Pro({ serial: "16001", connectionId: "00:00:5E:00:53:B2" }),
      });
      await second.waitForLog(/^Connected to /);
      secondId = String(secondStorage.read("tabletId"));

      await first.waitForLog(/^Another tablet connected with this Machine's token and took over\. Connecting again in 300 s,/);
      expect(first.received).toContainEqual({ type: "error", code: "replaced", message: expect.stringMatching(/from another tablet, took over/) });
      const viewed = await machine(lab.machine.id);
      expect(viewed).toMatchObject({ online: true, connectionId: "00:00:5E:00:53:B2", tablet: { id: secondId }, lastRefusal: null });
      const pluginVersion = String(readBuiltPlugin().manifest.version);
      expect(viewed.takeover).toEqual({
        at: expect.any(String),
        replaced: { tabletId: firstId, remoteAddress: "127.0.0.1", connectionId: "00:00:5E:00:53:B1", pluginVersion, decaidVersion: "0.8.7+2847" },
        replacement: { tabletId: secondId, remoteAddress: "127.0.0.1", connectionId: "00:00:5E:00:53:B2", pluginVersion, decaidVersion: "0.8.7+2847" },
      });
      takeover = viewed.takeover!;
      // Both by PostgreSQL's clock: the takeover during the transaction whose start first saw the second tablet. That
      // start is rounded to the millisecond, and the takeover's time, passed through JavaScript, truncated.
      expect(Date.parse(takeover.at)).toBeGreaterThanOrEqual(Date.parse(viewed.tablet!.firstSeenAt) - 1);
    });

    it("the replaced tablet keeps running, and its hellos asking not to replace the other are refused while that one stays", async () => {
      await first.waitForLogs(/^Another tablet is still connected with this Machine's token\. Trying again in 300 s\.$/, 2, 20_000);
      expect(first.logs).toContain(
        "The server reported machine held: A connection from another tablet holds this Machine, and this hello asked not to replace it",
      );
      const sent = hellos(first);
      expect(sent[0]).not.toHaveProperty("yielding");
      expect(sent.slice(1).every((hello) => hello.yielding === true && hello.tabletId === firstId)).toBe(true);
      expect(first.logs.filter((log) => log.startsWith("Connected to "))).toHaveLength(1);

      // The other tablet is never disturbed, and the refusals record nothing.
      expect(second.logs.filter((log) => log.startsWith("Disconnected"))).toEqual([]);
      expect(await machine(lab.machine.id)).toMatchObject({ online: true, tablet: { id: secondId }, lastRefusal: null, takeover });
    });

    it("once the other tablet unloads, the replaced one connects again by itself within its wait, and the Machine is online through it", async () => {
      await second.unload();
      const back = await api.waitForMachine("Lab", (viewed) => viewed.online && viewed.tablet?.id === firstId);
      expect(back).toMatchObject({ connectionId: "00:00:5E:00:53:B1", takeover });
      expect(first.logs.filter((log) => log.startsWith("Connected to "))).toHaveLength(2);
      expect(hellos(first).at(-1)).toMatchObject({ yielding: true });
      await first.unload();
    });
  });

  it("records no takeover when a tablet whose network dropped reconnects while the server still holds its old connection", async () => {
    const created = await api.createMachine("Dropped");
    const storage = new PluginStorage();
    const tablet = loadTablet({ settings: settingsFor(created), storage, api: derivedDe1Pro({ serial: "16101" }) });
    await tablet.waitForLog(/^Connected to /);

    tablet.dropConnectionsUnnoticed();
    await tablet.waitForLog(/^Disconnected: connection error \(transport_error\): .+\. Reconnecting in 1 s\.$/);
    expect(await tablet.waitForLogs(/^Connected to /, 2)).toHaveLength(2);
    // The server still held the old connection, live, and closed it as replaced by its own tablet once the new one was accepted.
    await expect
      .poll(() => server.output())
      .toContain("Closing the sync connection of Machine Dropped (127.0.0.1): Another connection from this tablet holds this Machine now");
    expect(await machine(created.machine.id)).toMatchObject({ online: true, tablet: { id: storage.read("tabletId") }, takeover: null });
    await tablet.unload();
  });

  it("leaves the Machine to a tablet whose earlier hello, held back on one instance, commits after its later one on another", async () => {
    const created = await api.createMachine("Abandoned hello");
    const tabletId = randomUUID();
    // The tablet's machine is bound to its token already.
    await (await welcomed(helloWith(created.token, { tabletId, machine: de1Pro("16201") }))).close();
    await api.waitForMachine("Abandoned hello", (viewed) => !viewed.online);
    const storage = new PluginStorage();
    storage.write("tabletId", tabletId);
    let tablet: SimulatedTablet | undefined;
    const database = await server.connectDatabase();
    try {
      // The test holds the hardware's lock, which a hello reporting it takes first.
      await database.query("BEGIN");
      await database.query("SELECT pg_advisory_xact_lock(4000002, hashtext($1::text || '/' || $2::text))", ["DE1Pro", "16201"]);
      const abandoned = await opened();
      abandoned.send(helloWith(created.token, { tabletId, machine: de1Pro("16201") }));
      await waitForLockWaits(server, { advisory: true });
      // The plugin gives up waiting for its welcome and connects again, through the other instance, its machine off
      // meanwhile: a hello without hardware takes no such lock, and is accepted.
      await abandoned.close();
      tablet = loadTablet({ settings: settingsFor({ ...created, serverUrl: other.url }), storage, machineConnected: false });
      await tablet.waitForLog(/^Connected to /);
      await database.query("COMMIT");
    } finally {
      await database.end();
    }

    // The earlier hello is accepted, from the same tablet, and its closed connection released; the plugin's connection,
    // replaced by it, is told to reconnect, and does with its normal backoff.
    await tablet.waitForLog(/^Disconnected: the server closed the connection \(4007: superseded\)\. Reconnecting in 1 s\.$/);
    expect(await tablet.waitForLogs(/^Connected to /, 2)).toHaveLength(2);
    expect(await api.waitForMachine("Abandoned hello", (viewed) => viewed.online)).toMatchObject({ tablet: { id: tabletId }, takeover: null });
    expect(tablet.logs.join("\n")).not.toMatch(/Another tablet/);
    await tablet.unload();
  });

  it("refuses a yielding hello while a live connection from another tablet holds the Machine, and accepts it once none does", async () => {
    const created = await api.createMachine("Yielded to");
    const holder = await welcomed(helloWith(created.token, { machine: null }));
    const yielding = await opened(other);
    yielding.send(helloWith(created.token, { machine: null, yielding: true }));
    expect(await expectRefusal(yielding, "machine_held")).toMatch(/asked not to replace it/);
    expect(await machine(created.machine.id)).toMatchObject({ online: true, lastRefusal: null, takeover: null });
    // The holder heard nothing of it but its welcome and answers to its heartbeats.
    expect(holder.messages.filter((message) => (message as { type?: unknown }).type !== "heartbeat")).toHaveLength(1);

    await holder.close();
    await api.waitForMachine("Yielded to", (viewed) => !viewed.online);
    const tabletId = randomUUID();
    await welcomed(helloWith(created.token, { tabletId, machine: null, yielding: true }), other);
    expect(await machine(created.machine.id)).toMatchObject({ online: true, tablet: { id: tabletId }, takeover: null });
  });

  it("accepts a yielding hello from the tablet holding the Machine, closing its older connection as superseded", async () => {
    const created = await api.createMachine("Yielding to itself");
    const tabletId = randomUUID();
    const older = await welcomed(helloWith(created.token, { tabletId, machine: null }));
    await welcomed(helloWith(created.token, { tabletId, machine: null, yielding: true }), other);
    expect(await expectRefusal(older, "superseded")).toBe("Another connection from this tablet holds this Machine now");
    expect(await machine(created.machine.id)).toMatchObject({ online: true, takeover: null });
  });

  it("records no takeover when a hello replaces a connection unheard for three heartbeat intervals", async () => {
    // An instance judging connections by 0.5 s heartbeats, and one that crashes holding a connection.
    const judge = await startTestServer({ env: { ...env, SYNC_HEARTBEAT_SECONDS: "0.5" }, sharing: server });
    const doomed = await startTestServer({ env, sharing: server });
    try {
      const created = await api.createMachine("Held by a crashed instance");
      await welcomed(helloWith(created.token, { machine: null }), doomed);
      await doomed.kill();
      // Nothing released it, but it has gone unheard.
      await api.at(judge.url).waitForMachine("Held by a crashed instance", (viewed) => !viewed.online);

      const tabletId = randomUUID();
      await welcomed(helloWith(created.token, { tabletId, machine: null }), judge);
      expect(await machine(created.machine.id)).toMatchObject({ online: true, tablet: { id: tabletId }, takeover: null });
    } finally {
      await doomed.stop();
      await judge.stop();
    }
  });

  it("decides a takeover and a yielding hello from another tablet in either order, under the Machine's lock", async () => {
    for (const yieldingFirst of [true, false]) {
      const name = `Contested, yielding ${yieldingFirst ? "first" : "second"}`;
      const created = await api.createMachine(name);
      const [yieldingTablet, takingTablet] = [randomUUID(), randomUUID()];
      const [yielding, taking] = [await opened(), await opened(other)];
      const steps = [
        () => yielding.send(helloWith(created.token, { tabletId: yieldingTablet, machine: null, yielding: true })),
        () => taking.send(helloWith(created.token, { tabletId: takingTablet, machine: null })),
      ];
      await inOrder(created.machine.id, yieldingFirst ? steps : steps.reverse());

      expect(await taking.message(0)).toMatchObject({ type: "welcome" });
      const viewed = await machine(created.machine.id);
      expect(viewed).toMatchObject({ online: true, tablet: { id: takingTablet } });
      if (yieldingFirst) {
        // Accepted while nothing held the Machine, then taken over while it was live.
        expect(await yielding.message(0)).toMatchObject({ type: "welcome" });
        await expectRefusal(yielding, "replaced");
        expect(viewed.takeover).toMatchObject({ replaced: { tabletId: yieldingTablet }, replacement: { tabletId: takingTablet } });
      } else {
        await expectRefusal(yielding, "machine_held");
        expect(viewed.takeover).toBeNull();
      }
    }
  });
});
