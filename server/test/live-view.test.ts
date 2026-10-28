import { randomUUID } from "node:crypto";
import { type RelayedLiveFrame, nameMachineState } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { bengleSteam, machineDisconnects, machineSnapshots, milkProbeListing, openingFrames, openingSocketFrames, socketFrames, stateOf } from "./support/live-fixtures.js";
import { type LiveViewStream, openLiveView, sourcesAndFrames } from "./support/live-views.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { quiesced } from "./support/quiet.js";
import { type SimulatedTablet, derivedDe1Pro, simulatedDevices } from "./support/simulated-tablet.js";
import { startStallingProxy } from "./support/stalling-proxy.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: the Live View (#260, #262) through the built plugin on simulated
// tablets, which send the test tablet's DE1Pro's recorded machine snapshots
// (#259) as Decaid's `stateUpdate`, each stamped with the tablet's local time
// as it is sent, and serve its local sockets' recorded frames, and a Bengle's
// milk probe's from Decaid's simulated one (#265). Viewers read
// `GET /api/machines/:id/live` as the browser's EventSource does. Serials are
// made up, from 26001.

/**
 * The simulated tablets' time zone: four hours behind UTC in daylight time,
 * five in standard time. Decaid's own timestamps are the tablet's local time
 * without an offset, so one read as UTC is hours out.
 */
const TABLET_TIME_ZONE = "America/Toronto";

/**
 * Heartbeats every 300 s, so no tablet's heartbeat writes its Machine's row
 * while a test holds the machines table; and a stream's comment after 0.2 s
 * with nothing to send, rather than 15 s.
 */
const env = { SYNC_HEARTBEAT_SECONDS: "300", LIVE_VIEW_KEEP_ALIVE_SECONDS: "0.2" };

const shot = machineSnapshots("shot.json");
const idle = machineSnapshots("idle.json");
const espresso = shot.filter((snapshot) => stateOf(snapshot).state === "espresso");
const firstOf = (substate: string) => espresso.find((snapshot) => stateOf(snapshot).substate === substate)!;

type Message = { type?: string };
const isLiveFrame = (frame: unknown) => (frame as Message).type === "liveFrame";
/** Decaid's sockets the plugin opens while streaming, by the source of their frames. */
const ALL_SOCKETS = ["devices", "scale", "shotSettings", "waterLevels"];
const count = (frames: unknown[], type: string) => frames.filter((frame) => (frame as Message).type === type).length;

/** The Machine State a relayed frame reports, on one line. */
function named(event: RelayedLiveFrame): string {
  const { state, substate } = stateOf(event.frame);
  return nameMachineState(state, substate, event.frame).name;
}

describe("the Live View", () => {
  let server: TestServer;
  let api: AdminApi;
  let timeZone: string | undefined;
  let serial = 26_001;

  beforeAll(async () => {
    timeZone = process.env.TZ;
    process.env.TZ = TABLET_TIME_ZONE;
    expect(new Date(2026, 9, 27).getTimezoneOffset()).toBe(240);
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  });

  /** A Machine whose simulated tablet, its machine's serial given, is connected, once it is online: a DE1Pro, or a Bengle. */
  async function connected(
    name: string,
    options: { timeScale?: number; upgradeAtTabletPace?: boolean; through?: { url: string }; bengle?: boolean; sensors?: unknown } = {},
  ): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; serial: number }> {
    const { through = server, bengle = false, sensors, ...rest } = options;
    const machine = await api.createMachine(name);
    const tabletSerial = serial++;
    const library = emptyLibrary(tabletSerial);
    if (bengle) library["/machine/info"] = derivedDe1Pro({ model: "Bengle", serial: String(tabletSerial) })["/machine/info"];
    if (sensors !== undefined) library["/sensors"] = sensors;
    const tablet = syncingTablet(machine, through, { api: library, ...rest });
    await api.waitForOnline(machine);
    return { machine, tablet, serial: tabletSerial };
  }

  /** Opens the Machine's Live View, and waits for the plugin to have been told to stream. */
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

  /** The machine snapshots in the live frames the plugin sent, from its `from`th frame on. */
  const liveFramesSent = (tablet: SimulatedTablet, from: number, source = "machine") =>
    tablet.sent
      .slice(from)
      .filter((frame) => isLiveFrame(frame) && (frame as { source: string }).source === source)
      .map((frame) => (frame as { frame: Record<string, unknown> }).frame);

  /** The stream's events from Decaid's sockets, rather than the machine's snapshots, as each one's source and frame. */
  const fromSockets = (stream: LiveViewStream) => sourcesAndFrames(stream).filter((event) => event.source !== "machine");

  /** The stream's events from a sensor, as each one's sensor id and frame. */
  const fromSensors = (stream: LiveViewStream) =>
    stream.events.filter((event) => event.source === "sensor").map(({ sensorId, frame }) => ({ sensorId, frame }));

  /**
   * Sends each snapshot in turn, each once the streams have the last: the
   * server relays a connection's frames one at a time, the latest of a burst
   * waiting, so a burst may reach a viewer as fewer. Resolves with them as sent.
   */
  async function seen(tablet: SimulatedTablet, snapshots: Record<string, unknown>[], ...streams: LiveViewStream[]): Promise<Record<string, unknown>[]> {
    const sent: Record<string, unknown>[] = [];
    for (const snapshot of snapshots) {
      sent.push(tablet.reportSnapshot(snapshot));
      for (const stream of streams) await expect.poll(() => carrying(stream, [sent.at(-1)!]).length).toBe(1);
    }
    return sent;
  }

  it("streams each machine snapshot as the tablet sends it, with when the plugin received it and when its Machine State began", async () => {
    const { machine, tablet } = await connected("Basics");
    const stream = await watching(machine, tablet);
    expect(stream.contentType).toBe("text/event-stream; charset=utf-8");

    const before = Date.now();
    // The start of a shot: preparing, then preinfusion.
    const sent = await seen(tablet, espresso.slice(10, 20), stream);
    const after = Date.now();
    const events = carrying(stream, sent);
    expect(events.map((event) => event.frame)).toEqual(sent);
    expect(events.every((event) => event.machineId === machine.machine.id && event.source === "machine")).toBe(true);
    for (const event of events) {
      const received = Date.parse(event.receivedAt);
      expect(received).toBeGreaterThanOrEqual(before);
      expect(received).toBeLessThanOrEqual(after);
      // Decaid's own timestamp is the tablet's local time without an offset, hours from the plugin's UTC.
      expect(String(event.frame.timestamp)).not.toMatch(/Z$/);
      expect(Math.abs(Date.parse(`${String(event.frame.timestamp)}Z`) - received)).toBeGreaterThan(3 * 3_600_000);
    }
    expect(events.map((event) => stateOf(event.frame).substate)).toContain("preparingForShot");
    expect(events.map((event) => stateOf(event.frame).substate)).toContain("preinfusion");
    // One Machine State, from its first frame.
    expect(new Set(events.map(named))).toEqual(new Set(["Pulling a shot"]));
    expect(new Set(events.map((event) => event.stateSince))).toEqual(new Set([events[0]!.receivedAt]));
  });

  // Stopping it once the last viewer has gone, after the linger, is in live-view-lifetime.test.ts.
  it("shares one stream between viewers, starting the plugin once, and sends one that joins the latest from each of Decaid's sockets", async () => {
    const { machine, tablet } = await connected("Shared");
    const first = await watching(machine, tablet);
    await expect.poll(() => fromSockets(first)).toEqual(expect.arrayContaining(openingSocketFrames()));
    // Decaid sent those as the plugin opened its sockets, and nothing since: the second viewer is sent them again.
    const second = await openLiveView(api, machine.machine.id);
    await expect.poll(() => fromSockets(second)).toEqual(expect.arrayContaining(openingSocketFrames()));
    await seen(tablet, espresso.slice(0, 3), first, second);

    await first.close();
    await seen(tablet, espresso.slice(3, 6), second);
    // Decided in turn, so the plugin was started only for the first viewer.
    expect(count(tablet.delivered, "liveStart")).toBe(1);
    expect(count(tablet.delivered, "liveStop")).toBe(0);
  });

  it("sends every frame of a shot, but one a second while idle, the latest winning, and a change of Machine State at once", async () => {
    // At real time, so the plugin's second is one.
    const { machine, tablet } = await connected("Rate", { timeScale: 1 });
    const stream = await watching(machine, tablet);

    // Idle, many frames at once: the first goes, and the latest a second later.
    let from = tablet.sent.length;
    const idling = idle.slice(0, 10).map((snapshot) => tablet.reportSnapshot(snapshot));
    expect(liveFramesSent(tablet, from)).toEqual([idling[0]]);
    await expect.poll(() => liveFramesSent(tablet, from)).toHaveLength(2);
    expect(liveFramesSent(tablet, from)).toEqual([idling[0], idling.at(-1)]);
    await expect.poll(() => carrying(stream, [idling.at(-1)!]).length).toBe(1);

    // A shot, all at once: its first frame is a change of Machine State, and every frame of it goes. So does the change
    // back to idle, at once; the rest of idle waits its second, the latest going. In two halves, each within the plugin's
    // live budget, the second once the server has said it received the first.
    from = tablet.sent.length;
    const rest = shot.slice(shot.indexOf(espresso[0]!));
    const half = Math.ceil(espresso.length / 2);
    const pulled = rest.slice(0, half).map((snapshot) => tablet.reportSnapshot(snapshot));
    const liveBytesSent = () => tablet.sent.filter(isLiveFrame).reduce<number>((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0);
    const liveReceived = () => tablet.delivered.filter((frame) => (frame as Message).type === "liveReceived").at(-1) as { bytes: number } | undefined;
    await expect.poll(() => liveReceived()?.bytes).toBe(liveBytesSent());
    pulled.push(...rest.slice(half).map((snapshot) => tablet.reportSnapshot(snapshot)));
    const shotFrames = pulled.filter((snapshot) => stateOf(snapshot).state === "espresso");
    const backToIdle = pulled[shotFrames.length]!;
    expect(stateOf(backToIdle).state).toBe("idle");
    expect(liveFramesSent(tablet, from)).toEqual([...shotFrames, backToIdle]);
    await expect.poll(() => liveFramesSent(tablet, from)).toHaveLength(shotFrames.length + 2);
    expect(liveFramesSent(tablet, from).at(-1)).toEqual(pulled.at(-1));
    // The server relays one at a time, the latest of a burst waiting, so the viewer sees the latest.
    await expect.poll(() => carrying(stream, [pulled.at(-1)!]).length).toBe(1);
  });

  it("opens Decaid's sockets only while streaming, forwarding what each sends as it opens, and closes them with the connection", async () => {
    const { machine, tablet } = await connected("Sockets");
    expect(tablet.openDecaidSockets()).toEqual([]);
    const before = Date.now();
    const stream = await watching(machine, tablet);
    await expect.poll(() => tablet.openDecaidSockets()).toEqual(ALL_SOCKETS);
    // The current water levels, shot settings and devices, and the scale's status, tagged with their source.
    await expect.poll(() => fromSockets(stream)).toEqual(expect.arrayContaining(openingSocketFrames()));
    const after = Date.now();
    const tabletId = (await api.machineNamed("Sockets"))!.tablet!.id;
    for (const event of stream.events.filter((event) => event.source !== "machine")) {
      expect(event).toEqual({ machineId: machine.machine.id, tabletId, source: event.source, receivedAt: expect.any(String), frame: event.frame });
      expect(Date.parse(event.receivedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(event.receivedAt)).toBeLessThanOrEqual(after);
    }

    // The connection ends: Decaid's sockets close with it, and open again once the next connection is started.
    tablet.loseNetwork();
    await expect.poll(() => tablet.openDecaidSockets()).toEqual([]);
    const [level] = socketFrames("shot.json", "waterLevels");
    tablet.reportOnSocket("waterLevels", level!);
    tablet.restoreNetwork();
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(2);
    await expect.poll(() => tablet.openDecaidSockets()).toEqual(ALL_SOCKETS);
    // As its socket opens again, Decaid sends the water levels that changed meanwhile.
    await expect.poll(() => fromSockets(stream)).toContainEqual({ source: "waterLevels", frame: level });
  });

  it("always leaves a transport free for the server connection, even while earlier connection attempts still hold theirs", async () => {
    // Four attempts the server never answers hold their transports, the fifth connects: five of Decaid's eight.
    const proxy = await startStallingProxy(server.url, 4);
    try {
      const { machine, tablet } = await connected("Transports", { through: proxy, timeScale: 25, upgradeAtTabletPace: true });
      expect(tablet.logs.filter((line) => line.startsWith("Disconnected: the server did not answer"))).toHaveLength(4);
      const stream = await watching(machine, tablet);
      // Two of Decaid's sockets open, so seven are held; the other two are skipped for want of a transport.
      await expect.poll(() => fromSockets(stream).map((event) => event.source).sort()).toEqual(["scale", "waterLevels"]);
      expect(tablet.openDecaidSockets()).toEqual(["scale", "waterLevels"]);
      expect(tablet.peakTransports).toBe(7);

      // The attempts end at last, and the skipped sockets are opened as they are tried again.
      for (const socket of proxy.stalled) socket.destroy();
      await expect.poll(() => tablet.openDecaidSockets()).toEqual(ALL_SOCKETS);
      await expect.poll(() => fromSockets(stream)).toEqual(expect.arrayContaining(openingSocketFrames()));
      expect(tablet.peakTransports).toBe(7);
      expect(tablet.logs.join("\n")).not.toContain("Too many open transports");
    } finally {
      await proxy.close();
    }
  });

  it("sends the frames of Decaid's sockets one a second while idle, the latest winning, every one during a shot, and a scale's disconnection", async () => {
    // At real time, so the plugin's second is one.
    const { machine, tablet } = await connected("Socket rate", { timeScale: 1 });
    tablet.reportOnSocket("scale", { status: "connected" });
    const stream = await watching(machine, tablet);
    await expect.poll(() => liveFramesSent(tablet, 0, "scale")).toEqual([{ status: "connected" }]);
    tablet.reportSnapshot(idle[0]!);

    // Idle, ten of the scale's weights at once: the first goes, unless the scale sent one within the second, and the
    // latest a second after. At most two, as long as the tablet hands the plugin all ten within its second.
    let from = tablet.sent.length;
    const weights = socketFrames("asleep.json", "scale").slice(0, 10);
    for (const weight of weights) tablet.reportOnSocket("scale", weight);
    await expect.poll(() => liveFramesSent(tablet, from, "scale").at(-1)).toEqual(weights.at(-1));
    expect(liveFramesSent(tablet, from, "scale").length).toBeLessThanOrEqual(2);
    await expect.poll(() => fromSockets(stream)).toContainEqual({ source: "scale", frame: weights.at(-1) });

    // A shot: every weight goes.
    tablet.reportSnapshot(firstOf("preinfusion"));
    from = tablet.sent.length;
    const shotWeights = socketFrames("shot.json", "scale").slice(0, 10);
    for (const weight of shotWeights) tablet.reportOnSocket("scale", weight);
    await expect.poll(() => liveFramesSent(tablet, from, "scale")).toEqual(shotWeights);

    // Idle again, the scale goes off: its disconnection reaches the viewer, the last of its frames.
    tablet.reportSnapshot(idle[1]!);
    tablet.reportOnSocket("scale", { status: "disconnected" });
    await expect.poll(() => fromSockets(stream).filter((event) => event.source === "scale").at(-1)).toEqual({ source: "scale", frame: { status: "disconnected" } });
  });

  it("streams a Bengle's milk probe, its id with each frame, from the last reading its socket sends as it opens, leaving a transport free for the server connection", async () => {
    // Two attempts the server never answers hold their transports, the third connects: three of Decaid's eight.
    const proxy = await startStallingProxy(server.url, 2);
    try {
      const { machine, tablet } = await connected("Bengle", { bengle: true, through: proxy, timeScale: 25, upgradeAtTabletPace: true });
      const steam = bengleSteam();
      const readings = steam.filter((frame) => frame.source === "sensor").map((frame) => frame.frame);
      tablet.attachMilkProbe();
      // A reading from before anyone watched, which its socket sends as it opens.
      const earlier = tablet.reportMilkProbe(readings[0]!);
      const stream = await watching(machine, tablet);
      // Decaid's four sockets open at once, holding seven. The probe's, found once Decaid's sensors have been read, would take the eighth: skipped.
      await expect.poll(() => fromSockets(stream)).toEqual(expect.arrayContaining(openingSocketFrames()));
      expect(tablet.openDecaidSockets()).toEqual(ALL_SOCKETS);
      expect(tablet.peakTransports).toBe(7);

      // The attempts end at last, and the probe's socket opens as it is tried again: its last reading, by its id.
      for (const socket of proxy.stalled) socket.destroy();
      await expect.poll(() => tablet.openDecaidSockets()).toEqual([...ALL_SOCKETS, "sensor"].sort());
      const { id } = milkProbeListing();
      expect(id).toMatch(/^00:00:5E:00:53:21-milkprobe$/);
      await expect.poll(() => fromSensors(stream)).toEqual([{ sensorId: id, frame: earlier }]);

      // Steaming, as recorded: every reading goes, each as Decaid sent it, the last reaching the viewer.
      const from = tablet.sent.length;
      await tablet.replayLive(steam, { speed: 10 }).to();
      const sent = liveFramesSent(tablet, from, "sensor");
      expect(sent.map((frame) => frame.temperature)).toEqual(readings.map((frame) => frame.temperature));
      await expect.poll(() => fromSensors(stream).at(-1)).toEqual({ sensorId: id, frame: sent.at(-1) });
      expect(tablet.peakTransports).toBe(7);
      expect(tablet.logs.join("\n")).not.toContain("Too many open transports");
    } finally {
      await proxy.close();
    }
  });

  it("finds a milk probe attached while streaming, and keeps its socket through a detach", async () => {
    const { machine, tablet } = await connected("Probe attached", { bengle: true });
    const stream = await watching(machine, tablet);
    await expect.poll(() => tablet.openDecaidSockets()).toEqual(ALL_SOCKETS);

    // Attached: found as the plugin looks through Decaid's sensors again, and streamed.
    const [first, second] = bengleSteam().filter((frame) => frame.source === "sensor");
    tablet.attachMilkProbe();
    await expect.poll(() => tablet.openDecaidSockets()).toEqual([...ALL_SOCKETS, "sensor"].sort());
    const { id } = milkProbeListing();
    const reading = tablet.reportMilkProbe(first!.frame);
    await expect.poll(() => fromSensors(stream)).toEqual([{ sensorId: id, frame: reading }]);

    // Detached, then attached again: its socket stays open, and sends the probe's readings again.
    tablet.detachMilkProbe();
    tablet.attachMilkProbe();
    const next = tablet.reportMilkProbe(second!.frame);
    await expect.poll(() => fromSensors(stream)).toEqual([
      { sensorId: id, frame: reading },
      { sensorId: id, frame: next },
    ]);
    expect(tablet.openDecaidSockets()).toEqual([...ALL_SOCKETS, "sensor"].sort());
  });

  it("opens no sensor's socket on a DE1's tablet, whatever other sensors Decaid lists", async () => {
    // Decaid's simulated sensors, a sensor basket and a debug port, but no milk probe.
    const { machine, tablet } = await connected("No probe", { sensors: simulatedDevices()["/sensors"] });
    const stream = await watching(machine, tablet);
    await expect.poll(() => tablet.openDecaidSockets()).toEqual(ALL_SOCKETS);
    // Long enough for the plugin to look through Decaid's sensors again three times: every 5 s at the tablet's 50 times pace.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tablet.openDecaidSockets()).toEqual(ALL_SOCKETS);
    // Its connection, and Decaid's four sockets: never another.
    expect(tablet.peakTransports).toBe(5);
    expect(liveFramesSent(tablet, 0, "sensor")).toEqual([]);
    expect(fromSensors(stream)).toEqual([]);
  });

  it("keeps the time in state across a reconnect, and through a change of detail", async () => {
    const { machine, tablet } = await connected("Reconnect");
    const stream = await watching(machine, tablet);
    const preinfusion = tablet.reportSnapshot(firstOf("preinfusion"));
    await expect.poll(() => carrying(stream, [preinfusion]).length).toBe(1);
    const since = carrying(stream, [preinfusion])[0]!.stateSince!;

    // The tablet's network drops; its plugin connects again, and is started again.
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(2);
    const pouring = tablet.reportSnapshot(firstOf("pouring"));
    await expect.poll(() => carrying(stream, [pouring]).length).toBe(1);
    const event = carrying(stream, [pouring])[0]!;
    expect(named(event)).toBe("Pulling a shot");
    expect(event.stateSince).toBe(since);
    expect(Date.parse(event.receivedAt)).toBeGreaterThan(Date.parse(since));
  });

  it("drops a frame too large to relay before sending it, and sends the next", async () => {
    const { machine, tablet } = await connected("Large frame");
    const stream = await watching(machine, tablet);
    // A snapshot of a future Decaid with far more in it than today's, derived from a recorded one.
    const large = tablet.reportSnapshot({ ...firstOf("preinfusion"), future: "x".repeat(8_000) });
    const next = tablet.reportSnapshot(firstOf("pouring"));
    await expect.poll(() => carrying(stream, [next]).length).toBe(1);
    expect(carrying(stream, [large])).toEqual([]);
    expect(tablet.sent.filter((frame) => isLiveFrame(frame) && (frame as { frame: { future?: unknown } }).frame.future !== undefined)).toEqual([]);
    expect(tablet.logs).toContain("Dropped a machine frame too large to relay to the Live View; any more are dropped too.");
  });

  it("drops the frames of a connection once another holds its Machine, even one received before", async () => {
    const { machine, tablet, serial: hardware } = await connected("Replaced");
    const stream = await watching(machine, tablet);
    const held = tablet.reportSnapshot(firstOf("preinfusion"));
    await expect.poll(() => carrying(stream, [held]).length).toBe(1);
    // Nothing else under way, so the one query that waits for the lock below is the frame's relay.
    await quiesced(api, { tablets: { tablet } });

    // A frame received while its connection held the Machine, relayed only once another hello has taken it, as through
    // another instance whose notification hasn't reached this one yet.
    const database = await server.connectDatabase();
    let late: Record<string, unknown>;
    try {
      await database.query("BEGIN");
      await database.query("LOCK TABLE machines IN ACCESS EXCLUSIVE MODE");
      late = tablet.reportSnapshot(firstOf("pouring"));
      await waitForLockWaits(server, { relation: "machines" });
      await database.query("UPDATE machines SET connected_session_id = $1 WHERE id = $2", [randomUUID(), machine.machine.id]);
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
    const afterwards = tablet.reportSnapshot(firstOf("pouringDone"));

    // Another tablet with the Machine's token takes it over, and its frames reach the viewer.
    const other = syncingTablet(machine, server, { api: emptyLibrary(hardware) });
    await expect.poll(() => count(other.delivered, "liveStart")).toBe(1);
    const taken = other.reportSnapshot(idle[0]!);
    await expect.poll(() => carrying(stream, [taken]).length).toBe(1);
    expect(carrying(stream, [late!, afterwards])).toEqual([]);
  });

  it("follows a Tablet swap: the viewer receives the new Tablet's frames, each naming it, and none from the one it replaced", async () => {
    const { machine, tablet, serial: hardware } = await connected("Swapped");
    const stream = await watching(machine, tablet);
    const [before] = await seen(tablet, [idle[0]!], stream);
    const first = (await api.machineNamed("Swapped"))!.tablet!.id;
    expect(carrying(stream, [before!]).map((event) => event.tabletId)).toEqual([first]);

    // Another Tablet connects with the Machine's token while the first is still connected, and takes it over.
    const swapped = syncingTablet(machine, server, { api: emptyLibrary(hardware) });
    await tablet.waitForLog(/^Another tablet connected with this Machine's token and took over\./);
    await expect.poll(() => count(swapped.delivered, "liveStart")).toBe(1);
    // The replaced Tablet's Decaid goes on reporting, and the new one's frames reach the viewer.
    const replaced = tablet.reportSnapshot(firstOf("preinfusion"));
    const taken = await seen(swapped, [idle[1]!, idle[2]!], stream);
    expect(carrying(stream, [replaced])).toEqual([]);
    const holder = (await api.machineNamed("Swapped"))!.tablet!.id;
    expect(holder).not.toBe(first);
    expect(carrying(stream, taken).map((event) => event.tabletId)).toEqual([holder, holder]);
    expect(liveFramesSent(tablet, 0).filter((snapshot) => snapshot.timestamp === replaced.timestamp)).toEqual([]);
  });

  it("relays the device list of a Tablet not connected to its machine, which says so, then the machine's frames once it connects", async () => {
    // Bound to its machine's hardware; then its Tablet starts without the machine, as with the machine switched off.
    const { machine, tablet, serial: hardware } = await connected("Not connected");
    await tablet.unload();
    await api.waitForMachine(machine.machine.name, (viewed) => !viewed.online);
    const { disconnected, reconnected } = machineDisconnects();
    const sockets = { ...openingFrames(), devices: disconnected };
    const alone = syncingTablet(machine, server, { api: emptyLibrary(hardware), machineConnected: false, sockets });
    await api.waitForOnline(machine);
    const stream = await watching(machine, alone);
    const listsTheMachine = (frame: Record<string, unknown>, state: string) =>
      (frame.devices as { type: string; state: string }[]).some((device) => device.type === "machine" && device.state === state);
    expect(listsTheMachine(disconnected, "disconnected") && !listsTheMachine(disconnected, "connected")).toBe(true);
    await expect.poll(() => fromSockets(stream)).toContainEqual({ source: "devices", frame: disconnected });
    // Decaid sends the machine's water levels, shot settings and state only while it is connected.
    expect(fromSockets(stream).map((event) => event.source).sort()).toEqual(["devices", "scale"]);
    expect(stream.events.filter((event) => event.source === "machine")).toEqual([]);

    // The machine connects: its Tablet's device list says so, and its frames follow.
    expect(listsTheMachine(reconnected, "connected")).toBe(true);
    alone.connectMachine(reconnected);
    await expect.poll(() => fromSockets(stream)).toContainEqual({ source: "devices", frame: reconnected });
    await expect.poll(() => stream.events.filter((event) => event.source === "machine").length).toBeGreaterThan(0);

    // It is disconnected again while streaming: the device list says so at once, as the latest.
    alone.disconnectMachine(disconnected);
    await expect.poll(() => fromSockets(stream).filter((event) => event.source === "devices").at(-1)?.frame).toEqual(disconnected);
  });

  it("never starts a connection whose tablet reports other hardware than its Machine's", async () => {
    const { machine, tablet } = await connected("Mismatch");
    // Bound to its tablet's hardware; then the token is entered on a tablet with another machine.
    await tablet.unload();
    const mismatched = syncingTablet(machine, server, { api: emptyLibrary(serial++) });
    await api.waitForMachine(machine.machine.name, (viewed) => viewed.online && viewed.identification === "mismatch");
    const stream = await openLiveView(api, machine.machine.id);
    expect(stream.status).toBe(200);

    // A Machine on the same instance, connected and watched after it. Each connection's decisions are its own, so its
    // plugin's start orders them only as their queries were made: the mismatched Machine's lease was announced first,
    // and a decision on it would be one query, made before the control's tablet even connected. The test fails when
    // mismatched connections are let stream.
    const control = await connected("Mismatch control");
    await watching(control.machine, control.tablet);
    mismatched.reportSnapshot(firstOf("preinfusion"));
    expect(count(mismatched.delivered, "liveStart")).toBe(0);
    expect(mismatched.sent.filter(isLiveFrame)).toEqual([]);
    expect(stream.events).toEqual([]);
  });

  it("opens for an offline Machine, whose frames arrive once it connects", async () => {
    const machine = await api.createMachine("Offline at first");
    const stream = await openLiveView(api, machine.machine.id);
    expect(stream.status).toBe(200);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++) });
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(1);
    const sent = tablet.reportSnapshot(idle[0]!);
    await expect.poll(() => carrying(stream, [sent]).length).toBe(1);
  });

  it("keeps no Live View of a viewer who left while its request was being let in", async () => {
    const { machine, tablet } = await connected("Left early");
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      // Holds the check of the viewer's session, which comes before the route.
      await database.query("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE");
      const abort = new AbortController();
      const leaving = api.eventStream(`/machines/${machine.machine.id}/live`, abort.signal).catch(() => undefined);
      await waitForLockWaits(server, { relation: "sessions" });
      abort.abort();
      await leaving;
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
    // Kept, its lease would have started the plugin, and been renewed for good. A Machine connected and watched after
    // it on the same instance has its plugin started many queries later than a decision on that lease would have been:
    // after a Machine's creation, its tablet's hello and another Live View's lease. The test fails when the route keeps
    // a viewer gone already.
    const control = await connected("Left early control");
    await watching(control.machine, control.tablet);
    expect(count(tablet.delivered, "liveStart")).toBe(0);
  });

  it("streams a Machine named by its id in capitals as any other", async () => {
    const { machine, tablet } = await connected("Capitals");
    const stream = await openLiveView(api, machine.machine.id.toUpperCase());
    expect(stream.status).toBe(200);
    await expect.poll(() => count(tablet.delivered, "liveStart")).toBe(1);
    await seen(tablet, [idle[0]!], stream);
    expect(stream.events.every((event) => event.machineId === machine.machine.id)).toBe(true);
  });

  it("sends a comment once it has had nothing else to send for a while, so proxies keep it open", async () => {
    const machine = await api.createMachine("Quiet");
    const stream = await openLiveView(api, machine.machine.id);
    await expect.poll(() => stream.comments.filter((comment) => comment === "keep-alive").length).toBeGreaterThanOrEqual(2);
    expect(stream.events).toEqual([]);
    expect(stream.ended).toBe(false);
  });

  it("answers 404 for a Machine there is none of", async () => {
    for (const id of [randomUUID(), "not-a-machine"]) {
      const response = await api.call("GET", `/machines/${id}/live`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ message: "No such Machine" });
    }
  });

  it("lets Staff watch any Machine, wherever they work", async () => {
    const theirs = await api.createLocation("Live View, Staff's own", "America/Toronto");
    const elsewhere = await api.createLocation("Live View elsewhere", "America/Toronto");
    const staff = await api.staffAt("live-view-staff@example.com", theirs);
    const machine = await api.createMachine("Staff's view", elsewhere.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++) });
    await api.waitForOnline(machine);
    const stream = await watching(machine, tablet, staff);
    const sent = tablet.reportSnapshot(idle[0]!);
    await expect.poll(() => carrying(stream, [sent]).length).toBe(1);
  });
});
