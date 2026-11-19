import { type Profile, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import type { ProfileVersion } from "../src/lib/api";
import { differences, profileFacts, relativeTemperature, stepAction, stepMovesOn, stepSimulated } from "../src/lib/profile-words";
import { earlierVersions, versionNames } from "../src/lib/profile-versions";

// A Profile's steps in the Profile page's words (#578), and its versions' names.

const soak: Profile = {
  version: "2",
  title: "Soak",
  notes: "",
  author: "",
  beverage_type: "espresso",
  steps: [
    { name: "Fill", pump: "flow", flow: 8, transition: "fast", exit: { type: "pressure", condition: "over", value: 4 }, volume: 0, seconds: 15, weight: null, temperature: 92, sensor: "coffee", limiter: null },
    { name: "", pump: "flow", flow: 0, transition: "fast", exit: { type: "pressure", condition: "under", value: 1 }, volume: 0, seconds: 0, weight: null, temperature: 92, sensor: "coffee", limiter: null },
    { name: "Pour", pump: "pressure", pressure: 9, transition: "smooth", exit: null, volume: 100, seconds: 40, weight: 30, temperature: 72, sensor: "water", limiter: { value: 2.5, range: 1 } },
  ],
  target_volume: null,
  target_weight: 0,
  target_volume_count_start: 1,
  tank_temperature: 40,
};

describe("a Profile's steps in words", () => {
  it("says what the Machine does, its limit and its temperature against the first step's", () => {
    expect(stepAction(soak, 0)).toBe("Pumps 8 ml/s at once");
    expect(stepAction(soak, 1)).toBe("Stops the pump");
    expect(stepAction(soak, 2)).toBe("Ramps to 9 bar over the step, flow limited to 2.5 ml/s, 20 °C cooler");
    expect(relativeTemperature(soak, 0)).toBeNull();
  });

  it("says when each step moves on, a step of no length at once whatever its exit", () => {
    expect(stepMovesOn(soak.steps[0]!)).toBe("Over 4 bar, or after 15 s");
    expect(stepMovesOn(soak.steps[1]!)).toBe("At once");
    expect(stepMovesOn(soak.steps[2]!)).toBe("30 g in the cup, 100 ml pumped, or after 40 s");
  });

  it("says what the simulation did with each step", () => {
    const run = simulateProfile({ profile: soak, puck: standardPuck(0), dose: 18, stopAt: 36 });
    expect(stepSimulated(soak, run, 0)).toMatch(/^\d+\.\d s, pressure passed 4 bar$/);
    expect(stepSimulated(soak, run, 1)).toBe("Passed through at once");
    expect(stepSimulated(soak, run, 2)).toMatch(/^\d+\.\d s, (30 g reached the cup|pumped its 100 ml)$/);
  });

  it("states the figures a Recipe replaces once, with what replaces them", () => {
    expect(profileFacts(soak)).toEqual([
      { term: "Brew temperature", text: "92 °C, unless a Recipe sets its own" },
      { term: "Stops at", text: "When its last step ends, unless a Recipe sets a yield" },
      { term: "Preinfusion", text: "Ends after Fill" },
      { term: "Water tank", text: "Preheated to 40 °C" },
    ]);
  });
});

describe("a Profile's versions", () => {
  const version = (id: string, savedAt: string, parentId: string | null, bundled = false): ProfileVersion => ({
    id,
    title: `Title ${id}`,
    bundled,
    archived: false,
    parentId,
    savedAt,
    savedBy: null,
    shownAt: [],
    shots: 0,
  });
  const chain = [version("c", "2026-11-03T00:00:00Z", "a"), version("b", "2026-11-02T00:00:00Z", "a"), version("a", "2026-11-01T00:00:00Z", "root"), version("root", "2020-01-01T00:00:00Z", null, true)];

  it("numbers them in the order they were saved, a bundled Profile by its title", () => {
    expect(versionNames(chain)).toEqual(new Map([["a", "Version 1"], ["b", "Version 2"], ["c", "Version 3"], ["root", "Title root"]]));
    expect(versionNames([version("only", "2026-11-01T00:00:00Z", null)])).toEqual(new Map([["only", "Title only"]]));
  });

  it("follows a version back to the first, not into another branch, nor into the bundled Profile the first was saved from", () => {
    expect(earlierVersions(chain, "c").map((each) => each.id)).toEqual(["a"]);
    expect(earlierVersions(chain, "root")).toEqual([]);
  });
});

describe("differences", () => {
  it("names a limit's easing that changed, which the step's words leave out", () => {
    const eased: Profile = { ...soak, steps: soak.steps.map((step, index) => (index === 2 ? { ...step, limiter: { value: 2.5, range: 0 } } : step)) };
    expect(differences(soak, eased)).toEqual([["Pour eases its limit", "Over 1 ml/s", "Over 0 ml/s"]]);
    expect(differences(soak, soak)).toEqual([]);
  });

  it("names a changed sensor and target volume, which give a new Profile though the words leave them out", () => {
    const changed: Profile = { ...soak, target_volume: 36, steps: soak.steps.map((step, index) => (index === 2 ? { ...step, sensor: "coffee" } : step)) };
    expect(differences(soak, changed)).toEqual([
      ["Pour measures its temperature", "At the water", "At the coffee"],
      ["Target volume", "None", "36 ml"],
    ]);
  });
});
