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

      const machine = await api.waitForMachine("Old DE1", (candidate) => candidate.online);
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
      const before = await api.machines();
      for (const token of ["not-a-token-this-server-issued", api.tokens[0]!.slice(1)]) {
        const raw = await RawConnection.open(server.url);
        connections.push(raw);
        raw.send({ type: "hello", protocolVersion: 0, token });
        await expectRefusal(raw, "plugin_too_old");
      }
      expect(await api.machines()).toEqual(before);
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
      tablet = loadTablet({ ...settingsFor(cafe), PollSeconds: 0.2 }, { api: derivedDe1Pro({ serial: "10401" }) });
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
  });

  it("never writes a token to the server's or any tablet's log", () => {
    const logs = [server.output(), ...tablets.flatMap((tablet) => tablet.logs)].join("\n");
    expect(api.tokens.length).toBeGreaterThan(5);
    for (const token of api.tokens) expect(logs).not.toContain(token);
  });
});
