import * as z from "zod";
import { MARGINS, MARGIN_WORDS, STOP_KINDS } from "../shots/spec.js";

// What is out of spec (#543; shots/spec.ts, GLOSSARY.md), as the tools that
// read Shots, Shot Summaries and Machines give it, each as its REST read
// does: the schemas, and what each tool's description says of the margins
// and of stopped at target, from the server's own constants.

const judgement = z.enum(["withinSpec", "outOfSpec", "notJudged"]);
const beyondMargin = z.boolean().nullable().describe("Whether they are beyond the margin, judged or not; null with nothing to measure.");

/** A group's judgement, as summarise_shots gives it. */
export const groupSpec = z
  .object({
    duration: z
      .object({ judgement, beyondMargin, difference: z.number().nullable().describe("The group's median duration less the Reference Shot's, in seconds.") })
      .optional()
      .describe("Only with groupBy recipe, where the Recipe has a Reference Shot with a duration."),
    yield: z.object({ judgement, beyondMargin }),
    stoppedAtTarget: z.object({ judgement, beyondMargin }),
    betweenMachines: z
      .object({ judgement, beyondMargin, apart: z.number().nullable().describe("The seconds between the fastest and slowest Machines' median durations.") })
      .optional()
      .describe("Only with groupBy recipe and machine, for a group with a Recipe: the same on each of the Recipe's groups."),
  })
  .describe("Without bucket: how the group's Shots stand against the margins.");

/** How a Shot stopped, as a Shot's spec gives it. */
const stopped = z.enum([...(Object.keys(STOP_KINDS) as [keyof typeof STOP_KINDS, ...(keyof typeof STOP_KINDS)[]]), "other"]);

const against = <T extends z.ZodRawShape>(shape: T, what: string) => z.object({ ...shape, outOfSpec: z.boolean() }).nullable().describe(what);
const shotDuration = against({ difference: z.number().describe("In seconds.") }, "Its duration less its Recipe's Reference Shot's; null where there is none to compare, or it is not judged.");
const shotYield = against({ againstTarget: z.number().describe("In grams.") }, "Its yield weighed less its target; null where it has neither, or it is not judged.");

/** One Shot's judgement, as get_shot, list_machines and get_machine give it. */
export const shotSpec = z
  .object({
    unfinished: z.boolean().describe("An Unfinished Shot: nothing poured."),
    cleaningOrCalibration: z.boolean().describe("A cleaning or calibration Shot."),
    duration: shotDuration,
    yield: shotYield,
    stopped: stopped.nullable().describe("How it stopped; null where it recorded no stop reason."),
  })
  .describe("How it stands against the margins.");

/** One Shot's judgement as a find_shots row gives it: each part only where it has a value, and the two flags only when true. */
export const shotRowSpec = z
  .object({
    unfinished: z.literal(true).optional(),
    cleaningOrCalibration: z.literal(true).optional(),
    duration: shotDuration.unwrap().optional(),
    yield: shotYield.unwrap().optional(),
    stopped: stopped.optional(),
  })
  .describe("How it stands against the margins, each part left out where it has none.");

/** What stopped at target means, for the descriptions of the tools that give it. */
export const STOPPED_AT_TARGET = "stopped at target, Decaid stopping it as it reached its target weight on the scale (targetWeight) or, with no scale, its target volume (targetVolume)";

/** What a Shot's spec judges, beside how it stopped, for the descriptions of the tools that give one whole. */
export const SHOT_SPEC = `spec judges it against the margins: duration, its seconds from the duration of its Recipe's Reference Shot, outOfSpec more than ${MARGIN_WORDS.duration} of that away, null with none; and yield, its grams from its own target, outOfSpec more than ${MARGIN_WORDS.yield} of the target away. unfinished Shots, in which nothing poured, and cleaningOrCalibration Shots are not judged.`;

/** What stopReason and spec.stopped are where a tool leaves their kinds to find_shots' description. */
export const STOPPED_BRIEFLY = "stopReason is what Decaid recorded stopping it, and spec.stopped its kind, as find_shots describes them: targetWeight and targetVolume are stopped at target, Decaid stopping it at its target weight on the scale or, with no scale, its target volume.";

/** A Machine's last Shot, for list_machines' description. */
export const LAST_SHOT = `lastShot, the Shot it pulled last, with its Recipe, its duration in seconds and its spec, as get_shot gives it: outOfSpec is a duration more than ${MARGIN_WORDS.duration} from its Recipe's Reference Shot's, or a yield more than ${MARGIN_WORDS.yield} from its target, and stopped is how it stopped, targetWeight and targetVolume being ${STOPPED_AT_TARGET}`;

/** The same for get_machine's, which leaves the rest to list_machines'. */
export const LAST_SHOT_BRIEFLY = `lastShot, with its Recipe, duration and spec, as list_machines describes: outOfSpec is beyond ${MARGIN_WORDS.duration} of its Recipe's Reference Shot's duration or ${MARGIN_WORDS.yield} of its target yield, and targetWeight and targetVolume are stopped at target`;

/** What a group's spec is, for summarise_shots' description. */
export const GROUP_SPEC = `Without bucket, spec judges each group withinSpec, outOfSpec or notJudged: yield, out of spec where the median of each Shot's yield against its target, as a share of it, is beyond ${MARGIN_WORDS.yield}; stoppedAtTarget, under ${MARGIN_WORDS.stoppedAtTarget}; by recipe, duration, a median more than ${MARGIN_WORDS.duration} of the Reference Shot's from it, with difference in seconds; and by recipe and machine, betweenMachines, the Recipe's fastest and slowest Machines' medians more than ${MARGIN_WORDS.betweenMachines} of the slower's apart, with apart in seconds. Each needs ${MARGINS.shots} Shots with a value, and betweenMachines two such Machines: fewer are notJudged, beyondMargin still saying whether they are beyond the margin.`;
