import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { machineSnapshots, stateOf } from "./support/live-fixtures.js";
import { type LiveViewStream, openLiveView } from "./support/live-views.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: how long the Live View lasts once its viewers leave (#261,
// ADR-0024), through the built plugin on simulated tablets, which send the
// test tablet's DE1Pro's recorded machine snapshots (#259). Viewers read
// `GET /api/machines/:id/live` as the browser's EventSource does. A closed
// stream's lease lingers 30 s, the server's own time, which these tests wait
// out. What each renewal does is in live-view-renewals.test.ts. Serials are
// made up, from 26201.

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

describe("the Live View's linger", () => {
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

  /** Opens the Machine's Live View, and waits for the plugin to have been told to stream. */
  async function watching(machine: CreatedMachine, tablet: SimulatedTablet): Promise<LiveViewStream> {
    const starts = count(tablet.delivered, "liveStart");
    const stream = await openLiveView(api, machine.machine.id);
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

    // The page reloads a second after its stream closed, and the new stream receives what the plugin goes on sending.
    await first.close();
    await sleep(1_000);
    const reloaded = await openLiveView(api, machine.machine.id);
    expect(reloaded.status).toBe(200);
    await seen(tablet, [firstOf("pouring"), firstOf("pouringDone")], reloaded);
    // Open a while, so the lease its opening inserted would expire well before the linger after its close ends.
    await sleep(5_000);

    // The last viewer leaves. The plugin is stopped once that stream's lease has lingered: not once the first's had,
    // nor once the lease the reload opened with would have expired, each over 5 s earlier.
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

  it("announces a closed stream's linger, which may land after the plugin was stopped at its lease's expiry, so a reload within it goes on", async () => {
    const { machine, tablet } = await connected("Lingered late");
    const stream = await watching(machine, tablet);
    const id = machine.machine.id;
    const holding = await server.connectDatabase();
    try {
      // The lease is to expire in 5 s, as when a stall made its renewals late, and the instance holding the Machine's
      // connection is told, so it checks at that expiry.
      await holding.query(
        `WITH soon AS (UPDATE live_view_leases SET expires_at = clock_timestamp() + interval '5 seconds' WHERE machine_id = $1::uuid) SELECT pg_notify('live_views', $2)`,
        [id, id],
      );
      // The viewer leaves at once, before the lease's next renewal. Its close's linger begins before the expiry, and
      // waits for the lease, held here, until after it, when the plugin is stopped.
      await holding.query("BEGIN");
      await holding.query("SELECT 1 FROM live_view_leases WHERE machine_id = $1::uuid FOR UPDATE", [id]);
      await stream.close();
      await waitForLockWaits(server);
      await expect.poll(() => count(tablet.delivered, "liveStop")).toBe(1);
      await holding.query("COMMIT");
    } finally {
      await holding.end();
    }

    // The linger goes on by its transaction's clock, from before the expiry, so it finds the lease unexpired and sets it
    // to linger; announced, the plugin streams again, for a reload within it.
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(2);
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
