import { type CurveInfo, type Sample, shadedSpans } from "@decent-sync/protocol";
import * as z from "zod";

// A Shot's or Steam Record's curves as an assistant reads them (#408): each
// series cut to about 100 points by a method that keeps its shape and peaks,
// with the shaded phases its record's page shades, such as a Shot's Preheat,
// at the seconds that page draws them.

/** The most points a series is cut to. */
export const MAX_CURVE_POINTS = 100;

/** A point of a series: its seconds and value. */
type Point = [seconds: number, value: number];

const points = z
  .array(z.tuple([z.number(), z.number()]))
  .describe(`Points as [seconds, value], in order, cut to at most ${MAX_CURVE_POINTS} keeping the curve's shape and peaks. A gap in the seconds is a stretch with no reading.`);

/** One curve's schema: its unit, readings and targets. */
export function curveSchema(description: string) {
  return z
    .object({
      unit: z.string(),
      values: points,
      targets: points.describe("The targets the Machine reported, as the management interface draws them dashed; empty where it reported none."),
    })
    .describe(description);
}

/** The schema of a record's shaded phases. */
export function shadedSchema(description: string) {
  return z.array(z.object({ phase: z.string(), from: z.number(), until: z.number() }).describe("From its first sample's seconds to the next sample's.")).describe(description);
}

/**
 * A record's curves from its samples (`shotSamples`, `steamSamples`): its
 * shaded phases, each by name from its first sample to the sample after its
 * last, as the management interface shades them, and each curve's readings
 * and targets, rounded to hundredths.
 */
export function curvesOf<C extends string>(samples: readonly Sample<C>[], curves: Record<C, CurveInfo>) {
  const series = Object.fromEntries(
    (Object.keys(curves) as C[]).map((curve) => [
      curve,
      {
        unit: curves[curve].unit,
        values: seriesOf(samples, (sample) => sample.values[curve]),
        targets: seriesOf(samples, (sample) => sample.targets[curve]),
      },
    ]),
  ) as Record<C, { unit: string; values: Point[]; targets: Point[] }>;
  const shaded = shadedSpans(samples).map(({ name, from, until }) => ({ phase: name, from: hundredths(from), until: hundredths(until) }));
  return { shaded, ...series };
}

/**
 * The samples' readings of one value, leaving out those without one, cut to
 * `MAX_CURVE_POINTS`. Its peak is kept, and its peak in the time the record's
 * duration counts, outside its shaded phases, which its own peaks are of,
 * such as a Shot's peak flow, which leaves out the heater test's in Preheat.
 */
function seriesOf<C extends string>(samples: readonly Sample<C>[], value: (sample: Sample<C>) => number | null): Point[] {
  const read: Point[] = [];
  const counted: boolean[] = [];
  for (const sample of samples) {
    const reading = value(sample);
    if (reading === null) continue;
    read.push([sample.seconds, reading]);
    counted.push(sample.shade === null);
  }
  const peaks = [peakOf(read, () => true), peakOf(read, (n) => counted[n]!)].filter((n) => n >= 0);
  return reduced(read, MAX_CURVE_POINTS, peaks).map(([seconds, reading]) => [hundredths(seconds), hundredths(reading)]);
}

/** The index of the highest of the points `included` picks, the first if several are, or -1 without any. */
function peakOf(read: readonly Point[], included: (n: number) => boolean): number {
  let peak = -1;
  read.forEach(([, reading], n) => {
    if (included(n) && (peak < 0 || reading > read[peak]![1])) peak = n;
  });
  return peak;
}

/**
 * At most `max` of the points, in order, the `kept` among them: all of them
 * if there are few enough, otherwise those Largest-Triangle-Three-Buckets
 * picks (`largestTriangles`), leaving room for the kept.
 */
export function reduced(read: readonly Point[], max: number, kept: readonly number[] = []): Point[] {
  if (read.length <= max) return [...read];
  const anchors = new Set(kept);
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

function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
