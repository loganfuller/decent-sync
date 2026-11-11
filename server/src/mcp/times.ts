import { BadRequestException } from "@nestjs/common";
import * as z from "zod";
import type { RecordFilters } from "../record-filters.js";

// Times through the MCP endpoint (#405): they go in and out as ISO 8601 with
// offsets, and a date given for a day means each Location's day in its own
// time zone, as the REST API's record lists read one.

const DAY = /^\d{4}-\d\d-\d\d$/;
/** A moment PostgreSQL reads, which ISO 8601 alone doesn't bound: from year 1, with an offset of at most 15:59. */
const MOMENT = /^(?!0000)\d{4}-.*(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/;

/** What a date given for a record list's bound means. */
const RECORDS_DAY = "A date, such as 2026-11-06, is that day at each Location, in its own time zone, and in UTC for a record whose Location is unknown.";

/** A time range's bound: a date, for each Location's day (`day` says whose), or a moment with its offset. */
export function timeBound(description: string, day = RECORDS_DAY) {
  return z
    .union([z.iso.date(), z.iso.datetime({ offset: true })], {
      error: "Enter a date, such as 2026-11-06, or a time with its seconds and offset, such as 2026-11-06T14:30:00-05:00",
    })
    .optional()
    .describe(`${description} ${day} A time with its offset, such as 2026-11-06T14:30:00-05:00, is that moment everywhere.`);
}

/**
 * The bounds of a record list's time range, as its filters: a date as the
 * REST API's filters read it (`readRecordFilters`), from the start of that
 * day at each record's Location, and `to` through its end; a moment as
 * itself, `from` at or after it and `to` before it.
 */
export function timeRange(from: string | undefined, to: string | undefined): { query: Record<string, string>; filters: Pick<RecordFilters, "fromAt" | "untilAt"> } {
  const query: Record<string, string> = {};
  const filters: Pick<RecordFilters, "fromAt" | "untilAt"> = {};
  if (from !== undefined) {
    if (DAY.test(from)) query.from = from;
    else filters.fromAt = moment("from", from);
  }
  if (to !== undefined) {
    if (DAY.test(to)) query.to = to;
    else filters.untilAt = moment("to", to);
  }
  if (filters.fromAt !== undefined && filters.untilAt !== undefined && Date.parse(filters.untilAt) <= Date.parse(filters.fromAt)) {
    throw new BadRequestException("Choose an end after the start");
  }
  return { query, filters };
}

/** A moment as given, if PostgreSQL reads it; otherwise refused, as the REST API refuses a time it can't read. */
function moment(name: string, value: string): string {
  if (MOMENT.test(value)) return value;
  throw new BadRequestException(`Enter ${name} as a time from year 1 with an offset of at most 15:59, such as 2026-11-06T14:30:00-05:00, or as a date`);
}

/**
 * A moment as ISO 8601 with the offset its Location's time zone had then, to
 * the millisecond, so it reads as that Location's wall clock; with UTC's for
 * a record whose Location is unknown, as the management interface shows it,
 * or whose zone this runtime doesn't know.
 */
export function zonedTime(at: Date, timeZone: string | null | undefined): string {
  if (!timeZone) return at.toISOString();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = zoned(timeZone).formatToParts(at);
  } catch {
    return at.toISOString();
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((found) => found.type === type)?.value ?? "";
  // "GMT" for an offset of zero, otherwise "GMT-05:00"; a zone's local mean time, before standard time, has seconds too.
  const offset = part("timeZoneName").replace(/^GMT/, "") || "+00:00";
  if (!/^[+-]\d\d:\d\d$/.test(offset)) return at.toISOString();
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")}${offset}`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** A format for a time zone's wall clock and offset, made once per zone; one Intl doesn't know throws a RangeError. */
function zoned(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    formats.set(timeZone, format);
  }
  return format;
}
