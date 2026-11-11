import type { SummaryBucket, SummaryNumber } from "@/lib/api";
import { bucketTitle } from "./machine-use";
import { MEDIAN_TEXT, NUMBERS, type NumberName, shareText } from "./shot-summary";

// A Shot Summary's trend (#470) as the Shots list charts it: the pure parts,
// which read the address's number and bucket, and put a group's buckets, as
// the REST API gives them, on a time axis and into words.

/** The numbers a trend can chart: each a summary gives as a median or a share, so not the last step, which is a count of Shots by step. */
export type TrendNumber = Exclude<NumberName, "lastStep">;
export const TREND_NUMBERS: readonly TrendNumber[] = NUMBERS.filter((name): name is TrendNumber => name !== "lastStep");

/** The number charted until another is chosen. */
export const DEFAULT_TREND: TrendNumber = "duration";

/** What a trend's Shots are bucketed by, as the REST API names them: the day, the default, or the week from its Monday. */
export const BUCKETS = ["day", "week"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** The number an address's `trend` names: the default where it names none, or one this release doesn't know, as in an address shared from a later one. */
export function trendNumber(param: string | null): TrendNumber {
  return TREND_NUMBERS.find((name) => name === param) ?? DEFAULT_TREND;
}

/** The `trend` an address holds for the number charted: none for the default. */
export function trendParam(number: TrendNumber): string | null {
  return number === DEFAULT_TREND ? null : number;
}

/** The bucket an address's `bucket` names: by day unless it names the week. */
export function trendBucket(param: string | null): Bucket {
  return param === "week" ? "week" : "day";
}

/** The `bucket` an address holds: none for by day. */
export function bucketParam(bucket: Bucket): string | null {
  return bucket === "day" ? null : bucket;
}

/** Each number's unit, as the chart's title gives it: none for a ratio, a rating or a grind setting. */
export const TREND_UNITS: Record<TrendNumber, string | undefined> = {
  yieldAgainstTarget: "g",
  duration: "s",
  stoppedOnWeight: "%",
  ratio: undefined,
  peakPressure: "bar",
  peakFlow: "ml/s",
  rating: undefined,
  grindSetting: undefined,
  tds: "%",
  extractionYield: "%",
  timeToFirstDrip: "s",
};

/**
 * A day or week of a trend that has a value to chart: `start`, its day or
 * its week's Monday; `at`, that date as a count of days, which the time axis
 * runs on, so a day or week with no point leaves its room; `value`, the
 * median of its Shots, or, of a share, the share, as a percentage; `band`,
 * the range the middle half of them fall in, which a share has none of; and
 * `shots`, how many Shots the value rests on, of the `covered` its bucket's
 * numbers cover.
 */
export interface TrendPoint {
  start: string;
  at: number;
  value: number;
  band?: [number, number];
  shots: number;
  covered: number;
}

/** A date, such as 2026-03-02, as a count of days, by its calendar alone: no time zone plays a part. */
export function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.round(Date.UTC(year!, month! - 1, day!) / 86_400_000);
}

/** The date a count of days is. */
export function dateOf(at: number): string {
  return new Date(at * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A group's buckets as the points a trend of `number` charts, oldest first:
 * one for each day or week whose Shots had a value of it. A day or week
 * with Shots but no value, as one with no Shot rated, has no point, nor has
 * the bucket of the Shots whose time is unknown.
 */
export function trendPoints(buckets: readonly SummaryBucket[], number: TrendNumber): TrendPoint[] {
  return buckets.flatMap((bucket): TrendPoint[] => {
    if (bucket.start === null) return [];
    const point = { start: bucket.start, at: dayNumber(bucket.start), covered: bucket.counts.shots };
    if (number === "stoppedOnWeight") {
      const share = bucket.numbers.stoppedOnWeight;
      return share && share.share !== null ? [{ ...point, value: share.share * 100, shots: share.shots }] : [];
    }
    const { shots, median, p25, p75 } = bucket.numbers[number] ?? ({ shots: 0, median: null, p25: null, p75: null } satisfies SummaryNumber);
    return median === null || p25 === null || p75 === null ? [] : [{ ...point, value: median, band: [p25, p75], shots }];
  });
}

/** How many Shots a group's buckets hold whose time is unknown, which are in no day or week, so on no chart. */
export function untimedShots(buckets: readonly SummaryBucket[]): number {
  const { shots, unfinished, cleaningAndCalibration } = buckets.find((bucket) => bucket.start === null)?.counts ?? { shots: 0, unfinished: 0, cleaningAndCalibration: 0 };
  return shots + unfinished + cleaningAndCalibration;
}

/**
 * The span of a trend's time axis, in days: from its first point to its
 * last, or, for one point, a day or week either side of it, so it sits in
 * the middle.
 */
export function axisSpan(points: readonly TrendPoint[], bucket: Bucket): [number, number] {
  const [first, last] = [points[0]?.at ?? 0, points.at(-1)?.at ?? 0];
  const step = bucket === "week" ? 7 : 1;
  return first === last ? [first - step, last + step] : [first, last];
}

/**
 * The days a trend's time axis is marked at: every `step`th day or week
 * from the span's first, `step` the smallest that leaves at most `most`
 * marks, so each mark is a day, or a week's Monday, the trend could have a
 * point at.
 */
export function axisTicks([from, until]: readonly [number, number], bucket: Bucket, most = 6): number[] {
  const unit = bucket === "week" ? 7 : 1;
  const step = unit * Math.max(1, Math.ceil((until - from) / unit / (most - 1)));
  const ticks: number[] = [];
  for (let at = from; at <= until; at += step) ticks.push(at);
  return ticks;
}

/** A point's day in full, such as "Thu, Nov 5, 2026", or its week, as "Week of Mon, Nov 2, 2026". */
export function pointTitle(start: string, bucket: Bucket): string {
  const day = bucketTitle({ date: start });
  return bucket === "week" ? `Week of ${day}` : day;
}

/**
 * A point's value as it reads: a median with its unit and the middle half's
 * range, as the Shots list's summary shows one, or a share as a whole
 * percentage, which has no range.
 */
export function pointText(point: Pick<TrendPoint, "value" | "band">, number: TrendNumber): { value: string; range?: string } {
  if (number === "stoppedOnWeight" || !point.band) return { value: shareText(point.value / 100)! };
  const text = MEDIAN_TEXT[number]({ shots: 1, median: point.value, p25: point.band[0], p75: point.band[1] })!;
  return { value: text.median, range: text.range };
}
