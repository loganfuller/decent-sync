import { dateIn } from "./machine-activity";
import { type TrendNumber, dateOf, dayNumber, trendParam } from "./shot-trend";

// A Recipe's numbers on its page (#474): the pure parts, which work out
// today and the trend's days at its Location, read the number its address
// keeps, and address a Machine's Shots of it in the Shots list.

/** How many days a Recipe's trend covers, today the last. */
export const TREND_DAYS = 30;

/** The numbers a Recipe's trend charts, one at a time, in the order it offers them: the first until another is chosen. */
export const RECIPE_TRENDS = ["duration", "yieldAgainstTarget", "grindSetting"] as const satisfies readonly TrendNumber[];
export type RecipeTrend = (typeof RECIPE_TRENDS)[number];

/** The number an address's `trend` names: duration where it names none, or one a Recipe's trend doesn't chart. */
export function recipeTrend(param: string | null): RecipeTrend {
  return RECIPE_TRENDS.find((name) => name === param) ?? RECIPE_TRENDS[0];
}

/**
 * A Recipe's days, by the wall clock now of its Location's time zone, or
 * UTC's for a Recipe at none: today, and the trend's days, the
 * `TREND_DAYS` that end with it, each as the Shots list's `from` and `to`
 * take one.
 */
export function recipeDays(timeZone: string | undefined, now = Date.now()): { today: string; trend: { from: string; to: string } } {
  const today = dateIn(timeZone, now);
  return { today, trend: { from: dateOf(dayNumber(today) - (TREND_DAYS - 1)), to: today } };
}

/**
 * The Shots list's address for a Machine's Shots of a Recipe over days: the
 * Recipe, the Machine and the days as its filters, so the Shots it finds
 * are those the numbers are of. With `trend`, the list's own trend charts
 * that number of them.
 */
export function machineShotsPath(recipeId: string, machineId: string, days: { from: string; to: string }, trend?: TrendNumber): string {
  const query = new URLSearchParams({ recipeId, machineId, from: days.from, to: days.to });
  const charted = trend && trendParam(trend);
  if (charted) query.set("trend", charted);
  return `/shots?${query}`;
}
