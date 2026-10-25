import { type SettingsField, decimalPlaces, isEditable } from "@decent-sync/protocol";
import { inTabletTime, localTimeText, timeOfDayMinutes, timeOfDayText } from "@/lib/tablet-time";

// How the Settings card writes a Machine's or Tablet's settings values.

/**
 * A field's value as its definition shows it: a choice by its label, a time
 * of day as hours and minutes, a local time as its date and time, each in
 * the Tablet's own time and labelled with its UTC offset where it is known,
 * a wake schedule's days by their names, and a number with its unit, a
 * sensor's calibration rounded to its field's step (`onCalibrationStep`). A
 * value that is none of these, such as a choice not offered, is shown as it
 * is (`valueText`). `name` is the field's settings collection.
 */
export function fieldText(name: string, field: SettingsField, value: unknown, utcOffsetMinutes: number | null = null): string {
  if (field.kind === "choice" && "choices" in field) {
    const choice = field.choices?.find((offered) => offered.value === value);
    if (choice) return choice.label;
  }
  const time =
    field.kind === "timeOfDay"
      ? timeOfDayText(value)
      : field.kind === "hoursMinutes"
        ? timeOfDayText(timeOfDayMinutes(value))
        : field.kind === "localTime"
          ? localTimeText(value)
          : undefined;
  if (time !== undefined) return inTabletTime(time, utcOffsetMinutes);
  if (field.kind === "weekdays") return daysText(value);
  const shown = name === "sensorCalibration" && typeof value === "number" ? onCalibrationStep(field, value) : value;
  if (typeof shown === "number" && field.unit) return `${valueText(shown)} ${field.unit}`;
  return valueText(shown);
}

/**
 * A sensor's calibration rounded to its field's step, 0.0001 for a
 * multiplier and 0.01 for the temperature offset, as Streamline's Sensor
 * Calibration page shows it. The machine holds each in signed Q16.16, steps
 * of 1/65536, seldom on the field's step: shown to five decimal places, the
 * test DE1Pro's pressure multiplier of 1.293609619140625 read 1.29361, and
 * an edit to 1.29, which the machine holds as 1.2899932861328125, read as
 * applied as 1.28999 (#272). The steps are powers of ten, so rounding to
 * their decimal places is rounding to the step.
 */
function onCalibrationStep(field: SettingsField, value: number): number {
  if (!isEditable(field) || field.step === undefined) return value;
  return Number(value.toFixed(decimalPlaces(field.step)));
}

/** The ISO days of the week, Monday 1 to Sunday 7, as a wake schedule names them. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A wake schedule's days, as Streamline's settings page names them: none chosen is every day, as Decaid takes it. */
export function daysText(days: unknown): string {
  if (!Array.isArray(days)) return valueText(days);
  if (days.length === 0) return "Every day";
  return days.map((day: unknown) => (typeof day === "number" && WEEKDAYS[day - 1]) || valueText(day)).join(", ");
}

/**
 * A settings value written out: on or off, and a number to five decimal
 * places at most, parts of a list or object too: Decaid sends
 * 2.500000000000001 for a flow multiplier of 2.5.
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
