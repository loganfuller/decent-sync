import { describe, expect, it } from "vitest";
import {
  COLLECTION_NAMES,
  NOT_WRITTEN,
  SETTINGS_COLLECTION_NAMES,
  SETTINGS_FIELDS,
  decimalPlaces,
  isEditable,
  onStep,
  refusedByOtherDefinitions,
  settingsRefusalText,
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
    for (const [target, value] of [["flow", 0.75], ["pressure", 1.33], ["temperature", -10]] as const) {
      expect(validateSettingsEdit({ collection: "sensorCalibration", fields: { [target]: value } }, "admin")).toEqual([]);
    }
  });

  it("takes the flow multipliers in hundredths, finer than Streamline's ± buttons move them, and refuses thousandths", () => {
    expect(
      validateSettingsEdit({ collection: "appSettings", fields: { weightFlowMultiplier: 0.86, volumeFlowMultiplier: 0.33, hotWaterFlowMultiplier: 0.33 } }, "staff"),
    ).toEqual([]);
    expect(validateSettingsEdit({ collection: "appSettings", fields: { weightFlowMultiplier: 0, volumeFlowMultiplier: 1.07, hotWaterFlowMultiplier: 12 } }, "staff")).toEqual([]);
    expect(
      validateSettingsEdit({ collection: "appSettings", fields: { weightFlowMultiplier: 0.865, volumeFlowMultiplier: 0.335, hotWaterFlowMultiplier: 0.331 } }, "staff"),
    ).toEqual([
      { reason: "offStep", field: "weightFlowMultiplier" },
      { reason: "offStep", field: "volumeFlowMultiplier" },
      { reason: "offStep", field: "hotWaterFlowMultiplier" },
    ]);
    expect(settingsRefusalText("appSettings", { reason: "offStep", field: "weightFlowMultiplier" })).toBe("Weight flow multiplier must be a multiple of 0.01");
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
    expect(settingsRefusalText("appSettings", { reason: "invalid", field: "nightModeSleepTime" })).toBe("Night mode sleep time must be a time of day");
    expect(validateSettingsEdit({ collection: "machineSettings", fields: { fan: 42.9 } }, "staff")).toEqual([{ reason: "invalid", field: "fan" }]);
    expect(validateSettingsEdit({ collection: "machineCalibration", fields: { flowMultiplier: Number.NaN } }, "admin")).toEqual([
      { reason: "invalid", field: "flowMultiplier" },
    ]);
  });

  it("takes the presence settings' fields as Staff's, the sleep timeout from 1 to 120 min", () => {
    expect(validateSettingsEdit({ collection: "presenceSettings", fields: { userPresenceEnabled: false, sleepTimeoutMinutes: 1 } }, "staff")).toEqual([]);
    expect(validateSettingsEdit({ collection: "presenceSettings", fields: { sleepTimeoutMinutes: 120 } }, "staff")).toEqual([]);
    expect(validateSettingsEdit({ collection: "presenceSettings", fields: { sleepTimeoutMinutes: 0 } }, "staff")).toEqual([{ reason: "outOfRange", field: "sleepTimeoutMinutes" }]);
    expect(validateSettingsEdit({ collection: "presenceSettings", fields: { sleepTimeoutMinutes: 121 } }, "admin")).toEqual([{ reason: "outOfRange", field: "sleepTimeoutMinutes" }]);
    expect(validateSettingsEdit({ collection: "presenceSettings", fields: { keepAwakeUntil: null } }, "admin")).toEqual([{ reason: "readOnly", field: "keepAwakeUntil" }]);
  });

  it("refuses the wake schedules set as a field, as they are changed one at a time", () => {
    const refusals = validateSettingsEdit({ collection: "presenceSettings", fields: { schedules: [] } }, "staff");
    expect(refusals).toEqual([{ reason: "invalid", field: "schedules" }]);
    expect(settingsRefusalText("presenceSettings", refusals[0]!)).toBe("Wake schedules are added, changed and deleted one at a time");
  });

  describe("a wake schedule's edit", () => {
    const schedule = { time: "06:30", daysOfWeek: [1, 3, 5], enabled: true, keepAwakeFor: 120 };
    const edit = (action: "add" | "change" | "delete", fields: Record<string, unknown>) => ({
      collection: "presenceSettings",
      schedule: action === "add" ? { action } : { action, id: "a2c4e6f8" },
      fields,
    });

    it("takes Staff's add of every field, a change of some and a delete of none, a keep-awake time of none included", () => {
      expect(validateSettingsEdit(edit("add", schedule), "staff")).toEqual([]);
      expect(validateSettingsEdit(edit("add", { ...schedule, daysOfWeek: [], keepAwakeFor: null }), "staff")).toEqual([]);
      expect(validateSettingsEdit(edit("change", { enabled: false }), "staff")).toEqual([]);
      expect(validateSettingsEdit(edit("change", { time: "23:59", keepAwakeFor: 720 }), "staff")).toEqual([]);
      expect(validateSettingsEdit(edit("delete", {}), "staff")).toEqual([]);
    });

    it("refuses an add missing a field, a change of nothing and a delete that sets something", () => {
      const { keepAwakeFor: _, ...withoutKeepAwake } = schedule;
      expect(validateSettingsEdit(edit("add", withoutKeepAwake), "staff")).toEqual([{ reason: "incompleteSchedule" }]);
      expect(validateSettingsEdit(edit("change", {}), "staff")).toEqual([{ reason: "noFields" }]);
      expect(validateSettingsEdit(edit("delete", { enabled: false }), "staff")).toEqual([{ reason: "deleteSetsNothing" }]);
      expect(validateSettingsEdit({ ...edit("delete", {}), collection: "appSettings" }, "admin")).toEqual([{ reason: "notSchedules" }]);
    });

    it("refuses a time that is not HH:MM, days out of order, repeated or not 1 to 7, and a keep-awake time outside 1 to 720 min", () => {
      for (const time of ["6:30", "24:00", "06:60", "0630", 390]) {
        expect(validateSettingsEdit(edit("change", { time }), "staff")).toEqual([{ reason: "invalid", field: "time", schedule: true }]);
      }
      for (const daysOfWeek of [[0], [8], [3, 1], [1, 1], [1.5], "1", null]) {
        expect(validateSettingsEdit(edit("change", { daysOfWeek }), "staff")).toEqual([{ reason: "invalid", field: "daysOfWeek", schedule: true }]);
      }
      for (const keepAwakeFor of [0, 721]) {
        expect(validateSettingsEdit(edit("change", { keepAwakeFor }), "staff")).toEqual([{ reason: "outOfRange", field: "keepAwakeFor", schedule: true }]);
      }
      expect(validateSettingsEdit(edit("change", { keepAwakeFor: 30.5, enabled: null, id: "b" }), "staff")).toEqual([
        { reason: "invalid", field: "keepAwakeFor", schedule: true },
        { reason: "invalid", field: "enabled", schedule: true },
        { reason: "unknown", field: "id", schedule: true },
      ]);
    });

    it("names a schedule's field by its label in a refusal", () => {
      const text = (fields: Record<string, unknown>) => settingsRefusalText("presenceSettings", validateSettingsEdit(edit("change", fields), "staff")[0]!);
      expect(text({ time: "6:30" })).toBe("Time must be a time of day");
      expect(text({ daysOfWeek: [3, 1] })).toBe("Days must be days of the week, 1 (Monday) to 7 (Sunday), each once and in order");
      expect(text({ keepAwakeFor: 0 })).toBe("Keeps awake for must be from 1 to 720, or none");
      expect(text({ keepAwakeFor: "1" })).toBe("Keeps awake for must be a whole number, or none");
      expect(settingsRefusalText("presenceSettings", { reason: "incompleteSchedule" })).toMatch(/^Give a new wake schedule its time/);
    });
  });

  it("refuses an edit of no settings collection, or of nothing", () => {
    expect(validateSettingsEdit({ collection: "beans", fields: { name: "x" } }, "admin")).toEqual([{ reason: "unknownCollection" }]);
    expect(validateSettingsEdit({ collection: "machineSettings", fields: {} }, "admin")).toEqual([{ reason: "noFields" }]);
  });

  it("refuses an edit of more than one sensor's calibration", () => {
    expect(validateSettingsEdit({ collection: "sensorCalibration", fields: { flow: 1.05, pressure: 1.1 } }, "admin")).toEqual([{ reason: "severalTargets" }]);
  });
});

describe("onStep", () => {
  it("takes no more decimal places than its step has", () => {
    expect(onStep(2.5, 0.1)).toBe(true);
    expect(onStep(2.55, 0.1)).toBe(false);
    expect(onStep(1.0001, 0.0001)).toBe(true);
    expect(onStep(1.00002, 0.0001)).toBe(false);
  });

  it("takes only multiples of its step, negative ones too, checked in its least decimal place", () => {
    // 0.35 / 0.05 is 6.999999999999999 in floating point; 35 hundredths are seven steps.
    expect(0.35 / 0.05).not.toBe(7);
    expect(onStep(0.35, 0.05)).toBe(true);
    expect(onStep(0.33, 0.05)).toBe(false);
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
    expect(validateSettingsEdit({ collection: "appSettings", fields: { volumeFlowMultiplier: 90071992547410.11, hotWaterFlowMultiplier: 4398046511104.125 } }, "staff")).toEqual([
      { reason: "offStep", field: "hotWaterFlowMultiplier" },
    ]);
  });
});

describe("refusedByOtherDefinitions", () => {
  const edit = { collection: "appSettings", fields: { weightFlowMultiplier: 0.86 } };
  // As the plugin of 1.3.1 refused it, by its step of 0.1.
  const earlier = { reason: "decaid", status: null, message: `${NOT_WRITTEN}Weight flow multiplier must be a multiple of 0.1` };

  it("takes a plugin's refusal by its own definitions of an edit these allow as a plugin at another release's", () => {
    expect(refusedByOtherDefinitions(edit, earlier)).toBe(true);
    // A field its definitions lacked, among others.
    expect(refusedByOtherDefinitions({ collection: "appSettings", fields: { themeMode: "dark", weightFlowMultiplier: 0.86 } }, { ...earlier, message: `${NOT_WRITTEN}There is no setting named themeMode` })).toBe(true);
  });

  it("leaves a refusal these definitions make too, and any other refusal, as it is", () => {
    expect(refusedByOtherDefinitions({ ...edit, fields: { weightFlowMultiplier: 0.865 } }, { ...earlier, message: `${NOT_WRITTEN}Weight flow multiplier must be a multiple of 0.01` })).toBe(false);
    // Decaid's own refusals, and the plugin's of what it does not write or could not ask.
    expect(refusedByOtherDefinitions(edit, { ...earlier, status: 400 })).toBe(false);
    expect(refusedByOtherDefinitions(edit, { ...earlier, message: "Decaid did not answer: timed out" })).toBe(false);
    expect(refusedByOtherDefinitions(edit, { ...earlier, message: null })).toBe(false);
    expect(refusedByOtherDefinitions(edit, { reason: "changedSince" })).toBe(false);
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
