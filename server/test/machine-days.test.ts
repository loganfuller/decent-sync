import { describe, expect, it } from "vitest";
import { useRange, useSpans } from "../src/machine-events/machine-use.js";
import { type Stay, machineRange } from "../src/machines/machine-days.js";

// How a date is read as a range of a Machine's activity or use (#587),
// through the pure function both read it with: the day at the Location the
// Machine was at at noon UTC, UTC's before the day it came to its first
// Location, and that day from the sooner of its starts in UTC and there, so
// a date holds the moments its use is counted under. Seam 1 reads the same
// through the REST route on simulated tablets (machine-activity.test.ts).

const ms = (iso: string) => Date.parse(iso);

/** A date's range, from its start to its end, in UTC. */
const day = (date: string, stays: readonly Stay[]) => {
  const { from, to } = machineRange(date, date, stays);
  return [from?.toISOString(), to?.toISOString()];
};

/** The moments use counts under each date over a range, as [from, to] in UTC, its spans joined. */
const counted = (from: string, to: string, stays: readonly Stay[]) => {
  const { buckets, spans } = useSpans({ from: ms(from), to: ms(to) }, stays, "day");
  return Object.fromEntries(
    buckets.map(({ date }, n) => {
      const mine = spans.filter((span) => span.bucket === n);
      return [date, [new Date(mine[0]!.from).toISOString(), new Date(mine.at(-1)!.to).toISOString()]];
    }),
  );
};

// Added to a Location in Chicago at 18:05 on 18 November there, 00:05 on the 19th in UTC.
const CHICAGO: Stay[] = [{ from: ms("2026-11-19T00:05:00Z"), timeZone: "America/Chicago" }];
// Added in Tokyo at 20:00 UTC on the 18th, which was already 05:00 on the 19th there.
const TOKYO: Stay[] = [{ from: ms("2026-11-18T20:00:00Z"), timeZone: "Asia/Tokyo" }];
// Added in Auckland at 14:05 UTC on the 18th, 03:05 on the 19th there, whose day began at 11:00 UTC on the 18th,
// before noon UTC.
const AUCKLAND: Stay[] = [{ from: ms("2026-11-18T14:05:00Z"), timeZone: "Pacific/Auckland" }];

describe("the days of a Machine", () => {
  it("reads the day a Machine came to its first Location west of UTC from its start in UTC to its end there, and a day before it in UTC", () => {
    expect(day("2026-11-17", CHICAGO)).toEqual(["2026-11-17T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(day("2026-11-18", CHICAGO)).toEqual(["2026-11-18T00:00:00.000Z", "2026-11-19T06:00:00.000Z"]);
    expect(day("2026-11-19", CHICAGO)).toEqual(["2026-11-19T06:00:00.000Z", "2026-11-20T06:00:00.000Z"]);
  });

  it("ends the day before the one a Machine came to its first Location east of UTC when that day began there", () => {
    expect(day("2026-11-18", TOKYO)).toEqual(["2026-11-18T00:00:00.000Z", "2026-11-18T15:00:00.000Z"]);
    expect(day("2026-11-19", TOKYO)).toEqual(["2026-11-18T15:00:00.000Z", "2026-11-19T15:00:00.000Z"]);
    // Auckland's 19th began before noon UTC on the 18th, which is still UTC's, not Auckland's 18th.
    expect(day("2026-11-17", AUCKLAND)).toEqual(["2026-11-17T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    expect(day("2026-11-18", AUCKLAND)).toEqual(["2026-11-18T00:00:00.000Z", "2026-11-18T11:00:00.000Z"]);
    expect(day("2026-11-19", AUCKLAND)).toEqual(["2026-11-18T11:00:00.000Z", "2026-11-19T11:00:00.000Z"]);
  });

  it("reads each date around a Machine's first Location as the moments its use counts under it, with no gap or overlap", () => {
    for (const stays of [CHICAGO, TOKYO, AUCKLAND]) {
      const buckets = counted("2026-11-16T00:00:00Z", "2026-11-21T00:00:00Z", stays);
      for (const date of ["2026-11-17", "2026-11-18", "2026-11-19"]) expect(day(date, stays)).toEqual(buckets[date]);
    }
  });

  it("reads a Machine at no Location in UTC", () => {
    expect(day("2026-11-18", [])).toEqual(["2026-11-18T00:00:00.000Z", "2026-11-19T00:00:00.000Z"]);
  });

  it("reads the day a Machine came to its first Location by hour, however long, and the hours before it came", () => {
    // Chicago's 18th from midnight UTC is 30 hours: one date by hour, or the day a range ends in, is read whole.
    const whole = useRange({ by: "hour", from: "2026-11-18", to: "2026-11-18" }, CHICAGO, ms("2026-11-20T00:00:00Z"));
    expect((whole.to - whole.from) / 3_600_000).toBe(30);
    expect(useRange({ by: "hour", to: "2026-11-18" }, CHICAGO, ms("2026-11-20T00:00:00Z"))).toEqual(whole);
    // An hour of it before the Machine came, after midnight UTC, is the 18th's, so its range starts then.
    expect(useRange({ by: "hour", to: "2026-11-18T03:00:00Z" }, CHICAGO, ms("2026-11-20T00:00:00Z"))).toEqual({ from: ms("2026-11-18T00:00:00Z"), to: ms("2026-11-18T03:00:00Z") });
    // Other ranges by hour are still at most 25 hours.
    expect(() => useRange({ by: "hour", from: "2026-11-18", to: "2026-11-19T02:00:00Z" }, CHICAGO, ms("2026-11-20T00:00:00Z"))).toThrow("at most 25 hours");
    // By day, 31 dates are read with it among them.
    const month = useRange({ by: "day", from: "2026-11-18", to: "2026-12-18" }, CHICAGO, ms("2026-12-20T00:00:00Z"));
    expect(useSpans(month, CHICAGO, "day").buckets).toHaveLength(31);
  });

  it("still reads the day a Machine moved after noon UTC by the Location it left", () => {
    const moved: Stay[] = [
      { from: ms("2025-01-01T00:00:00Z"), timeZone: "America/Denver" },
      { from: ms("2026-11-19T00:05:00Z"), timeZone: "America/Chicago" },
    ];
    expect(day("2026-11-18", moved)).toEqual(["2026-11-18T07:00:00.000Z", "2026-11-19T07:00:00.000Z"]);
  });
});
