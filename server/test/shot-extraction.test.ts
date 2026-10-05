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
    expect(extractShot({})).toEqual(Object.fromEntries(Object.keys(extractShot({})).map((key) => [key, null])));
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record<string, unknown>;
    for (const machine of [undefined, { model: "DE1Pro", serialNumber: "0" }, { model: "DE1Pro", serialNumber: "10001", provenanceStatus: "unavailable" }]) {
      expect(shotHardware({ ...fixture, workflow: { ...workflow, machine } })).toBeNull();
    }
  });

  it("versions by updatedAt alone, retaining Decaid's microseconds, and finds none in other records", () => {
    expect(shotVersion({ updatedAt: "2026-10-04T12:00:00.000002Z", createdAt: "2026-10-03T12:00:00Z" })).toBe("2026-10-04T12:00:00.000002Z");
    for (const updatedAt of [undefined, null, "2026-10-03T12:00:00", "2026-10-03T12:00:00+02:00", "2026-13-03T12:00:00Z", "unfamiliar"]) {
      expect(shotVersion({ updatedAt, createdAt: "2026-10-03T12:00:00Z", timestamp: "2026-10-03T12:00:00" })).toBeNull();
    }
  });
});
