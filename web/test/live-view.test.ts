import { describe, expect, it } from "vitest";
import { liveMachineOf, readLiveEvent, reported, timeInState } from "../src/lib/live-view";

// Reading the Live View's events, each a live frame as the server relays it.

const snapshot = { state: { state: "espresso", substate: "pouring" }, pressure: 3.06640625, targetPressure: 2.9375, flow: null };
const event = {
  machineId: "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a70",
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
    for (const data of ["", "not JSON", "[]", JSON.stringify({ ...event, frame: [] }), JSON.stringify({ ...event, receivedAt: 1 }), undefined]) {
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
});
