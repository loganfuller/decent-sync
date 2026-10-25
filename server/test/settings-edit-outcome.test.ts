import { describe, expect, it } from "vitest";
import { decideOutcome } from "../src/settings-edits/outcome.js";

// What came of a Settings Edit (ADR-0023), through the pure module's
// interface: decided from what the edit sent and the values the plugin read
// back after writing, or its refusal.

const fan = { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } };

describe("A Settings Edit's outcome", () => {
  it("is applied where every field read back holds the value sent, within half its step", () => {
    expect(decideOutcome(fan, { outcome: "written", values: { fan: 40 } })).toEqual({ outcome: "applied" });
    // Read back as the register's scaled value: a flow multiplier within half a thousandth of what was sent.
    const flow = { collection: "machineCalibration", fields: { flowMultiplier: 1.1 }, expected: { flowMultiplier: 1 } };
    expect(decideOutcome(flow, { outcome: "written", values: { flowMultiplier: 1.1000000000000001 } })).toEqual({ outcome: "applied" });
    expect(decideOutcome(flow, { outcome: "written", values: { flowMultiplier: 1.1005 } })).toEqual({ outcome: "applied" });
    // A choice or an on or off value holds exactly what was sent.
    const purge = { collection: "machineSettings", fields: { steamPurgeMode: 1, fan: 45 }, expected: { steamPurgeMode: 0, fan: 50 } };
    expect(decideOutcome(purge, { outcome: "written", values: { steamPurgeMode: 1, fan: 45 } })).toEqual({ outcome: "applied" });
  });

  it("is adjusted where the Machine stored another value, naming each such field and what it holds", () => {
    // Decaid truncates 1.005 to the thousandth below (`_writeMMRScaled`).
    const flow = { collection: "machineCalibration", fields: { flowMultiplier: 1.005 }, expected: { flowMultiplier: 1 } };
    expect(decideOutcome(flow, { outcome: "written", values: { flowMultiplier: 1.004 } })).toEqual({
      outcome: "adjusted",
      adjusted: [{ field: "flowMultiplier", holds: 1.004 }],
    });
    const purge = { collection: "machineSettings", fields: { fan: 45, steamPurgeMode: 1 }, expected: { fan: 50, steamPurgeMode: 0 } };
    expect(decideOutcome(purge, { outcome: "written", values: { fan: 45, steamPurgeMode: 0 } })).toEqual({
      outcome: "adjusted",
      adjusted: [{ field: "steamPurgeMode", holds: 0 }],
    });
    // A whole number a step away is another value.
    expect(decideOutcome(fan, { outcome: "written", values: { fan: 41 } })).toEqual({ outcome: "adjusted", adjusted: [{ field: "fan", holds: 41 }] });
  });

  it("names a field the read-back left out, or every field where it failed, as stored otherwise with nothing it holds", () => {
    expect(decideOutcome(fan, { outcome: "written", values: {} })).toEqual({ outcome: "adjusted", adjusted: [{ field: "fan" }] });
    expect(decideOutcome(fan, { outcome: "written" })).toEqual({ outcome: "adjusted", adjusted: [{ field: "fan" }] });
  });

  it("is refused with the plugin's reason, and for Decaid's refusal, the fields the read-back shows it changed before refusing", () => {
    expect(decideOutcome(fan, { outcome: "refused", reason: "machineBusy" })).toEqual({ outcome: "refused", reason: "machineBusy", changed: [] });
    expect(decideOutcome(fan, { outcome: "refused", reason: "changedSince", values: { fan: 30 } })).toEqual({ outcome: "refused", reason: "changedSince", changed: [] });
    expect(decideOutcome(fan, { outcome: "refused", reason: "expired" })).toEqual({ outcome: "refused", reason: "expired", changed: [] });
    const both = { collection: "machineSettings", fields: { fan: 45, steamPurgeMode: 1 }, expected: { fan: 50, steamPurgeMode: 0 } };
    // Decaid wrote the fan threshold, then failed on the steam purge mode.
    expect(decideOutcome(both, { outcome: "refused", reason: "decaid", values: { fan: 45, steamPurgeMode: 0 } })).toEqual({
      outcome: "refused",
      reason: "decaid",
      changed: ["fan"],
    });
    expect(decideOutcome(both, { outcome: "refused", reason: "decaid" })).toEqual({ outcome: "refused", reason: "decaid", changed: [] });
  });
});
