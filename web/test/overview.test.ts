import { describe, expect, it } from "vitest";
import type { GroupSpec, Judgement, Machine, Recipe, ShotSpec, SummaryGroup } from "../src/lib/api";
import { betweenMachinesLine, cellFilters, cellLines, coveredText, daysSinceRoast, lastShotMarks, offlineKind, overviewColumns, overviewRows, periodDays, periodOf, rowBatch } from "../src/lib/overview";

// The Overview's pure parts (#471, #543): a period's days at a Location, a
// Shot Summary grouped by Recipe and Machine as a block's rows and columns,
// and what a cell, a row and a status card say of the server's judgement.

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

describe("a row's Bean Batch line (#733)", () => {
  /** A Recipe naming a batch roasted on 30 October, as far as the line reads one. */
  const named = (location: typeof LAB, batchFinished = false, roastDate: string | null = "2026-10-30T00:00:00.000") =>
    ({ location, batchFinished, uses: { beanBatch: { id: "b1", roastDate, batchCode: "LR-0411", atLocation: !batchFinished } } }) as Recipe;
  const today = "2026-11-11";

  it("gives the batch's days since roast and what is left of it at the Location, a plain weight, or that it is not tracked there", () => {
    expect(rowBatch(named(LAB), "lab", today, new Map([["b1", 3240]]))).toEqual({ days: 12, weight: "3240 g here", finished: false });
    expect(rowBatch(named(LAB), "lab", today, new Map([["b1", 0]]))).toEqual({ days: 12, weight: "0 g here", finished: false });
    expect(rowBatch(named(LAB), "lab", today, new Map([["b1", null]]))).toEqual({ days: 12, weight: "not tracked here", finished: false });
    // A batch with no roast date has no days.
    expect(rowBatch(named(LAB, false, null), "lab", today, new Map([["b1", 3240]]))).toEqual({ weight: "3240 g here", finished: false });
  });

  it("says the batch is finished there in the weight's place", () => {
    expect(rowBatch(named(LAB, true), "lab", today, new Map([["b1", 3240]]))).toEqual({ days: 12, finished: true });
  });

  it("gives another Location's Recipe its days and no weight, and so any row where no weight was read", () => {
    // The Harbor's Recipe, pulled at the Lab: its batch's weight at the Lab is not its Location's, and it is finished at neither here.
    expect(rowBatch(named(HARBOR), "lab", today, new Map([["b1", 3240]]))).toEqual({ days: 12, finished: false });
    expect(rowBatch(named(HARBOR, true), "lab", today, new Map())).toEqual({ days: 12, finished: false });
    // The Location's batches could not be read, or name no weight of this one (ADR-0025).
    expect(rowBatch(named(LAB), "lab", today, undefined)).toEqual({ days: 12, finished: false });
    expect(rowBatch(named(LAB), "lab", today, new Map())).toEqual({ days: 12, finished: false });
  });

  it("is none for a Recipe that names no batch, or is not read yet", () => {
    expect(rowBatch({ location: LAB, batchFinished: false, uses: { beanBatch: null } } as Recipe, "lab", today, new Map())).toBeUndefined();
    expect(rowBatch(undefined, "lab", today, new Map())).toBeUndefined();
  });
});

describe("a Location's block", () => {
  const house = recipe("House", LAB, 2);
  const decaf = recipe("Decaf", LAB, 1);
  const guest = recipe("Guest", LAB, null);
  // Another Location's, in a slot there.
  const harborHouse = recipe("Harbor House", HARBOR, 1);
  const recipes = [decaf, house, guest, harborHouse];

  it("has a column for each Machine there now, in the Machines list's order, then any other whose Shots the groups hold, by name", () => {
    const machines = [machine("left", LAB), machine("Moved", HARBOR), machine("right", LAB), machine("spare", null)];
    // The groups come by Recipe first, so the Machines since moved away come in no order of their own.
    const groups = [group(decaf, "Moved"), group(house, "right"), group(house, "gone"), group(null, "Moved")];
    expect(overviewColumns(groups, machines, LAB.id)).toEqual([
      { id: "left", name: "left", machine: machines[0], here: true },
      { id: "right", name: "right", machine: machines[2], here: true },
      // One the Machines list doesn't hold is named as the summary names it.
      { id: "gone", name: "gone", machine: undefined, here: false },
      { id: "Moved", name: "Moved", machine: machines[1], here: false },
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

  it("gives a row its Recipe's Reference Shot and its judgement between Machines, as any of its groups gives them", () => {
    const reference = { id: "reference", numbers: { duration: 30 } };
    const betweenMachines = { judgement: "outOfSpec" as const, beyondMargin: true, apart: 4 };
    const spec = { yield: NOTHING, stoppedAtTarget: NOTHING, betweenMachines };
    const rows = overviewRows([{ ...group(house, "left"), reference, spec }, { ...group(house, "right"), reference, spec }, group(decaf, "left"), group(null, "left")], recipes, LAB.id);
    expect(rows.map((row) => [row.recipe?.id ?? null, row.reference, row.betweenMachines])).toEqual([
      // As the previous release answers during a deploy: with neither.
      ["Decaf", undefined, undefined],
      ["House", reference, betweenMachines],
      [null, undefined, undefined],
    ]);
  });

  it("has no row where nothing was pulled", () => {
    expect(overviewRows([], recipes, LAB.id)).toEqual([]);
  });

  it("opens a cell as the Shots list's filters: its Location, Machine, Recipe or none, and the period as the list's date preset", () => {
    expect(cellFilters("lab", "left", "house", "week")).toBe("locationId=lab&machineId=left&recipeId=house&period=7days");
    expect(cellFilters("lab", "left", null, "today")).toBe("locationId=lab&machineId=left&recipeId=none&period=today");
    expect(cellFilters("lab", "left", null, "yesterday")).toBe("locationId=lab&machineId=left&recipeId=none&period=yesterday");
  });
});

const WITHIN: Judgement = { judgement: "withinSpec", beyondMargin: false };
const OUT: Judgement = { judgement: "outOfSpec", beyondMargin: true };
const FEW_BEYOND: Judgement = { judgement: "notJudged", beyondMargin: true };
const FEW_WITHIN: Judgement = { judgement: "notJudged", beyondMargin: false };
const NOTHING: Judgement = { judgement: "notJudged", beyondMargin: null };

describe("what a block says of the server's judgement", () => {
  /** A cell of `shots` Shots, 1.8 g under their target, of which `atTarget` stopped at it, judged as given. */
  const cell = (shots: number, atTarget: number, spec: GroupSpec, counts: Partial<SummaryGroup["counts"]> = {}): SummaryGroup => ({
    by: {},
    counts: { shots, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0, ...counts },
    numbers: {
      yieldAgainstTarget: { shots, median: -1.84, p25: -2, p75: -1 },
      duration: { shots, median: 29.4, p25: 27, p75: 33 },
      stoppedAtTarget: { shots, share: atTarget / shots, atTarget, byHand: shots - atTarget, machineEnded: 0, error: 0, other: 0 },
    },
    spec,
  });

  it("says how many Shots a period's numbers cover, with the Unfinished Shots beside them", () => {
    const groups = [cell(299, 299, { yield: WITHIN, stoppedAtTarget: WITHIN }, { unfinished: 2 }), cell(1, 1, { yield: WITHIN, stoppedAtTarget: WITHIN }, { unfinished: 1, cleaningAndCalibration: 4 })];
    expect(coveredText(groups, "week")).toBe("300 Shots in the last 7 days · 3 unfinished");
    expect(coveredText(groups.slice(1), "today")).toBe("1 Shot today · 1 unfinished");
    expect(coveredText([cell(12, 12, { yield: WITHIN, stoppedAtTarget: WITHIN })], "yesterday")).toBe("12 Shots yesterday");
    expect(coveredText([], "today")).toBe("No Shots today");
  });

  it("always gives a cell's difference from the reference, marked when out of spec and muted otherwise", () => {
    const judged = (duration: GroupSpec["duration"]) => cellLines(cell(299, 299, { duration, yield: WITHIN, stoppedAtTarget: WITHIN }));
    expect(judged({ ...OUT, difference: -6.2 })).toEqual({ duration: { text: "−6.2 s vs reference", short: "−6.2 s", marked: true }, leftOut: [] });
    expect(judged({ ...WITHIN, difference: -2.31 })).toEqual({ duration: { text: "−2.3 s vs reference", short: "−2.3 s", marked: false }, leftOut: [] });
    // Too few Shots to judge, though they are beyond the margin.
    expect(judged({ ...FEW_BEYOND, difference: 9 })).toEqual({ duration: { text: "+9.0 s vs reference", short: "+9.0 s", marked: false }, leftOut: [] });
    // A Recipe with no Reference Shot, and Shots with no duration.
    expect(judged(undefined)).toEqual({ leftOut: [] });
    expect(judged({ ...NOTHING, difference: null })).toEqual({ leftOut: [] });
  });

  it("gives a cell's yield and stopping only when out of spec, marked, or beyond a margin with too few Shots to judge, muted", () => {
    expect(cellLines(cell(7, 0, { yield: OUT, stoppedAtTarget: OUT }))).toEqual({
      yield: { text: "−1.8 g vs target", short: "−1.8 g", marked: true },
      stopping: { text: "0 of 7 stopped at target", short: "0 of 7 at target", marked: true },
      leftOut: [],
    });
    expect(cellLines(cell(1, 0, { yield: FEW_BEYOND, stoppedAtTarget: FEW_BEYOND }))).toEqual({
      yield: { text: "−1.8 g vs target", short: "−1.8 g", marked: false },
      stopping: { text: "0 of 1 stopped at target", short: "0 of 1 at target", marked: false },
      leftOut: [],
    });
    // Within spec, and too few within the margin, say nothing; each is shown apart from the other.
    expect(cellLines(cell(299, 293, { yield: WITHIN, stoppedAtTarget: WITHIN }))).toEqual({ leftOut: [] });
    expect(cellLines(cell(2, 2, { yield: FEW_WITHIN, stoppedAtTarget: NOTHING }))).toEqual({ leftOut: [] });
    expect(Object.keys(cellLines(cell(40, 30, { yield: WITHIN, stoppedAtTarget: OUT })))).toEqual(["stopping", "leftOut"]);
  });

  it("keeps a cell's Unfinished Shots and its cleaning and calibration Shots, and says no more of the previous release's answer", () => {
    expect(cellLines(cell(56, 56, { yield: WITHIN, stoppedAtTarget: WITHIN }, { unfinished: 1, cleaningAndCalibration: 2 })).leftOut).toEqual(["1 unfinished", "2 cleaning or calibration"]);
    const { spec: _judged, ...unjudged } = cell(7, 0, { yield: OUT, stoppedAtTarget: OUT }, { unfinished: 1 });
    expect(cellLines(unjudged)).toEqual({ leftOut: ["1 unfinished"] });
  });

  it("says how far apart a Recipe's Machines are, marked when out of spec between them", () => {
    expect(betweenMachinesLine({ ...OUT, apart: 4 })).toEqual({ text: "4.0 s apart", short: "4.0 s apart", marked: true });
    expect(betweenMachinesLine({ ...WITHIN, apart: 0.46 })).toEqual({ text: "0.5 s apart", short: "0.5 s apart", marked: false });
    expect(betweenMachinesLine({ ...FEW_BEYOND, apart: 10 })).toMatchObject({ text: "10.0 s apart", marked: false });
    // One Machine pulled it, and the Shots pulled with no Recipe.
    expect(betweenMachinesLine({ ...NOTHING, apart: null })).toBeUndefined();
    expect(betweenMachinesLine(undefined)).toBeUndefined();
  });

  it("marks what of a Machine's last Shot is out of spec, and nothing of one within spec or not judged", () => {
    const spec = (parts: Partial<ShotSpec>): ShotSpec => ({ unfinished: false, cleaningOrCalibration: false, duration: null, yield: null, stopped: "targetWeight", ...parts });
    expect(lastShotMarks(spec({ duration: { difference: -6.44, outOfSpec: true }, yield: { againstTarget: -88.9, outOfSpec: true } }))).toEqual(["−6.4 s vs reference", "−88.9 g vs target"]);
    expect(lastShotMarks(spec({ duration: { difference: 1, outOfSpec: false }, yield: { againstTarget: 2.4, outOfSpec: true } }))).toEqual(["+2.4 g vs target"]);
    expect(lastShotMarks(spec({ unfinished: true }))).toEqual([]);
    // The previous release's answer.
    expect(lastShotMarks(undefined)).toEqual([]);
  });

  it("reads a Machine offline as asleep where its last Machine State was, as awake otherwise, and as never connected", () => {
    const state = (name: string) => ({ state: name, substate: "idle", observedAt: "2026-11-15T12:00:00Z" });
    expect(offlineKind({ lastSeenAt: "2026-11-15T12:50:00Z", machineState: state("sleeping") })).toBe("asleep");
    expect(offlineKind({ lastSeenAt: "2026-11-15T12:50:00Z", machineState: state("idle") })).toBe("awake");
    // Seen, though its tablet reported no Machine State.
    expect(offlineKind({ lastSeenAt: "2026-11-15T12:50:00Z", machineState: null })).toBe("awake");
    expect(offlineKind({ lastSeenAt: null, machineState: null })).toBe("never");
  });
});
