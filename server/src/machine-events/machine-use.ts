import { BadRequestException } from "@nestjs/common";
import { nameDecaidState } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { readTime } from "../machines/input.js";
import { type Stay, isDay, rangeBound, timeZoneAt } from "../machines/machine-days.js";
import { queryValue } from "../record-filters.js";

// A Machine's use (#475; #465, Machine Activity): for each day of a range, or
// each hour of a day, how many Shots, Steam Records, flushes and hot water
// pours it made and how long it spent in each Machine State, worked out as it
// is read from its Shots, Steam Records and stored Machine State changes.
// Nothing is stored for it.
//
// A day or an hour is that of the Location the Machine was at then, by its
// Location History, in that Location's time zone, and UTC's while it was at
// none (`useSpans`). A Machine State lasts until the next one reported, so a
// Machine whose tablet was off counts as in its last state until its tablet
// reports again: Monitoring's connection history (milestone 8) will correct
// that.

/** What a use is counted by: each day of its range, or each hour. */
export const USE_BYS = ["day", "hour"] as const;
export type UseBy = (typeof USE_BYS)[number];

/** The most days a use by day covers: a month, which an assistant reads whole within its budget (ADR-0028). */
export const MAX_USE_DAYS = 31;

/** How many days a use by day covers when no start is given: the day its range ends in and those before it. */
export const DEFAULT_USE_DAYS = 14;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The longest range of each kind, in milliseconds: by day, `MAX_USE_DAYS`
 * days and the hour a day gains as the clocks go back; by hour, 25 hours,
 * the longest a day is, as the clocks go back.
 */
const LONGEST: Record<UseBy, number> = { day: MAX_USE_DAYS * DAY + HOUR, hour: 25 * HOUR };

/**
 * What a use is asked for: its range, each bound a date, for a day at the
 * Location the Machine was at, or a moment with its offset (`rangeBound`),
 * and whether by day or by hour. With no end it runs until now; with no
 * start, from the start of the day it ends in, by hour, or of the day
 * `DEFAULT_USE_DAYS` days before that day's end, by day.
 */
export interface UseRequest {
  from?: string;
  to?: string;
  by: UseBy;
}

/** How long a Machine spent in one of Decaid's states, whatever its substates. */
export interface StateTime {
  /** Decaid's name for the state, such as `espresso` or `sleeping`. */
  state: string;
  /** The Machine State as the management interface names it, such as Pulling a shot or Asleep (`nameDecaidState`). */
  name: string;
  seconds: number;
}

/** A Machine's use in one day, or one hour of a day. */
export interface UseBucket {
  /** The day, as a date on the wall clock of the Location the Machine was at. */
  date: string;
  /** By hour, the hour of that day, 0 to 23. */
  hour?: number;
  /** The Shots credited to the Machine that were pulled in it, cleaning and calibration Shots included. */
  shots: number;
  /** The Steam Records credited to the Machine that were recorded in it. */
  steamRecords: number;
  /** The flushes that began in it: each a visit to Decaid's `flush`, a run of stored changes in that state. */
  flushes: number;
  /** The hot water pours that began in it: each a visit to Decaid's `hotWater`. */
  hotWaterPours: number;
  /** The time spent in each of Decaid's states in it, the longest first; a state it spent none in is left out. */
  states: StateTime[];
}

/** A Machine's use over a range, as the REST API returns it. */
export interface MachineUse {
  by: UseBy;
  /** The range's start. */
  from: string;
  /** The range's end, or now if that is sooner: nothing is counted after it. For a range still to come that is before its start. */
  to: string;
  /** Each day or hour of the range, oldest first, those with nothing counted included. */
  buckets: UseBucket[];
}

/**
 * Reads a use's request from a REST query: `from` and `to`, each a date,
 * such as 2026-11-06, or a time with its offset, and `by`, `day` unless
 * given.
 */
export function readUseRequest(query: Record<string, unknown>): UseRequest {
  const problems: string[] = [];
  const bound = (name: "from" | "to"): string | undefined => {
    const value = queryValue(query, name, problems);
    if (value === undefined || (isDay(value) ? isCalendarDay(value) : readTime(value, []) !== undefined)) return value;
    problems.push(`Enter ${name} as a date, such as 2026-11-06, or a time with its offset, such as 2026-11-06T14:30:00-05:00`);
    return undefined;
  };
  const from = bound("from");
  const to = bound("to");
  const by = queryValue(query, "by", problems) ?? "day";
  if (!(USE_BYS as readonly string[]).includes(by)) problems.push("Choose by as day or hour");
  if (problems.length > 0) throw new BadRequestException(problems);
  return { from, to, by: by as UseBy };
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
 * The range a request asks for, as moments in milliseconds, by the
 * Machine's stays and the time now: refused if the end it gives is at or
 * before its start, or it runs longer than `LONGEST` allows. One with no
 * end that starts after now ends before it starts: it is still to come.
 */
export function useRange({ from, to, by }: UseRequest, stays: readonly Stay[], now: number): { from: number; to: number } {
  const moment = (bound: string, end: boolean): number => {
    const at = rangeBound(bound, stays, end);
    // PostgreSQL has no year 0, and doesn't parse the six-digit year toISOString writes past 9999 or before 1.
    if (!Number.isFinite(at.getTime()) || at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) {
      throw new BadRequestException("Times must be in the years 1 to 9999, in UTC");
    }
    return at.getTime();
  };
  const end = to === undefined ? now : moment(to, true);
  // With no start, from the day the range's last moment is in, or the days before it too.
  const lastDay = zoned(end - 1, timeZoneAt(stays, end - 1)).toPlainDate();
  const start = moment(from ?? lastDay.subtract({ days: by === "day" ? DEFAULT_USE_DAYS - 1 : 0 }).toString(), false);
  if (to !== undefined && end <= start) throw new BadRequestException("Choose an end after the start");
  if (end - start > LONGEST[by]) {
    throw new BadRequestException(by === "day" ? `Choose a range of at most ${MAX_USE_DAYS} days` : "Choose a range of at most a day to read by hour");
  }
  return { from: start, to: end };
}

/** A span of time, in milliseconds, in one bucket: a bucket is every span of its day or hour. */
export interface UseSpan {
  from: number;
  to: number;
  /** The index of its bucket in the range's buckets. */
  bucket: number;
}

/**
 * A range cut into the days, or hours, of the Machine: each moment belongs
 * to the date, and hour, the wall clock read at the Location the Machine was
 * at then, UTC's before its first stay. The buckets are in the order of
 * their dates and hours, and the spans in the order of time.
 *
 * A bucket is nearly always one span. A day the clocks change in is one
 * bucket, 23 or 25 hours long, and the hour they repeat one bucket two hours
 * long. On a day the Machine moved between time zones each part of the day
 * goes by the Location it was at: a move west may bring a date, or an hour,
 * a second time, and both parts are that one bucket.
 */
export function useSpans(range: { from: number; to: number }, stays: readonly Stay[], by: UseBy): { buckets: Pick<UseBucket, "date" | "hour">[]; spans: UseSpan[] } {
  const unit = by === "day" ? DAY : HOUR;
  const labelled = new Map<string, { date: string; hour?: number; spans: Omit<UseSpan, "bucket">[] }>();
  const zones = [{ from: -Infinity, timeZone: null }, ...stays];
  zones.forEach(({ from, timeZone }, n) => {
    const end = Math.min(range.to, zones[n + 1]?.from ?? Infinity);
    for (let at = Math.max(range.from, from); at < end; ) {
      const wall = zoned(at, timeZone);
      // The wall clock's next midnight, or hour, at this offset, unless the zone's clocks change first.
      const offset = wall.offsetNanoseconds / 1_000_000;
      const edge = at + unit - ((((at + offset) % unit) + unit) % unit);
      const next = Math.min(edge, wall.getTimeZoneTransition("next")?.epochMilliseconds ?? Infinity, end);
      const date = wall.toPlainDate().toString();
      const label = by === "day" ? date : `${date}T${String(wall.hour).padStart(2, "0")}`;
      const bucket = labelled.get(label) ?? { date, ...(by === "hour" && { hour: wall.hour }), spans: [] };
      labelled.set(label, bucket);
      const last = bucket.spans.at(-1);
      if (last?.to === at) last.to = next;
      else bucket.spans.push({ from: at, to: next });
      at = next;
    }
  });
  const ordered = [...labelled.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, bucket]) => bucket);
  return {
    buckets: ordered.map(({ date, hour }) => ({ date, ...(hour !== undefined && { hour }) })),
    spans: ordered.flatMap((bucket, n) => bucket.spans.map((span) => ({ ...span, bucket: n }))).sort((a, b) => a.from - b.from),
  };
}

/** A moment on the wall clock of a time zone, UTC's for none or for one this runtime doesn't know. */
function zoned(at: number, timeZone: string | null): Temporal.ZonedDateTime {
  const instant = Temporal.Instant.fromEpochMilliseconds(at);
  try {
    return instant.toZonedDateTimeISO(timeZone ?? "UTC");
  } catch {
    return instant.toZonedDateTimeISO("UTC");
  }
}

/** One count or time of a bucket, as `readMachineUse` reads them. */
interface UseRow {
  kind: "seconds" | "visits" | "shots" | "steamRecords";
  bucket: number;
  state: string | null;
  value: number;
}

/**
 * The Machine's use over a range that ends at or before now, cut into
 * `spans`, in one statement, so its counts and times are of one moment; a
 * range that ends before it starts, as one still to come does once cut at
 * now, has no buckets:
 *
 * - the time in each of Decaid's states, from the stored Machine State
 *   changes: the one in effect as the range began, the latest before it,
 *   and each observed in it, by the tablet's clock, each lasting until the
 *   next, and the last until the range's end, cut at each span's edges;
 * - its flushes and hot water pours, each a run of stored changes in
 *   Decaid's `flush` or `hotWater`, a change of substate staying in the run,
 *   counted where the run began, so one under way as the range began is not
 *   counted in it;
 * - the Shots and Steam Records credited to the Machine, by when each was
 *   pulled or recorded: the Shots the Shots list lists for it, which leaves
 *   out one whose record has not arrived whole.
 *
 * The events' (machine_id, observed_at, id) index and the records'
 * (machine_id, time) indexes find each.
 */
export async function readMachineUse(db: Prisma.TransactionClient, machineId: string, range: { from: number; to: number }, by: UseBy, stays: readonly Stay[]): Promise<MachineUse> {
  const { buckets: labels, spans } = useSpans(range, stays, by);
  const buckets = labels.map((label): UseBucket => ({ ...label, shots: 0, steamRecords: 0, flushes: 0, hotWaterPours: 0, states: [] }));
  const [from, to] = [new Date(range.from).toISOString(), new Date(range.to).toISOString()];
  if (spans.length === 0) return { by, from, to, buckets };
  const rows = await db.$queryRaw<UseRow[]>`
    WITH span AS (
      SELECT * FROM unnest(
        ${spans.map((span) => new Date(span.from).toISOString())}::timestamptz[],
        ${spans.map((span) => new Date(span.to).toISOString())}::timestamptz[],
        ${spans.map((span) => span.bucket)}::int[]
      ) AS span(since, until, bucket)
    ),
    event AS (
      (SELECT id, observed_at, state FROM machine_state_events
        WHERE machine_id = ${machineId}::uuid AND observed_at < ${from}::timestamptz
        ORDER BY observed_at DESC, id DESC LIMIT 1)
      UNION ALL
      (SELECT id, observed_at, state FROM machine_state_events
        WHERE machine_id = ${machineId}::uuid AND observed_at >= ${from}::timestamptz AND observed_at < ${to}::timestamptz)
    ),
    stretch AS (
      SELECT state, observed_at AS began, lead(observed_at, 1, ${to}::timestamptz) OVER later AS ended, lag(state) OVER later AS before
      FROM event WINDOW later AS (ORDER BY observed_at, id)
    )
    SELECT 'seconds' AS kind, span.bucket, stretch.state,
      sum(extract(epoch FROM least(stretch.ended, span.until)) - extract(epoch FROM greatest(stretch.began, span.since)))::float8 AS value
    FROM stretch JOIN span ON stretch.began < span.until AND stretch.ended > span.since
    GROUP BY span.bucket, stretch.state
    UNION ALL
    SELECT 'visits', span.bucket, stretch.state, count(*)::float8
    FROM stretch JOIN span ON stretch.began >= span.since AND stretch.began < span.until
    WHERE stretch.state IN ('flush', 'hotWater') AND stretch.before IS DISTINCT FROM stretch.state
    GROUP BY span.bucket, stretch.state
    UNION ALL
    SELECT 'shots', span.bucket, NULL, count(*)::float8
    FROM span JOIN shots AS s ON s.machine_id = ${machineId}::uuid AND s.has_full_record AND s.pulled_at >= span.since AND s.pulled_at < span.until
    GROUP BY span.bucket
    UNION ALL
    SELECT 'steamRecords', span.bucket, NULL, count(*)::float8
    FROM span JOIN steam_records AS r ON r.machine_id = ${machineId}::uuid AND r.steamed_at >= span.since AND r.steamed_at < span.until
    GROUP BY span.bucket`;
  for (const { kind, bucket: n, state, value } of rows) {
    const bucket = buckets[n]!;
    if (kind === "shots") bucket.shots = value;
    else if (kind === "steamRecords") bucket.steamRecords = value;
    else if (kind === "visits") bucket[state === "flush" ? "flushes" : "hotWaterPours"] = value;
    else if (value > 0) bucket.states.push({ state: state!, name: nameDecaidState(state!), seconds: value });
  }
  for (const bucket of buckets) bucket.states.sort((a, b) => b.seconds - a.seconds || (a.state < b.state ? -1 : 1));
  return { by, from, to, buckets };
}
