import { describe, expect, it } from "vitest";
import { workflowFields } from "../src/components/workflow";

function brewTemperature(profile: Record<string, unknown>): string | undefined {
  return new Map(workflowFields({ profile: { title: "Londonium", ...profile } })).get("Brew temperature");
}

describe("workflowFields", () => {
  it("gives the brew temperature from the profile's first step, right after Profile", () => {
    expect(workflowFields({ profile: { title: "Londonium", steps: [{ temperature: 89 }, { temperature: 88.5 }] }, context: { targetDoseWeight: 18 } })).toEqual([
      ["Profile", "Londonium"],
      ["Brew temperature", "89 °C"],
      ["Dose", "18 g"],
    ]);
  });

  it("rounds the brew temperature to two decimal places, as the other amounts", () => {
    expect(brewTemperature({ steps: [{ temperature: 92.30000000000001 }] })).toBe("92.3 °C");
    expect(brewTemperature({ steps: [{ temperature: 91.456 }] })).toBe("91.46 °C");
  });

  it("leaves it out without steps, with none, or without a first step's numeric temperature", () => {
    expect(brewTemperature({})).toBeUndefined();
    expect(brewTemperature({ steps: [] })).toBeUndefined();
    expect(brewTemperature({ steps: [{}] })).toBeUndefined();
    expect(brewTemperature({ steps: [{ temperature: "92" }] })).toBeUndefined();
    expect(brewTemperature({ steps: [{ temperature: null }, { temperature: 88 }] })).toBeUndefined();
    expect(brewTemperature({ steps: [null] })).toBeUndefined();
    expect(brewTemperature({ steps: { 0: { temperature: 92 } } })).toBeUndefined();
    expect(workflowFields({ profile: { title: "Londonium", steps: [{}] } })).toEqual([["Profile", "Londonium"]]);
  });
});
