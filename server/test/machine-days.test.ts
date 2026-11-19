import { describe, expect, it } from "vitest";
import { type Stay, machineRange } from "../src/machines/machine-days.js";

// How a date is read as a range of a Machine's activity or use (#587),
// through the pure function both read it with: the day at the Location the
// Machine was at at noon UTC, or, at none then, at the first it came to that
// day. Seam 1 reads the same through the REST route on simulated tablets
// (machine-activity.test.ts).

const ms = (iso: string) => Date.parse(iso);

/** A date's range, from its start to its end, in UTC. */
const day = (date: string, stays: readonly Stay[]) => {
  const { from, to } = machineRange(date, date, stays);
  return [from?.toISOString(), to?.toISOString()];
};

describe("the days of a Machine", () => {
  it("reads the day a Machine came to its first Location after noon UTC by that Location's clock, and a day before it in UTC", () => {
    // Added to a Location in Chicago at 18:05 on 18 November there, 00:05 on the 19th in UTC.
    const chicago: Stay[] = [{ from: ms("2026-11-19T00:05:00Z"), timeZone: "America/Chicago" }];
    expect(day("2026-11-18", chicago)).toEqual(["2026-11-18T06:00:00.000Z", "2026-11-19T06:00:00.000Z"]);
    expect(day("2026-11-19", chicago)).toEqual(["2026-11-19T06:00:00.000Z", "2026-11-20T06:00:00.000Z"]);
    expect(day("2026-11-17", chicago)).toEqual(["2026-11-17T00:00:00.000Z", "2026-11-18T00:00:00.000Z"]);
    // Added in Tokyo at 20:00 UTC on the 18th, which was already the 19th there: the 18th is UTC's.
    const tokyo: Stay[] = [{ from: ms("2026-11-18T20:00:00Z"), timeZone: "Asia/Tokyo" }];
    expect(day("2026-11-18", tokyo)).toEqual(["2026-11-18T00:00:00.000Z", "2026-11-19T00:00:00.000Z"]);
    expect(day("2026-11-19", tokyo)).toEqual(["2026-11-18T15:00:00.000Z", "2026-11-19T15:00:00.000Z"]);
    // A Machine at no Location reads its days in UTC.
    expect(day("2026-11-18", [])).toEqual(["2026-11-18T00:00:00.000Z", "2026-11-19T00:00:00.000Z"]);
  });

  it("still reads the day a Machine moved after noon UTC by the Location it left", () => {
    const moved: Stay[] = [
      { from: ms("2025-01-01T00:00:00Z"), timeZone: "America/Denver" },
      { from: ms("2026-11-19T00:05:00Z"), timeZone: "America/Chicago" },
    ];
    expect(day("2026-11-18", moved)).toEqual(["2026-11-18T07:00:00.000Z", "2026-11-19T07:00:00.000Z"]);
  });
});
