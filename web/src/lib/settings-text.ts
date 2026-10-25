import type { SettingsField } from "@decent-sync/protocol";

// How the Settings card writes a Machine's or Tablet's settings values.

/**
 * A field's value as its definition shows it: a choice by its label, a time
 * of day as hours and minutes, and a number with its unit. A value that is
 * none of these, such as a choice not offered, is shown as it is
 * (`valueText`).
 */
export function fieldText(field: SettingsField, value: unknown): string {
  if (field.kind === "choice" && "choices" in field) {
    const choice = field.choices?.find((offered) => offered.value === value);
    if (choice) return choice.label;
  }
  if (field.kind === "timeOfDay" && typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 24 * 60) {
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }
  if (typeof value === "number" && field.unit) return `${valueText(value)} ${field.unit}`;
  return valueText(value);
}

/**
 * A settings value written out: on or off, and a number to five decimal
 * places at most, parts of a list or object too. The machine keeps each
 * sensor's calibration in signed Q16.16, steps of 1/65536, so any two it can
 * hold still differ when shown, and Decaid sends 2.500000000000001 for a flow
 * multiplier of 2.5.
 */
export function valueText(value: unknown): string {
  if (typeof value === "number") return String(Number(value.toFixed(5)));
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.length > 0 ? value.map(valueText).join(", ") : "None";
  if (isObject(value)) {
    if (Object.keys(value).length === 0) return "None";
    return Object.entries(value)
      .map(([key, part]) => `${key}: ${valueText(part)}`)
      .join(", ");
  }
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  return String(value);
}

/**
 * A settings collection's fields by their paths, as its report holds them.
 * `sensorCalibration` holds each target's current read, whose
 * `measuredValue` is its calibration (rest_v1.yml).
 */
export function reportedFields(name: string, value: Record<string, unknown>): Record<string, unknown> {
  if (name !== "sensorCalibration") return value;
  return Object.fromEntries(Object.entries(value).map(([target, read]) => [target, isObject(read) && "measuredValue" in read ? read.measuredValue : read]));
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
