// Times in a Location's time zone, which may differ from the browser's: a
// move to Uptown at 7:00 means 7:00 in Uptown, wherever the Admin is.

const TIME_FORMATS = new Map<string, Intl.DateTimeFormat>();
const PART_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** A time as it reads in the time zone, with the zone's abbreviation, such as "Jan 15, 2026, 8:30 AM CST". */
export function formatInZone(iso: string, timeZone: string): string {
  let format = TIME_FORMATS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    TIME_FORMATS.set(timeZone, format);
  }
  return format.format(new Date(iso));
}

/** The value of a `datetime-local` input showing the time in the zone, to the minute. */
export function toZonedInput(iso: string, timeZone: string): string {
  const wall = wallClock(Date.parse(iso), timeZone);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/**
 * The time a `datetime-local` input's value names in the zone, as an ISO
 * string, or undefined if it names none, as when the zone's clocks skip it.
 * A time the clocks repeat is taken at its first occurrence.
 */
export function fromZonedInput(value: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  if (!Number.isFinite(wall)) return undefined;
  // The zone's offsets a day either side cover any clock change near the time. Each gives a
  // candidate; those that read back as the time entered name it, and the earliest comes first.
  // A skipped time reads back as neither.
  const candidates = [wall - offset(wall - DAY, timeZone), wall - offset(wall + DAY, timeZone)]
    .map((time) => new Date(time).toISOString())
    .filter((iso) => toZonedInput(iso, timeZone) === value.slice(0, 16))
    .sort();
  return candidates[0];
}

const DAY = 24 * 60 * 60 * 1000;

/** How far the zone's clocks are ahead of UTC at the time, in milliseconds. */
function offset(time: number, timeZone: string): number {
  const wall = wallClock(time, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(time / 1000) * 1000;
}

function wallClock(time: number, timeZone: string) {
  let format = PART_FORMATS.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    PART_FORMATS.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(time)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}
