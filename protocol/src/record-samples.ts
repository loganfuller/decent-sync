// A Shot's or Steam Record's samples, from its measurements as Decaid sent
// them: one per machine snapshot, with what Decaid recorded beside it, such
// as a Shot's scale reading or a Steam Record's milk temperature. Defined
// once for the management interface, which draws them, and the server, whose
// MCP tools give them to assistants (#408), so both time them and mark their
// shaded phases alike. Any field may be missing; a sample without a time is
// left out.

import type { Profile, ProfileStep } from "./profile.js";
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
  weightFlow: { label: "Weight flow", unit: "g/s" },
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
  /** A Shot's: its Machine's substate, as Decaid names it, such as `preinfusion` or `pouring`; null where it reported none. */
  substate?: string | null;
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
 * scale's weight and its weight flow, the rate coffee lands in the cup in
 * g/s, which Decaid records with each weight, and the targets the machine
 * reported, none of them the scale's. The group temperature, in °C, is
 * measured at the group head, the closest to the coffee, and its target is
 * the profile's temperature, as Streamline draws them. The mix temperature is
 * left out: where the profile measures at the coffee, its target is the
 * firmware's control output, which swings around. Its Preheat is its leading
 * samples whose substate is `preparingForShot`, as the server reads it
 * (`extractCurves`), with the heater test's targets, before the profile's.
 * Each sample after Preheat names the step of `profile`, the Shot's Workflow's,
 * that its `profileFrame` indexes, as Streamline names it; in Preheat the
 * frame is left over from before the Shot.
 */
export function shotSamples(measurements: unknown, profile: Profile | null = null): Sample<ShotCurve>[] {
  const steps = profile?.steps ?? [];
  return timedSamples(measurements, (machine) => record(machine?.state)?.substate === "preparingForShot", (_, machine, scale, preheat) => ({
    shade: preheat ? "Preheat" : null,
    step: preheat ? null : profileStep(machine?.profileFrame, steps),
    substate: text(record(machine?.state)?.substate),
    values: {
      pressure: number(machine?.pressure),
      flow: number(machine?.flow),
      weight: number(scale?.weight),
      weightFlow: number(scale?.weightFlow),
      temperature: number(machine?.groupTemperature),
    },
    // A target of zero is a frame that sets none, as a pressure frame's flow target.
    targets: {
      pressure: positive(machine?.targetPressure),
      flow: positive(machine?.targetFlow),
      weight: null,
      weightFlow: null,
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
export function profileStep(frame: unknown, steps: readonly ProfileStep[]): Step | null {
  if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 0) return null;
  const name = steps[frame]?.name.trim();
  return { frame, name: name ? name : `Step ${frame + 1}` };
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
 * The scale's last weight a Shot's samples (`shotSamples`) recorded after
 * its Preheat, in grams, and its seconds; null where none did. Decaid records
 * no sample after a Shot's stop, so it is the weight just before the stop, or
 * earlier where the scale dropped out, from when Decaid records no reading. In
 * Preheat it records 0 for the scale until it tares it as the profile starts
 * (`ShotSequencer._processSnapshot` in decaid), or, in full gateway mode,
 * where it never tares, the untared reading, so no reading there is the
 * Shot's weight.
 */
export function lastRecordedWeight(samples: readonly Sample<ShotCurve>[]): { weight: number; seconds: number } | null {
  const last = lastWeighed(samples);
  return last && { weight: last.values.weight!, seconds: last.seconds };
}

/**
 * A Shot's flow at the stop: the scale's weight flow, in g/s, at its last
 * weight its samples (`shotSamples`) recorded after its Preheat
 * (`lastRecordedWeight`), so just before the stop, or earlier where the
 * scale dropped out; null where there is no such reading, or it recorded no
 * weight flow.
 */
export function flowAtStop(samples: readonly Sample<ShotCurve>[]): number | null {
  return lastWeighed(samples)?.values.weightFlow ?? null;
}

/** The last of a Shot's samples after its Preheat at which the scale recorded a weight. */
function lastWeighed(samples: readonly Sample<ShotCurve>[]): Sample<ShotCurve> | null {
  for (let n = samples.length - 1; n >= 0; n--) {
    const sample = samples[n]!;
    if (sample.shade === null && sample.values.weight !== null) return sample;
  }
  return null;
}

/**
 * The weight, in grams, a Shot's scale must reach for coffee to be in its
 * cup: a reading under it may come and go, as a knock on the scale does, and
 * a Shot whose scale never reads it has no first drip.
 */
export const IN_THE_CUP_GRAMS = 1;

/**
 * The least reading, in grams, that is a Shot's first drip, within a rise to
 * IN_THE_CUP_GRAMS: two counts of a scale that reads to 0.1 g, as one count
 * comes and goes.
 */
export const FIRST_DRIP_GRAMS = 0.2;

/** The seconds from the start of a Shot's profile within which the tare Decaid sends then lands. */
const TARE_LANDS = 2;

/**
 * A Shot's time to first drip: when its coffee first reached the cup, as
 * nearly as its scale shows it, in seconds from the start of its profile;
 * null where its scale never read IN_THE_CUP_GRAMS, as on a Shot with no
 * scale. It is read from its samples (`shotSamples`) after its Preheat,
 * passing over a sample with no scale reading, as no reading in Preheat is
 * the Shot's weight (`lastRecordedWeight`):
 *
 * 1. A cup weighed before Decaid's tare landed is left out: Decaid tares the
 *    scale at the profile's first sample without waiting for it, so a
 *    reading of IN_THE_CUP_GRAMS or more within TARE_LANDS after which the
 *    scale reads under it there is the cup's, and is passed over to that
 *    lower reading. A cup on the scale throughout, in full gateway mode,
 *    where Decaid never tares, reads as it was recorded.
 * 2. The rise is the scale's first reading of IN_THE_CUP_GRAMS or more.
 * 3. From it, back to the scale's last reading of zero or less, or to the
 *    first reading where there is none.
 * 4. The first drip is the first reading of FIRST_DRIP_GRAMS or more from
 *    there, so a reading that returns to zero before the rise is never it.
 *
 * One rule wherever a time to first drip is worked out: a stored Shot's, a
 * simulated run's (`simulateProfile`) and a Shot's puck (`shotPuck`).
 */
export function timeToFirstDrip(samples: readonly Sample<ShotCurve>[]): number | null {
  const weighed = samples.filter((sample) => sample.shade === null && sample.values.weight !== null);
  const weightAt = (n: number) => weighed[n]!.values.weight!;
  const from = tareLanded(weighed);
  let rise = from;
  while (rise < weighed.length && weightAt(rise) < IN_THE_CUP_GRAMS) rise++;
  if (rise === weighed.length) return null;
  let start = rise;
  while (start > from && weightAt(start) > 0) start--;
  while (weightAt(start) < FIRST_DRIP_GRAMS) start++;
  return weighed[start]!.seconds;
}

/**
 * The index among a Shot's scale readings after its Preheat of the first
 * after the tare Decaid sends at the profile's start: 0, or past a cup's
 * weight read before the tare landed, the last reading under
 * IN_THE_CUP_GRAMS within TARE_LANDS that follows one of it or more.
 */
function tareLanded(weighed: readonly Sample<ShotCurve>[]): number {
  let cup = false;
  let landed = 0;
  for (let n = 0; n < weighed.length && weighed[n]!.seconds <= TARE_LANDS; n++) {
    if (weighed[n]!.values.weight! >= IN_THE_CUP_GRAMS) cup = true;
    else if (cup) landed = n;
  }
  return landed;
}

/**
 * Whether a Shot poured: one of its samples (`shotSamples`) is in the
 * `pouring` substate, which the Machine reports once its profile is past the
 * steps it counts as preinfusion. It is what the Machine reported, whatever
 * landed in the cup: a Shot stopped on weight within those steps didn't pour
 * by it, though it ran whole. So an Unfinished Shot is one that didn't, and
 * has no time to first drip either (`timeToFirstDrip`).
 */
export function poured(samples: readonly Sample<ShotCurve>[]): boolean {
  return samples.some((sample) => sample.substate === "pouring");
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

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function positive(value: unknown): number | null {
  const reading = number(value);
  return reading !== null && reading > 0 ? reading : null;
}
