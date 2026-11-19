import { BadRequestException } from "@nestjs/common";
import { queryValue } from "../record-filters.js";
import { readTime } from "./input.js";

// A Machine's days: a day or an hour of a Machine is that of the Location it
// was at then, by its Location History, in that Location's time zone, the
// whole of the day it came to its first Location included, and UTC's before
// that day (`dayStays`). What reads a range of a Machine's activity, or
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

/**
 * A Machine's stays as its days are read, oldest first: the first from the
 * start of the day it came there, by that Location's clock, so that day is
 * wholly its first Location's, as the day of a Machine added there in the
 * evening west of UTC is, after midnight UTC (#587). Before it, the Machine
 * was at none, and its days are UTC's.
 */
export function dayStays(stays: readonly Stay[]): Stay[] {
  const [first, ...rest] = stays;
  if (!first) return [];
  let came: string;
  try {
    came = Temporal.Instant.fromEpochMilliseconds(first.from).toZonedDateTimeISO(first.timeZone).toPlainDate().toString();
  } catch {
    came = new Date(first.from).toISOString().slice(0, 10);
  }
  return [{ from: startOfDay(came, first.timeZone).getTime(), timeZone: first.timeZone }, ...rest];
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
 * UTC before the day it came to its first (`dayStays`). The day's Location
 * is the one it was at at noon UTC that day, within the day nearly
 * everywhere, which differs only on a day it moved between time zones.
 *
 * So a date holds the moments its use is counted under (`useSpans`): a day
 * before the one it came to its first Location on ends when that day began
 * there, which east of UTC is before midnight UTC, and that day begins when
 * the day began in UTC if that was sooner, as west of UTC, as its bucket
 * does.
 */
export function rangeBound(bound: string, stays: readonly Stay[], end: boolean): Date {
  if (!isDay(bound)) return new Date(bound);
  const days = dayStays(stays);
  const noon = Date.parse(`${bound}T12:00:00Z`);
  const came = days[0]?.from ?? Infinity;
  const utc = startOfDay(bound, null, end ? 1 : 0).getTime();
  if (noon < came) return new Date(Math.min(utc, came));
  if (!end && utc < came) return new Date(utc);
  return startOfDay(bound, timeZoneAt(days, noon), end ? 1 : 0);
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
