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

/** At most this many points per chart, so a long tea shot's thousands of samples draw quickly. */
const MAX_POINTS = 600;

/**
 * A curve of a Shot, its target, and the same curve of another Shot, read at
 * the same times so a tooltip can name all three: every tenth of a second, or
 * less often for a long Shot, from the start to `until` seconds. Each is
 * interpolated between its samples and has no value past its last.
 */
export function chartPoints(curve: Curve, current: Sample[], previous: Sample[] | undefined, until: number): ChartPoint[] {
  const step = Math.max(0.1, Math.ceil((until / MAX_POINTS) * 10) / 10);
  const times: number[] = [];
  for (let n = 0; n * step <= until + 1e-9; n++) times.push(Math.round(n * step * 10) / 10);
  const currents = resample(current, (sample) => sample.values[curve], times);
  const targets = resample(current, (sample) => sample.targets[curve], times);
  const previouses = previous ? resample(previous, (sample) => sample.values[curve], times) : [];
  return times.map((seconds, n) => ({ seconds, current: currents[n]!, target: targets[n]!, previous: previouses[n] ?? null }));
}

/** How long the samples run, in seconds. */
export function lastSecond(samples: Sample[]): number {
  return samples.at(-1)?.seconds ?? 0;
}

/**
 * The values at rising times, each interpolated between the samples around
 * it that have one, rounded to hundredths; null before the first or after the last.
 */
function resample(samples: Sample[], value: (sample: Sample) => number | null, times: number[]): (number | null)[] {
  const readings = samples.flatMap((sample) => {
    const reading = value(sample);
    return reading === null ? [] : [{ seconds: sample.seconds, reading }];
  });
  let next = 0;
  return times.map((seconds) => {
    while (next < readings.length && readings[next]!.seconds < seconds - 1e-9) next++;
    const after = readings[next];
    if (!after) return null;
    if (after.seconds - seconds < 1e-9) return after.reading;
    const before = readings[next - 1];
    if (!before) return null;
    const share = (seconds - before.seconds) / (after.seconds - before.seconds);
    return Math.round((before.reading + (after.reading - before.reading) * share) * 100) / 100;
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
