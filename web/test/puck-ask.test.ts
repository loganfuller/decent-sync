import { type SimulationShot, grindOf, shotPuck, simulationShotOf } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import classicItalian from "../../server/test/fixtures/decaid/simulated-shots-v0.9.2/classic-italian.json" with { type: "json" };
import { MAX_DOSE, MAX_STOP_AT, askOf } from "../src/lib/puck-ask";

// What a Shot laid over a Profile's graph sets its simulation to (#622), on
// the Shot Decaid v0.9.2's simulated machine recorded on Classic Italian
// espresso (server/test/fixtures/decaid/simulated-shots-v0.9.2/).
type Fields = Record<string, unknown>;
const recorded = classicItalian as Fields;
const shot = simulationShotOf(recorded, recorded.measurements);

/** The Shot with each sample's weight scaled, or dropped with null. */
function weighed(simulation: SimulationShot, by: number | null): SimulationShot {
  return {
    ...simulation,
    samples: simulation.samples.map((sample) => ({
      ...sample,
      values: { ...sample.values, weight: by === null || sample.values.weight === null ? null : sample.values.weight * by },
    })),
  };
}

describe("askOf", () => {
  it("sets the dose, the weight the Shot stopped at, its Machine's model and the grind its puck gives", () => {
    const grind = grindOf(shotPuck(shot)!);
    expect(askOf(shot)).toEqual({ dose: 18, stopAt: 33.4, model: "DE1", grind });
  });

  it("leaves out what the Shot can't give: no dose, no model, no weight", () => {
    const ask = askOf(weighed({ ...shot, dose: null, model: null }, null));
    expect(ask).not.toHaveProperty("dose");
    expect(ask).not.toHaveProperty("model");
    expect(ask).not.toHaveProperty("stopAt");
  });

  it("leaves out a dose or a stop-at weight past what its field takes", () => {
    const ask = askOf(weighed({ ...shot, dose: MAX_DOSE + 1 }, 20));
    expect(Math.max(...shot.samples.map((sample) => (sample.values.weight ?? 0) * 20))).toBeGreaterThan(MAX_STOP_AT);
    expect(ask).not.toHaveProperty("dose");
    expect(ask).not.toHaveProperty("stopAt");
    expect(ask).toHaveProperty("model", "DE1");
  });

  it("leaves the grind out where no puck can be worked out", () => {
    const unpressed = (recorded.measurements as Fields[]).map((measurement) => ({ ...measurement, machine: { ...(measurement.machine as Fields), pressure: 0 } }));
    const flat = simulationShotOf(recorded, unpressed);
    expect(shotPuck(flat)).toBeNull();
    expect(askOf(flat)).toEqual({ dose: 18, stopAt: 33.4, model: "DE1" });
  });
});
