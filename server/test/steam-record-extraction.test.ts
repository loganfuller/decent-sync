import { describe, expect, it } from "vitest";
import { extractSteamRecord } from "../src/steam-records/extraction.js";
import { milkProbeSteamFixture, nextMilkProbeSteamFixture, steamFixture } from "./support/steam-fixtures.js";

// Steam Records Decaid v0.8.7 produced: a scrubbed real record from a DE1Pro
// without a milk probe, and two from Decaid's simulated Bengle with its probe.
describe("Steam Record extraction", () => {
  it("extracts a real DE1Pro Steam Record, which has no milk temperature", () => {
    expect(extractSteamRecord(steamFixture())).toEqual({
      // From the first sample, at 19:23:40.558578, to the last, at 19:23:44.316115, to the millisecond.
      duration: 3.758,
      peakMilkTemperature: null,
      finalMilkTemperature: null,
      barista: "Fixture Barista",
    });
  });

  it("extracts the peak and final milk temperature a probe reported, ignoring samples before its first reading", () => {
    expect(extractSteamRecord(milkProbeSteamFixture())).toEqual({
      duration: 11.802,
      peakMilkTemperature: 60.46000000000001,
      finalMilkTemperature: 60.46000000000001,
      barista: "Fixture Barista",
    });
  });

  it("leaves the reading carried over from the Steam Record before out of the peak", () => {
    const next = nextMilkProbeSteamFixture();
    const readings = (next.measurements as { milkTemperature: number | null }[]).map((sample) => sample.milkTemperature);
    // The record before ended at 61.945 °C; this milk started at 6.52 °C.
    expect(readings.slice(0, 3)).toEqual([null, 61.945, 6.52]);
    expect(extractSteamRecord(next)).toEqual({
      duration: 12.102,
      peakMilkTemperature: 61.46499999999999,
      finalMilkTemperature: 61.46499999999999,
      barista: "Fixture Barista",
    });
    // Derived: cut short before the probe reported again, the record has only the reading it started with.
    const cutShort = { ...next, measurements: (next.measurements as unknown[]).slice(0, 2) };
    expect(extractSteamRecord(cutShort)).toMatchObject({ peakMilkTemperature: 61.945, finalMilkTemperature: 61.945 });
  });

  it("tolerates absent, unfamiliar and mistyped optional fields", () => {
    const none = { duration: null, peakMilkTemperature: null, finalMilkTemperature: null, barista: null };
    for (const record of [
      {},
      null,
      { measurements: "samples", workflow: null },
      { measurements: [null, 7, { machine: null, milkTemperature: "hot" }, { machine: { timestamp: "soon" } }], workflow: { context: { baristaName: 7 } } },
    ]) {
      expect(extractSteamRecord(record)).toEqual(none);
    }
    const fixture = milkProbeSteamFixture();
    const [sample] = fixture.measurements as Record<string, unknown>[];
    expect(extractSteamRecord({ ...fixture, measurements: [sample, { future: true }] })).toMatchObject({ duration: 0, peakMilkTemperature: null });
  });
});
