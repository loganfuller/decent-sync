import { describe, expect, it } from "vitest";
import { useRange, useSpans } from "../src/machine-events/machine-use.js";
import type { Stay } from "../src/machines/machine-days.js";

// The days and hours a Machine's use is counted by (#475), through the pure
// functions that cut a range into them: a day or an hour is that of the
// Location the Machine was at then. Seam 1 runs them through the REST route
// on simulated tablets (machine-use.test.ts).

const ms = (iso: string) => Date.parse(iso);
const HOUR = 3_600_000;

/** At the Lab, in Denver, since 2025. */
const DENVER: Stay[] = [{ from: ms("2025-01-01T00:00:00Z"), timeZone: "America/Denver" }];

/** Each bucket's label, with how long its spans are in hours, and the spans' buckets in the order of time. */
function cut(from: string, to: string, stays: readonly Stay[], by: "day" | "hour") {
  const { buckets, spans } = useSpans({ from: ms(from), to: ms(to) }, stays, by);
  // The spans are in time order, each ending where the next begins.
  expect(spans.map((span) => span.from)).toEqual([ms(from), ...spans.slice(0, -1).map((span) => span.to)]);
  expect(spans.at(-1)?.to ?? ms(to)).toBe(ms(to));
  return {
    buckets: buckets.map(({ date, hour }, n) => {
      const hours = spans.filter((span) => span.bucket === n).reduce((sum, span) => sum + span.to - span.from, 0) / HOUR;
      return by === "day" ? [date, hours] : [date, hour, hours];
    }),
    order: spans.map((span) => span.bucket),
  };
}

describe("the days and hours of a Machine's use", () => {
  it("cuts a range into the Location's days, a day the clocks change in 23 or 25 hours long", () => {
    // The clocks go forward in Denver on 8 March 2026, and back on 1 November.
    expect(cut("2026-03-07T07:00:00Z", "2026-03-10T06:00:00Z", DENVER, "day")).toEqual({
      buckets: [["2026-03-07", 24], ["2026-03-08", 23], ["2026-03-09", 24]],
      order: [0, 1, 2],
    });
    expect(cut("2026-10-31T06:00:00Z", "2026-11-03T07:00:00Z", DENVER, "day")).toEqual({
      buckets: [["2026-10-31", 24], ["2026-11-01", 25], ["2026-11-02", 24]],
      order: [0, 1, 2],
    });
    // A range that begins and ends within a day cuts its first and last.
    expect(cut("2026-02-10T20:00:00Z", "2026-02-12T08:30:00Z", DENVER, "day").buckets).toEqual([["2026-02-10", 11], ["2026-02-11", 24], ["2026-02-12", 1.5]]);
  });

  it("cuts a day into its hours: the hour the clocks repeat one hour two hours long, and the hour they skip left out", () => {
    const back = cut("2026-11-01T06:00:00Z", "2026-11-02T07:00:00Z", DENVER, "hour");
    expect(back.buckets).toEqual(Array.from({ length: 24 }, (_, hour) => ["2026-11-01", hour, hour === 1 ? 2 : 1]));
    expect(back.order).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
    const forward = cut("2026-03-08T07:00:00Z", "2026-03-09T06:00:00Z", DENVER, "hour");
    expect(forward.buckets).toEqual([0, 1, ...Array.from({ length: 21 }, (_, n) => n + 3)].map((hour) => ["2026-03-08", hour, 1]));
  });

  it("reads an hour on the Location's wall clock, where its offset is not a whole hour", () => {
    // Kolkata is 5 hours 30 minutes ahead of UTC.
    const kolkata = [{ from: ms("2025-01-01T00:00:00Z"), timeZone: "Asia/Kolkata" }];
    expect(cut("2026-02-10T03:00:00Z", "2026-02-10T05:00:00Z", kolkata, "hour").buckets).toEqual([
      ["2026-02-10", 8, 0.5],
      ["2026-02-10", 9, 1],
      ["2026-02-10", 10, 0.5],
    ]);
  });

  it("goes by UTC before a Machine's first Location, and by each Location from when it was there", () => {
    // 31 December in UTC, and its last 7 hours again in Denver, are one day.
    expect(cut("2024-12-31T00:00:00Z", "2025-01-02T07:00:00Z", DENVER, "day")).toEqual({ buckets: [["2024-12-31", 31], ["2025-01-01", 24]], order: [0, 1] });
    expect(cut("2024-12-31T00:00:00Z", "2025-01-02T00:00:00Z", [], "day").buckets).toEqual([["2024-12-31", 24], ["2025-01-01", 24]]);
    // A time zone this runtime doesn't know is read as UTC.
    expect(cut("2026-02-10T00:00:00Z", "2026-02-11T00:00:00Z", [{ from: 0, timeZone: "Mars/Olympus_Mons" }], "day").buckets).toEqual([["2026-02-10", 24]]);
  });

  it("gives a date a move west brings a second time one bucket, in two spans, and keeps a day whole across a move within one time zone", () => {
    // From Chicago to Denver half an hour into the 11th in Chicago, which was 23:30 on the 10th in Denver.
    const west: Stay[] = [
      { from: ms("2025-01-01T00:00:00Z"), timeZone: "America/Chicago" },
      { from: ms("2026-02-11T06:30:00Z"), timeZone: "America/Denver" },
    ];
    expect(cut("2026-02-10T12:00:00Z", "2026-02-11T12:00:00Z", west, "day")).toEqual({
      // The 10th: 18 hours in Chicago and half an hour in Denver. The 11th: half an hour in Chicago and 5 hours in Denver.
      buckets: [["2026-02-10", 18.5], ["2026-02-11", 5.5]],
      order: [0, 1, 0, 1],
    });
    const across: Stay[] = [
      { from: ms("2025-01-01T00:00:00Z"), timeZone: "America/Denver" },
      { from: ms("2026-02-10T20:00:00Z"), timeZone: "America/Boise" },
    ];
    expect(cut("2026-02-10T07:00:00Z", "2026-02-11T07:00:00Z", across, "day")).toEqual({ buckets: [["2026-02-10", 24]], order: [0] });
  });
});

describe("the range of a Machine's use", () => {
  /** 15:45 on 11 February 2026 in Denver. */
  const NOW = ms("2026-02-11T22:45:00Z");
  const range = (request: { from?: string; to?: string; by: "day" | "hour" }) => {
    const { from, to } = useRange(request, DENVER, NOW);
    return [new Date(from).toISOString(), new Date(to).toISOString()];
  };

  it("reads a date as a day at the Location the Machine was at, through its end for the range's end, and a time with its offset as itself", () => {
    expect(range({ from: "2026-02-10", to: "2026-02-11", by: "day" })).toEqual(["2026-02-10T07:00:00.000Z", "2026-02-12T07:00:00.000Z"]);
    expect(range({ from: "2026-02-10T08:00:00-07:00", to: "2026-02-10T18:00:00Z", by: "hour" })).toEqual(["2026-02-10T15:00:00.000Z", "2026-02-10T18:00:00.000Z"]);
  });

  it("runs until now with no end, and with no start from the day it ends in, by hour, or the 14 days ending with it, by day", () => {
    expect(range({ by: "day" })).toEqual(["2026-01-29T07:00:00.000Z", "2026-02-11T22:45:00.000Z"]);
    expect(range({ by: "hour" })).toEqual(["2026-02-11T07:00:00.000Z", "2026-02-11T22:45:00.000Z"]);
    // The 14 days ending with the 5th, and the 5th: an end at midnight is in the day before it.
    expect(range({ to: "2026-02-05", by: "day" })).toEqual(["2026-01-23T07:00:00.000Z", "2026-02-06T07:00:00.000Z"]);
    expect(range({ to: "2026-02-06T00:00:00-07:00", by: "hour" })).toEqual(["2026-02-05T07:00:00.000Z", "2026-02-06T07:00:00.000Z"]);
  });

  it("refuses a range that ends at or before its start, or runs longer than 31 days by day or a day by hour", () => {
    const refused = (request: Parameters<typeof range>[0]) => {
      try {
        range(request);
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    expect(refused({ from: "2026-02-11", to: "2026-02-10", by: "day" })).toBe("Choose an end after the start");
    // One that starts after now, with no end, is still to come: it ends now, before it starts.
    expect(range({ from: "2026-02-12", by: "day" })).toEqual(["2026-02-12T07:00:00.000Z", "2026-02-11T22:45:00.000Z"]);
    // 31 days, 25 hours longer or 1 hour shorter where the clocks change, are read; 32 are not.
    expect(refused({ from: "2026-10-05", to: "2026-11-04", by: "day" })).toBeUndefined();
    expect(refused({ from: "2026-02-10", to: "2026-03-12", by: "day" })).toBeUndefined();
    expect(refused({ from: "2026-02-10", to: "2026-03-13", by: "day" })).toBe("Choose a range of at most 31 days");
    // A day, 25 hours long as the clocks go back.
    expect(refused({ from: "2026-11-01", to: "2026-11-01", by: "hour" })).toBeUndefined();
    expect(refused({ from: "2026-11-01", to: "2026-11-02", by: "hour" })).toBe("Choose a range of at most a day to read by hour");
    expect(refused({ from: "0000-01-01", to: "0000-01-02", by: "day" })).toBe("Times must be in the years 1 to 9999, in UTC");
  });
});
