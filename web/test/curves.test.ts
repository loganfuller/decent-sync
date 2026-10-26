import { describe, expect, it } from "vitest";
import preheatShot from "../../server/test/fixtures/decaid/de1pro-v0.9.0/shot-preheat.json" with { type: "json" };
import { chartPoints, firstSecond, lastSecond, secondTicks, shotSamples, stepAt, stepChanges } from "../src/lib/curves";

// A Shot the test tablet's Decaid v0.9.0 recorded with a long Preheat: its
// first 43 of 168 samples, 7.36 s, before its profile's first, at
// 15:53:24.816 (server/test/fixtures/decaid/de1pro-v0.9.0/, ticket #287).
const measurements = preheatShot.measurements as { machine: Record<string, unknown> }[];

describe("shotSamples", () => {
  it("puts a Shot's Preheat at negative seconds, from 0 s at the first sample after it", () => {
    const samples = shotSamples(measurements);
    expect(samples).toHaveLength(168);
    expect(samples.map((sample) => sample.preheat)).toEqual(measurements.map((_, n) => n < 43));
    expect(samples[43]!.seconds).toBe(0);
    expect(samples[0]!.seconds).toBe(-7.363);
    expect(samples[42]!.seconds).toBeLessThan(0);
    expect(lastSecond(samples)).toBeCloseTo(25.833, 3);
    expect(firstSecond(samples)).toBe(samples[0]!.seconds);
    // Preheat keeps the targets the Machine reported then, and its flow is the heater test's 8 ml/s.
    expect(samples[0]!.targets.flow).toBe(4.125);
    expect(samples[42]!.values.flow).toBeCloseTo(8, 0);
  });

  it("reads the group temperature against its target, the profile's, not the mix temperature", () => {
    const samples = shotSamples(measurements);
    // The profile's steps hold the group at 88 °C, then 83 °C, while the mix target swings from 75 to 94 °C.
    expect([43, 50, 80, 167].map((n) => [samples[n]!.values.temperature, samples[n]!.targets.temperature])).toEqual([
      [70.85310363769531, 88],
      [72.68592834472656, 88],
      [85.04533386230469, 83],
      [83.12239074707031, 83],
    ]);
    expect(new Set(samples.slice(43).map((sample) => sample.targets.temperature))).toEqual(new Set([88, 83]));
  });

  it("starts at 0 s, with no Preheat, when the first sample is not preparingForShot", () => {
    // Derived: the real Shot without its Preheat's samples.
    const samples = shotSamples(measurements.slice(43));
    expect(samples[0]!.seconds).toBe(0);
    expect(samples.some((sample) => sample.preheat)).toBe(false);
    expect(firstSecond(samples)).toBe(0);
  });

  it("ends Preheat at the first sample with another substate, so a later preparingForShot sample is not in it", () => {
    // Derived: the real Shot with one sample of its profile marked preparingForShot.
    const marked = measurements.map((sample, n) => (n === 100 ? { ...sample, machine: { ...sample.machine, state: { state: "espresso", substate: "preparingForShot" } } } : sample));
    expect(shotSamples(marked).map((sample) => sample.preheat)).toEqual(measurements.map((_, n) => n < 43));
  });
});

describe("shotSamples of a Shot stopped in Preheat", () => {
  it("keeps every sample before 0 s, however many there are", () => {
    // Derived: the real Shot's Preheat alone, and its first sample alone, as a Shot stopped before its profile started would record.
    const all = shotSamples(measurements.slice(0, 43));
    expect(all.every((sample) => sample.preheat && sample.seconds < 0)).toBe(true);
    expect(all.at(-1)!.seconds).toBe(-0.001);
    const one = shotSamples(measurements.slice(0, 1));
    expect(one.map((sample) => [sample.seconds, sample.preheat])).toEqual([[-0.001, true]]);
    expect(firstSecond(one)).toBe(-0.001);
  });
});

describe("chartPoints", () => {
  it("reads a Shot's Preheat before 0 s, with 0 s itself and the Shot compared with aligned there", () => {
    const samples = shotSamples(measurements);
    // Derived: the real Shot without its Preheat, as the previous Shot.
    const previous = shotSamples(measurements.slice(43));
    const points = chartPoints("flow", samples, previous, firstSecond(samples), lastSecond(samples));
    expect(points[0]!.seconds).toBe(samples[0]!.seconds);
    expect(points.filter((point) => point.seconds < 0).every((point) => point.previous === null)).toBe(true);
    // At 0 s both are at their profile's first sample.
    const zero = points.find((point) => point.seconds === 0)!;
    expect(zero.current).toBe(zero.previous);
    expect(zero.current).toBe(samples[43]!.values.flow);
  });
});

describe("secondTicks", () => {
  it("marks round seconds, always including 0 s where a Shot's profile starts", () => {
    expect(secondTicks(-8, 26)).toEqual([-5, 0, 5, 10, 15, 20, 25]);
    expect(secondTicks(0, 28)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(secondTicks(-1, 701)).toEqual([0, 120, 240, 360, 480, 600]);
    expect(secondTicks(0, 1)).toEqual([0, 1]);
  });
});

describe("a Shot's Profile steps", () => {
  const profile = preheatShot.workflow.profile;

  it("names each sample's step after Preheat by its profileFrame, and none in Preheat", () => {
    const samples = shotSamples(measurements, profile);
    // In Preheat the frame, 4, is left over from before the Shot.
    expect(samples.slice(0, 43).every((sample) => sample.step === null)).toBe(true);
    expect([43, 66, 67, 72, 101, 127, 167].map((n) => samples[n]!.step)).toEqual([
      { frame: 0, name: "Prefill" },
      { frame: 0, name: "Prefill" },
      { frame: 2, name: "Compressing" },
      { frame: 3, name: "Dripping" },
      { frame: 4, name: "Pressurize" },
      { frame: 6, name: "Extraction" },
      { frame: 6, name: "Extraction" },
    ]);
  });

  it("changes step at each frame change the samples show, never in Preheat or at 0 s", () => {
    const samples = shotSamples(measurements, profile);
    // Fill (frame 1) and the 0 s Extraction start (frame 5) are never reported, so 0 to 2 and 4 to 6 are one change each.
    // Preheat's frame 4 to the profile's frame 0, at 0 s, is none.
    expect(stepChanges(samples)).toEqual([67, 72, 101, 127].map((n) => samples[n]!.seconds));
    expect(stepChanges(samples)[0]).toBeGreaterThan(0);
    // A Shot stopped in Preheat has none.
    expect(stepChanges(shotSamples(measurements.slice(0, 43), profile))).toEqual([]);
  });

  it("names a step with no name, or a frame past the Profile's steps, Step N, counting from 1", () => {
    // Derived: the real Shot's Profile with its Dripping step's name blank, and with only its first three steps.
    const blank = { ...profile, steps: profile.steps.map((step, n) => (n === 3 ? { ...step, name: " " } : step)) };
    expect(shotSamples(measurements, blank)[72]!.step).toEqual({ frame: 3, name: "Step 4" });
    const short = { ...profile, steps: profile.steps.slice(0, 3) };
    expect([67, 72, 127].map((n) => shotSamples(measurements, short)[n]!.step?.name)).toEqual(["Compressing", "Step 4", "Step 7"]);
    // With no Profile at all, every step after Preheat is still named and its changes still marked.
    const unnamed = shotSamples(measurements);
    expect(unnamed[43]!.step).toEqual({ frame: 0, name: "Step 1" });
    expect(stepChanges(unnamed)).toEqual(stepChanges(shotSamples(measurements, profile)));
  });

  it("neither starts nor ends a step at a sample that reports no frame", () => {
    // Derived: the real Shot with one Pressurize sample's profileFrame left out.
    const missing = measurements.map((sample, n) => {
      if (n !== 110) return sample;
      const { profileFrame: _, ...machine } = sample.machine;
      return { ...sample, machine };
    });
    const samples = shotSamples(missing, profile);
    expect(samples[110]!.step).toBeNull();
    expect(stepChanges(samples)).toEqual(stepChanges(shotSamples(measurements, profile)));
  });

  it("reads the step at a chart's time from the last sample at or before it", () => {
    const samples = shotSamples(measurements, profile);
    const change = samples[67]!.seconds;
    expect(stepAt(samples, change)?.name).toBe("Compressing");
    expect(stepAt(samples, change - 0.001)?.name).toBe("Prefill");
    expect(stepAt(samples, -1)).toBeNull();
    expect(stepAt(samples, lastSecond(samples))?.name).toBe("Extraction");
    expect(stepAt(samples, lastSecond(samples) + 0.1)).toBeNull();
  });
});
