import { profileOf, shotSamples } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { shotSamplesOf } from "../src/mcp/shot-samples.js";
import { preheatShotFixture } from "./support/shot-fixtures.js";

// A Shot's samples as get_shot_samples gives them (#607), through the pure
// function it calls. assistant-records.test.ts calls the tool itself.

describe("a Shot's samples", () => {
  it("give no frame, and get_shot no step, for a frame past the integers JSON's numbers hold exactly", () => {
    // Derived: the real Shot with a Preheat, one sample after it reporting a frame no Decaid sends, as a corrupt record might.
    const fixture = preheatShotFixture();
    const measurements = structuredClone(fixture.measurements) as { machine: { profileFrame: unknown } }[];
    const at = measurements.length - 1;
    measurements[at]!.machine.profileFrame = 2 ** 60;
    const samples = shotSamplesOf(measurements);
    const columns = samples.columns(0, samples.total);
    expect(columns.frame[at]).toBeNull();
    expect(columns.frame[at - 1]).toEqual(expect.any(Number));
    const curves = shotSamples(measurements, profileOf((fixture.workflow as { profile: unknown }).profile));
    expect(curves.at(-1)!.step).toBeNull();
  });
});
