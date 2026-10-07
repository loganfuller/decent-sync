import { randomUUID } from "node:crypto";
import net from "node:net";
import { CLOSE_CODES, MISSED_HEARTBEATS, PROTOCOL_VERSION } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AdminApi, type MachineView } from "./support/admin-api.js";
import { RawConnection, SimulatedTablet, type SimulatedTabletOptions, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: machine entries created through the REST API, simulated tablets
// running the built plugin against a real server on a fresh database, and
// raw frames for protocol failures. Assertions go through the REST API. The
// tests share one server and run in order.

const HEARTBEAT_SECONDS = 0.5;

describe("Machines and the sync connection", () => {
  let server: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];

  const call = (...args: Parameters<AdminApi["call"]>) => api.call(...args);
  const machineNamed = (name: string) => api.machineNamed(name);
  const waitForMachine = (name: string, matches: (machine: MachineView) => boolean) => api.waitForMachine(name, matches);
  const createMachine = (name: string) => api.createMachine(name);
  const disconnects = (tablet: SimulatedTablet) => tablet.logs.filter((log) => log.startsWith("Disconnected"));

  const loadTablet = (settings: Record<string, unknown>, options: Omit<SimulatedTabletOptions, "settings"> = {}) => {
    const tablet = SimulatedTablet.load({ settings, ...options });
    tablets.push(tablet);
    return tablet;
  };

  beforeAll(async () => {
    server = await startTestServer({
      env: { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) },
    });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await server?.stop();
  });

  describe("machine entries", () => {
    runAsSteps();

    it("are created with a token shown once, beside the server URL the plugin needs", async () => {
      const { machine, token, serverUrl } = await createMachine("  Lab ");

      expect(machine).toEqual({
        id: expect.any(String),
        name: "Lab",
        model: null,
        serial: null,
        identification: "hardwareNotReported",
        reported: null,
        connectionId: null,
        pluginVersion: null,
        decaidVersion: null,
        aliases: [],
        mismatch: null,
        lastRefusal: null,
        takeover: null,
        online: false,
        lastSeenAt: null,
        lastShot: null,
        machineState: null,
        location: null,
        locationHistory: [],
        tablet: null,
        earlierTablets: [],
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(serverUrl).toBe(server.url);
    });

    it("never show the token again", async () => {
      const response = await call("GET", "/machines");
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ machines: [expect.objectContaining({ name: "Lab" })] });
      for (const token of api.tokens) expect(body).not.toContain(token);
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
    describe("from connecting to being replaced", () => {
      runAsSteps();
      let uptown: Awaited<ReturnType<typeof createMachine>>;
      let tablet: SimulatedTablet;
      let connected: MachineView;

      it("connects with its Machine's token, and the Machine is listed online with a recent last-seen time", async () => {
        uptown = await createMachine("Uptown");
        const before = Date.now();
        tablet = loadTablet(settingsFor(uptown));

        connected = await waitForMachine("Uptown", (machine) => machine.online);
        // The last-seen time is by PostgreSQL's clock, which may run ahead of or behind this one.
        expect(Date.parse(connected.lastSeenAt!)).toBeGreaterThanOrEqual(before - 1_000);
        expect(Date.parse(connected.lastSeenAt!)).toBeLessThanOrEqual(Date.now() + 1_000);
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
        // Until the server notices the drop, the REST API still lists the old connection, so wait for the new one.
        expect(await tablet.waitForLogs(/^Connected to /, 2)).toHaveLength(2);
        await waitForMachine("Uptown", (machine) => machine.online);
      });

      it("replaces an older connection with the same token from another tablet, and the older tablet waits", async () => {
        const replacement = loadTablet(settingsFor(uptown));
        await replacement.waitForLog(/^Connected to /);

        await tablet.waitForLog(/^Another tablet connected with this Machine's token and took over\. Connecting again in 300 s,/);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(tablet.logs.filter((log) => log.startsWith("Connected to "))).toHaveLength(2);
        expect(await machineNamed("Uptown")).toMatchObject({ online: true });

        await replacement.unload();
        await waitForMachine("Uptown", (machine) => !machine.online);
      });
    });

    it("reconnects when the server stops answering without closing the connection", async () => {
      const lab = await createMachine("Behind a lost path");
      const proxy = await startPartitioningProxy(server.url);
      try {
        const tablet = loadTablet(settingsFor({ ...lab, serverUrl: proxy.url }));
        await tablet.waitForLog(/^Connected to /);
        // A server answering its heartbeats keeps the connection.
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 4000));
        expect(tablet.logs.filter((log) => log.startsWith("Disconnected"))).toEqual([]);

        // The path to the server is lost, as when its host vanishes: nothing arrives, and nothing closes.
        proxy.partition();
        await tablet.waitForLog(/^Disconnected: heard nothing from the server for 1\.5 s\. Reconnecting in 1 s\.$/);

        // The path stays lost until the plugin gives up on it, however quickly the server answers (#30).
        proxy.heal();
        expect(await tablet.waitForLogs(/^Connected to /, 2)).toHaveLength(2);
        await waitForMachine("Behind a lost path", (machine) => machine.online);
        await tablet.unload();
      } finally {
        await proxy.close();
      }
    }, 15_000);

    it("heartbeats at the server's pace when sped up, so a slow path does not drop it", async () => {
      const far = await createMachine("Far away, sped up");
      // 25 times faster, the plugin's own timings shrink, but not the 1.5 s it waits for the server's answers.
      const proxy = await startPartitioningProxy(server.url, { latencyMs: 100 });
      try {
        const tablet = loadTablet(settingsFor({ ...far, serverUrl: proxy.url }), { timeScale: 25 });
        const connected = await tablet.waitForLog(/^Connected to /);
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 4000));
        // The sped-up connect deadline (#30) ends at welcome, so nothing may drop the connection after it.
        const since = tablet.logs.slice(tablet.logs.indexOf(connected) + 1);
        expect(since.filter((log) => log.startsWith("Disconnected"))).toEqual([]);
        await tablet.unload();
      } finally {
        await proxy.close();
      }
    }, 15_000);

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

    it("waits to connect until Decaid's API reports Decaid's version", async () => {
      const unread = await createMachine("Version unread");
      const tablet = loadTablet(settingsFor(unread));
      tablet.failNextApiReads("/info", 1);
      await tablet.waitForLog(/^Disconnected: could not read Decaid's version from its API\. Reconnecting in 1 s\.$/);
      expect(await waitForMachine("Version unread", (machine) => machine.online)).toMatchObject({ decaidVersion: "0.8.7+2847" });
    });

    it("connects while earlier attempts the server never answered still hold their transports", async () => {
      const lab = await createMachine("Behind a stalling proxy");
      const proxy = await startStallingProxy(server.url, 2);
      try {
        // 25 times faster, with upgrades timed at that pace too: the deadline for each attempt the proxy stalls passes
        // in 600 ms of real time, which is also all the server has to accept the upgrade of the attempt the proxy
        // passes through. It then waits for welcome in real time, so a server slow to welcome adds no third timeout.
        const tablet = loadTablet(settingsFor({ ...lab, serverUrl: proxy.url }), { timeScale: 25, upgradeAtTabletPace: true });
        await tablet.waitForLog(/^Connected to /);
        expect(disconnects(tablet)).toEqual([
          "Disconnected: the server did not answer within 15 s. Reconnecting in 1 s.",
          "Disconnected: the server did not answer within 15 s. Reconnecting in 2 s.",
        ]);
        expect(proxy.stalled.filter((socket) => !socket.destroyed), disconnects(tablet).join("\n")).toHaveLength(2);
        await waitForMachine("Behind a stalling proxy", (machine) => machine.online);
        await tablet.unload();
      } finally {
        await proxy.close();
      }
    }, 15_000);

    it("stays within Decaid's transport limit while the server never answers, and connects once those attempts end", async () => {
      const lab = await createMachine("Behind a hung proxy");
      const proxy = await startStallingProxy(server.url, Infinity);
      try {
        // Upgrades are timed at the tablet's pace, so each stalled one times out in 150 ms. Once the proxy passes
        // attempts through, one the server is slow to upgrade only delays the connection.
        const tablet = loadTablet(settingsFor({ ...lab, serverUrl: proxy.url }), { timeScale: 100, upgradeAtTabletPace: true });
        await tablet.waitForLog(/^Disconnected: 8 earlier connection attempts are still waiting for the server to answer/);
        expect(proxy.stalled, disconnects(tablet).join("\n")).toHaveLength(8);
        // The plugin never asked Decaid for a ninth transport.
        expect(tablet.logs.join("\n")).not.toContain("Too many open transports");

        // The hung server finally drops them, and answers from now on.
        proxy.stallNext(0);
        for (const socket of proxy.stalled) socket.destroy();
        await tablet.waitForLog(/^Connected to /);
        await waitForMachine("Behind a hung proxy", (machine) => machine.online);
        await tablet.unload();
      } finally {
        await proxy.close();
      }
    }, 15_000);

    it("connects when Decaid's API is slower than the connect deadline", async () => {
      const slow = await createMachine("Slow API");
      // Each read takes 20 s of the tablet's time: longer than the 15 s deadline, within Decaid's 30 s fetch timeout.
      // 100 times faster, the reads take 200 ms, while the deadline would pass in 150 ms if it covered them.
      const tablet = loadTablet(settingsFor(slow), { timeScale: 100, apiDelayMs: 20_000 });
      await tablet.waitForLog(/^Connected to /);
      expect(disconnects(tablet)).toEqual([]);
      await waitForMachine("Slow API", (machine) => machine.online);
      await tablet.unload();

      // Reads that time out leave no Decaid version, without which the server would refuse the hello: the plugin retries instead.
      const timedOut = await createMachine("API timing out");
      const second = loadTablet(settingsFor(timedOut), { timeScale: 100, apiDelayMs: 30_000 });
      await second.waitForLog(/^Disconnected: could not read Decaid's version from its API\./);
      expect(await machineNamed("API timing out")).toMatchObject({ online: false, lastSeenAt: null, lastRefusal: null });
      await second.unload();
    }, 15_000);

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

    it("welcome a valid hello, with the heartbeat interval, and answer each heartbeat", async () => {
      const { token } = await createMachine("Raw");
      raw = await RawConnection.open(server.url);
      raw.send(helloWith(token));
      expect(await raw.message(0)).toEqual({
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        heartbeatIntervalMs: HEARTBEAT_SECONDS * 1000,
      });
      await waitForMachine("Raw", (machine) => machine.online);
      raw.send({ type: "heartbeat" });
      expect(await raw.message(1)).toEqual({ type: "heartbeat" });
      raw.send({ type: "heartbeat" });
      expect(await raw.message(2)).toEqual({ type: "heartbeat" });
    });

    it("answer heartbeats, and keep the connection, while the database is slow to record them", async () => {
      const created = await createMachine("Slow database");
      raw = await RawConnection.open(server.url);
      raw.send(helloWith(created.token));
      await raw.message(0);
      const database = await server.connectDatabase();
      try {
        // Holding the Machine's row stalls recording each heartbeat, for longer than three intervals.
        await database.query("BEGIN");
        await database.query("SELECT 1 FROM machines WHERE id = $1 FOR UPDATE", [created.machine.id]);
        for (let beat = 1; beat <= 8; beat++) {
          raw.send({ type: "heartbeat" });
          // Within the intervals the plugin waits before it drops a silent connection.
          expect(await raw.message(beat, HEARTBEAT_SECONDS * 1000 * MISSED_HEARTBEATS)).toEqual({ type: "heartbeat" });
          await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 500));
        }
        await database.query("ROLLBACK");
      } finally {
        await database.end();
      }
      expect(raw.messages.filter((message) => (message as { type: string }).type === "error")).toEqual([]);
      await waitForMachine("Slow database", (machine) => machine.online);
    }, 15_000);

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
        [helloWith(token, { decaidVersion: undefined }), "hello.decaidVersion must be a string"],
        [helloWith(token, { tabletId: undefined }), "hello.tabletId must be a UUID"],
        ["{not json", "The frame is not JSON"],
        [{ type: "heartbeat" }, "The first message must be hello"],
        [{ type: "shot" }, "shot.id must be a string; shot.shotId must be a string; shot.shot must be an object"],
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

    it("log what a hello reported quoted and escaped, so a tablet cannot forge log lines or control a terminal", async () => {
      // Logged as sent, each would end its line and forge another, then control the terminal showing the log.
      const forged = (value: string) => `${value}\nWARN [Sync] forged\u001b[2J\u009b2J\u2028\u202e`;
      const escaped = (value: string) => String.raw`${value}\u000aWARN [Sync] forged\u001b[2J\u009b2J\u2028\u202e`;
      const quoted = (value: string) => String.raw`"${value}\nWARN [Sync] forged\u001b[2J\u009b2J\u2028\u202e"`;
      const { token } = await createMachine("Forged hello");
      const [firstTablet, secondTablet] = [randomUUID(), randomUUID()];
      const first = await RawConnection.welcomed(server.url, helloWith(token, {
        tabletId: firstTablet, pluginVersion: forged("0.1.0"), machine: { model: forged("DE1Pro"), serial: forged("20001") },
      }));
      // Another tablet takes the Machine over from it, reporting other hardware, which an Admin then dismisses.
      raw = await RawConnection.welcomed(server.url, helloWith(token, { tabletId: secondTablet, machine: { model: forged("DE1XL"), serial: forged("20002") } }));
      expect(await first.closed).toEqual({ code: CLOSE_CODES.replaced, reason: "replaced" });
      const pending = (await api.pendingMachines()).find((machine) => machine.model === forged("DE1XL"));
      expect((await call("POST", `/pending-machines/${pending!.id}/dismiss`)).status).toBe(200);
      expect(await raw.closed).toEqual({ code: CLOSE_CODES.hardware_dismissed, reason: "hardware_dismissed" });

      for (const line of [
        `Machine Forged hello connected from 127.0.0.1: plugin ${quoted("0.1.0")}, Decaid "0.8.7+2847", bound to ${quoted("DE1Pro")} serial ${quoted("20001")}`,
        `Machine Forged hello was taken over by tablet ${secondTablet} from 127.0.0.1, from tablet ${firstTablet} at 127.0.0.1: plugin ${quoted("0.1.0")}, Decaid "0.8.7+2847", which was still connected`,
        `Machine Forged hello connected from 127.0.0.1: plugin "0.1.0", Decaid "0.8.7+2847", reports ${quoted("DE1XL")} serial ${quoted("20002")}, not the hardware its token is bound to`,
        `Closing the sync connection of Machine Forged hello (127.0.0.1): An Admin dismissed ${escaped("DE1XL")} serial ${escaped("20002")}, which a tablet reported with this Machine's token`,
      ]) {
        await expect.poll(() => server.output()).toContain(line);
      }
      for (const character of ["\nWARN [Sync] forged", "\u001b[2J", "\u009b", "\u2028", "\u202e"]) expect(server.output()).not.toContain(character);
    });

    it("refuse upgrades on any path but /sync", async () => {
      const socket = new WebSocket(`${server.url.replace(/^http/, "ws")}/elsewhere`);
      const failure = await new Promise<Error>((resolve) => socket.once("error", resolve));
      expect(failure.message).toBe("Unexpected server response: 404");
    });
  });
});

/**
 * A TCP proxy to a server that leaves its next `stalled` connections
 * unanswered, as a server that accepts connections but never completes the
 * WebSocket upgrade does, and passes the rest through.
 */
async function startStallingProxy(serverUrl: string, stall: number) {
  const target = new URL(serverUrl);
  let toStall = stall;
  const stalled: net.Socket[] = [];
  const passed: net.Socket[] = [];
  const proxy = net.createServer((socket) => {
    if (toStall > 0) {
      toStall--;
      stalled.push(socket);
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    passed.push(socket, upstream);
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stalled,
    stallNext(count: number) {
      toStall = count;
    },
    async close() {
      for (const socket of [...stalled, ...passed]) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

/**
 * A TCP proxy to a server whose path can be lost without anything closing, as
 * when the server's host vanishes or a NAT drops the connection's state.
 * `partition()` silently drops every byte on the connections passed through
 * so far, for good, and holds new connections unanswered until `heal()`
 * passes them through. What the server sends arrives `latencyMs` late, in
 * order.
 */
async function startPartitioningProxy(serverUrl: string, { latencyMs = 0 } = {}) {
  const target = new URL(serverUrl);
  const sockets = new Set<net.Socket>();
  const held: net.Socket[] = [];
  let lose: (() => void)[] = [];
  let partitioned = false;

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };
  const pass = (socket: net.Socket) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    track(upstream);
    let lost = false;
    const forward = (from: net.Socket, to: net.Socket, delayMs: number) => {
      let delivered = Promise.resolve();
      const later = (action: () => void) => {
        const due = Date.now() + delayMs;
        delivered = delivered
          .then(() => new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()))))
          .then(() => {
            if (!lost) action();
          });
      };
      from.on("data", (chunk) => later(() => to.write(chunk)));
      from.on("end", () => later(() => to.end()));
      from.on("close", () => later(() => to.destroy()));
    };
    forward(socket, upstream, 0);
    forward(upstream, socket, latencyMs);
    lose.push(() => {
      lost = true;
    });
  };

  const proxy = net.createServer((socket) => {
    track(socket);
    // Until passed through, what the client sends waits unread.
    if (partitioned) held.push(socket);
    else pass(socket);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    partition() {
      partitioned = true;
      for (const cut of lose) cut();
      lose = [];
    },
    heal() {
      partitioned = false;
      for (const socket of held.splice(0)) if (!socket.destroyed) pass(socket);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}
