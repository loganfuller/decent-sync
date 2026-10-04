import { describe, expect, it } from "vitest";
import { extractShot, shotHardware, shotVersion } from "../src/shots/extraction.js";
import { shotFixture } from "./support/shot-fixtures.js";

// Real tablet records and labelled derivations of older Decaid layouts, as
// verified in Decaid v0.7.5/v0.8.7's Workflow and ShotRecord serializers.
describe("Shot extraction", () => {
  it("extracts a real native espresso including curves and tablet-local library names", () => {
    const shot = shotFixture();
    expect(extractShot(shot)).toMatchObject({
      profileTitle: "Londonium", profileId: "profile:98fa00c191551b435845", targetDose: 18, targetYield: 36,
      actualDose: 18, actualYield: 35.9, barista: "Fixture Barista",
      beanBatchId: "416d62df-2554-4a8a-b266-c0029bc459b2", coffeeName: "Ethiopia Generic 100g Sample",
      duration: 27.935, peakPressure: expect.any(Number), peakFlow: expect.any(Number),
    });
    expect(shotHardware(shot)).toEqual({ model: "DE1Pro", serial: "10001" });
  });

  it("extracts an actual de1app import without inventing hardware, batch or Barista", () => {
    const shot = shotFixture("de1app");
    expect(extractShot(shot)).toMatchObject({ profileTitle: "TurboBloom", targetYield: 42, duration: 27.301, barista: null, beanBatchId: null });
    expect(shotHardware(shot)).toBeNull();
  });

  it("accepts a derived pre-context/pre-provenance layout with the older doseData and coffeeData fields", () => {
    const shot = shotFixture();
    const workflow = shot.workflow as Record<string, unknown>;
    const context = workflow.context as Record<string, unknown>;
    const { context: omittedContext, machine: omittedMachine, ...olderWorkflow } = workflow;
    const { createdAt, updatedAt, ...olderShot } = shot;
    const derived = { ...olderShot, workflow: { ...olderWorkflow,
      doseData: { doseIn: context.targetDoseWeight, doseOut: context.targetYield },
      coffeeData: { name: context.coffeeName, roaster: context.coffeeRoaster },
    } };
    expect(extractShot(derived)).toMatchObject({ targetDose: 18, targetYield: 36, coffeeName: context.coffeeName, beanBatchId: null });
    expect(shotHardware(derived)).toBeNull();
    expect(shotVersion(derived)).toBe(String(shot.timestamp) + "Z");
  });

  it("tolerates absent, unfamiliar and mistyped optional fields", () => {
    for (const shot of [{}, { workflow: null, annotations: "unknown", measurements: [{ machine: null }, { machine: { pressure: "high" } }] }]) {
      expect(Object.values(extractShot(shot))).toEqual(expect.arrayContaining([null]));
      expect(shotHardware(shot)).toBeNull();
    }
    expect(extractShot({})).toEqual(Object.fromEntries(Object.keys(extractShot({})).map((key) => [key, null])));
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record<string, unknown>;
    for (const machine of [undefined, { model: "DE1Pro", serialNumber: "0" }, { model: "DE1Pro", serialNumber: "10001", provenanceStatus: "unavailable" }]) {
      expect(shotHardware({ ...fixture, workflow: { ...workflow, machine } })).toBeNull();
    }
  });

  it("uses updatedAt, then createdAt, then timestamp, retaining Decaid's microseconds", () => {
    expect(shotVersion({ updatedAt: "2026-10-04T12:00:00.000002Z", createdAt: "2026-10-03T12:00:00Z" })).toBe("2026-10-04T12:00:00.000002Z");
    expect(shotVersion({ updatedAt: null, createdAt: "2026-10-03T12:00:00Z" })).toBe("2026-10-03T12:00:00Z");
    expect(shotVersion({ timestamp: "2026-10-03T12:00:00" })).toBe("2026-10-03T12:00:00Z");
    expect(shotVersion({ updatedAt: "unfamiliar" })).toBe("1970-01-01T00:00:00.000Z");
  });
});
