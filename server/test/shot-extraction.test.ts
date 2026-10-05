import { describe, expect, it } from "vitest";
import { extractCurves, extractShot, shotHardware, shotVersion } from "../src/shots/extraction.js";
import { shotFixture } from "./support/shot-fixtures.js";

// A scrubbed real tablet record, in the layout of Decaid v0.8.7's Workflow and
// ShotRecord serializers.
describe("Shot extraction", () => {
  it("extracts a real native espresso including curves and tablet-local library names", () => {
    const shot = shotFixture();
    expect(extractShot(shot)).toMatchObject({
      profileTitle: "Londonium", profileId: "profile:98fa00c191551b435845", targetDose: 18, targetYield: 36,
      actualDose: 18, actualYield: 35.9, barista: "Fixture Barista",
      beanBatchId: "416d62df-2554-4a8a-b266-c0029bc459b2", coffeeName: "Ethiopia Generic 100g Sample",
    });
    expect(extractCurves(shot, shot.measurements)).toMatchObject({ duration: 27.935, peakPressure: expect.any(Number), peakFlow: expect.any(Number) });
    expect(shotHardware(shot)).toEqual({ model: "DE1Pro", serial: "10001" });
  });

  it("places Decaid's offset-free local times using the UTC createdAt saved after the last sample", () => {
    const shot = shotFixture();
    // The fixture was pulled at 14:14:10 local time, UTC-4.
    expect(extractCurves(shot, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T18:14:10.690Z"));
    // The same wall-clock times on a tablet at UTC+5:30.
    expect(extractCurves({ ...shot, createdAt: "2026-10-04T08:44:42.666246Z" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T08:44:10.690Z"));
    expect(extractCurves({ ...shot, timestamp: "2026-10-04T14:14:10.690+02:00" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T12:14:10.690Z"));
    expect(extractCurves({ ...shot, createdAt: undefined }, shot.measurements).pulledAt).toBeNull();
    expect(extractCurves(shot, []).pulledAt).toBeNull();
  });

  it("tolerates absent, unfamiliar and mistyped optional fields", () => {
    for (const shot of [{}, { workflow: null, annotations: "unknown", measurements: [{ machine: null }, { machine: { pressure: "high" } }] }]) {
      expect(Object.values(extractShot(shot))).toEqual(expect.arrayContaining([null]));
      expect(Object.values(extractCurves(shot, shot.measurements))).toEqual([null, null, null, null]);
      expect(shotHardware(shot)).toBeNull();
    }
    expect(extractShot({})).toEqual(Object.fromEntries(Object.keys(extractShot({})).map((key) => [key, null])));
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record<string, unknown>;
    for (const machine of [undefined, { model: "DE1Pro", serialNumber: "0" }, { model: "DE1Pro", serialNumber: "10001", provenanceStatus: "unavailable" }]) {
      expect(shotHardware({ ...fixture, workflow: { ...workflow, machine } })).toBeNull();
    }
  });

  it("versions by updatedAt alone, retaining Decaid's microseconds, and finds none in other records", () => {
    expect(shotVersion({ updatedAt: "2026-10-04T12:00:00.000002Z", createdAt: "2026-10-03T12:00:00Z" })).toBe("2026-10-04T12:00:00.000002Z");
    for (const updatedAt of [undefined, null, "2026-10-03T12:00:00", "2026-13-03T12:00:00Z", "unfamiliar"]) {
      expect(shotVersion({ updatedAt, createdAt: "2026-10-03T12:00:00Z", timestamp: "2026-10-03T12:00:00" })).toBeNull();
    }
  });
});
