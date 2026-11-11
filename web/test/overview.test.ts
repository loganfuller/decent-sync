import { describe, expect, it } from "vitest";
import type { Machine, Recipe, SummaryGroup } from "../src/lib/api";
import { cellFilters, daysSinceRoast, overviewColumns, overviewRows, periodDays, periodOf } from "../src/lib/overview";

// The Overview's pure parts (#471): a period's days at a Location, and a
// Shot Summary grouped by Recipe and Machine as a block's rows and columns.

const LAB = { id: "lab", name: "Lab", timeZone: "America/Denver" };
const HARBOR = { id: "harbor", name: "Harbor", timeZone: "Asia/Tokyo" };

/** A Machine, as far as a block reads one. */
const machine = (id: string, location: typeof LAB | null): Machine => ({ id, name: id, location }) as Machine;

/** A Recipe, as far as a block reads one. */
const recipe = (id: string, location: typeof LAB, slot: number | null): Recipe => ({ id, name: id, location, slot }) as Recipe;

/** A group of a summary by Recipe and Machine: a Machine's Shots of a Recipe, or of none. */
function group(recipeOf: Recipe | null, machineId: string, shots = 1): SummaryGroup {
  return {
    by: {
      recipe: recipeOf && { id: recipeOf.id, name: recipeOf.name, location: recipeOf.location && { id: recipeOf.location.id, name: recipeOf.location.name } },
      machine: { id: machineId, name: machineId },
    },
    counts: { shots, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 },
    numbers: {},
  };
}

describe("the Overview's periods", () => {
  it("reads the period an address names, and today for none or one it doesn't know", () => {
    expect(periodOf(null)).toBe("today");
    expect(periodOf("yesterday")).toBe("yesterday");
    expect(periodOf("week")).toBe("week");
    expect(periodOf("month")).toBe("today");
  });

  it("takes a period's days from the wall clock of the Location's time zone", () => {
    // 03:00 UTC on the 11th is still the 10th in Denver, and already noon on the 11th in Tokyo.
    const now = Date.parse("2026-11-11T03:00:00Z");
    expect(periodDays("today", LAB.timeZone, now)).toEqual({ from: "2026-11-10", to: "2026-11-10", today: "2026-11-10" });
    expect(periodDays("today", HARBOR.timeZone, now)).toEqual({ from: "2026-11-11", to: "2026-11-11", today: "2026-11-11" });
    expect(periodDays("yesterday", LAB.timeZone, now)).toEqual({ from: "2026-11-09", to: "2026-11-09", today: "2026-11-10" });
    // Seven days, today the last of them.
    expect(periodDays("week", HARBOR.timeZone, now)).toEqual({ from: "2026-11-05", to: "2026-11-11", today: "2026-11-11" });
  });

  it("counts days back across a month's and a year's end, and a day the clocks change on", () => {
    expect(periodDays("yesterday", "UTC", Date.parse("2026-03-01T12:00:00Z"))).toMatchObject({ from: "2026-02-28", to: "2026-02-28" });
    expect(periodDays("week", "UTC", Date.parse("2027-01-03T12:00:00Z"))).toMatchObject({ from: "2026-12-28", to: "2027-01-03" });
    // Denver's clocks went back on 2026-11-01, a day of 25 hours there.
    expect(periodDays("week", LAB.timeZone, Date.parse("2026-11-03T18:00:00Z"))).toMatchObject({ from: "2026-10-28", to: "2026-11-03" });
  });

  it("counts the days since a roast to today, and none for no date or one after today", () => {
    expect(daysSinceRoast("2026-10-30T00:00:00.000", "2026-11-11")).toBe(12);
    expect(daysSinceRoast("2026-11-10", "2026-11-11")).toBe(1);
    expect(daysSinceRoast("2026-11-11T23:00:00.000Z", "2026-11-11")).toBe(0);
    expect(daysSinceRoast("2026-11-12", "2026-11-11")).toBeUndefined();
    expect(daysSinceRoast(null, "2026-11-11")).toBeUndefined();
    expect(daysSinceRoast("last week", "2026-11-11")).toBeUndefined();
  });
});

describe("a Location's block", () => {
  const house = recipe("House", LAB, 2);
  const decaf = recipe("Decaf", LAB, 1);
  const guest = recipe("Guest", LAB, null);
  // Another Location's, in a slot there.
  const harborHouse = recipe("Harbor House", HARBOR, 1);
  const recipes = [decaf, house, guest, harborHouse];

  it("has a column for each Machine there now, in the Machines list's order, then any other whose Shots the groups hold", () => {
    const machines = [machine("left", LAB), machine("moved", HARBOR), machine("right", LAB), machine("spare", null)];
    const groups = [group(house, "right"), group(house, "moved"), group(house, "gone"), group(null, "moved")];
    expect(overviewColumns(groups, machines, LAB.id)).toEqual([
      { id: "left", name: "left", machine: machines[0], here: true },
      { id: "right", name: "right", machine: machines[2], here: true },
      { id: "moved", name: "moved", machine: machines[1], here: false },
      // One the Machines list doesn't hold is named as the summary names it.
      { id: "gone", name: "gone", machine: undefined, here: false },
    ]);
    // With no Shots, its Machines alone.
    expect(overviewColumns([], machines, LAB.id).map((column) => column.id)).toEqual(["left", "right"]);
  });

  it("orders its rows by Recipe Slot, then the Recipes in none and other Locations' as the summary orders them, then the Shots with no Recipe", () => {
    // As the summary gives them: by the Recipe's name, the Shots with none last, and then by Machine.
    const groups = [group(decaf, "left"), group(guest, "right"), group(harborHouse, "left"), group(house, "left", 2), group(house, "right", 3), group(null, "left")];
    const rows = overviewRows(groups, recipes, LAB.id);
    expect(rows.map((row) => [row.recipe?.id ?? null, row.slot])).toEqual([
      ["Decaf", 1],
      ["House", 2],
      ["Guest", null],
      // Its slot is Harbor's, so here it is in none.
      ["Harbor House", null],
      [null, null],
    ]);
    expect(rows[1]!.details).toBe(house);
    expect([...rows[1]!.cells].map(([machineId, cell]) => [machineId, cell.counts.shots])).toEqual([
      ["left", 2],
      ["right", 3],
    ]);
    expect(rows[3]!.recipe?.location).toEqual({ id: "harbor", name: "Harbor" });
    expect(rows[4]!.details).toBeUndefined();
  });

  it("has no row where nothing was pulled", () => {
    expect(overviewRows([], recipes, LAB.id)).toEqual([]);
  });

  it("opens a cell as the Shots list's filters: its Location, Machine, Recipe or none, and the period's days", () => {
    const days = { from: "2026-11-05", to: "2026-11-11" };
    expect(cellFilters("lab", "left", "house", days)).toBe("locationId=lab&machineId=left&recipeId=house&from=2026-11-05&to=2026-11-11");
    expect(cellFilters("lab", "left", null, days)).toBe("locationId=lab&machineId=left&recipeId=none&from=2026-11-05&to=2026-11-11");
  });
});
