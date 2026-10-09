import { describe, expect, it } from "vitest";
import { brought, clearStillDue, joins, standing, workflowClear } from "../src/library/join-plan.js";

// The plan a Machine's tablet follows when it joins a Location (ADR-0008,
// ADR-0018): which reports are part of joining, what it brought, and which
// of its Workflow's grinder and batch are cleared. What it is written of the
// Location's Library and settings is planned as for any tablet there
// (holdings.test.ts, settings-intake.test.ts).

const LAB = "0199c0de-0000-7000-8000-00000000000a";
const BELMONT = "0199c0de-0000-7000-8000-00000000000b";
const ENTRY = { id: "0199c0de-0000-7000-8000-000000000001", locationId: LAB, sharingSince: null };

/** A Workflow's context naming a grinder and a batch on the tablet, with its profile's dose and yield. */
const CONTEXT = {
  targetDoseWeight: 18,
  targetYield: 36,
  grinderId: "grinder-1",
  grinderModel: "Niche Zero",
  grinderSetting: "12",
  beanBatchId: "batch-1",
  coffeeName: "Guji Hambela",
  coffeeRoaster: "Roux",
  baristaName: "Ana",
};
const GRINDER = { "context.grinderId": "grinder-1", "context.grinderModel": "Niche Zero" };
const BATCH = { "context.beanBatchId": "batch-1", "context.coffeeName": "Guji Hambela", "context.coffeeRoaster": "Roux" };

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

  it("lists what a joining report added to the Library or matched to an item it had, but not one of Decaid's bundled Profiles", () => {
    expect(brought(true, "joined")).toBe(true);
    expect(brought(true, "matched")).toBe(true);
    expect(brought(true, "joined", true)).toBe(false);
    // A record the tablet's map held, or one carrying an item's global id, was the Library's already.
    expect(brought(true, "known")).toBe(false);
    // A barista's new item after the tablet joined is no item it brought.
    expect(brought(false, "joined")).toBe(false);
    expect(brought(false, "matched")).toBe(false);
  });
});

describe("A joining tablet's Workflow", () => {
  it("has its grinder and batch cleared where the Location offers neither, keeping its profile, dose, yield and grinder setting", () => {
    expect(workflowClear(CONTEXT, "notOffered", "notOffered")).toEqual({ ...GRINDER, ...BATCH });
  });

  it("keeps a grinder or batch the Location offers", () => {
    expect(workflowClear(CONTEXT, "offered", "notOffered")).toEqual(BATCH);
    expect(workflowClear(CONTEXT, "notOffered", "offered")).toEqual(GRINDER);
    expect(workflowClear(CONTEXT, "offered", "offered")).toBeNull();
  });

  it("keeps one the tablet's map does not hold, which joins the Library at the Location with the tablet's reports", () => {
    expect(workflowClear(CONTEXT, "unknown", "unknown")).toBeNull();
    expect(workflowClear(CONTEXT, "unknown", "notOffered")).toEqual(BATCH);
  });

  it("clears nothing it does not name, and expects each field as the tablet reported it", () => {
    expect(workflowClear({ targetDoseWeight: 18, targetYield: 36 }, "notOffered", "notOffered")).toBeNull();
    expect(workflowClear(undefined, "notOffered", "notOffered")).toBeNull();
    // DYE2 sets a grinder's model with its id, but another skin may not.
    expect(workflowClear({ grinderId: "grinder-1" }, "notOffered", "unknown")).toEqual({ "context.grinderId": "grinder-1", "context.grinderModel": null });
  });

  it("keeps a clear due only while the Workflow still names the grinder or batch it would clear", () => {
    const expected = { ...GRINDER, ...BATCH };
    expect(clearStillDue(expected, CONTEXT)).toEqual(expected);
    // A barista picked another grinder since, of the same model: it stays whole, and the batch is still cleared.
    expect(clearStillDue(expected, { ...CONTEXT, grinderId: "grinder-2" })).toEqual(BATCH);
    // The write cleared both, as Decaid answered it.
    expect(clearStillDue(expected, { targetDoseWeight: 18, targetYield: 36, grinderSetting: "12" })).toBeNull();
    expect(clearStillDue(expected, undefined)).toBeNull();
    // A skin relabelled the same grinder: it is still cleared, expecting the label it holds now.
    expect(clearStillDue(GRINDER, { ...CONTEXT, grinderModel: "Niche Zero (bar)" })).toEqual({ ...GRINDER, "context.grinderModel": "Niche Zero (bar)" });
  });
});
