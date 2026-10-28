import { Prisma } from "./generated/prisma/client.js";
import { readLocationId } from "./locations/input.js";
import { readMachineId, readPendingMachineId } from "./machines/input.js";

/**
 * What a list of Shots or Steam Records is narrowed to by the filters both
 * have: the Machine or Pending Machine a record is credited to, its Location,
 * and wall-clock times, read in each record's own Location's time zone, or
 * UTC for a record without one.
 */
export interface RecordFilters {
  machineId?: string;
  pendingMachineId?: string;
  /** A Location's id, or null for records whose Location is unknown. */
  locationId?: string | null;
  /** Recorded at or after this local time, as `YYYY-MM-DDTHH:MM:SS`. */
  from?: string;
  /** Recorded before this local time, as `YYYY-MM-DDTHH:MM:SS`. */
  until?: string;
}

const LOCAL_TIME = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?$/;

/** A query parameter, if given; given more than once, it is a problem. */
export function queryValue(query: Record<string, unknown>, name: string, problems: string[]): string | undefined {
  const given = query[name];
  if (given === undefined) return undefined;
  if (typeof given === "string") return given;
  problems.push(`Give ${name} once`);
  return undefined;
}

/**
 * Reads the filters every record list has from its query, adding what is
 * wrong with them to `problems`, for the caller to refuse with its own. A
 * malformed Machine, Pending Machine or Location id names nothing, as in a
 * path. `from` and `to` are a local date (`2026-10-05`) or date and time
 * (`2026-10-05T06:00`), without an offset: `from` is the first moment listed,
 * and `to` the first moment after them, except that a date alone lists the
 * whole of that day.
 */
export function readRecordFilters(query: Record<string, unknown>, problems: string[]): RecordFilters {
  const filters: RecordFilters = {};

  const machineId = queryValue(query, "machineId", problems);
  if (machineId !== undefined) filters.machineId = readMachineId(machineId);
  const pendingMachineId = queryValue(query, "pendingMachineId", problems);
  if (pendingMachineId !== undefined) filters.pendingMachineId = readPendingMachineId(pendingMachineId);
  const locationId = queryValue(query, "locationId", problems);
  if (locationId !== undefined) filters.locationId = locationId === "none" ? null : readLocationId(locationId);

  const from = queryValue(query, "from", problems);
  const to = queryValue(query, "to", problems);
  if (from !== undefined) {
    const time = localTime(from);
    if (time) filters.from = time.start;
    else problems.push("Enter from as a date, such as 2026-10-05, or a date and time, such as 2026-10-05T06:00");
  }
  if (to !== undefined) {
    const time = localTime(to);
    if (time) filters.until = time.dateOnly ? nextDay(time.start) : time.start;
    else problems.push("Enter to as a date, such as 2026-10-05, or a date and time, such as 2026-10-05T12:00");
  }
  if (filters.from !== undefined && filters.until !== undefined && filters.until <= filters.from) {
    problems.push("Choose an end after the start");
  }
  return filters;
}

/**
 * The conditions for the filters, on a record table aliased `alias` whose
 * time is the column `time`, joined to its Location as `l`. Both names are
 * written into the query as given, so they are never input. Times compare the
 * record's time on its Location's wall clock with the times given, so a day
 * is that Location's day, 23 or 25 hours long across a daylight-saving
 * change, and an hour the clocks repeat is listed twice. A record whose time
 * is unknown matches no time.
 */
export function recordFilterSql(filters: RecordFilters, alias: string, time: string): Prisma.Sql {
  const column = (name: string) => Prisma.raw(`${alias}.${name}`);
  const conditions: Prisma.Sql[] = [];
  if (filters.machineId !== undefined) conditions.push(Prisma.sql`${column("machine_id")} = ${filters.machineId}::uuid`);
  if (filters.pendingMachineId !== undefined) conditions.push(Prisma.sql`${column("pending_machine_id")} = ${filters.pendingMachineId}::uuid`);
  if (filters.locationId === null) conditions.push(Prisma.sql`${column("location_id")} IS NULL`);
  else if (filters.locationId !== undefined) conditions.push(Prisma.sql`${column("location_id")} = ${filters.locationId}::uuid`);

  // No zone is 24 hours ahead of UTC or behind it, so these bounds let the index on the time narrow the rows
  // first. They are hours, not a day: a timestamptz's day follows the session's time zone, whose calendar
  // may skip one, as Samoa's did in 2011.
  const at = column(time);
  const local = Prisma.sql`(${at} AT TIME ZONE coalesce(l.time_zone, 'UTC'))`;
  if (filters.from !== undefined) {
    conditions.push(Prisma.sql`${at} >= (${filters.from}::timestamp AT TIME ZONE 'UTC') - interval '24 hours'`);
    conditions.push(Prisma.sql`${local} >= ${filters.from}::timestamp`);
  }
  if (filters.until !== undefined) {
    conditions.push(Prisma.sql`${at} < (${filters.until}::timestamp AT TIME ZONE 'UTC') + interval '24 hours'`);
    conditions.push(Prisma.sql`${local} < ${filters.until}::timestamp`);
  }
  return conditions.length === 0 ? Prisma.sql`TRUE` : Prisma.join(conditions, " AND ");
}

/** A local date or date and time as `YYYY-MM-DDTHH:MM:SS`, if it names one the calendar has. */
function localTime(value: string): { start: string; dateOnly: boolean } | undefined {
  const match = LOCAL_TIME.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const daysInMonth = utcDate(year!, month!, 0).getUTCDate();
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth || hour! > 23 || minute! > 59 || second! > 59) {
    return undefined;
  }
  return {
    start: `${pad(year!, 4)}-${pad(month!)}-${pad(day!)}T${pad(hour!)}:${pad(minute!)}:${pad(second!)}`,
    dateOnly: match[4] === undefined,
  };
}

/** The start of the day after a local time's day. */
function nextDay(start: string): string {
  const [year, month, day] = start.slice(0, 10).split("-").map(Number);
  const next = utcDate(year!, month! - 1, day! + 1);
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T00:00:00`;
}

/** A UTC date, with days past a month's end rolled over; unlike Date.UTC, years before 100 stay as given. */
function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function pad(part: number, length = 2): string {
  return String(part).padStart(length, "0");
}
