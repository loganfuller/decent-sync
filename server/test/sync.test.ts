import { CLOSE_CODES, PROTOCOL_VERSION } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RawConnection, SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: machine entries created through the REST API, simulated tablets
// running the built plugin against a real server on a fresh database, and
// raw frames for protocol failures. Assertions go through the REST API. The
// tests share one server and run in order.

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };
const HEARTBEAT_SECONDS = 0.5;

interface MachineView {
  id: string;
  name: string;
  model: string | null;
  serial: string | null;
  online: boolean;
  lastSeenAt: string | null;
}

describe("Machines and the sync connection", () => {
  let server: TestServer;
  let cookie: string;
  const tokens: string[] = [];
  const tablets: SimulatedTablet[] = [];

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Cookie: cookie }) =>
    fetch(`${server.url}/api${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const listMachines = async () => ((await (await call("GET", "/machines")).json()) as { machines: MachineView[] }).machines;
  const machineNamed = async (name: string) => (await listMachines()).find((machine) => machine.name === name);

  /** Polls the REST API until the Machine matches. */
  const waitForMachine = async (name: string, matches: (machine: MachineView) => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const machine = await machineNamed(name);
      if (machine && matches(machine)) return machine;
      if (Date.now() > deadline) throw new Error(`Machine ${name} did not match within ${timeoutMs} ms: ${JSON.stringify(machine)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const createMachine = async (name: string) => {
    const response = await call("POST", "/machines", { name });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { machine: MachineView; token: string; serverUrl: string };
    tokens.push(created.token);
    return created;
  };

  const loadTablet = (settings: Record<string, unknown>, options: { machineConnected?: boolean } = {}) => {
    const tablet = SimulatedTablet.load({ settings, ...options });
    tablets.push(tablet);
    return tablet;
  };

  const settingsFor = ({ token, serverUrl }: { token: string; serverUrl: string }) => ({ ServerUrl: serverUrl, Token: token });

  const helloWith = (token: string, extra: Record<string, unknown> = {}) => ({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    token,
    pluginVersion: "0.1.0",
    decaidVersion: "0.8.7+2850",
    connectionId: "00:00:5E:00:53:01",
    ...extra,
  });

  beforeAll(async () => {
    server = await startTestServer({
      env: { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) },
    });
    const setup = await call("POST", "/setup", admin, {});
    cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await server?.stop();
  });

  describe("machine entries", () => {
    it("require a session", async () => {
      expect((await call("GET", "/machines", undefined, {})).status).toBe(401);
      expect((await call("POST", "/machines", { name: "Lab" }, {})).status).toBe(401);
    });

    it("are created with a token shown once, beside the server URL the plugin needs", async () => {
      const { machine, token, serverUrl } = await createMachine("  Lab ");

      expect(machine).toEqual({ id: expect.any(String), name: "Lab", model: null, serial: null, online: false, lastSeenAt: null });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(serverUrl).toBe(server.url);
    });

    it("never show the token again", async () => {
      const response = await call("GET", "/machines");
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ machines: [expect.objectContaining({ name: "Lab" })] });
      for (const token of tokens) expect(body).not.toContain(token);
    });

    it("need a name no other Machine has", async () => {
      for (const name of ["", " ", undefined]) {
        const response = await call("POST", "/machines", { name });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { message: string[] }).message).toEqual(["Enter a name"]);
      }
      const duplicate = await call("POST", "/machines", { name: "Lab" });
      expect(duplicate.status).toBe(409);
      expect(((await duplicate.json()) as { message: string }).message).toBe("A Machine named Lab already exists");
    });
  });

  describe("a simulated tablet running the built plugin", () => {
    let uptown: Awaited<ReturnType<typeof createMachine>>;
    let tablet: SimulatedTablet;
    let connected: MachineView;

    it("connects with its Machine's token, and the Machine is listed online with a recent last-seen time", async () => {
      uptown = await createMachine("Uptown");
      const before = Date.now();
      tablet = loadTablet(settingsFor(uptown));

      connected = await waitForMachine("Uptown", (machine) => machine.online);
      expect(Date.parse(connected.lastSeenAt!)).toBeGreaterThanOrEqual(before - 1_000);
      expect(Date.parse(connected.lastSeenAt!)).toBeLessThanOrEqual(Date.now());
      await tablet.waitForLog(/^Connected to ws:\/\/127\.0\.0\.1:\d+\/sync$/);
    });

    it("binds the token to the model and serial the machine reported", () => {
      // The fixture's DE1Pro, whose serial is replaced with a made-up one.
      expect(connected).toMatchObject({ model: "DE1Pro", serial: "10001" });
    });

    it("keeps the last-seen time current with heartbeats", async () => {
      const first = Date.parse(connected.lastSeenAt!);
      const later = await waitForMachine("Uptown", (machine) => Date.parse(machine.lastSeenAt!) > first + HEARTBEAT_SECONDS * 1000);
      expect(later.online).toBe(true);
    });

    it("is listed offline after the tablet disconnects, keeping its last-seen time", async () => {
      await tablet.unload();
      const unloadedAt = Date.now();

      const offline = await waitForMachine("Uptown", (machine) => !machine.online);
      expect(Date.parse(offline.lastSeenAt!)).toBeGreaterThan(Date.parse(connected.lastSeenAt!));
      expect(Date.parse(offline.lastSeenAt!)).toBeLessThanOrEqual(unloadedAt + 1_000);
      expect(offline).toMatchObject({ model: "DE1Pro", serial: "10001" });

      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 2000));
      expect(await machineNamed("Uptown")).toEqual(offline);
    });

    it("reconnects after the network drops", async () => {
      tablet = loadTablet(settingsFor(uptown));
      await waitForMachine("Uptown", (machine) => machine.online);

      tablet.dropConnections();
      await tablet.waitForLog(/^Disconnected: the server closed the connection\. Reconnecting in 1 s\.$/);
      await waitForMachine("Uptown", (machine) => machine.online);
      expect(tablet.logs.filter((log) => log.startsWith("Connected to "))).toHaveLength(2);
    });

    it("replaces an older connection with the same token, and the older tablet stops", async () => {
      const replacement = loadTablet(settingsFor(uptown));
      await replacement.waitForLog(/^Connected to /);

      await tablet.waitForLog(/^Another tablet connected with this Machine's token, so this one stopped\./);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(tablet.logs.filter((log) => log.startsWith("Connected to "))).toHaveLength(2);
      expect(await machineNamed("Uptown")).toMatchObject({ online: true });

      await replacement.unload();
      await waitForMachine("Uptown", (machine) => !machine.online);
    });

    it("is accepted while no machine is connected to the tablet, without binding hardware", async () => {
      const belmont = await createMachine("Belmont");
      const early = loadTablet(settingsFor(belmont), { machineConnected: false });

      const online = await waitForMachine("Belmont", (machine) => machine.online);
      expect(online).toMatchObject({ model: null, serial: null });
      await early.unload();
    });

    it("stops and says why when the server refuses its token", async () => {
      const refused = loadTablet({ ServerUrl: server.url, Token: "not-a-token-this-server-issued" });
      await refused.waitForLog(/^The server refused the token\./);
      expect(refused.logs).toContain("The server reported bad token: No Machine on this server has this token; it may have been replaced by a newer one");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(refused.logs.filter((log) => log.startsWith("Disconnected"))).toEqual([]);
    });

    it("does not connect without a server URL and token, and says what is missing", async () => {
      const unset = loadTablet({});
      await unset.waitForLog(/^Not connecting: Server URL is not set; Token is not set\./);
      const wrong = loadTablet({ ServerUrl: "sync.example.com", Token: "x" });
      await wrong.waitForLog(/^Not connecting: Server URL must be the server's http:\/\/ or https:\/\/ address\./);
    });
  });

  describe("raw frames", () => {
    let raw: RawConnection | undefined;
    afterEach(async () => {
      await raw?.terminate();
      raw = undefined;
    });

    const expectRefusal = async (connection: RawConnection, code: keyof typeof CLOSE_CODES) => {
      expect(await connection.closed).toEqual({ code: CLOSE_CODES[code], reason: code });
      expect(connection.messages).toEqual([{ type: "error", code, message: expect.any(String) }]);
      return (connection.messages[0] as { message: string }).message;
    };

    it("welcome a valid hello, with the heartbeat interval", async () => {
      const { token } = await createMachine("Raw");
      raw = await RawConnection.open(server.url);
      raw.send(helloWith(token));
      expect(await raw.message(0)).toEqual({
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        heartbeatIntervalMs: HEARTBEAT_SECONDS * 1000,
      });
      await waitForMachine("Raw", (machine) => machine.online);
    });

    it("close a connection whose token is unknown with the bad-token code", async () => {
      raw = await RawConnection.open(server.url);
      raw.send(helloWith("aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSB0b2tlbg"));
      expect(await expectRefusal(raw, "bad_token")).toMatch(/has this token/);
    });

    it("close a connection that sends no hello within the timeout with the protocol-error code", async () => {
      raw = await RawConnection.open(server.url);
      const opened = Date.now();
      expect(await expectRefusal(raw, "protocol_error")).toBe("No hello within 1 seconds");
      expect(Date.now() - opened).toBeGreaterThanOrEqual(900);
    });

    it("close a connection whose hello is invalid with the protocol-error code", async () => {
      const { token } = await createMachine("Invalid hello");
      const invalid: [unknown, string][] = [
        [helloWith(token, { token: undefined }), "hello.token must be a string"],
        [helloWith(token, { pluginVersion: 7, machine: { model: "DE1Pro" } }), "hello.pluginVersion must be a string; hello.machine.serial must be a string"],
        ["{not json", "The frame is not JSON"],
        [{ type: "heartbeat" }, "The first message must be hello"],
        [{ type: "shot" }, "Unknown message type"],
        [helloWith(token, { protocolVersion: PROTOCOL_VERSION + 1 }), expect.stringContaining("update the server")],
      ];
      for (const [frame, problem] of invalid) {
        raw = await RawConnection.open(server.url);
        raw.send(frame);
        expect(await expectRefusal(raw, "protocol_error")).toEqual(problem);
      }

      raw = await RawConnection.open(server.url);
      raw.sendBinary(new TextEncoder().encode(JSON.stringify(helloWith(token))));
      expect(await expectRefusal(raw, "protocol_error")).toBe("Messages must be sent as text frames");
      expect(await machineNamed("Invalid hello")).toMatchObject({ online: false, lastSeenAt: null });
    });

    it("close a connection whose plugin is too old with the too-old code", async () => {
      const { token } = await createMachine("Old plugin");
      raw = await RawConnection.open(server.url);
      raw.send({ type: "hello", protocolVersion: 0, token });
      expect(await expectRefusal(raw, "plugin_too_old")).toMatch(/update the plugin/);
    });

    it("close a second hello, and a connection that stops sending heartbeats, with the protocol-error code", async () => {
      const { token } = await createMachine("Silent");
      raw = await RawConnection.open(server.url);
      raw.send(helloWith(token));
      await raw.message(0);
      raw.send(helloWith(token));
      await raw.closed;
      expect(raw.messages[1]).toEqual({ type: "error", code: "protocol_error", message: "hello was already sent on this connection" });

      raw = await RawConnection.open(server.url);
      raw.send(helloWith(token));
      await raw.message(0);
      const welcomed = Date.now();
      expect(await raw.closed).toEqual({ code: CLOSE_CODES.protocol_error, reason: "protocol_error" });
      expect(raw.messages[1]).toEqual({ type: "error", code: "protocol_error", message: "No heartbeat for 1.5 seconds" });
      expect(Date.now() - welcomed).toBeGreaterThanOrEqual(1_400);
      await waitForMachine("Silent", (machine) => !machine.online);
    });

    it("close the older of two connections with the same token with the replaced code", async () => {
      const { token } = await createMachine("Twice");
      const first = await RawConnection.open(server.url);
      first.send(helloWith(token));
      await first.message(0);

      raw = await RawConnection.open(server.url);
      raw.send(helloWith(token));
      await raw.message(0);
      expect(await first.closed).toEqual({ code: CLOSE_CODES.replaced, reason: "replaced" });
      expect(first.messages[1]).toEqual({ type: "error", code: "replaced", message: expect.any(String) });
      expect(await machineNamed("Twice")).toMatchObject({ online: true });
    });

    it("refuse upgrades on any path but /sync", async () => {
      const socket = new WebSocket(`${server.url.replace(/^http/, "ws")}/elsewhere`);
      const failure = await new Promise<Error>((resolve) => socket.once("error", resolve));
      expect(failure.message).toBe("Unexpected server response: 404");
    });
  });

  it("never writes a token to the server's or any tablet's log", () => {
    const logs = [server.output(), ...tablets.flatMap((tablet) => tablet.logs)].join("\n");
    expect(tokens.length).toBeGreaterThan(5);
    for (const token of [...tokens, "not-a-token-this-server-issued", "aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSB0b2tlbg"]) {
      expect(logs).not.toContain(token);
    }
    // The server did log the connections, so there was something to check.
    expect(server.output()).toMatch(/Machine Uptown connected from .*bound to DE1Pro 10001/);
  });
});
