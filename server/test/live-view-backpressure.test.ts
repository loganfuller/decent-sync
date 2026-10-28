import { utf8Length } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { liveFixture, machineSnapshots, stateOf } from "./support/live-fixtures.js";
import { type LiveViewStream, openLiveView } from "./support/live-views.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import { derivedShot, shotFixture, withShots } from "./support/shot-fixtures.js";
import { RawConnection, type SimulatedTablet, type SimulatedTabletOptions, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: live frames under backpressure (#269, ADR-0024), through the built
// plugin on simulated tablets, which send the test tablet's DE1Pro's recorded
// machine snapshots (#259), and through raw connections for what the plugin
// never sends. Viewers read `GET /api/machines/:id/live` as the browser's
// EventSource does. Serials are made up, from 26501.

/** Heartbeats every 2 s, so some are sent while a test stalls a link, and the connection outlasts a stall of a few seconds. */
const env = { SYNC_HEARTBEAT_SECONDS: "2" };

/** The plugin's live budget (plugin/src/live-view.ts): the bytes of live frames it may have sent that the server hasn't said it received. */
const LIVE_BUDGET_BYTES = 64 * 1024;
/** The live frames a connection may send a second (server/src/live-view/live-views.ts). */
const MAX_LIVE_FRAMES_PER_SECOND = 1_000;

const shot = machineSnapshots("shot.json");
const idle = machineSnapshots("idle.json");
const espresso = shot.filter((snapshot) => stateOf(snapshot).state === "espresso");
const pouring = espresso.filter((snapshot) => stateOf(snapshot).substate === "pouring");

type Message = { type?: string };
type SentLiveFrame = { type: "liveFrame"; frame: Record<string, unknown> };
const count = (frames: unknown[], type: string) => frames.filter((frame) => (frame as Message).type === type).length;
/** The frames of a type the plugin sent from its `from`th on. */
const sentSince = (tablet: SimulatedTablet, from: number, type: string) => tablet.sent.slice(from).filter((frame) => (frame as Message).type === type);
/** Their bytes, as Decaid counts them. */
const bytesOf = (frames: unknown[]) => frames.reduce<number>((sum, frame) => sum + utf8Length(JSON.stringify(frame)), 0);

describe("live frames under backpressure", () => {
  let server: TestServer;
  let api: AdminApi;
  let serial = 26_501;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine whose simulated tablet, its machine's serial given, is connected, once it is online. */
  async function connected(name: string, options: Pick<SimulatedTabletOptions, "stallUpload" | "uploadBytesPerSecond">): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; serial: number }> {
    const machine = await api.createMachine(name);
    const tabletSerial = serial++;
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(tabletSerial), ...options });
    await api.waitForOnline(machine);
    return { machine, tablet, serial: tabletSerial };
  }

  /** Opens the Machine's Live View, and waits for the plugin to have been told to stream. */
  async function watching(machine: CreatedMachine, tablet: SimulatedTablet): Promise<LiveViewStream> {
    const stream = await openLiveView(api, machine.machine.id);
    expect(stream.status).toBe(200);
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(1);
    return stream;
  }

  it("holds live frames within their budget on a stalled link, never refusing or holding back a Shot or the heartbeats, and keeps the connection", async () => {
    let stalled = false;
    const { machine, tablet, serial: hardware } = await connected("Stalled", { stallUpload: () => stalled });
    // A shot is being pulled, its Machine State delivered, and nothing else is under way, so a Shot is sent the moment it
    // is stored.
    tablet.reportSnapshot(pouring[0]!);
    await quiesced(api, { tablets: { tablet } });
    const stream = await watching(machine, tablet);

    // The link stalls before any live frame is sent, so no liveReceived is on its way to free the budget meanwhile.
    stalled = true;
    const from = tablet.sent.length;
    // Far more of the shot than Decaid's 1 MiB queue holds, every frame of which is to go, without a change of Machine
    // State, which would be delivered ahead of the Shot. Then the shot's last frame, as the latest.
    const offered = Array.from({ length: 4_000 }, (_, n) => tablet.reportSnapshot(pouring[n % (pouring.length - 1)]!));
    offered.push(tablet.reportSnapshot(pouring.at(-1)!));
    expect(bytesOf(offered)).toBeGreaterThan(1024 * 1024);
    // Then a Shot is stored.
    const { machine: _, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    const pulled = derivedShot("stalled-link-shot", { workflow, timestamp: "2026-10-27T21:05:00" });
    tablet.serve(withShots(emptyLibrary(hardware), [pulled]));
    tablet.fire("shotStored", { id: pulled.id });

    // Decaid takes the Shot and the next heartbeat while the link is stalled: neither waits for the live frames.
    await expect.poll(() => sentSince(tablet, from, "shot")).toHaveLength(1);
    await expect.poll(() => sentSince(tablet, from, "heartbeat").length).toBeGreaterThan(0);
    // The live frames sent stay within their budget, the shot's from its first; the rest wait, the latest of them held.
    const live = sentSince(tablet, from, "liveFrame") as SentLiveFrame[];
    expect(bytesOf(live)).toBeLessThanOrEqual(LIVE_BUDGET_BYTES);
    expect(bytesOf(live)).toBeGreaterThan(LIVE_BUDGET_BYTES - bytesOf([live[0]]));
    expect(live.map((frame) => frame.frame)).toEqual(offered.slice(0, live.length));
    expect(tablet.refusedSends).toBe(0);

    // The link recovers: the Shot is stored on the same connection, and the latest frame reaches the viewer.
    stalled = false;
    tablet.resumeUpload();
    const delivery = sentSince(tablet, from, "shot")[0] as { id: string };
    await expect.poll(() => tablet.acks(delivery.id)).toBe(1);
    await expect.poll(() => stream.events.at(-1)?.frame).toEqual(offered.at(-1));
    expect(tablet.refusedSends).toBe(0);
    expect(tablet.logs.filter((line) => line.startsWith("Disconnected"))).toEqual([]);
    expect(tablet.logs.filter((line) => line.startsWith("Connected to "))).toHaveLength(1);
  });

  it("sends the latest frame once the link recovers, and nothing older", async () => {
    let stalled = false;
    const { machine, tablet } = await connected("Recovers", { stallUpload: () => stalled });
    const stream = await watching(machine, tablet);
    stalled = true;
    const from = tablet.sent.length;
    // A shot, again and again, more than the budget holds, then the Machine idle again.
    const offered = Array.from({ length: 400 }, (_, n) => tablet.reportSnapshot(espresso[n % espresso.length]!));
    offered.push(tablet.reportSnapshot(idle[0]!));
    const withinBudget = sentSince(tablet, from, "liveFrame").length;
    expect(withinBudget).toBeLessThan(offered.length - 1);

    stalled = false;
    tablet.resumeUpload();
    // Of the frames past the budget, only the latest goes: the idle one, which the viewer sees last.
    await expect.poll(() => stream.events.at(-1)?.frame).toEqual(offered.at(-1));
    expect((sentSince(tablet, from, "liveFrame") as SentLiveFrame[]).map((frame) => frame.frame)).toEqual([...offered.slice(0, withinBudget), offered.at(-1)]);
  });

  it("holds live frames within their budget on a link slower than they are, though the server receives some every second", async () => {
    // A third of the live bytes a second get through.
    const { machine, tablet } = await connected("Slow link", { uploadBytesPerSecond: 32 * 1024 });
    // Pulling a shot, without a change of Machine State, which would be delivered, until the stream starts.
    tablet.reportSnapshot(pouring[0]!);
    await quiesced(api, { tablets: { tablet } });
    const stream = await watching(machine, tablet);
    const from = tablet.sent.length;

    // About 90 KiB a second for 2 s: the server receives some all along, and says so every second, but most wait.
    const answers = count(tablet.delivered, "liveReceived");
    for (let tick = 0; tick < 20; tick++) {
      for (let n = 0; n < 20; n++) tablet.reportSnapshot(pouring[(tick * 20 + n) % pouring.length]!);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(count(tablet.delivered, "liveReceived") - answers).toBeGreaterThan(1);
    expect(bytesOf(sentSince(tablet, from, "liveFrame"))).toBeGreaterThan(LIVE_BUDGET_BYTES);
    // What Decaid holds unsent is the live frames, within their budget, and the odd heartbeat.
    expect(tablet.peakPendingOutboundBytes).toBeLessThanOrEqual(LIVE_BUDGET_BYTES + 1024);
    expect(tablet.refusedSends).toBe(0);
    expect(stream.events.length).toBeGreaterThan(0);
  });

  it("drops a connection's live frames past its cap for a second, keeps it open, and tells it of every byte received, once a second", async () => {
    const machine = await api.createMachine("Capped");
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: { model: "DE1Pro", serial: String(serial++) } }), 1_000);
    const stream = await openLiveView(api, machine.machine.id);
    await expect.poll(() => count(raw.messages, "liveStart")).toBe(1);
    const received = () => raw.messages.filter((message) => (message as Message).type === "liveReceived") as { bytes: number }[];

    // A recorded scale frame again and again, each told apart by when the plugin would have received it.
    const [scale] = liveFixture("idle.json").filter((frame) => frame.source === "scale");
    const from = Date.now();
    const frame = (n: number) => ({ type: "liveFrame", source: "scale", receivedAt: new Date(from + n).toISOString(), frame: scale!.frame });
    const burst = Array.from({ length: MAX_LIVE_FRAMES_PER_SECOND + 50 }, (_, n) => frame(n));

    // More at once than the cap lets through in a second, while the first's relay is held, so each of the rest waits its
    // turn in place of the one before.
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("LOCK TABLE machines IN ACCESS EXCLUSIVE MODE");
      for (const live of burst) raw.send(live);
      // Told at once of the first, and of the rest once a second has passed, whatever becomes of them.
      await expect.poll(() => received().length).toBe(2);
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
    expect(received().map((answer) => answer.bytes)).toEqual([bytesOf(burst.slice(0, 1)), bytesOf(burst)]);
    // The first is relayed, then the latest the cap let through: those past it were dropped.
    await expect.poll(() => stream.events.map((event) => event.receivedAt)).toEqual([burst[0]!.receivedAt, burst[MAX_LIVE_FRAMES_PER_SECOND - 1]!.receivedAt]);
    expect(server.output()).toContain(`past ${MAX_LIVE_FRAMES_PER_SECOND} a second; any more past it are dropped too`);

    // The connection stays open: in the next second its frames are relayed again.
    const after = frame(burst.length);
    raw.send(after);
    await expect.poll(() => stream.events.at(-1)?.receivedAt).toBe(after.receivedAt);
    await expect.poll(() => received().at(-1)?.bytes).toBe(bytesOf([...burst, after]));
  });
});
