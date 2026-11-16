// A time as it reads beside what happened then (#543): how long ago where it
// is recent, the day and time of day for yesterday's, and a plain date
// otherwise. Never seconds. The pure part of `RelativeTime`
// (components/relative-time.tsx), which gives the exact time in a tooltip.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();
const TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();
const DATED_YEAR_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** A format in a time zone, made once for each zone. */
function cached(formats: Map<string, Intl.DateTimeFormat>, timeZone: string, locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeZone, ...options });
    formats.set(timeZone, format);
  }
  return format;
}

/** The calendar day a moment falls on in a time zone, as a count of days, for telling how many days apart two moments are there. */
function dayIn(time: number, timeZone: string): number {
  const parts = cached(DAY_FORMATS, timeZone, "en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
  const part = (type: string) => Number(parts.find((each) => each.type === type)!.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY;
}

/** The time zone times are shown in where none is given: the browser's. */
export const BROWSER_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A moment as it reads `now`, by the wall clock of `timeZone`: "Just now"
 * within a minute, "14 min ago" within the hour, "3 h ago" earlier the same
 * day, "Yesterday, 4:12 PM" for the day before, "2 days ago" for the six
 * days before that, and otherwise its date, "Nov 12", with the year where
 * it is another year's. A moment an hour or more ahead of now, as a tablet
 * whose clock is wrong gives one, reads as its date.
 */
export function relativeTime(at: number, now: number, timeZone: string = BROWSER_TIME_ZONE): string {
  const elapsed = now - at;
  if (elapsed > -HOUR && elapsed < MINUTE) return "Just now";
  if (elapsed >= 0 && elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  const days = dayIn(now, timeZone) - dayIn(at, timeZone);
  if (elapsed >= 0 && days === 0) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed >= 0 && days === 1) return `Yesterday, ${cached(TIME_FORMATS, timeZone, undefined, { hour: "numeric", minute: "2-digit" }).format(at)}`;
  if (elapsed >= 0 && days < 7) return `${days} days ago`;
  const sameYear = new Date(dayIn(now, timeZone) * DAY).getUTCFullYear() === new Date(dayIn(at, timeZone) * DAY).getUTCFullYear();
  return sameYear
    ? cached(DATE_FORMATS, timeZone, undefined, { month: "short", day: "numeric" }).format(at)
    : cached(DATED_YEAR_FORMATS, timeZone, undefined, { month: "short", day: "numeric", year: "numeric" }).format(at);
}
