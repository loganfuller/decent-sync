import { describe, expect, it } from "vitest";
import { MAX_HARDWARE_LENGTH } from "@decent-sync/protocol";
import { extractCurves, extractShot, shotHardware, shotVersion } from "../src/shots/extraction.js";
import { burrsShotFixture, shotFixture } from "./support/shot-fixtures.js";

// A scrubbed real tablet record, in the layout of Decaid v0.8.7's Workflow and
// ShotRecord serializers, which Decaid v0.9.0 still serves as it was stored,
// and one Decaid v0.9.0 recorded from its simulated machine.
describe("Shot extraction", () => {
  it("extracts a real native espresso including curves and tablet-local library names", () => {
    const shot = shotFixture();
    expect(extractShot(shot)).toMatchObject({
      profileTitle: "Londonium", profileId: "profile:98fa00c191551b435845", targetDose: 18, targetYield: 36,
      actualDose: 18, actualYield: 35.9, barista: "Fixture Barista",
      beanBatchId: "416d62df-2554-4a8a-b266-c0029bc459b2", grinderId: "e2d50b3d-a6d9-48bb-9b50-1efb4df60229", coffeeName: "Ethiopia Generic 100g Sample",
    });
    expect(extractCurves(shot, shot.measurements)).toMatchObject({ duration: 27.935, peakPressure: expect.any(Number), peakFlow: expect.any(Number) });
    expect(shotHardware(shot)).toEqual({ model: "DE1Pro", serial: "10001" });
    const longest = "9".repeat(MAX_HARDWARE_LENGTH);
    const workflow = shot.workflow as Record<string, unknown>;
    expect(shotHardware({ ...shot, workflow: { ...workflow, machine: { model: "DE1Pro", serialNumber: longest } } })).toEqual({ model: "DE1Pro", serial: longest });
  });

  it("extracts the burrs Decaid copied onto the Shot from its Grinder's record, over those its Workflow held", () => {
    // Its Workflow held "Inherited burrs", as one a repeated Shot brought would (shot-grinder-burrs-setup.json).
    expect(extractShot(burrsShotFixture())).toMatchObject({ grinderId: "1629e825-59e0-46b6-a3db-2346fcfd90b5", grinderBurrs: "Fixture 64mm flat" });
    // Pulled on Decaid v0.8.7, which recorded no burrs.
    expect(extractShot(shotFixture()).grinderBurrs).toBeNull();
  });

  it("places Decaid's offset-free local times using the UTC createdAt saved after the last sample", () => {
    const shot = shotFixture();
    // The fixture was pulled at 14:14:10 local time, UTC-4.
    expect(extractCurves(shot, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T18:14:10.690Z"));
    // The same wall-clock times on a tablet at UTC+5:30.
    expect(extractCurves({ ...shot, createdAt: "2026-10-04T08:44:42.666246Z" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T08:44:10.690Z"));
    expect(extractCurves({ ...shot, timestamp: "2026-10-04T14:14:10.690+02:00" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T12:14:10.690Z"));
    // Read back after the tablet moved from UTC-4 to UTC+1; its samples keep the zone they were recorded in.
    expect(extractCurves({ ...shot, timestamp: "2026-10-04T19:14:10.690852" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T18:14:10.690Z"));
    expect(extractCurves({ ...shot, createdAt: undefined }, shot.measurements).pulledAt).toBeNull();
    expect(extractCurves(shot, []).pulledAt).toBeNull();
  });

  it("measures duration across a daylight-saving change in the tablet's local times", () => {
    // Derived: the Shot's first two samples, at times either side of Chicago's changes, two seconds apart.
    const shot = shotFixture();
    const [first, second] = shot.measurements as { machine: Record<string, unknown> }[];
    const at = (sample: { machine: Record<string, unknown> }, timestamp: string) => ({ ...sample, machine: { ...sample.machine, timestamp } });
    for (const [before, after] of [
      ["2026-03-08T01:59:59.000000", "2026-03-08T03:00:01.000000"],
      ["2026-11-01T01:59:59.000000", "2026-11-01T01:00:01.000000"],
    ]) {
      expect(extractCurves(shot, [at(first!, before!), at(second!, after!)]).duration).toBe(2);
    }
    // A jump that is not whole quarter hours, or a clock set back, is a correction of unknown size.
    expect(extractCurves(shot, [at(first!, "2026-10-04T14:14:10.000000"), at(second!, "2026-10-04T14:21:10.000000")]).duration).toBe(0);
    expect(extractCurves(shot, [at(first!, "2026-10-04T14:14:10.000000"), at(second!, "2026-10-04T13:59:09.000000")]).duration).toBe(0);
    const setBack = ["2026-10-04T14:14:10.000000", "2026-10-04T14:14:11.000000", "2026-10-04T14:14:01.000000", "2026-10-04T14:14:02.000000"];
    expect(extractCurves(shot, setBack.map((timestamp) => at(first!, timestamp))).duration).toBe(2);
  });

  it("tolerates absent, unfamiliar and mistyped optional fields", () => {
    for (const shot of [{}, { workflow: null, annotations: "unknown", measurements: [{ machine: null }, { machine: { pressure: "high" } }] }]) {
      expect(Object.values(extractShot(shot))).toEqual(expect.arrayContaining([null]));
      expect(Object.values(extractCurves(shot, shot.measurements))).toEqual([null, null, null, null]);
      expect(shotHardware(shot)).toBeNull();
    }
    // Every value is null, but the Tools, a list, which is empty, and whether DYE2's selection named anything.
    expect(extractShot({})).toEqual({ ...Object.fromEntries(Object.keys(extractShot({})).map((key) => [key, null])), toolIds: [], selectionNamed: false });
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record<string, unknown>;
    const tooLong = "9".repeat(MAX_HARDWARE_LENGTH + 1);
    for (const machine of [
      undefined,
      { model: "DE1Pro", serialNumber: "0" },
      { model: "DE1Pro", serialNumber: "10001", provenanceStatus: "unavailable" },
      // Longer than a hello may report: no Machine or Pending Machine could hold it.
      { model: "DE1Pro", serialNumber: tooLong },
      { model: tooLong, serialNumber: "10001" },
    ]) {
      expect(shotHardware({ ...fixture, workflow: { ...workflow, machine } })).toBeNull();
    }
  });

  it("reads the Basket and Tools DYE2 recorded, its Edit Shot page's over the Workflow's, and the recipe slot DYE2's selection named", () => {
    const shot = shotFixture();
    const workflow = shot.workflow as Record<string, unknown>;
    const context = workflow.context as Record<string, unknown>;
    const pulled = (extras: Record<string, unknown>, annotations: Record<string, unknown> = {}) =>
      extractShot({ ...shot, annotations, workflow: { ...workflow, context: { ...context, extras } } });

    expect(pulled({ basketId: "picked", basketName: "20 g", equipmentIds: ["wdt"], dye: { v: 1, selection: { kind: "recipe", id: "2" } } })).toMatchObject({
      basketId: "picked",
      toolIds: ["wdt"],
      recipeSlot: "2",
      selectionNamed: true,
    });
    // The Edit Shot page's Basket, and its Tools, single or listed, beside the Workflow's.
    expect(pulled({ basketId: "picked", equipmentIds: ["wdt"] }, { extras: { basketId: "edited", equipmentIds: ["screen", "wdt"] } })).toMatchObject({
      basketId: "edited",
      toolIds: ["screen", "wdt"],
    });
    expect(pulled({ basketId: "picked" }, { extras: { equipmentId: "tamper" } })).toMatchObject({ basketId: "picked", toolIds: ["tamper"] });
    // A Basket its page set by name alone is the page's, as DYE2 reads it, with no id.
    expect(pulled({ basketId: "picked" }, { extras: { basketName: "Unlisted" } }).basketId).toBeNull();
    // A favourite, or a recipe whose id is no slot, names an item but no slot; a selection cleared, or none, names nothing.
    expect(pulled({ dye: { selection: { kind: "favourite", id: "fav-1" } }, basketId: 7, equipmentIds: [3, ""] })).toMatchObject({
      recipeSlot: null,
      selectionNamed: true,
      basketId: null,
      toolIds: [],
    });
    expect(pulled({ dye: { selection: { kind: "recipe", id: "slot-1" } } })).toMatchObject({ recipeSlot: null, selectionNamed: true });
    expect(pulled({ dye: { v: 1, selection: null } })).toMatchObject({ recipeSlot: null, selectionNamed: false });
    expect(pulled({})).toMatchObject({ recipeSlot: null, selectionNamed: false });
  });

  it("versions by updatedAt alone, retaining Decaid's microseconds, and finds none in other records", () => {
    expect(shotVersion({ updatedAt: "2026-10-04T12:00:00.000002Z", createdAt: "2026-10-03T12:00:00Z" })).toBe("2026-10-04T12:00:00.000002Z");
    for (const updatedAt of [undefined, null, "2026-10-03T12:00:00", "2026-10-03T12:00:00+02:00", "2026-13-03T12:00:00Z", "unfamiliar"]) {
      expect(shotVersion({ updatedAt, createdAt: "2026-10-03T12:00:00Z", timestamp: "2026-10-03T12:00:00" })).toBeNull();
    }
  });
});
