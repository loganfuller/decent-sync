import type { SummaryNumber } from "@/lib/api";

// How a Shot Summary's numbers read (#466): each as its median, with the
// range the middle half of its Shots fall in beside it, such as
// "26.0 s (25.6–26.6)".

/** A number of a summary as it reads: its median with its unit, and the range from its 25th percentile to its 75th. */
export interface MedianText {
  median: string;
  range: string;
}

/** A duration as its median and range, in seconds to a tenth, as the Shots list shows one: none where no Shot had one. */
export function durationText(number: SummaryNumber): MedianText | undefined {
  const { median, p25, p75 } = number;
  if (median === null || p25 === null || p75 === null) return undefined;
  return { median: `${median.toFixed(1)} s`, range: `${p25.toFixed(1)}–${p75.toFixed(1)}` };
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
