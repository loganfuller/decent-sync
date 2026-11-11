import type { SummaryNumber, SummaryNumbers } from "@/lib/api";

// How a Shot Summary's numbers read (#466, #469): each as its median, with
// the range the middle half of its Shots fall in beside it, such as
// "26.0 s (25.6–26.6)"; which of them the Shots list shows, as its address
// keeps them; and who a Barista's name names (#468), for the Barista
// filter's choice.

/** The numbers a summary can give, as the REST API names them, in the order the Shots list shows them. */
export const NUMBERS = [
  "yieldAgainstTarget",
  "duration",
  "stoppedOnWeight",
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

/** Those the Shots list shows until others are chosen, as the REST API gives where none are named. */
export const DEFAULT_NUMBERS: readonly NumberName[] = ["yieldAgainstTarget", "duration", "stoppedOnWeight"];

/** Each number as the Shots list names it. */
export const NUMBER_NAMES: Record<NumberName, string> = {
  yieldAgainstTarget: "Yield against target",
  duration: "Duration",
  stoppedOnWeight: "Stopped on weight",
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
 * How each number read as a median shows: its places and unit. A grind
 * setting shows as Grinders' scales are written, to at most two places
 * without trailing zeros, "8.8" or "12".
 */
export const MEDIAN_TEXT = {
  yieldAgainstTarget: yieldAgainstTargetText,
  duration: durationText,
  ratio: ratioText,
  peakPressure: (number: SummaryNumber) => medianText(number, places(1), " bar"),
  peakFlow: (number: SummaryNumber) => medianText(number, places(1), " ml/s"),
  rating: (number: SummaryNumber) => medianText(number, places(1)),
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

/** A count of Shots, as "1 Shot" or "12 Shots". */
export function shotsText(count: number): string {
  return `${count} ${count === 1 ? "Shot" : "Shots"}`;
}

/**
 * Who a Barista's name names, as the server reads one (`baristaKeySql`): the
 * name without its case or the blanks around it, which are spaces, tabs and
 * line ends and no other space, so the Barista filter's choice is found for
 * any spelling an address holds. Empty for no name, or a blank one.
 */
export function baristaKey(name: string): string {
  return name.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").toLowerCase();
}
