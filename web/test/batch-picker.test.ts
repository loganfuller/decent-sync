import { describe, expect, it } from "vitest";
import { type BatchOption, type BatchOptionGroup, activeOption, batchCount, batchMatches, latestRoastedFirst, matchingGroups, optionName, optionText, typedInto } from "../src/lib/batch-picker";

// The batch picker's pure parts (#733): which batches the words typed find, what they leave of its groups, how an option
// reads in the field and to a screen reader, and the order the latest roast comes first in.

/** Late November 2026, as each test's now. */
const now = new Date(2026, 10, 27, 12);
const day = (date: number) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.UTC(2026, 10, date));

const house = (batchCode: string | null, roastDate: string | null = "2026-11-17") => ({ bean: { name: "House Espresso", roaster: "Lantern Coffee Roasters" }, roastDate, batchCode });
const decaf = { bean: { name: "House Decaf", roaster: "Roux" }, roastDate: "2026-11-23", batchCode: "LR-0418" };

describe("the words typed", () => {
  it("find a batch by each word in its Bean's name, its roaster or its Batch Code, ignoring case, as the list of batches searches", () => {
    expect(batchMatches(house("LR-0411"), "house")).toBe(true);
    expect(batchMatches(house("LR-0411"), "LANTERN")).toBe(true);
    expect(batchMatches(house("LR-0411"), "lr-04")).toBe(true);
    // Every word, in whichever of the three, in any order.
    expect(batchMatches(house("LR-0411"), "0411 espresso lantern")).toBe(true);
    expect(batchMatches(house("LR-0411"), "house roux")).toBe(false);
    expect(batchMatches(decaf, "house roux")).toBe(true);
    // Never by its roast date, which is no word of it.
    expect(batchMatches(house("LR-0411"), "2026")).toBe(false);
  });

  it("match every batch while none is typed, whatever blanks are", () => {
    expect(batchMatches(house(null), "")).toBe(true);
    expect(batchMatches(house(null), "   ")).toBe(true);
    expect(batchMatches(house("LR-0411"), " house ")).toBe(true);
    // A batch with no Bean name, roaster or code is found by no word, and listed while none is typed.
    expect(batchMatches({ bean: { name: null } }, "house")).toBe(false);
    expect(batchMatches({ bean: { name: null } }, "")).toBe(true);
  });

  it("leave each group its batches that match, drop a group left with none, and hide no entry that is no batch", () => {
    const groups: BatchOptionGroup[] = [
      { label: "At Downtown", options: [{ value: "a", batch: house("LR-0411") }, { value: "b", batch: house(null, "2026-11-10") }] },
      { label: "Elsewhere: saving adds it at Downtown", options: [{ value: "c", batch: decaf }] },
      { options: [{ value: "none", label: "No batch" }] },
    ];
    expect(matchingGroups(groups, "")).toEqual(groups);
    expect(matchingGroups(groups, "0411").map((group) => [group.label, group.options.map((option) => option.value)])).toEqual([
      ["At Downtown", ["a"]],
      [undefined, ["none"]],
    ]);
    expect(matchingGroups(groups, "decaf").map((group) => group.label)).toEqual(["Elsewhere: saving adds it at Downtown", undefined]);
    // Nothing matches: "No batch" is still in reach, and the picker says no batch matches.
    expect(matchingGroups(groups, "kenya").map((group) => group.options.map((option) => option.value))).toEqual([["none"]]);
    expect(batchCount(groups)).toBe(3);
    expect(batchCount(matchingGroups(groups, "kenya"))).toBe(0);
  });
});

describe("the option the arrows and Enter are on", () => {
  const options: BatchOption[] = [
    { value: "a", batch: house("LR-0411") },
    { value: "c", batch: decaf },
    { value: "none", label: "No batch" },
  ];

  it("is the one chosen while nothing is typed, or the first when none of them is", () => {
    expect(activeOption(options, undefined, "c", "")?.value).toBe("c");
    expect(activeOption(options, undefined, "none", "  ")?.value).toBe("none");
    expect(activeOption(options, undefined, "gone", "")?.value).toBe("a");
  });

  it("is the first batch the words typed find, not an entry that is no batch left chosen, nor the batch chosen", () => {
    // "No batch" chosen, as a new Recipe is, or "Any Bean Batch" in the Shots filter: Enter takes the match.
    expect(activeOption(options.slice(1), undefined, "none", "0418")?.value).toBe("c");
    expect(activeOption(options, undefined, "c", "lr")?.value).toBe("a");
    // Typed, with no batch found: none, so Enter on a word mistyped chooses no entry that is no batch.
    expect(activeOption(options.slice(2), undefined, "none", "yirgacheffe")).toBeUndefined();
    expect(activeOption([{ value: "any", label: "Any Bean Batch" }, options[2]!], undefined, "a", "yirgacheffe")).toBeUndefined();
    // Unless the arrows moved to one.
    expect(activeOption(options.slice(2), "none", "a", "yirgacheffe")?.value).toBe("none");
  });

  it("is the one the arrows moved to, while it is listed", () => {
    expect(activeOption(options, "none", "c", "lr")?.value).toBe("none");
    expect(activeOption(options.slice(1), "a", "none", "0418")?.value).toBe("c");
  });
});

describe("what is typed into the field reading the option chosen", () => {
  const shown = "House Espresso LR-0411, roasted 17 Nov (this Recipe's batch now)";

  it("is what was inserted, at its end or inside it, as a browser that keeps no select on focus leaves it", () => {
    expect(typedInto(shown, `${shown}0419`)).toBe("0419");
    expect(typedInto(shown, "House Espresso LR-04110419, roasted 17 Nov (this Recipe's batch now)")).toBe("0419");
    expect(typedInto(shown, `0419${shown}`)).toBe("0419");
    // A letter that repeats the one beside it is still taken once.
    expect(typedInto("Kenya", "Kenyaa")).toBe("a");
  });

  it("is the field as it reads where the option's words were replaced or edited, or the field read none", () => {
    expect(typedInto(shown, "0419")).toBe("0419");
    expect(typedInto(shown, "")).toBe("");
    expect(typedInto(shown, "House Espresso")).toBe("House Espresso");
    expect(typedInto(shown, "Hou Espresso LR-0411, roasted 17 Nov (this Recipe's batch now)xx")).toBe("Hou Espresso LR-0411, roasted 17 Nov (this Recipe's batch now)xx");
    expect(typedInto("", "lr")).toBe("lr");
  });
});

describe("an option", () => {
  it("reads in the field as its batch in words, with its note, or as its label", () => {
    expect(optionText({ value: "a", batch: house("LR-0411"), weight: "3240 g here" }, now)).toBe(`House Espresso LR-0411, roasted ${day(17)}`);
    expect(optionText({ value: "a", batch: house(null), note: "this Recipe's" }, now)).toBe(`House Espresso, roasted ${day(17)} (this Recipe's)`);
    expect(optionText({ value: "none", label: "No batch" })).toBe("No batch");
  });

  it("is named for a screen reader by its batch in words, then its note and its weight", () => {
    expect(optionName({ value: "a", batch: house("LR-0411"), note: "this Recipe's batch now", weight: "3240 g here" }, now)).toBe(`House Espresso LR-0411, roasted ${day(17)}, this Recipe's batch now, 3240 g here`);
    expect(optionName({ value: "a", batch: house(null, null), weight: "Not tracked" }, now)).toBe("House Espresso, no roast date, Not tracked");
    expect(optionName({ value: "a", batch: house("LR-0411") }, now)).toBe(`House Espresso LR-0411, roasted ${day(17)}`);
    expect(optionName({ value: "any", label: "Any Bean Batch" })).toBe("Any Bean Batch");
  });
});

describe("the latest roasted first", () => {
  it("orders batches by roast date, the latest first, one with none last, then the latest to join the Library", () => {
    const batches = [
      { id: "old", roastDate: "2026-11-10T00:00:00.000", createdAt: "2026-11-11T00:00:00Z" },
      { id: "undated", roastDate: null, createdAt: "2026-11-26T00:00:00Z" },
      { id: "new", roastDate: "2026-11-24", createdAt: "2026-11-25T00:00:00Z" },
      { id: "new-later", roastDate: "2026-11-24T00:00:00.000", createdAt: "2026-11-26T00:00:00Z" },
    ];
    expect([...batches].sort(latestRoastedFirst).map((batch) => batch.id)).toEqual(["new-later", "new", "old", "undated"]);
  });
});
