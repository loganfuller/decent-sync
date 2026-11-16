import { describe, expect, it } from "vitest";
import type { SummaryGroup, SummaryNumbers } from "../src/lib/api";
import { RECIPE_TRENDS, machineNumbers, machineShotsPath, recipeTrend, trendDays } from "../src/lib/recipe-numbers";

// A Recipe's numbers on its page (#474, #547), the pure parts: the trend's
// 30 days at its Location, the number its address keeps, the Shots list's
// address for a Machine's Shots of it, and a Machine's numbers as its row
// says them.

describe("a Recipe's trend's days", () => {
  it("are the 30 days that end with today at its Location", () => {
    // 03:00 UTC on the 11th is still the 10th in Denver, and already noon on the 11th in Tokyo.
    const now = Date.parse("2026-11-11T03:00:00Z");
    expect(trendDays("America/Denver", now)).toEqual({ from: "2026-10-12", to: "2026-11-10" });
    expect(trendDays("Asia/Tokyo", now)).toEqual({ from: "2026-10-13", to: "2026-11-11" });
  });

  it("are UTC's for a Recipe at no Location, and count back across a year's end and a leap day", () => {
    expect(trendDays(undefined, Date.parse("2027-01-03T23:30:00Z"))).toEqual({ from: "2026-12-05", to: "2027-01-03" });
    expect(trendDays("UTC", Date.parse("2028-03-10T12:00:00Z")).from).toBe("2028-02-10");
  });
});

describe("the number a Recipe's trend charts", () => {
  it("is duration where the address names none, or one it doesn't chart", () => {
    expect(RECIPE_TRENDS).toEqual(["duration", "yieldAgainstTarget", "grindSetting"]);
    expect(recipeTrend(null)).toBe("duration");
    expect(recipeTrend("ratio")).toBe("duration");
    expect(recipeTrend("")).toBe("duration");
  });

  it("is the one the address names of those it charts", () => {
    for (const name of RECIPE_TRENDS) expect(recipeTrend(name)).toBe(name);
  });
});

describe("a Machine's Shots of a Recipe in the Shots list", () => {
  it("are found by the Recipe, the Machine and the list's preset of the days", () => {
    expect(machineShotsPath("recipe-1", "machine-1", "7days")).toBe("/shots?recipeId=recipe-1&machineId=machine-1&period=7days");
    expect(machineShotsPath("recipe-1", "machine-1", "today")).toBe("/shots?recipeId=recipe-1&machineId=machine-1&period=today");
  });

  it("have the list's trend open, charting the number given", () => {
    expect(machineShotsPath("recipe-1", "machine-1", "30days", "grindSetting")).toBe("/shots?recipeId=recipe-1&machineId=machine-1&period=30days&trend=grindSetting");
  });
});

describe("a Machine's numbers of a Recipe", () => {
  const number = (median: number, p25: number, p75: number) => ({ median, p25, p75 }) as SummaryNumbers["duration"];
  const stops = (atTarget: number, shots: number) => ({ shots, share: atTarget / shots, atTarget, byHand: shots - atTarget, machineEnded: 0, error: 0, other: 0 });
  const within = { judgement: "withinSpec", beyondMargin: false } as const;
  const outOfSpec = { judgement: "outOfSpec", beyondMargin: true } as const;
  const group = (given: Partial<SummaryGroup>): SummaryGroup => ({
    by: { machine: { id: "machine-1", name: "Left" } },
    counts: { shots: 12, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 },
    numbers: { duration: number(29.4, 27.1, 33.1), yieldAgainstTarget: number(-0.1, -0.4, 0.2), stoppedAtTarget: stops(11, 12) },
    ...given,
  });

  it("are its median duration with the middle half's range, its yield against target and the share stopped at target", () => {
    expect(machineNumbers(group({ spec: { yield: within, stoppedAtTarget: within } }))).toEqual({
      duration: { median: "29.4 s", range: "27.1–33.1" },
      against: undefined,
      yield: { text: "−0.1 g", marked: false },
      stopping: { text: "92%", marked: false },
      leftOut: [],
    });
  });

  it("set the duration against the Reference Shot's, marked when out of spec and muted otherwise", () => {
    const against = (duration: NonNullable<SummaryGroup["spec"]>["duration"]) => machineNumbers(group({ spec: { duration, yield: within, stoppedAtTarget: within } })).against;
    expect(against({ ...outOfSpec, difference: -6.2 })).toEqual({ text: "−6.2 s vs reference", short: "−6.2 s", marked: true });
    expect(against({ ...within, difference: -2.3 })).toEqual({ text: "−2.3 s vs reference", short: "−2.3 s", marked: false });
    // Too few Shots to judge: the difference is said, unmarked.
    expect(against({ judgement: "notJudged", beyondMargin: true, difference: 9 })?.marked).toBe(false);
  });

  it("mark the yield and the stopping only where the server judged each out of spec", () => {
    const judged = machineNumbers(group({ spec: { yield: outOfSpec, stoppedAtTarget: outOfSpec } }));
    expect(judged.yield).toEqual({ text: "−0.1 g", marked: true });
    expect(judged.stopping).toEqual({ text: "92%", marked: true });
    const few = machineNumbers(group({ spec: { yield: { judgement: "notJudged", beyondMargin: true }, stoppedAtTarget: { judgement: "notJudged", beyondMargin: true } } }));
    expect([few.yield?.marked, few.stopping?.marked]).toEqual([false, false]);
  });

  it("say what the numbers leave out, and give none of what no Shot had", () => {
    const sparse = machineNumbers(group({ counts: { shots: 2, unfinished: 1, cleaningAndCalibration: 2, awaitingValues: 0 }, numbers: { duration: { median: null, p25: null, p75: null } as SummaryNumbers["duration"] } }));
    expect(sparse).toEqual({ duration: undefined, against: undefined, leftOut: ["1 unfinished", "2 cleaning or calibration"] });
  });

  it("mark nothing of the previous release's answer, which judges nothing and counts no stops at target", () => {
    const previous = machineNumbers(group({ numbers: { duration: number(29.4, 27.1, 33.1), yieldAgainstTarget: number(3, 2, 4), stoppedOnWeight: { shots: 12, share: 0.5 } } }));
    expect(previous).toEqual({ duration: { median: "29.4 s", range: "27.1–33.1" }, against: undefined, yield: { text: "+3.0 g", marked: false }, leftOut: [] });
  });
});
