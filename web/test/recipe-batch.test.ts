import { describe, expect, it } from "vitest";
import type { BatchAtLocation, BeanBatchSummary, Recipe } from "../src/lib/api";
import { BEAN_ONLY, NO_BATCH, agoText, batchEdit, batchValueOf, elsewhereText, hereText, nextRoasts, offeredBatches, recipeBatchGroups, thereText, usedBatch, usedBatchText, weightAt } from "../src/lib/recipe-batch";

// A Recipe's Bean Batch (#733), the pure parts: the batch a Recipe uses, what is left of a batch at a Location and
// elsewhere, what the picker offers a Recipe, what a value of it edits, and the next roasts of a Recipe's Bean.

const day = (date: number) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.UTC(new Date().getFullYear(), 10, date));
const year = new Date().getFullYear();

const DOWNTOWN = { id: "downtown", name: "Downtown", timeZone: "America/Chicago" };
const RIVERSIDE = { id: "riverside", name: "Riverside", timeZone: "America/Chicago" };
const LAB = { id: "lab", name: "Roastery Lab", timeZone: "America/Chicago" };
const HOUSE = { id: "house", roaster: "Lantern Coffee Roasters", name: "House Espresso" };
const DECAF = { id: "decaf", roaster: "Lantern Coffee Roasters", name: "House Decaf" };

const at = (location: typeof DOWNTOWN, remainingWeight: number | null): BatchAtLocation => ({ location, remainingWeight, since: `${year}-11-01T00:00:00Z` });

function batch(id: string, date: number | null, batchCode: string | null, locations: BatchAtLocation[], changes: Partial<BeanBatchSummary> = {}): BeanBatchSummary {
  const weights = locations.flatMap((here) => (here.remainingWeight === null ? [] : [here.remainingWeight]));
  return {
    id,
    bean: HOUSE,
    roastDate: date === null ? null : `${year}-11-${String(date).padStart(2, "0")}T00:00:00.000`,
    batchCode,
    archived: false,
    locations,
    totalRemainingWeight: weights.length === 0 ? null : weights.reduce((sum, weight) => sum + weight, 0),
    createdAt: `${year}-11-${String(date ?? 1).padStart(2, "0")}T12:00:00Z`,
    createdLocation: null,
    ...changes,
  };
}

/** A Recipe at Downtown, as far as its batch is read. */
function recipe(beanBatch: { id: string; date: number | null; batchCode?: string | null; atLocation?: boolean } | null, bean: typeof HOUSE | null = HOUSE): Recipe {
  return {
    id: "r1",
    name: "House",
    location: DOWNTOWN,
    content: { ...(beanBatch && { beanBatchId: beanBatch.id }), ...(bean && { beanId: bean.id }) },
    uses: {
      bean,
      beanBatch: beanBatch && { id: beanBatch.id, roastDate: beanBatch.date === null ? null : `${year}-11-${beanBatch.date}T00:00:00.000`, batchCode: beanBatch.batchCode, atLocation: beanBatch.atLocation ?? true },
    },
  } as Recipe;
}

describe("the batch a Recipe uses", () => {
  it("is named by its Recipe's Bean, with its roaster, its roast date and its Batch Code", () => {
    expect(usedBatch(recipe({ id: "b1", date: 17, batchCode: "LR-0411" }))).toEqual({ id: "b1", bean: { name: "House Espresso", roaster: "Lantern Coffee Roasters" }, roastDate: `${year}-11-17T00:00:00.000`, batchCode: "LR-0411" });
    expect(usedBatchText(recipe({ id: "b1", date: 17, batchCode: "LR-0411" }))).toBe(`House Espresso LR-0411, roasted ${day(17)}`);
    // The previous release sends no Batch Code (ADR-0025): by its Bean and roast date.
    expect(usedBatchText(recipe({ id: "b1", date: 17 }))).toBe(`House Espresso, roasted ${day(17)}`);
  });

  it("is none for a Recipe naming a Bean with no batch, which reads as that Bean with none, and for one naming neither", () => {
    expect(usedBatch(recipe(null))).toBeUndefined();
    expect(usedBatchText(recipe(null))).toBe("House Espresso, no batch");
    expect(usedBatchText(recipe(null, null))).toBeUndefined();
  });
});

describe("what is left of a batch", () => {
  const both = batch("both", 17, "LR-0411", [at(DOWNTOWN, 3240), at(RIVERSIDE, 1850)]);
  const untracked = batch("untracked", 10, null, [at(DOWNTOWN, null)]);

  it("at a Location is its weight there, null where it is untracked there, and nothing where it is not there or no weight is said", () => {
    expect(weightAt(both, "downtown")).toBe(3240);
    expect(weightAt(untracked, "downtown")).toBeNull();
    expect(weightAt(both, "lab")).toBeUndefined();
    expect(weightAt(undefined, "downtown")).toBeUndefined();
    expect(weightAt(both, undefined)).toBeUndefined();
    // A server that says no weight of it, as an older one might during a deploy.
    expect(weightAt({ locations: [{ location: DOWNTOWN, since: "" } as BatchAtLocation] }, "downtown")).toBeUndefined();
  });

  it("reads as a plain weight here or there, or as not tracked, and as nothing where there is none to say", () => {
    expect(hereText(3240)).toBe("3240 g here");
    expect(hereText(0)).toBe("0 g here");
    expect(hereText(981.5, "there")).toBe("981.5 g there");
    expect(hereText(null)).toBe("Not tracked");
    expect(hereText(undefined)).toBeUndefined();
  });

  it("over the Locations a batch from elsewhere is at is their total, with where it is", () => {
    expect(thereText(both)).toBe("5090 g there");
    expect(elsewhereText(both)).toBe("at Downtown, Riverside");
    expect(thereText(untracked)).toBe("Not tracked");
    // The release before answers with no total (ADR-0025): its weights are added up.
    expect(thereText({ locations: both.locations })).toBe("5090 g there");
    expect(thereText({ locations: untracked.locations })).toBe("Not tracked");
    const nowhere = batch("nowhere", 3, null, []);
    expect(thereText(nowhere)).toBeUndefined();
    expect(elsewhereText(nowhere)).toBe("at no Location");
  });

  it("was roasted today, a day ago or some days ago", () => {
    expect(agoText(0)).toBe("today");
    expect(agoText(1)).toBe("1 day ago");
    expect(agoText(10)).toBe("10 days ago");
  });
});

describe("what a Recipe is offered", () => {
  const now = batch("now", 17, "LR-0411", [at(DOWNTOWN, 3240)]);
  const next = batch("next", 24, "LR-0419", [at(DOWNTOWN, 6000)]);
  const plain = batch("plain", 10, null, [at(DOWNTOWN, null)]);
  const lab = batch("lab", 26, "LR-0423", [at(LAB, 6000)]);
  const decaf = batch("decaf", 23, "LR-0418", [at(RIVERSIDE, 1850), at(LAB, null)], { bean: DECAF });
  const nowhere = batch("nowhere", 3, "LR-0390", []);
  const all = [plain, lab, now, nowhere, decaf, next];

  it("is no Archived batch and no batch of an Archived Bean", () => {
    const archived = batch("archived", 1, null, [at(DOWNTOWN, 100)], { archived: true });
    expect(offeredBatches([now, archived, decaf], [{ id: "house", archived: false }, { id: "decaf", archived: true }]).map((each) => each.id)).toEqual(["now"]);
    expect(offeredBatches([now, decaf], []).map((each) => each.id)).toEqual(["now", "decaf"]);
  });

  it("is grouped: the batches at its Location, the latest roasted first, each with its weight there; then those elsewhere, each with where it is and its weight over them; then No batch", () => {
    const groups = recipeBatchGroups({ batches: all, here: DOWNTOWN, value: "now", own: { id: "now", bean: HOUSE, roastDate: now.roastDate, batchCode: "LR-0411" } });
    expect(groups.map((group) => group.label)).toEqual(["At Downtown", "Elsewhere: saving adds it at Downtown", undefined]);
    expect(groups[0]!.options.map(({ value, note, weight }) => ({ value, note, weight }))).toEqual([
      { value: "next", note: undefined, weight: "6000 g here" },
      // The Recipe's batch now says so.
      { value: "now", note: "this Recipe's batch now", weight: "3240 g here" },
      { value: "plain", note: undefined, weight: "Not tracked" },
    ]);
    expect(groups[1]!.options.map(({ value, note, weight }) => ({ value, note, weight }))).toEqual([
      { value: "lab", note: "at Roastery Lab", weight: "6000 g there" },
      { value: "decaf", note: "at Riverside, Roastery Lab", weight: "1850 g there" },
      { value: "nowhere", note: "at no Location", weight: undefined },
    ]);
    expect(groups[2]!.options).toEqual([{ value: NO_BATCH, label: "No batch" }]);
  });

  it("leads with the Recipe's own batch where it is no longer offered, as one Archived, and with the Bean it keeps with no batch", () => {
    const own = { id: "gone", bean: HOUSE, roastDate: `${year}-11-03T00:00:00.000`, batchCode: "LR-0405" };
    const kept = recipeBatchGroups({ batches: all, here: DOWNTOWN, value: "gone", own, kept: "House Espresso LR-0405" });
    expect(kept[0]).toEqual({ options: [{ value: "gone", batch: own, note: "this Recipe's batch now" }] });
    expect(kept.map((group) => group.label)).toEqual([undefined, "At Downtown", "Elsewhere: saving adds it at Downtown", undefined]);
    const beanOnly = recipeBatchGroups({ batches: all, here: DOWNTOWN, value: BEAN_ONLY, kept: "House Espresso, no batch" });
    expect(beanOnly[0]).toEqual({ options: [{ value: BEAN_ONLY, label: "House Espresso, no batch" }] });
    // A new Recipe names none: nothing leads, and nothing is its batch now.
    const fresh = recipeBatchGroups({ batches: all, here: DOWNTOWN, value: NO_BATCH });
    expect(fresh.map((group) => group.label)).toEqual(["At Downtown", "Elsewhere: saving adds it at Downtown", undefined]);
    expect(fresh.flatMap((group) => group.options).some((option) => option.note === "this Recipe's batch now")).toBe(false);
  });

  it("marks its own batch among those elsewhere, as one finished at its Location is, and offers only No batch where the Library has no batch", () => {
    const groups = recipeBatchGroups({ batches: [lab, next], here: DOWNTOWN, value: "lab", own: { id: "lab", bean: HOUSE, roastDate: lab.roastDate } });
    expect(groups[1]!.options[0]!.note).toBe("this Recipe's batch now · at Roastery Lab");
    expect(recipeBatchGroups({ batches: [], here: DOWNTOWN, value: NO_BATCH })).toEqual([{ options: [{ value: NO_BATCH, label: "No batch" }] }]);
  });

  it("the next roasts of its Bean at its Location: the other batches of the Bean there, the latest roasted first", () => {
    const finished = recipe({ id: "gone", date: 3, batchCode: "LR-0405", atLocation: false });
    expect(nextRoasts(finished, all, "downtown").map((each) => each.id)).toEqual(["next", "now", "plain"]);
    // Not the Recipe's own, were it still listed there, and none of another Bean or another Location.
    expect(nextRoasts(recipe({ id: "now", date: 17 }), all, "downtown").map((each) => each.id)).toEqual(["next", "plain"]);
    expect(nextRoasts(finished, all, "riverside")).toEqual([]);
    expect(nextRoasts(finished, [decaf, lab], "downtown")).toEqual([]);
    expect(nextRoasts(recipe({ id: "gone", date: 3 }, null), all, "downtown")).toEqual([]);
    expect(nextRoasts(finished, all, undefined)).toEqual([]);
  });
});

describe("the picker's value", () => {
  it("is a Recipe's batch, that it names a Bean with none, or no batch", () => {
    expect(batchValueOf({ beanBatchId: "b1", beanId: "house" })).toBe("b1");
    expect(batchValueOf({ beanId: "house" })).toBe(BEAN_ONLY);
    expect(batchValueOf({})).toBe(NO_BATCH);
  });

  it("edits the Recipe's batch and nothing else: a batch, none, or nothing for a Bean kept with no batch", () => {
    expect(batchEdit("b1")).toEqual({ beanBatchId: "b1" });
    expect(batchEdit(NO_BATCH)).toEqual({ beanBatchId: null });
    expect(batchEdit(BEAN_ONLY)).toEqual({});
  });
});
