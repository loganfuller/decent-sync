import { REQUESTS_WIRE_REVISION, type ServerMessage } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { derivedShot } from "./support/shot-fixtures.js";
import { RawConnection, type SimulatedTablet, derivedWorkflow, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { StandInServer } from "./support/stand-in-server.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Ticket #507 (milestone 8, ADR-0030): a Skin on a tablet asks the plugin
// whether its Machine is served. It calls the plugin's `status` endpoint,
// the plugin asks the server with a `request` over its connection, and the
// server's `answer` comes back in the same call; a Skin listening on the
// plugin's `changes` endpoint is pushed a message when the plugin's
// connection comes or goes. Through the built plugin in simulated tablets
// against a real server, for the status of each kind of Machine and the
// pushes; against a stand-in server for what the real one never does, an
// answer that comes late or not at all; and with raw frames for the request
// and answer themselves. The endpoint and push Streamline reads are covered
// by skin-notices.test.ts, which this ticket leaves as it was. Serials are
// made up, from 49601.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The plugin's time for a request (SKIN_REQUEST_MS in plugin/src/skin-requests.ts), in the tablet's ms. */
const REQUEST_MS = 10_000;

const tablets = new LoadedTablets();
afterAll(() => tablets.unloadAll());

/** Calls the plugin's status endpoint as a Skin does: the HTTP status and the JSON answered. */
async function status(tablet: SimulatedTablet): Promise<{ status: number; body: Record_ }> {
  const answer = await tablet.callEndpoint("status");
  expect(answer.headers["Content-Type"]).toBe("application/json");
  return { status: answer.status, body: JSON.parse(answer.body) as Record_ };
}

/** What a Skin listening on `changes` since the tablet loaded was told of the plugin's connection. */
const connectionPushes = (tablet: SimulatedTablet) => tablet.pushes("changes").map((push) => (push as { connected?: unknown }).connected);

const requestsSent = (tablet: SimulatedTablet) => (tablet.sent as Record_[]).filter((frame) => frame.type === "request");

describe("The plugin's status endpoint, against a server", () => {
  let server: TestServer;
  let api: AdminApi;
  let location: LocationView;
  let serial = 49_601;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    location = await api.createLocation("Skin status", "America/Chicago");
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  /** A Machine's tablet, connected to an instance, once the plugin has been welcomed there. */
  async function connected(machine: CreatedMachine, instance: TestServer = server, hardware = serial++): Promise<SimulatedTablet> {
    const tablet = tablets.syncing(machine, instance, { api: emptyLibrary(hardware) });
    await expect.poll(() => connectionPushes(tablet)).toEqual([true]);
    return tablet;
  }

  it("answers a served Machine with its Machine and Location, and nothing but a GET", async () => {
    const machine = await api.createMachine("Skin status, served", location.id);
    const tablet = await connected(machine);

    expect(await status(tablet)).toEqual({
      status: 200,
      body: { connected: true, served: true, machine: { id: machine.machine.id, name: "Skin status, served" }, location: { id: location.id, name: "Skin status" } },
    });
    // One request for each call, which the server answered and never acknowledged.
    const [request] = requestsSent(tablet);
    expect(requestsSent(tablet)).toHaveLength(1);
    expect(request).toEqual({ type: "request", id: expect.any(String), ask: "status" });
    expect(tablet.acks(request!.id)).toBe(0);

    const posted = await tablet.callEndpoint("status", { method: "POST", body: {} });
    expect([posted.status, posted.headers.Allow]).toEqual([405, "GET"]);
    expect(requestsSent(tablet)).toHaveLength(1);
  });

  it("tells a Capture-only Machine so, at no Location or with its sharing off, and serves it once it takes part", async () => {
    const nowhere = await api.createMachine("Skin status, at no Location");
    const tablet = await connected(nowhere);
    const refused = await status(tablet);
    expect(refused).toEqual({
      status: 409,
      body: {
        connected: true,
        served: false,
        machine: { id: nowhere.machine.id, name: "Skin status, at no Location" },
        location: null,
        code: "captureOnly",
        message: expect.stringContaining("Capture-only Machine"),
      },
    });

    // Sharing turned off at a Location: it is still at that Location, and named there.
    const off = await api.createMachine("Skin status, sharing off", location.id);
    const quiet = await connected(off);
    expect((await status(quiet)).status).toBe(200);
    await api.send("PUT", `/machines/${off.machine.id}/sharing`, { sharing: false });
    expect(await status(quiet)).toEqual({
      status: 409,
      body: expect.objectContaining({ connected: true, served: false, code: "captureOnly", location: { id: location.id, name: "Skin status" } }),
    });
    // Each call asks afresh: nothing is kept of the last answer.
    await api.send("PUT", `/machines/${off.machine.id}/sharing`, { sharing: true });
    expect(await status(quiet)).toMatchObject({ status: 200, body: { served: true } });
  });

  it("tells a tablet whose machine is a Pending Machine's hardware so, naming no Machine", async () => {
    const machine = await api.createMachine("Skin status, other hardware", location.id);
    // The Machine's own tablet binds its token to its hardware, and goes.
    const own = await connected(machine);
    await api.waitForMachine("Skin status, other hardware", (viewed) => viewed.identification === "identified" && viewed.serial !== null);
    await own.unload();

    // The same token on a tablet whose machine is other hardware: a mismatch, held as a Pending Machine.
    const other = serial++;
    const tablet = await connected(machine, server, other);
    await expect.poll(async () => (await api.pendingMachines()).map((pending) => pending.serial)).toContain(String(other));
    expect(await status(tablet)).toEqual({
      status: 409,
      body: { connected: true, served: false, machine: null, location: null, code: "hardwareMismatch", message: expect.stringContaining("token") },
    });
  });

  it("answers at once that the server can't be reached once it has stopped, and pushes as the connection goes and comes back", async () => {
    const machine = await api.createMachine("Skin status, server stopped", location.id);
    // An instance of its own, to stop and to start again at the same address.
    const instance = await startTestServer({ env, sharing: server });
    const tablet = await connected(machine, instance);
    expect((await status(tablet)).status).toBe(200);
    const asked = requestsSent(tablet).length;

    await instance.stop();
    await expect.poll(() => connectionPushes(tablet)).toEqual([true, false]);
    expect(tablet.pushes("changes").at(-1)).toEqual({ what: "connection", connected: false });
    // At once: answered before anything else can happen, a timer or an answer from anywhere.
    const answered = tablet.callEndpoint("status");
    const first = await Promise.race([answered, new Promise<string>((resolve) => setImmediate(() => resolve("waited")))]);
    expect(first).toMatchObject({ status: 503 });
    expect(await status(tablet)).toEqual({
      status: 503,
      body: { connected: false, served: false, machine: null, location: null, code: "unreachable", message: expect.stringContaining("can't be reached") },
    });
    expect(requestsSent(tablet)).toHaveLength(asked);

    // The server back at its address: the plugin reconnects, and a Skin is told.
    const back = await startTestServer({ env, sharing: server, port: Number(new URL(instance.url).port) });
    try {
      await expect.poll(() => connectionPushes(tablet)).toEqual([true, false, true]);
      expect(tablet.pushes("changes").at(-1)).toEqual({ what: "connection", connected: true });
      expect(await status(tablet)).toMatchObject({ status: 200, body: { connected: true, served: true } });
    } finally {
      await tablet.unload();
      await back.stop();
    }
  });

  it("leaves Streamline's endpoint and push as they were: nothing new is pushed on changed, and skin answers the same connected or not", async () => {
    const machine = await api.createMachine("Skin status, Streamline", location.id);
    const tablet = await connected(machine);
    const skin = async () => {
      const answer = await tablet.callEndpoint("skin");
      return [answer.status, JSON.parse(answer.body)];
    };
    const asStreamlineReadsIt = [200, { version: 1, surfaces: [], live: { endpoint: "changed" } }];
    expect(await skin()).toEqual(asStreamlineReadsIt);
    expect((await status(tablet)).status).toBe(200);

    tablet.loseNetwork();
    await expect.poll(() => connectionPushes(tablet)).toEqual([true, false]);
    expect(await skin()).toEqual(asStreamlineReadsIt);
    tablet.restoreNetwork();
    await expect.poll(() => connectionPushes(tablet)).toEqual([true, false, true]);

    // Streamline reads any push on `changed` as a change of the Workflow: the connection's coming and going is not there.
    expect(tablet.pushes("changed").filter((push) => JSON.stringify(push) !== JSON.stringify({ what: "workflow" }))).toEqual([]);
    expect(tablet.pushes("changes")).toEqual([
      { what: "connection", connected: true },
      { what: "connection", connected: false },
      { what: "connection", connected: true },
    ]);
  });

  it("sends a request behind the reports that were waiting as the Skin asked: a Shot just pulled is delivered first", async () => {
    const machine = await api.createMachine("Skin status, behind a Shot", location.id);
    const tablet = await connected(machine);
    expect((await status(tablet)).status).toBe(200);
    const asked = requestsSent(tablet).length;

    // Decaid is slow to read the Shot, so its delivery is still to come as the Skin asks.
    const release = tablet.holdShotReads();
    const shot = derivedShot("skin-status-behind-a-shot");
    tablet.pullShot(shot);
    await expect.poll(() => tablet.inFlightRequests.map((request) => request.route)).toContain(`/shots/${shot.id}`);
    const answered = status(tablet);
    // Nothing of the request has left the tablet while the Shot is still to be delivered.
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestsSent(tablet)).toHaveLength(asked);

    release();
    expect((await answered).status).toBe(200);
    const sent = tablet.sent as Record_[];
    const delivered = sent.findIndex((frame) => frame.type === "shot" && frame.shotId === shot.id);
    const requested = sent.findIndex((frame, index) => frame.type === "request" && index > delivered);
    expect(delivered).toBeGreaterThanOrEqual(0);
    expect(requestsSent(tablet)).toHaveLength(asked + 1);
    expect(requested).toBeGreaterThan(delivered);
    // The server had stored the Shot by the time it answered.
    expect((await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);
  });

  describe("requests and answers, with raw frames", () => {
    const answersTo = (raw: RawConnection, id: string) => (raw.messages as Record_[]).filter((message) => message.type === "answer" && message.id === id);
    /** Sends a request and resolves with its answer, the `count`th to that id. */
    async function ask(raw: RawConnection, id: string, count = 1): Promise<Record_> {
      raw.send({ type: "request", id, ask: "status" });
      await expect.poll(() => answersTo(raw, id).length).toBe(count);
      return answersTo(raw, id)[count - 1]!;
    }

    it("answers a request once, and a repeated id as a request of its own, acknowledging neither", async () => {
      const machine = await api.createMachine("Skin status, raw frames", location.id);
      const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
      const served = { served: true, machine: { id: machine.machine.id, name: "Skin status, raw frames" }, location: { id: location.id, name: "Skin status" } };

      expect(await ask(raw, "status-1")).toEqual({ type: "answer", id: "status-1", ask: "status", result: served });
      // Nothing of a request is remembered: its id asked again is answered again, as things stand then.
      await api.send("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: false });
      expect(await ask(raw, "status-1", 2)).toEqual({ type: "answer", id: "status-1", ask: "status", result: { ...served, served: false, notServed: "captureOnly" } });
      expect(raw.acks("status-1")).toBe(0);

      // Nor is its id looked up among the deliveries handled, whose repeats are acknowledged and not handled again.
      await raw.deliver({ type: "machineState", id: "one-id", observedAt: "2026-11-14T12:00:00.000Z", state: "idle", substate: "idle" });
      expect(await ask(raw, "one-id")).toMatchObject({ type: "answer", id: "one-id", result: { served: false } });
      expect(raw.acks("one-id")).toBe(1);
      expect(answersTo(raw, "status-1")).toHaveLength(2);
    });

    it("answers a request from a Capture-only connection as not served", async () => {
      const machine = await api.createMachine("Skin status, raw capture-only");
      const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
      expect(await ask(raw, "capture-only")).toEqual({
        type: "answer",
        id: "capture-only",
        ask: "status",
        result: { served: false, notServed: "captureOnly", machine: { id: machine.machine.id, name: "Skin status, raw capture-only" }, location: null },
      });
    });

    it("answers a request in its turn, after storing the delivery sent before it", async () => {
      const machine = await api.createMachine("Skin status, raw order", location.id);
      const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
      const shot = derivedShot("skin-status-raw-order");
      raw.send({ type: "shot", id: "shot-first", shotId: shot.id, shot });
      await ask(raw, "then-status");
      const types = (raw.messages as Record_[]).filter((message) => message.id === "shot-first" || message.id === "then-status").map((message) => message.type);
      expect(types).toEqual(["ack", "answer"]);
    });

    it("refuses a request that asks for nothing it knows, and one from a plugin behind the wire revision requests came in", async () => {
      const machine = await api.createMachine("Skin status, raw refusals", location.id);
      const unknown = await RawConnection.welcomed(server.url, helloWith(machine.token));
      unknown.send({ type: "request", id: "unknown", ask: "everything" });
      expect((await unknown.closed).code).toBe(4000);
      expect(unknown.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error", message: expect.stringContaining("request.ask") });

      // The release before requests sends none, so one from a plugin at its revision is no plugin's.
      const behind = await RawConnection.welcomed(server.url, helloWith(machine.token, { wireRevision: REQUESTS_WIRE_REVISION - 1 }));
      behind.send({ type: "request", id: "behind", ask: "status" });
      expect((await behind.closed).code).toBe(4000);
      expect(behind.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error", message: expect.stringContaining("wire revision") });
      expect(answersTo(behind, "behind")).toEqual([]);
    });
  });
});

describe("A request the server does not answer", () => {
  /** A tablet connected to a stand-in server, which answers no request by itself. */
  async function standIn(token: string, serial: number, options: { wireRevision?: number } = {}): Promise<{ server: StandInServer; tablet: SimulatedTablet }> {
    const server = await StandInServer.start(options);
    const tablet = tablets.load({ settings: settingsFor({ token, serverUrl: server.url }), api: emptyLibrary(serial), timeScale: 50 });
    await expect.poll(() => connectionPushes(tablet)).toEqual([true]);
    return { server, tablet };
  }
  const answer = (id: unknown): ServerMessage => ({
    type: "answer",
    id: String(id),
    ask: "status",
    result: { served: true, machine: { id: "0199c0de-0000-7000-8000-000000049611", name: "Stand-in" }, location: { id: "0199c0de-0000-7000-8000-000000049612", name: "Stand-in" } },
  });

  it("is answered as unreachable once its time is up, well inside the time Decaid gives the plugin, and an answer after that is dropped", async () => {
    const { server, tablet } = await standIn("stand-in token 49611", 49_611);
    try {
      const before = tablet.readClock();
      const unanswered = await status(tablet);
      expect(unanswered).toEqual({
        status: 503,
        body: { connected: true, served: false, machine: null, location: null, code: "unreachable", message: expect.any(String) },
      });
      // It waited out its own time: Decaid would have answered 500 after 30 s of the tablet's.
      expect(tablet.readClock() - before).toBeGreaterThanOrEqual(REQUEST_MS);
      const request = await server.next("request");
      expect(request).toMatchObject({ ask: "status" });

      // The answer comes after all, to nobody: the next call asks anew, and takes its own answer.
      server.send(answer(request.id));
      const next = status(tablet);
      const second = await server.next("request", server.received.indexOf(request) + 1);
      expect(second.id).not.toBe(request.id);
      server.send(answer(second.id));
      expect(await next).toMatchObject({ status: 200, body: { connected: true, served: true, machine: { name: "Stand-in" } } });
      expect(tablet.logs.filter((line) => line.includes("Ignoring a message from the server"))).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("is answered as unreachable when its connection closes first, and is not sent again on the next", async () => {
    const { server, tablet } = await standIn("stand-in token 49613", 49_613);
    try {
      const asked = status(tablet);
      const request = await server.next("request");
      const received = server.received.length;
      server.drop();
      expect(await asked).toEqual({
        status: 503,
        body: { connected: false, served: false, machine: null, location: null, code: "unreachable", message: expect.any(String) },
      });

      // The plugin reconnects, and sends what its outbox holds, but no request.
      await expect.poll(() => connectionPushes(tablet)).toEqual([true, false, true]);
      await server.next("collection", received);
      expect(server.received.filter((message) => message.type === "request")).toEqual([request]);
    } finally {
      await server.stop();
    }
  });

  it("waits for the server to acknowledge the deliveries queued as the Skin asked, and no later ones", async () => {
    const { server, tablet } = await standIn("stand-in token 49615", 49_615);
    try {
      // Once the tablet has sent what a welcome brings, the server is slow to store what comes next.
      await expect.poll(() => tablet.acknowledgedEvery((frame: Record_) => typeof frame.id === "string" && frame.type !== "request") && tablet.inFlightRequests.length === 0).toBe(true);
      const release = server.holdAcks();
      const sentBefore = server.received.length;
      tablet.setWorkflow(derivedWorkflow({ targetYield: 41 }));
      const waiting = await server.next("workflow", sentBefore);

      const asked = status(tablet);
      await new Promise((resolve) => setImmediate(resolve));
      expect(server.received.filter((message) => message.type === "request")).toEqual([]);

      release();
      const request = await server.next("request", sentBefore);
      expect(server.received.indexOf(request)).toBeGreaterThan(server.received.indexOf(waiting));
      expect(tablet.acks(waiting.id)).toBe(1);
      server.send(answer(request.id));
      expect((await asked).status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it("is not sent to a server of the release before requests, which is answered as too old to ask", async () => {
    const { server, tablet } = await standIn("stand-in token 49614", 49_614, { wireRevision: REQUESTS_WIRE_REVISION - 1 });
    try {
      expect(await status(tablet)).toEqual({
        status: 503,
        body: { connected: true, served: false, machine: null, location: null, code: "serverTooOld", message: expect.stringContaining("too old") },
      });
      expect(requestsSent(tablet)).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("answers that the server can't be reached where the plugin has no settings to connect with", async () => {
    const tablet = tablets.load({ settings: {} });
    expect(await status(tablet)).toMatchObject({ status: 503, body: { connected: false, served: false, code: "unreachable" } });
    expect(tablet.pushes("changes")).toEqual([]);
  });
});
