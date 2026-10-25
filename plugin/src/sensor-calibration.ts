// Setting a sensor's calibration to a value (#228): a pure module.
//
// Decaid's `PUT /machine/calibration/{target}` is a correction, not a set:
// the DE1's firmware multiplies a ratio by `measuredValue / de1ReportedValue`
// and adds their difference to an offset (`De1Calibration`). Sending the
// current value C as `de1ReportedValue` and the value wanted as
// `measuredValue` lands on the value wanted, as Streamline's
// `absoluteSetCorrection` does (streamline-js:src/modules/sensor-cal.js).

/** The machine's sensors that Decaid reads and writes calibration for (`De1CalibrationTarget`). */
export const SENSOR_CALIBRATION_TARGETS = ["flow", "pressure", "temperature"] as const;

/** Whether a sensor's calibration is a ratio, multiplied, or an offset, added. */
const KINDS: Readonly<Record<(typeof SENSOR_CALIBRATION_TARGETS)[number], "ratio" | "offset">> = { flow: "ratio", pressure: "ratio", temperature: "offset" };

/** The scale of the signed Q16.16 values a calibration packet carries (`De1Calibration.fixedPointScale`). */
const Q16 = 65536;

/**
 * The correction that sets `target`'s calibration from `current`, its value
 * as read, to `wanted`, or why it can't be made: the target is none the
 * machine calibrates, the read holds no number, or, for a ratio, the
 * current value encodes as zero in Q16.16, which Decaid refuses to divide
 * by (`De1Calibration.validateForWrite`).
 */
export function absoluteSet(target: string, current: unknown, wanted: number): { body: { de1ReportedValue: number; measuredValue: number } } | { refused: string } {
  const kind = (KINDS as Readonly<Record<string, "ratio" | "offset">>)[target];
  if (kind === undefined) return { refused: `The machine has no ${target} sensor to calibrate` };
  if (typeof current !== "number" || !Number.isFinite(current)) return { refused: `Decaid's answer holds no current calibration of the ${target} sensor` };
  if (kind === "ratio" && Math.round(Math.abs(current) * Q16) === 0) {
    return { refused: `The ${target} sensor's calibration is 0, which Decaid can't correct from` };
  }
  return { body: { de1ReportedValue: current, measuredValue: wanted } };
}
