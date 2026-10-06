// A Shot's curves, from its measurements as Decaid sent them: one sample per
// machine snapshot, with the scale's reading beside it. Any field may be
// missing; a sample without a time is left out.

/** The curves a Shot page draws, each with its unit. */
export const CURVES = {
  pressure: { label: "Pressure", unit: "bar" },
  flow: { label: "Flow", unit: "ml/s" },
  weight: { label: "Weight", unit: "g" },
  temperature: { label: "Temperature", unit: "°C" },
} as const;

export type Curve = keyof typeof CURVES;

/** One sample: seconds since the Shot's first, and each curve's value and target there. */
export interface Sample {
  seconds: number;
  values: Record<Curve, number | null>;
  targets: Record<Curve, number | null>;
}

/** Decaid takes a snapshot several times a second, so a longer gap between two is the tablet's clock changing. */
const CLOCK_CHANGE_MS = 60_000;
const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * The samples of a Shot's measurements, in the order Decaid recorded them.
 * Times are counted as the server counts a Shot's duration: the gaps between
 * consecutive samples added up, leaving out the whole quarter hours a
 * daylight-saving change adds or takes away, and counting for nothing a gap
 * left by any other change of the tablet's clock.
 */
export function shotSamples(measurements: unknown): Sample[] {
  if (!Array.isArray(measurements)) return [];
  const samples: Sample[] = [];
  let previous: number | undefined;
  let elapsed = 0;
  for (const measurement of measurements) {
    const machine = record(record(measurement)?.machine);
    const scale = record(record(measurement)?.scale);
    const at = time(machine?.timestamp);
    if (at === undefined) continue;
    if (previous !== undefined) {
      const gap = at - previous;
      const real = Math.abs(gap) <= CLOCK_CHANGE_MS ? gap : gap - Math.round(gap / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
      if (real >= 0 && real <= CLOCK_CHANGE_MS) elapsed += real;
    }
    previous = at;
    samples.push({
      seconds: elapsed / 1000,
      values: {
        pressure: number(machine?.pressure),
        flow: number(machine?.flow),
        weight: number(scale?.weight),
        temperature: number(machine?.mixTemperature),
      },
      // A target of zero is a frame that sets none, as a pressure frame's flow target.
      targets: {
        pressure: positive(machine?.targetPressure),
        flow: positive(machine?.targetFlow),
        weight: null,
        temperature: positive(machine?.targetMixTemperature),
      },
    });
  }
  return samples;
}

/** One point of a chart: each series' value at a time, or null where it has none. */
export interface ChartPoint {
  seconds: number;
  current: number | null;
  target: number | null;
  previous: number | null;
}

/** About this many points per chart, so a long tea shot's thousands of samples draw quickly. */
const MAX_POINTS = 600;

interface Series {
  samples: Sample[];
  value(sample: Sample): number | null;
}

/**
 * A curve of a Shot, its target, and the same curve of another Shot, read at
 * the same times (`chartTimes`) so a tooltip can name all three. Each is
 * interpolated between consecutive samples that both have a value, so a
 * line breaks where its samples have none, such as a target a step does
 * not set, and has no value past its last.
 */
export function chartPoints(curve: Curve, current: Sample[], previous: Sample[] | undefined, until: number): ChartPoint[] {
  const series: Series[] = [
    { samples: current, value: (sample) => sample.values[curve] },
    { samples: current, value: (sample) => sample.targets[curve] },
    ...(previous ? [{ samples: previous, value: (sample: Sample) => sample.values[curve] }] : []),
  ];
  const times = chartTimes(previous ? [current, previous] : [current], series, until);
  const [currents, targets, previouses] = series.map(({ samples, value }) => resample(samples, value, times));
  return times.map((seconds, n) => ({ seconds, current: currents![n]!, target: targets![n]!, previous: previouses?.[n] ?? null }));
}

/**
 * The times a chart reads its series at, rising. Every sample's when the
 * Shots have few enough; otherwise each Shot's first and last, and those on
 * both sides of wherever a series gains or loses a value, so no gap or lone
 * reading is lost. Between them, a grid every tenth of a second, or less
 * often for a long Shot, so sparse samples can be read between too; a grid
 * time closer than half a step to a sample's is left out.
 */
function chartTimes(shots: Sample[][], series: Series[], until: number): number[] {
  const step = Math.max(0.1, Math.ceil((until / MAX_POINTS) * 10) / 10);
  const kept: number[] = [];
  if (shots.reduce((count, samples) => count + samples.length, 0) <= MAX_POINTS) {
    for (const samples of shots) for (const sample of samples) kept.push(sample.seconds);
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
  for (let n = 0; n * step <= until + 1e-9; n++) {
    const grid = Math.round(n * step * 10) / 10;
    // Kept times before this grid time come first; the grid time only if none is within half a step.
    while (next < kept.length && kept[next]! < grid) times.push(kept[next++]!);
    const nearest = Math.min(Math.abs(grid - (times.at(-1) ?? -Infinity)), Math.abs((kept[next] ?? Infinity) - grid));
    if (nearest >= step / 2) times.push(grid);
  }
  while (next < kept.length) times.push(kept[next++]!);
  return times.filter((time, n) => n === 0 || time - times[n - 1]! > 1e-9);
}

/** How long the samples run, in seconds. */
export function lastSecond(samples: Sample[]): number {
  return samples.at(-1)?.seconds ?? 0;
}

/**
 * The values at rising times, rounded to hundredths: a sample's own at its
 * time, otherwise interpolated between the samples either side when both have
 * one. Null where either has none, and before the first or after the last.
 */
function resample(samples: Sample[], value: (sample: Sample) => number | null, times: number[]): (number | null)[] {
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

/** A time without an offset is the tablet's wall clock; read as UTC, its differences are still exact. */
function time(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
  const reading = number(value);
  return reading !== null && reading > 0 ? reading : null;
}
