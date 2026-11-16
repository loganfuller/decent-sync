import type { SummaryGroup } from "@/lib/api";
import { dateIn } from "./machine-activity";
import { type MedianText, durationText, shareText, yieldAgainstTargetText } from "./shot-summary";
import { type SpecLine, cellLines } from "./overview";
import { type TrendNumber, dateOf, dayNumber } from "./shot-trend";

// A Recipe's numbers on its page (#474, #547): the pure parts, which work
// out the trend's days at its Location, read the number its address keeps,
// address a Machine's Shots of it in the Shots list, and word a Machine's
// numbers with what the server judged out of spec.

/** How many days a Recipe's trend covers, today the last. */
export const TREND_DAYS = 30;

/** The Shots list's date preset of the trend's days. */
export const TREND_PRESET = "30days";

/** The numbers a Recipe's trend charts, one at a time, in the order it offers them: the first until another is chosen. */
export const RECIPE_TRENDS = ["duration", "yieldAgainstTarget", "grindSetting"] as const satisfies readonly TrendNumber[];
export type RecipeTrend = (typeof RECIPE_TRENDS)[number];

/** The number an address's `trend` names: duration where it names none, or one a Recipe's trend doesn't chart. */
export function recipeTrend(param: string | null): RecipeTrend {
  return RECIPE_TRENDS.find((name) => name === param) ?? RECIPE_TRENDS[0];
}

/**
 * A Recipe's trend's days, by the wall clock now of its Location's time
 * zone, or UTC's for a Recipe at none: the `TREND_DAYS` that end with
 * today, as the Shots list's `from` and `to` take them.
 */
export function trendDays(timeZone: string | undefined, now = Date.now()): { from: string; to: string } {
  const today = dateIn(timeZone, now);
  return { from: dateOf(dayNumber(today) - (TREND_DAYS - 1)), to: today };
}

/**
 * The Shots list's address for a Machine's Shots of a Recipe over a period:
 * the Recipe, the Machine and the list's date preset of the period's days
 * (`preset`) as its filters, so the Shots it finds are those the numbers
 * are of. With `trend`, the list's own trend is open, charting that number
 * of them.
 */
export function machineShotsPath(recipeId: string, machineId: string, preset: string, trend?: TrendNumber): string {
  const query = new URLSearchParams({ recipeId, machineId, period: preset });
  if (trend) query.set("trend", trend);
  return `/shots?${query}`;
}

/** A number of a Machine's Shots as its row says it, marked where the server judged it out of spec. */
export interface Judged {
  text: string;
  marked: boolean;
}

/**
 * A Machine's Shots of a Recipe over a period, as its row of By Machine
 * says them (#547), from a Shot Summary's group and the server's judgement
 * of it (#543):
 * - `duration`, their median duration, with the range the middle half fall in;
 * - `against`, the median's difference from the Recipe's Reference Shot's,
 *   where there is one: marked when out of spec, and muted otherwise;
 * - `yield`, the median of each Shot's yield against its own target, and
 *   `stopping`, the share stopped at target, each marked when out of spec;
 * - `leftOut`, the Unfinished Shots and the cleaning and calibration Shots
 *   the numbers leave out.
 * The previous release's answer during a deploy judges nothing and counts
 * no stops at target (ADR-0025), so nothing of it is marked.
 */
export function machineNumbers(group: SummaryGroup): { duration?: MedianText; against?: SpecLine; yield?: Judged; stopping?: Judged; leftOut: string[] } {
  const { numbers, spec } = group;
  const lines = cellLines(group);
  const against = numbers.yieldAgainstTarget && yieldAgainstTargetText(numbers.yieldAgainstTarget)?.median;
  const share = numbers.stoppedAtTarget && shareText(numbers.stoppedAtTarget.share);
  return {
    duration: numbers.duration && durationText(numbers.duration),
    against: lines.duration,
    ...(against && { yield: { text: against, marked: spec?.yield.judgement === "outOfSpec" } }),
    ...(share && { stopping: { text: share, marked: spec?.stoppedAtTarget.judgement === "outOfSpec" } }),
    leftOut: lines.leftOut,
  };
}
