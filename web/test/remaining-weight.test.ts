import { describe, expect, it } from "vitest";
import type { BatchAtLocation, EditSource } from "../src/lib/api";
import { atText, dayText, enteredBy, movedLine, startText, totalText, weightLine, weightText } from "../src/lib/remaining-weight";

// What the management interface writes of a Bean Batch's Remaining Weight at a Location (#706), with what Batch Moves have brought and taken since its count started (#704).

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
});
