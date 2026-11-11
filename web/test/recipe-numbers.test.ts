import { describe, expect, it } from "vitest";
import { RECIPE_TRENDS, machineShotsPath, recipeDays, recipeTrend } from "../src/lib/recipe-numbers";

// A Recipe's numbers on its page (#474), the pure parts: today and the
// trend's 30 days at its Location, the number its address keeps, and the
// Shots list's address for a Machine's Shots of it.

describe("a Recipe's days", () => {
  it("gives today at its Location, and the 30 days that end with it", () => {
    // 03:00 UTC on the 11th is still the 10th in Denver, and already noon on the 11th in Tokyo.
    const now = Date.parse("2026-11-11T03:00:00Z");
    expect(recipeDays("America/Denver", now)).toEqual({ today: "2026-11-10", trend: { from: "2026-10-12", to: "2026-11-10" } });
    expect(recipeDays("Asia/Tokyo", now)).toEqual({ today: "2026-11-11", trend: { from: "2026-10-13", to: "2026-11-11" } });
  });

  it("reads UTC's day for a Recipe at no Location, and counts back across a year's end and a leap day", () => {
    expect(recipeDays(undefined, Date.parse("2027-01-03T23:30:00Z"))).toEqual({ today: "2027-01-03", trend: { from: "2026-12-05", to: "2027-01-03" } });
    expect(recipeDays("UTC", Date.parse("2028-03-10T12:00:00Z")).trend.from).toBe("2028-02-10");
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
  const days = { from: "2026-10-13", to: "2026-11-11" };

  it("are found by the Recipe, the Machine and the days", () => {
    expect(machineShotsPath("recipe-1", "machine-1", days)).toBe("/shots?recipeId=recipe-1&machineId=machine-1&from=2026-10-13&to=2026-11-11");
    expect(machineShotsPath("recipe-1", "machine-1", { from: "2026-11-11", to: "2026-11-11" })).toBe("/shots?recipeId=recipe-1&machineId=machine-1&from=2026-11-11&to=2026-11-11");
  });

  it("have the list's trend chart the number given, none named for its default", () => {
    expect(machineShotsPath("recipe-1", "machine-1", days, "grindSetting")).toBe("/shots?recipeId=recipe-1&machineId=machine-1&from=2026-10-13&to=2026-11-11&trend=grindSetting");
    expect(machineShotsPath("recipe-1", "machine-1", days, "duration")).toBe("/shots?recipeId=recipe-1&machineId=machine-1&from=2026-10-13&to=2026-11-11");
  });
});
