// A record's curves, from its measurements as Decaid sent them: one sample
// per machine snapshot, with what Decaid recorded beside it, such as a Shot's
// scale reading or a Steam Record's milk temperature. Any field may be
// missing; a sample without a time is left out.

import { STEAM_PHASE_NAMES, type SteamPhase, isShadedPhase, shadedPhaseChanges, steamPhases } from "@decent-sync/protocol";

/** One curve a record's page draws, in its own chart. */
export interface CurveInfo {
  label: string;
  unit: string;
  /** Its axis fits its readings, as a temperature far from zero needs; otherwise the axis starts at zero. */
  fit?: boolean;
}

/** The curves a Shot page draws. */
export const SHOT_CURVES = {
  pressure: { label: "Pressure", unit: "bar" },
  flow: { label: "Flow", unit: "ml/s" },
  weight: { label: "Weight", unit: "g" },
  temperature: { label: "Temperature", unit: "°C", fit: true },
} as const satisfies Record<string, CurveInfo>;

/** The curves a Steam Record page draws. */
export const STEAM_CURVES = {
  milkTemperature: { label: "Milk temperature", unit: "°C" },
  steamTemperature: { label: "Steam temperature", unit: "°C", fit: true },
  pressure: { label: "Pressure", unit: "bar" },
  flow: { label: "Flow", unit: "ml/s" },
} as const satisfies Record<string, CurveInfo>;

export type ShotCurve = keyof typeof SHOT_CURVES;
export type SteamCurve = keyof typeof STEAM_CURVES;

/**
 * One sample: its seconds, and each curve's value and target there. A Shot's
 * count from the first sample after its Preheat, and a Steam Record's from
 * the first after its lead-in, whose samples are at negative seconds.
 */
export interface Sample<C extends string> {
  seconds: number;
  /**
   * The shaded phase it is in, by name, which its record's duration leaves
   * out: a Shot's Preheat, the Machine heating its water before the profile
   * starts, or a Steam Record's Preparing, Paused, Puffing or Purge. Null in
   * the time the duration counts.
   */
  shade: string | null;
  values: Record<C, number | null>;
  targets: Record<C, number | null>;
  /** A Shot's: the Profile step its Machine was running, null in Preheat or where it reported none. */
  step?: Step | null;
  /** A Steam Record's: its phase (`steamPhases`). */
  phase?: SteamPhase;
}

/** A step of a Shot's Profile: its index among the Profile's steps, and its name. */
export interface Step {
  frame: number;
  name: string;
}

/** Decaid takes a snapshot several times a second, so a longer gap between two is the tablet's clock changing. */
const CLOCK_CHANGE_MS = 60_000;
const QUARTER_HOUR_MS = 15 * 60_000;

/**
 * A Shot's samples: the machine's pressure, flow and group temperature, the
 * scale's weight, and the targets it reported. The group temperature, in °C,
 * is measured at the group head, the closest to the coffee, and its target is
 * the profile's temperature, as Streamline draws them. The mix temperature is
 * left out: where the profile measures at the coffee, its target is the
 * firmware's control output, which swings around. Its Preheat is its leading
 * samples whose substate is `preparingForShot`, as the server reads it
 * (`extractCurves`), with the heater test's targets, before the profile's.
 * Each sample after Preheat names the step of `profile`, the Shot's Workflow's,
 * that its `profileFrame` indexes, as Streamline names it; in Preheat the
 * frame is left over from before the Shot.
 */
export function shotSamples(measurements: unknown, profile?: unknown): Sample<ShotCurve>[] {
  const steps = record(profile)?.steps;
  return timedSamples(measurements, (machine) => record(machine?.state)?.substate === "preparingForShot", (_, machine, scale, preheat) => ({
    shade: preheat ? "Preheat" : null,
    step: preheat ? null : profileStep(machine?.profileFrame, Array.isArray(steps) ? steps : []),
    values: {
      pressure: number(machine?.pressure),
      flow: number(machine?.flow),
      weight: number(scale?.weight),
      temperature: number(machine?.groupTemperature),
    },
    // A target of zero is a frame that sets none, as a pressure frame's flow target.
    targets: {
      pressure: positive(machine?.targetPressure),
      flow: positive(machine?.targetFlow),
      weight: null,
      temperature: positive(machine?.targetGroupTemperature),
    },
  }));
}

/**
 * A Steam Record's samples: the milk temperature its probe last reported,
 * null before any reading or with no probe, the steam heater's temperature,
 * and the steam's pressure and flow, with the targets the machine reported
 * and `stopAt`, the milk temperature its Workflow stops steaming at, if any.
 * Each names its phase (`steamPhases`), and its lead-in, its leading
 * Preparing samples, comes before 0 s, as a Shot's Preheat does.
 */
export function steamSamples(measurements: unknown, stopAt: number | null): Sample<SteamCurve>[] {
  const phases = steamPhases(measurements);
  return timedSamples(measurements, (_, n) => phases[n] === "preparing", (measurement, machine, _scale, _lead, n) => ({
    shade: isShadedPhase(phases[n]!) ? STEAM_PHASE_NAMES[phases[n]!] : null,
    phase: phases[n]!,
    values: {
      milkTemperature: number(measurement.milkTemperature),
      steamTemperature: number(machine?.steamTemperature),
      pressure: number(machine?.pressure),
      flow: number(machine?.flow),
    },
    targets: {
      milkTemperature: stopAt,
      steamTemperature: null,
      pressure: positive(machine?.targetPressure),
      flow: positive(machine?.targetFlow),
    },
  }));
}

/**
 * The samples of a record's measurements, in the order Decaid recorded them,
 * each read by `read` from the measurement, its index, and its machine
 * snapshot and scale reading. Its leading samples that `leading` picks out,
 * such as a Shot's Preheat, come before 0 s, which is the first sample after
 * them, or a millisecond after the last if none follows, as when a Shot is
 * stopped before its profile starts. Times are counted as the server
 * counts a record's duration: the gaps between consecutive samples added up,
 * leaving out the whole quarter hours a daylight-saving change adds or takes
 * away, and counting for nothing a gap left by any other change of the
 * tablet's clock. Each sample is still a millisecond after the one before, so
 * samples a clock change would put at one time stay apart, and a gap among
 * them is kept.
 */
function timedSamples<C extends string>(
  measurements: unknown,
  leading: (machine: Record<string, unknown> | undefined, index: number) => boolean,
  read: (
    measurement: Record<string, unknown>,
    machine: Record<string, unknown> | undefined,
    scale: Record<string, unknown> | undefined,
    lead: boolean,
    index: number,
  ) => Omit<Sample<C>, "seconds">,
): Sample<C>[] {
  if (!Array.isArray(measurements)) return [];
  const timed: { elapsed: number; sample: Omit<Sample<C>, "seconds"> }[] = [];
  let previous: number | undefined;
  let elapsed = 0;
  let lead = true;
  let zero: number | undefined;
  for (const [index, measurement] of measurements.entries()) {
    const fields = record(measurement);
    const machine = record(fields?.machine);
    // A sample without a time still ends what leads, as it does on the server.
    if (lead && !leading(machine, index)) lead = false;
    const at = time(machine?.timestamp);
    if (!fields || at === undefined) continue;
    if (previous !== undefined) {
      const gap = at - previous;
      const real = Math.abs(gap) <= CLOCK_CHANGE_MS ? gap : gap - Math.round(gap / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
      elapsed += real >= 0 && real <= CLOCK_CHANGE_MS ? Math.max(real, 1) : 1;
    }
    previous = at;
    if (!lead) zero ??= elapsed;
    timed.push({ elapsed, sample: read(fields, machine, record(fields.scale), lead, index) });
  }
  const start = zero ?? elapsed + 1;
  return timed.map(({ elapsed, sample }) => ({ seconds: (elapsed - start) / 1000, ...sample }));
}

/**
 * The step a `profileFrame` indexes among a Profile's steps, by its name, or
 * "Step N", counting from 1, for a step with none or a frame past the last.
 */
export function profileStep(frame: unknown, steps: unknown[]): Step | null {
  if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 0) return null;
  const name = record(steps[frame])?.name;
  return { frame, name: typeof name === "string" && name.trim() !== "" ? name.trim() : `Step ${frame + 1}` };
}

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

/** A stretch of a record in one shaded phase, from its first sample to the sample after its last. */
export interface ShadedSpan {
  name: string;
  from: number;
  until: number;
}

/**
 * Each run of samples in one shaded phase, from its first sample to the next
 * sample after it, which starts what follows, or to its last if none
 * follows.
 */
export function shadedSpans(samples: Sample<string>[]): ShadedSpan[] {
  const spans: ShadedSpan[] = [];
  samples.forEach((sample, n) => {
    if (sample.shade === null) return;
    const until = samples[n + 1]?.seconds ?? sample.seconds;
    if (samples[n - 1]?.shade === sample.shade) spans.at(-1)!.until = until;
    else spans.push({ name: sample.shade, from: sample.seconds, until });
  });
  return spans;
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
