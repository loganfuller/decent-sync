import { describe, expect, it } from "vitest";
import type { BatchAtLocation, BatchRecipe } from "../src/lib/api";
import { destinationText, finishLines, movePlan, moveText, recipesAt, sourceText } from "../src/lib/batch-moves";

// What the management interface says of a Batch Move (#704): what the move
// dialog says each Location will hold afterwards and what it sends, and the
// one line a move is in a batch's history; and what the confirmation before
// Finish here says finishing does (#726).

const downtown = { id: "l1", name: "Downtown", timeZone: "America/Chicago" };
const riverside = { id: "l2", name: "Riverside", timeZone: "America/Chicago" };
const belmont = { id: "l3", name: "Belmont", timeZone: "America/Chicago" };
const since = new Date(2026, 10, 25, 9).toISOString();

function at(location: typeof downtown, remainingWeight: number | null): BatchAtLocation {
  return { location, remainingWeight, since };
}

/** What a move of part says of the tablets at both Locations (#726). */
const tablets = "Tablets at both Locations show the new weights.";

describe("a Batch Move in words", () => {
  it("names each Location the batch may be moved to with what it has of it", () => {
    expect(destinationText(riverside, at(riverside, 428))).toBe("Riverside, which has 428 g");
    expect(destinationText(riverside, at(riverside, null))).toBe("Riverside, where it is not tracked");
    expect(destinationText(belmont, undefined)).toBe("Belmont, which has none");
    expect(sourceText(at(downtown, 2920))).toBe("Downtown has 2920 g of it.");
    expect(sourceText(at(downtown, null))).toBe("It is at Downtown, with no weight entered there.");
  });

  it("says what each Location will hold after a move of part, and sends the amount", () => {
    expect(movePlan(at(downtown, 2920), riverside, at(riverside, 428), "part", "500")).toEqual({
      amount: 500,
      lines: ["Downtown will have 2420 g.", "Riverside will have 928 g: the 428 g there now and these 500 g.", tablets],
      submit: "Move 500 g to Riverside",
    });
    // To a Location that has none, or has it with no weight, the amount arriving is what it has.
    expect(movePlan(at(downtown, 2920), belmont, undefined, "part", "120.25").lines).toEqual(["Downtown will have 2799.7 g.", "Belmont will have 120.3 g.", tablets]);
    expect(movePlan(at(downtown, 2920), riverside, at(riverside, null), "part", "20")).toMatchObject({ amount: 20, lines: ["Downtown will have 2900 g.", "Riverside will have 20 g.", tablets] });
  });

  it("says that tablets show the new weights only of a move of part, which leaves both Locations with one (#726)", () => {
    expect(movePlan(at(downtown, 2920), riverside, at(riverside, 428), "all", "").lines).not.toContain(tablets);
    expect(movePlan(at(downtown, null), belmont, undefined, "some", "").lines).not.toContain(tablets);
    expect(movePlan(at(downtown, null), belmont, undefined, "all", "").lines).not.toContain(tablets);
  });

  it("makes no move of part for an amount of zero, a negative one, or one equal to or above what is there, saying to choose all", () => {
    for (const entered of ["0", "-5", "2920", "3000", "many"]) {
      expect(movePlan(at(downtown, 2920), riverside, undefined, "part", entered), entered).toEqual({
        lines: [],
        problem: "Enter a weight above 0 and below 2920 g. To move everything, choose All of it.",
        submit: "Move to Riverside",
      });
    }
    // Nothing typed yet is no mistake, and nothing to send.
    expect(movePlan(at(downtown, 2920), riverside, undefined, "part", " ")).toEqual({ lines: [], problem: undefined, submit: "Move to Riverside" });
    // Nor is there anything to say before a Location is chosen.
    expect(movePlan(at(downtown, 2920), undefined, undefined, "all", "")).toEqual({ lines: [], submit: "Move" });
  });

  it("says a move of all finishes the batch at the Location left, with the Recipes there that name it", () => {
    expect(movePlan(at(downtown, 2920), riverside, at(riverside, 428), "all", "", { naming: 2, slotted: 1 })).toEqual({
      amount: "all",
      lines: [
        "Riverside will have 3348 g: the 428 g there now and these 2920 g.",
        "Downtown stops listing the batch, and its tablets stop offering it.",
        '2 Recipes at Downtown name it and will go on naming it. The one in a Recipe Slot will read "Batch finished here".',
      ],
      submit: "Move all to Riverside",
    });
    const recipes = (naming: number, slotted: number) => movePlan(at(downtown, 100), belmont, undefined, "all", "", { naming, slotted }).lines.slice(2);
    expect(recipes(0, 0)).toEqual([]);
    expect(recipes(1, 0)).toEqual(["1 Recipe at Downtown names it and will go on naming it."]);
    expect(recipes(1, 1)).toEqual(['1 Recipe at Downtown names it and will go on naming it. It is in a Recipe Slot, and will read "Batch finished here".']);
    expect(recipes(3, 2)).toEqual(['3 Recipes at Downtown name it and will go on naming it. The 2 in Recipe Slots will read "Batch finished here".']);
    // Not read yet, the dialog says nothing of them.
    expect(movePlan(at(downtown, 100), belmont, undefined, "all", "").lines).toEqual(["Belmont will have 100 g.", "Downtown stops listing the batch, and its tablets stop offering it."]);
    // All of a Location that reads 0 g moves none, and the Location joined keeps what it has.
    expect(movePlan(at(downtown, 0), riverside, at(riverside, 300), "all", "").lines[0]).toBe("Riverside will have 300 g, as now.");
    expect(movePlan(at(downtown, 0), belmont, undefined, "all", "").lines[0]).toBe("Belmont will have 0 g.");
  });

  it("moves a batch with no weight as all of it or some of it, with no amount, and not as some to a Location it is at", () => {
    expect(movePlan(at(downtown, null), belmont, undefined, "some", "")).toEqual({
      amount: "some",
      lines: [
        "The batch stays at Downtown and is added at Belmont.",
        'No weight is entered for it at Downtown, so none moves. It reads "Not tracked" at Belmont until a weight is entered there.',
        "To move a known amount, enter its weight at Downtown first.",
      ],
      submit: "Move some to Belmont",
    });
    expect(movePlan(at(downtown, null), belmont, undefined, "all", "", { naming: 1, slotted: 0 })).toEqual({
      amount: "all",
      lines: [
        "The batch is added at Belmont.",
        "Downtown stops listing the batch, and its tablets stop offering it.",
        "1 Recipe at Downtown names it and will go on naming it.",
        'No weight is entered for it at Downtown, so none moves. It reads "Not tracked" at Belmont until a weight is entered there.',
      ],
      submit: "Move all to Belmont",
    });
    expect(movePlan(at(downtown, null), riverside, at(riverside, 428), "all", "").lines).toEqual([
      "The batch stays at Riverside, as it is.",
      "Downtown stops listing the batch, and its tablets stop offering it.",
      "No weight is entered for it at Downtown, so none moves.",
    ]);
    expect(movePlan(at(downtown, null), riverside, at(riverside, 428), "some", "")).toEqual({
      lines: [],
      problem: "It is at Riverside already. Move all of it, or choose another Location.",
      submit: "Move some to Riverside",
    });
  });

  it("writes a move in a batch's history as one line naming both Locations and the amount", () => {
    expect(moveText({ from: { ...downtown, name: "Roastery Lab" }, to: belmont, amount: 5700, all: false })).toBe("Moved 5700 g from Roastery Lab to Belmont");
    expect(moveText({ from: downtown, to: riverside, amount: 2920, all: true })).toBe("Moved all, 2920 g, from Downtown to Riverside");
    expect(moveText({ from: downtown, to: belmont, amount: null, all: true })).toBe("Moved all from Downtown to Belmont, with no weight entered");
    expect(moveText({ from: downtown, to: belmont, amount: null, all: false })).toBe("Moved some from Downtown to Belmont, with no weight entered");
    expect(moveText({ from: null, to: belmont, amount: 20.5, all: false })).toBe("Moved 20.5 g from a Location since deleted to Belmont");
  });

  it("says what finishing a batch at a Location does, in a move of all's lines, leaving out the weight where it is untracked and the Recipes where none names it (#726)", () => {
    expect(finishLines(at(downtown, 2920), { naming: 2, slotted: 1 })).toEqual([
      "Downtown stops listing the batch, and its tablets stop offering it.",
      "The 2920 g there goes with it. No other Location's weight changes.",
      '2 Recipes at Downtown name it and will go on naming it. The one in a Recipe Slot will read "Batch finished here".',
    ]);
    // Untracked there, no weight goes with it; with no Recipe naming it, or none read, nothing is said of them.
    expect(finishLines(at(downtown, null), { naming: 0, slotted: 0 })).toEqual(["Downtown stops listing the batch, and its tablets stop offering it."]);
    expect(finishLines(at(downtown, 0))).toEqual(["Downtown stops listing the batch, and its tablets stop offering it.", "The 0 g there goes with it. No other Location's weight changes."]);
  });

  it("counts the Recipes at a Location that name a batch, and those in a Recipe Slot, from the batch's own, and none where the release before listed none (#726)", () => {
    const recipe = (location: typeof downtown | null, slot: number | null): BatchRecipe => ({ id: `${location?.id}-${slot}`, name: "Guji", location, slot, dose: 18, yield: 40, batchFinished: false });
    const recipes = [recipe(downtown, 2), recipe(downtown, null), recipe(riverside, 5), recipe(null, 1)];
    expect(recipesAt(recipes, downtown.id)).toEqual({ naming: 2, slotted: 1 });
    expect(recipesAt(recipes, riverside.id)).toEqual({ naming: 1, slotted: 1 });
    expect(recipesAt(recipes, belmont.id)).toEqual({ naming: 0, slotted: 0 });
    expect(recipesAt(undefined, downtown.id)).toBeUndefined();
  });
});
