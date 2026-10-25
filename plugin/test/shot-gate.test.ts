import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHOT_STORED_WITHIN_MS, ShotGate } from "../src/shot-gate.js";

// When the plugin takes its Machine to be pulling a Shot, which its writes
// into the Workflow wait out (ADR-0022): from the machine state espresso
// until Decaid stores the Shot, or SHOT_STORED_WITHIN_MS after the state
// left espresso, or until no machine is connected.

describe("ShotGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds from espresso until the Shot is stored, not as the state leaves espresso", async () => {
    const gate = new ShotGate();
    const ends = vi.fn();
    gate.onEnd(ends);
    gate.state("idle");
    expect(gate.running()).toBe(false);
    gate.state("espresso");
    expect(gate.running()).toBe(true);
    const ended = gate.ended(60_000);
    gate.state("idle");
    expect(gate.running()).toBe(true);
    gate.shotStored();
    expect(ends).toHaveBeenCalledTimes(1);
    expect(gate.running()).toBe(false);
    await expect(ended).resolves.toBe(false);
  });

  it("ends a Shot Decaid stores nothing of once SHOT_STORED_WITHIN_MS have passed, and one whose machine goes at once", () => {
    const gate = new ShotGate();
    gate.state("espresso");
    // A Shot stored before the state left espresso is an earlier one's.
    gate.shotStored();
    expect(gate.running()).toBe(true);
    gate.state("idle");
    vi.advanceTimersByTime(SHOT_STORED_WITHIN_MS - 1);
    expect(gate.running()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(gate.running()).toBe(false);

    gate.state("espresso");
    gate.machineGone();
    expect(gate.running()).toBe(false);
  });

  it("lets a wait for the Shot end after its limit, or as the plugin stops", async () => {
    const gate = new ShotGate();
    gate.state("espresso");
    const limited = gate.ended(1_000);
    vi.advanceTimersByTime(1_000);
    await expect(limited).resolves.toBe(false);
    expect(gate.running()).toBe(true);
    const stopping = gate.ended(60_000);
    gate.stop();
    await expect(stopping).resolves.toBe(true);
  });
});
