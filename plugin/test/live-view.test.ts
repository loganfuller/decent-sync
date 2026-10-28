import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LiveFrame, encode, utf8Length } from "@decent-sync/protocol";
import type { TransportEvent, Transports } from "../src/host.js";
import { LIVE_BUDGET_BYTES, LIVE_INTERVAL_MS, LIVE_SOCKETS, LIVE_SOCKET_RETRY_MS, LiveBudget, LiveRate, LiveView, TimeInState, sensorSocket } from "../src/live-view.js";

// The plugin's side of the Live View: when time in state restarts, the rate
// rule, the live budget, and what it streams, on the test tablet's DE1Pro's
// recorded frames (server/test/fixtures/decaid/de1pro-live-v0.9.0/, #259).

/** A recording's frames from one source, in order, as Decaid sent them. */
function framesOf(file: string, source: string): Record<string, unknown>[] {
  const url = new URL(`../../server/test/fixtures/decaid/de1pro-live-v0.9.0/${file}`, import.meta.url);
  const { frames } = JSON.parse(fs.readFileSync(url, "utf8")) as { frames: { source: string; frame: Record<string, unknown> }[] };
  return frames.filter((frame) => frame.source === source).map((frame) => frame.frame);
}

function machineFrames(file: string): Record<string, unknown>[] {
  return framesOf(file, "machine");
}

/**
 * Decaid's sockets as the Live View opens them, each opening at once and
 * quiet until `push` sends a frame on those open on a URL. An open of a URL
 * in `refused` fails, as for want of a transport. Decaid lists the milk
 * probe `probe.id`, none while it is null.
 */
function decaidSockets() {
  const open = new Map<string, { url: string; listener?: (event: TransportEvent) => void }>();
  const refused = new Set<string>();
  const probe: { id: string | null } = { id: null };
  let handles = 0;
  const transports: Transports = {
    open: async (url) => {
      if (refused.has(url)) throw new Error("Decaid allows no more transports");
      const handle = `socket ${++handles}`;
      open.set(handle, { url });
      return handle;
    },
    onEvent: (handle, listener) => {
      const socket = open.get(handle);
      if (socket) socket.listener = listener;
    },
    close: (handle) => void open.delete(handle),
  };
  const on = (url: string) => [...open.values()].filter((socket) => socket.url === url);
  return {
    transports,
    refused,
    probe,
    findMilkProbe: async () => probe.id,
    /** The URLs of the sockets open now. */
    urls: () => [...open.values()].map((socket) => socket.url).sort(),
    push: (url: string, frame: unknown) => {
      for (const socket of on(url)) socket.listener?.({ type: "data", dataType: "text", data: JSON.stringify(frame) });
    },
    /** Decaid closes the sockets open on the URL. */
    end: (url: string) => {
      for (const socket of on(url)) socket.listener?.({ type: "close", code: 1001 });
    },
  };
}

/** The first snapshot of each run of one state and substate, and of one target flow under steam, as Decaid sent it. */
function firstOfEach(file: string): Record<string, unknown>[] {
  const firsts: Record<string, unknown>[] = [];
  let last: string | undefined;
  for (const snapshot of machineFrames(file)) {
    const { state, substate } = snapshot.state as { state: string; substate: string };
    const key = `${state}/${substate}/${state === "steam" ? Number(snapshot.targetFlow) > 0 : ""}`;
    if (key !== last) firsts.push(snapshot);
    last = key;
  }
  return firsts;
}

/** A time n seconds after a moment, as the plugin writes one. */
const at = (n: number) => new Date(Date.UTC(2026, 9, 27, 21, 5, n)).toISOString();

describe("TimeInState", () => {
  it("restarts when the Machine State's name changes, and not when only its detail does", () => {
    const time = new TimeInState();
    // Idle, a shot's preparing, preinfusion, pouring and ending, then idle again.
    const shot = firstOfEach("shot.json");
    expect(shot.map((snapshot) => time.observe(snapshot, at(shot.indexOf(snapshot))))).toEqual([
      { since: at(0), changed: true },
      { since: at(1), changed: true },
      { since: at(1), changed: false },
      { since: at(1), changed: false },
      { since: at(1), changed: false },
      { since: at(5), changed: true },
    ]);
    expect(time.latestState()).toBe("idle");
  });

  it("keeps steaming's time through a pause and puffs, and restarts it for the purge", () => {
    const time = new TimeInState();
    // Idle, preparing, steaming, paused, puffing, paused, the purge, idle.
    const steam = firstOfEach("steam-two-tap-stop.json");
    expect(steam).toHaveLength(8);
    expect(steam.map((snapshot, n) => time.observe(snapshot, at(n))?.since)).toEqual([at(0), at(1), at(1), at(1), at(1), at(1), at(6), at(7)]);
  });

  it("keeps a Machine woken by a wake schedule idle, and its warm-up too", () => {
    const time = new TimeInState();
    const [idle] = machineFrames("idle.json");
    const reported = (state: string, substate: string) => ({ ...idle, state: { state, substate } });
    expect(time.observe(reported("idle", "idle"), at(0))).toEqual({ since: at(0), changed: true });
    expect(time.observe(reported("schedIdle", "idle"), at(1))).toEqual({ since: at(0), changed: false });
    expect(time.observe(reported("idle", "preparingForShot"), at(2))).toEqual({ since: at(0), changed: false });
    expect(time.observe(reported("sleeping", "idle"), at(3))).toEqual({ since: at(3), changed: true });
  });

  it("says nothing until a snapshot reports a state, then ignores one that reports none", () => {
    const time = new TimeInState();
    const [idle] = machineFrames("idle.json");
    expect(time.observe({ ...idle, state: null }, at(0))).toBeUndefined();
    expect(time.observe(idle, at(1))).toEqual({ since: at(1), changed: true });
    expect(time.observe({ ...idle, state: {} }, at(2))).toEqual({ since: at(1), changed: false });
    expect(time.latestState()).toBe("idle");
  });
});

describe("LiveRate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("forwards one frame a second outside an activity, holding the latest for the end of the second", () => {
    const forwarded: string[] = [];
    const rate = new LiveRate<string>((frame) => forwarded.push(frame));
    rate.offer("machine", "a", { now: false });
    rate.offer("machine", "b", { now: false });
    rate.offer("machine", "c", { now: false });
    expect(forwarded).toEqual(["a"]);
    vi.advanceTimersByTime(LIVE_INTERVAL_MS - 1);
    expect(forwarded).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(forwarded).toEqual(["a", "c"]);
    // The second after that held nothing, so the next goes at once.
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    rate.offer("machine", "d", { now: false });
    expect(forwarded).toEqual(["a", "c", "d"]);
  });

  it("forwards at once what it is told to, such as a change of Machine State or a frame during an activity, dropping what it held", () => {
    const forwarded: string[] = [];
    const rate = new LiveRate<string>((frame) => forwarded.push(frame));
    rate.offer("machine", "idle", { now: false });
    rate.offer("machine", "idle, held", { now: false });
    rate.offer("machine", "espresso", { now: true });
    rate.offer("machine", "espresso 2", { now: true });
    expect(forwarded).toEqual(["idle", "espresso", "espresso 2"]);
    rate.offer("machine", "idle again", { now: true });
    rate.offer("machine", "idle, held again", { now: false });
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    expect(forwarded).toEqual(["idle", "espresso", "espresso 2", "idle again", "idle, held again"]);
  });

  it("paces each source on its own, and drops what it holds once cleared", () => {
    const forwarded: string[] = [];
    const rate = new LiveRate<string>((frame) => forwarded.push(frame));
    rate.offer("machine", "machine", { now: false });
    rate.offer("scale", "scale", { now: false });
    rate.offer("machine", "machine, held", { now: false });
    expect(forwarded).toEqual(["machine", "scale"]);
    rate.clear();
    vi.advanceTimersByTime(LIVE_INTERVAL_MS * 3);
    expect(forwarded).toEqual(["machine", "scale"]);
    rate.offer("machine", "after", { now: false });
    expect(forwarded).toEqual(["machine", "scale", "after"]);
  });
});

describe("LiveBudget", () => {
  /** A budget whose sends are recorded, refused while `refusing` holds. */
  function budget(): { budget: LiveBudget<string>; sent: string[]; refusing: { now: boolean } } {
    const sent: string[] = [];
    const refusing = { now: false };
    const budget = new LiveBudget<string>(async (frame) => {
      if (refusing.now) throw Object.assign(new Error("Outbound data limit exceeded; send rejected"), { code: "transport_resource_limit" });
      sent.push(frame);
    });
    return { budget, sent, refusing };
  }
  const quarter = LIVE_BUDGET_BYTES / 4;

  it("sends frames while the bytes the server has yet to receive stay within the budget, then holds the latest of each source", () => {
    const { budget: live, sent } = budget();
    for (const frame of ["machine 1", "scale 1", "machine 2", "scale 2"]) live.offer(frame.split(" ")[0]!, frame, quarter);
    expect(sent).toEqual(["machine 1", "scale 1", "machine 2", "scale 2"]);
    live.offer("machine", "machine 3", 1);
    live.offer("scale", "scale 3", 1);
    live.offer("machine", "machine 4", 1);
    live.offer("waterLevels", "water 1", 1);
    expect(sent).toHaveLength(4);
    // The server has the first two: room for the held, in the order each source's latest came.
    live.received(2 * quarter);
    expect(sent.slice(4)).toEqual(["scale 3", "machine 4", "water 1"]);
  });

  it("holds every frame behind those held, even one that would fit, and sends what was held only as it fits", () => {
    const { budget: live, sent } = budget();
    live.offer("machine", "machine 1", LIVE_BUDGET_BYTES - 100);
    live.offer("machine", "machine 2", 200);
    // It would fit, but waits its turn.
    live.offer("scale", "scale 1", 50);
    expect(sent).toEqual(["machine 1"]);
    // Received in part: still no room for the held machine frame, so the scale frame behind it waits too.
    live.received(50);
    expect(sent).toEqual(["machine 1"]);
    live.received(LIVE_BUDGET_BYTES - 100);
    expect(sent).toEqual(["machine 1", "machine 2", "scale 1"]);
    // Nothing held, so the next goes at once.
    live.offer("machine", "machine 3", 200);
    expect(sent.at(-1)).toBe("machine 3");
  });

  it("takes the server's count of what it received, in all, ignoring one older than the last", () => {
    const { budget: live, sent } = budget();
    live.offer("machine", "machine 1", LIVE_BUDGET_BYTES);
    live.received(LIVE_BUDGET_BYTES);
    live.offer("machine", "machine 2", LIVE_BUDGET_BYTES);
    expect(sent).toEqual(["machine 1", "machine 2"]);
    live.offer("machine", "machine 3", 1);
    // A count from before the last, as one overtaken, frees nothing.
    live.received(LIVE_BUDGET_BYTES - 1);
    expect(sent).toHaveLength(2);
    live.received(2 * LIVE_BUDGET_BYTES);
    expect(sent).toEqual(["machine 1", "machine 2", "machine 3"]);
  });

  it("frees a frame Decaid refuses, which never leaves the tablet, and sends what it held", async () => {
    const { budget: live, sent, refusing } = budget();
    refusing.now = true;
    live.offer("machine", "refused", LIVE_BUDGET_BYTES);
    live.offer("machine", "held", 1);
    refusing.now = false;
    await vi.waitFor(() => expect(sent).toEqual(["held"]));
  });

  it("drops what it holds once cleared, keeping what was sent counted until the server receives it", () => {
    const { budget: live, sent } = budget();
    live.offer("machine", "machine 1", LIVE_BUDGET_BYTES);
    live.offer("machine", "dropped", 1);
    live.clear();
    live.offer("machine", "machine 2", 1);
    expect(sent).toEqual(["machine 1"]);
    live.received(LIVE_BUDGET_BYTES);
    expect(sent).toEqual(["machine 1", "machine 2"]);
  });
});

describe("LiveView", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-27T21:04:57.000Z") }));
  afterEach(() => vi.useRealTimers());

  function streaming(): { live: LiveView; sent: LiveFrame[]; logs: string[]; sockets: ReturnType<typeof decaidSockets> } {
    const sent: LiveFrame[] = [];
    const logs: string[] = [];
    const sockets = decaidSockets();
    const live = new LiveView((line) => logs.push(line), sockets.transports, sockets.findMilkProbe);
    live.start(async (frame) => void sent.push(frame));
    return { live, sent, logs, sockets };
  }

  it("streams each machine snapshot as Decaid sent it, with the plugin's time it came and when its Machine State began", () => {
    const { live, sent } = streaming();
    const [idle, preparing] = firstOfEach("shot.json");
    live.stateUpdate(idle);
    vi.advanceTimersByTime(300);
    live.stateUpdate(preparing);
    expect(sent).toEqual([
      { type: "liveFrame", source: "machine", receivedAt: "2026-10-27T21:04:57.000Z", stateSince: "2026-10-27T21:04:57.000Z", frame: idle },
      { type: "liveFrame", source: "machine", receivedAt: "2026-10-27T21:04:57.300Z", stateSince: "2026-10-27T21:04:57.300Z", frame: preparing },
    ]);
  });

  it("sends every frame of a shot, but one a second while idle, and tracks the time in state while not streaming", () => {
    const sent: LiveFrame[] = [];
    const sockets = decaidSockets();
    const live = new LiveView(() => {}, sockets.transports, sockets.findMilkProbe);
    const frames = machineFrames("shot.json");
    // Not streaming yet: its time in state is tracked all the same.
    live.stateUpdate(frames[0]);
    const idleSince = new Date().toISOString();
    vi.advanceTimersByTime(200);
    live.start(async (frame) => void sent.push(frame));
    for (const snapshot of frames.slice(1, 9)) {
      live.stateUpdate(snapshot);
      vi.advanceTimersByTime(100);
    }
    // Idle, 0.8 s of frames at 10 a second: one sent, the latest held.
    expect(sent.map((frame) => frame.stateSince)).toEqual([idleSince]);
    const espresso = frames.filter((snapshot) => (snapshot.state as { state: string }).state === "espresso");
    // The server receives each as it is sent, so the live budget holds none back.
    for (const snapshot of espresso) {
      live.stateUpdate(snapshot);
      live.received(sent.reduce((sum, frame) => sum + utf8Length(encode(frame)), 0));
    }
    expect(sent.slice(1).map((frame) => frame.frame)).toEqual(espresso);
  });

  it("opens Decaid's sockets as it starts, forwarding each one's frames, each source paced on its own, and closes them as it stops", async () => {
    const { live, sent, sockets } = streaming();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.urls()).toEqual(Object.values(LIVE_SOCKETS).sort());
    // What each socket sent as it opened, the machine asleep and the scale off, and the latest snapshot.
    for (const source of ["waterLevels", "scale", "shotSettings", "devices"] as const) {
      sockets.push(LIVE_SOCKETS[source], framesOf("opening.json", source)[0]);
    }
    const [asleep] = machineFrames("opening.json");
    live.stateUpdate(asleep);
    expect(sent.map(({ source, frame }) => ({ source, frame }))).toEqual([
      { source: "waterLevels", frame: framesOf("opening.json", "waterLevels")[0] },
      { source: "scale", frame: { status: "disconnected" } },
      { source: "shotSettings", frame: framesOf("opening.json", "shotSettings")[0] },
      { source: "devices", frame: framesOf("opening.json", "devices")[0] },
      { source: "machine", frame: asleep },
    ]);
    expect(sent.every((frame) => frame.receivedAt === "2026-10-27T21:04:57.000Z")).toBe(true);
    expect(sent.filter((frame) => frame.source !== "machine").every((frame) => frame.stateSince === undefined && frame.sensorId === undefined)).toBe(true);

    // Asleep, each source sends one frame a second, the latest winning, from when it last sent one.
    const weights = framesOf("asleep.json", "scale");
    const levels = framesOf("asleep.json", "waterLevels");
    let from = sent.length;
    for (const weight of weights.slice(0, 5)) sockets.push(LIVE_SOCKETS.scale, weight);
    sockets.push(LIVE_SOCKETS.waterLevels, levels[0]);
    expect(sent.slice(from).map((frame) => frame.frame)).toEqual([]);
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
    expect(sent.slice(from).map((frame) => frame.frame)).toEqual([levels[0], weights[4]]);

    // During a shot, every frame of every source goes.
    const shot = framesOf("shot.json", "scale").slice(0, 5);
    live.stateUpdate(firstOfEach("shot.json")[1]);
    from = sent.length;
    for (const weight of shot) sockets.push(LIVE_SOCKETS.scale, weight);
    expect(sent.slice(from).map((frame) => frame.frame)).toEqual(shot);

    // Not a JSON object: dropped.
    from = sent.length;
    sockets.push(LIVE_SOCKETS.devices, ["not", "an", "object"]);
    expect(sent.slice(from)).toEqual([]);

    // Stopped: the sockets close, and what they'd send goes nowhere.
    live.stop();
    expect(sockets.urls()).toEqual([]);
    live.start(async (frame) => void sent.push(frame));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.urls()).toEqual(Object.values(LIVE_SOCKETS).sort());
    live.disconnected();
    expect(sockets.urls()).toEqual([]);
  });

  it("opens a socket that couldn't open, or that Decaid closed, again a while later, until it stops", async () => {
    const sockets = decaidSockets();
    const live = new LiveView(() => {}, sockets.transports, sockets.findMilkProbe);
    sockets.refused.add(LIVE_SOCKETS.devices);
    live.start(async () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.urls()).not.toContain(LIVE_SOCKETS.devices);
    sockets.refused.clear();
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_RETRY_MS - 1);
    expect(sockets.urls()).not.toContain(LIVE_SOCKETS.devices);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.urls()).toEqual(Object.values(LIVE_SOCKETS).sort());

    sockets.end(LIVE_SOCKETS.scale);
    expect(sockets.urls()).not.toContain(LIVE_SOCKETS.scale);
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_RETRY_MS);
    expect(sockets.urls()).toEqual(Object.values(LIVE_SOCKETS).sort());

    // Stopped while one waits to be opened again: it stays closed.
    sockets.end(LIVE_SOCKETS.scale);
    live.stop();
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_RETRY_MS * 2);
    expect(sockets.urls()).toEqual([]);
  });

  it("opens a milk probe's socket once Decaid lists one, forwarding its frames tagged with its id, and looks again while none is", async () => {
    const { live, sent, sockets } = streaming();
    await vi.advanceTimersByTimeAsync(0);
    // No probe listed, as on a DE1: no socket for one.
    expect(sockets.urls()).toEqual(Object.values(LIVE_SOCKETS).sort());

    // One attached: found as Decaid lists it next, by an id that names its Bengle's device, and its socket opened.
    const id = "00:00:5E:00:53:21-milkprobe";
    const url = sensorSocket(id);
    expect(url).toBe("ws://localhost:8080/ws/v1/sensors/00%3A00%3A5E%3A00%3A53%3A21-milkprobe/snapshot");
    sockets.probe.id = id;
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_RETRY_MS);
    expect(sockets.urls()).toEqual([...Object.values(LIVE_SOCKETS), url].sort());
    const reading = { timestamp: "2026-10-28T11:05:55.430551", temperature: 7.0 };
    sockets.push(url, reading);
    expect(sent.at(-1)).toEqual({ type: "liveFrame", source: "sensor", sensorId: id, receivedAt: expect.any(String), frame: reading });

    // Its socket closes, as one opened while the probe isn't listed does: Decaid is looked through again, a while later.
    sockets.push(url, { error: "not found" });
    sockets.end(url);
    sockets.probe.id = null;
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_RETRY_MS * 2);
    expect(sockets.urls()).not.toContain(url);
    sockets.probe.id = id;
    await vi.advanceTimersByTimeAsync(LIVE_SOCKET_RETRY_MS);
    expect(sockets.urls()).toContain(url);

    // Stopped: it closes with the rest.
    live.stop();
    expect(sockets.urls()).toEqual([]);
  });

  it("drops a frame too large to relay, saying so once, and sends the next", () => {
    const { live, sent, logs } = streaming();
    const [idle] = machineFrames("idle.json");
    live.stateUpdate({ ...idle, extra: "x".repeat(8000) });
    expect(sent).toEqual([]);
    live.stateUpdate({ ...idle, state: { state: "espresso", substate: "preparingForShot" }, extra: "x".repeat(8000) });
    expect(logs).toEqual(["Dropped a machine frame too large to relay to the Live View; any more are dropped too."]);
    live.stateUpdate({ ...idle, state: { state: "espresso", substate: "preinfusion" } });
    expect(sent.map((frame) => frame.frame.state)).toEqual([{ state: "espresso", substate: "preinfusion" }]);
  });

  it("sends nothing once stopped, drops what it held, and changes nothing on a second start", async () => {
    const { live, sent } = streaming();
    const [first, second] = machineFrames("idle.json");
    live.start(async () => {
      throw new Error("A second start must not replace the first");
    });
    live.stateUpdate(first);
    live.stateUpdate(second);
    live.stop();
    vi.advanceTimersByTime(LIVE_INTERVAL_MS * 2);
    live.stateUpdate(first);
    expect(sent.map((frame) => frame.frame)).toEqual([first]);
  });

  it("holds the latest frame past its budget until the server says it received the rest, and starts afresh on the next connection", () => {
    const { live, sent } = streaming();
    const espresso = machineFrames("shot.json").filter((snapshot) => (snapshot.state as { state: string }).state === "espresso");
    // Every frame of a shot goes, until the budget is spent.
    const offered: Record<string, unknown>[] = [];
    while (sent.length === offered.length) {
      offered.push(espresso[offered.length % espresso.length]!);
      live.stateUpdate(offered.at(-1));
    }
    const bytes = (frames: LiveFrame[]) => frames.reduce((sum, frame) => sum + utf8Length(encode(frame)), 0);
    expect(bytes(sent)).toBeLessThanOrEqual(LIVE_BUDGET_BYTES);
    expect(bytes(sent) + utf8Length(encode({ ...sent[0]!, frame: offered.at(-1)! }))).toBeGreaterThan(LIVE_BUDGET_BYTES);
    const held = sent.length;
    for (const snapshot of espresso.slice(0, 5)) live.stateUpdate(snapshot);
    expect(sent).toHaveLength(held);

    // The server has received them all: only the latest held goes.
    live.received(bytes(sent));
    expect(sent.slice(held).map((frame) => frame.frame)).toEqual([espresso[4]]);

    // Held again, then the connection ends: the next starts with nothing counted and nothing held.
    live.received(bytes(sent) - 1);
    for (let n = 0; n < 200; n++) live.stateUpdate(espresso[n % espresso.length]);
    live.disconnected();
    const next: LiveFrame[] = [];
    live.start(async (frame) => void next.push(frame));
    live.stateUpdate(espresso[0]);
    expect(next.map((frame) => frame.frame)).toEqual([espresso[0]]);
  });

  it("drops a frame Decaid's transport refuses, and goes on", async () => {
    const sockets = decaidSockets();
    const live = new LiveView(() => {}, sockets.transports, sockets.findMilkProbe);
    let refuse = true;
    const sent: LiveFrame[] = [];
    live.start(async (frame) => {
      if (refuse) throw Object.assign(new Error("Pending outbound bytes would exceed 1 MiB"), { code: "transport_resource_limit" });
      sent.push(frame);
    });
    const [idle] = machineFrames("idle.json");
    live.stateUpdate({ ...idle, state: { state: "espresso", substate: "preinfusion" } });
    // Not every timer: while streaming with no milk probe listed, the plugin looks for one again and again.
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
    refuse = false;
    live.stateUpdate({ ...idle, state: { state: "espresso", substate: "pouring" } });
    expect(sent.map((frame) => frame.frame.state)).toEqual([{ state: "espresso", substate: "pouring" }]);
  });
});
