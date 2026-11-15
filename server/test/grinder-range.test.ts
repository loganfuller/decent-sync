import { describe, expect, it } from "vitest";
import { grinderEdit, newGrinderProblem } from "../src/library/grinder-range.js";

// Module tests for ticket #551: the rules of a Grinder's range and defaults
// in the management interface and through the MCP endpoint, as DYE2 v0.1.40's
// Grinders page keeps them (fixtures/decaid/dye2-v0.1.40/grinder-form.json).

const REVERSED_SETTING = "The lowest setting cannot be above the highest";
const REVERSED_RPM = "The lowest RPM cannot be above the highest";
const NAMED = "A Grinder with named positions holds no range or default for its setting";

describe("A Grinder's range and defaults", () => {
  it("refuses a new Grinder whose lowest is above its highest, for the setting or the RPM, and takes one equal to it, a 0, a number below 0 and a default outside the range", () => {
    expect(newGrinderProblem({ model: "EG-1", settingType: "numeric", settingMin: 9, settingMax: 3 })).toBe(REVERSED_SETTING);
    expect(newGrinderProblem({ model: "EG-1", rpmMin: 1500, rpmMax: 1200 })).toBe(REVERSED_RPM);
    expect(newGrinderProblem({ model: "EG-1", settingMin: 0, settingMax: 0, rpmMin: 400, rpmMax: 400 })).toBeNull();
    expect(newGrinderProblem({ model: "EG-1", settingMin: -5, settingMax: 10, settingDefault: 40, rpmDefault: 100, rpmMin: 400 })).toBeNull();
    // One end alone is no range to reverse.
    expect(newGrinderProblem({ model: "EG-1", settingMin: 50, rpmMax: 0 })).toBeNull();
  });

  it("refuses a new Grinder with named positions any range or default of its setting, and takes its RPM's", () => {
    for (const field of ["settingMin", "settingMax", "settingDefault"]) expect(newGrinderProblem({ model: "EG-1", settingType: "preset", [field]: 0 }), field).toBe(NAMED);
    expect(newGrinderProblem({ model: "EG-1", settingType: "preset", settingValues: ["Fine"], rpmMin: 300, rpmMax: 1400, rpmDefault: 800 })).toBeNull();
  });

  it("judges an edit over what the Grinder holds", () => {
    const held = { model: "EG-1", settingType: "numeric", settingMin: 0, settingMax: 10, rpmMin: 400, rpmMax: 1200 };
    expect(grinderEdit(held, { settingMin: 12 })).toEqual({ problem: REVERSED_SETTING });
    expect(grinderEdit(held, { rpmMax: 300 })).toEqual({ problem: REVERSED_RPM });
    // Both ends moved together, and a highest cleared.
    expect(grinderEdit(held, { settingMin: 12, settingMax: 20 })).toEqual({ values: { settingMin: 12, settingMax: 20 } });
    expect(grinderEdit(held, { settingMin: 12, settingMax: null })).toEqual({ values: { settingMin: 12, settingMax: null } });
    expect(grinderEdit(held, { settingDefault: 40, notes: "Lab" })).toEqual({ values: { settingDefault: 40, notes: "Lab" } });
  });

  it("clears the setting's range and default the Grinder holds as an edit gives it named positions, and refuses one that sets any", () => {
    const held = { model: "EG-1", settingType: "numeric", settingMin: 0, settingDefault: 4, rpmMin: 400, rpmDefault: 900 };
    expect(grinderEdit(held, { settingType: "preset", settingValues: ["Fine", "Coarse"] })).toEqual({
      values: { settingType: "preset", settingValues: ["Fine", "Coarse"], settingMin: null, settingDefault: null },
    });
    expect(grinderEdit(held, { settingType: "preset", settingMax: 9 })).toEqual({ problem: NAMED });
    // One with named positions already: nothing to clear, a clear is taken, and a value refused.
    const named = { model: "EG-1", settingType: "preset", rpmMin: 400 };
    expect(grinderEdit(named, { notes: "Lab" })).toEqual({ values: { notes: "Lab" } });
    expect(grinderEdit(named, { settingMin: null })).toEqual({ values: { settingMin: null } });
    expect(grinderEdit(named, { settingDefault: 2 })).toEqual({ problem: NAMED });
    // Given a numbered dial again in the same edit, it may hold them.
    expect(grinderEdit(named, { settingType: "numeric", settingMin: 1, settingMax: 5 })).toEqual({ values: { settingType: "numeric", settingMin: 1, settingMax: 5 } });
  });

  it("takes an edit of something else over what tablets' edits merged to: a range with named positions is cleared, and a lowest above a highest is refused only once an end of it is edited", () => {
    const named = { model: "EG-1", settingType: "preset", settingMin: 1, settingMax: 9 };
    expect(grinderEdit(named, { notes: "Lab" })).toEqual({ values: { notes: "Lab", settingMin: null, settingMax: null } });
    const reversed = { model: "EG-1", settingType: "numeric", settingMin: 9, settingMax: 3, rpmMin: 400, rpmMax: 1200 };
    expect(grinderEdit(reversed, { notes: "Lab", rpmMin: 500 })).toEqual({ values: { notes: "Lab", rpmMin: 500 } });
    expect(grinderEdit(reversed, { settingMax: 5 })).toEqual({ problem: REVERSED_SETTING });
    expect(grinderEdit(reversed, { settingMax: 12 })).toEqual({ values: { settingMax: 12 } });
  });
});
