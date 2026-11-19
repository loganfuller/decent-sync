import { describe, expect, it } from "vitest";
import { shotRecordParts, workflowFields, workflowParts } from "../src/components/workflow";

/** A step as Decaid writes one, at a temperature. */
function step(temperature: unknown): Record<string, unknown> {
  return { name: "pour", pump: "pressure", transition: "fast", exit: null, volume: 0, seconds: 30, weight: null, temperature, sensor: "coffee", pressure: 9, limiter: null };
}

function brewTemperature(profile: Record<string, unknown>): string | undefined {
  return new Map(workflowFields({ profile: { title: "Londonium", ...profile } })).get("Brew temperature");
}

describe("workflowFields", () => {
  it("gives the brew temperature from the profile's first step, right after Profile", () => {
    expect(workflowFields({ profile: { title: "Londonium", steps: [step(89), step(88.5)] }, context: { targetDoseWeight: 18 } })).toEqual([
      ["Profile", "Londonium"],
      ["Brew temperature", "89 °C"],
      ["Dose", "18 g"],
    ]);
  });

  it("rounds the brew temperature to two decimal places, as the other amounts", () => {
    expect(brewTemperature({ steps: [step(92.30000000000001)] })).toBe("92.3 °C");
    expect(brewTemperature({ steps: [step(91.456)] })).toBe("91.46 °C");
  });

  it("leaves it out without steps, with none, or with steps Decaid would not read, but keeps the title", () => {
    expect(brewTemperature({})).toBeUndefined();
    expect(brewTemperature({ steps: [] })).toBeUndefined();
    expect(brewTemperature({ steps: [{}] })).toBeUndefined();
    expect(brewTemperature({ steps: [{ temperature: 92 }] })).toBeUndefined();
    expect(brewTemperature({ steps: [step(null), step(88)] })).toBeUndefined();
    expect(brewTemperature({ steps: [null] })).toBeUndefined();
    // As Decaid reads a number written as text.
    expect(brewTemperature({ steps: [step("92")] })).toBe("92 °C");
    expect(workflowFields({ profile: { title: "Londonium", steps: [{}] } })).toEqual([["Profile", "Londonium"]]);
  });
});

describe("workflowParts", () => {
  it("reads each part a Workflow holds, the flush settings from Decaid's rinse data, and leaves out what it holds none of", () => {
    expect(
      workflowParts({
        profile: { title: "Londonium", steps: [step(89)] },
        context: { targetDoseWeight: 18, targetYield: 36, coffeeName: "Guji", coffeeRoaster: "Roux", grinderModel: "DF64 v2", grinderBurrs: "SSP MP", grinderSetting: "7.5", baristaName: "Ann" },
        steamSettings: { targetTemperature: 160, duration: 120, flow: 2.500000000000001 },
        hotWaterData: { targetTemperature: 65, volume: 100 },
        rinseData: { targetTemperature: 90, duration: 5 },
      }),
    ).toEqual({
      profile: "Londonium",
      brewTemperature: "89 °C",
      dose: "18 g",
      yield: "36 g",
      bean: "Guji",
      roaster: "Roux",
      grinder: "DF64 v2",
      burrs: "SSP MP",
      grindSetting: "7.5",
      barista: "Ann",
      steam: "160 °C, 120 s, 2.5 ml/s",
      hotWater: "65 °C, 100 ml",
      flush: "90 °C, 5 s",
    });
    expect(Object.values(workflowParts({})).filter((part) => part !== undefined)).toEqual([]);
  });

  it("is what a Machine's page lists, the flush settings under Decaid's name for them", () => {
    expect(workflowFields({ rinseData: { targetTemperature: 90, duration: 5 }, steamSettings: { duration: 30 } })).toEqual([
      ["Steam", "30 s"],
      ["Rinse", "90 °C, 5 s"],
    ]);
  });
});

describe("shotRecordParts", () => {
  it("gives the machine as the Shot recorded it in one line, without how Decaid knew it", () => {
    const machine = { provenanceStatus: "captured", flowCalibration: 1.1, serialNumber: "10021", model: "DE1Pro", firmwareVersion: "1333" };
    expect(shotRecordParts({ workflow: { machine } }).machine).toBe("DE1Pro, serial 10021, firmware 1333, flow calibration 1.1");
    expect(shotRecordParts({ workflow: { machine: { model: "Bengle", serialNumber: "10029" } } }).machine).toBe("Bengle, serial 10029");
  });

  it("gives none for a Shot that recorded no machine hardware", () => {
    expect(shotRecordParts({ workflow: { machine: { provenanceStatus: "unavailable" } } }).machine).toBeUndefined();
    expect(shotRecordParts({ workflow: {} }).machine).toBeUndefined();
    expect(shotRecordParts({})).toEqual({ drinker: undefined, tools: undefined, machine: undefined });
  });

  it("names who it was for, and its Tools once each, those DYE2's Edit Shot page set before the Workflow's", () => {
    const shot = {
      workflow: { context: { drinkerName: "Cat", extras: { equipmentNames: ["WDT", "Puck screen"] } } },
      annotations: { extras: { equipmentName: "Puck screen" } },
    };
    expect(shotRecordParts(shot)).toMatchObject({ drinker: "Cat", tools: "Puck screen, WDT" });
    expect(shotRecordParts({ workflow: { context: { extras: { equipmentNames: ["", 3] } } } }).tools).toBeUndefined();
  });
});
