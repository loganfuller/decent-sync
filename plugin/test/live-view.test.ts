import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveFrame } from "@decent-sync/protocol";
import { LIVE_INTERVAL_MS, LiveRate, LiveView, TimeInState } from "../src/live-view.js";

// The plugin's side of the Live View: when time in state restarts, the rate
// rule, and what it streams, on the test tablet's DE1Pro's machine snapshots
// (server/test/fixtures/decaid/de1pro-live-v0.9.0/, #259).

function machineFrames(file: string): Record<string, unknown>[] {
  const url = new URL(`../../server/test/fixtures/decaid/de1pro-live-v0.9.0/${file}`, import.meta.url);
  const { frames } = JSON.parse(fs.readFileSync(url, "utf8")) as { frames: { source: string; frame: Record<string, unknown> }[] };
  return frames.filter((frame) => frame.source === "machine").map((frame) => frame.frame);
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

describe("LiveView", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-27T21:04:57.000Z") }));
  afterEach(() => vi.useRealTimers());

  function streaming(): { live: LiveView; sent: LiveFrame[]; logs: string[] } {
    const sent: LiveFrame[] = [];
    const logs: string[] = [];
    const live = new LiveView((line) => logs.push(line));
    live.start(async (frame) => void sent.push(frame));
    return { live, sent, logs };
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
    const live = new LiveView(() => {});
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
    for (const snapshot of espresso) live.stateUpdate(snapshot);
    expect(sent.slice(1).map((frame) => frame.frame)).toEqual(espresso);
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

  it("drops a frame Decaid's transport refuses, and goes on", async () => {
    const live = new LiveView(() => {});
    let refuse = true;
    const sent: LiveFrame[] = [];
    live.start(async (frame) => {
      if (refuse) throw Object.assign(new Error("Pending outbound bytes would exceed 1 MiB"), { code: "transport_resource_limit" });
      sent.push(frame);
    });
    const [idle] = machineFrames("idle.json");
    live.stateUpdate({ ...idle, state: { state: "espresso", substate: "preinfusion" } });
    await vi.runAllTimersAsync();
    refuse = false;
    live.stateUpdate({ ...idle, state: { state: "espresso", substate: "pouring" } });
    expect(sent.map((frame) => frame.frame.state)).toEqual([{ state: "espresso", substate: "pouring" }]);
  });
});
