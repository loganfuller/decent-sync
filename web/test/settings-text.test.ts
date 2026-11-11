import { type SettingsCollectionName, type SettingsField, settingsField } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { daysText, fieldText, reportedFields, valueText } from "../src/lib/settings-text";
import { localTimeText, utcOffsetText } from "../src/lib/tablet-time";

// How the Settings card writes a Machine's or Tablet's settings values, with
// the protocol's own definitions of the fields.

function field(collection: SettingsCollectionName, path: string): SettingsField {
  const found = settingsField(collection, path);
  if (!found) throw new Error(`The protocol defines no ${collection} field ${path}`);
  return found;
}

describe("valueText", () => {
  it("writes a number to five decimal places at most", () => {
    // Decaid sends 2.500000000000001 for a flow multiplier of 2.5.
    expect(valueText(2.500000000000001)).toBe("2.5");
    expect(valueText(1.293609619140625)).toBe("1.29361");
    expect(valueText(0)).toBe("0");
    expect(valueText(-12)).toBe("-12");
  });

  it("writes on or off, an empty text as Empty, and no value as None", () => {
    expect(valueText(true)).toBe("On");
    expect(valueText(false)).toBe("Off");
    expect(valueText("")).toBe("Empty");
    expect(valueText("espresso")).toBe("espresso");
    expect(valueText(null)).toBe("None");
    expect(valueText(undefined)).toBe("None");
  });

  it("writes the parts of a list or an object the same way, and None for one with no parts", () => {
    expect(valueText([1, true, "a", 2.500000000000001])).toBe("1, On, a, 2.5");
    expect(valueText([])).toBe("None");
    expect(valueText({ flow: 2.500000000000001, heater: false })).toBe("flow: 2.5, heater: Off");
    expect(valueText({ steam: { flow: 1.2 }, days: [1, 2] })).toBe("steam: flow: 1.2, days: 1, 2");
    expect(valueText({})).toBe("None");
  });
});

describe("daysText", () => {
  it("names a wake schedule's days, Monday 1 to Sunday 7, and none chosen as every day", () => {
    expect(daysText([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(daysText([7])).toBe("Sun");
    expect(daysText([])).toBe("Every day");
  });

  it("writes a day that is none of the seven, or days that are no list, as they are", () => {
    expect(daysText([0, 8, "x"])).toBe("0, 8, x");
    expect(daysText("weekends")).toBe("weekends");
    expect(daysText(null)).toBe("None");
  });
});

describe("fieldText", () => {
  it("writes a choice by its label, and one not offered as it is", () => {
    const steamPurgeMode = field("machineSettings", "steamPurgeMode");
    expect(fieldText("machineSettings", steamPurgeMode, 1)).toBe("Two Tap Stop");
    expect(fieldText("machineSettings", steamPurgeMode, 7)).toBe("7");
  });

  it("writes a number with its field's unit, and on or off", () => {
    expect(fieldText("machineSettings", field("machineSettings", "steamFlow"), 1.2000000000000002)).toBe("1.2 ml/s");
    expect(fieldText("machineSettings", field("machineSettings", "fan"), 45)).toBe("45 °C");
    expect(fieldText("machineSettings", field("machineSettings", "usb"), true)).toBe("On");
  });

  it("writes a time of day as hours and minutes, in the Tablet's own time with its UTC offset where that is known", () => {
    const nightModeSleepTime = field("appSettings", "nightModeSleepTime");
    expect(fieldText("appSettings", nightModeSleepTime, 1320)).toBe("22:00");
    expect(fieldText("appSettings", nightModeSleepTime, 1320, -240)).toBe(`22:00 (${utcOffsetText(-240)})`);
    // Derived: the same field as one whose value is written as hours and minutes, as a wake schedule's times are.
    const hoursMinutes: SettingsField = { ...nightModeSleepTime, kind: "hoursMinutes" };
    expect(fieldText("presenceSettings", hoursMinutes, "06:30", 60)).toBe(`06:30 (${utcOffsetText(60)})`);
  });

  it("writes a local time as its date and time, not moved into another zone", () => {
    const keepAwakeUntil = field("presenceSettings", "keepAwakeUntil");
    const written = localTimeText("2026-03-01T06:30:00");
    expect(written).toBeDefined();
    expect(fieldText("presenceSettings", keepAwakeUntil, "2026-03-01T06:30:00")).toBe(written);
    expect(fieldText("presenceSettings", keepAwakeUntil, "2026-03-01T06:30:00", -300)).toBe(`${written} (${utcOffsetText(-300)})`);
  });

  it("writes a value that is no time, where its field holds one, as it is", () => {
    expect(fieldText("appSettings", field("appSettings", "nightModeSleepTime"), "soon", -240)).toBe("soon");
    expect(fieldText("presenceSettings", field("presenceSettings", "keepAwakeUntil"), null)).toBe("None");
  });

  it("writes a wake schedule's days by their names", () => {
    // Derived: a field of the protocol's with the kind a wake schedule's days have.
    const weekdays: SettingsField = { ...field("appSettings", "nightModeSleepTime"), kind: "weekdays" };
    expect(fieldText("presenceSettings", weekdays, [6, 7])).toBe("Sat, Sun");
    expect(fieldText("presenceSettings", weekdays, [])).toBe("Every day");
  });

  it("rounds a sensor's calibration to its field's step, as the machine seldom holds it on one", () => {
    // The test DE1Pro's pressure multiplier, and an edit to 1.29 as the machine holds it, in Q16.16 (#272).
    const pressure = field("sensorCalibration", "pressure");
    expect(fieldText("sensorCalibration", pressure, 1.293609619140625)).toBe("1.2936");
    expect(fieldText("sensorCalibration", pressure, 1.2899932861328125)).toBe("1.29");
    // The temperature offset's step is 0.01 °C.
    expect(fieldText("sensorCalibration", field("sensorCalibration", "temperature"), 0.4999847412109375)).toBe("0.5 °C");
  });

  it("rounds no other collection's numbers to a step", () => {
    expect(fieldText("machineCalibration", field("machineCalibration", "flowMultiplier"), 1.293609619140625)).toBe("1.29361");
  });
});

describe("reportedFields", () => {
  it("reads each sensor's calibration from its current read, and any other collection as it is reported", () => {
    expect(reportedFields("sensorCalibration", { pressure: { measuredValue: 1.29, rawValue: 4.2 }, flow: 1.1 })).toEqual({ pressure: 1.29, flow: 1.1 });
    const machineSettings = { fan: 45, usb: true };
    expect(reportedFields("machineSettings", machineSettings)).toBe(machineSettings);
  });
});
