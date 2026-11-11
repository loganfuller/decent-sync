import { describe, expect, it } from "vitest";
import { baristaKey, durationText, groupFilters, groupingsIn, shareText, shotsText, signedText, yieldAgainstTargetText } from "../src/lib/shot-summary";

// How a Shot Summary's numbers read on the Shots list (#466), what its
// address groups it by, and the filters each of its groups opens as (#468).

const NONE = { shots: 0, median: null, p25: null, p75: null };

describe("a Shot Summary's numbers as text", () => {
  it("reads a duration as its median in seconds with the middle half's range", () => {
    expect(durationText({ shots: 20, median: 26, p25: 25.62, p75: 26.649 })).toEqual({ median: "26.0 s", range: "25.6–26.6" });
    expect(durationText({ shots: 1, median: 23.549, p25: 23.549, p75: 23.549 })).toEqual({ median: "23.5 s", range: "23.5–23.5" });
    expect(durationText(NONE)).toBeUndefined();
  });

  it("reads a yield against target in grams, each with its sign, and its range with a word between", () => {
    expect(yieldAgainstTargetText({ shots: 8, median: -0.55, p25: -1.3, p75: 0.05 })).toEqual({ median: "−0.6 g", range: "−1.3 to +0.1" });
    expect(yieldAgainstTargetText({ shots: 3, median: 2.4, p25: 0.5, p75: 3 })).toEqual({ median: "+2.4 g", range: "+0.5 to +3.0" });
    expect(yieldAgainstTargetText(NONE)).toBeUndefined();
  });

  it("signs a difference, but one that rounds to nothing", () => {
    expect([1, -1, 0.04, -0.04, 0, -0.05, 12.345].map(signedText)).toEqual(["+1.0", "−1.0", "0.0", "0.0", "0.0", "−0.1", "+12.3"]);
  });

  it("reads a share as a whole percentage, and none where there is none", () => {
    expect([0, 0.875, 5 / 6, 1].map(shareText)).toEqual(["0%", "88%", "83%", "100%"]);
    expect(shareText(null)).toBeUndefined();
  });

  it("counts Shots in words", () => {
    expect([0, 1, 2].map(shotsText)).toEqual(["0 Shots", "1 Shot", "2 Shots"]);
  });
});

describe("a Shot Summary's grouping", () => {
  it("reads the groupings an address names: those there are, each once, at most two", () => {
    expect(groupingsIn(null)).toEqual([]);
    expect(groupingsIn("")).toEqual([]);
    expect(groupingsIn("recipe")).toEqual(["recipe"]);
    expect(groupingsIn("recipe,machine")).toEqual(["recipe", "machine"]);
    // What it doesn't have is passed over, as is one named twice, and any beyond two.
    expect(groupingsIn("roaster,beanBatch,,Recipe")).toEqual(["beanBatch"]);
    expect(groupingsIn("barista,barista,profile")).toEqual(["barista", "profile"]);
    expect(groupingsIn("location,machine,recipe")).toEqual(["location", "machine"]);
  });

  it("opens a group as the list's filter of each grouping, by its id or by what its Shots recorded", () => {
    expect(groupFilters({})).toEqual({});
    expect(
      groupFilters({
        location: { id: "location-1", name: "Lab" },
        recipe: { id: "recipe-1", name: "House", location: null },
        beanBatch: { id: "batch-1", bean: { id: "bean-1", roaster: "Roux", name: "Guji" }, roastDate: null },
        grinder: { id: "grinder-1", model: "EK43", location: null },
        basket: { id: "basket-1", name: "18 g" },
      }),
    ).toEqual({ locationId: "location-1", recipeId: "recipe-1", beanBatchId: "batch-1", grinderId: "grinder-1", basketId: "basket-1" });
    expect(groupFilters({ bean: { roaster: "Roux", name: "Guji" }, profile: "Londonium", barista: "Jules" })).toEqual({ coffeeRoaster: "Roux", coffeeName: "Guji", profileTitle: "Londonium", barista: "Jules" });
    // A Bean with a roaster and no name: its name's filter finds those that recorded none.
    expect(groupFilters({ bean: { roaster: "Roux", name: null } })).toEqual({ coffeeRoaster: "Roux", coffeeName: "" });
  });

  it("opens a Machine's group as that Machine, and a Pending Machine's as it, clearing the other", () => {
    expect(groupFilters({ machine: { id: "machine-1", name: "Lab 1" }, pendingMachine: null })).toEqual({ machineId: "machine-1", pendingMachineId: null });
    expect(groupFilters({ machine: null, pendingMachine: { id: "pending-1", model: "DE1Pro", serial: "10041" } })).toEqual({ machineId: null, pendingMachineId: "pending-1" });
  });

  it("opens a group of Shots with none as the filter that finds them: none for what is linked, empty for what is recorded", () => {
    expect(groupFilters({ location: null, recipe: null, beanBatch: null, grinder: null, basket: null })).toEqual({ locationId: "none", recipeId: "none", beanBatchId: "none", grinderId: "none", basketId: "none" });
    expect(groupFilters({ bean: null, profile: null, barista: null })).toEqual({ coffeeRoaster: "", coffeeName: "", profileTitle: "", barista: "" });
  });

  it("reads a Barista's name without its case or the blanks around it", () => {
    expect([" Jules", "JULES\t", "jules", "Jules Verne"].map(baristaKey)).toEqual(["jules", "jules", "jules", "jules verne"]);
    expect(["", "   ", "\n", " \t\r\n\f\v"].map(baristaKey)).toEqual(["", "", "", ""]);
    // Only the blanks the server leaves out: a name within another space is another Barista, as it is there.
    expect(["\u00a0Jules", "Jules\u2003", "\u00a0"].map(baristaKey)).toEqual(["\u00a0jules", "jules\u2003", "\u00a0"]);
  });
});
