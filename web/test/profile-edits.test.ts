import { PROFILE_LIMITS, type Profile, type ProfileStep } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { COALESCE_MS, canRedo, canUndo, recordChange, redo, startHistory, undo } from "../src/lib/edit-history";
import {
  addStep,
  deleteStep,
  duplicateStep,
  held,
  moveStep,
  movesOn,
  preinfusionEnd,
  relativeTo,
  withBrewTemperature,
  withMovesOn,
  withPreinfusionEnd,
  withPump,
  withRelativeTemperature,
} from "../src/lib/profile-edits";

// A Draft's edits in the editor (#579): its steps added, duplicated, deleted
// and moved with preinfusion kept on its step, a pump switched, temperatures
// relative to the first step's, and undo and redo through the session.

const step = (name: string, more: Partial<ProfileStep> = {}): ProfileStep =>
  ({ name, pump: "pressure", pressure: 6, transition: "fast", exit: null, volume: 0, seconds: 10, weight: null, temperature: 92, sensor: "coffee", limiter: null, ...more }) as ProfileStep;

/** Four steps, the first two preinfusion. */
const four: Profile = {
  version: "2",
  title: "Four",
  notes: "",
  author: "",
  beverage_type: "espresso",
  steps: [step("Fill", { pump: "flow", flow: 4 } as Partial<ProfileStep>), step("Soak"), step("Pour", { temperature: 90 }), step("Finish", { temperature: 88 })],
  target_volume: 0,
  target_weight: 36,
  target_volume_count_start: 2,
  tank_temperature: 0,
};

const names = (profile: Profile) => profile.steps.map((each) => each.name);
const endsAfter = (profile: Profile) => {
  const end = preinfusionEnd(profile);
  return end === null ? null : profile.steps[end]!.name;
};

describe("a Draft's steps", () => {
  it("are added after a step, and a step is duplicated after itself, keeping preinfusion on its step", () => {
    const added = addStep(four, 0);
    expect(names(added)).toEqual(["Fill", "New step", "Soak", "Pour", "Finish"]);
    expect(added.steps[1]).toMatchObject({ pump: "pressure", pressure: 6, seconds: 10, temperature: 92, exit: null, limiter: null });
    expect(endsAfter(added)).toBe("Soak");
    expect(endsAfter(addStep(four, 1))).toBe("Soak");
    expect(addStep(four, 1).target_volume_count_start).toBe(2);
    expect(names(addStep({ ...four, steps: [] }, -1))).toEqual(["New step"]);

    const copied = duplicateStep(four, 2);
    expect(names(copied)).toEqual(["Fill", "Soak", "Pour", "Pour", "Finish"]);
    expect(copied.steps[3]).toEqual(four.steps[2]);
    expect(copied.steps[3]).not.toBe(four.steps[2]);
    expect(endsAfter(duplicateStep(four, 0))).toBe("Soak");
    // A copy of the step preinfusion ends on comes after it, outside preinfusion.
    expect(duplicateStep(four, 1).target_volume_count_start).toBe(2);
  });

  it("are deleted, preinfusion then ending on the nearest step kept before the one it ended on, or nowhere", () => {
    expect(endsAfter(deleteStep(four, 0))).toBe("Soak");
    expect(deleteStep(four, 0).target_volume_count_start).toBe(1);
    expect(endsAfter(deleteStep(four, 1))).toBe("Fill");
    expect(endsAfter(deleteStep(four, 3))).toBe("Soak");
    expect(endsAfter(deleteStep(deleteStep(four, 1), 0))).toBeNull();
    expect(deleteStep(four, 9)).toBe(four);
  });

  it("are moved, preinfusion ending on the step it ended on, wherever it went", () => {
    const later = moveStep(four, 1, 3);
    expect(names(later)).toEqual(["Fill", "Pour", "Finish", "Soak"]);
    expect(endsAfter(later)).toBe("Soak");
    expect(later.target_volume_count_start).toBe(4);
    const earlier = moveStep(four, 3, 0);
    expect(names(earlier)).toEqual(["Finish", "Fill", "Soak", "Pour"]);
    expect(endsAfter(earlier)).toBe("Soak");
    expect(moveStep(four, 0, 4)).toBe(four);
    expect(withPreinfusionEnd(four, 2).target_volume_count_start).toBe(3);
    expect(withPreinfusionEnd(four, null).target_volume_count_start).toBe(0);
  });
});

describe("a step's pump and exit", () => {
  it("switch the pump to the other quantity, at a middling target, dropping a limit of the quantity it now controls", () => {
    const limited = step("Pour", { limiter: { value: 2.5, range: 0.6 } });
    expect(withPump(limited, "flow")).toEqual({ ...step("Pour"), pump: "flow", flow: 2, pressure: undefined, limiter: null });
    expect(withPump(limited, "flow")).not.toHaveProperty("pressure", 6);
    expect(withPump(limited, "pressure")).toBe(limited);
  });

  it("move on at the step's time, or at an exit of the quantity chosen, keeping its value where it watched the same", () => {
    const exits = step("Fill", { exit: { type: "pressure", condition: "over", value: 3 } });
    expect(movesOn(exits)).toBe("pressure-over");
    expect(withMovesOn(exits, "pressure-under", PROFILE_LIMITS).exit).toEqual({ type: "pressure", condition: "under", value: 3 });
    expect(withMovesOn(exits, "flow-over", PROFILE_LIMITS).exit).toEqual({ type: "flow", condition: "over", value: 2 });
    expect(withMovesOn(exits, "time", PROFILE_LIMITS).exit).toBeNull();
    expect(movesOn(step("Pour"))).toBe("time");
  });
});

describe("temperatures", () => {
  it("are given relative to the first step's, and moved together by the brew temperature", () => {
    expect([0, 1, 2, 3].map((index) => relativeTo(four, index))).toEqual([0, 0, -2, -4]);
    const cooler = withRelativeTemperature(four, 3, -6, PROFILE_LIMITS.temperature);
    expect(cooler.steps[3]!.temperature).toBe(86);
    const brewed = withBrewTemperature(four, 94, PROFILE_LIMITS.temperature);
    expect(brewed.steps.map((each) => each.temperature)).toEqual([94, 94, 92, 90]);
    expect(withBrewTemperature(four, 110, PROFILE_LIMITS.temperature).steps.map((each) => each.temperature)).toEqual([105, 105, 105, 105]);
    expect(held(12.345, { min: 0, max: 12 })).toBe(12);
    expect(held(3.14159, { min: 0, max: 12 })).toBe(3.1);
  });
});

describe("undo and redo", () => {
  it("undo each change and redo it, a change of one thing in quick succession being one, and a new change dropping what was undone", () => {
    let history = startHistory("a");
    expect(canUndo(history)).toBe(false);
    history = recordChange(history, "ab", "title", 0);
    history = recordChange(history, "abc", "title", COALESCE_MS - 1);
    history = recordChange(history, "abc!", "notes", COALESCE_MS);
    expect(history.past).toEqual(["a", "abc"]);
    history = undo(history);
    expect(history.present).toBe("abc");
    expect(canRedo(history)).toBe(true);
    history = undo(history);
    expect(history.present).toBe("a");
    expect(undo(history)).toBe(history);
    history = redo(history);
    expect(history.present).toBe("abc");
    // After an undo or redo, a change of the same thing is a step of its own.
    history = recordChange(history, "abcd", "title", COALESCE_MS + 1);
    expect(history.past).toEqual(["a", "abc"]);
    expect(canRedo(history)).toBe(false);
    expect(recordChange(history, "abcd", "title", COALESCE_MS + 2)).toBe(history);
    // The same thing changed again after a pause is another step.
    expect(recordChange(history, "abcde", "title", 3 * COALESCE_MS).past).toEqual(["a", "abc", "abcd"]);
  });
});
