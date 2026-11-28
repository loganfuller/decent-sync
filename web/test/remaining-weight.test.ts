import { describe, expect, it } from "vitest";
import type { BatchAtLocation, EditSource, ItemVersion } from "../src/lib/api";
import { atLines, atText, barOf, batchesCountText, dayText, differenceText, enteredBy, leftHereText, leftText, movedLine, startText, totalLine, totalText, weightLine, weightLineParts, weightText } from "../src/lib/remaining-weight";

// What the management interface writes of a Bean Batch's Remaining Weight at a Location (#706), with what Batch Moves have brought and taken since its count started (#704),
// and what a batch's page, the list of batches and the Enter weight dialog lead with (#726).

const location = { id: "l1", name: "Downtown", timeZone: "America/Chicago" };
const sam: EditSource = { machine: null, tabletId: null, account: { id: "a1", name: "Sam" }, connectedApp: null };
const now = new Date(2026, 10, 26, 12);
const at = new Date(2026, 10, 25, 9).toISOString();

function here(changes: Partial<BatchAtLocation>): BatchAtLocation {
  return { location, remainingWeight: 3420, since: at, entered: { weight: 4180, at, by: sam }, used: { shots: 38, weight: 760 }, ...changes };
}

describe("a batch's Remaining Weight in words", () => {
  it("reads a weight in grams and none as not tracked, never as zero", () => {
    expect(weightText(3420)).toBe("3420 g");
    expect(weightText(981.5)).toBe("981.5 g");
    expect(weightText(0)).toBe("0 g");
    expect(weightText(null)).toBe("Not tracked");
  });

  it("counts a Bean's batches at a Location and what the Locations that track them hold in all (#732)", () => {
    const batch = (changes: { archived?: boolean; locations?: BatchAtLocation[]; totalRemainingWeight?: number | null }) => ({ archived: false, locations: [here({})], totalRemainingWeight: 3420, ...changes });
    expect(batchesCountText([batch({}), batch({ locations: [here({}), here({ remainingWeight: 1850 })], totalRemainingWeight: 5270 }), batch({ locations: [here({ remainingWeight: null })], totalRemainingWeight: null })])).toBe(
      "3 at a Location, 8690 g in all",
    );
    // One at no Location, and one Archived, whatever it was at, are counted in neither.
    expect(batchesCountText([batch({}), batch({ locations: [], totalRemainingWeight: null }), batch({ archived: true })])).toBe("1 at a Location, 3420 g in all");
    expect(batchesCountText([batch({ locations: [here({ remainingWeight: null })], totalRemainingWeight: null })])).toBe("1 at a Location, none with a weight");
    expect(batchesCountText([batch({ locations: [], totalRemainingWeight: null })])).toBe("None at a Location");
    // The release before gives no total, so its weights are added up (ADR-0025).
    expect(batchesCountText([{ archived: false, locations: [here({}), here({ remainingWeight: 100 })] }])).toBe("1 at a Location, 3520 g in all");
  });

  it("names each Location a batch is at with its weight there", () => {
    expect(atText([])).toBe("Nowhere");
    expect(atText([here({}), here({ location: { ...location, name: "Riverside" }, remainingWeight: null })])).toBe("Downtown (3420 g), Riverside (not tracked)");
  });

  it("gives the total the server worked out, none for a batch at no Location, and the sum of what the release before sent", () => {
    expect(totalText({ locations: [here({})], totalRemainingWeight: 3420 })).toBe("3420 g");
    expect(totalText({ locations: [here({ remainingWeight: null })], totalRemainingWeight: null })).toBe("Not tracked");
    expect(totalText({ locations: [], totalRemainingWeight: null })).toBeUndefined();
    expect(totalText({ locations: [here({}), here({ remainingWeight: 100 }), here({ remainingWeight: null })] })).toBe("3520 g");
  });

  it("says in one line what the count starts from and what Shots have used since", () => {
    // The day is written as the browser's locale writes one, such as "25 Nov", with its year once that is past.
    const day = dayText(at, now);
    expect(day).toMatch(/25/);
    expect(day).not.toMatch(/2026/);
    expect(weightLine(here({}), "someone", now)).toBe(`4180 g entered ${day} by Sam. Since: 38 Shots used 760 g.`);
    expect(weightLine(here({ used: { shots: 1, weight: 18.5 } }), "a1", now)).toBe(`4180 g entered ${day} by you. Since: 1 Shot used 18.5 g.`);
    expect(weightLine(here({ used: { shots: 0, weight: 0 } }), undefined, now)).toBe(`4180 g entered ${day} by Sam. No Shots since.`);
    expect(weightLine(here({ entered: { weight: 4180, at, by: null } }), undefined, now)).toBe(`4180 g entered ${day}. Since: 38 Shots used 760 g.`);
    const later = new Date(2027, 0, 5);
    expect(dayText(at, later)).toMatch(/2026/);
    expect(weightLine(here({}), undefined, later)).toBe(`4180 g entered ${dayText(at, later)} by Sam. Since: 38 Shots used 760 g.`);
    expect(weightLine(here({ remainingWeight: null, entered: null, used: null }), undefined, now)).toBe("No weight entered.");
  });

  it("says where a count that started with a move arrived from, and what moves have brought and taken since, by Location", () => {
    const day = dayText(at, now);
    const riverside = { ...location, id: "l2", name: "Riverside" };
    const lab = { ...location, id: "l3", name: "Roastery Lab" };
    expect(weightLine(here({ moved: { in: 0, from: [], away: 500, to: [{ location: riverside, weight: 500 }] } }), undefined, now)).toBe(
      `4180 g entered ${day} by Sam. Since: 38 Shots used 760 g, 500 g moved to Riverside.`,
    );
    expect(weightLine(here({ entered: { weight: 500, at, by: sam, arrivedFrom: location }, used: { shots: 4, weight: 72 }, moved: { in: 0, from: [], away: 0, to: [] } }), undefined, now)).toBe(
      `500 g arrived from Downtown ${day}. Since: 4 Shots used 72 g.`,
    );
    // No Shots, and moves both ways: each other Location has its amount.
    expect(
      weightLine(
        here({ used: { shots: 0, weight: 0 }, moved: { in: 320.5, from: [{ location: lab, weight: 320.5 }], away: 600, to: [{ location: riverside, weight: 500 }, { location: lab, weight: 100 }] } }),
        undefined,
        now,
      ),
    ).toBe(`4180 g entered ${day} by Sam. Since: 320.5 g moved from Roastery Lab, 500 g moved to Riverside, 100 g moved to Roastery Lab.`);
    // An amount whose other Location has been deleted since is still counted, and said.
    expect(weightLine(here({ used: { shots: 0, weight: 0 }, moved: { in: 50, from: [], away: 0, to: [] } }), undefined, now)).toBe(
      `4180 g entered ${day} by Sam. Since: 50 g moved from a Location since deleted.`,
    );
    // Nothing since reads as it did, and a weight entered through the release that moved nothing has no `moved`.
    expect(weightLine(here({ used: { shots: 0, weight: 0 }, moved: { in: 0, from: [], away: 0, to: [] } }), undefined, now)).toBe(`4180 g entered ${day} by Sam. No Shots since.`);
  });

  it("writes no line where the release before answers, which says none of it", () => {
    expect(weightLine({ location, remainingWeight: 250, since: at }, undefined, now)).toBeUndefined();
  });

  it("names who entered a weight: a Machine, an account, through a Connected App, or one Staff are not told", () => {
    expect(enteredBy({ ...sam, machine: { id: "m1", name: "Lab bar" }, tabletId: "t1", account: null }, undefined)).toBe("on Lab bar");
    expect(enteredBy({ ...sam, connectedApp: { id: "c1", name: "Claude", host: "claude.ai" } }, undefined)).toBe("by Sam, through Claude");
    expect(enteredBy({ ...sam, account: { id: "a2", name: null } }, "a1")).toBe("by an account");
    expect(enteredBy({ machine: null, tabletId: "t1", account: null, connectedApp: null }, undefined)).toBe("on a Machine since removed");
    expect(enteredBy(null, undefined)).toBeUndefined();
  });

  it("says in a Location's list what a count starts from, and that an untracked batch has no weight entered (#707)", () => {
    const day = dayText(at, now);
    expect(startText(here({}), now)).toBe(`of 4180 g entered ${day}`);
    expect(startText(here({ entered: { weight: 6000, at, by: null, arrivedFrom: { ...location, name: "Roastery Lab" } } }), now)).toBe(`of 6000 g arrived ${day}`);
    expect(startText(here({ entered: null }), now)).toBe("No weight entered");
    expect(startText({}, now)).toBe("No weight entered");
  });

  it("says in a Location's list what was moved in and away since, or that nothing was (#707)", () => {
    const riverside = { ...location, id: "l2", name: "Riverside" };
    expect(movedLine({ in: 0, from: [], away: 0, to: [] })).toBe("Nothing moved");
    expect(movedLine(null)).toBe("Nothing moved");
    expect(movedLine(undefined)).toBe("Nothing moved");
    expect(movedLine({ in: 200, from: [{ location: riverside, weight: 200 }], away: 500, to: [{ location: riverside, weight: 500 }] })).toBe("200 g moved from Riverside, 500 g moved to Riverside");
  });

  it("gives the list of batches a line for each Location, with its weight, the name alone where no Location tracks the batch, and \"not tracked\" beside one that does not where another does (#726)", () => {
    const riverside = { ...location, id: "l2", name: "Riverside" };
    expect(atLines([])).toEqual([]);
    expect(atLines([here({}), here({ location: riverside, remainingWeight: 428 })])).toEqual([
      { id: "l1", name: "Downtown", weight: "3420 g" },
      { id: "l2", name: "Riverside", weight: "428 g" },
    ]);
    expect(atLines([here({ remainingWeight: null }), here({ location: riverside, remainingWeight: null })])).toEqual([
      { id: "l1", name: "Downtown" },
      { id: "l2", name: "Riverside" },
    ]);
    expect(atLines([here({}), here({ location: riverside, remainingWeight: null })])).toEqual([
      { id: "l1", name: "Downtown", weight: "3420 g" },
      { id: "l2", name: "Riverside", weight: "not tracked" },
    ]);
  });

  it("says under a batch's total how many Locations it is at, how many track it where not all do, and its roasted weight where it has one (#726)", () => {
    const three = [here({}), here({ remainingWeight: 428 }), here({ remainingWeight: 246 })];
    expect(totalLine(three, 6000)).toBe("At 3 Locations, of 6000 g roasted.");
    expect(totalLine(three, undefined)).toBe("At 3 Locations.");
    expect(totalLine([here({})], 250.5)).toBe("At 1 Location, of 250.5 g roasted.");
    expect(totalLine([here({}), here({}), here({ remainingWeight: null })], undefined)).toBe("At 3 Locations, 2 with a weight.");
    expect(totalLine([here({}), here({ remainingWeight: null })], 6000)).toBe("At 2 Locations, 1 with a weight, of 6000 g roasted.");
    expect(totalLine([here({ remainingWeight: null }), here({ remainingWeight: null })], 6000)).toBe("At 2 Locations, none with a weight, of 6000 g roasted.");
    // A roasted weight that is no weight, as a tablet's record may hold, is left out, and a batch at no Location has no line.
    for (const none of [0, -5, "6000", null, Number.NaN]) expect(totalLine([here({})], none)).toBe("At 1 Location.");
    expect(totalLine([], 6000)).toBeUndefined();
  });

  it("gives the line in parts, so its count of Shots can be a link, and no count where no Shot was pulled since (#726)", () => {
    const day = dayText(at, now);
    const riverside = { ...location, id: "l2", name: "Riverside" };
    expect(weightLineParts(here({ moved: { in: 0, from: [], away: 500, to: [{ location: riverside, weight: 500 }] } }), undefined, now)).toEqual({
      before: `4180 g entered ${day} by Sam. Since: `,
      shots: "38 Shots",
      after: " used 760 g, 500 g moved to Riverside.",
    });
    expect(weightLineParts(here({ used: { shots: 1, weight: 18.5 } }), undefined, now)).toEqual({ before: `4180 g entered ${day} by Sam. Since: `, shots: "1 Shot", after: " used 18.5 g." });
    expect(weightLineParts(here({ used: { shots: 0, weight: 0 } }), undefined, now)).toEqual({ before: `4180 g entered ${day} by Sam. No Shots since.`, after: "" });
    expect(weightLineParts(here({ remainingWeight: null, entered: null, used: null }), undefined, now)).toEqual({ before: "No weight entered.", after: "" });
    expect(weightLineParts({ location, remainingWeight: 250, since: at }, undefined, now)).toBeUndefined();
  });

  it("draws a Location's bar as what is left over that plus what Shots there have used: full with no Shot since, empty at 0 g, and unmoved by a Batch Move in or away (#726)", () => {
    expect(barOf(here({ remainingWeight: 2920, used: { shots: 38, weight: 760 } }))).toEqual({ fraction: 2920 / 3680, label: "2920 g left at Downtown, 760 g used by Shots there" });
    expect(barOf(here({ remainingWeight: 4180, used: { shots: 0, weight: 0 } }))?.fraction).toBe(1);
    expect(barOf(here({ remainingWeight: 0, used: { shots: 34, weight: 600 } }))).toEqual({ fraction: 0, label: "0 g left at Downtown, 600 g used by Shots there" });
    // A weight entered as 0 g that no Shot has used since is empty, not 0 over 0.
    expect(barOf(here({ remainingWeight: 0, used: { shots: 0, weight: 0 } }))?.fraction).toBe(0);
    // 500 g moved away leaves 3680 g less 760 g used less 500 g: the bar is of what stayed, 2420 g of 3180 g, and coffee received is not drawn as used either.
    const riverside = { ...location, id: "l2", name: "Riverside" };
    expect(barOf(here({ remainingWeight: 2420, used: { shots: 38, weight: 760 }, moved: { in: 0, from: [], away: 500, to: [{ location: riverside, weight: 500 }] } }))?.fraction).toBe(2420 / 3180);
    expect(barOf(here({ remainingWeight: 4680, used: { shots: 0, weight: 0 }, moved: { in: 500, from: [{ location: riverside, weight: 500 }], away: 0, to: [] } }))?.fraction).toBe(1);
  });

  it("draws no bar where the batch is untracked, or the release before gave no count of what was used (#726)", () => {
    expect(barOf(here({ remainingWeight: null, entered: null, used: null }))).toBeUndefined();
    expect(barOf({ location, remainingWeight: 250 })).toBeUndefined();
    expect(barOf({ location, remainingWeight: 250, used: null })).toBeUndefined();
  });

  it("says how far a weight typed is from the one worked out, and nothing for the same weight, none worked out, zero or an empty field (#726)", () => {
    expect(differenceText("2780", 2920)).toBe("140 g less than the 2920 g worked out.");
    expect(differenceText("292", 2920)).toBe("2628 g less than the 2920 g worked out.");
    expect(differenceText("2980", 2920)).toBe("60 g more than the 2920 g worked out.");
    expect(differenceText("4141.2", 4141.5)).toBe("0.3 g less than the 4141.5 g worked out.");
    expect(differenceText(" 2920 ", 2920)).toBeUndefined();
    expect(differenceText("2920.04", 2920)).toBeUndefined();
    expect(differenceText("500", null)).toBeUndefined();
    // Zero and an empty field have lines of their own, and what is no weight has none.
    for (const typed of ["0", "", "  ", "-5", "many"]) expect(differenceText(typed, 2920), typed).toBeUndefined();
    // A Location that reads 0 g still has a weight worked out.
    expect(differenceText("250", 0)).toBe("250 g more than the 0 g worked out.");
  });

  it("says of a Location a batch has left that a Batch Move of all took it, naming where to, or that it was finished there, with the day (#726)", () => {
    const day = dayText(at, now);
    const riverside = { ...location, id: "l2", name: "Riverside" };
    const left = { location, remainingWeight: 0, finishedAt: at };
    const version = (receivedAt: string, changes: Partial<ItemVersion>): ItemVersion => ({ id: receivedAt, fields: {}, location: null, source: sam, editedAt: receivedAt, receivedAt, copiedFrom: null, move: null, ...changes });
    const movedAll = version("2026-11-25T15:00:00.000Z", { move: { from: location, to: riverside, amount: 2420, all: true } });
    const movedPart = version("2026-11-25T14:00:00.000Z", { move: { from: location, to: riverside, amount: 500, all: false } });
    const finished = version("2026-11-25T13:00:00.000Z", { location, fields: { atLocation: false } });
    expect(leftText(left, [movedAll, movedPart], now)).toBe(`Moved to Riverside ${day}`);
    expect(leftText(left, [finished, movedPart], now)).toBe(`Finished ${day}`);
    // The latest of the changes that took it from the Location decides, in whatever order the history lists them.
    expect(leftText(left, [finished, movedAll], now)).toBe(`Moved to Riverside ${day}`);
    expect(leftText(left, [version("2026-11-25T16:00:00.000Z", { location, fields: { atLocation: false, remainingWeight: 0 } }), movedAll], now)).toBe(`Finished ${day}`);
    // A move of all from another Location, or to this one, did not take it from here, and neither did being added here.
    expect(leftText(left, [version("2026-11-25T17:00:00.000Z", { move: { from: riverside, to: location, amount: 100, all: true } }), version("2026-11-25T18:00:00.000Z", { location, fields: { atLocation: true } })], now)).toBe(`Finished ${day}`);
    expect(leftText(left, [version("2026-11-25T15:00:00.000Z", { move: { from: location, to: null, amount: null, all: true } })], now)).toBe(`Moved to a Location since deleted ${day}`);
    // Not read yet, or the release before's, which names no move: it reads as finished.
    expect(leftText(left, undefined, now)).toBe(`Finished ${day}`);
    expect(leftText(left, [{ ...movedAll, move: undefined }], now)).toBe(`Finished ${day}`);
  });

  it("says the same of a Recipe's own Location on the Recipe's page, after its batch's roast day (#733)", () => {
    const day = dayText(at, now);
    const riverside = { ...location, id: "l2", name: "Riverside" };
    const left = { location, remainingWeight: 0, finishedAt: at };
    const version = (receivedAt: string, changes: Partial<ItemVersion>): ItemVersion => ({ id: receivedAt, fields: {}, location: null, source: sam, editedAt: receivedAt, receivedAt, copiedFrom: null, move: null, ...changes });
    const movedAll = version("2026-11-25T15:00:00.000Z", { move: { from: location, to: riverside, amount: 2420, all: true } });
    const finished = version("2026-11-25T13:00:00.000Z", { location, fields: { atLocation: false } });
    expect(leftHereText(left, [finished], now)).toBe(`finished here ${day}`);
    expect(leftHereText(left, [finished, movedAll], now)).toBe(`moved to Riverside ${day}`);
    expect(leftHereText(left, [version("2026-11-25T15:00:00.000Z", { move: { from: location, to: null, amount: null, all: true } })], now)).toBe(`moved to a Location since deleted ${day}`);
    // Its history not read, or the release before's: finished here.
    expect(leftHereText(left, undefined, now)).toBe(`finished here ${day}`);
  });
});
