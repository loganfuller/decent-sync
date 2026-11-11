import { describe, expect, it } from "vitest";
import type { SummaryBucket } from "../src/lib/api";
import {
  TREND_NUMBERS,
  axisSpan,
  axisTicks,
  bucketParam,
  dateOf,
  dayNumber,
  pointText,
  pointTitle,
  trendBucket,
  trendNumber,
  trendParam,
  trendPoints,
  trendRows,
  untimedShots,
} from "../src/lib/shot-trend";

// The Shots list's trend (#470): the number and bucket its address keeps,
// and a group's buckets, as the REST API gives them, as the points of a
// chart, the marks of its time axis and the words of its tooltips and
// table; and several groups' points as the rows of one chart, a line for
// each (#474).

const counts = (shots: number, cleaning = 0) => ({ shots, unfinished: 0, cleaningAndCalibration: cleaning, awaitingValues: 0 });
const number = (shots: number, median: number | null, p25 = median, p75 = median) => ({ shots, median, p25, p75 });

describe("the trend's number and bucket in the address", () => {
  it("charts duration by day where the address names neither, and holds neither then", () => {
    expect(trendNumber(null)).toBe("duration");
    expect(trendBucket(null)).toBe("day");
    expect(trendParam("duration")).toBeNull();
    expect(bucketParam("day")).toBeNull();
  });

  it("reads and holds each number a trend can chart, every one a summary gives but the last step", () => {
    expect(TREND_NUMBERS).toEqual(["yieldAgainstTarget", "duration", "stoppedOnWeight", "ratio", "peakPressure", "peakFlow", "rating", "grindSetting", "tds", "extractionYield", "timeToFirstDrip"]);
    for (const name of TREND_NUMBERS.filter((each) => each !== "duration")) expect(trendNumber(trendParam(name))).toBe(name);
    expect(trendBucket(bucketParam("week"))).toBe("week");
  });

  it("falls back to the defaults for what it doesn't know, as of a later release's address", () => {
    expect(trendNumber("lastStep")).toBe("duration");
    expect(trendNumber("crema")).toBe("duration");
    expect(trendBucket("month")).toBe("day");
    expect(trendBucket("")).toBe("day");
  });
});

describe("a group's buckets as a trend's points", () => {
  const buckets: SummaryBucket[] = [
    { start: "2026-02-10", counts: counts(2), numbers: { duration: number(2, 24.691, 24.12, 25.262), rating: { ...number(0, null), rated: 0 }, stoppedOnWeight: { shots: 2, share: 1 } } },
    // Rated by one of its three, and none recorded what stopped it.
    { start: "2026-02-12", counts: counts(3, 1), numbers: { duration: number(3, 23.549), rating: { ...number(1, 8), rated: 1 / 3 }, stoppedOnWeight: { shots: 0, share: null } } },
    { start: "2026-03-01", counts: counts(4), numbers: { duration: number(4, 25.833, 23.549, 25.833), rating: { ...number(0, null), rated: 0 }, stoppedOnWeight: { shots: 3, share: 2 / 3 } } },
    // The Shots whose time is unknown.
    { start: null, counts: { ...counts(1, 1), unfinished: 2 }, numbers: { duration: number(1, 30), rating: { ...number(0, null), rated: 0 }, stoppedOnWeight: { shots: 1, share: 1 } } },
  ];

  it("gives a median's point for each day with a value, at its date as a count of days, with the middle half's band", () => {
    expect(trendPoints(buckets, "duration")).toEqual([
      { start: "2026-02-10", at: 20494, value: 24.691, band: [24.12, 25.262], shots: 2, covered: 2 },
      { start: "2026-02-12", at: 20496, value: 23.549, band: [23.549, 23.549], shots: 3, covered: 3 },
      { start: "2026-03-01", at: 20513, value: 25.833, band: [23.549, 25.833], shots: 4, covered: 4 },
    ]);
  });

  it("gives no point for a day whose Shots had no value, and says how many of a day's Shots a value rests on", () => {
    expect(trendPoints(buckets, "rating")).toEqual([{ start: "2026-02-12", at: 20496, value: 8, band: [8, 8], shots: 1, covered: 3 }]);
    // A number the answer doesn't hold, as the one loaded before another was chosen.
    expect(trendPoints(buckets, "tds")).toEqual([]);
    expect(trendPoints([], "duration")).toEqual([]);
  });

  it("gives a share as a percentage with no band, and no point where no Shot either did or didn't", () => {
    expect(trendPoints(buckets, "stoppedOnWeight")).toEqual([
      { start: "2026-02-10", at: 20494, value: 100, shots: 2, covered: 2 },
      { start: "2026-03-01", at: 20513, value: (2 / 3) * 100, shots: 3, covered: 4 },
    ]);
  });

  it("counts the Shots whose time is unknown, each kind of them, which are on no chart", () => {
    expect(untimedShots(buckets)).toBe(4);
    expect(untimedShots(buckets.slice(0, 3))).toBe(0);
  });
});

describe("several lines' points as one chart's rows", () => {
  const point = (start: string, value: number) => ({ start, at: dayNumber(start), value, band: [value, value] as [number, number], shots: 1, covered: 1 });
  const left = [point("2026-02-10", 24), point("2026-02-12", 25)];
  const right = [point("2026-02-09", 26), point("2026-02-12", 27)];

  it("gives a row for each day any line has a point of, oldest first, each line's point in the lines' order and none where it has none", () => {
    expect(trendRows([left, right])).toEqual([
      { start: "2026-02-09", at: 20493, points: [undefined, right[0]] },
      { start: "2026-02-10", at: 20494, points: [left[0], undefined] },
      { start: "2026-02-12", at: 20496, points: [left[1], right[1]] },
    ]);
  });

  it("gives one line's points as its rows, a line with no point a place in each row, and no rows of no points", () => {
    expect(trendRows([left])).toEqual([
      { start: "2026-02-10", at: 20494, points: [left[0]] },
      { start: "2026-02-12", at: 20496, points: [left[1]] },
    ]);
    expect(trendRows([[], left]).map((row) => row.points)).toEqual([
      [undefined, left[0]],
      [undefined, left[1]],
    ]);
    expect(trendRows([[], []])).toEqual([]);
    expect(trendRows([])).toEqual([]);
  });
});

describe("a trend's time axis", () => {
  it("counts a date's days by its calendar alone, there and back, across a leap day", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(dateOf(dayNumber("2026-02-10"))).toBe("2026-02-10");
    expect(dayNumber("2028-03-01") - dayNumber("2028-02-28")).toBe(2);
    expect(dateOf(dayNumber("2026-03-08") + 1)).toBe("2026-03-09");
  });

  const at = (...dates: string[]) => dates.map((start) => ({ start, at: dayNumber(start), value: 1, shots: 1, covered: 1 }));

  it("spans its first point to its last, or a day or week either side of its only one", () => {
    expect(axisSpan(at("2026-02-10", "2026-02-12", "2026-03-01"), "day")).toEqual([20494, 20513]);
    expect(axisSpan(at("2026-02-10"), "day")).toEqual([20493, 20495]);
    expect(axisSpan(at("2026-02-09"), "week")).toEqual([20486, 20500]);
  });

  it("marks every day while they fit, and then every second or third, from the first", () => {
    expect(axisTicks([20494, 20498], "day").map(dateOf)).toEqual(["2026-02-10", "2026-02-11", "2026-02-12", "2026-02-13", "2026-02-14"]);
    // 19 days in at most six marks: every fourth.
    expect(axisTicks([20494, 20513], "day").map(dateOf)).toEqual(["2026-02-10", "2026-02-14", "2026-02-18", "2026-02-22", "2026-02-26"]);
    expect(axisTicks([20494, 20494 + 364], "day")).toHaveLength(5);
  });

  it("marks weeks at their Mondays only", () => {
    const span: [number, number] = [dayNumber("2026-02-09"), dayNumber("2026-03-02")];
    expect(axisTicks(span, "week").map(dateOf)).toEqual(["2026-02-09", "2026-02-16", "2026-02-23", "2026-03-02"]);
    // A year of weeks: every eleventh Monday.
    const year = axisTicks([dayNumber("2026-01-05"), dayNumber("2027-01-04")], "week");
    expect(year.map(dateOf)).toEqual(["2026-01-05", "2026-03-23", "2026-06-08", "2026-08-24", "2026-11-09"]);
    for (const tick of year) expect(new Date(tick * 86_400_000).getUTCDay()).toBe(1);
    // The one week's either side.
    expect(axisTicks(axisSpan(at("2026-02-09"), "week"), "week").map(dateOf)).toEqual(["2026-02-02", "2026-02-09", "2026-02-16"]);
  });
});

describe("a trend's point in words", () => {
  it("names a day in full, and a week by its Monday", () => {
    expect(pointTitle("2026-02-10", "day")).toBe(new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(Date.UTC(2026, 1, 10))));
    expect(pointTitle("2026-02-09", "week")).toMatch(/^Week of /);
  });

  it("reads a median as the summary shows one, with its unit and the middle half's range", () => {
    expect(pointText({ value: 24.691, band: [24.12, 25.262] }, "duration")).toEqual({ value: "24.7 s", range: "24.1–25.3" });
    expect(pointText({ value: -0.7, band: [-1, 0.4] }, "yieldAgainstTarget")).toEqual({ value: "−0.7 g", range: "−1.0 to +0.4" });
    expect(pointText({ value: 2.1, band: [2, 2.25] }, "ratio")).toEqual({ value: "1:2.10", range: "2.00–2.25" });
    expect(pointText({ value: 8.75, band: [8.5, 9] }, "grindSetting")).toEqual({ value: "8.75", range: "8.5–9" });
  });

  it("reads a share as a whole percentage, with no range", () => {
    expect(pointText({ value: (2 / 3) * 100 }, "stoppedOnWeight")).toEqual({ value: "67%" });
    expect(pointText({ value: 0 }, "stoppedOnWeight")).toEqual({ value: "0%" });
  });
});
