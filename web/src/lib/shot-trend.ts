import type { BatchLink, BucketedGroup, SummaryBucket, SummaryNumber } from "@/lib/api";
import { batchCodeOf, recordedDayText, roastedText } from "./batch-name";
import { bucketTitle } from "./machine-use";
import { starsOf } from "./rating";
import { MEDIAN_TEXT, NUMBERS, type NumberName, shareText, starsMedianText } from "./shot-summary";

// A Shot Summary's trend (#470) as the Shots list charts it, and the Recipe
// page a line for each Machine (#474): the pure parts, which read the
// address's number and bucket, and put each group's buckets, as the REST
// API gives them, on a time axis and into words.

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

/** Whether a number is a share of the Shots, charted as a line alone from none of them to all, rather than a median with its band. */
export function isShare(number: TrendNumber): number is "stoppedAtTarget" {
  return number === "stoppedAtTarget";
}

/** The bucket an address's `bucket` names: by day unless it names the week. */
export function trendBucket(param: string | null): Bucket {
  return param === "week" ? "week" : "day";
}

/** The `bucket` an address holds: none for by day. */
export function bucketParam(bucket: Bucket): string | null {
  return bucket === "day" ? null : bucket;
}

/** Each number's unit, as the chart's title gives it: none for a ratio or a grind setting. A rating is charted in stars (#532). */
export const TREND_UNITS: Record<TrendNumber, string | undefined> = {
  yieldAgainstTarget: "g",
  duration: "s",
  stoppedAtTarget: "%",
  ratio: undefined,
  peakPressure: "bar",
  peakFlow: "ml/s",
  rating: "stars",
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
 * numbers cover. A rating's value and band are in stars, each two points of
 * the rating the summary gives (#532).
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
    if (isShare(number)) {
      const share = bucket.numbers[number];
      return share && share.share !== null ? [{ ...point, value: share.share * 100, shots: share.shots }] : [];
    }
    const { shots, median, p25, p75 } = bucket.numbers[number] ?? ({ shots: 0, median: null, p25: null, p75: null } satisfies SummaryNumber);
    if (median === null || p25 === null || p75 === null) return [];
    if (number === "rating") return [{ ...point, value: starsOf(median), band: [starsOf(p25), starsOf(p75)], shots }];
    return [{ ...point, value: median, band: [p25, p75], shots }];
  });
}

/**
 * A day or week of a trend of several lines, as its chart reads one: `at`
 * and `start` as a point's, and each line's point of it, in the lines'
 * order, none for a line with no value then.
 */
export interface TrendRow {
  start: string;
  at: number;
  points: (TrendPoint | undefined)[];
}

/**
 * The lines of a trend, each its points, as the rows of one chart, oldest
 * first: one for each day or week any line has a point of.
 */
export function trendRows(lines: readonly (readonly TrendPoint[])[]): TrendRow[] {
  const rows = new Map<number, TrendRow>();
  lines.forEach((points, line) => {
    for (const point of points) {
      const row = rows.get(point.at) ?? { start: point.start, at: point.at, points: lines.map(() => undefined) };
      row.points[line] = point;
      rows.set(point.at, row);
    }
  });
  return [...rows.values()].sort((a, b) => a.at - b.at);
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
export function axisSpan(points: readonly Pick<TrendPoint, "at">[], bucket: Bucket): [number, number] {
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
 * range, as the Shots list's summary shows one, a rating's in stars, as its
 * point holds it, or a share as a whole percentage, which has no range.
 */
export function pointText(point: Pick<TrendPoint, "value" | "band">, number: TrendNumber): { value: string; range?: string } {
  if (isShare(number) || !point.band) return { value: shareText(point.value / 100)! };
  const text = number === "rating" ? starsMedianText(point.value, point.band) : MEDIAN_TEXT[number]({ shots: 1, median: point.value, p25: point.band[0], p75: point.band[1] })!;
  return { value: text.median, range: text.range };
}

/**
 * Where a trend's chart keeps its plot, in pixels, which its marks are
 * placed by: the value axis's width at its left, the margin at its right,
 * the room the time axis leaves at each end for the first and last dots,
 * the time axis's own height under it, and, over it, the margin a chart
 * with no marks has (`top`) and the taller one that holds a marked chart's
 * labels (`labels`).
 */
export const PLOT = { left: 44, right: 8, pad: 12, bottom: 30, top: 8, labels: 28 } as const;

/**
 * A Bean Batch a Trend of one Recipe is marked with (#733): the first day,
 * or week, in which a Shot the Trend charts was pulled with it, as `start`,
 * a date, and `at`, its count of days. `earliest` is the batch of the
 * chart's earliest Shots, which is labelled at the chart's left edge and has
 * no line.
 */
export interface BatchMark {
  batch: BatchLink;
  start: string;
  at: number;
  earliest: boolean;
}

/**
 * A Trend's marks, oldest first, from a Shot Summary of its Shots grouped by
 * Bean Batch by day or week: one for each batch, where it is first used,
 * however often the bar goes back to it. Shots linked to no batch make no
 * mark, and a batch first used after some of them is not the earliest's, so
 * it has a line. Cleaning, calibration and Unfinished Shots,
 * which the Trend leaves out, and Shots whose time is unknown, mark nothing.
 * The previous release's answer, with no buckets, marks nothing (ADR-0025).
 */
export function batchMarks(groups: readonly Pick<BucketedGroup, "by" | "buckets">[]): BatchMark[] {
  const firstOf = (group: Pick<BucketedGroup, "buckets">) => group.buckets?.find((bucket) => bucket.start !== null && bucket.counts.shots > 0)?.start ?? undefined;
  const marks = groups.flatMap((group): BatchMark[] => {
    const start = firstOf(group);
    return group.by.beanBatch && start !== undefined ? [{ batch: group.by.beanBatch, start, at: dayNumber(start), earliest: false }] : [];
  });
  // Batches first used on one day stand in the order they were roasted.
  marks.sort((a, b) => a.at - b.at || (a.batch.roastDate ?? "").localeCompare(b.batch.roastDate ?? "") || a.batch.id.localeCompare(b.batch.id));
  const unlinked = groups.flatMap((group) => (group.by.beanBatch ? [] : [firstOf(group)])).flatMap((start) => (start === undefined ? [] : [dayNumber(start)]));
  const [first] = marks;
  if (first && unlinked.every((at) => at >= first.at)) first.earliest = true;
  return marks;
}

/** What a mark's label reads: its batch's Batch Code, or "roasted 10 Nov" where it has none. */
export function markLabel(batch: Pick<BatchLink, "roastDate" | "batchCode">, now: Date = new Date()): { text: string; code: boolean } {
  const code = batchCodeOf(batch);
  return code === undefined ? { text: roastedText(batch, now), code: false } : { text: code, code: true };
}

/**
 * What stands before a batch in the list under the chart: "From 21 Nov",
 * the first day it was used, or "From the week of 16 Nov", and "Until then"
 * for the batch of the chart's earliest Shots where another follows it.
 */
export function markLead(mark: BatchMark, marks: readonly BatchMark[], bucket: Bucket, now: Date = new Date()): string {
  if (mark.earliest && marks.length > 1) return "Until then";
  const day = recordedDayText(mark.start, now) ?? mark.start;
  return bucket === "week" ? `From the week of ${day}` : `From ${day}`;
}

/**
 * How a chart over a span of days draws its marks: `edge`, the batch
 * labelled at its left edge, which is that of its earliest Shots, or the
 * last one first used before the span; and `lines`, those with a line on
 * their first day or week within it. A batch first used beyond either end
 * is drawn nowhere, and the list under the chart still names it.
 */
export function drawnMarks(marks: readonly BatchMark[], [from, until]: readonly [number, number]): { edge?: BatchMark; lines: BatchMark[] } {
  const before = marks.filter((mark) => mark.at < from);
  const edge = before.at(-1) ?? (marks[0]?.earliest ? marks[0] : undefined);
  return { ...(edge && { edge }), lines: marks.filter((mark) => mark !== edge && mark.at >= from && mark.at <= until) };
}

/** A mark's label as wide as its text needs, in pixels: a Batch Code in monospace, or a roast day in the page's own type, at 13 px, in its chip. */
export function labelWidth(label: { text: string; code: boolean }): number {
  return Math.ceil(label.text.length * (label.code ? 8 : 7)) + 14;
}

/** How far a mark's label stands from its line, and one label from the next, in pixels. */
const LABEL_GAP = 5;

/**
 * Where a chart `width` pixels wide writes its marks' labels, each by its
 * left edge, in pixels from the chart's: the edge's label at the plot's
 * left, and each line's label right of its line at the top, or left of it
 * where the chart ends first. A label that would be drawn over another is
 * left out, the earlier of them kept, and so is one the chart has no room
 * for. `x` is each line's place: `lineX`.
 */
export function labelPlaces(drawn: { edge?: BatchMark; lines: readonly BatchMark[] }, span: readonly [number, number], width: number, now: Date = new Date()): { mark: BatchMark; text: string; code: boolean; left: number; width: number }[] {
  const placed: { mark: BatchMark; text: string; code: boolean; left: number; width: number }[] = [];
  const clear = (left: number, wide: number) => left >= PLOT.left && left + wide <= width && placed.every((other) => left >= other.left + other.width + LABEL_GAP || left + wide + LABEL_GAP <= other.left);
  if (drawn.edge) {
    const label = markLabel(drawn.edge.batch, now);
    const wide = labelWidth(label);
    if (clear(PLOT.left, wide)) placed.push({ mark: drawn.edge, ...label, left: PLOT.left, width: wide });
  }
  for (const mark of drawn.lines) {
    const label = markLabel(mark.batch, now);
    const wide = labelWidth(label);
    const x = lineX(mark.at, span, width);
    const left = x + LABEL_GAP + wide <= width ? x + LABEL_GAP : x - LABEL_GAP - wide;
    if (clear(left, wide)) placed.push({ mark, ...label, left, width: wide });
  }
  return placed;
}

/** Where a day stands across a chart `width` pixels wide whose time axis runs over `span`, in pixels from the chart's left, as the chart's own scale puts it. */
export function lineX(at: number, [from, until]: readonly [number, number], width: number): number {
  const first = PLOT.left + PLOT.pad;
  const last = width - PLOT.right - PLOT.pad;
  return until === from ? first : first + ((last - first) * (at - from)) / (until - from);
}
