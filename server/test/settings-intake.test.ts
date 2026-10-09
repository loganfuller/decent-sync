import type { SharedSettings } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import type { FieldEdits } from "../src/library/merge.js";
import { settingsEdits, settingsToWrite } from "../src/library/settings-intake.js";

// Which of a tablet's reported steam, hot water and rinse settings are
// edits of its Location's, and what a tablet is to be written (ADR-0014).

const SETTINGS: SharedSettings = {
  "steamSettings.targetTemperature": 150,
  "steamSettings.duration": 45,
  "steamSettings.flow": 1.8,
  "steamSettings.stopAtTemperature": 65,
  "hotWaterData.targetTemperature": 80,
  "hotWaterData.duration": 40,
  "hotWaterData.volume": 150,
  "hotWaterData.flow": 8,
  "rinseData.targetTemperature": 92,
  "rinseData.duration": 8,
  "rinseData.flow": 5.5,
};

const EDIT = { at: "2026-10-09T10:00:00.000Z", decidedAt: "2026-10-09T10:00:00.000Z", tabletId: null, versionId: "v" };

/** Every setting edited already, as once a Machine set them. */
const ALL_SET: FieldEdits = Object.fromEntries(Object.keys(SETTINGS).map((field) => [field, EDIT]));

const steamOff = { ...SETTINGS, "steamSettings.targetTemperature": 0 };

describe("A tablet's reported settings", () => {
  it("set every setting a Location has not, as from the first Machine there", () => {
    expect(settingsEdits(null, SETTINGS, {})).toEqual(SETTINGS);
  });

  it("change nothing the Location has set when the tablet is new to them: the Location's are written to it", () => {
    expect(settingsEdits(null, { ...SETTINGS, "steamSettings.flow": 2.2 }, ALL_SET)).toEqual({});
  });

  it("are edits where they changed since the tablet last had them", () => {
    expect(settingsEdits(SETTINGS, { ...SETTINGS, "steamSettings.flow": 2.2, "rinseData.duration": 6 }, ALL_SET)).toEqual({
      "steamSettings.flow": 2.2,
      "rinseData.duration": 6,
    });
  });

  it("keep a Machine's steam off to itself, and its steam settings while off", () => {
    expect(settingsEdits(SETTINGS, steamOff, ALL_SET)).toEqual({});
    expect(settingsEdits(steamOff, { ...steamOff, "steamSettings.flow": 1, "hotWaterData.volume": 200 }, ALL_SET)).toEqual({ "hotWaterData.volume": 200 });
  });

  it("turning steam back on take the Location's steam settings rather than give the Machine's", () => {
    expect(settingsEdits(steamOff, { ...SETTINGS, "steamSettings.targetTemperature": 135 }, ALL_SET)).toEqual({});
  });

  it("from a Machine with steam off set no steam setting, but the rest", () => {
    const set = settingsEdits(null, steamOff, {});
    expect(Object.keys(set).some((field) => field.startsWith("steamSettings."))).toBe(false);
    expect(set["hotWaterData.volume"]).toBe(150);
    // Once a Machine with steam on reports, it sets them.
    const unsetSteam = Object.fromEntries(Object.entries(ALL_SET).filter(([field]) => !field.startsWith("steamSettings.")));
    expect(settingsEdits(steamOff, SETTINGS, unsetSteam)).toEqual({
      "steamSettings.targetTemperature": 150,
      "steamSettings.duration": 45,
      "steamSettings.flow": 1.8,
      "steamSettings.stopAtTemperature": 65,
    });
  });
});

describe("What a tablet is to be written", () => {
  it("is each setting the Location has that its Workflow holds otherwise, with what it holds", () => {
    expect(settingsToWrite({ ...SETTINGS, "steamSettings.flow": 2.2, "rinseData.flow": 4 }, SETTINGS)).toEqual({
      fields: { "steamSettings.flow": 2.2, "rinseData.flow": 4 },
      expected: { "steamSettings.flow": 1.8, "rinseData.flow": 5.5 },
    });
    expect(settingsToWrite(SETTINGS, SETTINGS)).toBeNull();
  });

  it("leaves out what the Location has not set", () => {
    expect(settingsToWrite({ "rinseData.flow": 4 }, SETTINGS)).toEqual({ fields: { "rinseData.flow": 4 }, expected: { "rinseData.flow": 5.5 } });
  });

  it("leaves out the steam settings of a Machine whose steam is off, so shared values never turn it on", () => {
    expect(settingsToWrite({ ...SETTINGS, "steamSettings.flow": 2.2, "hotWaterData.flow": 6 }, steamOff)).toEqual({
      fields: { "hotWaterData.flow": 6 },
      expected: { "hotWaterData.flow": 8 },
    });
  });
});
