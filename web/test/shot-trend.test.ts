import { describe, expect, it } from "vitest";
import type { BatchLink, BucketedGroup, SummaryBucket } from "../src/lib/api";
import {
  PLOT,
  TREND_NUMBERS,
  TREND_UNITS,
  axisSpan,
  axisTicks,
  batchMarks,
  bucketParam,
  dateOf,
  dayNumber,
  drawnMarks,
  labelPlaces,
  labelWidth,
  lineX,
  markLabel,
  markLead,
  pointText,
  pointTitle,
  trendBucket,
  trendNumber,
  trendPoints,
  trendRows,
  untimedShots,
} from "../src/lib/shot-trend";

// The Shots list's trend (#470): the number and bucket its address keeps,
// and a group's buckets, as the REST API gives them, as the points of a
// chart, the marks of its time axis and the words of its tooltips and
// table; and several groups' points as the rows of one chart, a line for
// each (#474). A rating is charted, and read, in stars (#532).

const counts = (shots: number, cleaning = 0) => ({ shots, unfinished: 0, cleaningAndCalibration: cleaning, awaitingValues: 0 });
const number = (shots: number, median: number | null, p25 = median, p75 = median) => ({ shots, median, p25, p75 });

describe("the trend's number and bucket in the address", () => {
  it("charts duration by day where the address names neither, and holds no bucket for by day", () => {
    expect(trendNumber(null)).toBe("duration");
    expect(trendBucket(null)).toBe("day");
    expect(bucketParam("day")).toBeNull();
  });

  it("reads and holds each number a trend can chart, every one a summary gives but the last step", () => {
    expect(TREND_NUMBERS).toEqual(["yieldAgainstTarget", "duration", "stoppedAtTarget", "ratio", "peakPressure", "peakFlow", "rating", "grindSetting", "tds", "extractionYield", "timeToFirstDrip"]);
    for (const name of TREND_NUMBERS) expect(trendNumber(name)).toBe(name);
    expect(trendBucket(bucketParam("week"))).toBe("week");
  });

  it("falls back to the defaults for what it doesn't know, as of a later release's address", () => {
    expect(trendNumber("lastStep")).toBe("duration");
    expect(trendNumber("crema")).toBe("duration");
    // Stopped on weight, which stopped at target took the place of (#544), as an address kept from before names it.
    expect(trendNumber("stoppedOnWeight")).toBe("duration");
    expect(trendBucket("month")).toBe("day");
    expect(trendBucket("")).toBe("day");
  });
});

describe("a group's buckets as a trend's points", () => {
  const buckets: SummaryBucket[] = [
    { start: "2026-02-10", counts: counts(2), numbers: { duration: number(2, 24.691, 24.12, 25.262), rating: { ...number(0, null), rated: 0 }, stoppedAtTarget: { shots: 2, share: 1, atTarget: 2, byHand: 0, machineEnded: 0, error: 0, other: 0 } } },
    // Rated by one of its three, and none recorded what stopped it.
    { start: "2026-02-12", counts: counts(3, 1), numbers: { duration: number(3, 23.549), rating: { ...number(1, 8), rated: 1 / 3 }, stoppedAtTarget: { shots: 0, share: null, atTarget: 0, byHand: 0, machineEnded: 0, error: 0, other: 0 } } },
    { start: "2026-03-01", counts: counts(4), numbers: { duration: number(4, 25.833, 23.549, 25.833), rating: { ...number(0, null), rated: 0 }, stoppedAtTarget: { shots: 3, share: 2 / 3, atTarget: 2, byHand: 1, machineEnded: 0, error: 0, other: 0 } } },
    // The Shots whose time is unknown.
    { start: null, counts: { ...counts(1, 1), unfinished: 2 }, numbers: { duration: number(1, 30), rating: { ...number(0, null), rated: 0 }, stoppedAtTarget: { shots: 1, share: 1, atTarget: 1, byHand: 0, machineEnded: 0, error: 0, other: 0 } } },
  ];

  it("gives a median's point for each day with a value, at its date as a count of days, with the middle half's band", () => {
    expect(trendPoints(buckets, "duration")).toEqual([
      { start: "2026-02-10", at: 20494, value: 24.691, band: [24.12, 25.262], shots: 2, covered: 2 },
      { start: "2026-02-12", at: 20496, value: 23.549, band: [23.549, 23.549], shots: 3, covered: 3 },
      { start: "2026-03-01", at: 20513, value: 25.833, band: [23.549, 25.833], shots: 4, covered: 4 },
    ]);
  });

  it("gives no point for a day whose Shots had no value, and says how many of a day's Shots a value rests on", () => {
    // The one day with a Shot rated, 8 of Decaid's 10, in stars.
    expect(trendPoints(buckets, "rating")).toEqual([{ start: "2026-02-12", at: 20496, value: 4, band: [4, 4], shots: 1, covered: 3 }]);
    // A number the answer doesn't hold, as the one loaded before another was chosen.
    expect(trendPoints(buckets, "tds")).toEqual([]);
    expect(trendPoints([], "duration")).toEqual([]);
  });

  it("gives a rating's median and band in stars, two points of the summary's rating each, and no point where no Shot was rated (#532)", () => {
    const rated = (start: string, shots: number, median: number | null, p25 = median, p75 = median): SummaryBucket => ({ start, counts: counts(4), numbers: { rating: { ...number(shots, median, p25, p75), rated: shots / 4 } } });
    expect(TREND_UNITS.rating).toBe("stars");
    expect(trendPoints([rated("2026-02-10", 4, 8, 7, 9), rated("2026-02-11", 2, 7.5, 7.25, 7.75), rated("2026-02-12", 0, null), rated("2026-02-13", 1, 2), rated("2026-02-14", 3, 9, 8, 10)], "rating")).toEqual([
      { start: "2026-02-10", at: 20494, value: 4, band: [3.5, 4.5], shots: 4, covered: 4 },
      // A median between two stars, as it is.
      { start: "2026-02-11", at: 20495, value: 3.75, band: [3.625, 3.875], shots: 2, covered: 4 },
      { start: "2026-02-13", at: 20497, value: 1, band: [1, 1], shots: 1, covered: 4 },
      { start: "2026-02-14", at: 20498, value: 4.5, band: [4, 5], shots: 3, covered: 4 },
    ]);
    // No other number is changed.
    expect(trendPoints([{ start: "2026-02-10", counts: counts(1), numbers: { peakPressure: number(1, 8) } }], "peakPressure")[0]).toMatchObject({ value: 8, band: [8, 8] });
  });

  it("gives a share as a percentage with no band, and no point where no Shot either did or didn't", () => {
    expect(trendPoints(buckets, "stoppedAtTarget")).toEqual([
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

  it("reads a rating's point, in stars already, as stars, as the summary shows one (#532)", () => {
    expect(pointText({ value: 4, band: [3.5, 4.5] }, "rating")).toEqual({ value: "4 stars", range: "3.5–4.5" });
    expect(pointText({ value: 4.5, band: [4, 5] }, "rating")).toEqual({ value: "4.5 stars", range: "4–5" });
    expect(pointText({ value: 3.75, band: [3.625, 3.875] }, "rating")).toEqual({ value: "3.75 stars", range: "3.63–3.88" });
    expect(pointText({ value: 1, band: [1, 1] }, "rating")).toEqual({ value: "1 star", range: "1–1" });
  });

  it("reads a share as a whole percentage, with no range", () => {
    expect(pointText({ value: (2 / 3) * 100 }, "stoppedAtTarget")).toEqual({ value: "67%" });
    expect(pointText({ value: 0 }, "stoppedAtTarget")).toEqual({ value: "0%" });
  });
});

describe("a Trend of one Recipe marked where its Bean Batch changed (#733)", () => {
  const year = new Date().getFullYear();
  const now = new Date(year, 10, 27, 12);
  const day = (date: number) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.UTC(year, 10, date));
  const date = (of: number) => `${year}-11-${String(of).padStart(2, "0")}`;
  const batch = (id: string, roasted: number | null, batchCode: string | null): BatchLink => ({ id, bean: { id: "house", roaster: "Lantern", name: "House Espresso" }, roastDate: roasted === null ? null : `${date(roasted)}T00:00:00.000`, batchCode });
  /** A group of a summary by Bean Batch: the batch's Shots of each day, or those linked to none. */
  const group = (by: BatchLink | null, ...days: [start: string | null, shots: number][]): Pick<BucketedGroup, "by" | "buckets"> => ({
    by: { beanBatch: by },
    buckets: days.map(([start, shots]) => ({ start, counts: counts(shots), numbers: {} })),
  });
  const old = batch("old", 10, "LR-0405");
  const next = batch("next", 17, "LR-0411");
  const plain = batch("plain", 20, null);

  it("marks each batch once, on the first day a Shot charted was pulled with it, oldest first, however often the bar goes back to it", () => {
    // The summary lists batches the latest roasted first, and the bar went back to the old one on the 23rd.
    const marks = batchMarks([group(plain, [date(25), 3]), group(next, [date(21), 4], [date(22), 5]), group(old, [date(14), 6], [date(15), 6], [date(23), 1])]);
    expect(marks.map((mark) => [mark.batch.id, mark.start, mark.at === dayNumber(mark.start), mark.earliest])).toEqual([
      ["old", date(14), true, true],
      ["next", date(21), true, false],
      ["plain", date(25), true, false],
    ]);
  });

  it("makes no mark of Shots linked to no batch, nor of a day with only Shots the Trend leaves out, nor of Shots whose time is unknown", () => {
    // The old batch's first day held an Unfinished Shot alone, and one of its Shots has no time.
    const unfinished = { start: date(13), counts: { ...counts(0), unfinished: 1 }, numbers: {} };
    const marks = batchMarks([{ by: { beanBatch: old }, buckets: [unfinished, { start: date(14), counts: counts(2), numbers: {} }, { start: null, counts: counts(1), numbers: {} }] }, group(null, [date(16), 3])]);
    expect(marks.map((mark) => [mark.batch.id, mark.start, mark.earliest])).toEqual([["old", date(14), true]]);
    expect(batchMarks([group(null, [date(14), 3])])).toEqual([]);
    expect(batchMarks([])).toEqual([]);
  });

  it("gives the first batch a line, not the left edge, where Shots linked to none were pulled before it", () => {
    expect(batchMarks([group(old, [date(16), 2]), group(null, [date(14), 3])]).map((mark) => mark.earliest)).toEqual([false]);
    // On its own first day, unlinked Shots beside it leave it the earliest.
    expect(batchMarks([group(old, [date(14), 2]), group(null, [date(14), 3])]).map((mark) => mark.earliest)).toEqual([true]);
  });

  it("stands two batches first used on one day in the order they were roasted", () => {
    expect(batchMarks([group(next, [date(14), 1]), group(old, [date(14), 1])]).map((mark) => [mark.batch.id, mark.earliest])).toEqual([
      ["old", true],
      ["next", false],
    ]);
  });

  it("marks nothing of the previous release's answer, which has no buckets, or names no batch (ADR-0025)", () => {
    expect(batchMarks([{ by: { beanBatch: old } }, { by: {}, buckets: [{ start: date(14), counts: counts(2), numbers: {} }] }])).toEqual([]);
  });

  it("marks by week as by day, on the week's Monday", () => {
    const marks = batchMarks([group(old, ["2026-11-09", 9]), group(next, ["2026-11-16", 4], ["2026-11-23", 8])]);
    expect(marks.map((mark) => [mark.batch.id, mark.start, mark.earliest])).toEqual([
      ["old", "2026-11-09", true],
      ["next", "2026-11-16", false],
    ]);
  });

  it("labels a mark with its batch's Batch Code, or its roast date where it has none", () => {
    expect(markLabel(next, now)).toEqual({ text: "LR-0411", code: true });
    expect(markLabel(plain, now)).toEqual({ text: `roasted ${day(20)}`, code: false });
    expect(markLabel(batch("undated", null, null), now)).toEqual({ text: "no roast date", code: false });
    // The previous release sends no Batch Code.
    expect(markLabel({ roastDate: `${date(17)}T00:00:00.000` }, now)).toEqual({ text: `roasted ${day(17)}`, code: false });
  });

  it("lists each batch from its first day, or week, and the earliest until then where another follows it", () => {
    const marks = batchMarks([group(old, [date(14), 6]), group(next, [date(21), 4])]);
    expect(marks.map((mark) => markLead(mark, marks, "day", now))).toEqual(["Until then", `From ${day(21)}`]);
    expect(marks.map((mark) => markLead(mark, marks, "week", now))).toEqual(["Until then", `From the week of ${day(21)}`]);
    // One batch alone, and one that follows Shots linked to none, are each from their first day.
    const alone = batchMarks([group(old, [date(14), 6])]);
    expect(markLead(alone[0]!, alone, "day", now)).toBe(`From ${day(14)}`);
    const after = batchMarks([group(old, [date(16), 2]), group(next, [date(21), 4]), group(null, [date(14), 3])]);
    expect(after.map((mark) => markLead(mark, after, "day", now))).toEqual([`From ${day(16)}`, `From ${day(21)}`]);
  });

  describe("on a chart", () => {
    const marks = batchMarks([group(old, [date(14), 6]), group(next, [date(21), 4]), group(plain, [date(25), 3])]);
    const span = [dayNumber(date(14)), dayNumber(date(27))] as const;

    it("draws the earliest batch at the left edge with no line, and a line for each other on its first day", () => {
      const drawn = drawnMarks(marks, span);
      expect(drawn.edge?.batch.id).toBe("old");
      expect(drawn.lines.map((mark) => mark.batch.id)).toEqual(["next", "plain"]);
      // A chart of 30 days whose first Shots are days in: its batch is still the edge's.
      expect(drawnMarks(marks, [dayNumber(date(1)), dayNumber(date(30))]).edge?.batch.id).toBe("old");
      expect(drawnMarks([], span)).toEqual({ lines: [] });
    });

    it("labels at the left edge the last batch first used before the chart begins, and draws none first used beyond either end", () => {
      // The number charted has its first value on the 22nd, and its last on the 24th.
      const drawn = drawnMarks(marks, [dayNumber(date(22)), dayNumber(date(24))]);
      expect(drawn.edge?.batch.id).toBe("next");
      expect(drawn.lines).toEqual([]);
      // A batch first used after Shots linked to none has a line, and nothing is at the edge.
      const after = batchMarks([group(old, [date(16), 2]), group(null, [date(14), 3])]);
      expect(drawnMarks(after, span)).toEqual({ lines: after });
    });

    it("puts a day across the chart as its time axis does: the first and last days inside the plot's ends", () => {
      expect(lineX(span[0], span, 800)).toBe(PLOT.left + PLOT.pad);
      expect(lineX(span[1], span, 800)).toBe(800 - PLOT.right - PLOT.pad);
      expect(lineX((span[0] + span[1]) / 2, span, 800)).toBe((PLOT.left + PLOT.pad + 800 - PLOT.right - PLOT.pad) / 2);
    });

    it("writes the edge's label at the plot's left and each line's beside its line, wide enough for its text", () => {
      const places = labelPlaces(drawnMarks(marks, span), span, 800, now);
      expect(places.map((place) => [place.mark.batch.id, place.text, place.code])).toEqual([
        ["old", "LR-0405", true],
        ["next", "LR-0411", true],
        ["plain", `roasted ${day(20)}`, false],
      ]);
      expect(places[0]!.left).toBe(PLOT.left);
      expect(places[1]!.left).toBeGreaterThan(lineX(dayNumber(date(21)), span, 800));
      for (const place of places) expect(place.width).toBe(labelWidth(place));
      // None is drawn over another.
      for (const [index, place] of places.entries()) for (const other of places.slice(index + 1)) expect(place.left + place.width).toBeLessThan(other.left);
    });

    it("leaves out a label that would be drawn over another, keeping the earlier, and writes one left of its line where the chart ends first", () => {
      // The next batch came on the 15th, a day after the chart begins: its label would stand on the edge's.
      const close = batchMarks([group(old, [date(14), 6]), group(next, [date(15), 4]), group(plain, [date(27), 3])]);
      const drawn = drawnMarks(close, span);
      const places = labelPlaces(drawn, span, 600, now);
      expect(drawn.lines.map((mark) => mark.batch.id)).toEqual(["next", "plain"]);
      expect(places.map((place) => place.mark.batch.id)).toEqual(["old", "plain"]);
      // The last day's label has no room right of its line.
      const last = places[1]!;
      expect(last.left + last.width).toBeLessThan(lineX(dayNumber(date(27)), span, 600));
      // A chart too narrow for any label writes none, and the list under it still names each batch.
      expect(labelPlaces(drawn, span, 80, now)).toEqual([]);
    });
  });
});
