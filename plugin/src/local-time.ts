// Times Decaid writes in the tablet's local time without an offset, placed
// in UTC. The plugin runs in the tablet's time zone (AI_RUNTIME_NOTES.md), so
// it can place them where the server cannot.

const ISO_TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;

/**
 * A time Decaid wrote, in UTC, or null if it is not a time that exists.
 * Decaid writes a Steam Record's `timestamp` and a Library record's
 * `updatedAt` as the tablet's local time without an offset, to the
 * microsecond (`DateTime.now()`, by `toIso8601String`, as in
 * SteamSequencer._openRecord and BeansHandler), and records nothing that
 * places them in UTC.
 * The plugin runs in the tablet's time zone, so the time is built from its
 * parts, which JavaScript reads as local time, daylight saving included,
 * rather than parsed: engines differ in how they parse a time without an
 * offset, and in how many fractional digits they read. A local time that
 * occurs twice, as the clocks go back, is read as the first. A time written
 * with an offset, as a later Decaid may write it, is placed by its offset.
 * Date rolls over parts that do not exist, such as the 30th of February or a
 * local time the clocks skip, so a time whose parts read back differently is
 * refused.
 */
export function utcTime(timestamp: unknown): string | null {
  const match = typeof timestamp === "string" ? ISO_TIME.exec(timestamp) : null;
  if (!match) return null;
  const parts = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const [year, month, day, hour, minute, second] = parts;
  const ms = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offset = match[8];
  if (offset === undefined) {
    const local = new Date(year, month - 1, day, hour, minute, second, ms);
    const readBack = [local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds()];
    return readBack.every((part, index) => part === parts[index]) ? local.toISOString() : null;
  }
  const minutes = offsetMinutes(offset);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  const readBack = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds()];
  if (minutes === null || !readBack.every((part, index) => part === parts[index])) return null;
  return new Date(utc.getTime() - minutes * 60_000).toISOString();
}

/** An ISO 8601 offset, Z or ±hh:mm, in minutes east of UTC, or null if its hours or minutes are out of range. */
function offsetMinutes(offset: string): number | null {
  if (offset === "Z") return 0;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return null;
  return (offset.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
}
