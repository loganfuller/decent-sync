import { describe, expect, it } from "vitest";
import opening from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/opening.json" with { type: "json" };
import scaleConnects from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/scale-connects.json" with { type: "json" };
import shot from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/shot.json" with { type: "json" };
import asleep from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/asleep.json" with { type: "json" };
import machineDisconnects from "../../server/test/fixtures/decaid/simulated-devices-v0.9.0/machine-disconnects.json" with { type: "json" };
import bengleSteam from "../../server/test/fixtures/decaid/bengle-live-v0.9.0/steam.json" with { type: "json" };
import probeSocket from "../../server/test/fixtures/decaid/bengle-live-v0.9.0/probe-socket.json" with { type: "json" };
import {
  type LiveState,
  STALE_AFTER_MS,
  type StoredMachineState,
  asleepSinceOf,
  liveConditionOf,
  liveMachineOf,
  machineConnectedOf,
  milkTemperatureOf,
  readLiveEvent,
  reported,
  scaleOf,
  staleAtOf,
  timeInState,
  waterLevelOf,
  withHolder,
  withLiveFrame,
} from "../src/lib/live-view";

// Reading the Live View's events, each a live frame as the server relays it,
// on the test tablet's DE1Pro's recorded frames
// (server/test/fixtures/decaid/de1pro-live-v0.9.0/, #259) where Decaid's data
// is read, Decaid's device lists as its simulated machine was disconnected
// and connected again (simulated-devices-v0.9.0/, #264), and its simulated
// Bengle steaming with its milk probe (bengle-live-v0.9.0/, #265).

const recordings = {
  "opening.json": opening,
  "scale-connects.json": scaleConnects,
  "shot.json": shot,
  "asleep.json": asleep,
  "machine-disconnects.json": machineDisconnects,
  "bengle-steam.json": bengleSteam,
};

/** A recording's frames from one source, in order, as Decaid sent them. */
function framesOf(file: keyof typeof recordings, source: string): Record<string, unknown>[] {
  const { frames } = recordings[file] as { frames: { source: string; frame: Record<string, unknown> }[] };
  return frames.filter((frame) => frame.source === source).map((frame) => frame.frame);
}

const snapshot = { state: { state: "espresso", substate: "pouring" }, pressure: 3.06640625, targetPressure: 2.9375, flow: null };
const TABLET_ID = "019a2f3e-8b52-7c0f-9e2a-6a4d3f5c7b81";
const event = {
  machineId: "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a70",
  tabletId: TABLET_ID,
  source: "machine",
  receivedAt: "2026-10-27T21:05:09.881Z",
  stateSince: "2026-10-27T21:04:59.250Z",
  frame: snapshot,
};

describe("the Live View's events", () => {
  it("reads a relayed machine frame's snapshot and times, and nothing else", () => {
    const relayed = readLiveEvent(JSON.stringify(event))!;
    expect(liveMachineOf(relayed)).toEqual({ snapshot, receivedAt: event.receivedAt, stateSince: event.stateSince });
    expect(liveMachineOf(readLiveEvent(JSON.stringify({ ...event, source: "scale", stateSince: undefined }))!)).toBeNull();
    expect(liveMachineOf(readLiveEvent(JSON.stringify({ ...event, stateSince: undefined }))!)).toBeNull();
    const malformed = [JSON.stringify({ ...event, frame: [] }), JSON.stringify({ ...event, receivedAt: 1 }), JSON.stringify({ ...event, tabletId: undefined })];
    for (const data of ["", "not JSON", "[]", ...malformed, undefined]) {
      expect(readLiveEvent(data)).toBeNull();
    }
  });

  it("measures the time in state from when its name began to the latest snapshot, both by the tablet's clock", () => {
    const since = "2026-10-27T21:04:59.250Z";
    const after = (ms: number) => ({ stateSince: since, receivedAt: new Date(Date.parse(since) + ms).toISOString() });
    expect(timeInState(after(0))).toBe("0 s");
    expect(timeInState(after(10_631))).toBe("10 s");
    expect(timeInState(after(59_999))).toBe("59 s");
    expect(timeInState(after(184_000))).toBe("3 min 4 s");
    expect(timeInState(after(2 * 3_600_000 + 5 * 60_000 + 59_000))).toBe("2 h 5 min");
    // A tablet clock set back between the two shows no time rather than a negative one.
    expect(timeInState(after(-5_000))).toBe("0 s");
    expect(timeInState({ stateSince: "not a time", receivedAt: since })).toBeNull();
  });

  it("reads a value only where the snapshot sends a number", () => {
    expect(reported(snapshot, "pressure")).toBe(3.06640625);
    expect(reported(snapshot, "flow")).toBeNull();
    expect(reported(snapshot, "steamTemperature")).toBeNull();
    expect(reported({ ...snapshot, pressure: "3" }, "pressure")).toBeNull();
    expect(reported({ ...snapshot, pressure: Number.NaN }, "pressure")).toBeNull();
  });

  it("keeps the latest frame of each source, and ignores a source it doesn't show", () => {
    const relayed = (source: string, frame: Record<string, unknown>, stateSince?: string) =>
      readLiveEvent(JSON.stringify({ ...event, source, frame, stateSince }))!;
    const [levels, later] = framesOf("shot.json", "waterLevels");
    // Nothing it shows: still nothing.
    expect(withLiveFrame(undefined, relayed("sensor", { temperature: 40 }), 0)).toBeUndefined();
    let live = withLiveFrame(undefined, relayed("waterLevels", levels!), 1_000);
    live = withLiveFrame(live, relayed("scale", { status: "disconnected" }), 2_000);
    live = withLiveFrame(live, relayed("machine", snapshot, event.stateSince), 3_000);
    live = withLiveFrame(live, relayed("waterLevels", later!), 4_000);
    // With when the page received the machine snapshot, by its own clock.
    expect(live).toEqual({
      tabletId: TABLET_ID,
      arrivedAt: 4_000,
      waterLevels: later,
      scale: { status: "disconnected" },
      machine: { snapshot, receivedAt: event.receivedAt, stateSince: event.stateSince },
      machineArrivedAt: 3_000,
    });
    expect(withLiveFrame(live, relayed("sensor", { temperature: 40 }), 5_000)).toBe(live);
    // A machine frame without its times changes nothing.
    expect(withLiveFrame(live, relayed("machine", { state: { state: "idle", substate: "idle" } }), 5_000)).toBe(live);
  });

  it("keeps a milk probe's latest frame, of no other sensor, and reads its temperature only while current by Decaid's own times", () => {
    const sensor = (sensorId: string, frame: Record<string, unknown>) => readLiveEvent(JSON.stringify({ ...event, source: "sensor", sensorId, frame }))!;
    const { sensorId } = (bengleSteam as { frames: { sensorId?: string }[] }).frames.find((frame) => frame.sensorId)!;
    const readings = framesOf("bengle-steam.json", "sensor");
    const snapshots = framesOf("bengle-steam.json", "machine");
    let live = withLiveFrame(undefined, sensor(sensorId!, readings[0]!), 1_000);
    expect(live).toEqual({ tabletId: TABLET_ID, arrivedAt: 1_000, milkProbe: readings[0] });
    live = withLiveFrame(live, sensor(sensorId!, readings[1]!), 2_000);
    expect(live).toEqual({ tabletId: TABLET_ID, arrivedAt: 2_000, milkProbe: readings[1] });
    // Another sensor, such as Decaid's simulated sensor basket, which also sends a temperature: not a milk probe's.
    expect(withLiveFrame(live, sensor("mockSensorBasket", { timestamp: readings[2]!.timestamp, temperature: 93 }), 3_000)).toBe(live);

    // Steaming, each reading sent just after the snapshot it was taken with, both in Decaid's local time without an offset: current.
    const { frames } = bengleSteam as { frames: { source: string; frame: Record<string, unknown> }[] };
    const steaming = frames.slice(0, frames.findIndex(({ frame }) => frame === readings[1])).filter(({ source }) => source === "machine").at(-1)!.frame;
    expect(String(steaming.timestamp).slice(0, 21)).toBe(String(readings[1]!.timestamp).slice(0, 21));
    expect(milkTemperatureOf(readings[1], steaming)).toBe(readings[1]!.temperature);
    // A reading taken after the snapshot is current too, as frames of two sources may come in either order.
    expect(milkTemperatureOf(readings[2], steaming)).toBe(readings[2]!.temperature);

    // What the probe's socket sent as it opened after steaming: its last reading, current only up to 5 s after it was
    // taken. Derived: a snapshot of the recording, its time moved to 5 s and to 5.001 s after the reading.
    const [last] = (probeSocket as { opening: { frames: { frame: Record<string, unknown> }[] } }).opening.frames.map((frame) => frame.frame);
    const after = (ms: number) => ({ ...snapshots.at(-1), timestamp: new Date(Date.parse(`${String(last!.timestamp)}Z`) + ms).toISOString().slice(0, -1) });
    expect(milkTemperatureOf(last, after(STALE_AFTER_MS))).toBe(last!.temperature);
    expect(milkTemperatureOf(last, after(STALE_AFTER_MS + 1))).toBeNull();
    // The Tablet's clock set back, as daylight saving time ends: the snapshots after it are an hour before that
    // reading by Decaid's times, which isn't current either. Derived as above.
    expect(milkTemperatureOf(last, after(-STALE_AFTER_MS))).toBe(last!.temperature);
    expect(milkTemperatureOf(last, after(-STALE_AFTER_MS - 1))).toBeNull();
    expect(milkTemperatureOf(last, after(-3_600_000 + 10_000))).toBeNull();

    // No snapshot to judge it by, no probe, or a frame that isn't a reading, such as the socket's answer while none is listed.
    expect(milkTemperatureOf(readings[1], undefined)).toBeNull();
    expect(milkTemperatureOf(undefined, steaming)).toBeNull();
    const [notFound] = (probeSocket as { notFound: { frames: { frame: Record<string, unknown> }[] } }).notFound.frames.map((frame) => frame.frame);
    expect(milkTemperatureOf(notFound, steaming)).toBeNull();
  });

  it("drops what a Tablet sent once a frame comes from another, which has taken the Machine over, or the page's poll finds another holding it", () => {
    const other = "019a2f3e-9c63-7d1a-8f3b-7b5e4a6d8c92";
    const fromOther = readLiveEvent(JSON.stringify({ ...event, tabletId: other, source: "devices", frame: { devices: [] } }))!;
    let live = withLiveFrame(undefined, readLiveEvent(JSON.stringify(event))!, 1_000);
    live = withLiveFrame(live, readLiveEvent(JSON.stringify({ ...event, source: "scale", frame: { status: "connected" } }))!, 2_000);
    expect(withLiveFrame(live, fromOther, 3_000)).toEqual({ tabletId: other, arrivedAt: 3_000, devices: { devices: [] } });
    // Even one of a source it doesn't show.
    expect(withLiveFrame(live, readLiveEvent(JSON.stringify({ ...event, tabletId: other, source: "sensor", frame: {} }))!, 3_000)).toBeUndefined();
    // A poll asked for after the last frame came: another Tablet's frames are dropped, as one on the previous release
    // never sends any; the holder's own are kept.
    expect(withHolder(live, other, 2_500)).toBeUndefined();
    expect(withHolder(live, TABLET_ID, 2_500)).toBe(live);
    expect(withHolder(undefined, TABLET_ID, 2_500)).toBeUndefined();
    // One asked for before then, answered after: the frames came from a Tablet holding the Machine after it looked.
    expect(withHolder(live, other, 1_500)).toBe(live);
  });

  it("reads the water level against the refill level, low at or below it", () => {
    const [opening] = framesOf("opening.json", "waterLevels");
    expect(waterLevelOf(opening)).toEqual({ level: 4.78515625, refill: 5, low: true });
    expect(waterLevelOf({ currentLevel: 5, refillLevel: 5 }).low).toBe(true);
    expect(waterLevelOf(framesOf("shot.json", "waterLevels")[0])).toEqual({ level: 33.8203125, refill: 5, low: false });
    expect(waterLevelOf({ currentLevel: 3 })).toEqual({ level: 3, refill: null, low: false });
    expect(waterLevelOf(undefined)).toEqual({ level: null, refill: null, low: false });
  });

  it("reads the scale's connection from its status, and its weight, weight flow and battery from a weight, which shows it connected", () => {
    const none = { weight: null, weightFlow: null, battery: null };
    expect(scaleOf(undefined)).toEqual({ connected: null, ...none });
    expect(scaleOf({ status: "disconnected" })).toEqual({ connected: false, ...none });
    expect(scaleOf({ status: "connected" })).toEqual({ connected: true, ...none });
    const [weight] = framesOf("scale-connects.json", "scale").filter((frame) => frame.status === undefined);
    expect(scaleOf(weight)).toEqual({ connected: true, weight: 16, weightFlow: 0, battery: 80 });
    expect(scaleOf({ ...weight, battery: null })).toMatchObject({ connected: true, battery: null });
  });

  it("reads whether the Machine is connected to its Tablet from the devices it lists", () => {
    const [devices] = framesOf("opening.json", "devices");
    expect(machineConnectedOf(devices)).toBe(true);
    const listed = devices!.devices as Record<string, unknown>[];
    expect(machineConnectedOf({ ...devices, devices: listed.map((device) => ({ ...device, state: "disconnected" })) })).toBe(false);
    expect(machineConnectedOf({ ...devices, devices: listed.filter((device) => device.type !== "machine") })).toBe(false);
    expect(machineConnectedOf({ ...devices, devices: undefined })).toBeNull();
    expect(machineConnectedOf(undefined)).toBeNull();
  });
});

describe("what the Live View can show", () => {
  const [devicesConnected, devicesDisconnected] = framesOf("machine-disconnects.json", "devices");
  const [awake] = framesOf("shot.json", "machine");
  const sleeping = framesOf("asleep.json", "machine").find((frame) => (frame.state as { state: string }).state === "sleeping")!;
  /** The Live View with a machine snapshot the page received at `arrivedAt`, and a device list. */
  const liveWith = (frame: Record<string, unknown>, arrivedAt: number, devices = devicesConnected): LiveState => ({
    tabletId: TABLET_ID,
    arrivedAt,
    machine: { snapshot: frame, receivedAt: event.receivedAt, stateSince: event.stateSince },
    machineArrivedAt: arrivedAt,
    devices,
  });
  const openedAt = 10_000;
  /** The condition at `now`, the page's latest poll having found the Machine offline at `offlineAt`, or online. */
  const judged = (live: LiveState | undefined, now: number, offlineAt: number | null = null, mismatched = false, stored: StoredMachineState | null = null) =>
    liveConditionOf({ offlineAt, mismatched, stored, live, openedAt, now });

  it("is offline, then mismatched, as the page last polled the Machine, but for a current machine snapshot come since", () => {
    expect(judged(undefined, 20_000, 15_000)).toBe("offline");
    expect(judged(undefined, 20_000, 15_000, true)).toBe("offline");
    expect(judged({ tabletId: TABLET_ID, arrivedAt: openedAt, devices: devicesConnected }, openedAt, openedAt)).toBe("offline");
    // One that has connected since the page's last poll sends its snapshots before the next poll finds it online.
    const live = liveWith(awake!, 20_000);
    expect(judged(live, 25_000, 15_000)).toBe("live");
    expect(judged(live, 25_001, 15_000)).toBe("offline");
    // A poll asked for after the snapshot came, finding it offline, as after a Tablet that left cleanly: offline at once.
    expect(judged(live, 21_000, 20_500)).toBe("offline");
    expect(judged(live, 20_000, 20_000)).toBe("offline");
    expect(judged(live, 20_000, null, true)).toBe("mismatch");
    expect(judged(live, 20_000, 15_000, true)).toBe("mismatch");
  });

  it("waits until something has come, and says when the Tablet lists its machine not connected", () => {
    expect(judged(undefined, openedAt + 60_000)).toBe("waiting");
    expect(machineConnectedOf(devicesDisconnected)).toBe(false);
    expect(judged(liveWith(awake!, 20_000, devicesDisconnected), 20_000)).toBe("notConnected");
    // However long ago its last snapshot came.
    expect(judged(liveWith(awake!, 20_000, devicesDisconnected), 90_000)).toBe("notConnected");
    expect(judged({ tabletId: TABLET_ID, arrivedAt: 20_000, devices: devicesDisconnected }, 20_000)).toBe("notConnected");
    // A device list that names no machine at all says nothing of it.
    expect(judged(liveWith(awake!, 20_000, { ...devicesConnected, devices: undefined }), 20_000)).toBe("live");
  });

  it("is stale once more than 5 s has passed since the latest machine snapshot came, by the page's clock", () => {
    const live = liveWith(awake!, 20_000);
    expect(staleAtOf(live, openedAt)).toBe(20_000 + STALE_AFTER_MS);
    expect(judged(live, 20_000)).toBe("live");
    expect(judged(live, 25_000)).toBe("live");
    expect(judged(live, 25_001)).toBe("stale");
    // The tablet's times in it count for nothing.
    expect(judged({ ...live, machine: { ...live.machine!, receivedAt: "2020-01-01T00:00:00.000Z" } }, 25_000)).toBe("live");
  });

  it("counts from when the page last opened its stream until the first machine snapshot comes", () => {
    const live: LiveState = { tabletId: TABLET_ID, arrivedAt: openedAt, waterLevels: framesOf("opening.json", "waterLevels")[0], devices: devicesConnected };
    expect(staleAtOf(live, openedAt)).toBe(openedAt + STALE_AFTER_MS);
    expect(judged(live, openedAt + STALE_AFTER_MS)).toBe("live");
    expect(judged(live, openedAt + STALE_AFTER_MS + 1)).toBe("stale");
  });

  it("shows a Machine whose latest snapshot said it was asleep as asleep rather than stale", () => {
    const live = liveWith(sleeping, 20_000);
    expect(judged(live, 25_000)).toBe("live");
    expect(judged(live, 25_001)).toBe("asleep");
    expect(judged(live, 600_000)).toBe("asleep");
    // Woken, it is stale again once it stops sending.
    expect(judged(liveWith(awake!, 30_000), 35_001)).toBe("stale");
  });

  it("takes the stored Machine State where it was observed after the latest snapshot, or none has come, as a page opened while the Machine sleeps", () => {
    /** A stored Machine State, observed `ms` after the plugin received the snapshot in `liveWith`. */
    const storedAfter = (state: string, ms: number): StoredMachineState => ({ state, observedAt: new Date(Date.parse(event.receivedAt) + ms).toISOString() });
    // Opened while it sleeps: the replayed socket frames, but no snapshot.
    const opened: LiveState = { tabletId: TABLET_ID, arrivedAt: openedAt, devices: devicesConnected };
    expect(judged(opened, openedAt + STALE_AFTER_MS + 1, null, false, storedAfter("sleeping", -60_000))).toBe("asleep");
    expect(asleepSinceOf(opened, storedAfter("sleeping", -60_000))).toBe(storedAfter("sleeping", -60_000).observedAt);
    expect(judged(opened, openedAt + STALE_AFTER_MS + 1, null, false, storedAfter("idle", -60_000))).toBe("stale");
    // Gone to sleep after the last snapshot the page had, as with its tab hidden.
    const idle = liveWith(awake!, 20_000);
    expect(judged(idle, 25_001, null, false, storedAfter("sleeping", 1_000))).toBe("asleep");
    expect(judged(idle, 25_001, null, false, storedAfter("sleeping", -1_000))).toBe("stale");
    // The latest snapshot said asleep, though a stored state from before it didn't.
    expect(judged(liveWith(sleeping, 20_000), 25_001, null, false, storedAfter("idle", -1_000))).toBe("asleep");
    expect(asleepSinceOf(liveWith(sleeping, 20_000), null)).toBe(event.stateSince);
    // Woken since: the stored state wins over an older sleeping snapshot.
    expect(judged(liveWith(sleeping, 20_000), 25_001, null, false, storedAfter("idle", 1_000))).toBe("stale");
  });
});
