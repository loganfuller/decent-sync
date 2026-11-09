import { SHOT_CURVES, type Sample, type ShotCurve, shotSamples } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_CHARS, withinBudget } from "../src/mcp/budget.js";
import { MAX_CURVE_POINTS, askedCurves, curvesOf, withCurves } from "../src/mcp/curves.js";
import { preheatShotFixture, withRepeatedSamples } from "./support/shot-fixtures.js";

// A record's curves as get_shot and get_steam_record give them (#408, #440),
// through the pure functions they call: which curves, how many points, and a
// window of a Shot's at as many points as the response's budget holds
// (ADR-0028). assistant-records.test.ts calls the tools themselves.

type Curve = { unit: string; values: [number, number][]; targets: [number, number][] };
type Curves = { shaded: unknown[]; thinnedTo: number | null } & Partial<Record<ShotCurve, Curve>>;

const size = (value: unknown) => JSON.stringify(value).length;
const hundredths = (value: number) => Math.round(value * 100) / 100 || 0;

/** A real Shot with a Preheat: 168 samples, the first 43 of them, 7.36 s, its Preheat (de1pro-v0.9.0/shot-preheat.json). */
const fixture = preheatShotFixture();
const profile = (fixture.workflow as { profile: unknown }).profile;
const samples = shotSamples(fixture.measurements, profile);
/** Derived: its samples repeated, in order and with their recorded times, past 1.25 MiB, as a long tea shot's are. */
const long = shotSamples(withRepeatedSamples(fixture, "long").measurements, profile);

/** A value's readings among the samples, as a curve gives them, to hundredths. */
const readings = (from: readonly Sample<ShotCurve>[], value: (sample: Sample<ShotCurve>) => number | null): [number, number][] =>
  from.flatMap((sample) => (value(sample) === null ? [] : [[hundredths(sample.seconds), hundredths(value(sample)!)] as [number, number]]));

describe("a record's curves for an assistant", () => {
  it("gives every curve, or those listed, in their usual order", () => {
    expect(askedCurves(SHOT_CURVES, true)).toBe(SHOT_CURVES);
    expect(askedCurves(SHOT_CURVES, false)).toBeUndefined();
    const listed = askedCurves(SHOT_CURVES, ["weightFlow", "weight"])!;
    expect(Object.keys(curvesOf(samples, listed))).toEqual(["shaded", "thinnedTo", "weight", "weightFlow"]);
    expect(Object.keys(curvesOf(samples, SHOT_CURVES))).toEqual(["shaded", "thinnedTo", "pressure", "flow", "weight", "weightFlow", "temperature"]);
    expect((curvesOf(samples, listed) as Curves).weightFlow!.unit).toBe("g/s");
  });

  it("thins each series to 100 points by default, keeping its shape's ends and its highest reading, and says so", () => {
    const { curves } = withCurves({ id: "shot" }, samples, SHOT_CURVES, {}) as { curves: Curves };
    expect(curves.thinnedTo).toBe(MAX_CURVE_POINTS);
    for (const curve of ["pressure", "flow", "weight", "weightFlow", "temperature"] as const) {
      const read = readings(samples, (sample) => sample.values[curve]);
      const { values } = curves[curve]!;
      expect(values.length, curve).toBeLessThanOrEqual(MAX_CURVE_POINTS);
      expect(values.length, curve).toBeGreaterThanOrEqual(MAX_CURVE_POINTS - 2);
      expect([values[0], values.at(-1)], curve).toEqual([read[0], read.at(-1)]);
      expect(Math.max(...values.map(([, value]) => value)), curve).toBe(Math.max(...read.map(([, value]) => value)));
    }
    // A record whose series hold no more than 100 readings gives every one, and says none was thinned.
    const short = samples.slice(43, 143);
    const whole = curvesOf(short, SHOT_CURVES) as Curves;
    expect(whole.thinnedTo).toBeNull();
    expect(whole.weightFlow!.values).toEqual(readings(short, (sample) => sample.values.weightFlow));
  });

  it("gives every reading within a window of a few seconds, its bounds included, as the curves give their seconds", () => {
    // Samples 100 to 110, after Preheat, about 2.5 s of its pour.
    const window = { from: hundredths(samples[100]!.seconds), until: hundredths(samples[110]!.seconds) };
    const { curves } = withCurves({ id: "shot" }, samples, SHOT_CURVES, {}, window) as { curves: Curves };
    expect(curves.thinnedTo).toBeNull();
    const shown = samples.slice(100, 111);
    for (const curve of ["pressure", "flow", "weight", "weightFlow", "temperature"] as const) {
      expect(curves[curve]!.values, curve).toEqual(readings(shown, (sample) => sample.values[curve]));
      expect(curves[curve]!.targets, curve).toEqual(readings(shown, (sample) => sample.targets[curve]));
    }
    expect(curves.weightFlow!.values).toHaveLength(11);
    // Its Preheat is still marked, though the window is after it.
    expect(curves.shaded).toEqual([{ phase: "Preheat", from: -7.36, until: 0 }]);
    // A bound left out is the first or last sample; with both, the whole Shot fits, every reading of it.
    const tail = (withCurves({}, samples, SHOT_CURVES, {}, { from: window.from }) as { curves: Curves }).curves;
    expect(tail.weight!.values).toEqual(readings(samples.slice(100), (sample) => sample.values.weight));
    const all = (withCurves({}, samples, SHOT_CURVES, {}, {}) as { curves: Curves }).curves;
    expect(all.thinnedTo).toBeNull();
    expect(all.pressure!.values).toHaveLength(168);
    // A window past its last sample has no readings.
    expect((withCurves({}, samples, SHOT_CURVES, {}, { from: 1_000 }) as { curves: Curves }).curves.flow!.values).toEqual([]);
  });

  it("thins a window too wide for the budget to as many points as fit, each series keeping its highest reading and the peak its record reports", () => {
    expect(long.length).toBeGreaterThan(2_000);
    const peakPressure = Math.max(...long.filter((sample) => sample.shade === null).map((sample) => sample.values.pressure!));
    const details = { id: "long", notes: "Sweet, a little sharp at the end; try a finer grind." };
    const response = withCurves(details, long, SHOT_CURVES, { pressure: peakPressure }, {}) as { curves: Curves };
    expect(size(response)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const { thinnedTo } = response.curves;
    expect(thinnedTo).toBeGreaterThan(MAX_CURVE_POINTS);
    // One more point a series would not fit.
    expect(size({ ...details, curves: curvesOf(long, SHOT_CURVES, { pressure: peakPressure }, { window: {}, max: thinnedTo! + 1 }) })).toBeGreaterThan(MAX_RESPONSE_CHARS);
    for (const curve of ["pressure", "flow", "weight", "weightFlow", "temperature"] as const) {
      const { values } = response.curves[curve]!;
      expect(values.length, curve).toBeLessThanOrEqual(thinnedTo!);
      expect(Math.max(...values.map(([, value]) => value)), curve).toBe(Math.max(...readings(long, (sample) => sample.values[curve]).map(([, value]) => value)));
    }
    expect(response.curves.pressure!.values.map(([, value]) => value)).toContain(hundredths(peakPressure));
    // The guard leaves it as it is.
    expect(withinBudget(response, {}, "get_shot")).toBe(response);
  });

  it("thins a window no further than the default, leaving a response whose text is too long even so to the guard, which cuts its text", () => {
    const details = { id: "long", notes: "A long note. ".repeat(4_000) };
    const response = withCurves(details, long, SHOT_CURVES, {}, {}) as { notes: string; curves: Curves };
    expect(response.curves.thinnedTo).toBe(MAX_CURVE_POINTS);
    const fitted = withinBudget(response, {}, "get_shot");
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(fitted.notes.endsWith("…[cut]")).toBe(true);
    expect(fitted.curves).toEqual(response.curves);
  });
});
