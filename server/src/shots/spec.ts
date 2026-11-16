// Out of spec (#543; GLOSSARY.md): the margins a machine's shots of a recipe
// over a period, and one shot, are judged against, and the judgements
// themselves, which a Shot Summary gives of each group (summary.ts) and a
// Shot's read of the Shot (shot-specs.ts). This module is pure: it reads
// nothing, and each judgement is of numbers its caller read.

/**
 * The margins, each in one place. They are the server's own, the same for
 * every Location and Recipe: setting them in the management interface, and
 * a marginal level between the two, are a later ticket's (#548).
 */
export const MARGINS = {
  /** A duration is out of spec more than this share of the Recipe's Reference Shot's duration from it, either way. */
  duration: 0.1,
  /** A yield is out of spec more than this share of its target from it, either way. */
  yield: 0.05,
  /** A group's Shots are out of spec where under this share of those that recorded what stopped them stopped at their target. */
  stoppedAtTarget: 0.9,
  /** A Recipe is out of spec between Machines where its fastest and slowest Machines' median durations differ by more than this share of the slower one's. */
  betweenMachines: 0.1,
  /** The fewest Shots with a value a group's judgement needs: fewer are not judged. */
  shots: 3,
} as const;

/**
 * How a Shot stopped, of the stop reason Decaid recorded
 * (`ShotDecisionReason` in decaid:lib/src/models/data/shot_state_event.dart,
 * the same at v0.9.1 and v0.9.2): each kind with its reasons. The first two
 * are stopped at target (GLOSSARY.md): Decaid stopped the Shot as it reached
 * its target weight on the scale or, with no scale, its target volume.
 * `byHand` is the Stop button in Decaid's own app or a stop through its API,
 * as a Skin's; `machineEnded` the Machine ending it itself, as its profile
 * ran out or it was stopped on the Machine; `error` the Machine going into
 * an error state, or its connection dropping. Any other reason is `other`.
 */
export const STOP_KINDS = {
  targetWeight: ["targetWeight"],
  targetVolume: ["targetVolume"],
  byHand: ["appStop", "apiStop"],
  machineEnded: ["machineEnded"],
  error: ["error", "disconnected"],
} as const;

/** How a Shot stopped: one of `STOP_KINDS`, or `other`, for a reason of none of them, which the Shot's `stopReason` gives as recorded. */
export type StopKind = keyof typeof STOP_KINDS | "other";

/** The reasons that are stopping at target. */
export const AT_TARGET_REASONS: readonly string[] = [...STOP_KINDS.targetWeight, ...STOP_KINDS.targetVolume];

/** How a Shot that recorded `reason` stopped; null where it recorded none. */
export function stopKindOf(reason: string | null): StopKind | null {
  if (reason === null) return null;
  const kinds = Object.keys(STOP_KINDS) as (keyof typeof STOP_KINDS)[];
  return kinds.find((kind) => (STOP_KINDS[kind] as readonly string[]).includes(reason)) ?? "other";
}

/**
 * A judgement of a group's Shots, or of a Recipe between Machines:
 * `withinSpec`, `outOfSpec`, or `notJudged`, where fewer than
 * `MARGINS.shots` Shots had a value, or too few Machines had that many.
 * `beyondMargin` is whether what they have is beyond the margin whether or
 * not they are judged, so the few Shots of a group not judged still say
 * which way they lean: true out of spec, false within, and null where there
 * is nothing to measure.
 */
export interface Judgement {
  judgement: "withinSpec" | "outOfSpec" | "notJudged";
  beyondMargin: boolean | null;
}

function judged(shots: number, beyondMargin: boolean | null): Judgement {
  return { judgement: beyondMargin === null || shots < MARGINS.shots ? "notJudged" : beyondMargin ? "outOfSpec" : "withinSpec", beyondMargin };
}

/**
 * A measure as a whole number of millionths, in which a margin's edge is
 * exact: a duration is kept to the millisecond and a yield's share of its
 * target to millionths, and a median of an even number of them falls halfway
 * between two, which a float holds only nearly.
 */
function millionths(value: number): number {
  return Math.round(value * 1e6);
}

/** A difference of two such measures as it prints, without what a float's subtraction leaves after the millionths; as it is where it is too large to count them. */
function exact(difference: number): number {
  const scaled = millionths(difference);
  return Number.isFinite(scaled) ? scaled / 1e6 : difference;
}

/** Whether `difference` is more than `margin`, a share, of `whole` from nothing, either way: at the margin exactly it is not. */
function beyond(difference: number, whole: number, margin: number): boolean {
  return Math.abs(millionths(difference)) > Math.abs(millionths(whole)) * margin + 1e-6;
}

/** A group's duration against its Recipe's Reference Shot's: its median's difference from it, in seconds, null where no Shot had a duration, and the judgement of that. */
export interface DurationJudgement extends Judgement {
  difference: number | null;
}

/** Judges a group's median duration, of `shots` Shots that had one, against the Reference Shot's `reference`, both in seconds. */
export function judgeDuration(shots: number, median: number | null, reference: number): DurationJudgement {
  if (median === null) return { ...judged(0, null), difference: null };
  const difference = exact(median - reference);
  return { ...judged(shots, beyond(difference, reference, MARGINS.duration)), difference };
}

/** Judges a group's yield: `median`, the median of each Shot's yield less its target as a share of that target, of the `shots` Shots that had one. */
export function judgeYield(shots: number, median: number | null): Judgement {
  return judged(shots, median === null ? null : beyond(median, 1, MARGINS.yield));
}

/** Judges a group's stopping: of the `shots` Shots that recorded what stopped them, the `atTarget` that stopped at their target. */
export function judgeStopping(shots: number, atTarget: number): Judgement {
  // In whole Shots, so 9 of 10 is at the margin, and within it.
  return judged(shots, shots === 0 ? null : atTarget < shots * MARGINS.stoppedAtTarget - 1e-9);
}

/** A Recipe between Machines: how far apart its fastest and slowest Machines' median durations are, in seconds, null where fewer than two Machines pulled it, and the judgement of that. */
export interface BetweenMachines extends Judgement {
  apart: number | null;
}

/**
 * Judges a Recipe between Machines, from the fastest and slowest median
 * durations of its Machines: of those with at least `MARGINS.shots` Shots,
 * `counted`, where there are two or more, which it is judged by; and
 * otherwise of every Machine that pulled it, `every`, which is not judged,
 * so the number given is always the one the judgement is of.
 */
export function judgeBetweenMachines(counted: MachineSpread, every: MachineSpread): BetweenMachines {
  const spread = counted.machines >= 2 ? counted : every;
  if (spread.machines < 2 || spread.fastest === null || spread.slowest === null) return { judgement: "notJudged", beyondMargin: null, apart: null };
  const apart = exact(spread.slowest - spread.fastest);
  const beyondMargin = beyond(apart, spread.slowest, MARGINS.betweenMachines);
  return { judgement: spread === counted ? (beyondMargin ? "outOfSpec" : "withinSpec") : "notJudged", beyondMargin, apart };
}

/** Some of a Recipe's Machines: how many there are, and the lowest and highest of their median durations, in seconds. */
export interface MachineSpread {
  machines: number;
  fastest: number | null;
  slowest: number | null;
}

/**
 * One Shot against the margins, as its read and a Shots list's row give it.
 * An Unfinished Shot and a cleaning or calibration Shot are not judged, as a
 * Shot Summary leaves them out of its numbers: `duration` and `yield` are
 * null for them.
 */
export interface ShotSpec {
  /** Whether it is an Unfinished Shot (GLOSSARY.md): nothing poured. */
  unfinished: boolean;
  /** Whether it is a cleaning or calibration Shot, by its profile's type as recorded. */
  cleaningOrCalibration: boolean;
  /**
   * Its duration less that of the Reference Shot of the Recipe it was pulled
   * with, in seconds, and whether that is out of spec; null where that
   * Recipe has no Reference Shot with a duration, it was pulled with no
   * Recipe, or it has no duration.
   */
  duration: { difference: number; outOfSpec: boolean } | null;
  /** Its yield weighed less its own target, in grams, and whether that is out of spec, as a share of the target; null where its target is 0 or missing, or it weighed none. */
  yield: { againstTarget: number; outOfSpec: boolean } | null;
  /** How it stopped (`StopKind`); null where it recorded no stop reason. */
  stopped: StopKind | null;
}

/** What one Shot's judgement is of, as read with it. */
export interface ShotMeasures {
  unfinished: boolean;
  cleaningOrCalibration: boolean;
  /** Its duration, and its Recipe's Reference Shot's, in seconds. */
  duration: number | null;
  referenceDuration: number | null;
  /** Its yield less its target, in grams, and as a share of that target. */
  yieldAgainstTarget: number | null;
  yieldShare: number | null;
  stopReason: string | null;
}

/** Judges one Shot by the margins a group is judged by. */
export function judgeShot(shot: ShotMeasures): ShotSpec {
  const judgedShot = !shot.unfinished && !shot.cleaningOrCalibration;
  const difference = shot.duration === null || shot.referenceDuration === null ? null : exact(shot.duration - shot.referenceDuration);
  return {
    unfinished: shot.unfinished,
    cleaningOrCalibration: shot.cleaningOrCalibration,
    duration: judgedShot && difference !== null ? { difference, outOfSpec: beyond(difference, shot.referenceDuration!, MARGINS.duration) } : null,
    yield:
      judgedShot && shot.yieldAgainstTarget !== null && shot.yieldShare !== null
        ? { againstTarget: shot.yieldAgainstTarget, outOfSpec: beyond(shot.yieldShare, 1, MARGINS.yield) }
        : null,
    stopped: stopKindOf(shot.stopReason),
  };
}

/** The margins in words, as percentages, for what describes them, such as an MCP tool's description. */
export const MARGIN_WORDS = {
  duration: `${MARGINS.duration * 100}%`,
  yield: `${MARGINS.yield * 100}%`,
  stoppedAtTarget: `${MARGINS.stoppedAtTarget * 100}%`,
  betweenMachines: `${MARGINS.betweenMachines * 100}%`,
} as const;
