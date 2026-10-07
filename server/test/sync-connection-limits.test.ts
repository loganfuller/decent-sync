import net from "node:net";
import { MISSED_HEARTBEATS, SYNC_PATH } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { RawConnection, SimulatedTablet, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// The cap on connections one server instance holds before their hello is
// accepted, with raw connections that send nothing, a simulated tablet
// running the built plugin, and a real server on a fresh database. The hello
// timeout is long enough that no connection is closed for its silence. The
// tests are steps of one scenario on one server, each starting from the cap
// as the step before left it.

/** Connections whose hello has not been accepted that an instance holds at once. */
const CAP = 64;
const HEARTBEAT_SECONDS = 0.5;
const WARNING = /Refusing sync connections while 64 have not had a hello accepted/g;

describe("connections awaiting hello on one server instance", { timeout: 30_000 }, () => {
  runAsSteps();
  let server: TestServer;
  let api: AdminApi;
  /** Connections that have sent nothing, filling the cap with `waiting`. */
  const silent: RawConnection[] = [];
  let connected: RawConnection;
  let waiting: RawConnection;
  let waitingToken: string;
  let tablet: SimulatedTablet | undefined;

  const expectRefused = () => expect(RawConnection.open(server.url)).rejects.toThrow("Unexpected server response: 503");
  /** Opens a connection once one is accepted: the server may see a close a moment after the client does. */
  const openOnceAccepted = async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return await RawConnection.open(server.url);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };
  /** Starts a WebSocket upgrade over plain TCP, as a client that ignores what the server sends can. */
  const upgradeOverTcp = async (path: string) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(new URL(server.url).port), allowHalfOpen: true });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    return socket;
  };
  /** Sends a heartbeat and expects an answer within the silence after which the plugin gives up on a connection, and no error so far. */
  const expectAlive = async (connection: RawConnection) => {
    const next = connection.messages.length;
    connection.send({ type: "heartbeat" });
    // Its own heartbeats are answered too, so the next answer may be to one of them.
    expect(await connection.message(next, HEARTBEAT_SECONDS * 1000 * MISSED_HEARTBEATS)).toEqual({ type: "heartbeat" });
    expect(connection.messages.filter((message) => (message as { type: string }).type === "error")).toEqual([]);
  };

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "60", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) } });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await tablet?.unload();
    await Promise.all([...silent, connected, waiting].filter(Boolean).map((connection) => connection.terminate()));
    await server?.stop();
  });

  it("refuses upgrades once 64 connections await hello, while a connected Machine keeps working", async () => {
    connected = await RawConnection.welcomed(server.url, helloWith((await api.createMachine("Connected")).token), HEARTBEAT_SECONDS * 1000);
    waitingToken = (await api.createMachine("Waiting")).token;

    // The connected Machine's connection is not counted: 64 more fit.
    for (let i = 0; i < CAP - 1; i++) silent.push(await RawConnection.open(server.url));
    waiting = await RawConnection.open(server.url);
    await expectRefused();
    await expectRefused();

    await expectAlive(connected);
    expect(await api.machineNamed("Connected")).toMatchObject({ online: true });
    await expectRefused();
  });

  it("accepts an upgrade again once a hello is accepted", async () => {
    waiting.send(helloWith(waitingToken));
    expect(await waiting.message(0)).toMatchObject({ type: "welcome" });
    waiting.keepAlive(HEARTBEAT_SECONDS * 1000);

    silent.push(await RawConnection.open(server.url));
    await expectRefused();
  });

  it("accepts an upgrade again once a connection awaiting hello closes", async () => {
    await silent.pop()!.close();
    silent.push(await openOnceAccepted());
    await expectRefused();

    await silent.pop()!.terminate();
    silent.push(await openOnceAccepted());
    await expectRefused();
  });

  it("welcomes a tablet with a valid token as soon as a connection awaiting hello closes", async () => {
    const { token } = await api.createMachine("Tablet");
    tablet = SimulatedTablet.load({ settings: settingsFor({ token, serverUrl: server.url }), timeScale: 10 });
    await tablet.waitForLog(/^Disconnected: could not connect to .*Unexpected server response: 503/);

    await silent.pop()!.close();
    await api.waitForMachine("Tablet", (machine) => machine.online);
    // Once welcomed, it no longer counts either.
    silent.push(await RawConnection.open(server.url));
    await expectRefused();
    // The Machines connected earlier kept working throughout.
    await expectAlive(connected);
    await expectAlive(waiting);
  });

  it("closes a refused upgrade's connection, on any path, though the client keeps its end open or resets it", async () => {
    for (const [path, status] of [
      [SYNC_PATH, "503 Service Unavailable"],
      ["/elsewhere", "404 Not Found"],
    ] as const) {
      const socket = await upgradeOverTcp(path);
      const received: Buffer[] = [];
      socket.on("data", (data: Buffer) => received.push(data));
      const closed = new Promise((resolve) => socket.once("close", resolve));
      await new Promise((resolve) => socket.once("end", resolve));
      expect(Buffer.concat(received).toString()).toMatch(new RegExp(`^HTTP/1\\.1 ${status}\r\n`));
      // The server closed the whole connection, not only its side: what the client goes on sending is refused.
      const writing = setInterval(() => socket.write("more"), 50);
      const outcome = await Promise.race([closed.then(() => "closed"), new Promise((resolve) => setTimeout(resolve, 5_000, "still open"))]);
      clearInterval(writing);
      socket.destroy();
      expect(outcome).toBe("closed");
    }

    // Clients that reset the connection once the answer arrives: a socket the server left open then failed with no one handling it.
    for (const path of [SYNC_PATH, "/elsewhere"]) {
      const socket = await upgradeOverTcp(path);
      await new Promise((resolve) => socket.once("data", resolve));
      socket.resetAndDestroy();
    }
    // And clients that reset it as they ask. Only some resets reach the server
    // before it writes its answer, which then fails; nothing can make one do so.
    for (let i = 0; i < 20; i++) {
      const socket = await upgradeOverTcp(i % 2 === 0 ? SYNC_PATH : "/elsewhere");
      if (i % 4 < 2) socket.resetAndDestroy();
      else setImmediate(() => socket.resetAndDestroy());
    }
    // Time for a crash to show. Nothing signals that the server has seen the
    // resets, and a shorter wait can only miss a crash, never fail a server that works.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
    await expectRefused();
    await expectAlive(connected);
  });

  it("logs the refusals at most once a minute", () => {
    expect(server.output().match(WARNING)).toHaveLength(1);
  });
});
