// A Shot's or Steam Record's samples, from its measurements as Decaid sent
// them: one per machine snapshot, with what Decaid recorded beside it, such
// as a Shot's scale reading or a Steam Record's milk temperature. Defined
// once for the management interface, which draws them, and the server, whose
// MCP tools give them to assistants (#408), so both time them and mark their
// shaded phases alike. Any field may be missing; a sample without a time is
// left out.

import { STEAM_PHASE_NAMES, type SteamPhase, isShadedPhase, steamPhases } from "./steam-phases.js";

/** One curve of a record, as the management interface draws it in its own chart. */
export interface CurveInfo {
  label: string;
  unit: string;
  /** Its axis fits its readings, as a temperature far from zero needs; otherwise the axis starts at zero. */
  fit?: boolean;
}

/** A Shot's curves. */
export const SHOT_CURVES = {
  pressure: { label: "Pressure", unit: "bar" },
  flow: { label: "Flow", unit: "ml/s" },
  weight: { label: "Weight", unit: "g" },
  temperature: { label: "Temperature", unit: "°C", fit: true },
} as const satisfies Record<string, CurveInfo>;

/** A Steam Record's curves. */
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
/** A quarter hour, written out, so the plugin's bundle, which reads none of this module, leaves it out too. */
const QUARTER_HOUR_MS = 900_000;

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
 * The milk temperature a Steam Record's Workflow stops steaming at, from the
 * record as Decaid sent it, or null where it set none or turned it off (0).
 */
export function steamStopAt(steamRecord: unknown): number | null {
  const stopAt = record(record(record(steamRecord)?.workflow)?.steamSettings)?.stopAtTemperature;
  return typeof stopAt === "number" && stopAt > 0 ? stopAt : null;
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

/** A step a Shot ran, from its first sample's seconds to the next step's first sample's, or to the Shot's last sample. */
export interface StepSpan extends Step {
  from: number;
  until: number;
}

/**
 * The steps of its Profile a Shot's samples (`shotSamples`) show it ran, in
 * order: each run of samples after its Preheat at one frame, from its first
 * sample to the first sample of the next, and the last to the Shot's last
 * sample. A sample that reports no frame neither starts nor ends one. A step
 * that ends between two samples, or lasts none, is not among them: the next
 * step the samples show starts where they show it. None for a Shot stopped
 * in its Preheat.
 */
export function stepSpans(samples: readonly Sample<string>[]): StepSpan[] {
  const spans: StepSpan[] = [];
  for (const { step, seconds } of samples) {
    if (!step) continue;
    const current = spans[spans.length - 1];
    if (current?.frame === step.frame) continue;
    if (current) current.until = seconds;
    spans.push({ ...step, from: seconds, until: seconds });
  }
  const last = spans[spans.length - 1];
  if (last) last.until = samples[samples.length - 1]!.seconds;
  return spans;
}

/**
 * The scale's last weight a Shot's samples (`shotSamples`) recorded, in
 * grams, and its seconds; null where none recorded one. Decaid records no
 * sample after a Shot's stop, so it is the weight just before the stop.
 */
export function lastRecordedWeight(samples: readonly Sample<ShotCurve>[]): { weight: number; seconds: number } | null {
  for (let n = samples.length - 1; n >= 0; n--) {
    const { values, seconds } = samples[n]!;
    if (values.weight !== null) return { weight: values.weight, seconds };
  }
  return null;
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
export function shadedSpans(samples: readonly Sample<string>[]): ShadedSpan[] {
  const spans: ShadedSpan[] = [];
  samples.forEach((sample, n) => {
    if (sample.shade === null) return;
    const until = samples[n + 1]?.seconds ?? sample.seconds;
    if (samples[n - 1]?.shade === sample.shade) spans[spans.length - 1]!.until = until;
    else spans.push({ name: sample.shade, from: sample.seconds, until });
  });
  return spans;
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
