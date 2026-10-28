import { describe, expect, it } from "vitest";
import { type Offered, clearStillDue, joiningRecord, joins, standing, workflowClear } from "../src/library/join-plan.js";

// The plan a Machine's tablet follows when it joins a Location (ADR-0008,
// ADR-0018): which reports are part of joining, what joining does to the
// tablet's records of Recipes, Baskets and Tools, and which of its
// Workflow's grinder, batch and Basket are cleared. What it is written of
// the Location's Library, its Recipe Slots included, is planned as for any
// tablet there (holdings.test.ts).

const LAB = "0199c0de-0000-7000-8000-00000000000a";
const BELMONT = "0199c0de-0000-7000-8000-00000000000b";
const ENTRY = { id: "0199c0de-0000-7000-8000-000000000001", locationId: LAB, sharingSince: null };

/** A Workflow's context naming a grinder, a batch and a Basket on the tablet, with its profile's dose and yield, and its RPM. */
const CONTEXT = {
  targetDoseWeight: 18,
  targetYield: 36,
  grinderId: "grinder-1",
  grinderModel: "Niche Zero",
  grinderBurrs: "Stock",
  grinderSetting: "12",
  beanBatchId: "batch-1",
  coffeeName: "Guji Hambela",
  coffeeRoaster: "Roux",
  baristaName: "Ana",
  extras: { basketId: "basket-1", basketName: "18g Precision", rpm: 1200 },
};
const GRINDER = { "context.grinderId": "grinder-1", "context.grinderModel": "Niche Zero", "context.grinderBurrs": "Stock" };
const BATCH = { "context.beanBatchId": "batch-1", "context.coffeeName": "Guji Hambela", "context.coffeeRoaster": "Roux" };
const BASKET = { "context.extras.basketId": "basket-1", "context.extras.basketName": "18g Precision" };

/** What the Location offers of the Workflow's grinder, batch and Basket, each as given or else not offered. */
const offers = (given: { grinder?: Offered; batch?: Offered; basket?: Offered } = {}) => ({
  grinder: "notOffered" as Offered,
  batch: "notOffered" as Offered,
  basket: "notOffered" as Offered,
  ...given,
});

describe("Joining a Location", () => {
  it("starts with a tablet's first report of a kind, and again once its Machine is at another Location, or moved away and back", () => {
    expect(joins(null, ENTRY, false)).toBe(true);
    expect(joins(ENTRY, ENTRY, true)).toBe(false);
    // Moved, or moved back to a Location it was at before, a new entry replacing the one it was taken in under.
    expect(joins(ENTRY, { id: "0199c0de-0000-7000-8000-000000000002", locationId: BELMONT, sharingSince: null }, true)).toBe(true);
    expect(joins(ENTRY, { id: "0199c0de-0000-7000-8000-000000000003", locationId: LAB, sharingSince: null }, true)).toBe(true);
    // An Admin corrected the current entry's Location, or removed it: it is at another Location now.
    expect(joins(ENTRY, { ...ENTRY, locationId: BELMONT, sharingSince: null }, true)).toBe(true);
    expect(joins(ENTRY, { id: "0199c0de-0000-7000-8000-000000000004", locationId: BELMONT, sharingSince: null }, false)).toBe(true);
  });

  it("does not start when a move made by mistake is removed, and the Machine never left", () => {
    // A move away and back removed: the entry it was taken in under is gone, and an earlier one at the same Location is current.
    expect(joins(ENTRY, { id: "0199c0de-0000-7000-8000-000000000000", locationId: LAB, sharingSince: null }, false)).toBe(false);
  });

  it("starts again once an Admin turns sharing back on, under the same entry", () => {
    const turnedOn = { ...ENTRY, sharingSince: new Date("2026-10-09T12:00:00.000Z") };
    expect(joins(ENTRY, turnedOn, true)).toBe(true);
    expect(joins(turnedOn, { ...turnedOn, sharingSince: new Date("2026-10-09T12:00:00.000Z") }, true)).toBe(false);
    // Turned off and on again since.
    expect(joins(turnedOn, { ...ENTRY, sharingSince: new Date("2026-10-09T13:00:00.000Z") }, true)).toBe(true);
  });

  it("tells a tablet's writer its reports were taken in elsewhere once sharing was turned off and on again", () => {
    const turnedOn = { ...ENTRY, sharingSince: new Date("2026-10-09T12:00:00.000Z") };
    expect(standing(ENTRY)).toBe(LAB);
    expect(standing(turnedOn)).not.toBe(standing(ENTRY));
    expect(standing({ ...turnedOn, id: "0199c0de-0000-7000-8000-000000000002" })).toBe(standing(turnedOn));
    expect(standing({ ...turnedOn, locationId: BELMONT })).not.toBe(standing(turnedOn));
  });
});

describe("A joining tablet's recipes, baskets and tools", () => {
  it("drops its own, removed from DYE2's lists and not kept, where the Location has some of the kind", () => {
    expect(joiningRecord("add", false)).toBe("leftOut");
    // A recipe saved in a slot the Location fills is the tablet's own, not that Recipe's.
    expect(joiningRecord("edit", false)).toBe("leftOut");
  });

  it("brings its own in their slots, or shown, to a Location that has none of the kind yet", () => {
    expect(joiningRecord("add", true)).toBe("brought");
    expect(joiningRecord("edit", true)).toBe("leftOut");
  });

  it("takes those that are Library items as those items, written the Location's state, as another Location's Recipes", () => {
    for (const bringing of [false, true]) {
      expect(joiningRecord("map", bringing)).toBe("theItem");
      expect(joiningRecord("update", bringing)).toBe("theItem");
    }
    // A Basket or Tool matched by name is that item, shown there only where the Location shows none of the kind yet.
    expect(joiningRecord("link", false)).toBe("theItem");
    expect(joiningRecord("link", true)).toBe("shown");
  });
});

describe("A joining tablet's Workflow", () => {
  it("has its grinder, batch and Basket cleared where the Location offers none of them, keeping its profile, dose, yield, grinder setting and RPM", () => {
    expect(workflowClear(CONTEXT, offers())).toEqual({ ...GRINDER, ...BATCH, ...BASKET });
  });

  it("keeps a grinder, batch or Basket the Location offers", () => {
    expect(workflowClear(CONTEXT, offers({ grinder: "offered" }))).toEqual({ ...BATCH, ...BASKET });
    expect(workflowClear(CONTEXT, offers({ batch: "offered" }))).toEqual({ ...GRINDER, ...BASKET });
    expect(workflowClear(CONTEXT, offers({ basket: "offered" }))).toEqual({ ...GRINDER, ...BATCH });
    expect(workflowClear(CONTEXT, offers({ grinder: "offered", batch: "offered", basket: "offered" }))).toBeNull();
  });

  it("keeps one the tablet's map does not hold, which joins the Library at the Location with the tablet's reports", () => {
    expect(workflowClear(CONTEXT, offers({ grinder: "unknown", batch: "unknown", basket: "unknown" }))).toBeNull();
    expect(workflowClear(CONTEXT, offers({ grinder: "unknown", basket: "unknown" }))).toEqual(BATCH);
  });

  it("clears nothing it does not name, and expects each field as the tablet reported it", () => {
    expect(workflowClear({ targetDoseWeight: 18, targetYield: 36 }, offers())).toBeNull();
    expect(workflowClear({ targetDoseWeight: 18, extras: { basketId: null, rpm: 1200 } }, offers())).toBeNull();
    expect(workflowClear(undefined, offers())).toBeNull();
    // DYE2 sets a grinder's model with its id, and a Basket's name with its id, but another skin may not.
    expect(workflowClear({ grinderId: "grinder-1" }, offers({ batch: "unknown" }))).toEqual({ "context.grinderId": "grinder-1", "context.grinderModel": null, "context.grinderBurrs": null });
    expect(workflowClear({ extras: { basketId: "basket-1" } }, offers())).toEqual({ "context.extras.basketId": "basket-1", "context.extras.basketName": null });
  });

  it("keeps a clear due only while the Workflow still names the grinder, batch or Basket it would clear", () => {
    const expected = { ...GRINDER, ...BATCH, ...BASKET };
    expect(clearStillDue(expected, CONTEXT)).toEqual(expected);
    // A barista picked another grinder since, of the same model: it stays whole, and the batch and Basket are still cleared.
    expect(clearStillDue(expected, { ...CONTEXT, grinderId: "grinder-2" })).toEqual({ ...BATCH, ...BASKET });
    // Or another Basket of the same name.
    expect(clearStillDue(expected, { ...CONTEXT, extras: { ...CONTEXT.extras, basketId: "basket-2" } })).toEqual({ ...GRINDER, ...BATCH });
    // The write cleared them all, as Decaid answered it, the Basket's keys set to null.
    expect(clearStillDue(expected, { targetDoseWeight: 18, targetYield: 36, grinderSetting: "12", extras: { basketId: null, basketName: null, rpm: 1200 } })).toBeNull();
    expect(clearStillDue(expected, undefined)).toBeNull();
    // A skin relabelled the same grinder: it is still cleared, expecting the label it holds now.
    expect(clearStillDue(GRINDER, { ...CONTEXT, grinderModel: "Niche Zero (bar)" })).toEqual({ ...GRINDER, "context.grinderModel": "Niche Zero (bar)" });
  });
});
