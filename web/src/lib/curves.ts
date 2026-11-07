// A record's curves, as its page charts them, from the samples the protocol
// package reads from its measurements (`shotSamples`, `steamSamples`), which
// the server's MCP tools read too.

import { type Sample, type Step, shadedPhaseChanges } from "@decent-sync/protocol";

export {
  type CurveInfo,
  SHOT_CURVES,
  STEAM_CURVES,
  type Sample,
  type ShadedSpan,
  type ShotCurve,
  type SteamCurve,
  type Step,
  profileStep,
  shadedSpans,
  shotSamples,
  steamSamples,
  steamStopAt,
} from "@decent-sync/protocol";

/**
 * The seconds at which a Shot's samples move from one step of its Profile to
 * another: each sample whose frame differs from the last one reported before
 * it, from the first sample after Preheat on, so none is at 0 s or in
 * Preheat. A step that ends between two samples, or lasts none, shows no
 * change of its own: one change marks the frame change the samples show.
 */
export function stepChanges(samples: Sample<string>[]): number[] {
  const changes: number[] = [];
  let frame: number | undefined;
  for (const sample of samples) {
    if (!sample.step) continue;
    if (frame !== undefined && sample.step.frame !== frame) changes.push(sample.seconds);
    frame = sample.step.frame;
  }
  return changes;
}

/**
 * The step of the last sample at or before `seconds`, which a change of step
 * starts at: null where it has none, and before the first sample or after the
 * last, as a chart reads past a Shot's end the longer Shot compared with it.
 */
export function stepAt(samples: Sample<string>[], seconds: number): Step | null {
  return sampleAt(samples, seconds)?.step ?? null;
}

/** The shaded phase of the last sample at or before `seconds`, read as `stepAt` reads a step. */
export function shadeAt(samples: Sample<string>[], seconds: number): string | null {
  return sampleAt(samples, seconds)?.shade ?? null;
}

function sampleAt<C extends string>(samples: Sample<C>[], seconds: number): Sample<C> | undefined {
  if (seconds > lastSecond(samples) + 1e-9) return undefined;
  let found: Sample<C> | undefined;
  for (const sample of samples) {
    if (sample.seconds > seconds + 1e-9) break;
    found = sample;
  }
  return found;
}

/** The seconds at which two of a Steam Record's shaded phases meet (`shadedPhaseChanges`); none for a Shot. */
export function phaseChanges(samples: Sample<string>[]): number[] {
  return shadedPhaseChanges(samples.flatMap(({ phase, seconds }) => (phase ? [{ phase, seconds }] : [])));
}

/** One point of a chart: each series' value at a time, or null where it has none. */
export interface ChartPoint {
  seconds: number;
  current: number | null;
  target: number | null;
  previous: number | null;
}

/**
 * The grid's points per chart, and the most samples read at their own times,
 * so a long tea shot's thousands of samples draw quickly. Samples around a
 * gap are always read, so a record with many gaps has more points.
 */
const MAX_POINTS = 600;

interface Series<C extends string> {
  samples: Sample<C>[];
  value(sample: Sample<C>): number | null;
}

/**
 * A curve of a record, its target, and the same curve of another record,
 * read at the same times (`chartTimes`) so a tooltip can name all three. Each
 * is interpolated between consecutive samples that both have a value, so a
 * line breaks where its samples have none, such as a target a step does
 * not set, and has no value past its last.
 */
export function chartPoints<C extends string>(curve: C, current: Sample<C>[], previous: Sample<C>[] | undefined, from: number, until: number): ChartPoint[] {
  const series: Series<C>[] = [
    { samples: current, value: (sample) => sample.values[curve] },
    { samples: current, value: (sample) => sample.targets[curve] },
    ...(previous ? [{ samples: previous, value: (sample: Sample<C>) => sample.values[curve] }] : []),
  ];
  const times = chartTimes(previous ? [current, previous] : [current], series, from, until);
  const [currents, targets, previouses] = series.map(({ samples, value }) => resample(samples, value, times));
  return times.map((seconds, n) => ({ seconds, current: currents![n]!, target: targets![n]!, previous: previouses?.[n] ?? null }));
}

/**
 * The times a chart reads its series at, rising. Every sample's when the
 * records have few enough; otherwise each record's first and last, and those
 * on both sides of wherever a series gains or loses a value, so no gap or
 * lone reading is lost. Between them, from `from` to `until`, which a Shot's
 * Preheat puts before 0 s, a grid every tenth of a second, or less
 * often for a long record, so sparse samples can be read between too; a grid
 * time closer than half a step to a sample's is left out.
 */
function chartTimes<C extends string>(records: Sample<C>[][], series: Series<C>[], from: number, until: number): number[] {
  const step = Math.max(0.1, Math.ceil(((until - from) / MAX_POINTS) * 10) / 10);
  const kept: number[] = [];
  if (records.reduce((count, samples) => count + samples.length, 0) <= MAX_POINTS) {
    for (const samples of records) for (const sample of samples) kept.push(sample.seconds);
  } else {
    for (const { samples, value } of series) {
      const has = samples.map((sample) => value(sample) !== null);
      samples.forEach((sample, n) => {
        if (n === 0 || n === samples.length - 1 || has[n] !== has[n - 1] || has[n] !== has[n + 1]) kept.push(sample.seconds);
      });
    }
  }
  kept.sort((a, b) => a - b);
  const times: number[] = [];
  let next = 0;
  for (let n = Math.ceil(from / step - 1e-9); n * step <= until + 1e-9; n++) {
    const grid = Math.round(n * step * 10) / 10;
    // Kept times before this grid time come first; the grid time only if none is within half a step.
    while (next < kept.length && kept[next]! < grid) times.push(kept[next++]!);
    const nearest = Math.min(Math.abs(grid - (times.at(-1) ?? -Infinity)), Math.abs((kept[next] ?? Infinity) - grid));
    if (nearest >= step / 2) times.push(grid);
  }
  while (next < kept.length) times.push(kept[next++]!);
  return times.filter((time, n) => n === 0 || time - times[n - 1]! > 1e-9);
}

/** When the samples end, in seconds. */
export function lastSecond(samples: { seconds: number }[]): number {
  return samples.at(-1)?.seconds ?? 0;
}

/** The steps a chart's time axis is marked at, in seconds. */
const TICK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];

/**
 * The times a chart's axis from `start` to `end` seconds is marked at: every
 * multiple of the smallest step that leaves at most seven marks between
 * them, so 0 s, where a Shot's profile starts after its Preheat, is always
 * one.
 */
export function secondTicks(start: number, end: number): number[] {
  const step = TICK_STEPS.find((candidate) => (end - start) / candidate <= 7) ?? TICK_STEPS.at(-1)!;
  const ticks: number[] = [];
  // Never -0, which Math.ceil gives for a start just before 0.
  for (let n = Math.ceil(start / step); n * step <= end; n++) ticks.push(n * step || 0);
  return ticks;
}

/** When the samples start, in seconds: before 0 s for a Shot's Preheat. */
export function firstSecond(samples: { seconds: number }[]): number {
  return Math.min(0, samples[0]?.seconds ?? 0);
}

/**
 * The values at rising times, rounded to hundredths: a sample's own at its
 * time, otherwise interpolated between the samples either side when both have
 * one. Null where either has none, and before the first or after the last.
 */
function resample<C extends string>(samples: Sample<C>[], value: (sample: Sample<C>) => number | null, times: number[]): (number | null)[] {
  let next = 0;
  return times.map((seconds) => {
    while (next < samples.length && samples[next]!.seconds < seconds - 1e-9) next++;
    const after = samples[next];
    if (!after) return null;
    const reading = value(after);
    if (after.seconds - seconds < 1e-9) return reading;
    const before = samples[next - 1];
    const from = before ? value(before) : null;
    if (from === null || reading === null) return null;
    const share = (seconds - before!.seconds) / (after.seconds - before!.seconds);
    return Math.round((from + (reading - from) * share) * 100) / 100;
  });
}
