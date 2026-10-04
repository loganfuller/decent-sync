import { CLOSE_CODES } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type MachineView, helloWith, settingsFor } from "./support/admin-api.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: who a connecting tablet is (ADR-0004, ADR-0015). Raw frames and
// simulated tablets running the built plugin connect to a real server on a
// fresh database; assertions go through the REST API. Hardware ids are made
// up: serials from 10001, connection ids from 00:00:5E:00:53:xx.

const HEARTBEAT_SECONDS = 0.5;
const FIXTURE_CONNECTION_ID = "00:00:5E:00:53:01";
const de1Pro = (serial: string) => ({ model: "DE1Pro", serial, firmware: "1333" });

describe("Machine identity", { timeout: 20_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const connections: RawConnection[] = [];

  const loadTablet = (settings: Record<string, unknown>, options: Omit<Parameters<typeof SimulatedTablet.load>[0], "settings"> = {}) => {
    const tablet = SimulatedTablet.load({ settings, ...options });
    tablets.push(tablet);
    return tablet;
  };

  /** Opens a raw connection and sends a hello, resolving with the connection once the server answers. */
  const connect = async (hello: Record<string, unknown>) => {
    const raw = await RawConnection.open(server.url);
    connections.push(raw);
    raw.send(hello);
    await raw.message(0);
    return raw;
  };

  const expectWelcomed = (raw: RawConnection) => expect(raw.messages[0]).toMatchObject({ type: "welcome" });

  const expectRefusal = async (raw: RawConnection, code: keyof typeof CLOSE_CODES) => {
    expect(await raw.closed).toEqual({ code: CLOSE_CODES[code], reason: code });
    const error = raw.messages.at(-1) as { type: string; code: string; message: string };
    expect(error).toEqual({ type: "error", code, message: expect.any(String) });
    return error.message;
  };

  /** A machine entry whose token a raw connection has bound to DE1Pro `serial` from `connectionId`. */
  const boundMachine = async (name: string, serial: string, connectionId: string) => {
    const created = await api.createMachine(name);
    const raw = await connect(helloWith(created.token, { machine: de1Pro(serial), connectionId }));
    expectWelcomed(raw);
    await raw.close();
    await api.waitForMachine(name, (machine) => !machine.online);
    return created;
  };

  beforeAll(async () => {
    server = await startTestServer({
      env: { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) },
    });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await server?.stop();
  });

  describe("binding and aliases (raw frames)", () => {
    let lab: CreatedMachine;

    it("binds a token to the first hardware it reports, remembering the connection id and versions", async () => {
      lab = await boundMachine("Lab", "10001", "00:00:5E:00:53:10");
      expect(await api.machineNamed("Lab")).toMatchObject({
        model: "DE1Pro",
        serial: "10001",
        identification: "identified",
        reported: { model: "DE1Pro", serial: "10001", firmware: "1333" },
        connectionId: "00:00:5E:00:53:10",
        pluginVersion: "0.1.0",
        decaidVersion: "0.8.7+2850",
        aliases: ["00:00:5E:00:53:10"],
        mismatch: null,
        lastRefusal: null,
      });
    });

    it("keeps the same Machine for a new tablet on the same hardware, remembering its connection id too", async () => {
      const before = await api.machines();
      const raw = await connect(helloWith(lab.token, { machine: de1Pro("10001"), connectionId: "00:00:5E:00:53:11" }));
      expectWelcomed(raw);

      const after = await api.machines();
      expect(after.map((machine) => machine.id)).toEqual(before.map((machine) => machine.id));
      expect(after.find((machine) => machine.name === "Lab")).toMatchObject({
        id: lab.machine.id,
        identification: "identified",
        connectionId: "00:00:5E:00:53:11",
        aliases: ["00:00:5E:00:53:10", "00:00:5E:00:53:11"],
        online: true,
      });
    });

    it("recognises the Machine by a known alias when its tablet reports no hardware", async () => {
      const raw = await connect(helloWith(lab.token, { machine: null, connectionId: "00:00:5E:00:53:10" }));
      expectWelcomed(raw);
      expect(await api.machineNamed("Lab")).toMatchObject({ identification: "identified", model: "DE1Pro", serial: "10001" });
    });

    it("shows hardware not yet reported, keeping the binding, when no hardware comes from an unknown connection id", async () => {
      const raw = await connect(helloWith(lab.token, { connectionId: "00:00:5E:00:53:19" }));
      expectWelcomed(raw);
      expect(await api.machineNamed("Lab")).toMatchObject({
        identification: "hardwareNotReported",
        model: "DE1Pro",
        serial: "10001",
        mismatch: null,
        // An unconfirmed connection id is not remembered.
        aliases: ["00:00:5E:00:53:10", "00:00:5E:00:53:11"],
      });
    });

    it("replaces a connection with a second one using the same token, and the stale close leaves the Machine online", async () => {
      const first = await connect(helloWith(lab.token, { machine: de1Pro("10001") }));
      const second = await connect(helloWith(lab.token, { machine: de1Pro("10001") }));
      expectWelcomed(second);
      expect(await expectRefusal(first, "replaced")).toMatch(/newer connection/);

      // The replaced connection's close reaches the server after the replacement.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await api.machineNamed("Lab")).toMatchObject({ online: true });
      await second.terminate();
      await api.waitForMachine("Lab", (machine) => !machine.online);
    });
  });

  describe("mismatches and Pending Machines (raw frames)", () => {
    let lab: CreatedMachine;

    it("accepts a different serial on a bound token as a mismatch, holding its hardware as a Pending Machine", async () => {
      lab = await boundMachine("Mismatch lab", "10101", "00:00:5E:00:53:20");
      const raw = await connect(helloWith(lab.token, { machine: de1Pro("10102"), connectionId: "00:00:5E:00:53:21" }));
      expectWelcomed(raw);

      const [pending] = await api.pendingMachines();
      expect(pending).toEqual({
        id: expect.any(String),
        model: "DE1Pro",
        serial: "10102",
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
        dismissed: false,
        mismatchedMachines: [{ id: lab.machine.id, name: "Mismatch lab" }],
      });
      expect(await api.machineNamed("Mismatch lab")).toMatchObject({
        // The token stays bound to its own hardware.
        model: "DE1Pro",
        serial: "10101",
        identification: "mismatch",
        mismatch: { model: "DE1Pro", serial: "10102", pendingMachineId: pending!.id, machine: null },
        // The other hardware's connection id is not this Machine's.
        aliases: ["00:00:5E:00:53:20"],
        online: true,
      });
    });

    it("resolves the mismatch by creating a machine entry for the hardware, which is issued its own token", async () => {
      const [pending] = await api.pendingMachines();
      const response = await api.call("POST", `/pending-machines/${pending!.id}/machine`, { name: "Mismatch lab two" });
      expect(response.status).toBe(201);
      const created = await api.issued(response);
      expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.serverUrl).toBe(server.url);
      expect(created.machine).toMatchObject({ name: "Mismatch lab two", model: "DE1Pro", serial: "10102", identification: "identified" });

      expect(await api.pendingMachines()).toEqual([]);
      // The tablet still uses the old token: its hardware now has a Machine of its own.
      expect((await api.machineNamed("Mismatch lab"))!.mismatch).toEqual({
        model: "DE1Pro",
        serial: "10102",
        pendingMachineId: null,
        machine: { id: created.machine.id, name: "Mismatch lab two" },
      });

      const raw = await connect(helloWith(created.token, { machine: de1Pro("10102"), connectionId: "00:00:5E:00:53:21" }));
      expectWelcomed(raw);
      expect(await api.machineNamed("Mismatch lab two")).toMatchObject({ identification: "identified", aliases: ["00:00:5E:00:53:21"] });
    });

    it("treats the same serial on another model as other hardware", async () => {
      const raw = await connect(helloWith(lab.token, { machine: { model: "DE1XL", serial: "10101" } }));
      expectWelcomed(raw);
      expect(await api.machineNamed("Mismatch lab")).toMatchObject({
        model: "DE1Pro",
        serial: "10101",
        identification: "mismatch",
        mismatch: { model: "DE1XL", serial: "10101", machine: null },
      });
      expect(await api.pendingMachines()).toMatchObject([{ model: "DE1XL", serial: "10101", dismissed: false }]);
    });

    it("dismissing the Pending Machine closes and refuses that hardware with this token, and shows why", async () => {
      const live = await connect(helloWith(lab.token, { machine: { model: "DE1XL", serial: "10101" } }));
      expectWelcomed(live);
      const [pending] = await api.pendingMachines();
      const response = await api.call("POST", `/pending-machines/${pending!.id}/dismiss`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { pendingMachine: unknown }).pendingMachine).toMatchObject({
        dismissed: true,
        mismatchedMachines: [{ name: "Mismatch lab" }],
      });

      expect(await expectRefusal(live, "hardware_dismissed")).toMatch(/dismissed DE1XL serial 10101/);
      const refused = await connect(helloWith(lab.token, { machine: { model: "DE1XL", serial: "10101" } }));
      expect(await expectRefusal(refused, "hardware_dismissed")).toMatch(/dismissed DE1XL serial 10101/);
      expect(await api.machineNamed("Mismatch lab")).toMatchObject({
        online: false,
        lastRefusal: { reason: expect.stringContaining("dismissed DE1XL serial 10101"), at: expect.any(String) },
      });
      // Dismissed Pending Machines are kept, so a machine entry can still be created for them.
      expect(await api.pendingMachines()).toMatchObject([{ id: pending!.id, dismissed: true }]);

      // The token's own hardware still connects, which clears the refusal.
      const own = await connect(helloWith(lab.token, { machine: de1Pro("10101"), connectionId: "00:00:5E:00:53:20" }));
      expectWelcomed(own);
      expect(await api.machineNamed("Mismatch lab")).toMatchObject({ identification: "identified", mismatch: null, lastRefusal: null });
    });

    it("flags an unbound token reporting another Machine's hardware as a mismatch, without binding it", async () => {
      const spare = await api.createMachine("Spare token");
      const raw = await connect(helloWith(spare.token, { machine: de1Pro("10101") }));
      expectWelcomed(raw);
      expect(await api.machineNamed("Spare token")).toMatchObject({
        model: null,
        serial: null,
        identification: "mismatch",
        mismatch: { model: "DE1Pro", serial: "10101", pendingMachineId: null, machine: { id: lab.machine.id, name: "Mismatch lab" } },
      });
    });

    it("refuses Pending Machine actions on unknown ids and duplicate names", async () => {
      expect((await api.call("POST", "/pending-machines/not-an-id/dismiss")).status).toBe(404);
      expect((await api.call("POST", "/pending-machines/00000000-0000-7000-8000-000000000000/machine", { name: "X" })).status).toBe(404);
      const [pending] = await api.pendingMachines();
      const duplicate = await api.call("POST", `/pending-machines/${pending!.id}/machine`, { name: "Mismatch lab" });
      expect(duplicate.status).toBe(409);
      expect((await api.call("GET", "/pending-machines", undefined, {})).status).toBe(401);
    });
  });

  describe("Unidentified Machines", () => {
    let old: CreatedMachine;
    let tablet: SimulatedTablet;

    it("lists a machine reporting serial 0 as an Unidentified Machine that stays connected, never bound to that serial", async () => {
      old = await api.createMachine("Old DE1");
      tablet = loadTablet(settingsFor(old), { api: derivedDe1Pro({ model: "DE1", serial: "0" }) });

      const machine = await api.waitForMachine("Old DE1", (candidate) => candidate.online && candidate.identification === "unidentified");
      expect(machine).toMatchObject({
        model: null,
        serial: null,
        identification: "unidentified",
        reported: { model: "DE1", serial: "0" },
        mismatch: null,
        aliases: [FIXTURE_CONNECTION_ID],
      });
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 4000));
      expect(await api.machineNamed("Old DE1")).toMatchObject({ online: true, identification: "unidentified" });
      expect(tablet.logs.filter((log) => log.startsWith("Disconnected") || log.includes("Reconnecting"))).toEqual([]);
      expect(await api.pendingMachines()).not.toContainEqual(expect.objectContaining({ serial: "0" }));
    });

    it("needs a real model and serial entered by hand", async () => {
      const path = `/machines/${old.machine.id}/hardware`;
      const zero = await api.call("PUT", path, { model: "DE1", serial: "0" });
      expect(zero.status).toBe(400);
      expect(((await zero.json()) as { message: string[] }).message).toEqual([
        "Enter the machine's serial number; 0 is what a machine without one reports",
      ]);
      const unknown = await api.call("PUT", path, { model: "Espresso 3000", serial: "10201" });
      expect(unknown.status).toBe(400);
      // The models to choose from, as Decaid names them.
      const { models } = (await (await api.call("GET", "/machines/models")).json()) as { models: string[] };
      expect(models).toEqual(["DE1", "DE1Plus", "DE1Pro", "DE1XL", "DE1Cafe", "DE1XXL", "DE1XXXL", "Bengle"]);
      expect((await api.call("PUT", path, { model: "DE1Pro", serial: "10101" })).status).toBe(409);
      expect(await api.machineNamed("Old DE1")).toMatchObject({ identification: "unidentified", model: null });
    });

    it("becomes identified when an Admin enters its model and serial, and stays identified when its tablet reconnects", async () => {
      const response = await api.call("PUT", `/machines/${old.machine.id}/hardware`, { model: "DE1", serial: "10201" });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { machine: MachineView }).machine).toMatchObject({
        model: "DE1",
        serial: "10201",
        identification: "identified",
        aliases: [FIXTURE_CONNECTION_ID],
      });

      // The machine still reports serial 0; its known connection id recognises it.
      tablet.dropConnections();
      await tablet.waitForLogs(/^Connected to /, 2);
      await api.waitForMachine("Old DE1", (machine) => machine.online);
      expect(await api.machineNamed("Old DE1")).toMatchObject({ model: "DE1", serial: "10201", identification: "identified" });

      // Only an Unidentified Machine's hardware is entered by hand.
      expect((await api.call("PUT", `/machines/${old.machine.id}/hardware`, { model: "DE1", serial: "10202" })).status).toBe(409);
      await tablet.unload();
    });

    it("can have its hardware entered while its tablet starts before its machine", async () => {
      const morning = await api.createMachine("Old DE1 at dawn");
      const raw = await connect(helloWith(morning.token, { machine: { model: "DE1", serial: "0" }, connectionId: "00:00:5E:00:53:28" }));
      expectWelcomed(raw);
      await raw.close();
      // The next morning the tablet connects before the machine is switched on.
      const early = await connect(helloWith(morning.token, { connectionId: "00:00:5E:00:53:28" }));
      expectWelcomed(early);
      expect(await api.machineNamed("Old DE1 at dawn")).toMatchObject({ identification: "hardwareNotReported", model: null });

      const response = await api.call("PUT", `/machines/${morning.machine.id}/hardware`, { model: "DE1", serial: "10211" });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { machine: MachineView }).machine).toMatchObject({
        identification: "identified",
        model: "DE1",
        serial: "10211",
        aliases: ["00:00:5E:00:53:28"],
      });
    });

    it("is flagged again when its token reports serial 0 from an unknown connection id", async () => {
      const raw = await connect(helloWith(old.token, { machine: { model: "DE1", serial: "0" }, connectionId: "00:00:5E:00:53:29" }));
      expectWelcomed(raw);
      expect(await api.machineNamed("Old DE1")).toMatchObject({
        model: "DE1",
        serial: "10201",
        identification: "unidentified",
        aliases: [FIXTURE_CONNECTION_ID],
      });
    });
  });

  describe("tokens", () => {
    it("reissuing a token closes the connection using the old one, which can no longer connect", async () => {
      const created = await api.createMachine("Reissued");
      const tablet = loadTablet(settingsFor(created));
      await api.waitForMachine("Reissued", (machine) => machine.online);

      const response = await api.call("POST", `/machines/${created.machine.id}/token`);
      expect(response.status).toBe(201);
      const reissued = await api.issued(response);
      expect(reissued.token).not.toBe(created.token);
      expect(reissued.serverUrl).toBe(server.url);

      await tablet.waitForLog(/^The server refused the token\./);
      await api.waitForMachine("Reissued", (machine) => !machine.online);
      const old = await connect(helloWith(created.token, { machine: de1Pro("10001") }));
      await expectRefusal(old, "bad_token");

      const fresh = loadTablet(settingsFor(reissued));
      await api.waitForMachine("Reissued", (machine) => machine.online);
      await fresh.unload();
    });

    it("refuses to reissue or identify an unknown Machine", async () => {
      expect((await api.call("POST", "/machines/00000000-0000-7000-8000-000000000000/token")).status).toBe(404);
      expect((await api.call("PUT", "/machines/nope/hardware", { model: "DE1", serial: "1" })).status).toBe(404);
      expect((await api.call("POST", "/machines/00000000-0000-7000-8000-000000000000/token", undefined, {})).status).toBe(401);
    });
  });

  describe("protocol versions", () => {
    it("refuses a too-old plugin and shows the reason on its token's Machine", async () => {
      const created = await api.createMachine("Old plugin");
      const raw = await RawConnection.open(server.url);
      connections.push(raw);
      raw.send({ type: "hello", protocolVersion: 0, token: created.token });
      expect(await expectRefusal(raw, "plugin_too_old")).toMatch(/update the plugin/);

      expect((await api.machineNamed("Old plugin"))!.lastRefusal).toEqual({
        reason: expect.stringContaining("update the plugin"),
        at: expect.any(String),
      });
      const response = await api.call("GET", `/machines/${created.machine.id}`);
      expect(((await response.json()) as { machine: MachineView }).machine.lastRefusal?.reason).toMatch(/update the plugin/);
    });

    it("shows a plugin newer than the server on its Machine too", async () => {
      const created = await api.createMachine("New plugin");
      const raw = await RawConnection.open(server.url);
      connections.push(raw);
      raw.send(helloWith(created.token, { protocolVersion: 99 }));
      await expectRefusal(raw, "protocol_error");
      expect((await api.machineNamed("New plugin"))!.lastRefusal?.reason).toMatch(/update the server/);
    });

    it("never lets an invalid token change any Machine's status", async () => {
      // Refusals only: a Machine that disconnected moments ago may still be having its last-seen time recorded.
      const refusals = async () => (await api.machines()).map(({ name, lastRefusal }) => ({ name, lastRefusal }));
      const before = await refusals();
      for (const token of ["not-a-token-this-server-issued", api.tokens[0]!.slice(1)]) {
        const raw = await RawConnection.open(server.url);
        connections.push(raw);
        raw.send({ type: "hello", protocolVersion: 0, token });
        await expectRefusal(raw, "plugin_too_old");
      }
      expect(await refusals()).toEqual(before);
    });
  });

  describe("a simulated tablet whose machine is disconnected", () => {
    let home: CreatedMachine;
    const homeApi = (connectionId?: string) => derivedDe1Pro({ serial: "10501", connectionId });

    it("binds while its machine is connected", async () => {
      home = await api.createMachine("Home");
      const tablet = loadTablet(settingsFor(home), { api: homeApi() });
      await api.waitForMachine("Home", (machine) => machine.online && machine.identification === "identified");
      await tablet.unload();
      await api.waitForMachine("Home", (machine) => !machine.online);
    });

    it("is identified by its known connection id while its machine is off", async () => {
      const tablet = loadTablet(settingsFor(home), { machineConnected: false, api: homeApi() });
      const machine = await api.waitForMachine("Home", (candidate) => candidate.online);
      expect(machine).toMatchObject({ identification: "identified", model: "DE1Pro", serial: "10501", mismatch: null });
      await tablet.unload();
      await api.waitForMachine("Home", (candidate) => !candidate.online);
    });

    it("shows hardware not yet reported from an unknown connection id, then reconnects and is identified once the machine connects", async () => {
      // A new tablet, reaching the same machine over another connection id.
      const tablet = loadTablet(settingsFor(home), { machineConnected: false, api: homeApi("00:00:5E:00:53:31") });
      const early = await api.waitForMachine("Home", (machine) => machine.online);
      expect(early).toMatchObject({ identification: "hardwareNotReported", model: "DE1Pro", serial: "10501", mismatch: null });

      tablet.connectMachine();
      await tablet.waitForLog(/^The machine reports its hardware now\. Reconnecting to tell the server\.$/);
      await api.waitForMachine("Home", (machine) => machine.online && machine.identification === "identified");
      expect(await api.machineNamed("Home")).toMatchObject({
        model: "DE1Pro",
        serial: "10501",
        aliases: [FIXTURE_CONNECTION_ID, "00:00:5E:00:53:31"],
      });
      await tablet.unload();
      await api.waitForMachine("Home", (machine) => !machine.online);
    });

    it("reconnects as a mismatch when the machine that connects is other hardware", async () => {
      const tablet = loadTablet(settingsFor(home), {
        machineConnected: false,
        api: derivedDe1Pro({ serial: "10301", connectionId: "00:00:5E:00:53:32" }),
      });
      expect(await api.waitForMachine("Home", (machine) => machine.online)).toMatchObject({ identification: "hardwareNotReported" });

      tablet.connectMachine();
      const mismatched = await api.waitForMachine("Home", (machine) => machine.online && machine.identification === "mismatch");
      expect(mismatched).toMatchObject({ model: "DE1Pro", serial: "10501", mismatch: { model: "DE1Pro", serial: "10301" } });
      await tablet.unload();
      await api.waitForMachine("Home", (machine) => !machine.online);
    });
  });

  describe("a simulated tablet whose machine changes", () => {
    let cafe: CreatedMachine;
    let tablet: SimulatedTablet;

    it("notices different hardware by polling, and reconnects as a mismatch", async () => {
      cafe = await api.createMachine("Cafe");
      // 25 times faster: the 5 s poll runs every 200 ms.
      tablet = loadTablet({ ...settingsFor(cafe), PollSeconds: 5 }, { api: derivedDe1Pro({ serial: "10401" }), timeScale: 25 });
      await api.waitForMachine("Cafe", (machine) => machine.online && machine.identification === "identified");

      // No state update is delivered: the poll finds the change.
      tablet.serve(derivedDe1Pro({ serial: "10402" }));
      await tablet.waitForLog(/^The machine reports different hardware\. Reconnecting to tell the server\.$/);
      expect(await api.waitForMachine("Cafe", (machine) => machine.identification === "mismatch")).toMatchObject({
        model: "DE1Pro",
        serial: "10401",
        mismatch: { serial: "10402" },
      });
      await api.waitForMachine("Cafe", (machine) => machine.online);
    });

    it("stops connecting when an Admin dismisses that hardware, and connects again once the machine reports other hardware", async () => {
      const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "10402")!;
      expect((await api.call("POST", `/pending-machines/${pending.id}/dismiss`)).status).toBe(200);

      await tablet.waitForLog(/^The server refused this machine's hardware for this Machine's token\./);
      await api.waitForMachine("Cafe", (machine) => !machine.online);
      // Polls keep finding the dismissed hardware, and nothing reconnects.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(tablet.logs.filter((log) => log.startsWith("Connected to "))).toHaveLength(2);
      expect(await api.machineNamed("Cafe")).toMatchObject({ online: false, lastRefusal: { reason: expect.stringContaining("10402") } });

      tablet.serve(derivedDe1Pro({ serial: "10401" }));
      await tablet.waitForLog(/^The machine reports other hardware than the server refused\. Connecting\.$/);
      await api.waitForMachine("Cafe", (machine) => machine.online && machine.identification === "identified");
      expect(await api.machineNamed("Cafe")).toMatchObject({ lastRefusal: null });
      await tablet.unload();
    });

    it("polls the machine no more often than every 5 s, however short the poll interval set", async () => {
      const created = await api.createMachine("Impatient");
      const impatient = loadTablet({ ...settingsFor(created), PollSeconds: 0.01 }, { api: derivedDe1Pro({ serial: "10411" }) });
      await api.waitForMachine("Impatient", (machine) => machine.online);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // Only the read for its hello.
      expect(impatient.requests.filter((route) => route === "/machine/info")).toHaveLength(1);
      await impatient.unload();
    });
  });

  describe("at the same time (raw frames)", () => {
    // Each race is run several times: without the Machine's lock its outcome depends on timing.
    const ROUNDS = 5;

    it("binds a token to the hardware of the first of two simultaneous connections, and the other is a mismatch", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const name = `First of two ${round}`;
        const { token } = await api.createMachine(name);
        const [a, b] = await Promise.all([RawConnection.open(server.url), RawConnection.open(server.url)]);
        connections.push(a!, b!);
        a!.send(helloWith(token, { machine: de1Pro(`106${round}1`), connectionId: `00:00:5E:00:53:6${round}` }));
        b!.send(helloWith(token, { machine: de1Pro(`106${round}2`), connectionId: `00:00:5E:00:53:7${round}` }));
        await Promise.all([a!.message(0), b!.message(0)]);

        const machine = (await api.machineNamed(name))!;
        const bound = machine.serial === `106${round}1` ? 0 : 1;
        expect([`106${round}1`, `106${round}2`]).toContain(machine.serial);
        // The second, decided after the first bound, is the mismatch.
        expect(machine).toMatchObject({
          identification: "mismatch",
          mismatch: { serial: bound === 0 ? `106${round}2` : `106${round}1` },
          aliases: [bound === 0 ? `00:00:5E:00:53:6${round}` : `00:00:5E:00:53:7${round}`],
        });
      }
    });

    it("leaves only the last of two simultaneous reissued tokens valid", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const created = await api.createMachine(`Reissued twice ${round}`);
        const responses = await Promise.all([1, 2].map(() => api.call("POST", `/machines/${created.machine.id}/token`)));
        const tokens = [created.token];
        for (const response of responses) {
          expect(response.status).toBe(201);
          tokens.push((await api.issued(response)).token);
        }

        const answers = [];
        for (const token of tokens) {
          const raw = await connect(helloWith(token, { machine: de1Pro(`107${round}1`) }));
          answers.push((raw.messages[0] as { type: string; code?: string }).code ?? "welcome");
          await raw.close();
        }
        expect(answers[0]).toBe("bad_token");
        expect(answers.slice(1).sort()).toEqual(["bad_token", "welcome"]);
      }
    });

    it("closes a connection whose hello is accepted while its token is reissued", async () => {
      for (let round = 0; round < ROUNDS * 2; round++) {
        const created = await api.createMachine(`Reissued mid-hello ${round}`);
        const raw = await RawConnection.open(server.url);
        connections.push(raw);
        raw.send(helloWith(created.token, { machine: de1Pro(`108${round}1`) }));
        const response = await api.call("POST", `/machines/${created.machine.id}/token`);
        expect(response.status).toBe(201);
        await api.issued(response);

        // Welcomed or not, the connection must not outlive its token.
        const closed = await Promise.race([raw.closed, new Promise((resolve) => setTimeout(() => resolve("still open"), 3_000))]);
        expect(closed).toEqual({ code: CLOSE_CODES.bad_token, reason: "bad_token" });
        await api.waitForMachine(`Reissued mid-hello ${round}`, (machine) => !machine.online);
      }
    });

    it("dismisses a Pending Machine while a tablet reporting it reconnects, refusing that tablet either way", async () => {
      for (let round = 0; round < ROUNDS * 2; round++) {
        const name = `Dismissed mid-hello ${round}`;
        const lab = await boundMachine(name, `110${round}0`, `00:00:5E:00:53:8${round % 10}`);
        const other = de1Pro(`110${round}1`);
        const first = await connect(helloWith(lab.token, { machine: other }));
        expectWelcomed(first);
        const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === other.serial)!;

        const again = await RawConnection.open(server.url);
        connections.push(again);
        again.send(helloWith(lab.token, { machine: other }));
        const response = await api.call("POST", `/pending-machines/${pending.id}/dismiss`);
        expect(response.status).toBe(200);
        // Refused at hello, or closed once welcomed.
        expect(await again.closed).toEqual({ code: CLOSE_CODES.hardware_dismissed, reason: "hardware_dismissed" });
        expect(await api.machineNamed(name)).toMatchObject({ lastRefusal: { reason: expect.stringContaining(other.serial) } });
      }
    });

    it("leaves no Pending Machine behind when a machine entry is created for it while a tablet reports it", async () => {
      for (let round = 0; round < ROUNDS * 2; round++) {
        const lab = await boundMachine(`Adopted mid-hello ${round}`, `111${round}0`, `00:00:5E:00:53:9${round % 10}`);
        const other = de1Pro(`111${round}1`);
        expectWelcomed(await connect(helloWith(lab.token, { machine: other })));
        const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === other.serial)!;

        const again = await RawConnection.open(server.url);
        connections.push(again);
        again.send(helloWith(lab.token, { machine: other }));
        const response = await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: `Adopted ${round}` });
        expect(response.status).toBe(201);
        await api.issued(response);
        await again.message(0);

        expect((await api.pendingMachines()).filter((candidate) => candidate.serial === other.serial)).toEqual([]);
        expect((await api.machineNamed(`Adopted mid-hello ${round}`))!.mismatch).toMatchObject({
          pendingMachineId: null,
          machine: { name: `Adopted ${round}` },
        });
      }
    });

    it("says another Machine has the hardware when a hello binds it while a machine entry is being created for it", async () => {
      for (let round = 0; round < ROUNDS * 2; round++) {
        const lab = await boundMachine(`Contested ${round}`, `112${round}0`, `00:00:5E:00:53:A${round % 10}`);
        const other = de1Pro(`112${round}1`);
        expectWelcomed(await connect(helloWith(lab.token, { machine: other })));
        const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === other.serial)!;
        const spare = await api.createMachine(`Contested spare ${round}`);

        const binding = await RawConnection.open(server.url);
        connections.push(binding);
        binding.send(helloWith(spare.token, { machine: other }));
        const response = await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: `Contested entry ${round}` });
        await binding.message(0);

        if (response.status === 201) {
          await api.issued(response);
          continue;
        }
        // The hello bound it first: the Pending Machine is gone, or the clash is named.
        expect([404, 409]).toContain(response.status);
        if (response.status === 409) {
          expect(((await response.json()) as { message: string }).message).toBe(
            `Machine Contested spare ${round} already has DE1Pro serial ${other.serial}`,
          );
        }
      }
    });

    it("refuses a revoked token, leaving the connection with the current token alone", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const created = await api.createMachine(`Revoked and current ${round}`);
        const reissued = await api.issued(await api.call("POST", `/machines/${created.machine.id}/token`));
        const [revoked, current] = await Promise.all([RawConnection.open(server.url), RawConnection.open(server.url)]);
        connections.push(revoked!, current!);
        revoked!.send(helloWith(created.token, { machine: de1Pro(`113${round}1`) }));
        current!.send(helloWith(reissued.token, { machine: de1Pro(`113${round}1`) }));

        await expectRefusal(revoked!, "bad_token");
        expect(await current!.message(0)).toMatchObject({ type: "welcome" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(current!.messages).toHaveLength(1);
      }
    });

    it("never lets a hello refused for its revoked token replace the connection using the new one", async () => {
      for (let round = 0; round < ROUNDS * 2; round++) {
        const name = `Stale hello ${round}`;
        const created = await api.createMachine(name);
        const stale = await RawConnection.open(server.url);
        connections.push(stale);
        stale.send(helloWith(created.token, { machine: de1Pro(`109${round}1`) }));
        const reissued = await api.issued(await api.call("POST", `/machines/${created.machine.id}/token`));
        const current = await connect(helloWith(reissued.token, { machine: de1Pro(`109${round}1`) }));
        expectWelcomed(current);

        expect(await stale.closed).toEqual({ code: CLOSE_CODES.bad_token, reason: "bad_token" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(current.messages).toHaveLength(1);
        expect(await api.machineNamed(name)).toMatchObject({ online: true, identification: "identified" });
      }
    });
  });

  it("never writes a token to the server's or any tablet's log", () => {
    const logs = [server.output(), ...tablets.flatMap((tablet) => tablet.logs)].join("\n");
    expect(api.tokens.length).toBeGreaterThan(5);
    for (const token of api.tokens) expect(logs).not.toContain(token);
  });
});
