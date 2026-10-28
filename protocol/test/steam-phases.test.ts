import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { type PhasedSample, type SteamPhase, isShadedPhase, shadedPhaseChanges, steamPhases, steamingSeconds } from "../src/index.js";

// Real Steam Records: four the test tablet's DE1Pro recorded on firmware 1358
// and Decaid v0.9.0, each stopped another way (#259, #308), one from firmware
// 1333 on Decaid v0.8.7, and one from Decaid v0.8.7's simulated Bengle.

type Measurement = { machine: Record<string, unknown> };

function measurementsOf(file: string): Measurement[] {
  const steam = JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/${file}`, import.meta.url), "utf8"));
  return steam.measurements;
}

/** Each sample's phase and its seconds from the first after the lead-in, by its local time: none of these crosses a change of the tablet's clock. */
function phased(measurements: Measurement[]): PhasedSample[] {
  const phases = steamPhases(measurements);
  const times = measurements.map((sample) => Date.parse(`${String(sample.machine.timestamp)}Z`));
  const zero = times[phases.findIndex((phase) => phase !== "preparing")]!;
  return phases.map((phase, n) => ({ phase, seconds: (times[n]! - zero) / 1000 }));
}

/** The phases in order, each with how many samples in a row it held. */
function runs(phases: SteamPhase[]): [SteamPhase, number][] {
  const found: [SteamPhase, number][] = [];
  for (const phase of phases) {
    if (found.at(-1)?.[0] === phase) found.at(-1)![1]++;
    else found.push([phase, 1]);
  }
  return found;
}

/** How long each phase lasted, to the millisecond, its stretches added up: from each of its samples to the next. */
function lasted(samples: PhasedSample[]): Partial<Record<SteamPhase, number>> {
  const totals: Partial<Record<SteamPhase, number>> = {};
  for (let n = 0; n + 1 < samples.length; n++) {
    const { phase, seconds } = samples[n]!;
    totals[phase] = (totals[phase] ?? 0) + samples[n + 1]!.seconds - seconds;
  }
  return Object.fromEntries(Object.entries(totals).map(([phase, seconds]) => [phase, Math.round(seconds * 1000) / 1000]));
}

// The issue's Expected values, to the millisecond, which it rounds to hundredths.
const RECORDS = [
  {
    file: "de1pro-live-v0.9.0/steam-record.json",
    stop: "a tap, in Normal",
    runs: [["preparing", 10], ["steaming", 81], ["paused", 16], ["purge", 15]],
    lasted: { preparing: 2.047, steaming: 16.915, paused: 3.316, purge: 2.922 },
    lines: [20.231],
  },
  {
    file: "de1pro-live-v0.9.0/steam-record-two-tap-stop.json",
    stop: "two taps, in Two Tap Stop",
    runs: [["preparing", 15], ["steaming", 95], ["paused", 10], ["puffing", 22], ["paused", 10], ["purge", 14]],
    lasted: { preparing: 3.12, steaming: 19.795, paused: 4.146, puffing: 4.578, purge: 2.729 },
    lines: [21.844, 26.422, 28.519],
  },
  {
    file: "de1pro-live-v0.9.0/steam-record-idle-request.json",
    stop: "an idle request",
    runs: [["preparing", 15], ["steaming", 50], ["paused", 18], ["purge", 16]],
    lasted: { preparing: 3.118, steaming: 10.341, paused: 3.747, purge: 3.127 },
    lines: [14.088],
  },
  {
    file: "de1pro-live-v0.9.0/steam-record-timed-stop.json",
    stop: "time, then a tap",
    runs: [["preparing", 12], ["steaming", 48], ["paused", 18], ["puffing", 171], ["paused", 10], ["purge", 28]],
    lasted: { preparing: 2.485, steaming: 9.994, paused: 5.892, puffing: 35.592, purge: 2.728 },
    lines: [13.791, 49.383, 51.478],
  },
  {
    file: "de1pro-v0.8.7/steam.json",
    stop: "going straight to idle, on firmware 1333",
    runs: [["preparing", 10], ["steaming", 9]],
    lasted: { preparing: 2.099, steaming: 1.659 },
    lines: [],
  },
] as const;

describe("a Steam Record's phases", () => {
  for (const record of RECORDS) {
    it(`reads those of one stopped by ${record.stop}`, () => {
      const samples = phased(measurementsOf(record.file));
      expect(runs(samples.map((sample) => sample.phase))).toEqual(record.runs);
      // The lead-in comes before 0 s, at the first sample after it.
      expect(samples[0]!.seconds).toBe(-record.lasted.preparing);
      expect(lasted(samples)).toEqual(record.lasted);
      expect(steamingSeconds(samples)).toBe(record.lasted.steaming);
      expect(shadedPhaseChanges(samples)).toEqual(record.lines);
    });
  }

  it("ends in the phase of the sample before the last, idle one", () => {
    for (const record of RECORDS) {
      const measurements = measurementsOf(record.file);
      const phases = steamPhases(measurements);
      expect((measurements.at(-1)!.machine.state as { substate: string }).substate).toBe("idle");
      expect(phases.at(-1)).toBe(phases.at(-2));
    }
  });

  it("reads Steaming from a first sample with no phase of its own, and on until another", () => {
    // Decaid v0.8.7's simulated Bengle reports `steam` / `idle`, at a target flow of 0, all along.
    const measurements = measurementsOf("bengle-simulated-v0.8.7/steam-milk-probe.json");
    expect(new Set(measurements.map((sample) => (sample.machine.state as { substate: string }).substate))).toEqual(new Set(["idle"]));
    expect(new Set(steamPhases(measurements))).toEqual(new Set(["steaming"]));
  });

  it("reads a sample without a target flow as at one above 0", () => {
    // Derived: the tap in Normal's first paused sample, `pouringDone`, and a steaming one, `pouring`, without their target flows.
    const measurements = measurementsOf("de1pro-live-v0.9.0/steam-record.json");
    const without = measurements.map((sample, n) => {
      if (n !== 50 && n !== 91) return sample;
      const { targetFlow: _, ...machine } = sample.machine;
      return { ...sample, machine };
    });
    expect([50, 91].map((n) => steamPhases(measurements)[n])).toEqual(["steaming", "paused"]);
    expect([50, 91].map((n) => steamPhases(without)[n])).toEqual(["steaming", "purge"]);
  });

  it("reads pausedSteam as Paused, at any target flow", () => {
    // Derived: the tap in Normal with five steaming samples marked `pausedSteam`, which no record shows.
    const measurements = measurementsOf("de1pro-live-v0.9.0/steam-record.json").map((sample, n) =>
      n >= 40 && n < 45 ? { ...sample, machine: { ...sample.machine, state: { state: "steam", substate: "pausedSteam" } } } : sample,
    );
    const phases = steamPhases(measurements);
    expect(phases.slice(39, 46)).toEqual(["steaming", "paused", "paused", "paused", "paused", "paused", "steaming"]);
    // Each pause meets Steaming on both sides, which the shading's edges mark.
    expect(shadedPhaseChanges(phased(measurements))).toEqual([20.231]);
  });

  it("gives a sample with no machine snapshot or substate the phase of the sample before", () => {
    const pouring = { machine: { state: { substate: "pouring" }, targetFlow: 2.5 } };
    const puffing = { machine: { state: { substate: "puffing" }, targetFlow: 0.125 } };
    expect(steamPhases([null, pouring, puffing, {}, { machine: { state: "steam" } }, 7])).toEqual(["steaming", "steaming", "puffing", "puffing", "puffing", "puffing"]);
    expect(steamPhases(undefined)).toEqual([]);
    expect(steamPhases({ measurements: [pouring] })).toEqual([]);
  });

  it("counts no steaming after the last sample, nor in a record of one", () => {
    expect(steamingSeconds([])).toBe(0);
    expect(steamingSeconds([{ phase: "steaming", seconds: 3 }])).toBe(0);
    expect(steamingSeconds([{ phase: "paused", seconds: 0 }, { phase: "steaming", seconds: 1.5 }])).toBe(0);
  });

  it("shades every phase but Steaming", () => {
    expect((["preparing", "steaming", "paused", "puffing", "purge"] as const).filter(isShadedPhase)).toEqual(["preparing", "paused", "puffing", "purge"]);
  });
});
