// The simulation of a profile on a puck (#577, ADR-0032): a run of what a
// Machine of a model would do with it, for the management interface to draw
// as the person edits and the server to answer through the REST API and the
// MCP tools. The same code runs in both.
//
// The machine follows what recorded Shots and Decaid's sources show. Decaid's
// simulated machine (`MockDe1` in
// decaid:lib/src/models/device/impl/mock_de1/mock_de1.dart, v0.9.2) is where
// its dynamics start: a pump controlling pressure or flow, the other capped by
// the step's limiter, eased over its range as `_applyLimiter` eases it or as
// recorded Shots show the model holds it (`limited`), and exits read from
// what the machine measures. Unlike it, a step that gets to
// its target over the whole step ramps from what was measured as it began,
// not from the target of the step before, as recorded Shots show.
//
// The puck is a few numbers, not a curve through time (#602): the water it
// holds before its first drip, its resistance once settled, and the water
// through it by which it has opened. It soaks, seals as it fills, and opens
// as water passes through it; it tightens under pressure, so that its flow
// rises little with pressure; and the group above it holds water and trapped
// air, which fill as pressure builds and drain through the puck as it falls.
// Each is what the simulation's corpus of recorded Shots shows
// (scripts/simulation), and none is a published model of a puck.
//
// Temperature is not simulated: a run's samples carry the plan's temperature
// as their target, and no temperature of their own.
//
// Pure: no Node or browser API, as the plugin bundles this package.

import { MODEL_FIGURES, type MachineModel, type ModelFigures, machineModelOf } from "./machine-models.js";
import { MAX_PROFILE_STEPS, PROFILE_LIMITS, type Profile, type ProfileStep, type StepLimiter, profileOf, stepTarget } from "./profile.js";
import { type Sample, type ShotCurve, type StepSpan, IN_THE_CUP_GRAMS, lastRecordedWeight, shotSamples, stepSpans, timeToFirstDrip } from "./record-samples.js";

// The machine ------------------------------------------------------------------

/** The simulation's tick, s: how often its machine reads and acts, about the DE1's control tick, and its runs' sample interval. */
export const SIMULATION_TICK = 0.1;

/**
 * The water the group holds for each bar of pressure in its own give, ml/bar,
 * and the air trapped above the puck, ml at no pressure, which pressure
 * squeezes: together what fills as pressure builds and drains through the
 * puck as it falls, so pressure falls over seconds, not at once, when the
 * pump stops. Fitted to the corpus (#602): with these a pump-off soak that
 * ends as pressure falls under a figure lasts within a second of its Shot's
 * on 21 of the 26 that have one, where 0.5 ml/bar and no air left them a
 * median 1.4 s short.
 */
const GROUP_GIVE = 0.9;
const TRAPPED_AIR = 9;

/** An atmosphere, bar: the pressure the trapped air is at with none on the gauge. */
const ATMOSPHERE = 1.013;

/** The water the group holds at a pressure, ml: its own give, and what has taken the place of the trapped air squeezed by it. */
function groupHolds(pressure: number): number {
  const p = Math.max(0, pressure);
  return GROUP_GIVE * p + (TRAPPED_AIR * p) / (p + ATMOSPHERE);
}

/** The water the group takes for each bar more at a pressure, ml/bar. */
function groupGives(pressure: number): number {
  const p = Math.max(0, pressure);
  return GROUP_GIVE + (TRAPPED_AIR * ATMOSPHERE) / ((p + ATMOSPHERE) * (p + ATMOSPHERE));
}

/** The pressure a puck's resistance is stated at, bar. */
const RESISTANCE_AT = 9;

/**
 * How a puck tightens under pressure: its resistance, as pressure over flow
 * squared, goes as the pressure to this power, so its flow goes as the
 * pressure to the power 0.15, rising little with pressure. Recorded Shots of
 * one coffee, grind and dose passed about 2.2 to 2.6 ml/s late in the Shot at
 * 0.6, 5.3 and 9 bar alike; with the square root of the pressure (a power of
 * 0 here) one Shot's puck run with another Profile's steps lands a median
 * 13.8% off that Shot's duration on the corpus, and with this 7.9% (#602).
 */
const TIGHTENS = 0.7;

/** The flow through a puck of a resistance at a pressure, ml/s. */
function flowThrough(pressure: number, resistance: number): number {
  if (!(pressure > 0)) return 0;
  return Math.sqrt(RESISTANCE_AT ** TIGHTENS / resistance) * pressure ** ((1 - TIGHTENS) / 2);
}

/** The pressure at which a flow passes a puck of a resistance, bar. */
function pressureFor(flow: number, resistance: number): number {
  if (!(flow > 0)) return 0;
  return ((flow * flow * resistance) / RESISTANCE_AT ** TIGHTENS) ** (1 / (1 - TIGHTENS));
}

/** The resistance a puck shows, stated at RESISTANCE_AT, where a flow passes it at a pressure. */
function resistanceShown(pressure: number, flow: number): number {
  return (RESISTANCE_AT ** TIGHTENS * pressure ** (1 - TIGHTENS)) / (flow * flow);
}

/**
 * How quickly the pump's flow follows what it is asked for on a step whose
 * pump controls pressure, the time constant, s: within a tick, as how
 * quickly the pressure follows its target is each model's own
 * (`ModelFigures.pressureResponse`).
 */
const PUMP_RESPONSE = 0.1;

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

/**
 * How far ahead a step's weight is judged, s: Decaid ends a step on its
 * weight once the weight plus its rate times this reaches it
 * (`projectedWeight` in decaid:lib/src/controllers/shot_sequencer.dart,
 * v0.9.2, its `weightFlowMultiplier` 1 by default).
 */
const WEIGHT_LOOKAHEAD = 1;

/** The least resistance a puck has, where water fills the space above it and meets none. */
const LEAST_RESISTANCE = 0.001;

// The puck ---------------------------------------------------------------------

/**
 * A puck: the few numbers the simulation needs of one to run a profile on
 * it, so that it carries from one profile to another.
 */
export interface Puck {
  /**
   * Its resistance once it has opened, late in a Shot: the pressure it takes
   * for a flow through it, in bar per (ml/s)², stated at RESISTANCE_AT, as it
   * tightens under pressure (TIGHTENS).
   */
  resistance: number;
  /**
   * The water through it after its first drip by which it has opened, ml at
   * STANDARD_DOSE: from just after the first drip it passes a share of what
   * it passes once open that grows with the water through it, to all of it
   * here.
   */
  opens: number;
  /** The water the group and the puck take before coffee drips, ml: the space above the puck and what the coffee soaks up. */
  holds: number;
  /** Grams in the cup for each ml through the puck once it drips. */
  yieldPerMl: number;
  /** The dose it is of, g. Simulated with another dose, its resistance and the water it holds are scaled to it (`puckForDose`). */
  dose: number;
}

/** The dose the standard puck is of, g. */
export const STANDARD_DOSE = 18;

/** The water ground coffee soaks up before it drips, ml for each gram. */
const SOAKED_PER_GRAM = 1.1;

/**
 * The space above the puck a gram of coffee takes up, ml: with more coffee
 * the space is smaller by this and the coffee soaks up SOAKED_PER_GRAM more,
 * so the water before the first drip falls a little as the dose rises and
 * pressure builds sooner. Recorded Shots of 16, 18 and 20 g in one basket
 * took a median 42, 44 to 46 and 41 ml before their first drip.
 */
const SPACE_PER_GRAM = 1.3;

/**
 * The standard puck at the middle of its control, from the simulation's
 * corpus of recorded coffee Shots (scripts/simulation, #602), as their pucks
 * are fitted (`shotPuck`), at STANDARD_DOSE:
 *
 * - the water before its first drip, the space above the puck and what the
 *   coffee soaks up, is the median of all of them, 35 ml;
 * - its open resistance is the median of the corpus's Shots of a flat 9 bar
 *   Profile, and it opens over the water with which their steps, run on it
 *   at their own dose and stop-at weight, last what they lasted at the
 *   median (26 to 33 s). The median puck of the whole corpus is coarser
 *   (0.79, opening over 12 ml), as most of its Shots are of gentler
 *   Profiles ground for them, and runs a flat 9 bar Profile in under 20 s.
 */
const STANDARD_HEADSPACE = 15;
const STANDARD_RESISTANCE = 1;
const STANDARD_OPENS = 20;

/**
 * Each end of the grind takes this many times the middle's resistance, or a
 * part of it: the corpus's coffee Shots' pucks span from about a thirtieth
 * of the standard puck's resistance, a coarse grind for a fast, filter-like
 * Profile, to twenty times it, a fine one, so the ends pass a turbo or
 * filter grind and a grind finer than any recorded. As a puck's flow at one
 * pressure goes as one over the square root of its resistance, each end
 * passes about a seventh or seven times the middle's flow.
 */
const GRIND_RANGE = 50;

/** The standard puck: 18 g of coffee, at `grind` from -1, the finest, to 1, the coarsest, where 0 is the corpus's typical puck. */
export function standardPuck(grind = 0): Puck {
  const scale = GRIND_RANGE ** -Math.min(1, Math.max(-1, grind));
  return { resistance: STANDARD_RESISTANCE * scale, opens: STANDARD_OPENS, holds: STANDARD_HEADSPACE + SOAKED_PER_GRAM * STANDARD_DOSE, yieldPerMl: 1, dose: STANDARD_DOSE };
}

/**
 * The grind of the standard puck, -1 to 1, at which it has a puck's open
 * resistance, the puck's taken at STANDARD_DOSE (`puckForDose`): below 0 for
 * a puck finer than the standard's middle, above it for a coarser one, and
 * held to the control's ends. The standard puck at it still holds and opens
 * as the standard puck does, so it comes near the puck without being it.
 */
export function grindOf(puck: Puck): number {
  const resistance = (puck.resistance * STANDARD_DOSE) / puck.dose;
  return Math.min(1, Math.max(-1, -Math.log(resistance / STANDARD_RESISTANCE) / Math.log(GRIND_RANGE)));
}

/**
 * How far apart the grinds `shotGrind` first tries are: closer than the
 * 0.02 to 0.04 over which a run's distance from a Shot (`shotMiss`) rises
 * and falls again, as its steps' exits and its stop fall a tick earlier or
 * later, so the grid steps over no dip that matters.
 */
const GRIND_SEARCH_STEP = 0.02;
/** How many times `shotGrind` narrows its search about the best of those it first tried. */
const GRIND_SEARCH_NARROWINGS = 10;

/**
 * The grind of the standard puck, -1 to 1, that best imitates a Shot (#622):
 * the one at which the Shot's own steps, run on the standard puck at its
 * dose as its Machine's model and stopped as it stopped (`fitToShot`), come
 * closest to it (`shotMiss`). A Shot laid over a Profile's graph sets the
 * simulation's finer to coarser control to it, so that moving the control
 * from there says how the Shot would likely shift. The standard puck holds
 * and opens as it always does, so the grind takes up as much of the Shot's
 * difference from it as one control can.
 *
 * The grinds tried first are GRIND_SEARCH_STEP apart from end to end, and
 * the best of them is narrowed by golden section within a step either
 * side, so the same Shot always gives the same grind. Where its own steps
 * can't be run as it ran (`shotPuck`'s conditions), the grind at which the
 * standard puck has the open resistance its samples show (`readPuck`,
 * `grindOf`). Null where no sample shows the puck's resistance.
 */
export function shotGrind(shot: SimulationShot): number | null {
  const read = readPuck(shot.samples, shot.dose);
  if (!read) return null;
  const own = shot.profile && shot.profile.steps.length > 0 && shot.profile.steps.length <= MAX_PROFILE_STEPS ? shot.profile : null;
  if (!own || shot.model === null || underManualControl(shot.samples, own, shot.model)) return grindOf(read);
  const stop = shotFitStop(shot.samples, shot.stopReason, shot.model, own);
  if (!stop) return grindOf(read);
  const model = shot.model;
  const dose = shot.dose ?? STANDARD_DOSE;
  const tried = new Map<number, number>();
  const miss = (grind: number) => {
    let y = tried.get(grind);
    if (y === undefined) {
      y = shotMiss(shot.samples, fitToShot({ samples: shot.samples, profile: own, puck: puckForDose(standardPuck(grind), dose), stopAt: stop.stopAt, model }));
      tried.set(grind, y);
    }
    return y;
  };
  const steps = Math.round(2 / GRIND_SEARCH_STEP);
  let best = -1;
  for (let n = 0; n <= steps; n++) {
    const grind = -1 + (2 * n) / steps;
    if (miss(grind) < miss(best)) best = grind;
  }
  // Golden section within a step either side of the best, held to the control.
  const golden = (Math.sqrt(5) - 1) / 2;
  let low = Math.max(-1, best - GRIND_SEARCH_STEP);
  let high = Math.min(1, best + GRIND_SEARCH_STEP);
  let left = high - golden * (high - low);
  let right = low + golden * (high - low);
  for (let n = 0; n < GRIND_SEARCH_NARROWINGS; n++) {
    if (miss(left) < miss(right)) {
      high = right;
      right = left;
      left = high - golden * (high - low);
    } else {
      low = left;
      left = right;
      right = low + golden * (high - low);
    }
  }
  const narrowed = (low + high) / 2;
  return Math.min(1, Math.max(-1, miss(narrowed) < miss(best) ? narrowed : best));
}

/**
 * A puck's resistance at its first drip, as a part of what it is once open:
 * soaked through, and not yet sealed.
 */
const AT_FIRST_DRIP = 0.4;

/** A puck's resistance while it soaks, as a part of what it is at its first drip, against the share of what it soaks up that it has taken. */
const SOAKING: ReadonlyArray<readonly [number, number]> = [
  [0, 0.15],
  [0.5, 0.4],
  [0.75, 0.6],
  [1, 1],
];

/** The water through a puck after its first drip by which it is at its tightest, ml at STANDARD_DOSE. */
const SEALED_AT = 3;

/** The least share of its open flow a puck passes, at its tightest. */
const LEAST_OPEN = 0.08;

/**
 * A puck's resistance, stated at RESISTANCE_AT, once `into` ml of water has
 * gone into the space above it and into it, as recorded Shots show one goes:
 *
 * - none to speak of while water fills the space above it;
 * - rising as the coffee soaks (SOAKING) to AT_FIRST_DRIP of its open
 *   resistance at the first drip;
 * - sealing over the next SEALED_AT ml, as the wet coffee swells, to its
 *   tightest, where it passes a small share of its open flow;
 * - and opening from there as water passes through it, its flow a share of
 *   its open flow that grows evenly with the water through it since the
 *   first drip, to all of it at `opens`.
 *
 * So a pump-off soak holds its pressure against a sealing puck, and a Shot's
 * flow at one pressure climbs through the pour.
 */
function resistanceOf(puck: Puck, into: number): number {
  const soaks = Math.min(puck.holds, SOAKED_PER_GRAM * puck.dose);
  const space = puck.holds - soaks;
  const atDrip = puck.resistance * AT_FIRST_DRIP;
  if (into <= space) return Math.max(LEAST_RESISTANCE, space > 0 ? (SOAKING[0]![1] * atDrip * into) / space : SOAKING[0]![1] * atDrip);
  if (into <= puck.holds) return atDrip * pointsAt(SOAKING, soaks > 0 ? (into - space) / soaks : 1);
  const since = ((into - puck.holds) * STANDARD_DOSE) / puck.dose;
  const open = (water: number) => Math.min(1, Math.max(LEAST_OPEN, water / puck.opens));
  if (since >= SEALED_AT) return puck.resistance / open(since) ** 2;
  // Between the first drip and its tightest, evenly on a scale of ratios.
  const tightest = puck.resistance / open(SEALED_AT) ** 2;
  return atDrip * (tightest / atDrip) ** (since / SEALED_AT);
}

/** The least pressure and flow through the puck at which a Shot's sample shows its resistance. */
const MEASURABLE_PRESSURE = 0.3;
const MEASURABLE_FLOW = 0.3;

/** The share of its last weight the cup holds from where a Shot's yield is read: the first of the pour comes while the coffee is still soaking, and reads low. */
const YIELD_FROM = 1 / 3;

/**
 * A puck read straight from a Shot's samples (`shotSamples`) after its
 * Preheat, with no run of its steps: the water it took before the first
 * drip (`timeToFirstDrip`), which is what was pumped less what the group
 * held at that pressure (`groupHolds`); the grams that reached the cup for
 * each ml through it, over the later part of the pour (YIELD_FROM); and its
 * open resistance, from each sample's pressure and the flow through the
 * puck (the pump's flow less what went to fill the group as pressure rose),
 * as the median of the later half of those after its tightest; and the
 * water by which it opens, from the samples that show it part open, or as
 * the standard puck opens where none does. A Shot with no scale takes what
 * the standard puck holds and yields. `dose` is the Shot's, where it recorded one. Null where
 * no sample shows the puck's resistance, as where the Shot recorded no flow
 * or its pump never ran against pressure.
 */
export function readPuck(samples: readonly Sample<ShotCurve>[], dose: number | null = null): Puck | null {
  const shot = samples.filter((sample) => sample.shade === null);
  const doseOf = dose !== null && dose > 0 ? dose : STANDARD_DOSE;
  const seconds = shot.map((sample) => sample.seconds);
  const pressure = shot.map((sample) => Math.max(0, sample.values.pressure ?? 0));
  const flow = shot.map((sample) => Math.max(0, sample.values.flow ?? 0));
  const pumped = [0];
  for (let n = 1; n < shot.length; n++) pumped.push(pumped[n - 1]! + ((flow[n - 1]! + flow[n]!) / 2) * (seconds[n]! - seconds[n - 1]!));
  // The water into the space above the puck and the puck by each sample: what was pumped, less what pressure holds in the group.
  const into = pumped.map((volume, n) => volume - groupHolds(pressure[n]!));
  const shown: number[] = [];
  const shownAt: number[] = [];
  for (let n = 0; n < shot.length; n++) {
    const before = Math.max(0, n - 1);
    const after = Math.min(shot.length - 1, n + 1);
    const span = seconds[after]! - seconds[before]!;
    const rising = span > 0 ? (pressure[after]! - pressure[before]!) / span : 0;
    const puckFlow = flow[n]! - groupGives(pressure[n]!) * rising;
    if (pressure[n]! < MEASURABLE_PRESSURE || puckFlow < MEASURABLE_FLOW || flow[n]! < MEASURABLE_FLOW) continue;
    shown.push(resistanceShown(pressure[n]!, puckFlow));
    shownAt.push(into[n]!);
  }
  if (shown.length === 0) return null;
  // Each the median of it and its neighbours, two either side, which takes out a sample's spike.
  const smooth = shown.map((_, n) => medianOf(shown.slice(Math.max(0, n - 2), n + 3)));
  const tightest = smooth.reduce((best, value, n) => (value > smooth[best]! ? n : best), 0);
  const after = smooth.slice(tightest);
  const resistance = Math.min(RESISTANCE_MOST, Math.max(RESISTANCE_LEAST, medianOf(after.slice(after.length >> 1))));
  const standard = standardPuck();
  let holds = Math.max(0, standard.holds + (SOAKED_PER_GRAM - SPACE_PER_GRAM) * (doseOf - STANDARD_DOSE));
  let yieldPerMl = standard.yieldPerMl;
  const firstDrip = timeToFirstDrip(shot);
  const last = lastRecordedWeight(shot);
  if (firstDrip !== null) {
    const at = shot.findIndex((sample) => sample.seconds === firstDrip);
    const lastAt = last ? shot.findIndex((sample) => sample.seconds === last.seconds) : -1;
    const firstWeight = shot[at]!.values.weight!;
    if (last && lastAt > at && into[lastAt]! - into[at]! > 5) {
      let from = at;
      for (let n = at; n < lastAt; n++) {
        const weight = shot[n]!.values.weight;
        if (weight === null || weight < last.weight * YIELD_FROM) continue;
        if (into[lastAt]! - into[n]! > 5) from = n;
        break;
      }
      yieldPerMl = Math.min(1.5, Math.max(0.5, (last.weight - (shot[from]!.values.weight ?? firstWeight)) / (into[lastAt]! - into[from]!)));
    }
    holds = Math.max(0, into[at]! - firstWeight / yieldPerMl) + HOLDS_PAST_FIRST_DRIP;
  }
  // The water by which it opens: where a sample after its tightest shows it part open, the water through it since the
  // first drip over the share of its open flow it passes there, as `resistanceOf` has it open; the median of those.
  const opening: number[] = [];
  for (let n = tightest; n < smooth.length; n++) {
    const since = ((shownAt[n]! - holds) * STANDARD_DOSE) / doseOf;
    const open = Math.sqrt(resistance / smooth[n]!);
    if (since >= SEALED_AT && open > LEAST_OPEN && open < 0.8) opening.push(since / open / OPENS_AS_SHOWN);
  }
  const opens = opening.length > 0 ? Math.min(OPENS_MOST, Math.max(OPENS_LEAST, medianOf(opening))) : STANDARD_OPENS;
  return { resistance, opens, holds, yieldPerMl, dose: doseOf };
}

/**
 * How what a Shot's samples show of its puck stands to the puck its own
 * steps need, at the median of the corpus's fitted pucks: the first drops
 * reach the cup this much water before the puck holds all it will, ml, and
 * a puck read part open from a sample's flow opens over this many times the
 * water it is fitted to open over.
 */
const HOLDS_PAST_FIRST_DRIP = 3.5;
const OPENS_AS_SHOWN = 2;

/** The bounds a Shot's puck keeps its open resistance within, and the water by which it opens, ml. */
const RESISTANCE_LEAST = 0.005;
const RESISTANCE_MOST = 500;
const OPENS_LEAST = 1;
const OPENS_MOST = 200;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The water by which a puck opens that a fit starts from, ml: the median of the corpus's fitted pucks, three times it and a third of it. */
const FIT_OPENS = [12, 36, 4];

/** How many steps each of a fit's two searches takes (`leastOf`). */
const FIT_STEPS = 60;
const FIT_STEPS_AGAIN = 40;

/**
 * A Shot's puck: what the simulation needs of the Shot to reproduce it, so
 * that it carries to another profile, where its resistance through its own
 * Shot would not. Its yield is read from its samples (`readPuck`); its open
 * resistance, the water by which it opens and the water it holds before its
 * first drip are those with which a run of the Shot's own steps, on the
 * model of its Machine and ended as it ended (`shotFitStop`), comes closest
 * to the Shot (`shotMiss`), sought from what its samples show, opening
 * over each of FIT_OPENS, whichever starts closest, and then again from what that finds with a wider reach.
 * The water it holds is sought only where its scale showed a first drip.
 *
 * Where its own steps can't be run as it ran (its profile unread, or of no
 * steps or more than a machine takes, its record naming no model, under manual
 * control, or no run able to end as it did: `shotFit`'s conditions), what
 * its samples show. Null where no sample shows the puck's resistance.
 */
export function shotPuck(shot: SimulationShot): Puck | null {
  const read = readPuck(shot.samples, shot.dose);
  if (!read) return null;
  const own = shot.profile && shot.profile.steps.length > 0 && shot.profile.steps.length <= MAX_PROFILE_STEPS ? shot.profile : null;
  if (!own || shot.model === null || underManualControl(shot.samples, own, shot.model)) return read;
  const stop = shotFitStop(shot.samples, shot.stopReason, shot.model, own);
  if (!stop) return read;
  const model = shot.model;
  const dripped = timeToFirstDrip(shot.samples.filter((sample) => sample.shade === null)) !== null;
  // The numbers sought: the logarithms of its resistance and of the water by which it opens, and the water it holds more than its samples show,
  // from the water at its first drip itself.
  const of = ([resistance, opens, holds]: number[]): Puck => ({
    ...read,
    resistance: Math.min(RESISTANCE_MOST, Math.max(RESISTANCE_LEAST, Math.exp(resistance!))),
    opens: Math.min(OPENS_MOST, Math.max(OPENS_LEAST, Math.exp(opens!))),
    ...(dripped ? { holds: Math.max(0, read.holds + holds!) } : {}),
  });
  const miss = (x: number[]) => shotMiss(shot.samples, fitToShot({ samples: shot.samples, profile: own, puck: of(x), stopAt: stop.stopAt, model }));
  const starts = FIT_OPENS.map((opens) => [Math.log(read.resistance), Math.log(opens), ...(dripped ? [-HOLDS_PAST_FIRST_DRIP] : [])]);
  const start = starts.map((x) => ({ x, y: miss(x) })).sort((a, b) => a.y - b.y)[0]!.x;
  const first = leastOf(miss, start, dripped ? [0.5, 0.5, 3] : [0.5, 0.5], FIT_STEPS);
  return of(leastOf(miss, first, dripped ? [-0.3, -0.3, 10] : [-0.3, -0.3], FIT_STEPS_AGAIN));
}

/** How much a second between a run's first drip and its Shot's counts in `shotMiss`, squared. */
const FIRST_DRIP_COUNTS = 0.1;

/**
 * How far a run of a Shot's own steps is from the Shot, as one number a fit
 * brings down, each part squared and summed: its duration's error as a
 * share of the margin a fit is held to (5% or 1 s), its peak pressure's
 * likewise (0.5 bar), the root mean square distance of its pressure (bar)
 * and flow (ml/s) curves from the Shot's at the Shot's samples, and its
 * first drip's error in seconds, counted for less (FIRST_DRIP_COUNTS).
 */
function shotMiss(samples: readonly Sample<ShotCurve>[], { run, fit }: FittedShot): number {
  const duration = (fit.simulated.duration - fit.shot.duration) / Math.max(1, 0.05 * fit.shot.duration);
  const peak = (fit.simulated.peakPressure - fit.shot.peakPressure) / 0.5;
  const drip = fit.shot.timeToFirstDrip !== null && fit.simulated.timeToFirstDrip !== null ? fit.simulated.timeToFirstDrip - fit.shot.timeToFirstDrip : 0;
  const shot = samples.filter((sample) => sample.shade === null);
  const until = Math.min(shot.length > 0 ? shot[shot.length - 1]!.seconds : 0, run.duration);
  let at = 0;
  let pressure = 0;
  let flow = 0;
  let count = 0;
  for (const sample of shot) {
    if (sample.seconds > until) break;
    while (at + 1 < run.samples.length && run.samples[at + 1]!.seconds <= sample.seconds) at++;
    const ran = run.samples[at]!.values;
    pressure += ((ran.pressure ?? 0) - (sample.values.pressure ?? 0)) ** 2;
    flow += ((ran.flow ?? 0) - (sample.values.flow ?? 0)) ** 2;
    count++;
  }
  return duration * duration + peak * peak + (count > 0 ? (pressure + flow) / count : 0) + FIRST_DRIP_COUNTS * drip * drip;
}

/**
 * The point at which a function of a few numbers is least, sought from a
 * start by Nelder and Mead's method over a fixed count of steps, so that
 * the same start gives the same point wherever it runs. `spread` is how far
 * from the start, in each number, the search first reaches.
 */
function leastOf(f: (x: number[]) => number, start: number[], spread: number[], steps: number): number[] {
  let simplex = [start, ...start.map((_, n) => start.map((value, m) => (m === n ? value + spread[n]! : value)))].map((x) => ({ x, y: f(x) }));
  for (let step = 0; step < steps; step++) {
    simplex.sort((a, b) => a.y - b.y);
    const worst = simplex[simplex.length - 1]!;
    const centre = start.map((_, n) => simplex.slice(0, -1).reduce((sum, point) => sum + point.x[n]!, 0) / (simplex.length - 1));
    const along = (t: number) => centre.map((c, n) => c + t * (worst.x[n]! - c));
    const reflected = along(-1);
    const yr = f(reflected);
    if (yr < simplex[0]!.y) {
      const expanded = along(-2);
      const ye = f(expanded);
      simplex[simplex.length - 1] = ye < yr ? { x: expanded, y: ye } : { x: reflected, y: yr };
    } else if (yr < simplex[simplex.length - 2]!.y) simplex[simplex.length - 1] = { x: reflected, y: yr };
    else {
      const contracted = along(0.5);
      const yc = f(contracted);
      if (yc < worst.y) simplex[simplex.length - 1] = { x: contracted, y: yc };
      else {
        const best = simplex[0]!;
        simplex = simplex.map((point, n) => {
          if (n === 0) return point;
          const x = point.x.map((value, m) => (value + best.x[m]!) / 2);
          return { x, y: f(x) };
        });
      }
    }
  }
  simplex.sort((a, b) => a.y - b.y);
  return simplex[0]!.x;
}

/**
 * A puck scaled to another dose: its resistance in proportion, as the bed is
 * deeper; the water the coffee soaks up with it (SOAKED_PER_GRAM), and the
 * space above it smaller by what the coffee takes up (SPACE_PER_GRAM); and
 * the water by which it opens in proportion, as `resistanceOf` reads it.
 */
function puckForDose(puck: Puck, dose: number): Puck {
  if (!(dose > 0) || dose === puck.dose) return puck;
  return { ...puck, resistance: (puck.resistance * dose) / puck.dose, holds: Math.max(0, puck.holds + (SOAKED_PER_GRAM - SPACE_PER_GRAM) * (dose - puck.dose)), dose };
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
  /** s, read from its samples as a Shot's is (`timeToFirstDrip`), or null where its cup never held IN_THE_CUP_GRAMS. */
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
  /**
   * How the stop-at weight is judged: `ahead`, the default, as Decaid stops a
   * Shot, once the weight plus its rate times WEIGHT_LOOKAHEAD reaches it,
   * so the cup holds a little less at the stop; `reached`, once the weight
   * itself does, as a fit stops at the weight a Shot reached.
   */
  stopOn?: "ahead" | "reached";
  /** A DE1 where none is given. */
  model?: MachineModel;
}

/**
 * Runs a profile on a puck, as a Machine of the model would with a scale
 * under the cup. Each step ends at its time, its exit, its water pumped or
 * the weight in the cup reaching its weight, the model's stepWeightLag
 * after it does (the stop-at weight has none),
 * whichever comes first, a step of no length at once, whatever its exit,
 * and none longer than the machine runs one (127 s, PROFILE_LIMITS); the
 * Shot stops when the weight in the cup reaches the stop-at weight, or when
 * its last step ends. A profile of no steps runs for none.
 */
export function simulateProfile({ profile, puck: given, dose, stopAt, stopOn = "ahead", model = "DE1" }: Simulation): SimulatedRun {
  const figures: ModelFigures = MODEL_FIGURES[model];
  const puck = puckForDose(given, dose ?? given.dose);
  const stopWeight = stopAt !== null && stopAt > 0 ? stopAt : null;
  const steps: RunStep[] = profile.steps.map((step, index) => ({ index, name: step.name, start: null, end: null, reason: null }));
  // What the machine runs.
  const sentSteps = profile.steps.map((step) => sentStep(step, model));
  const samples: Sample<ShotCurve>[] = [];
  // The share of the gap to what it is asked for that the pump's flow closes each tick: as a pressure sets it, or as a flow step's target does.
  const followsPressure = 1 - Math.exp(-SIMULATION_TICK / PUMP_RESPONSE);
  const followsFlow = 1 - Math.exp(-SIMULATION_TICK / figures.flowResponse);
  const holds = (target: number, pressure: number, resistance: number) => holding(target, pressure, resistance, figures.pressureResponse);
  // The weight a step is judged on, a second ahead at its rate, at each tick, as it reaches the step the model's stepWeightLag later.
  const lagTicks = Math.round((figures.stepWeightLag ?? 0) / SIMULATION_TICK);
  const judged: number[] = [];

  let time = 0;
  let pressure = 0;
  // The pump as the profile begins: what it was giving through the Preheat, or what its first step of any length asks for where that is a flow and less.
  const opening = sentSteps.find((step) => step.seconds > 0);
  let flow = opening ? Math.min(figures.startFlow ?? 0, opening.pump === "flow" ? Math.max(0, stepTarget(opening)) : Infinity) : 0;
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
    const resistance = Math.max(LEAST_RESISTANCE, resistanceOf(puck, through));

    // What the pump is asked for this tick, and whether a pressure sets it: the step's, its limiter's or the most the machine reaches.
    let asked: number;
    let byPressure = step.pump === "pressure";
    if (step.pump === "pressure") {
      asked = holds(target, pressure, resistance);
      // The most the model gives here: against the pressure now, and against the pressure the step asks for.
      const gives = Math.min(
        figures.pressureStepFlow ? pointsAt(figures.pressureStepFlow, pressure) : figures.maxFlow,
        figures.pressureStepTargetFlow ? pointsAt(figures.pressureStepTargetFlow, goal) : figures.maxFlow,
      );
      asked = limited(Math.min(gives, asked), step.limiter, figures.flowLimiterReach);
    } else {
      asked = Math.min(figures.maxFlow, Math.max(0, target));
      const wouldBe = pressureFor(asked, resistance);
      const allowed = limited(wouldBe, step.limiter, figures.pressureLimiterReach);
      if (allowed < wouldBe) {
        const held = holds(allowed, pressure, resistance);
        if (held < asked) [asked, byPressure] = [held, true];
      }
    }
    const most = holds(figures.maxPressure, pressure, resistance);
    if (most < asked) [asked, byPressure] = [most, true];
    asked = Math.max(0, asked);

    // The pump follows, and the group fills or drains through the puck.
    flow += (asked - flow) * (byPressure ? followsPressure : followsFlow);
    const next = groupPressure(pressure, flow, resistance);
    // What passed the puck is what the group held and the pump gave, less what the group holds now, so no water is made or
    // lost: near no pressure the halving leaves a trace of pressure through which the puck's flow, as pressure to a small
    // power, would be far from none.
    const puckFlow = Math.max(0, groupHolds(pressure) + flow * SIMULATION_TICK - groupHolds(next)) / SIMULATION_TICK;
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
    const ahead = weight + weightFlow * WEIGHT_LOOKAHEAD;
    judged.push(ahead);
    if (stopWeight !== null && (stopOn === "ahead" ? ahead : weight) >= stopWeight) {
      steps[index]!.end = round(time);
      steps[index]!.reason = "stop";
      stop = { seconds: round(time), reason: "weight" };
    } else {
      const reason = stepEnded(step, { elapsed, pressure, flow, water: pumped - stepPumped, weight: judged[judged.length - 1 - lagTicks] ?? 0 });
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

  const firstDrip = timeToFirstDrip(samples);
  return {
    model,
    dose: puck.dose,
    stopAt: stopWeight,
    samples,
    steps,
    stop,
    duration: stop.seconds,
    timeToFirstDrip: firstDrip,
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
 * The flow that brings the group to `target` bar from `pressure` within
 * `response` s, the model's `pressureResponse`: what holds it there through
 * the puck, and more to fill the group as pressure rises, or less to let it
 * drain as it falls.
 */
function holding(target: number, pressure: number, resistance: number, response: number): number {
  return flowThrough(Math.max(0, target), resistance) + (groupHolds(target) - groupHolds(pressure)) / response;
}

/** A value read from [x, value] points in order of x, along the line between two, and level beyond either end. */
function pointsAt(points: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let n = 1; n < points.length; n++) {
    const [x1, y1] = points[n]!;
    if (x <= x1) {
      const [x0, y0] = points[n - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1]![1];
}

/**
 * The group's pressure after a tick with the pump at `flow`: the water the
 * group holds (`groupHolds`) rises with what the pump gives and falls with
 * what passes the puck at the pressure the tick ends at (`flowThrough`),
 * found by halving so that it holds steady however small the resistance.
 */
function groupPressure(pressure: number, flow: number, resistance: number): number {
  const have = groupHolds(pressure) + flow * SIMULATION_TICK;
  if (!(have > 0)) return 0;
  const over = (p: number) => groupHolds(p) + flowThrough(p, resistance) * SIMULATION_TICK - have;
  let low = 0;
  let high = Math.max(1, pressure);
  while (over(high) < 0 && high < 1e6) high *= 2;
  for (let n = 0; n < 40 && high - low > 1e-5; n++) {
    const middle = (low + high) / 2;
    if (over(middle) < 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
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

/**
 * A reading held under a step's limiter as recorded Shots show a model holds
 * it (`ModelFigures.flowLimiterReach`, `pressureLimiterReach`): unchanged up
 * to the limit; above it, the limit plus what the reading is over it, less
 * a share of that which grows evenly, so that it settles at `reach` of the
 * range above the limit once the reading is twice that over. A reach of 0,
 * or a limiter of no range, is a hard cap at the limit. Where the model has
 * no reach, as Decaid's simulated machine eases it (`eased`).
 */
export function limited(reading: number, limiter: StepLimiter | null, reach?: number): number {
  if (reach === undefined) return eased(reading, limiter);
  if (!limiter || limiter.value <= 0 || reading <= limiter.value) return reading;
  const most = reach * limiter.range;
  const over = reading - limiter.value;
  return limiter.value + (over >= 2 * most ? most : over - (over * over) / (4 * most));
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

/** A Shot's figures from its samples (`shotSamples`) after its Preheat, its first drip as a stored Shot's (`timeToFirstDrip`). */
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
    // A step passed through at once has no sample, as a Shot has none of it, so it is left out as from a Shot's.
    steps: run.steps.flatMap((step) => (step.end === null || step.end === step.start ? [] : [{ index: step.index, name: step.name.trim() || `Step ${step.index + 1}`, end: step.end }])),
  };
}

/** How long before a Shot's last sample its scale's last weight may be and still be the weight it stopped at, s. */
const SCALE_GAP = 1;

/**
 * How a run of a Shot's own steps, its Workflow's `profile`, on the model of
 * its Machine, ends as the Shot did: `{ stopAt }`, the weight it stops at,
 * as reached, or null to run its steps out; or null where it can't.
 *
 * - Where a DE1 ended it (`machineEnded`) having run its last step of any
 *   length for its time, within RAN_OUT, the run runs its steps out, as the
 *   weight may have all but stopped rising by then; not where its scale
 *   was lost and a step has a weight, as below.
 * - Otherwise, where its scale read a weight of at least IN_THE_CUP_GRAMS
 *   within SCALE_GAP of the stop, the run stops at that weight or with its
 *   last step, whichever comes first, however it stopped: Decaid stops a Shot on weight before the weight it
 *   is set to, by what is still to land, a Bengle stops one at the Workflow's
 *   yield itself, a person stops one in the app or on the Machine, and a
 *   Shot that ran its steps out reached that weight as its last step ended.
 *   Decaid records a stop on the Machine as `machineEnded`, as it does a
 *   profile's end.
 * - With no such weight, as with no scale, the run runs its steps out where
 *   a DE1 ended the Shot having run its last step of any length out: for
 *   its time, within SCALE_GAP, or to an exit or water limit that could have
 *   ended it. Not otherwise, nor where its scale dropped out and a step has
 *   a weight, as Decaid checks no step's weight once its scale is lost.
 */
export function shotFitStop(samples: readonly Sample<ShotCurve>[], stopReason: unknown, model: MachineModel, profile: Profile): { stopAt: number | null } | null {
  const shot = samples.filter((sample) => sample.shade === null);
  const last = lastRecordedWeight(shot);
  const lost = last !== null && shot[shot.length - 1]!.seconds - last.seconds > SCALE_GAP;
  const endedByDe1 = stopReason === "machineEnded" && model !== "Bengle";
  // Whether a step's weight fired is unknown once the scale was lost.
  const unknowable = lost && profile.steps.some((step) => step.weight !== null && step.weight > 0);
  if (endedByDe1 && !unknowable && ranLastStepOut(shot, profile, model, RAN_OUT, false)) return { stopAt: null };
  if (last !== null && last.weight >= IN_THE_CUP_GRAMS && !lost) return { stopAt: last.weight };
  if (endedByDe1 && !unknowable && ranLastStepOut(shot, profile, model, SCALE_GAP, true)) return { stopAt: null };
  return null;
}

/**
 * How close to its time a Shot's last step must have run for it to have run
 * out, s: about four of a DE1's samples, which Decaid records 0.2 to 0.25 s
 * apart; a stop on the Machine that late differs from running out by less
 * than the fit's margin. A last step that ended on its exit or water limit
 * can't be told from a stop on the Machine, so is judged by its weight.
 */
const RAN_OUT = 1;

/** Whether a Shot's samples end in its profile's last step of any length, as sent to the model, having run it for its time, within `within` s, or, where `limits`, with an exit or water limit that could have ended it. */
function ranLastStepOut(shot: readonly Sample<ShotCurve>[], profile: Profile, model: MachineModel, within: number, limits: boolean): boolean {
  const spans = stepSpans(shot);
  const span = spans[spans.length - 1];
  let lastStep = profile.steps.length - 1;
  while (lastStep >= 0 && !(sentStep(profile.steps[lastStep]!, model).seconds > 0)) lastStep--;
  if (!span || span.frame !== lastStep) return false;
  const step = sentStep(profile.steps[lastStep]!, model);
  return span.until - span.from >= step.seconds - within || (limits && ((step.exit !== null && step.exit.value > 0) || step.volume > 0));
}

/** A Shot's own steps run on its own puck, and how close the run comes to the Shot. */
export interface FittedShot {
  run: SimulatedRun;
  fit: ShotFit;
}

/**
 * Runs a Shot's own steps, its Workflow's profile, on its own puck
 * (`shotPuck`), ended as it ended (`shotFitStop`), and gives the Shot's
 * figures and the run's side by side. A Shot whose scale read nothing ran
 * with no step's weight, as Decaid checks none without a scale, and so does
 * its run.
 */
export function fitToShot({ samples, profile, puck, stopAt, model }: { samples: readonly Sample<ShotCurve>[]; profile: Profile; puck: Puck; stopAt: number | null; model?: MachineModel }): FittedShot {
  const weighed = lastRecordedWeight(samples) !== null;
  const ran = weighed ? profile : { ...profile, steps: profile.steps.map((step) => ({ ...step, weight: null })) };
  const run = simulateProfile({ profile: ran, puck, stopAt, stopOn: "reached", ...(model ? { model } : {}) });
  return { run, fit: { shot: shotFigures(samples), simulated: runFigures(run) } };
}

// Simulating on a Shot's puck --------------------------------------------------

/** What a simulation on a Shot's puck reads of the Shot. */
export interface SimulationShot {
  /** Its samples (`shotSamples`). */
  samples: Sample<ShotCurve>[];
  /** Its own profile, its Workflow's; null where Decaid would not read it. */
  profile: Profile | null;
  /** The coffee it used, g, as weighed or else as set; null where it recorded neither. */
  dose: number | null;
  /** What stopped it, as Decaid recorded it. */
  stopReason: string | null;
  /**
   * The model of the Machine it recorded, a DE1 for any DE1 model
   * (`machineModelOf`); null where its record names none, as Decaid's
   * records before v0.9.2 and one whose capture of the Machine failed
   * (`provenanceStatus` `unavailable`).
   */
  model: MachineModel | null;
}

/** What a simulation on a Shot's puck reads of the Shot, from its full record and its measurements, as the server stores both. */
export function simulationShotOf(record: unknown, measurements: unknown): SimulationShot {
  const shot = fieldsOf(record);
  const workflow = fieldsOf(shot.workflow);
  const profile = profileOf(workflow.profile);
  const above = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  return {
    samples: shotSamples(measurements, profile),
    profile,
    dose: above(fieldsOf(shot.annotations).actualDoseWeight) ?? above(fieldsOf(workflow.context).targetDoseWeight),
    stopReason: typeof shot.stopReason === "string" ? shot.stopReason : null,
    model: typeof fieldsOf(workflow.machine).model === "string" ? machineModelOf(fieldsOf(workflow.machine).model) : null,
  };
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A profile simulated on a Shot's puck, with how close a run of the Shot's own steps on it comes to the Shot. */
export interface ShotPuckRun {
  puck: Puck;
  run: SimulatedRun;
  /**
   * The Shot's own steps run on its puck, stopped as it stopped, beside the
   * Shot (`fitToShot`); null where Decaid would not read its own profile or
   * it has no steps or more than a machine takes, and where a run can't end as the
   * Shot did (`shotFitStop`), where its record names no Machine model, and
   * where it ran under manual control (`underManualControl`).
   */
  fit: ShotFit | null;
}

/**
 * Simulates a profile on a Shot's puck: with `dose`, else the Shot's,
 * stopping at `stopAt`, on a Machine of `model`; and fits the Shot's own
 * steps to it, on the model of the Shot's Machine. `puck` is the Shot's
 * (`shotPuck`), for a caller that keeps it from one run to the next, as
 * working it out runs the Shot's steps some hundreds of times; worked out
 * here where none is given. Null for a Shot whose samples show nothing of
 * its puck's resistance.
 */
export function simulateOnShot({ profile, shot, puck: given, dose, stopAt, model }: { profile: Profile; shot: SimulationShot; puck?: Puck | null; dose?: number | null; stopAt: number | null; model: MachineModel }): ShotPuckRun | null {
  const puck = given ?? shotPuck(shot);
  if (!puck) return null;
  const run = simulateProfile({ profile, puck, dose: dose ?? puck.dose, stopAt, model });
  return { puck, run, fit: shotFit(shot, puck) };
}

/**
 * How close a run of a Shot's own steps on its puck comes to it
 * (`fitToShot`), ended as it ended (`shotFitStop`), on the model of its
 * Machine; null where Decaid would not read its own profile or it has no
 * steps or more than a machine takes, where its record names no Machine model,
 * where it ran under manual control (`underManualControl`), and where a run
 * can't end as it did.
 */
export function shotFit(shot: SimulationShot, puck: Puck): ShotFit | null {
  const own = shot.profile && shot.profile.steps.length > 0 && shot.profile.steps.length <= MAX_PROFILE_STEPS ? shot.profile : null;
  if (!own || shot.model === null || underManualControl(shot.samples, own, shot.model)) return null;
  const stop = shotFitStop(shot.samples, shot.stopReason, shot.model, own);
  return stop ? fitToShot({ samples: shot.samples, profile: own, puck, stopAt: stop.stopAt, model: shot.model }).fit : null;
}

/**
 * How far a target its Machine reported may stray from what a step asks
 * before it is one the step never asked for: 1 bar or ml/s, or this share of
 * what it asks, whichever is more, as a DE1 recorded a target of 12 ml/s for
 * a step asking 15, above what its pump gives.
 */
const MANUAL_STRAY = 1;
const MANUAL_STRAY_SHARE = 0.25;

/**
 * Whether a Shot ran under manual control, as under a Bengle's lever and
 * group-head modes (GHC), so that its steps were not what its Machine
 * followed: for more than half its time after Preheat, the Machine reported
 * a target for what its step's pump controls further than MANUAL_STRAY from
 * what the step asks, as sent to the model (`sentStep`). A smooth step asks
 * for a ramp over its time from its pump's quantity as it began. While a
 * step's limiter holds the other quantity near its value (within
 * MANUAL_STRAY of it, or MANUAL_STRAY_SHARE of it, whichever is more, however
 * wide the limiter's range), a lower target is the limiter's doing. A
 * pressure step's sample with no pressure target reported a target of 0; a
 * flow step's with no flow target counts as following its step. On 944 recorded Shots (#599), the seven that strayed for more than
 * half their time were the Bengle's manual modes and two others whose own
 * steps ran 33% and 78% off their duration; no other strayed for more than
 * two fifths of its time.
 */
export function underManualControl(samples: readonly Sample<ShotCurve>[], profile: Profile, model: MachineModel): boolean {
  const shot = samples.filter((sample) => sample.shade === null);
  if (shot.length < 2) return false;
  const steps = profile.steps.map((step) => sentStep(step, model));
  let strayed = 0;
  let from = 0;
  let began = 0;
  for (let n = 0; n + 1 < shot.length; n++) {
    const sample = shot[n]!;
    const step = sample.step ? steps[sample.step.frame] : undefined;
    if (!step) continue;
    if (sample.step!.frame !== shot[n - 1]?.step?.frame) {
      from = sample.values[step.pump] ?? 0;
      began = sample.seconds;
    }
    // Decaid reports both targets in every sample and shotSamples reads a zero as none, so a pressure step's missing
    // pressure target is a reported 0, as with a lever held closed. A flow step's is none: a Bengle reports a flow
    // step's target as a pressure, with a flow target of 0.
    const target = sample.targets[step.pump] ?? (step.pump === "pressure" ? 0 : null);
    if (target === null) continue;
    const asked = stepTarget(step);
    // A smooth step ramps its target over its time from its pump's quantity as it began, as the Machine reports it.
    const ramped = step.transition === "smooth" && step.seconds > 0 ? from + (asked - from) * Math.min(1, (sample.seconds - began) / step.seconds) : asked;
    // A limiter lowers the target a Bengle reports while it holds the other quantity back near its value, and never raises it.
    const limited = step.pump === "pressure" ? sample.values.flow : sample.values.pressure;
    const holding = step.limiter !== null && step.limiter.value > 0 && limited !== null && limited >= step.limiter.value - Math.max(MANUAL_STRAY, MANUAL_STRAY_SHARE * step.limiter.value);
    const off = holding ? target - ramped : Math.abs(target - ramped);
    if (off > Math.max(MANUAL_STRAY, MANUAL_STRAY_SHARE * Math.max(asked, ramped))) strayed += shot[n + 1]!.seconds - sample.seconds;
  }
  return strayed > shot[shot.length - 1]!.seconds / 2;
}
