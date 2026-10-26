import { describe, expect, it } from "vitest";
import preheatShot from "../../server/test/fixtures/decaid/de1pro-v0.9.0/shot-preheat.json" with { type: "json" };
import { chartPoints, firstSecond, lastSecond, secondTicks, shotSamples } from "../src/lib/curves";

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
