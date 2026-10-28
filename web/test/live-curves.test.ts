import { type RelayedLiveFrame, machineStateOf } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import flush from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/flush.json" with { type: "json" };
import hotWater from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/hot-water.json" with { type: "json" };
import idle from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/idle.json" with { type: "json" };
import shot from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/shot.json" with { type: "json" };
import steamRecordTwoTapStop from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/steam-record-two-tap-stop.json" with { type: "json" };
import steamRecord from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/steam-record.json" with { type: "json" };
import steamTwoTapStop from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/steam-two-tap-stop.json" with { type: "json" };
import steam from "../../server/test/fixtures/decaid/de1pro-live-v0.9.0/steam.json" with { type: "json" };
import { steamSamples } from "../src/lib/curves";
import { type LiveCurve, type LiveCurves, liveSamples, withCurvesFrame, withStreamOpened } from "../src/lib/live-curves";

// The Live View's curves (#263), built from the test tablet's DE1Pro's
// recorded streams (server/test/fixtures/decaid/de1pro-live-v0.9.0/, #259),
// relayed as its plugin streams them, and, for steaming, compared with the
// Steam Record Decaid stored of the same steaming.

type Recording = { frames: { ms: number; source: string; frame: Record<string, unknown> }[] };
const MACHINE_ID = "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a70";
/** When the plugin received each recording's first frame, an hour apart, so recordings relayed one after another follow on. */
const RECORDINGS = new Map<Recording, number>(
  [shot, steam, steamTwoTapStop, flush, hotWater, idle].map((recording, n) => [recording as Recording, Date.parse("2026-10-27T21:00:00Z") + n * 3_600_000]),
);

/**
 * A recording's frames as the plugin relays them, each received at its
 * recorded time, a machine frame with when its Machine State's name began, as
 * the plugin's `TimeInState` tracks it from every snapshot, streaming or not.
 */
function relayed(recording: unknown): RelayedLiveFrame[] {
  const at = RECORDINGS.get(recording as Recording)!;
  let name: string | undefined;
  let since = "";
  return (recording as Recording).frames.map(({ ms, source, frame }) => {
    const receivedAt = new Date(at + ms).toISOString();
    if (source !== "machine") return { machineId: MACHINE_ID, source, receivedAt, frame } as RelayedLiveFrame;
    const named = machineStateOf(frame)!;
    if (named.name !== name) [name, since] = [named.name, receivedAt];
    return { machineId: MACHINE_ID, source: "machine", receivedAt, stateSince: since, frame };
  });
}

/** The curves with each frame taken in, in order. */
function take(frames: RelayedLiveFrame[], curves: LiveCurves = {}): LiveCurves {
  return frames.reduce(withCurvesFrame, curves);
}

/** The index of a recording's first machine frame in that state and substate, or with a target flow of 0 or above 0 too. */
function first(frames: RelayedLiveFrame[], state: string, substate: string, flowing?: boolean): number {
  return frames.findIndex(({ source, frame }) => {
    const reported = frame.state as { state: string; substate: string } | undefined;
    if (source !== "machine" || reported?.state !== state || reported.substate !== substate) return false;
    return flowing === undefined || (frame.targetFlow as number) > 0 === flowing;
  });
}

function snapshotsIn(frames: RelayedLiveFrame[], state: string): Record<string, unknown>[] {
  return frames.filter(({ source, frame }) => source === "machine" && (frame.state as { state: string }).state === state).map(({ frame }) => frame);
}

describe("the Live View's curves", () => {
  it("builds a shot's curves from its frames as the Shot page reads a Shot's, each snapshot with the scale's latest weight", () => {
    const frames = relayed(shot);
    const { curve } = take(frames);
    expect(curve).toMatchObject({ activity: "shot", partial: false, ended: true, startedAt: frames[first(frames, "espresso", "preparingForShot")]!.receivedAt });
    // Each snapshot of the shot, in order, beside the scale's last weight before it, as Decaid records a Shot's.
    expect(curve!.measurements.map(({ machine }) => machine)).toEqual(snapshotsIn(frames, "espresso"));
    let weight: Record<string, unknown> | undefined;
    const paired = frames.flatMap(({ source, frame }) => {
      if (source === "scale") weight = frame;
      return source === "machine" && (frame.state as { state: string }).state === "espresso" ? [weight] : [];
    });
    expect(curve!.measurements.map(({ scale }) => scale)).toEqual(paired);
    expect(paired.every((scale) => typeof scale?.weight === "number")).toBe(true);

    const profile = { steps: [{ name: "Fill" }, { name: "Infuse" }, { name: "Pressure Up" }, { name: "Pressure Decline" }, { name: "Stop" }] };
    const live = liveSamples(curve!, profile);
    if (live.activity !== "shot") throw new Error(`Not a shot's samples: ${live.activity}`);
    const { samples } = live;
    expect(samples).toHaveLength(paired.length);
    // Its 2.9 s of Preheat before 0 s, then 7.7 s of preinfusion, 23.8 s of pouring and 4.2 s ending it.
    expect(samples[0]).toMatchObject({ shade: "Preheat", step: null });
    expect(samples[0]!.seconds).toBeCloseTo(-2.9, 0);
    const profileStart = samples.findIndex((sample) => sample.shade === null);
    expect(samples[profileStart]).toMatchObject({ seconds: 0, step: { frame: expect.any(Number), name: expect.any(String) } });
    expect(samples.at(-1)!.seconds).toBeCloseTo(35.7, 0);
    expect(new Set(samples.flatMap(({ step }) => (step ? [step.name] : [])))).toEqual(new Set(profile.steps.map(({ name }) => name)));
    // The scale's weight rises to the shot's yield.
    expect(samples.at(-1)!.values.weight).toBeGreaterThan(30);
  });

  it.each([
    ["Normal", steam, steamRecord, ["Preparing", "Paused", "Purge"]],
    ["Two Tap Stop", steamTwoTapStop, steamRecordTwoTapStop, ["Preparing", "Paused", "Puffing", "Purge"]],
  ])("builds steaming's curves from its frames as its Steam Record's page draws the record, %s", (_, recording, record, shades) => {
    const frames = relayed(recording);
    const { curve } = take(frames);
    expect(curve).toMatchObject({ activity: "steaming", partial: false, ended: true });
    expect(curve!.measurements.map(({ machine }) => machine)).toEqual(snapshotsIn(frames, "steam"));
    const live = liveSamples(curve!);
    expect(live.activity).toBe("steaming");
    // The record also holds the first sample after steaming, which the curves end before.
    const measurements = (record as { measurements: unknown[] }).measurements;
    expect(live.samples).toEqual(steamSamples(measurements.slice(0, -1), null));
    expect(new Set(live.samples.flatMap(({ shade }) => (shade ? [shade] : [])))).toEqual(new Set(shades));
  });

  it("labels the curves partial where their shot or steaming began before the page's first machine frame", () => {
    const shotFrames = relayed(shot);
    // Opened mid-shot: the shot's Machine State began before the page's first frame.
    const pouring = first(shotFrames, "espresso", "pouring");
    const midShot = take(shotFrames.slice(pouring)).curve!;
    expect(midShot).toMatchObject({ activity: "shot", partial: true, ended: true });
    expect(midShot.measurements.map(({ machine }) => machine)).toEqual(snapshotsIn(shotFrames.slice(pouring), "espresso"));
    // Drawn from its first frame, at 0 s.
    expect(liveSamples(midShot).samples[0]).toMatchObject({ seconds: 0, shade: null });
    // Opened with its first frame: it is whole.
    expect(take(shotFrames.slice(first(shotFrames, "espresso", "preparingForShot"))).curve!.partial).toBe(false);

    // Opened during the purge, which began after the steaming did.
    const steamFrames = relayed(steam);
    const purge = first(steamFrames, "steam", "pouringDone", true);
    expect(take(steamFrames.slice(purge + 1)).curve).toMatchObject({ activity: "steaming", partial: true });

    // Earlier frames of other sources, which the server sends a joining viewer again, don't count.
    const shotSettings = { machineId: MACHINE_ID, source: "shotSettings", receivedAt: "2026-10-27T20:00:00.000Z", frame: { targetSteamTemp: 160 } } as RelayedLiveFrame;
    expect(take([shotSettings, ...shotFrames.slice(pouring)]).curve!.partial).toBe(true);
  });

  it("keeps the last curves until the next shot or steaming starts", () => {
    const afterShot = take(relayed(shot));
    const kept = take([...relayed(flush), ...relayed(hotWater), ...relayed(idle)], afterShot);
    // A flush, a hot water pour and idle draw no curves.
    expect(kept.curve).toBe(afterShot.curve);
    const steaming = take(relayed(steam), kept);
    expect(steaming.curve).toMatchObject({ activity: "steaming", ended: true, partial: false });
    expect(take(relayed(shot), steaming).curve).toMatchObject({ activity: "shot", ended: true, partial: false });
  });

  it("continues the curves after the stream opened again only in a Machine State they hold, and starts new ones otherwise", () => {
    const steamFrames = relayed(steam);
    const pouring = first(steamFrames, "steam", "pouring", true);
    const purge = first(steamFrames, "steam", "pouringDone", true);
    const beforeClosing = take(steamFrames.slice(0, pouring + 10));
    const steamingBefore = beforeClosing.curve!;

    // Opened again while the same Steaming runs: its curves continue, into the Purging after it.
    const continued = take(steamFrames.slice(pouring + 40), withStreamOpened(beforeClosing)).curve!;
    expect(continued).toMatchObject({ activity: "steaming", startedAt: steamingBefore.startedAt, partial: false, ended: true });
    expect(continued.measurements.map(({ machine }) => machine)).toEqual([
      ...snapshotsIn(steamFrames.slice(0, pouring + 10), "steam"),
      ...snapshotsIn(steamFrames.slice(pouring + 40), "steam"),
    ]);

    // Opened again during its Purging, which began while the stream was closed: it may be another steaming's, so it is drawn as one, partial.
    const purging = take(steamFrames.slice(purge + 2), withStreamOpened(beforeClosing)).curve!;
    expect(purging).toMatchObject({ activity: "steaming", partial: true, ended: true });
    expect(purging.startedAt).not.toBe(steamingBefore.startedAt);

    // Opened again during another steaming, by Two Tap Stop: its own curves, partial.
    const otherFrames = relayed(steamTwoTapStop);
    const otherPouring = first(otherFrames, "steam", "pouring", true);
    const other = take(otherFrames.slice(otherPouring + 10), withStreamOpened(beforeClosing)).curve!;
    expect(other).toMatchObject({ activity: "steaming", partial: true, ended: true });
    expect(other.measurements.map(({ machine }) => machine)).toEqual(snapshotsIn(otherFrames.slice(otherPouring + 10), "steam"));

    // With the stream open throughout, a Machine State beginning again doesn't split the curves, as a purge's target flow falling to 0 would.
    const flicker = steamFrames.findIndex(({ source }, n) => n > purge && source === "machine");
    const flickered = steamFrames.map((frame, n) => (n === flicker ? { ...frame, stateSince: frame.receivedAt, frame: { ...frame.frame, targetFlow: 0 } } : frame));
    expect(take(flickered).curve).toMatchObject({ startedAt: steamingBefore.startedAt, partial: false });
    expect(take(flickered).curve!.measurements).toHaveLength(snapshotsIn(steamFrames, "steam").length);
  });

  it("takes each snapshot with the scale's latest weight, and none once the scale disconnects", () => {
    const frames = relayed(shot);
    const start = first(frames, "espresso", "preparingForShot");
    const disconnected = { machineId: MACHINE_ID, source: "scale", receivedAt: frames[start]!.receivedAt, frame: { status: "disconnected" } } as RelayedLiveFrame;
    const { curve } = take([...frames.slice(0, start), disconnected, ...frames.slice(start).filter(({ source }) => source === "machine")]);
    expect(curve!.measurements.every(({ scale }) => scale === undefined)).toBe(true);
    // A frame without a Machine State, or of a source the curves don't read, changes nothing.
    const curves: LiveCurves = { curve: curve as LiveCurve };
    const noState = { machineId: MACHINE_ID, source: "machine", receivedAt: frames[start]!.receivedAt, stateSince: frames[start]!.receivedAt, frame: { pressure: 1 } } as RelayedLiveFrame;
    expect(withCurvesFrame(curves, noState)).toBe(curves);
    expect(withCurvesFrame(curves, { ...noState, source: "waterLevels", frame: { currentLevel: 20 } })).toBe(curves);
  });
});
