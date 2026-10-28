import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { decaidNameInWords, machineStateOf, machineStateText, nameMachineState } from "@decent-sync/protocol";

// Machine State names from #258's table, and real machine snapshots the test
// tablet's DE1Pro sent on firmware 1358 and Decaid v0.9.0 (#259), as the
// plugin's `stateUpdate` carries them.

interface LiveFixtureFrame {
  source: string;
  frame: Record<string, unknown>;
}

function machineFrames(file: string): Record<string, unknown>[] {
  const url = new URL(`../../server/test/fixtures/decaid/de1pro-live-v0.9.0/${file}`, import.meta.url);
  const { frames } = JSON.parse(fs.readFileSync(url, "utf8")) as { frames: LiveFixtureFrame[] };
  return frames.filter((frame) => frame.source === "machine").map((frame) => frame.frame);
}

/** Each Machine State a recording passes through, on one line, in order, each once in a row. */
function passesThrough(file: string): string[] {
  const named: string[] = [];
  for (const snapshot of machineFrames(file)) {
    const text = machineStateText(machineStateOf(snapshot)!);
    if (named.at(-1) !== text) named.push(text);
  }
  return named;
}

const name = (state: string, substate: string, snapshot?: unknown) => {
  const { name, detail } = nameMachineState(state, substate, snapshot);
  return detail === null ? name : `${name} · ${detail}`;
};

describe("Machine State names", () => {
  it("names a shot with its phase, and a skipped step", () => {
    expect(name("espresso", "preparingForShot")).toBe("Pulling a shot · Preparing");
    expect(name("espresso", "preinfusion")).toBe("Pulling a shot · Preinfusion");
    expect(name("espresso", "pouring")).toBe("Pulling a shot · Pouring");
    expect(name("espresso", "pouringDone")).toBe("Pulling a shot · Ending");
    expect(name("skipStep", "pouring")).toBe("Pulling a shot · Next step");
    expect(passesThrough("shot.json")).toEqual([
      "Idle",
      "Pulling a shot · Preparing",
      "Pulling a shot · Preinfusion",
      "Pulling a shot · Pouring",
      "Pulling a shot · Ending",
      "Idle",
    ]);
  });

  it("tells steaming, its pauses and puffs, and its purge apart by the substate and target flow, as a Steam Record's phases are", () => {
    expect(name("steam", "preparingForShot", { targetFlow: 2.5 })).toBe("Steaming · Preparing");
    expect(name("steam", "pouring", { targetFlow: 2.5 })).toBe("Steaming");
    expect(name("steam", "pouring", { targetFlow: 0 })).toBe("Steaming · Paused");
    expect(name("steam", "pouringDone", { targetFlow: 0 })).toBe("Steaming · Paused");
    expect(name("steam", "pouringDone", { targetFlow: 4 })).toBe("Purging");
    expect(name("steam", "pausedSteam", { targetFlow: 0 })).toBe("Steaming · Paused");
    expect(name("steam", "puffing", { targetFlow: 0.125 })).toBe("Steaming · Puffing");
    // A snapshot without a target flow is read as flowing, as a Steam Record's sample is.
    expect(name("steam", "pouringDone")).toBe("Purging");
    expect(name("steam", "idle")).toBe("Steaming");
    expect(name("steam", "cleaningSteam")).toBe("Steaming · Cleaning steam");
    // Steam Purge Mode Normal: stop, the flow falls, then the purge, whose last samples arrive under idle.
    expect(passesThrough("steam.json")).toEqual(["Idle", "Steaming · Preparing", "Steaming", "Steaming · Paused", "Purging", "Idle"]);
    // Two Tap Stop: the first tap cuts the flow, puffs follow until the second, then the purge.
    expect(passesThrough("steam-two-tap-stop.json")).toEqual([
      "Idle",
      "Steaming · Preparing",
      "Steaming",
      "Steaming · Paused",
      "Steaming · Puffing",
      "Steaming · Paused",
      "Purging",
      "Idle",
    ]);
  });

  it("names a hot water pour, a flush and the steam wand's clean, heating up before the first two", () => {
    expect(name("hotWater", "preparingForShot")).toBe("Pouring hot water · Heating up");
    expect(name("hotWater", "pouring")).toBe("Pouring hot water");
    expect(name("flush", "preparingForShot")).toBe("Flushing · Heating up");
    expect(name("flush", "pouring")).toBe("Flushing");
    expect(name("steamRinse", "pouring")).toBe("Cleaning the steam wand");
    expect(name("steamRinse", "idle")).toBe("Cleaning the steam wand");
    expect(passesThrough("hot-water.json")).toEqual(["Idle", "Pouring hot water · Heating up", "Pouring hot water", "Idle"]);
    expect(passesThrough("flush.json")).toEqual(["Idle", "Flushing", "Idle"]);
  });

  it("names a cleaning cycle and a descale with their substates in words", () => {
    expect(name("cleaning", "cleaningStart")).toBe("Cleaning · Cleaning start");
    expect(name("cleaning", "cleaningGroup")).toBe("Cleaning · Cleaning group");
    expect(name("cleaning", "cleanSoaking")).toBe("Cleaning · Clean soaking");
    expect(name("cleaning", "cleaningSteam")).toBe("Cleaning · Cleaning steam");
    expect(name("descaling", "cleaningStart")).toBe("Descaling · Cleaning start");
    expect(name("descaling", "cleaningGroup")).toBe("Descaling · Cleaning group");
    expect(name("descaling", "cleaningSteam")).toBe("Descaling · Cleaning steam");
  });

  it("names idle and asleep, a wake schedule's idle by Decaid's name in its note, and a warm-up after a wake as heating up", () => {
    expect(nameMachineState("idle", "idle")).toEqual({ name: "Idle", detail: null, note: null });
    expect(nameMachineState("schedIdle", "idle")).toEqual({ name: "Idle", detail: null, note: "Woken by a wake schedule" });
    // Firmware 1358 reports the first part of a warm-up after a wake so, which Streamline takes for heating.
    expect(name("idle", "preparingForShot")).toBe("Idle · Heating up");
    expect(name("schedIdle", "preparingForShot")).toBe("Idle · Heating up");
    expect(name("sleeping", "idle")).toBe("Asleep");
    expect(passesThrough("wake.json")).toEqual(["Asleep", "Idle · Heating up", "Idle"]);
    expect(passesThrough("asleep.json")).toEqual(["Idle", "Asleep"]);
    expect(passesThrough("idle.json")).toEqual(["Idle"]);
  });

  it("names a Machine that needs water, and an error by its substate in words", () => {
    expect(name("needsWater", "idle")).toBe("Needs water");
    expect(passesThrough("needs-water.json")).toEqual(["Idle · Heating up", "Idle", "Needs water", "Idle"]);
    expect(name("error", "errorWLevel")).toBe("Error · W level");
    expect(name("error", "errorNoAC")).toBe("Error · No AC");
    expect(name("error", "errorNaN")).toBe("Error · NaN");
    expect(name("error", "errorHiCurrent")).toBe("Error · Hi current");
    expect(name("error", "idle")).toBe("Error");
  });

  it("names the rest of Decaid's states, two of them heating, which no device on Decaid v0.9.0 reports", () => {
    const named: [string, string][] = [
      ["airPurge", "Draining for transport"],
      ["booting", "Starting up"],
      ["busy", "Busy"],
      ["calibration", "Calibrating"],
      ["selfTest", "Self test"],
      ["fwUpgrade", "Updating firmware"],
      ["heating", "Heating"],
      ["preheating", "Heating"],
    ];
    for (const [state, expected] of named) expect(name(state, "idle")).toBe(expected);
  });

  it("shows a state or substate it has no name for by Decaid's name, in words", () => {
    expect(nameMachineState("descalingRinse", "idle")).toEqual({ name: "Descaling rinse", detail: null, note: null });
    expect(name("descalingRinse", "rinsingGroup")).toBe("Descaling rinse · Rinsing group");
    expect(name("espresso", "blooming")).toBe("Pulling a shot · Blooming");
    expect(name("idle", "warmingUpOOM")).toBe("Idle · Warming up OOM");
    expect(decaidNameInWords("hotWater")).toBe("hot water");
  });

  it("reads a snapshot's state and substate, and nothing from one that reports none", () => {
    const [snapshot] = machineFrames("shot.json");
    expect(machineStateOf(snapshot)).toEqual({ state: "idle", substate: "idle", name: "Idle", detail: null, note: null });
    for (const reported of [undefined, null, {}, { state: "idle" }, { state: "", substate: "idle" }, { state: 1, substate: "idle" }]) {
      expect(machineStateOf({ ...snapshot, state: reported })).toBeNull();
    }
    expect(machineStateOf(null)).toBeNull();
    expect(machineStateOf([snapshot])).toBeNull();
  });
});
