import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { readLocationId } from "../locations/input.js";
import { readMachineId, readPendingMachineId } from "../machines/input.js";

/**
 * What a Shots list is narrowed to. Each text filter is an exact match on
 * what the Shot recorded, or, when empty, matches Shots that recorded none.
 * `from` and `until` are wall-clock times, read in each Shot's own
 * Location's time zone, or UTC for a Shot without one.
 */
export interface ShotFilters {
  machineId?: string;
  pendingMachineId?: string;
  /** A Location's id, or null for Shots whose Location is unknown. */
  locationId?: string | null;
  coffeeRoaster?: string;
  coffeeName?: string;
  barista?: string;
  profileTitle?: string;
  /** Pulled at or after this local time, as `YYYY-MM-DDTHH:MM:SS`. */
  from?: string;
  /** Pulled before this local time, as `YYYY-MM-DDTHH:MM:SS`. */
  until?: string;
}

const TEXT_FILTERS = ["coffeeRoaster", "coffeeName", "barista", "profileTitle"] as const;
const LOCAL_TIME = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?$/;
const MAX_TEXT_LENGTH = 500;

/**
 * Reads a Shots list's filters from its query. A malformed Machine, Pending
 * Machine or Location id names nothing, as in a path. `from` and `to` are a
 * local date (`2026-10-05`) or date and time (`2026-10-05T06:00`), without an
 * offset: `from` is the first moment listed, and `to` the first moment after
 * them, except that a date alone lists the whole of that day.
 */
export function readShotFilters(query: Record<string, unknown>): ShotFilters {
  const problems: string[] = [];
  const value = (name: string): string | undefined => {
    const given = query[name];
    if (given === undefined) return undefined;
    if (typeof given === "string") return given;
    problems.push(`Give ${name} once`);
    return undefined;
  };
  const filters: ShotFilters = {};

  const machineId = value("machineId");
  if (machineId !== undefined) filters.machineId = readMachineId(machineId);
  const pendingMachineId = value("pendingMachineId");
  if (pendingMachineId !== undefined) filters.pendingMachineId = readPendingMachineId(pendingMachineId);
  const locationId = value("locationId");
  if (locationId !== undefined) filters.locationId = locationId === "none" ? null : readLocationId(locationId);

  for (const name of TEXT_FILTERS) {
    const text = value(name);
    if (text === undefined) continue;
    if (text.length > MAX_TEXT_LENGTH) problems.push(`Use a ${name} of at most ${MAX_TEXT_LENGTH} characters`);
    else filters[name] = text;
  }

  const from = value("from");
  const to = value("to");
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

  if (problems.length > 0) throw new BadRequestException(problems);
  return filters;
}

/**
 * The conditions for the filters, on `shots` aliased `s` joined to its
 * Location as `l`. Times compare the Shot's pulled-at time on its Location's
 * wall clock with the times given, so a day is that Location's day, 23 or 25
 * hours long across a daylight-saving change, and an hour the clocks repeat
 * is listed twice. A Shot whose time is unknown matches no time.
 */
export function shotFilterSql(filters: ShotFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filters.machineId !== undefined) conditions.push(Prisma.sql`s.machine_id = ${filters.machineId}::uuid`);
  if (filters.pendingMachineId !== undefined) conditions.push(Prisma.sql`s.pending_machine_id = ${filters.pendingMachineId}::uuid`);
  if (filters.locationId === null) conditions.push(Prisma.sql`s.location_id IS NULL`);
  else if (filters.locationId !== undefined) conditions.push(Prisma.sql`s.location_id = ${filters.locationId}::uuid`);

  for (const [name, column] of [
    ["coffeeRoaster", "coffee_roaster"],
    ["coffeeName", "coffee_name"],
    ["barista", "barista"],
    ["profileTitle", "profile_title"],
  ] as const) {
    const text = filters[name];
    if (text === undefined) continue;
    const field = Prisma.raw(`s.${column}`);
    conditions.push(text === "" ? Prisma.sql`nullif(${field}, '') IS NULL` : Prisma.sql`${field} = ${text}`);
  }

  // No zone is a day ahead of UTC or behind it, so these bounds let the pulled-at index narrow the rows first.
  const local = Prisma.sql`(s.pulled_at AT TIME ZONE coalesce(l.time_zone, 'UTC'))`;
  if (filters.from !== undefined) {
    conditions.push(Prisma.sql`s.pulled_at >= (${filters.from}::timestamp AT TIME ZONE 'UTC') - interval '1 day'`);
    conditions.push(Prisma.sql`${local} >= ${filters.from}::timestamp`);
  }
  if (filters.until !== undefined) {
    conditions.push(Prisma.sql`s.pulled_at < (${filters.until}::timestamp AT TIME ZONE 'UTC') + interval '1 day'`);
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
