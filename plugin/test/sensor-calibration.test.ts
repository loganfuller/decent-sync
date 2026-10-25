import { describe, expect, it } from "vitest";
import { absoluteSet } from "../src/sensor-calibration.js";

// Module tests for setting a sensor's calibration to a value (#228): the
// correction Decaid's `PUT /machine/calibration/{target}` takes, which the
// DE1's firmware folds into the value it holds.

/** What the firmware holds after folding a correction into `held` (`De1Calibration`): a ratio multiplied, an offset added. */
function folded(kind: "ratio" | "offset", held: number, correction: { de1ReportedValue: number; measuredValue: number }): number {
  return kind === "ratio" ? held * (correction.measuredValue / correction.de1ReportedValue) : held + (correction.measuredValue - correction.de1ReportedValue);
}

describe("the absolute set of a sensor calibration", () => {
  it("sends the current value as the reported one and the value wanted as the measured one, so the machine lands on it", () => {
    for (const [target, kind, current, wanted] of [
      ["flow", "ratio", 1, 1.05],
      ["pressure", "ratio", 1.0234375, 0.98],
      ["temperature", "offset", -0.5, 1.25],
      ["temperature", "offset", 0, -2],
    ] as const) {
      const set = absoluteSet(target, current, wanted);
      expect(set).toEqual({ body: { de1ReportedValue: current, measuredValue: wanted } });
      if ("body" in set) expect(folded(kind, current, set.body)).toBeCloseTo(wanted, 12);
    }
  });

  it("refuses a flow or pressure calibration of 0, which Decaid can't divide by, but not a temperature offset of 0", () => {
    expect(absoluteSet("flow", 0, 1)).toEqual({ refused: "The flow sensor's calibration is 0, which Decaid can't correct from" });
    // Under half a step of Q16.16, which encodes as zero.
    expect(absoluteSet("pressure", 0.4 / 65536, 1)).toEqual({ refused: "The pressure sensor's calibration is 0, which Decaid can't correct from" });
    expect(absoluteSet("pressure", 1 / 65536, 1)).toEqual({ body: { de1ReportedValue: 1 / 65536, measuredValue: 1 } });
    expect(absoluteSet("temperature", 0, 1)).toEqual({ body: { de1ReportedValue: 0, measuredValue: 1 } });
  });

  it("refuses a read holding no number, and a target the machine does not calibrate", () => {
    expect(absoluteSet("flow", undefined, 1)).toEqual({ refused: "Decaid's answer holds no current calibration of the flow sensor" });
    expect(absoluteSet("temperature", "0.5", 1)).toEqual({ refused: "Decaid's answer holds no current calibration of the temperature sensor" });
    expect(absoluteSet("weight", 1, 1)).toEqual({ refused: "The machine has no weight sensor to calibrate" });
  });
});
