import { describe, expect, it } from "vitest";
import {
  COLLECTION_NAMES,
  SETTINGS_COLLECTION_NAMES,
  SETTINGS_FIELDS,
  decimalPlaces,
  isEditable,
  onStep,
  validateSettingsEdit,
} from "../src/index.js";

describe("validateSettingsEdit", () => {
  it("accepts Staff's in-range edit of Staff's fields", () => {
    expect(validateSettingsEdit({ collection: "machineSettings", fields: { fan: 45, steamPurgeMode: 1 } }, "staff")).toEqual([]);
    expect(
      validateSettingsEdit(
        { collection: "appSettings", fields: { chargingMode: "balanced", nightModeEnabled: true, nightModeSleepTime: 1380, volumeFlowMultiplier: 0.35 } },
        "staff",
      ),
    ).toEqual([]);
  });

  it("accepts an Admin's edit of an Admin's field", () => {
    expect(validateSettingsEdit({ collection: "advancedSettings", fields: { heaterPh1Flow: 2.5, heaterVoltage: 230 } }, "admin")).toEqual([]);
    expect(validateSettingsEdit({ collection: "sensorCalibration", fields: { temperature: -0.5 } }, "admin")).toEqual([]);
  });

  it("refuses an unknown field", () => {
    expect(validateSettingsEdit({ collection: "machineSettings", fields: { fan: 45, fanSpeed: 3 } }, "admin")).toEqual([{ reason: "unknown", field: "fanSpeed" }]);
    // A collection's fields are its own: the fan threshold is no Tablet Setting.
    expect(validateSettingsEdit({ collection: "appSettings", fields: { fan: 45 } }, "admin")).toEqual([{ reason: "unknown", field: "fan" }]);
  });

  it("refuses a read-only field, for an Admin too", () => {
    expect(validateSettingsEdit({ collection: "machineSettings", fields: { steamFlow: 1.5, usb: true } }, "admin")).toEqual([
      { reason: "readOnly", field: "steamFlow" },
      { reason: "readOnly", field: "usb" },
    ]);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { defaultSkinId: "streamline.js" } }, "admin")).toEqual([
      { reason: "readOnly", field: "defaultSkinId" },
    ]);
  });

  it("refuses a value out of range", () => {
    expect(validateSettingsEdit({ collection: "machineSettings", fields: { fan: 51 } }, "staff")).toEqual([{ reason: "outOfRange", field: "fan" }]);
    expect(validateSettingsEdit({ collection: "machineCalibration", fields: { flowMultiplier: 0.129 } }, "admin")).toEqual([
      { reason: "outOfRange", field: "flowMultiplier" },
    ]);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { nightModeMorningTime: 1440, weightFlowMultiplier: -0.1 } }, "staff")).toEqual([
      { reason: "outOfRange", field: "nightModeMorningTime" },
      { reason: "outOfRange", field: "weightFlowMultiplier" },
    ]);
    // The ends of a range are in it.
    expect(validateSettingsEdit({ collection: "machineCalibration", fields: { flowMultiplier: 2 } }, "admin")).toEqual([]);
    expect(validateSettingsEdit({ collection: "sensorCalibration", fields: { flow: 0.75, pressure: 1.33, temperature: -10 } }, "admin")).toEqual([]);
  });

  it("refuses a value off a 0.05 step, checked in hundredths", () => {
    // 0.35 / 0.05 is 6.999999999999999 in floating point; 35 hundredths are seven steps.
    expect(0.35 / 0.05).not.toBe(7);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { volumeFlowMultiplier: 0.35, hotWaterFlowMultiplier: 0.3 } }, "staff")).toEqual([]);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { volumeFlowMultiplier: 0.33, hotWaterFlowMultiplier: 0.355 } }, "staff")).toEqual([
      { reason: "offStep", field: "volumeFlowMultiplier" },
      { reason: "offStep", field: "hotWaterFlowMultiplier" },
    ]);
  });

  it("refuses a flow multiplier off its thousandths", () => {
    expect(validateSettingsEdit({ collection: "machineCalibration", fields: { flowMultiplier: 1.023 } }, "admin")).toEqual([]);
    expect(validateSettingsEdit({ collection: "machineCalibration", fields: { flowMultiplier: 1.0235 } }, "admin")).toEqual([
      { reason: "offStep", field: "flowMultiplier" },
    ]);
  });

  it("refuses a choice not offered", () => {
    // Decaid writes -1 for a heater voltage outside its two ranges.
    expect(validateSettingsEdit({ collection: "advancedSettings", fields: { heaterVoltage: 200 } }, "admin")).toEqual([
      { reason: "notOffered", field: "heaterVoltage" },
    ]);
    expect(validateSettingsEdit({ collection: "advancedSettings", fields: { refillKitSetting: "2" } }, "admin")).toEqual([
      { reason: "notOffered", field: "refillKitSetting" },
    ]);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { themeMode: "sepia" } }, "staff")).toEqual([{ reason: "notOffered", field: "themeMode" }]);
  });

  it("refuses Staff changing an Admin's field, before judging its value", () => {
    expect(validateSettingsEdit({ collection: "advancedSettings", fields: { heaterPh1Flow: 2.5 } }, "staff")).toEqual([{ reason: "notAllowed", field: "heaterPh1Flow" }]);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { gatewayMode: "full", themeMode: "dark" } }, "staff")).toEqual([
      { reason: "notAllowed", field: "gatewayMode" },
    ]);
    expect(validateSettingsEdit({ collection: "machineCalibration", fields: { flowMultiplier: 99 } }, "staff")).toEqual([
      { reason: "notAllowed", field: "flowMultiplier" },
    ]);
  });

  it("refuses a value not of its field's kind", () => {
    expect(
      validateSettingsEdit({ collection: "appSettings", fields: { blockOnNoScale: "yes", weightFlowMultiplier: "1", nightModeSleepTime: 600.5 } }, "staff"),
    ).toEqual([
      { reason: "invalid", field: "blockOnNoScale" },
      { reason: "invalid", field: "weightFlowMultiplier" },
      { reason: "invalid", field: "nightModeSleepTime" },
    ]);
    expect(validateSettingsEdit({ collection: "machineSettings", fields: { fan: 42.9 } }, "staff")).toEqual([{ reason: "invalid", field: "fan" }]);
    expect(validateSettingsEdit({ collection: "machineCalibration", fields: { flowMultiplier: Number.NaN } }, "admin")).toEqual([
      { reason: "invalid", field: "flowMultiplier" },
    ]);
  });

  it("refuses an edit of no settings collection, or of nothing", () => {
    expect(validateSettingsEdit({ collection: "beans", fields: { name: "x" } }, "admin")).toEqual([{ reason: "unknownCollection" }]);
    expect(validateSettingsEdit({ collection: "machineSettings", fields: {} }, "admin")).toEqual([{ reason: "noFields" }]);
  });
});

describe("onStep", () => {
  it("takes no more decimal places than its step has", () => {
    expect(onStep(2.5, 0.1)).toBe(true);
    expect(onStep(2.55, 0.1)).toBe(false);
    expect(onStep(1.0001, 0.0001)).toBe(true);
    expect(onStep(1.00002, 0.0001)).toBe(false);
  });

  it("takes only multiples of its step, negative ones too", () => {
    expect(onStep(-0.15, 0.05)).toBe(true);
    expect(onStep(-0.12, 0.05)).toBe(false);
    expect(onStep(0, 0.05)).toBe(true);
    expect(onStep(12, 0.05)).toBe(true);
  });

  it("stays exact for values too large to scale in floating point", () => {
    // 90071992547410.11 * 100 rounds to a multiple of 5, yet 11 hundredths are no multiple of 0.05.
    expect(Math.round(90071992547410.11 * 100) % 5).toBe(0);
    expect(onStep(90071992547410.11, 0.05)).toBe(false);
    expect(onStep(90071992547410.1, 0.05)).toBe(true);
    // Written in exponent notation, and a multiple of every step.
    expect(onStep(1e21, 0.05)).toBe(true);
    expect(onStep(1e21, 0.001)).toBe(true);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { volumeFlowMultiplier: 90071992547410.11 } }, "staff")).toEqual([
      { reason: "offStep", field: "volumeFlowMultiplier" },
    ]);
  });
});

describe("decimalPlaces", () => {
  it("counts the places JavaScript writes, in exponent notation too", () => {
    expect(decimalPlaces(3)).toBe(0);
    expect(decimalPlaces(0.05)).toBe(2);
    expect(decimalPlaces(-1.023)).toBe(3);
    expect(decimalPlaces(1.5e-7)).toBe(8);
    expect(decimalPlaces(1e21)).toBe(0);
  });
});

describe("SETTINGS_FIELDS", () => {
  it("defines only reported collections, each field once, with what an edit needs", () => {
    for (const collection of SETTINGS_COLLECTION_NAMES) {
      expect(COLLECTION_NAMES).toContain(collection);
      const paths = SETTINGS_FIELDS[collection].map((field) => field.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const field of SETTINGS_FIELDS[collection]) {
        if (!isEditable(field)) continue;
        if (field.kind === "choice") expect(field.choices?.length).toBeGreaterThan(0);
        if (field.kind === "number") expect(field.step).toBeGreaterThan(0);
        if (field.min !== undefined && field.max !== undefined) expect(field.min).toBeLessThan(field.max);
      }
    }
  });
});
