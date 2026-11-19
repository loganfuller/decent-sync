// The simulation of a profile on a puck (#577, ADR-0032): a run of what a
// Machine of a model would do with it, for the management interface to draw
// as the person edits and the server to answer through the REST API and the
// MCP tools. The same code runs in both.
//
// The machine follows what recorded Shots and Decaid's sources show. Decaid's
// simulated machine (`MockDe1` in
// decaid:lib/src/models/device/impl/mock_de1/mock_de1.dart, v0.9.2) is where
// its dynamics start: a pump controlling pressure or flow, the other capped by
// the step's limiter, eased over its range as `_applyLimiter` eases it, and
// exits read from what the machine measures. Unlike it, a step that gets to
// its target over the whole step ramps from what was measured as it began,
// not from the target of the step before, as recorded Shots show, and the
// puck is a resistance through the water pumped, with water held in the group
// as pressure builds, rather than a curve through time.
//
// Temperature is not simulated: a run's samples carry the plan's temperature
// as their target, and no temperature of their own.
//
// Pure: no Node or browser API, as the plugin bundles this package.

import { MODEL_FIGURES, type MachineModel } from "./machine-models.js";
import { PROFILE_LIMITS, type Profile, type ProfileStep, type StepLimiter, stepTarget } from "./profile.js";
import { type Sample, type ShotCurve, type StepSpan, FIRST_DRIP_GRAMS, lastRecordedWeight, stepSpans, timeToFirstDrip } from "./record-samples.js";

// The machine ------------------------------------------------------------------

/** The simulation's tick, s: how often its machine reads and acts, about the DE1's control tick, and its runs' sample interval. */
export const SIMULATION_TICK = 0.1;

/**
 * The water the group holds for each bar of pressure, ml/bar: the give in the
 * group and the air above the puck, which fill as pressure builds and drain
 * through the puck as it falls, so pressure falls over seconds, not at once,
 * when the pump stops.
 */
export const GROUP_COMPLIANCE = 0.5;

/**
 * How quickly the pump brings pressure to a target: the time constant, s.
 * Recorded Shots show the DE1 in no hurry, its pump giving little more than
 * holds the pressure as it climbs to a target.
 */
const PRESSURE_RESPONSE = 2;

/**
 * A step's time as the machine runs it, as Decaid sends it in one byte
 * (`convert_float_to_F8_1_7` in
 * decaid:lib/src/models/device/impl/de1/unified_de1/unified_de1.profile.dart,
 * v0.9.2): rounded to a tenth of a second below 12.75 s, so under 0.05 s is
 * none, and to a whole second from there, up to 127 s (PROFILE_LIMITS), so a
 * run is bounded by its steps however long a stored profile says one is.
 */
export function stepSeconds(step: ProfileStep): number {
  const seconds = step.seconds;
  if (!(seconds > 0)) return 0;
  if (seconds >= 12.75) return Math.min(PROFILE_LIMITS.seconds.max, Math.trunc(0.5 + seconds));
  return Math.trunc(0.5 + seconds * 10) / 10;
}

/**
 * The water a step may pump as the machine runs it, ml: Decaid sends it as a
 * whole number of ml, cut down, in ten bits (`convert_float_to_U10P0`, as
 * above), so 1.9 ml runs as 1, and 1025, past PROFILE_LIMITS, as 1.
 */
function stepVolume(step: ProfileStep): number {
  return step.volume > 0 ? Math.trunc(step.volume) & 1023 : 0;
}

/**
 * A step as Decaid sends it to a Machine of the model, which is what the
 * machine runs: its time (`stepSeconds`) and water (`stepVolume`), and its
 * target, exit and limiter each in one byte of the model's parts of a unit
 * (`ModelFigures.wireScale`), rounded, so a flow of 0.02 ml/s runs on a DE1
 * as none, and its temperature in half degrees.
 */
export function sentStep(step: ProfileStep, model: MachineModel = "DE1"): ProfileStep {
  const scale = MODEL_FIGURES[model].wireScale;
  const sent = (value: number) => (Math.trunc(0.5 + value * scale) & 255) / scale;
  const target = sent(stepTarget(step));
  return {
    ...step,
    // In half degrees, to either model.
    temperature: (Math.trunc(0.5 + step.temperature * 2) & 255) / 2,
    ...(step.pump === "pressure" ? { pressure: target } : { flow: target }),
    seconds: stepSeconds(step),
    volume: stepVolume(step),
    exit: step.exit ? { ...step.exit, value: sent(step.exit.value) } : null,
    limiter: step.limiter ? { value: sent(step.limiter.value), range: sent(step.limiter.range) } : null,
  } as ProfileStep;
}

/** The least resistance a puck has, where water fills the space above it and meets none. */
const LEAST_RESISTANCE = 0.001;

// The puck ---------------------------------------------------------------------

/**
 * A puck: its resistance through the Shot, as the pressure it takes for a
 * flow through it, in bar per (ml/s)², at each volume of water pumped, and
 * the water it takes before coffee drips into the cup.
 */
export interface Puck {
  /**
   * [water pumped, ml; resistance, bar/(ml/s)²], in order of the water
   * pumped: the resistance between two is read along the line between them,
   * and beyond the last it stays the last's.
   */
  resistance: ReadonlyArray<readonly [number, number]>;
  /** The water the group and the puck take before coffee drips, ml: the space above the puck and what the coffee soaks up. */
  holds: number;
  /** Grams in the cup for each ml through the puck once it drips. */
  yieldPerMl: number;
  /** The dose it is of, g. Simulated with another dose, its resistance and the water it soaks up are scaled to it. */
  dose: number;
  /** For a Shot's puck, the volume of water pumped beyond which the Shot measured nothing, ml; its resistance stays the last measured. */
  measuredTo?: number;
}

/** The dose the standard puck is of, g. */
export const STANDARD_DOSE = 18;

/** The water ground coffee soaks up, ml for each gram. */
const SOAKED_PER_GRAM = 1.1;

/**
 * The water the space above the standard puck and the group take before the
 * coffee soaks any up, ml, as recorded Shots on a DE1 show from the start of
 * their profile: their first drip comes after 34 to 44 ml.
 */
const STANDARD_HEADSPACE = 18;

/** The standard puck's resistance at its peak, at a medium grind: about 2 ml/s at 9 bar. */
const STANDARD_PEAK = 2.2;

/** Each end of the grind takes this many times the middle's resistance, or a part of it. */
const GRIND_RANGE = 4;

/**
 * The standard puck's resistance, as a part of its peak, against the water
 * pumped beyond what it holds before its first drip, ml: little while the
 * water fills the space above it, rising steeply as the coffee soaks through
 * to a peak about 13 ml after the first drip, then easing as the puck
 * erodes, as recorded Shots on a DE1 show.
 */
const STANDARD_CURVE: ReadonlyArray<readonly [number, number]> = [
  [-20, 0.02],
  [-10, 0.05],
  [-5, 0.07],
  [0, 0.12],
  [3, 0.2],
  [6, 0.32],
  [10, 0.85],
  [13, 1],
  [20, 0.75],
  [30, 0.55],
  [40, 0.48],
  [50, 0.45],
  [70, 0.42],
];

/**
 * The standard puck: a fixed resistance through the Shot, for 18 g of coffee,
 * scaled by `grind`, from -1, the finest, to 1, the coarsest, where 0 is a
 * medium grind and each end takes four times its resistance or a quarter of
 * it, so half or twice its flow at one pressure.
 */
export function standardPuck(grind = 0): Puck {
  const scale = GRIND_RANGE ** -Math.min(1, Math.max(-1, grind));
  const holds = STANDARD_HEADSPACE + SOAKED_PER_GRAM * STANDARD_DOSE;
  const resistance: Array<[number, number]> = [[0, LEAST_RESISTANCE]];
  for (const [beyond, part] of STANDARD_CURVE) resistance.push([holds + beyond, STANDARD_PEAK * scale * part]);
  return { resistance, holds, yieldPerMl: 1, dose: STANDARD_DOSE };
}

/** A puck's resistance at a volume of water pumped, found by halving, as a Shot's puck has a point for each of its samples. */
function resistanceAt(points: Puck["resistance"], volume: number): number {
  if (points.length === 0) return LEAST_RESISTANCE;
  if (volume <= points[0]![0]) return points[0]![1];
  if (volume > points[points.length - 1]![0]) return points[points.length - 1]![1];
  // The first point at or beyond the volume.
  let low = 1;
  let high = points.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle]![0] < volume) low = middle + 1;
    else high = middle;
  }
  const [v0, r0] = points[low - 1]!;
  const [v1, r1] = points[low]!;
  return v1 === v0 ? r1 : r0 + ((r1 - r0) * (volume - v0)) / (v1 - v0);
}

/** The least pressure and flow through the puck at which a Shot's sample shows its resistance. */
const MEASURABLE_PRESSURE = 0.3;
const MEASURABLE_FLOW = 0.3;

/**
 * A Shot's puck, worked out from its samples (`shotSamples`) after its
 * Preheat: its resistance at each sample from its pressure and the flow
 * through the puck, which is the pump's flow less what went to fill the
 * group as pressure rose (GROUP_COMPLIANCE), against the water pumped by
 * then; the water it took before the first drip (`timeToFirstDrip`); and
 * the grams that reached the cup for each ml through it after that. A Shot
 * with no scale takes what the standard puck holds and yields. `dose` is
 * the Shot's, where it recorded one. Null where no sample shows the puck's
 * resistance, as where the Shot recorded no flow or its pump never ran
 * against pressure.
 */
export function shotPuck(samples: readonly Sample<ShotCurve>[], dose: number | null = null): Puck | null {
  const shot = samples.filter((sample) => sample.shade === null);
  const doseOf = dose !== null && dose > 0 ? dose : STANDARD_DOSE;
  const standardHolds = STANDARD_HEADSPACE + SOAKED_PER_GRAM * doseOf;
  const seconds = shot.map((sample) => sample.seconds);
  const pressure = shot.map((sample) => Math.max(0, sample.values.pressure ?? 0));
  const flow = shot.map((sample) => Math.max(0, sample.values.flow ?? 0));
  const pumped = [0];
  for (let n = 1; n < shot.length; n++) pumped.push(pumped[n - 1]! + ((flow[n - 1]! + flow[n]!) / 2) * (seconds[n]! - seconds[n - 1]!));
  // The water through the puck by each sample: what was pumped, less what pressure holds in the group.
  const through = pumped.map((volume, n) => volume - GROUP_COMPLIANCE * pressure[n]!);
  const points: Array<[number, number]> = [];
  let filling = true;
  for (let n = 0; n < shot.length; n++) {
    const before = Math.max(0, n - 1);
    const after = Math.min(shot.length - 1, n + 1);
    const span = seconds[after]! - seconds[before]!;
    const rising = span > 0 ? (pressure[after]! - pressure[before]!) / span : 0;
    const puckFlow = flow[n]! - GROUP_COMPLIANCE * rising;
    // While the pump rests, as through a soak, the group drains through the puck at a rate its resistance
    // under flow doesn't describe, so those samples are left out and the resistance there read from either side.
    if (pressure[n]! < MEASURABLE_PRESSURE || puckFlow < MEASURABLE_FLOW || flow[n]! < MEASURABLE_FLOW) {
      // Before pressure first builds, water fills the space above the puck and meets no resistance.
      if (filling) points.splice(0, points.length, [pumped[n]!, LEAST_RESISTANCE]);
      continue;
    }
    if (filling) {
      // The fill's point of least resistance, where it comes before this, the first measured.
      if (points.length === 0) points.push([0, LEAST_RESISTANCE]);
      if (points[0]![0] >= pumped[n]! - 1e-9) points.pop();
    }
    filling = false;
    points.push([pumped[n]!, pressure[n]! / (puckFlow * puckFlow)]);
  }
  if (filling) return null;
  const resistance = monotoneInVolume(smoothed(points));
  const firstDrip = timeToFirstDrip(shot.slice(tareLanded(shot)));
  const last = lastRecordedWeight(shot);
  let holds = standardHolds;
  let yieldPerMl = 1;
  if (firstDrip !== null) {
    const at = shot.findIndex((sample) => sample.seconds === firstDrip);
    const lastAt = last ? shot.findIndex((sample) => sample.seconds === last.seconds) : -1;
    const firstWeight = shot[at]!.values.weight!;
    if (last && lastAt > at && through[lastAt]! - through[at]! > 5) {
      yieldPerMl = Math.min(1.5, Math.max(0.5, (last.weight - firstWeight) / (through[lastAt]! - through[at]!)));
    }
    holds = Math.max(0, through[at]! - firstWeight / yieldPerMl);
  }
  return { resistance, holds, yieldPerMl, dose: doseOf, measuredTo: pumped[pumped.length - 1]! };
}

/** The seconds from the start of its profile within which the tare Decaid sends then lands. */
const TARE_LANDS = 2;

/**
 * The index of a Shot's first sample (`shotSamples`, after its Preheat) its
 * scale read after the tare Decaid sends at the profile's start: past a cup's
 * weight read before it landed, where the scale then reads under a gram
 * within TARE_LANDS, as `timeToFirstDrip` counts that weight as recorded.
 */
function tareLanded(shot: readonly Sample<ShotCurve>[]): number {
  let weighed = false;
  let landed = 0;
  for (let n = 0; n < shot.length && shot[n]!.seconds <= TARE_LANDS; n++) {
    const weight = shot[n]!.values.weight;
    if (weight === null) continue;
    if (weight >= FIRST_DRIP_GRAMS) weighed = true;
    else if (weighed) landed = n;
  }
  return landed;
}

/** Each resistance the median of it and its neighbours, two either side, which takes out a sample's spike. */
function smoothed(points: Array<[number, number]>): Array<[number, number]> {
  return points.map(([volume, resistance], n) => {
    if (resistance === LEAST_RESISTANCE) return [volume, resistance];
    const near = points.slice(Math.max(0, n - 2), n + 3).filter(([, r]) => r !== LEAST_RESISTANCE).map(([, r]) => r).sort((a, b) => a - b);
    return [volume, near[Math.floor(near.length / 2)] ?? resistance];
  });
}

/** Points whose volumes only rise: those at one volume, as while the pump rests, are taken as their mean. */
function monotoneInVolume(points: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const [volume, resistance] of points) {
    const last = out[out.length - 1];
    if (last && volume <= last[0] + 1e-9) {
      last[1] = (last[1] * last[2] + resistance) / (last[2] + 1);
      last[2] += 1;
    } else out.push([volume, resistance, 1]);
  }
  return out.map(([volume, resistance]) => [volume, resistance]);
}

/**
 * A puck scaled to another dose: its resistance in proportion, as the bed is
 * deeper, and the water the coffee soaks up with it, the resistance before
 * the first drip stretched over the water it then holds and the rest moved
 * along by the difference.
 */
function puckForDose(puck: Puck, dose: number): Puck {
  if (!(dose > 0) || dose === puck.dose) return puck;
  const ratio = dose / puck.dose;
  const holds = Math.max(0, puck.holds + SOAKED_PER_GRAM * (dose - puck.dose));
  const moved = (volume: number) => (volume <= puck.holds ? (puck.holds > 0 ? (volume * holds) / puck.holds : volume) : volume + holds - puck.holds);
  return {
    ...puck,
    resistance: puck.resistance.map(([volume, resistance]) => [moved(volume), resistance === LEAST_RESISTANCE ? resistance : resistance * ratio] as const),
    holds,
    dose,
    ...(puck.measuredTo === undefined ? {} : { measuredTo: moved(puck.measuredTo) }),
  };
}

// The run ----------------------------------------------------------------------

/** Why a step of a run ended. */
export type StepEnd =
  /** It ran out its time, or had none. */
  | "time"
  /** Its exit fired. */
  | "exit"
  /** It pumped its water. */
  | "water"
  /** Its weight reached the cup. */
  | "weight"
  /** The Shot stopped during it. */
  | "stop";

/** Why a run stopped. */
export type RunStop =
  /** The stop-at weight reached the cup. */
  | "weight"
  /** Its last step ended. */
  | "lastStep";

/** What a run did with one of its profile's steps: when it began and ended, and why; never begun where the Shot stopped before it. */
export interface RunStep {
  /** Its index among the profile's steps. */
  index: number;
  name: string;
  /** Its seconds from the start of the run, or null where the run never came to it. */
  start: number | null;
  end: number | null;
  reason: StepEnd | null;
}

/** A simulated run of a profile on a puck. */
export interface SimulatedRun {
  model: MachineModel;
  dose: number;
  /** The weight it stops at, g, or null to run its steps. */
  stopAt: number | null;
  /**
   * Its samples, one each tick from 0 s: pressure, flow and the weight in the
   * cup and its rate, with the targets the plan asks for (the pressure or
   * flow its pump is asked for, ramped where the step gets there over its
   * whole time, and the step's temperature), in the shape of a Shot's.
   */
  samples: Sample<ShotCurve>[];
  steps: RunStep[];
  stop: { seconds: number; reason: RunStop };
  /** s, from its start to its stop. */
  duration: number;
  /** s, or null where nothing reached the cup. */
  timeToFirstDrip: number | null;
  peakPressure: number;
  peakFlow: number;
  /** The weight in the cup at the stop, g. */
  weight: number;
  /** The rate coffee was landing in the cup at the stop, g/s. */
  weightFlowAtStop: number;
  /** The water pumped, ml. */
  water: number;
}

/** What a simulation is of. */
export interface Simulation {
  profile: Profile;
  puck: Puck;
  /** The dose, g; the puck's own where none is given. */
  dose?: number | null;
  /** The weight the Shot stops at, g; null or 0 to run until its last step ends. */
  stopAt: number | null;
  /** A DE1 where none is given. */
  model?: MachineModel;
}

/**
 * Runs a profile on a puck, as a Machine of the model would with a scale
 * under the cup. Each step ends at its time, its exit, its water pumped or
 * the weight in the cup reaching its weight, whichever comes first, a step
 * of no length at once, whatever its exit, and none longer than the machine
 * runs one (127 s, PROFILE_LIMITS); the Shot stops when the weight in
 * the cup reaches the stop-at weight, or when its last step ends. A profile
 * of no steps runs for none.
 */
export function simulateProfile({ profile, puck: given, dose, stopAt, model = "DE1" }: Simulation): SimulatedRun {
  const figures = MODEL_FIGURES[model];
  const puck = puckForDose(given, dose ?? given.dose);
  const stopWeight = stopAt !== null && stopAt > 0 ? stopAt : null;
  const steps: RunStep[] = profile.steps.map((step, index) => ({ index, name: step.name, start: null, end: null, reason: null }));
  // What the machine runs.
  const sentSteps = profile.steps.map((step) => sentStep(step, model));
  const samples: Sample<ShotCurve>[] = [];
  const pumpFollow = 1 - Math.exp(-SIMULATION_TICK / figures.pumpResponse);

  let time = 0;
  let pressure = 0;
  let flow = 0;
  let pumped = 0;
  let through = 0;
  let weight = 0;
  let weightFlow = 0;
  let index = 0;
  let stepStart = 0;
  let stepPumped = 0;
  let from = 0;
  let stop: SimulatedRun["stop"] | null = null;
  let peakPressure = 0;
  let peakFlow = 0;

  /** A sample now, of the step at `at`, the one running from now, or the last where the run has stopped; null for none. */
  const sample = (at: number | null, target: number | null) => {
    const step = at === null ? undefined : sentSteps[at];
    samples.push({
      seconds: round(time),
      shade: null,
      step: step ? { frame: at!, name: step.name.trim() || `Step ${at! + 1}` } : null,
      substate: at !== null && at < profile.target_volume_count_start ? "preinfusion" : "pouring",
      values: { pressure, flow, weight, weightFlow, temperature: null },
      targets: {
        pressure: step?.pump === "pressure" && target !== null && target > 0 ? target : null,
        flow: step?.pump === "flow" && target !== null && target > 0 ? target : null,
        weight: null,
        weightFlow: null,
        temperature: step && step.temperature > 0 ? step.temperature : null,
      },
    });
  };

  /** Begins the step at `index`, passing through any of no length; false once past the last. */
  const begin = (): boolean => {
    while (index < sentSteps.length) {
      const step = sentSteps[index]!;
      steps[index]!.start = round(time);
      stepStart = time;
      stepPumped = pumped;
      from = step.pump === "pressure" ? pressure : flow;
      if (step.seconds > 0) return true;
      steps[index]!.end = round(time);
      steps[index]!.reason = "time";
      index++;
    }
    return false;
  };

  // The first sample is of the step the run begins with, past any of no length, or of none.
  if (begin()) sample(index, initialTarget(sentSteps[index]!, from));
  else {
    sample(null, null);
    stop = { seconds: 0, reason: "lastStep" };
  }

  while (!stop) {
    const step = sentSteps[index]!;
    const elapsed = time + SIMULATION_TICK - stepStart;
    const goal = stepTarget(step);
    const target = step.transition === "smooth" ? from + (goal - from) * Math.min(1, elapsed / step.seconds) : goal;
    const resistance = Math.max(LEAST_RESISTANCE, resistanceAt(puck.resistance, pumped));

    // What the pump is asked for this tick.
    let asked: number;
    if (step.pump === "pressure") {
      asked = holding(target, pressure, resistance);
      asked = eased(Math.min(figures.pressureStepMaxFlow, asked), step.limiter);
    } else {
      asked = Math.min(figures.maxFlow, Math.max(0, target));
      const wouldBe = resistance * asked * asked;
      const allowed = eased(wouldBe, step.limiter);
      if (allowed < wouldBe) asked = Math.min(asked, holding(allowed, pressure, resistance));
    }
    asked = Math.max(0, Math.min(asked, holding(figures.maxPressure, pressure, resistance)));

    // The pump follows, and the group fills or drains through the puck.
    flow += (asked - flow) * pumpFollow;
    const next = groupPressure(pressure, flow, resistance);
    const puckFlow = Math.sqrt(next / resistance);
    pressure = next;
    pumped += flow * SIMULATION_TICK;
    through += puckFlow * SIMULATION_TICK;
    const before = weight;
    weight = Math.max(0, through - puck.holds) * puck.yieldPerMl;
    weightFlow = (weight - before) / SIMULATION_TICK;
    time += SIMULATION_TICK;
    peakPressure = Math.max(peakPressure, pressure);
    peakFlow = Math.max(peakFlow, flow);

    // Whether the step or the Shot ends now; the sample is then of the step that begins, as a Shot's sample is of the frame the machine is on.
    const ran = index;
    if (stopWeight !== null && weight >= stopWeight) {
      steps[index]!.end = round(time);
      steps[index]!.reason = "stop";
      stop = { seconds: round(time), reason: "weight" };
    } else {
      const reason = stepEnded(step, { elapsed, pressure, flow, water: pumped - stepPumped, weight });
      if (reason) {
        steps[index]!.end = round(time);
        steps[index]!.reason = reason;
        index++;
        if (!begin()) stop = { seconds: round(time), reason: "lastStep" };
      }
    }
    if (stop || index === ran) sample(ran, target);
    else sample(index, initialTarget(sentSteps[index]!, from));
  }

  const firstDrip = samples.find((s) => (s.values.weight ?? 0) >= FIRST_DRIP_GRAMS);
  return {
    model,
    dose: puck.dose,
    stopAt: stopWeight,
    samples,
    steps,
    stop,
    duration: stop.seconds,
    timeToFirstDrip: firstDrip ? firstDrip.seconds : null,
    peakPressure,
    peakFlow,
    weight,
    weightFlowAtStop: weightFlow,
    water: pumped,
  };
}

/** A step's target as it begins, before it has acted: its own, or what was measured where it ramps from that. */
function initialTarget(step: ProfileStep, measured: number): number {
  return step.transition === "smooth" ? measured : stepTarget(step);
}

/** Why a step, as sent (`sentStep`), ends after this tick, or null while it runs on. */
function stepEnded(step: ProfileStep, at: { elapsed: number; pressure: number; flow: number; water: number; weight: number }): StepEnd | null {
  const exit = step.exit;
  // Decaid's simulated machine takes an exit of 0 or less as none (`_stepExitConditionMet`).
  if (exit && exit.value > 0) {
    const reading = exit.type === "pressure" ? at.pressure : at.flow;
    if (exit.condition === "over" ? reading >= exit.value : reading <= exit.value) return "exit";
  }
  if (step.volume > 0 && at.water >= step.volume) return "water";
  if (step.weight !== null && step.weight > 0 && at.weight >= step.weight) return "weight";
  if (at.elapsed >= step.seconds - 1e-9) return "time";
  return null;
}

/**
 * The flow that brings the group to `target` bar from `pressure` within the
 * pump's response: what holds it there through the puck, and more to fill
 * the group as pressure rises, or less to let it drain as it falls.
 */
function holding(target: number, pressure: number, resistance: number): number {
  return Math.sqrt(Math.max(0, target) / resistance) + (GROUP_COMPLIANCE * (target - pressure)) / PRESSURE_RESPONSE;
}

/**
 * The group's pressure after a tick with the pump at `flow`: the water the
 * group holds for each bar (GROUP_COMPLIANCE) rises with what the pump gives
 * and falls with what passes the puck, the square root of the pressure over
 * the resistance, solved for the tick's end so it holds steady however small
 * the resistance.
 */
function groupPressure(pressure: number, flow: number, resistance: number): number {
  const a = GROUP_COMPLIANCE / SIMULATION_TICK;
  const b = 1 / Math.sqrt(resistance);
  const c = a * pressure + flow;
  // a·s² + b·s − c = 0, for s, the square root of the pressure, written so it stays exact when b is large.
  const s = (2 * c) / (b + Math.sqrt(b * b + 4 * a * c));
  return s * s;
}

/**
 * A reading eased under a step's limiter, as Decaid's simulated machine eases
 * it (`_applyLimiter`): unchanged up to the limit, and above it, the limit
 * plus a share of its range that grows toward the whole range as the reading
 * goes further over. A limiter of 0 or less is none, and one of no range a
 * hard cap.
 */
export function eased(reading: number, limiter: StepLimiter | null): number {
  if (!limiter || limiter.value <= 0 || reading <= limiter.value) return reading;
  if (limiter.range <= 0) return limiter.value;
  const over = reading - limiter.value;
  return limiter.value + (limiter.range * over) / (limiter.range + over);
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

// How close a run comes to a Shot --------------------------------------------------

/** A run's or a Shot's figures, as the fit compares them. */
export interface RunFigures {
  /** s, from the start of its profile to its last sample. */
  duration: number;
  timeToFirstDrip: number | null;
  peakPressure: number;
  /** Each step it came to: its index and name, and when it ended, s. */
  steps: Array<{ index: number; name: string; end: number }>;
}

/** How close a run of a Shot's own steps on its own puck comes to the Shot. */
export interface ShotFit {
  shot: RunFigures;
  simulated: RunFigures;
}

/** A Shot's figures from its samples (`shotSamples`) after its Preheat. */
export function shotFigures(samples: readonly Sample<ShotCurve>[]): RunFigures {
  const shot = samples.filter((sample) => sample.shade === null);
  return {
    duration: shot.length > 0 ? shot[shot.length - 1]!.seconds : 0,
    timeToFirstDrip: timeToFirstDrip(shot),
    peakPressure: shot.reduce((peak, sample) => Math.max(peak, sample.values.pressure ?? 0), 0),
    steps: stepSpans(shot).map((span: StepSpan) => ({ index: span.frame, name: span.name, end: span.until })),
  };
}

/** A run's figures, as `shotFigures` reads a Shot's. */
export function runFigures(run: SimulatedRun): RunFigures {
  return {
    duration: run.duration,
    timeToFirstDrip: run.timeToFirstDrip,
    peakPressure: run.peakPressure,
    steps: run.steps.flatMap((step) => (step.end === null ? [] : [{ index: step.index, name: step.name.trim() || `Step ${step.index + 1}`, end: step.end }])),
  };
}

/**
 * The weight a run of a Shot's own steps stops at: the scale's last weight
 * before the Shot stopped (`lastRecordedWeight`), as Decaid stops a Shot
 * before the weight it is set to, by what is still to land, or wherever a
 * person stopped it; none where its machine ended it, having run its last
 * step (Decaid's `machineEnded`), or where it recorded no weight.
 */
export function shotStopAt(samples: readonly Sample<ShotCurve>[], stopReason: unknown): number | null {
  if (stopReason === "machineEnded") return null;
  return lastRecordedWeight(samples)?.weight ?? null;
}

/** How long before a Shot's last sample its scale's last weight may be and still be the weight it stopped at, s. */
const SCALE_GAP = 1;

/**
 * Whether a run of a Shot's own steps can be stopped as it stopped
 * (`shotStopAt`): not where its scale dropped out more than SCALE_GAP before
 * a stop its machine didn't make, as the weight it stopped at is then
 * unknown.
 */
export function shotStopKnown(samples: readonly Sample<ShotCurve>[], stopReason: unknown): boolean {
  if (stopReason === "machineEnded") return true;
  const shot = samples.filter((sample) => sample.shade === null);
  const last = lastRecordedWeight(shot);
  return !last || shot.length === 0 || shot[shot.length - 1]!.seconds - last.seconds <= SCALE_GAP;
}

/** A Shot's own steps run on its own puck, and how close the run comes to the Shot. */
export interface FittedShot {
  run: SimulatedRun;
  fit: ShotFit;
}

/**
 * Runs a Shot's own steps, its Workflow's profile, on its own puck
 * (`shotPuck`), stopped as it stopped (`shotStopAt`), and gives the Shot's
 * figures and the run's side by side.
 */
export function fitToShot({ samples, profile, puck, stopAt, model }: { samples: readonly Sample<ShotCurve>[]; profile: Profile; puck: Puck; stopAt: number | null; model?: MachineModel }): FittedShot {
  const run = simulateProfile({ profile, puck, stopAt, ...(model ? { model } : {}) });
  return { run, fit: { shot: shotFigures(samples), simulated: runFigures(run) } };
}
