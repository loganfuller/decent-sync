import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, admin, signIn } from "./support/admin-api.js";
import { machineSnapshots, stateOf } from "./support/live-fixtures.js";
import { type LiveViewStream, openLiveView } from "./support/live-views.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: how long the Live View lasts (#261, ADR-0024), through the built
// plugin on simulated tablets, which send the test tablet's DE1Pro's recorded
// machine snapshots (#259). Viewers read `GET /api/machines/:id/live` as the
// browser's EventSource does. A stream's instance renews its lease every
// 10 s, to expire 30 s later, and a closed stream's lease lingers 30 s: the
// server's own times, which these tests wait out. Serials are made up, from
// 26201.

/** Heartbeats every 300 s, so none writes a Machine's row while a test holds a lock. */
const env = { SYNC_HEARTBEAT_SECONDS: "300" };

/** How long a closed stream's lease lingers (server/src/live-view/live-views.ts). */
const LINGER_MS = 30_000;

const shot = machineSnapshots("shot.json");
const idle = machineSnapshots("idle.json");
const espresso = shot.filter((snapshot) => stateOf(snapshot).state === "espresso");
const firstOf = (substate: string) => espresso.find((snapshot) => stateOf(snapshot).substate === substate)!;

const count = (frames: unknown[], type: string) => frames.filter((frame) => (frame as { type?: string }).type === type).length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the Live View's lifetime", () => {
  let server: TestServer;
  let api: AdminApi;
  let serial = 26_201;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine whose simulated tablet is connected, once it is online. */
  async function connected(name: string): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++) });
    await api.waitForOnline(machine);
    return { machine, tablet };
  }

  /** Opens the Machine's Live View as `as` is signed in, and waits for the plugin to have been told to stream. */
  async function watching(machine: CreatedMachine, tablet: SimulatedTablet, as = api): Promise<LiveViewStream> {
    const starts = count(tablet.delivered, "liveStart");
    const stream = await openLiveView(as, machine.machine.id);
    expect(stream.status).toBe(200);
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBeGreaterThan(starts);
    return stream;
  }

  /** The events of the stream that carry one of these snapshots as sent, by Decaid's own timestamp in it. */
  const carrying = (stream: LiveViewStream, sent: Record<string, unknown>[]) =>
    stream.events.filter((event) => sent.some((snapshot) => snapshot.timestamp === event.frame.timestamp));

  /** Sends each snapshot in turn, each once the streams have the last, and resolves with them as sent. */
  async function seen(tablet: SimulatedTablet, snapshots: Record<string, unknown>[], ...streams: LiveViewStream[]): Promise<Record<string, unknown>[]> {
    const sent: Record<string, unknown>[] = [];
    for (const snapshot of snapshots) {
      sent.push(tablet.reportSnapshot(snapshot));
      for (const stream of streams) await expect.poll(() => carrying(stream, [sent.at(-1)!]).length).toBe(1);
    }
    return sent;
  }

  it("stops the plugin about 30 s after the last viewer leaves, and not before, so a reload within that time goes on without a stop", async () => {
    const { machine, tablet } = await connected("Linger");
    const first = await watching(machine, tablet);
    await seen(tablet, [firstOf("preinfusion")], first);

    // The page reloads a few seconds after its stream closed, and the new stream receives what the plugin goes on
    // sending.
    await first.close();
    await sleep(3_000);
    const reloaded = await openLiveView(api, machine.machine.id);
    expect(reloaded.status).toBe(200);
    await seen(tablet, [firstOf("pouring"), firstOf("pouringDone")], reloaded);

    // The last viewer leaves. The plugin is stopped once that stream's lease has lingered, not once the first's had,
    // which ended over 3 s earlier.
    const left = performance.now();
    await reloaded.close();
    await expect.poll(() => count(tablet.delivered, "liveStop"), { timeout: LINGER_MS + 15_000 }).toBe(1);
    expect(performance.now() - left).toBeGreaterThanOrEqual(LINGER_MS - 1_000);
    // Started once, for the first viewer: the reload continued its stream.
    expect(count(tablet.delivered, "liveStart")).toBe(1);
    const sends = tablet.sent.length;
    tablet.reportSnapshot(idle[0]!);
    expect(tablet.sent.slice(sends).filter((frame) => (frame as { type?: string }).type === "liveFrame")).toEqual([]);
  });

  it("ends a stream within a renewal once its viewer signs out or is deactivated, and refuses its reconnect, while another viewer's goes on", async () => {
    const { machine, tablet } = await connected("Session");
    const signingOut = AdminApi.signedInAs(server.url, await signIn(server.url, admin));
    const email = "live-view-deactivated@example.com";
    const deactivating = await api.staffAt(email, await api.createLocation("Live View, deactivated Staff's", "America/Toronto"));
    const staying = await watching(machine, tablet);
    const signedOut = await openLiveView(signingOut, machine.machine.id);
    const deactivated = await openLiveView(deactivating, machine.machine.id);
    expect([signedOut.status, deactivated.status]).toEqual([200, 200]);
    await seen(tablet, [idle[0]!], staying, signedOut, deactivated);

    expect((await signingOut.call("DELETE", "/session")).status).toBe(204);
    const { id } = (await api.accounts()).find((account) => account.email === email)!;
    expect((await api.call("POST", `/accounts/${id}/deactivate`)).status).toBe(200);
    // Each within its next renewal, 10 s at most.
    await expect.poll(() => signedOut.ended).toBe(true);
    await expect.poll(() => deactivated.ended).toBe(true);
    // The browser's reconnect is refused, as every request of an ended session is.
    expect((await openLiveView(signingOut, machine.machine.id)).status).toBe(401);
    expect((await openLiveView(deactivating, machine.machine.id)).status).toBe(401);

    // The viewer still signed in goes on receiving, and the plugin was never stopped.
    await seen(tablet, [firstOf("preinfusion")], staying);
    expect(staying.ended).toBe(false);
    expect(count(tablet.delivered, "liveStop")).toBe(0);
  });

  it("puts back a lease a renewal finds deleted or expired, as after its instance stalled, and the plugin streams to it again", async () => {
    const deleted = await connected("Lease deleted");
    const expired = await connected("Lease expired");
    const deletedStream = await watching(deleted.machine, deleted.tablet);
    const expiredStream = await watching(expired.machine, expired.tablet);

    // As while this instance stalled: both leases expired, and another viewer's opening then deleted one of them. The
    // instance holding each Machine's connection checks as it would at the expiry, and stops its plugin.
    const database = await server.connectDatabase();
    try {
      await database.query(
        `WITH gone AS (DELETE FROM live_view_leases WHERE machine_id = $1::uuid),
           lapsed AS (UPDATE live_view_leases SET expires_at = now() WHERE machine_id = $2::uuid)
         SELECT pg_notify('live_views', $3), pg_notify('live_views', $4)`,
        [deleted.machine.machine.id, expired.machine.machine.id, deleted.machine.machine.id, expired.machine.machine.id],
      );
    } finally {
      await database.end();
    }
    for (const { tablet } of [deleted, expired]) await expect.poll(() => count(tablet.delivered, "liveStop")).toBe(1);

    // Within a renewal, each stream's lease is put back and announced, and its plugin started again.
    for (const { tablet } of [deleted, expired]) await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(2);
    await seen(deleted.tablet, [idle[0]!], deletedStream);
    await seen(expired.tablet, [idle[0]!], expiredStream);
    expect([deletedStream.ended, expiredStream.ended]).toEqual([false, false]);
  });

  it("starts the plugin again after a renewal that began before its lease expired and ended after the plugin was stopped", async () => {
    const { machine, tablet } = await connected("Renewed late");
    const stream = await watching(machine, tablet);
    const holding = await server.connectDatabase();
    const database = await server.connectDatabase();
    try {
      // The stream's next renewal begins, then waits for its viewer's session, held here. Nothing else is under way to
      // wait for it.
      await holding.query("BEGIN");
      await holding.query("SELECT 1 FROM sessions FOR UPDATE");
      await waitForLockWaits(server);
      // Its lease expires meanwhile, as when a stall made the renewal late, and the instance holding the Machine's
      // connection, checking at that expiry, stops the plugin.
      await database.query(
        `WITH lapsed AS (UPDATE live_view_leases SET expires_at = clock_timestamp() WHERE machine_id = $1::uuid) SELECT pg_notify('live_views', $2)`,
        [machine.machine.id, machine.machine.id],
      );
      await expect.poll(() => count(tablet.delivered, "liveStop")).toBe(1);
      await holding.query("COMMIT");
    } finally {
      await Promise.all([holding.end(), database.end()]);
    }

    // The renewal goes on by its transaction's clock, from before the expiry, so it finds the lease unexpired; it still
    // has the plugin started again.
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(2);
    await seen(tablet, [idle[0]!], stream);
    expect(stream.ended).toBe(false);
  });

  it("starts a plugin unloaded mid-stream again on its next load, which kept nothing from before", async () => {
    const { machine, tablet } = await connected("Unloaded");
    const stream = await watching(machine, tablet);
    const [before] = await seen(tablet, [firstOf("preinfusion")], stream);

    const reloaded = await tablet.reload();
    await expect.poll(() => count(reloaded.delivered, "liveStart")).toBe(1);
    const [after] = await seen(reloaded, [firstOf("pouring")], stream);
    // The time in state starts again with the load: the shot's Machine State began, as far as it knows, with this frame.
    const event = carrying(stream, [after!])[0]!;
    expect(event.stateSince).toBe(event.receivedAt);
    expect(Date.parse(event.stateSince!)).toBeGreaterThan(Date.parse(carrying(stream, [before!])[0]!.stateSince!));
    expect(stream.ended).toBe(false);
  });
});
