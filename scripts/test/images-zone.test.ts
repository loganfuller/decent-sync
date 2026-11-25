// The image capture's time zone (scripts/images/zone.ts): whatever the hour the capture runs at, its pages show the
// same Shots on the same days.
import { describe, expect, it } from "vitest";

import { AFTERNOON_HOUR, AFTERNOON_ZONES, afternoonZone, offsetHours } from "../images/zone.js";

const HOUR = 3_600_000;
/** Every quarter of an hour of a day in each season, and around the days daylight saving starts and ends. */
const DAYS = ["2026-01-15", "2026-03-08", "2026-03-29", "2026-04-05", "2026-07-15", "2026-09-27", "2026-10-04", "2026-10-25", "2026-11-01"];
const RUNS = DAYS.flatMap((day) => Array.from({ length: 96 }, (_, i) => Date.parse(`${day}T00:00:00Z`) + i * 15 * 60_000));

/** A moment's local date and hour in a zone. */
const localDate = (zone: string, ms: number) => new Date(ms + offsetHours(zone, ms) * HOUR).toISOString().slice(0, 10);
const localHour = (zone: string, ms: number) => new Date(ms + offsetHours(zone, ms) * HOUR).getUTCHours();

describe("the image capture's time zone", () => {
  it("has a zone for every whole hour from UTC-10 to UTC+13, each one the server accepts", () => {
    const supported = new Set(Intl.supportedValuesOf("timeZone"));
    expect(Object.keys(AFTERNOON_ZONES).map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i - 10));
    for (const zone of Object.values(AFTERNOON_ZONES)) expect(supported.has(zone), zone).toBe(true);
  });

  it("is one with no daylight saving", () => {
    for (const [offset, zone] of Object.entries(AFTERNOON_ZONES)) {
      for (const run of RUNS.filter((_, i) => i % 24 === 0)) expect(offsetHours(zone, run), `${zone} at ${new Date(run).toISOString()}`).toBe(Number(offset));
    }
  });

  it("puts the latest Shot in the afternoon, today's Shots today and yesterday's yesterday, at any hour", () => {
    for (const run of RUNS) {
      const zone = afternoonZone(run);
      const at = new Date(run).toISOString();
      expect(localHour(zone, run), at).toBe(AFTERNOON_HOUR);
      // The spec's today reaches back 4.1 hours, its yesterday from 24.6 to 28 hours, its Loaded Recipes 48 hours.
      expect(localDate(zone, run - 4.1 * HOUR), at).toBe(localDate(zone, run));
      const yesterday = localDate(zone, run - 24 * HOUR);
      expect(localDate(zone, run - 24.6 * HOUR), at).toBe(yesterday);
      expect(localDate(zone, run - 28 * HOUR), at).toBe(yesterday);
      expect(yesterday < localDate(zone, run), at).toBe(true);
      expect(offsetHours(zone, run - 48 * HOUR), at).toBe(offsetHours(zone, run));
    }
  });
});
