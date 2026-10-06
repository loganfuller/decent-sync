import { PROTOCOL_VERSION } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { RawConnection, SimulatedTablet, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// The cap on connections one server instance holds before their hello is
// accepted, with raw connections that send nothing, a simulated tablet
// running the built plugin, and a real server on a fresh database. The hello
// timeout is long enough that no connection is closed for its silence. The
// tests share one server and run in order.

/** Connections whose hello has not been accepted that an instance holds at once. */
const CAP = 64;
const HEARTBEAT_SECONDS = 0.5;
const WARNING = /Refusing sync connections while 64 have not had a hello accepted/g;

describe("connections awaiting hello on one server instance", { timeout: 30_000 }, () => {
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
  const heartbeating: NodeJS.Timeout[] = [];
  /** Sends a heartbeat every interval from now on, as the plugin does once welcomed. */
  const keepAlive = (connection: RawConnection) => {
    heartbeating.push(setInterval(() => connection.send({ type: "heartbeat" }), HEARTBEAT_SECONDS * 1000));
  };
  /** Waits three intervals, which would end a connection whose heartbeats went unanswered, and checks they were answered. */
  const expectHeartbeatsAnswered = async (connection: RawConnection) => {
    const answered = () => connection.messages.filter((message) => (message as { type: string }).type === "heartbeat").length;
    const before = answered();
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 3000));
    expect(answered()).toBeGreaterThanOrEqual(before + 2);
    expect(connection.messages.filter((message) => (message as { type: string }).type === "error")).toEqual([]);
  };

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "60", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) } });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    for (const timer of heartbeating) clearInterval(timer);
    await tablet?.unload();
    await Promise.all([...silent, connected, waiting].filter(Boolean).map((connection) => connection.terminate()));
    await server?.stop();
  });

  it("refuses upgrades once 64 connections await hello, while a connected Machine keeps working", async () => {
    connected = await RawConnection.open(server.url);
    connected.send(helloWith((await api.createMachine("Connected")).token));
    expect(await connected.message(0)).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    keepAlive(connected);
    waitingToken = (await api.createMachine("Waiting")).token;

    // The connected Machine's connection is not counted: 64 more fit.
    for (let i = 0; i < CAP - 1; i++) silent.push(await RawConnection.open(server.url));
    waiting = await RawConnection.open(server.url);
    await expectRefused();
    await expectRefused();

    await expectHeartbeatsAnswered(connected);
    expect(await api.machineNamed("Connected")).toMatchObject({ online: true });
    await expectRefused();
  });

  it("accepts an upgrade again once a hello is accepted", async () => {
    waiting.send(helloWith(waitingToken));
    expect(await waiting.message(0)).toMatchObject({ type: "welcome" });
    keepAlive(waiting);

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
    await expectHeartbeatsAnswered(connected);
    await expectHeartbeatsAnswered(waiting);
  });

  it("logs the refusals at most once a minute", () => {
    expect(server.output().match(WARNING)).toHaveLength(1);
  });
});
