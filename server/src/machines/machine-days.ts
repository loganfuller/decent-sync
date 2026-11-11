import { BadRequestException } from "@nestjs/common";
import { queryValue } from "../record-filters.js";
import { readTime } from "./input.js";

// A Machine's days: a day or an hour of a Machine is that of the Location it
// was at then, by its Location History, in that Location's time zone, and
// UTC's while it was at none. What reads a range of a Machine's activity, or
// counts its use by day or hour, reads its days here.

/**
 * A stay of a Machine's Location History, as its days are read from it: from
 * when it was at a Location, in milliseconds, and that Location's time zone.
 * It lasted until the next one's start.
 */
export interface Stay {
  from: number;
  timeZone: string;
}

/** A Machine's stays, oldest first, from its Location History, oldest first, as the REST API gives it. */
export function staysOf(history: readonly { effectiveFrom: string; location: { timeZone: string } }[]): Stay[] {
  return history.map((entry) => ({ from: Date.parse(entry.effectiveFrom), timeZone: entry.location.timeZone }));
}

/** The time zone of the Location the Machine was at, at a moment, by its stays, oldest first; null before its first. */
export function timeZoneAt(stays: readonly Stay[], at: number): string | null {
  let found: string | null = null;
  for (const stay of stays) {
    if (stay.from > at) break;
    found = stay.timeZone;
  }
  return found;
}

const DAY = /^\d{4}-\d\d-\d\d$/;

/** Whether a bound is a date, for a day, rather than a moment. */
export function isDay(bound: string): boolean {
  return DAY.test(bound);
}

/** Whether a date names a day the calendar has. */
function isCalendarDay(day: string): boolean {
  try {
    Temporal.PlainDate.from(day);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bound of a range of a Machine's activity or use, `from` or `to`, as a
 * REST query gives it, for `rangeBound` to read: a date, such as 2026-11-06,
 * or a time with its offset. Undefined if it isn't given; one that is
 * neither, or given more than once, is added to `problems`.
 */
export function readRangeBound(query: Record<string, unknown>, name: "from" | "to", problems: string[]): string | undefined {
  const value = queryValue(query, name, problems);
  if (value === undefined || (isDay(value) ? isCalendarDay(value) : readTime(value, []) !== undefined)) return value;
  problems.push(`Enter ${name} as a date, such as 2026-11-06, or a time with its offset, such as 2026-11-06T14:30:00-05:00`);
  return undefined;
}

/**
 * When a day, or the day `days` after it, began in a time zone, UTC's for
 * none or for a zone this runtime doesn't know: its first moment, which
 * daylight saving time may move from midnight.
 */
export function startOfDay(day: string, timeZone: string | null | undefined, days = 0): Date {
  const date = Temporal.PlainDate.from(day).add({ days });
  try {
    return new Date(date.toZonedDateTime(timeZone ?? "UTC").epochMilliseconds);
  } catch {
    return new Date(date.toZonedDateTime("UTC").epochMilliseconds);
  }
}

/**
 * A bound of a range of the Machine's activity as a moment: one given with
 * its offset as itself, and a date as when that day began at the Location
 * the Machine was at, or for an end the day after it, through its end, in
 * UTC while it was at none. The day's Location is the one it was at at noon
 * UTC that day, within the day nearly everywhere, which differs only on a
 * day it moved between time zones.
 */
export function rangeBound(bound: string, stays: readonly Stay[], end: boolean): Date {
  if (!isDay(bound)) return new Date(bound);
  return startOfDay(bound, timeZoneAt(stays, Date.parse(`${bound}T12:00:00Z`)), end ? 1 : 0);
}

/**
 * A range of a Machine's activity from its bounds (`rangeBound`), an end
 * left open, as null, where none is given: refused if a bound is outside the
 * years PostgreSQL reads, or if it ends at or before its start.
 */
export function machineRange(from: string | undefined, to: string | undefined, stays: readonly Stay[]): { from: Date | null; to: Date | null } {
  const range = { from: from === undefined ? null : rangeBound(from, stays, false), to: to === undefined ? null : rangeBound(to, stays, true) };
  // PostgreSQL has no year 0, and doesn't parse the six-digit year toISOString writes past 9999 or before 1.
  if ([range.from, range.to].some((end) => end && !(end.getUTCFullYear() >= 1 && end.getUTCFullYear() <= 9999))) {
    throw new BadRequestException("Times must be in the years 1 to 9999, in UTC");
  }
  if (range.from && range.to && range.from >= range.to) throw new BadRequestException("Choose an end after the start");
  return range;
}
