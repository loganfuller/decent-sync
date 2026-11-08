import { describe, expect, it } from "vitest";
import { type RecipeEvent, type TrailChange, type TrailEntry, type TrailRecipe, dialInTrail } from "../src/machine-events/dial-in-trail.js";
import type { WorkflowSummary } from "../src/machine-events/workflow-summary.js";

// A Machine's dial-in trail (#436), through the pure function the
// get_machine_activity tool's Workflow changes are made by: how a Recipe's
// load and unload fold in the changes that made them, how changes of one
// cause merge, and what is dropped. Seam 1 runs it through the tool on a
// simulated tablet (assistant-machines.test.ts).

/** 06:00:00 UTC on 8 November 2026, as each test's moment 0. */
const T0 = Date.UTC(2026, 10, 8, 6);
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const iso = (seconds: number) => at(seconds).toISOString();

const ETHIOPIA: TrailRecipe = { id: "0199a000-0000-7000-8000-000000000001", name: "Ethiopia" };
const BRAZIL: TrailRecipe = { id: "0199a000-0000-7000-8000-000000000002", name: "Brazil" };

const SUMMARY: WorkflowSummary = {
  profile: "Adaptive v3",
  profileId: "profile:98fa00c191551b435845",
  brewTemperature: 92,
  dose: 18,
  yield: 36,
  bean: "Ethiopia Guji",
  roaster: "Roux",
  beanBatchId: null,
  grinder: "EG-1",
  burrs: null,
  grindSetting: "8.8",
  grinderId: null,
  basket: "18 g",
  basketId: null,
  recipe: null,
  recipeId: null,
  barista: null,
  steam: { temperature: 150, duration: 30, flow: 1.5 },
  hotWater: { temperature: 85, volume: 120 },
  flush: { temperature: 90, duration: 5 },
};

type Cause = Pick<TrailChange, "cause" | "pluginWrite">;
const OTHER: Cause = { cause: "other", pluginWrite: null };
const UNKNOWN: Cause = { cause: "unknown", pluginWrite: null };
const plugin = (pluginWrite: NonNullable<TrailChange["pluginWrite"]>): Cause => ({ cause: "plugin", pluginWrite });

/** Changes made in turn, each with the summary as the one before it left it, with its own changes. */
function changes(...made: [seconds: number, cause: Cause, changed: Partial<WorkflowSummary>][]): TrailChange[] {
  let summary = SUMMARY;
  return made.map(([seconds, cause, changed], n) => {
    summary = { ...summary, ...changed };
    return { id: BigInt(n + 2), observedAt: at(seconds), ...cause, summary };
  });
}

const baseline = (summary = SUMMARY, cause: Cause = OTHER): TrailChange => ({ id: 1n, observedAt: at(-3600), ...cause, summary });

const loads = (...events: [kind: RecipeEvent["kind"], seconds: number, recipe: TrailRecipe, id?: number][]): RecipeEvent[] =>
  events.map(([kind, seconds, recipe, id = 1]) => ({ kind, at: at(seconds), recipe, id: BigInt(id) }));

/** The trail's entries but its first, the Workflow in effect, each as its kind, time and changes. */
function shown(trail: TrailEntry[]) {
  return trail.slice(1).map(({ kind, observedAt, lastObservedAt, cause, pluginWrite, loadedRecipe, changes }) => ({
    kind,
    observedAt,
    lastObservedAt,
    cause: cause === "plugin" ? `plugin:${pluginWrite}` : cause,
    loadedRecipe: loadedRecipe?.name ?? null,
    changes: Object.fromEntries(changes.map(({ field, before, after }) => [field, [before, after]])),
  }));
}

describe("dialInTrail", () => {
  it("gives the Workflow in effect first, whole, with the Loaded Recipe then, and nothing else for a range with no change", () => {
    const trail = dialInTrail({ baseline: baseline(), changes: [], recipeEvents: [], loadedAtStart: ETHIOPIA });
    expect(trail).toEqual([
      {
        kind: "inEffect",
        observedAt: iso(-3600),
        lastObservedAt: null,
        cause: "other",
        pluginWrite: null,
        loadedRecipe: ETHIOPIA,
        replaced: null,
        workflow: SUMMARY,
        changes: [],
      },
    ]);
  });

  it("folds a Streamline strip's load and the plugin's load write 2 s later into one load entry, a barista's change between them apart", () => {
    const made = changes(
      [0, OTHER, { recipe: "Ethiopia", recipeId: ETHIOPIA.id, grindSetting: "8.6" }],
      [1, OTHER, { dose: 18.5 }],
      [2, plugin("load"), { steam: { temperature: 150, duration: 25, flow: 1.5 } }],
    );
    const trail = dialInTrail({ baseline: baseline(), changes: made, recipeEvents: loads(["loaded", 0, ETHIOPIA]), loadedAtStart: null });
    expect(shown(trail)).toEqual([
      {
        kind: "loaded",
        observedAt: iso(0),
        lastObservedAt: iso(2),
        cause: "other",
        loadedRecipe: "Ethiopia",
        changes: { recipe: [null, "Ethiopia"], recipeId: [null, ETHIOPIA.id], grindSetting: ["8.8", "8.6"], "steam.duration": [30, 25] },
      },
      { kind: "changed", observedAt: iso(1), lastObservedAt: null, cause: "other", loadedRecipe: "Ethiopia", changes: { dose: [18, 18.5] } },
    ]);
    // A load write more than 5 s after the load is a change of its own.
    const late = changes([0, OTHER, { recipeId: ETHIOPIA.id }], [6, plugin("load"), { dose: 19 }]);
    expect(shown(dialInTrail({ baseline: baseline(), changes: late, recipeEvents: loads(["loaded", 0, ETHIOPIA]), loadedAtStart: null })).map((entry) => entry.kind)).toEqual([
      "loaded",
      "changed",
    ]);
  });

  it("folds the change that unloaded a Recipe, and those of its cause within 5 s after it, into one unload entry, as a profile switch on Streamline followed by its saved steam time", () => {
    const made = changes(
      [0, OTHER, { profile: "Classic Italian", profileId: "profile:classic", recipeId: null }],
      [3, OTHER, { steam: { temperature: 150, duration: 20, flow: 1.5 } }],
      [4, plugin("steamOn"), { steam: { temperature: 155, duration: 20, flow: 1.5 } }],
      [7, OTHER, { dose: 17 }],
    );
    const trail = dialInTrail({ baseline: baseline({ ...SUMMARY, recipeId: ETHIOPIA.id }), changes: made, recipeEvents: loads(["unloaded", 0, ETHIOPIA]), loadedAtStart: ETHIOPIA });
    expect(shown(trail)).toEqual([
      {
        kind: "unloaded",
        observedAt: iso(0),
        lastObservedAt: iso(3),
        cause: "other",
        loadedRecipe: "Ethiopia",
        changes: { profile: ["Adaptive v3", "Classic Italian"], profileId: ["profile:98fa00c191551b435845", "profile:classic"], recipeId: [ETHIOPIA.id, null], "steam.duration": [30, 20] },
      },
      // Another cause, so apart; and the barista's change at 7 s, past the unload's 5 s, apart from it, with no Recipe loaded.
      { kind: "changed", observedAt: iso(4), lastObservedAt: null, cause: "plugin:steamOn", loadedRecipe: null, changes: { "steam.temperature": [150, 155] } },
      { kind: "changed", observedAt: iso(7), lastObservedAt: null, cause: "other", loadedRecipe: null, changes: { dose: [18, 17] } },
    ]);
  });

  it("gives a Recipe loaded as another unloads as one load entry naming the one it replaced", () => {
    const made = changes([10, OTHER, { recipe: "Brazil", recipeId: BRAZIL.id, dose: 20 }], [11, plugin("load"), { yield: 40 }]);
    const recipeEvents = loads(["unloaded", 10, ETHIOPIA, 1], ["loaded", 10, BRAZIL, 2]);
    const trail = dialInTrail({ baseline: baseline({ ...SUMMARY, recipe: "Ethiopia", recipeId: ETHIOPIA.id }), changes: made, recipeEvents, loadedAtStart: ETHIOPIA });
    expect(trail).toHaveLength(2);
    expect(trail[1]).toMatchObject({ kind: "loaded", observedAt: iso(10), lastObservedAt: iso(11), loadedRecipe: BRAZIL, replaced: ETHIOPIA, workflow: null });
    expect(shown(trail)[0]!.changes).toEqual({ dose: [18, 20], yield: [36, 40], recipe: ["Ethiopia", "Brazil"], recipeId: [ETHIOPIA.id, BRAZIL.id] });
  });

  it("merges a barista's changes of one cause within 5 s of each other, old to new, a group spanning at most 30 s, and changes back left out", () => {
    // A grind dialled from 8.8 to 8.5 a step at a time, 4 s apart, and the dose changed and changed back.
    const made = changes(
      [100, OTHER, { grindSetting: "8.7", dose: 18.2 }],
      [104, OTHER, { grindSetting: "8.6" }],
      [108, OTHER, { grindSetting: "8.5", dose: 18 }],
    );
    expect(shown(dialInTrail({ baseline: baseline(), changes: made, recipeEvents: [], loadedAtStart: ETHIOPIA }))).toEqual([
      { kind: "changed", observedAt: iso(100), lastObservedAt: iso(108), cause: "other", loadedRecipe: "Ethiopia", changes: { grindSetting: ["8.8", "8.5"] } },
    ]);
    // Ten changes 4 s apart: the first 30 s are one entry, from 0 to 28 s, and the rest another.
    const steady = changes(...Array.from({ length: 10 }, (_, n): [number, Cause, Partial<WorkflowSummary>] => [n * 4, OTHER, { dose: 18 + (n + 1) / 10 }]));
    const groups = shown(dialInTrail({ baseline: baseline(), changes: steady, recipeEvents: [], loadedAtStart: null }));
    expect(groups.map(({ observedAt, lastObservedAt, changes }) => [observedAt, lastObservedAt, changes.dose])).toEqual([
      [iso(0), iso(28), [18, 18 + 8 / 10]],
      [iso(32), iso(36), [18 + 8 / 10, 18 + 10 / 10]],
    ]);
    // More than 5 s apart, or of another cause, or another of the plugin's writes, apart.
    const apart = changes([0, OTHER, { dose: 19 }], [6, OTHER, { dose: 20 }], [7, UNKNOWN, { dose: 21 }], [8, plugin("loadedRecipe"), { dose: 22 }], [9, plugin("steamOn"), { dose: 23 }]);
    expect(shown(dialInTrail({ baseline: baseline(), changes: apart, recipeEvents: [], loadedAtStart: null })).map((entry) => entry.cause)).toEqual([
      "other",
      "other",
      "unknown",
      "plugin:loadedRecipe",
      "plugin:steamOn",
    ]);
  });

  it("merges changes stored before who made them was recorded by the 5 s window alone, as of one cause", () => {
    const made = changes([0, UNKNOWN, { dose: 19 }], [2, UNKNOWN, { grindSetting: "9" }], [9, UNKNOWN, { dose: 20 }]);
    expect(shown(dialInTrail({ baseline: baseline(baseline().summary, UNKNOWN), changes: made, recipeEvents: [], loadedAtStart: null }))).toEqual([
      { kind: "changed", observedAt: iso(0), lastObservedAt: iso(2), cause: "unknown", loadedRecipe: null, changes: { dose: [18, 19], grindSetting: ["8.8", "9"] } },
      { kind: "changed", observedAt: iso(9), lastObservedAt: null, cause: "unknown", loadedRecipe: null, changes: { dose: [19, 20] } },
    ]);
    // A strip's load and the plugin's load write 2 s later, both stored before #434: one entry; a barista's change since, apart.
    const loading = changes([20, UNKNOWN, { recipeId: BRAZIL.id }], [22, UNKNOWN, { steam: { temperature: 150, duration: 25, flow: 1.5 } }], [23, OTHER, { dose: 19 }]);
    expect(shown(dialInTrail({ baseline: baseline(), changes: loading, recipeEvents: loads(["loaded", 20, BRAZIL]), loadedAtStart: null }))).toEqual([
      { kind: "loaded", observedAt: iso(20), lastObservedAt: iso(22), cause: "unknown", loadedRecipe: "Brazil", changes: { recipeId: [null, BRAZIL.id], "steam.duration": [30, 25] } },
      { kind: "changed", observedAt: iso(23), lastObservedAt: null, cause: "other", loadedRecipe: "Brazil", changes: { dose: [18, 19] } },
    ]);
  });

  it("gives the plugin's write of an edit of the Loaded Recipe made elsewhere as that Recipe updated", () => {
    const made = changes([50, plugin("loadedRecipe"), { grindSetting: "8.4" }], [51, plugin("loadedRecipe"), { dose: 18.4 }]);
    expect(shown(dialInTrail({ baseline: baseline(), changes: made, recipeEvents: [], loadedAtStart: BRAZIL }))).toEqual([
      { kind: "recipeUpdated", observedAt: iso(50), lastObservedAt: iso(51), cause: "plugin:loadedRecipe", loadedRecipe: "Brazil", changes: { grindSetting: ["8.8", "8.4"], dose: [18, 18.4] } },
    ]);
  });

  it("never merges across a load or unload, and folds nothing into one after its 5 s", () => {
    const made = changes([0, OTHER, { dose: 19 }], [2, OTHER, { recipeId: BRAZIL.id }], [4, OTHER, { dose: 20 }], [8, OTHER, { dose: 21 }], [9, OTHER, { dose: 22 }]);
    const trail = shown(dialInTrail({ baseline: baseline(), changes: made, recipeEvents: loads(["loaded", 2, BRAZIL]), loadedAtStart: null }));
    expect(trail.map(({ kind, observedAt, lastObservedAt, loadedRecipe }) => [kind, observedAt, lastObservedAt, loadedRecipe])).toEqual([
      ["changed", iso(0), null, null],
      // The load takes the change that loaded it, and none but the plugin's load writes after it.
      ["loaded", iso(2), null, "Brazil"],
      ["changed", iso(4), iso(9), "Brazil"],
    ]);
  });

  it("drops an entry no field of the summary changed in, but keeps a load or unload that changed none", () => {
    const made = changes([0, OTHER, {}], [20, OTHER, { dose: 19 }], [40, OTHER, { dose: 19 }]);
    const trail = dialInTrail({ baseline: baseline(), changes: made, recipeEvents: loads(["loaded", 40, BRAZIL]), loadedAtStart: null });
    expect(shown(trail).map(({ kind, changes }) => [kind, changes])).toEqual([
      ["changed", { dose: [18, 19] }],
      ["loaded", {}],
    ]);
  });

  it("puts a load or unload before a change at the same moment, then orders by stored id, and gives a load with no change near it as of unknown cause", () => {
    // The change at the load's moment, stored before the load's entry, folds into it all the same.
    const made: TrailChange[] = [{ id: 1n, observedAt: at(0), ...OTHER, summary: { ...SUMMARY, recipeId: BRAZIL.id } }];
    const trail = dialInTrail({ baseline: { ...baseline(), id: 0n }, changes: made, recipeEvents: loads(["loaded", 0, BRAZIL, 9]), loadedAtStart: null });
    expect(shown(trail)).toEqual([{ kind: "loaded", observedAt: iso(0), lastObservedAt: null, cause: "other", loadedRecipe: "Brazil", changes: { recipeId: [null, BRAZIL.id] } }]);
    // A load timed as a change held back first named it, delivered 3 s later: the change's time is its last.
    const held = changes([3, plugin("steamOn"), { recipeId: BRAZIL.id }]);
    expect(shown(dialInTrail({ baseline: baseline(), changes: held, recipeEvents: loads(["loaded", 0, BRAZIL]), loadedAtStart: null }))).toEqual([
      { kind: "loaded", observedAt: iso(0), lastObservedAt: iso(3), cause: "plugin:steamOn", loadedRecipe: "Brazil", changes: { recipeId: [null, BRAZIL.id] } },
    ]);
    // A load as the Machine joins its Location, with its Workflow unchanged, so no change stored.
    const joined = dialInTrail({ baseline: baseline(), changes: [], recipeEvents: loads(["loaded", 0, BRAZIL]), loadedAtStart: null });
    expect(shown(joined)).toEqual([{ kind: "loaded", observedAt: iso(0), lastObservedAt: null, cause: "unknown", loadedRecipe: "Brazil", changes: {} }]);
  });

  it("gives a part the Workflow has none of as its fields null, as steam turned on with its settings", () => {
    const made = changes([0, OTHER, { steam: null }], [60, OTHER, { steam: { temperature: 150, duration: 30, flow: 1.5 } }]);
    expect(shown(dialInTrail({ baseline: baseline(), changes: made, recipeEvents: [], loadedAtStart: null })).map((entry) => entry.changes)).toEqual([
      { "steam.temperature": [150, null], "steam.duration": [30, null], "steam.flow": [1.5, null] },
      { "steam.temperature": [null, 150], "steam.duration": [null, 30], "steam.flow": [null, 1.5] },
    ]);
  });
});
