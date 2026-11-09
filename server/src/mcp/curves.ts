import { type CurveInfo, type Sample, shadedSpans } from "@decent-sync/protocol";
import * as z from "zod";
import { hundredths, mostWithinBudget } from "./budget.js";

// A Shot's or Steam Record's curves as an assistant reads them (#408): all
// of them or those asked for (#440), each series thinned to about 100 points
// by a method that keeps its shape and peaks, or, for a Shot's within a
// window, to as many as the response's budget holds, with the shaded phases
// its record's page shades, such as a Shot's Preheat, at the seconds that
// page draws them.

/** The most points a series is thinned to by default. */
export const MAX_CURVE_POINTS = 100;

/** A point of a series: its seconds and value. */
type Point = [seconds: number, value: number];

/** A stretch of a record's curves' axis, in seconds, from its first sample or until its last where a bound is left out. */
export interface CurveWindow {
  from?: number | undefined;
  until?: number | undefined;
}

const points = z
  .array(z.tuple([z.number(), z.number()]))
  .describe("Points as [seconds, value], in order: every reading, or thinned to at most thinnedTo keeping the curve's shape and peaks.");

/** One curve's schema: its unit, readings and targets, given when asked for. */
export function curveSchema(description: string) {
  return z
    .object({
      unit: z.string(),
      values: points,
      targets: points.describe("The targets the Machine reported, as the management interface draws them dashed; empty where it reported none."),
    })
    .optional()
    .describe(`${description} Only when asked for.`);
}

/** The schema of a record's shaded phases. */
export function shadedSchema(description: string) {
  return z.array(z.object({ phase: z.string(), from: z.number(), until: z.number() }).describe("From its first sample's seconds to the next sample's.")).describe(description);
}

/** The schema of the most points a record's curves' series were thinned to. */
export const thinnedToSchema = z
  .number()
  .nullable()
  .describe(`Where a series had more readings than it gives, the most points each was thinned to, keeping its shape and peaks: ${MAX_CURVE_POINTS} by default, as many as fit within a window; null where every series gives every reading.`);

/**
 * A record's `curves` input: true for every one of its curves, a list of
 * those to give, or false for none.
 */
export function curvesInput<C extends string>(curves: Record<C, CurveInfo>) {
  const names = Object.keys(curves) as [C, ...C[]];
  return z
    .union([z.boolean(), z.array(z.enum(names)).min(1)])
    .default(false)
    .describe(`Its curves: true for all of them, or a list of those to give, of ${names.join(", ")}; none when false or left out, unless a window asks for them.`);
}

/** The curves `curvesInput` asks for, in their usual order: all of them, those listed, or none. */
export function askedCurves<C extends string>(curves: Record<C, CurveInfo>, asked: boolean | readonly C[]): Partial<Record<C, CurveInfo>> | undefined {
  if (asked === false) return undefined;
  if (asked === true) return curves;
  return Object.fromEntries((Object.keys(curves) as C[]).filter((curve) => asked.includes(curve)).map((curve) => [curve, curves[curve]])) as Partial<Record<C, CurveInfo>>;
}

/**
 * A response with a record's curves (`curvesOf`): each series thinned to
 * `MAX_CURVE_POINTS`, or, within a window, to as many points as fit the
 * response's budget (`mostWithinBudget`), every reading in it where the
 * response then fits. Never fewer than `MAX_CURVE_POINTS`: a response that
 * holds too much free text to fit even so is shortened by the guard, which
 * cuts its text first (`withinBudget`).
 */
export function withCurves<T extends object, C extends string>(
  response: T,
  samples: readonly Sample<C>[],
  curves: Partial<Record<C, CurveInfo>>,
  peaks: Partial<Record<C, number | null>>,
  window?: CurveWindow,
) {
  const respond = (max: number) => ({ ...response, curves: curvesOf(samples, curves, peaks, { window, max }) });
  if (!window) return respond(MAX_CURVE_POINTS);
  return respond(mostWithinBudget(MAX_CURVE_POINTS, samples.filter(within(window)).length, respond));
}

/**
 * A record's curves from its samples (`shotSamples`, `steamSamples`): its
 * shaded phases, each by name from its first sample to the sample after its
 * last, as the management interface shades them, the most points a series
 * was thinned to (`thinnedTo`), and each curve asked for, its readings and
 * targets in the window, if any, thinned to at most `max` points and rounded
 * to hundredths. `peaks` are the peaks the record reports of its curves,
 * which their readings keep: those its summary shows, such as a Shot's peak
 * flow, which leaves out the heater test's in Preheat, or a Steam Record's
 * peak milk temperature, which leaves out a reading carried over from the
 * Steam Record before.
 */
export function curvesOf<C extends string>(
  samples: readonly Sample<C>[],
  curves: Partial<Record<C, CurveInfo>>,
  peaks: Partial<Record<C, number | null>> = {},
  { window, max = MAX_CURVE_POINTS }: { window?: CurveWindow | undefined; max?: number } = {},
) {
  const shown = window ? samples.filter(within(window)) : samples;
  let thinned = false;
  const series = (value: (sample: Sample<C>) => number | null, reported: number | null) => {
    const read = readingsOf(shown, value);
    if (read.length > max) thinned = true;
    return thinnedSeries(read, max, reported);
  };
  const shownCurves = Object.fromEntries(
    (Object.keys(curves) as C[]).map((curve) => [
      curve,
      {
        unit: curves[curve]!.unit,
        values: series((sample) => sample.values[curve], peaks[curve] ?? null),
        targets: series((sample) => sample.targets[curve], null),
      },
    ]),
  ) as Partial<Record<C, { unit: string; values: Point[]; targets: Point[] }>>;
  const shaded = shadedSpans(samples).map(({ name, from, until }) => ({ phase: name, from: hundredths(from), until: hundredths(until) }));
  return { shaded, thinnedTo: thinned ? max : null, ...shownCurves };
}

/** Whether a sample is in a window, at its seconds as the curves give them, to hundredths. */
function within({ from, until }: CurveWindow): (sample: Sample<string>) => boolean {
  return ({ seconds }) => (from === undefined || hundredths(seconds) >= from) && (until === undefined || hundredths(seconds) <= until);
}

/** The samples' readings of one value, leaving out those without one. */
function readingsOf<C extends string>(samples: readonly Sample<C>[], value: (sample: Sample<C>) => number | null): Point[] {
  const read: Point[] = [];
  for (const sample of samples) {
    const reading = value(sample);
    if (reading !== null) read.push([sample.seconds, reading]);
  }
  return read;
}

/**
 * Readings thinned to at most `max`, keeping the highest and the last
 * reading of the peak its record reports, if any reading is that: the
 * readings that peak leaves out, a Shot's Preheat and a Steam Record's
 * carried over from the one before, come first.
 */
function thinnedSeries(read: readonly Point[], max: number, reported: number | null): Point[] {
  let highest = 0;
  read.forEach(([, reading], n) => {
    if (reading > read[highest]![1]) highest = n;
  });
  const peaks = [highest, read.map(([, reading]) => reading).lastIndexOf(reported ?? Number.NaN)].filter((n) => n >= 0);
  return reduced(read, max, peaks).map(([seconds, reading]) => [hundredths(seconds), hundredths(reading)]);
}

/**
 * At most `max` of the points, in order, the `kept` among them: all of them
 * if there are few enough, otherwise those Largest-Triangle-Three-Buckets
 * picks (`largestTriangles`), leaving room for the kept but the first and
 * last, which it always picks.
 */
function reduced(read: readonly Point[], max: number, kept: readonly number[]): Point[] {
  if (read.length <= max) return [...read];
  const anchors = new Set(kept.filter((n) => n > 0 && n < read.length - 1));
  const chosen = new Set(largestTriangles(read, Math.max(2, max - anchors.size)));
  for (const n of anchors) chosen.add(n);
  return [...chosen].sort((a, b) => a - b).map((n) => read[n]!);
}

/**
 * The indices of `count` of the points, at least 2, by Largest-Triangle-Three-Buckets
 * (Steinarsson, "Downsampling Time Series for Visual Representation", 2013):
 * the first and last, and one from each of `count - 2` equal buckets of the
 * points between, the one making the largest triangle with the point chosen
 * before it and the average of the next bucket. It keeps a curve's shape,
 * its turns and its peaks, where taking every nth point would cut them off.
 */
function largestTriangles(read: readonly Point[], count: number): number[] {
  const n = read.length;
  if (count >= n) return read.map((_, index) => index);
  const chosen = [0];
  const width = (n - 2) / (count - 2);
  let a = 0;
  for (let bucket = 0; bucket < count - 2; bucket++) {
    const start = Math.floor(bucket * width) + 1;
    const end = Math.floor((bucket + 1) * width) + 1;
    // The last bucket's next is the last point alone.
    const nextEnd = Math.min(Math.floor((bucket + 2) * width) + 1, n);
    let averageSeconds = 0;
    let averageValue = 0;
    for (let next = end; next < nextEnd; next++) {
      averageSeconds += read[next]![0];
      averageValue += read[next]![1];
    }
    averageSeconds /= nextEnd - end;
    averageValue /= nextEnd - end;
    const [aSeconds, aValue] = read[a]!;
    let best = start;
    let largest = -1;
    for (let candidate = start; candidate < end; candidate++) {
      const [seconds, value] = read[candidate]!;
      const area = Math.abs((aSeconds - averageSeconds) * (value - aValue) - (aSeconds - seconds) * (averageValue - aValue));
      if (area > largest) {
        largest = area;
        best = candidate;
      }
    }
    chosen.push(best);
    a = best;
  }
  chosen.push(n - 1);
  return chosen;
}
