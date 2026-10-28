import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { machineSnapshots, openingSocketFrames, stateOf } from "./support/live-fixtures.js";
import { type LiveViewStream, openLiveView, sourcesAndFrames } from "./support/live-views.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { startRoutingProxy } from "./support/routing-proxy.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: the Live View across server instances on one database (#261,
// ADR-0016, ADR-0024), through the built plugin on simulated tablets, which
// send the test tablet's DE1Pro's recorded machine snapshots and serve what
// its local sockets sent as they opened (#259). Viewers
// read `GET /api/machines/:id/live` as the browser's EventSource does. A
// stream's instance renews its lease every 10 s, to expire 30 s later: the
// server's own times, which a lost instance's test waits out. Serials are
// made up, from 26301.

/** Heartbeats every 300 s, so none writes a Machine's row while a test holds a lock. */
const env = { SYNC_HEARTBEAT_SECONDS: "300" };

/** How long after its last renewal a lease expires (server/src/live-view/live-views.ts). */
const LEASE_MS = 30_000;
/** How often a stream's instance renews its lease. */
const RENEW_MS = 10_000;

const shot = machineSnapshots("shot.json");
const idle = machineSnapshots("idle.json");
const espresso = shot.filter((snapshot) => stateOf(snapshot).state === "espresso");
const firstOf = (substate: string) => espresso.find((snapshot) => stateOf(snapshot).substate === substate)!;

const count = (frames: unknown[], type: string) => frames.filter((frame) => (frame as { type?: string }).type === type).length;

describe("the Live View across instances", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let serial = 26_301;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine whose simulated tablet is connected through `instance`, once it is online. */
  async function connected(name: string, instance: { url: string } = server): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name);
    const tablet = syncingTablet(machine, instance, { api: emptyLibrary(serial++) });
    await api.waitForOnline(machine);
    return { machine, tablet };
  }

  /** Opens the Machine's Live View on `instance`, and waits for the plugin to have been told to stream. */
  async function watching(machine: CreatedMachine, tablet: SimulatedTablet, instance: TestServer): Promise<LiveViewStream> {
    const starts = count(tablet.delivered, "liveStart");
    const stream = await openLiveView(api.at(instance.url), machine.machine.id);
    expect(stream.status).toBe(200);
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBeGreaterThan(starts);
    return stream;
  }

  /**
   * Runs `work` with every session's row held, so no stream's renewal goes on meanwhile: each renewal is announced,
   * and would start the plugin within 10 s whatever `work` waits for.
   */
  async function renewalsHeld(work: () => Promise<void>): Promise<void> {
    const holding = await server.connectDatabase();
    try {
      await holding.query("BEGIN");
      await holding.query("SELECT 1 FROM sessions FOR UPDATE");
      await work();
    } finally {
      await holding.query("ROLLBACK").catch(() => {});
      await holding.end();
    }
  }

  /** The events of the stream that carry one of these snapshots as sent, by Decaid's own timestamp in it. */
  const carrying = (stream: LiveViewStream, sent: Record<string, unknown>[]) =>
    stream.events.filter((event) => sent.some((snapshot) => snapshot.timestamp === event.frame.timestamp));

  /** Sends each snapshot in turn, each once the streams have the last. */
  async function seen(tablet: SimulatedTablet, snapshots: Record<string, unknown>[], ...streams: LiveViewStream[]): Promise<void> {
    for (const snapshot of snapshots) {
      const sent = tablet.reportSnapshot(snapshot);
      for (const stream of streams) await expect.poll(() => carrying(stream, [sent]).length).toBe(1);
    }
  }

  it("relays the frames of a Machine whose connection one instance holds to viewers on every instance", async () => {
    const { machine, tablet } = await connected("Relayed");
    // The first viewer is on the instance not holding the connection, which starts the plugin through its lease's
    // announcement alone: its renewals are held from once its lease is held.
    const elsewhere = await openLiveView(api.at(other.url), machine.machine.id);
    expect(elsewhere.status).toBe(200);
    await renewalsHeld(() => expect.poll(() => count(tablet.delivered, "liveStart")).toBe(1));
    const here = await openLiveView(api, machine.machine.id);
    await seen(tablet, espresso.slice(10, 15), elsewhere, here);
    expect(count(tablet.delivered, "liveStart")).toBe(1);

    // A viewer joining on that instance later receives, as its stream starts, the latest of what Decaid's sockets sent
    // as the plugin opened them, which the holding instance relays again as the viewer's lease is announced.
    await expect.poll(() => sourcesAndFrames(elsewhere)).toEqual(expect.arrayContaining(openingSocketFrames()));
    const joining = await openLiveView(api.at(other.url), machine.machine.id);
    await expect.poll(() => sourcesAndFrames(joining)).toEqual(expect.arrayContaining(openingSocketFrames()));
    expect(count(tablet.delivered, "liveStart")).toBe(1);
  });

  it("starts a plugin that reconnects to another instance mid-stream again at once, and its viewer keeps receiving", async () => {
    const leaving = await startTestServer({ env, sharing: server });
    // In front of the instance being left, then the other, as a proxy routing by health is; the viewer is on neither.
    const proxy = await startRoutingProxy([leaving, other]);
    try {
      const { machine, tablet } = await connected("Reconnected", proxy);
      expect(proxy.routed).toEqual([leaving.url]);
      const stream = await watching(machine, tablet, server);
      await seen(tablet, [firstOf("preinfusion")], stream);

      // The instance stops, as in a deploy, and hands the tablet over: it reconnects to the other instance, which
      // starts it after its welcome, from the lease alone, with the lease's renewals held.
      await renewalsHeld(async () => {
        await leaving.stop();
        await expect.poll(() => proxy.routed.at(-1)).toBe(other.url);
        await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(2);
      });
      await seen(tablet, [firstOf("pouring"), firstOf("pouringDone")], stream);
      expect(stream.ended).toBe(false);
    } finally {
      await proxy.close();
      await leaving.stop();
    }
  });

  it("stops the plugin once the lease of a lost instance's viewer expires", async () => {
    const lost = await startTestServer({ env, sharing: server });
    try {
      const { machine, tablet } = await connected("Watched from a lost instance");
      const stream = await watching(machine, tablet, lost);
      await seen(tablet, [idle[0]!], stream);

      // Its host crashes, with no time to end its streams: nothing deletes the lease, or sets it to linger.
      const crashed = performance.now();
      await lost.kill();
      // Its viewer's stream drops with it.
      await expect.poll(() => stream.ended).toBe(true);
      await expect(stream.close()).rejects.toThrow();
      await expect.poll(() => count(tablet.delivered, "liveStop"), { timeout: LEASE_MS + 15_000 }).toBe(1);
      // At the lease's expiry, 30 s after its last renewal, which came within a renewal's interval before the crash.
      expect(performance.now() - crashed).toBeGreaterThanOrEqual(LEASE_MS - RENEW_MS - 5_000);
    } finally {
      await lost.stop();
    }
  });

  it("starts a plugin for a lease announced while its instance wasn't listening, once it listens again", async () => {
    const { machine, tablet } = await connected("Listening again");
    const notListening = () => server.output().split("Not listening for access changes").length - 1;
    const before = notListening();
    const database = await server.connectDatabase();
    try {
      // A lease whose announcement every instance misses: held as each loses its listening connection, with no
      // notification. In one statement, so it is held well before an instance listens again, 1 s later.
      await database.query(
        `WITH lease AS (
           INSERT INTO live_view_leases (id, machine_id, session_id, expires_at)
           SELECT gen_random_uuid(), $1::uuid, id, now() + interval '30 seconds' FROM sessions ORDER BY created_at LIMIT 1)
         SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN %'`,
        [machine.machine.id],
      );
    } finally {
      await database.end();
    }
    await expect.poll(notListening).toBeGreaterThan(before);
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(1);
  });
});
