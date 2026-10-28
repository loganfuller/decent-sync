// Relative, as the module tests import it without the web build's alias.
import { zoneOffsetMinutes } from "./zoned-time";

// Times in a Tablet's own time, which Decaid keeps without an offset: night
// mode's times as minutes after midnight, a wake schedule's time as HH:MM,
// and `keepAwakeUntil` as a local date and time. The Tablet's plugin sends
// its UTC offset beside them, which labels them.

const MINUTES_PER_DAY = 24 * 60;

/** Minutes after midnight, 0 to 1439, as a time of day such as 06:30; undefined for any other value. */
export function timeOfDayText(minutes: unknown): string | undefined {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) return undefined;
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** A time of day written HH:MM, as Decaid writes a wake schedule's time and a time input gives one, in minutes after midnight; undefined for any other text. */
export function timeOfDayMinutes(text: unknown): number | undefined {
  const match = typeof text === "string" ? /^(\d\d):(\d\d)$/.exec(text) : null;
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/** A UTC offset in minutes east of UTC as it labels a time, such as UTC−4, UTC+5:30 or UTC. */
export function utcOffsetText(minutes: number): string {
  if (minutes === 0) return "UTC";
  const size = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(size / 60)}${size % 60 === 0 ? "" : `:${pad(size % 60)}`}`;
}

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

/**
 * A date and time Decaid wrote in the Tablet's own time without an offset,
 * as Dart's `toIso8601String` writes a local `DateTime` (such as
 * 2026-10-25T08:30:00.000), as its date and time of day, such as
 * "Oct 25, 2026, 08:30"; undefined for text that is not one. Its date is
 * written as it reads there, not moved into the browser's time zone.
 */
export function localTimeText(text: unknown): string | undefined {
  const match = typeof text === "string" ? /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?$/.exec(text) : null;
  if (!match) return undefined;
  const [year, month, day, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hours > 23 || minutes > 59 || seconds > 59) return undefined;
  return `${DATE.format(date)}, ${pad(hours)}:${pad(minutes)}`;
}

/** A time in the Tablet's own time with its UTC offset, such as "06:30 (UTC−4)", or as it is where the offset is unknown. */
export function inTabletTime(text: string, utcOffsetMinutes: number | null): string {
  return utcOffsetMinutes === null ? text : `${text} (${utcOffsetText(utcOffsetMinutes)})`;
}

/**
 * The time zone's UTC offset at the time, in minutes east of UTC, where it
 * differs from the Tablet's, as when the Tablet is set to another zone than
 * its Location's, or has not followed a daylight saving change; undefined
 * where they agree.
 */
export function differingZoneOffset(tabletOffsetMinutes: number, timeZone: string, time: number): number | undefined {
  const zone = zoneOffsetMinutes(timeZone, time);
  return zone === tabletOffsetMinutes ? undefined : zone;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
