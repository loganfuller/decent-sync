import type { SummaryGroup, SummaryNumber, SummaryNumbers } from "@/lib/api";
import { starCountText, starsOf, starsText } from "./rating";

// How a Shot Summary's numbers read (#466, #469): each as its median, with
// the range the middle half of its Shots fall in beside it, such as
// "26.0 s (25.6–26.6)", a rating in stars (#532); which of them the Shots
// list shows, as its address keeps them; and who a Barista's name names
// (#468), for the Barista filter's choice.

/**
 * The numbers the Shots list offers of a summary, as the REST API names
 * them, in the order it shows them.
 */
export const NUMBERS = [
  "yieldAgainstTarget",
  "duration",
  "stoppedAtTarget",
  "ratio",
  "peakPressure",
  "peakFlow",
  "rating",
  "grindSetting",
  "tds",
  "extractionYield",
  "timeToFirstDrip",
  "lastStep",
] as const satisfies readonly (keyof SummaryNumbers)[];
export type NumberName = (typeof NUMBERS)[number];

/** Those the Shots list shows until others are chosen. */
export const DEFAULT_NUMBERS: readonly NumberName[] = ["yieldAgainstTarget", "duration", "stoppedAtTarget"];

/** Each number as the Shots list names it. */
export const NUMBER_NAMES: Record<NumberName, string> = {
  yieldAgainstTarget: "Yield against target",
  duration: "Duration",
  stoppedAtTarget: "Stopped at target",
  ratio: "Ratio",
  peakPressure: "Peak pressure",
  peakFlow: "Peak flow",
  rating: "Rating",
  grindSetting: "Grind setting",
  tds: "TDS",
  extractionYield: "Extraction yield",
  timeToFirstDrip: "Time to first drip",
  lastStep: "Last step",
};

/**
 * The numbers an address's `numbers` names, as a comma-separated list, in
 * the order of `NUMBERS`: the default where it names none, and leaving out
 * any name it doesn't know, as of a later release's number in an address
 * shared from it.
 */
export function shownNumbers(param: string | null): NumberName[] {
  const named = new Set(param?.split(",") ?? []);
  const shown = NUMBERS.filter((name) => named.has(name));
  return shown.length > 0 ? shown : [...DEFAULT_NUMBERS];
}

/** The `numbers` an address holds for the numbers shown, in the order of `NUMBERS`: none for the default. */
export function numbersParam(shown: readonly NumberName[]): string | null {
  const ordered = NUMBERS.filter((name) => shown.includes(name));
  const isDefault = ordered.length === DEFAULT_NUMBERS.length && ordered.every((name) => DEFAULT_NUMBERS.includes(name));
  return ordered.length === 0 || isDefault ? null : ordered.join(",");
}

/** A number of a summary as it reads: its median with its unit, and the range from its 25th percentile to its 75th. */
export interface MedianText {
  median: string;
  range: string;
}

/** A number as its median and range, each read by `text`, the median with `unit`: none where no Shot had one. */
function medianText(number: SummaryNumber, text: (value: number) => string, unit = ""): MedianText | undefined {
  const { median, p25, p75 } = number;
  if (median === null || p25 === null || p75 === null) return undefined;
  return { median: `${text(median)}${unit}`, range: `${text(p25)}–${text(p75)}` };
}

/** To a fixed number of decimal places. */
const places = (digits: number) => (value: number) => value.toFixed(digits);

/** A duration as its median and range, in seconds to a tenth, as the Shots list shows one: none where no Shot had one. */
export function durationText(number: SummaryNumber): MedianText | undefined {
  return medianText(number, places(1), " s");
}

/** A ratio, yield over dose, as "1:2.10", its range to hundredths. */
export function ratioText(number: SummaryNumber): MedianText | undefined {
  const text = medianText(number, places(2));
  return text && { ...text, median: `1:${text.median}` };
}

/**
 * A rating as its median and range in stars (#532), such as "4 stars" and
 * "3.5–4.5", as a single Shot's reads (`ratingText`): the summary gives it
 * on Decaid's scale, from 0 to 10, of which a star is two points. None
 * where no Shot was rated.
 */
export function ratingMedianText(number: SummaryNumber): MedianText | undefined {
  const { median, p25, p75 } = number;
  if (median === null || p25 === null || p75 === null) return undefined;
  return starsMedianText(starsOf(median), [starsOf(p25), starsOf(p75)]);
}

/**
 * A median and the middle half's range, already in stars, as they read:
 * each to at most two places without trailing zeros, so a median between
 * two stars reads as it is, "3.75 stars", and one star "1 star".
 */
export function starsMedianText(median: number, [p25, p75]: readonly [number, number]): MedianText {
  return { median: starsText(median), range: `${starCountText(p25)}–${starCountText(p75)}` };
}

/**
 * How each number read as a median shows: its places and unit. A rating
 * shows in stars. A grind setting shows as Grinders' scales are written,
 * to at most two places without trailing zeros, "8.8" or "12".
 */
export const MEDIAN_TEXT = {
  yieldAgainstTarget: yieldAgainstTargetText,
  duration: durationText,
  ratio: ratioText,
  peakPressure: (number: SummaryNumber) => medianText(number, places(1), " bar"),
  peakFlow: (number: SummaryNumber) => medianText(number, places(1), " ml/s"),
  rating: ratingMedianText,
  grindSetting: (number: SummaryNumber) => medianText(number, settingText),
  tds: (number: SummaryNumber) => medianText(number, places(2), "%"),
  extractionYield: (number: SummaryNumber) => medianText(number, places(1), "%"),
  timeToFirstDrip: (number: SummaryNumber) => medianText(number, places(1), " s"),
} satisfies Partial<Record<NumberName, (number: SummaryNumber) => MedianText | undefined>>;

/** A grind setting, to at most two places, without trailing zeros. */
export function settingText(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * A yield against target as its median and range, in grams to a tenth, each
 * with its sign, over or under the target: none where no Shot had one. The
 * range reads "to" rather than a dash, which a minus sign beside it would
 * be mistaken for.
 */
export function yieldAgainstTargetText(number: SummaryNumber): MedianText | undefined {
  const { median, p25, p75 } = number;
  if (median === null || p25 === null || p75 === null) return undefined;
  return { median: `${signedText(median)} g`, range: `${signedText(p25)} to ${signedText(p75)}` };
}

/** A difference to a tenth with its sign, a plus or a minus sign (U+2212); one that rounds to nothing has neither. */
export function signedText(value: number): string {
  const size = Math.abs(value).toFixed(1);
  if (Number(size) === 0) return size;
  return `${value > 0 ? "+" : "−"}${size}`;
}

/** A share, from 0 to 1, as a whole percentage: none where no Shot either did or didn't. */
export function shareText(share: number | null): string | undefined {
  return share === null ? undefined : `${Math.round(share * 100)}%`;
}

/**
 * What a summary's Shots count notes under it, each where there are any:
 * the Unfinished Shots and the cleaning and calibration Shots left out of
 * its numbers, and those of its Shots whose stored values, the first drip
 * and last step, the server is still working out.
 */
export function countNotes({ unfinished, cleaningAndCalibration, awaitingValues }: SummaryGroup["counts"]): string[] {
  return [
    ...(unfinished > 0 ? [`${unfinished} Unfinished ${unfinished === 1 ? "Shot" : "Shots"} left out`] : []),
    ...(cleaningAndCalibration > 0 ? [`${cleaningAndCalibration} cleaning ${cleaningAndCalibration === 1 ? "or calibration Shot" : "and calibration Shots"} left out`] : []),
    ...(awaitingValues > 0 ? [`${awaitingValues} still ${awaitingValues === 1 ? "awaits its" : "await their"} first drip and last step`] : []),
  ];
}

/**
 * How the Shots that didn't stop at their target stopped, each kind where
 * there are any, as a note under the share that did: "2 by hand · 1 ended by
 * the Machine".
 */
export function otherStopsText({ byHand, machineEnded, error, other }: SummaryNumbers["stoppedAtTarget"]): string | undefined {
  const kinds = [
    [byHand, "by hand"],
    [machineEnded, "ended by the Machine"],
    [error, "by an error"],
    [other, "another way"],
  ] as const;
  const said = kinds.filter(([shots]) => shots > 0).map(([shots, how]) => `${shots} ${how}`);
  return said.length > 0 ? said.join(" · ") : undefined;
}

/** A count of Shots, as "1 Shot" or "12 Shots". */
export function shotsText(count: number): string {
  return `${count} ${count === 1 ? "Shot" : "Shots"}`;
}

/**
 * Who a Barista's name names, as the server reads one (`baristaKeySql`): the
 * name without the blanks around it, which are spaces, tabs and line ends
 * and no other space, and without the case of A to Z, so the Barista
 * filter's choice is found for an address holding another spelling. Empty
 * for no name, or a blank one. The server folds every letter's case as its
 * database's collation does, which differs from JavaScript's for some, such
 * as a final sigma or a dotted I, so other letters are left as they are:
 * such a name spelled another way finds no choice, rather than another
 * Barista's.
 */
export function baristaKey(name: string): string {
  return name.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").replace(/[A-Z]+/g, (capitals) => capitals.toLowerCase());
}
