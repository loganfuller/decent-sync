import { SETTINGS_EDIT_STATES } from "@decent-sync/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineActivity } from "../src/machine-activity.js";
import { MACHINE_GONE_AFTER_MS, SHOT_STORED_WITHIN_MS, ShotGate } from "../src/shot-gate.js";

// When the plugin takes its Machine to be running nothing, which its reads
// of the machine's own settings and sensor calibration wait for (#403): the
// latest machine state Decaid reported is one of SETTINGS_EDIT_STATES, or
// none was reported yet, and no Shot is yet to be stored (`ShotGate`).

describe("MachineActivity", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A gate and the activity over it, told of each state as the connection tells them, the gate first. */
  function machine() {
    const shot = new ShotGate();
    const activity = new MachineActivity(shot);
    const turnedFree = vi.fn();
    activity.onRunningNothing(turnedFree);
    const report = (state: string) => {
      shot.state(state);
      activity.state(state);
    };
    return { shot, activity, turnedFree, report };
  }

  it("runs nothing before any state is reported, and in each of the states a Settings Edit goes ahead in", () => {
    const { activity, report } = machine();
    expect(activity.runningNothing()).toBe(true);
    for (const state of SETTINGS_EDIT_STATES) {
      report(state);
      expect(activity.runningNothing()).toBe(true);
    }
  });

  it("runs something in every other state, as steam, hot water, a flush, heating, an error or a firmware upgrade", () => {
    const { activity, report } = machine();
    for (const state of ["steam", "hotWater", "flush", "steamRinse", "cleaning", "descaling", "heating", "preheating", "booting", "busy", "error", "fwUpgrade"]) {
      report(state);
      expect(activity.runningNothing()).toBe(false);
    }
  });

  it("runs a Shot from espresso until Decaid stores it, not as the state leaves espresso", () => {
    const { activity, turnedFree, report, shot } = machine();
    report("espresso");
    expect(activity.runningNothing()).toBe(false);
    report("idle");
    expect(activity.runningNothing()).toBe(false);
    expect(turnedFree).not.toHaveBeenCalled();
    shot.shotStored();
    expect(activity.runningNothing()).toBe(true);
    expect(turnedFree).toHaveBeenCalledTimes(1);
  });

  it("runs nothing once a Shot Decaid stores nothing of ends after SHOT_STORED_WITHIN_MS", () => {
    const { activity, turnedFree, report } = machine();
    report("espresso");
    report("idle");
    vi.advanceTimersByTime(SHOT_STORED_WITHIN_MS - 1);
    expect(activity.runningNothing()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(activity.runningNothing()).toBe(true);
    expect(turnedFree).toHaveBeenCalledTimes(1);
  });

  it("tells each time it turns to running nothing, and not on each update while it stays so", () => {
    const { turnedFree, report } = machine();
    report("idle");
    report("idle");
    expect(turnedFree).not.toHaveBeenCalled();
    report("steam");
    report("steam");
    expect(turnedFree).not.toHaveBeenCalled();
    report("idle");
    report("sleeping");
    expect(turnedFree).toHaveBeenCalledTimes(1);
    report("hotWater");
    report("needsWater");
    expect(turnedFree).toHaveBeenCalledTimes(2);
  });

  it("keeps a machine that went away busy as running something until Decaid reports a state again", () => {
    const { activity, turnedFree, report, shot } = machine();
    report("espresso");
    // No machine is found once Decaid has stopped reporting its state: the Shot ends, but espresso is the latest state.
    vi.advanceTimersByTime(MACHINE_GONE_AFTER_MS);
    shot.machineGone();
    expect(shot.running()).toBe(false);
    expect(activity.runningNothing()).toBe(false);
    expect(turnedFree).not.toHaveBeenCalled();
    report("idle");
    expect(activity.runningNothing()).toBe(true);
    expect(turnedFree).toHaveBeenCalledTimes(1);
  });
});
