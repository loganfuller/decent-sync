import type { UseBucket } from "@/lib/api";

// A Machine's use (#475) as its page shows it: the pure parts, which put the
// REST API's days and hours, counts and times into words.

/** What a Machine's use counts, in the order it is shown. */
export const USE_COUNTS = [
  { key: "shots", label: "Shots" },
  { key: "steamRecords", label: "Steam Records" },
  { key: "flushes", label: "Flushes" },
  { key: "hotWaterPours", label: "Hot water pours" },
] as const;

export type UseCount = (typeof USE_COUNTS)[number]["key"];

/** How many of each the days or hours hold in all. */
export function countTotals(buckets: readonly UseBucket[]): Record<UseCount, number> {
  const totals = { shots: 0, steamRecords: 0, flushes: 0, hotWaterPours: 0 };
  for (const bucket of buckets) for (const { key } of USE_COUNTS) totals[key] += bucket[key];
  return totals;
}

/**
 * The time spent in each Machine State over the days or hours, the longest
 * first: by the name the management interface gives it, so those of
 * Decaid's states it names alike, as Idle is its `idle` and `schedIdle`, are
 * one.
 */
export function stateTimes(buckets: readonly UseBucket[]): { name: string; seconds: number }[] {
  const times = new Map<string, number>();
  for (const bucket of buckets) for (const { name, seconds } of bucket.states) times.set(name, (times.get(name) ?? 0) + seconds);
  return [...times].map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
}

const UNITS = [
  ["d", 86_400],
  ["h", 3_600],
  ["min", 60],
  ["s", 1],
] as const;

/**
 * A length of time to the second, in its largest unit and the next where
 * that isn't nothing: "2 d 3 h", "5 h 12 min", "3 min", "45 s". What is left
 * over is dropped, so it never reads longer than it was.
 */
export function durationText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const first = UNITS.findIndex(([, size]) => whole >= size);
  if (first === -1) return "0 s";
  const [unit, size] = UNITS[first]!;
  const next = UNITS[first + 1];
  const rest = next ? Math.floor((whole % size) / next[1]) : 0;
  return `${Math.floor(whole / size)} ${unit}${rest > 0 ? ` ${rest} ${next![0]}` : ""}`;
}

// A day or an hour is given as it read on the wall clock of the Location the Machine was at, so it is shown as given:
// formatted in UTC from a date built in UTC, the browser's own time zone playing no part.
const DAY = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
const HOUR = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", hour: "numeric" });
const WHOLE_DAY = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });

function wallClock({ date, hour }: Pick<UseBucket, "date" | "hour">): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, hour ?? 0));
}

/** A day or hour under its bar: the day, such as "Nov 5", or the hour, such as "6 AM". */
export function bucketLabel(bucket: Pick<UseBucket, "date" | "hour">): string {
  return (bucket.hour === undefined ? DAY : HOUR).format(wallClock(bucket));
}

/** A day or hour in full, such as "Thu, Nov 5, 2026", or "Thu, Nov 5, 2026, 6 AM". */
export function bucketTitle(bucket: Pick<UseBucket, "date" | "hour">): string {
  const day = WHOLE_DAY.format(wallClock({ date: bucket.date }));
  return bucket.hour === undefined ? day : `${day}, ${HOUR.format(wallClock(bucket))}`;
}
