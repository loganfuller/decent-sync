import type { ListedShot, ShotSpec } from "@/lib/api";
import { dateIn } from "./machine-activity";
import { starsText } from "./rating";
import { signedText } from "./shot-summary";
import { stopWords } from "./stops";
import { dayNumber } from "./shot-trend";

// The Shots list's rows (#544): the pure parts, which put a page of Shots
// under a heading for each day, word a Shot's time, differences and stop,
// and name what its rating filter is set to.

/** The time zone a Shot's day and time are read in: its Location's, or UTC for a Shot with none. */
function zoneOf(shot: Pick<ListedShot, "location">): string {
  return shot.location?.timeZone ?? "UTC";
}

/** A date, such as 2026-11-15, as a moment its parts can be formatted from in UTC. */
function atDate(date: string): Date {
  return new Date(dayNumber(date) * 86_400_000);
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short" });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

/**
 * What heads a day's Shots: the day, such as "Sat Nov 14", with its year
 * where that isn't `today`'s, and today and yesterday named so, as "Today,
 * Sun Nov 15". `today` is the date now where the day is read.
 */
export function dayHeading(day: string, today: string): string {
  const at = atDate(day);
  const date = `${WEEKDAY.format(at)} ${(day.slice(0, 4) === today.slice(0, 4) ? MONTH_DAY : MONTH_DAY_YEAR).format(at)}`;
  const back = dayNumber(today) - dayNumber(day);
  return back === 0 ? `Today, ${date}` : back === 1 ? `Yesterday, ${date}` : date;
}

/** What heads the Shots whose time is unknown, which are in no day. */
export const UNTIMED = "Time not known";

/** Some of a page's Shots under one heading, in the page's order. */
export interface DayGroup<Shot> {
  heading: string;
  shots: Shot[];
}

/**
 * A page of Shots, in its order, under a heading for each day: each Shot's
 * own Location's day, on that Location's wall clock, or UTC's for a Shot
 * with none, as the list's date filters read one, with today and yesterday
 * named by that Location's own today. The list is in the order the Shots
 * were pulled, whatever their Locations, so the Shots under a heading are
 * those in a row that share it: where Locations whose calendars differ
 * pulled Shots in turn, a heading comes again rather than moving a Shot out
 * of its place.
 */
export function dayGroups<Shot extends Pick<ListedShot, "pulledAt" | "location">>(shots: readonly Shot[], now = Date.now()): DayGroup<Shot>[] {
  const groups: DayGroup<Shot>[] = [];
  for (const shot of shots) {
    const zone = zoneOf(shot);
    const heading = shot.pulledAt === null ? UNTIMED : dayHeading(dateIn(zone, Date.parse(shot.pulledAt)), dateIn(zone, now));
    const last = groups.at(-1);
    if (last?.heading === heading) last.shots.push(shot);
    else groups.push({ heading, shots: [shot] });
  }
  return groups;
}

const TIMES = new Map<string, Intl.DateTimeFormat>();

/** When a Shot was pulled, as a time of its day on its Location's wall clock, such as "1:21 PM": its day heads it. */
export function timeOfDay(shot: Pick<ListedShot, "pulledAt" | "location">): string {
  if (shot.pulledAt === null) return UNTIMED;
  const zone = zoneOf(shot);
  let format = TIMES.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" });
    TIMES.set(zone, format);
  }
  return format.format(new Date(shot.pulledAt));
}

/** How far a number of one Shot is from what it is measured against, as its row says it beside the number: marked when out of spec, muted otherwise. */
export interface Difference {
  text: string;
  marked: boolean;
}

/** A Shot's yield against its own target, as its row says it: none where the server judged none, as of an Unfinished Shot. */
export function yieldDifference(spec: ShotSpec | undefined): Difference | undefined {
  return spec?.yield ? { text: `${signedText(spec.yield.againstTarget)} g`, marked: spec.yield.outOfSpec } : undefined;
}

/** A Shot's duration against its Recipe's Reference Shot's, as its row says it: none where its Recipe has no such Shot. */
export function durationDifference(spec: ShotSpec | undefined): Difference | undefined {
  return spec?.duration ? { text: `${signedText(spec.duration.difference)} s`, marked: spec.duration.outOfSpec } : undefined;
}

/**
 * How a Shot stopped, in words, where it was not at its target: "stopped by
 * hand", "ended by the Machine", "stopped by an error", or, for a reason of
 * no kind, the reason as recorded. None for one stopped at its target, one
 * that recorded no reason, and from the previous release's answer during a
 * deploy, which gives no kind (ADR-0025).
 */
export function stopNote(spec: ShotSpec | undefined, reason: string | null): string | undefined {
  const kind = spec?.stopped;
  if (kind === undefined || kind === null || kind === "targetWeight" || kind === "targetVolume") return undefined;
  const words = stopWords(kind, reason);
  if (words === undefined) return undefined;
  return kind === "machineEnded" ? words : kind === "other" ? `stopped: ${words}` : `stopped ${words}`;
}

/** The rating filter's choices, as the REST API names them, in the order they are offered. */
export const RATINGS = ["rated", "unrated", "5", "4", "3", "2"] as const;

/** What a rating filter's choice is called: "Rated", "Not rated", "5 stars", or a least number of stars, as "4 stars or more". One this build doesn't know reads as it is. */
export function ratingChoiceText(rating: string): string {
  if (rating === "rated") return "Rated";
  if (rating === "unrated") return "Not rated";
  if (!(RATINGS as readonly string[]).includes(rating)) return rating;
  return rating === "5" ? starsText(5) : `${starsText(Number(rating))} or more`;
}

/** The Shots list's address for a Recipe's rated Shots, which "No reference" opens: those a Reference Shot is chosen from. */
export function ratedShotsPath(recipeId: string): string {
  return `/shots?${new URLSearchParams({ recipeId, rating: "rated" })}`;
}
