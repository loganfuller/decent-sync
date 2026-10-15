import fs from "node:fs";
import { LOADED_RECIPE_KEY, RECIPE_FIELD } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  type ChangedSetUp,
  type Dial,
  type HeldRecipe,
  type Pending,
  type WorkflowSetUp,
  changedParts,
  chooseLoad,
  decideChange,
  loadWrite,
  matches,
  profileKey,
  recipeDials,
  resolveDial,
  unloads,
  workflowDial,
} from "../src/recipe-matching.js";

// Module tests for working out a Machine's Loaded Recipe from its Workflow
// (ADR-0022): detecting a load, choosing between matches, what recording one
// writes, and when the plugin unloads one. With what DYE2 v0.1.19 and
// Streamline were recorded holding and applying on Decaid's Linux release
// (server/test/fixtures/decaid/dye2-v0.1.19/), or records derived from them
// by the named changes.

type Record_ = Record<string, unknown>;

function fixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/dye2-v0.1.19/${file}.json`, import.meta.url), "utf8")) as T;
}

interface Exchange {
  request: { method: string; path: string };
  response: { body: unknown };
}

/** The Workflow Decaid answered the step's `PUT /workflow` with. */
function applied(file: "dye2-applies" | "streamline", step: string): Record_ {
  const exchange = fixture<Record<string, Exchange[]>>(file)[step]!.find(({ request }) => request.method === "PUT" && request.path === "/workflow");
  return structuredClone(exchange!.response.body) as Record_;
}

const keys = fixture<{ recipes: Record_[] }>("keys");
const library = fixture<{ profiles: { id: string; profile: Record_ }[]; workflow: Record_ }>("library");
const recipe = (slot: string) => structuredClone(keys.recipes.find((record) => record.id === slot)!);
/** The tablet's profiles' keys, by their ids. */
const keyOfId = (id: string) => profileKey(library.profiles.find((profile) => profile.id === id)?.profile);
const dialsOf = (record: Record_) => recipeDials(record).map((dial) => resolveDial(dial, keyOfId));
const held = (globalId: string, slot: number, record: Record_, earlier: Record_[] = []): HeldRecipe => ({
  globalId,
  slot,
  record,
  dials: [record, ...earlier].flatMap(dialsOf),
  now: dialsOf(record),
});

const ONE = "0190a5a2-0000-7000-8000-000000000001";
const TWO = "0190a5a2-0000-7000-8000-000000000002";

describe("a profile compared by what Decaid hashes for its id", () => {
  const profile = library.profiles[0]!.profile;

  it("is the same with each step's temperature or the target weight a skin overrides, or a limiter of value 0 sent as none", () => {
    const steps = (profile.steps as Record_[]).map((step) => ({ ...step, temperature: 80, limiter: { value: 0, range: 0.6 } }));
    expect(profileKey({ ...profile, steps, target_weight: 42 })).toBe(profileKey({ ...profile, steps: steps.map((step) => ({ ...step, limiter: null })) }));
    expect(profileKey({ ...profile, title: "Renamed", notes: "", target_weight: 0 })).toBe(profileKey(profile));
  });

  it("differs with what the machine executes, and is none without steps", () => {
    const steps = structuredClone(profile.steps) as Record_[];
    steps[0] = { ...steps[0], seconds: 99 };
    expect(profileKey({ ...profile, steps })).not.toBe(profileKey(profile));
    expect(profileKey({ ...profile, tank_temperature: 40 })).not.toBe(profileKey(profile));
    expect(profileKey({ title: "Adaptive v3" })).toBeNull();
  });
});

describe("detecting a load", () => {
  it("takes the Workflow DYE2's dashboard applied for its recipe, its profile named by id in the record", () => {
    const workflow = applied("dye2-applies", "applySlot1");
    expect(dialsOf(recipe("1")).some((dial) => matches(dial, workflowDial(workflow)))).toBe(true);
    expect(dialsOf(recipe("2")).some((dial) => matches(dial, workflowDial(workflow)))).toBe(false);
  });

  it("takes the Workflow Streamline's strip applied from the Workflow embedded in its recipe, though the recipe's dial moved on since", () => {
    // Streamline's auto-save moved slot 2's dose to 20 and its grind to 3.1, leaving the embedded Workflow at 19 and 3.
    const record = recipe("2");
    const workflow = applied("streamline", "applySlot2");
    const [dye2, streamline] = dialsOf(record) as [Dial, Dial];
    expect(matches(dye2, workflowDial(workflow))).toBe(false);
    expect(matches(streamline, workflowDial(workflow))).toBe(true);
  });

  it("reads a grind setting as Decaid keeps it, text, and a yield as a recipe's dose times its ratio where it holds none", () => {
    const record = recipe("1");
    const variables = record.dashboardVariables as Record_;
    variables.grind = 3;
    delete variables.drink;
    variables.ratio = 2;
    const [dial] = dialsOf(record) as [Dial];
    expect(dial).toMatchObject({ grind: "3", yield: 37, dose: 18.5 });
    const workflow = applied("dye2-applies", "applySlot1");
    workflow.context = { ...(workflow.context as Record_), grinderSetting: "3.0", targetYield: 37 };
    expect(matches(dial, workflowDial(workflow))).toBe(true);
  });

  it("leaves a field the recipe sets none of to the Workflow, and a recipe setting none matches nothing", () => {
    const dial: Dial = { profile: null, dose: 18.5, yield: null, grinder: null, grind: null };
    const workflow = workflowDial(applied("dye2-applies", "applySlot1"));
    expect(matches(dial, workflow)).toBe(true);
    expect(matches({ ...dial, dose: 18 }, workflow)).toBe(false);
    expect(matches({ ...dial, dose: null }, workflow)).toBe(false);
  });
});

describe("choosing between matches", () => {
  const workflow = workflowDial(applied("dye2-applies", "applySlot1"));
  const record = recipe("1");
  const copy = { ...recipe("1"), id: "4", name: "The same dial" };

  it("chooses the lowest slot, unless the Workflow names one of them as loaded already", () => {
    const recipes = [held(TWO, 4, copy), held(ONE, 1, record)];
    expect(chooseLoad(workflow, null, recipes)?.globalId).toBe(ONE);
    expect(chooseLoad(workflow, TWO, recipes)?.globalId).toBe(TWO);
    expect(chooseLoad(workflow, "0190a5a2-0000-7000-8000-000000000009", recipes)?.globalId).toBe(ONE);
  });

  it("loads no recipe of another Bean than the batch picked in the same change", () => {
    const recipes = [held(ONE, 1, record)];
    expect(chooseLoad(workflow, null, recipes, "6b16db38-425e-48ec-93b7-e03e1d8707cd")).toBeNull();
    expect(chooseLoad(workflow, null, recipes, String(record.beanId))?.globalId).toBe(ONE);
    expect(chooseLoad(workflow, null, [held(ONE, 1, { ...record, beanId: null })], "6b16db38-425e-48ec-93b7-e03e1d8707cd")?.globalId).toBe(ONE);
  });

  it("matches a dial a recipe held before, as a stale page applies, and none it never held", () => {
    // Edited since, and its embedded Workflow written again with it, as the server writes it.
    const edited = recipe("1");
    Object.assign(edited.dashboardVariables as Record_, { dose: 19.5, grind: 2.9 });
    Object.assign((edited.workflow as Record_).context as Record_, { targetDoseWeight: 19.5, grinderSetting: "2.9" });
    expect(chooseLoad(workflow, null, [held(ONE, 1, edited)])).toBeNull();
    expect(chooseLoad(workflow, null, [held(ONE, 1, edited, [record])])?.globalId).toBe(ONE);
  });
});

describe("recording a load", () => {
  const batch = { id: "b850e4f2-89cf-400f-9d43-ec1080ad595b", coffeeName: "Fixture Ethiopia", coffeeRoaster: "Fixture Roasters" };
  const hotWater = { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 };
  /** Slot 1 as the server writes it: its Bean Batch and all four hot water settings in its own field. */
  const written = (): Record_ => ({ ...recipe("1"), [RECIPE_FIELD]: { beanBatchId: batch.id, hotWaterData: hotWater } });
  const profile = library.profiles[0]!.profile;

  it("writes what the Workflow lacks of the recipe's current values, its batch, its hot water and its id", () => {
    const workflow = applied("dye2-applies", "applySlot1");
    expect(loadWrite(workflow, written(), ONE, { profile, batch })).toEqual({
      context: {
        beanBatchId: batch.id,
        coffeeName: "Fixture Ethiopia",
        coffeeRoaster: "Fixture Roasters",
        extras: { basketId: "5a792f42-b6ff-44e0-a58c-ed165741b789", basketName: "Fixture 18g Precision", [LOADED_RECIPE_KEY]: ONE },
      },
      hotWaterData: { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 },
    });
  });

  it("writes the recipe's current dial over a stale copy's, and its Profile where the Workflow's is another", () => {
    const workflow = applied("dye2-applies", "applySlot1");
    const record = written();
    Object.assign(record.dashboardVariables as Record_, { dose: 19.5, drink: 40, grind: 2.9, rpm: 950 });
    const other = library.profiles[1]!.profile;
    const write = loadWrite(workflow, record, ONE, { profile: other, batch: null });
    expect(write?.context).toMatchObject({ targetDoseWeight: 19.5, targetYield: 40, grinderSetting: "2.9", extras: { rpm: 950 } });
    expect(write?.profile).toBe(other);
    expect(loadWrite(workflow, record, ONE, { profile, batch: null })).not.toHaveProperty("profile");
  });

  it("writes nothing to a Workflow holding it all, and leaves a value the recipe holds none of", () => {
    const workflow = applied("dye2-applies", "applySlot1");
    const record = written();
    const first = loadWrite(workflow, record, ONE, { profile, batch })!;
    const after = structuredClone(workflow);
    after.context = { ...(after.context as Record_), ...(first.context as Record_), extras: { ...((after.context as Record_).extras as Record_), ...((first.context as Record_).extras as Record_) } };
    after.hotWaterData = { ...(after.hotWaterData as Record_), ...(first.hotWaterData as Record_) };
    expect(loadWrite(after, record, ONE, { profile, batch })).toBeNull();
    const bare = { ...record, [RECIPE_FIELD]: { beanBatchId: null, hotWaterData: { targetTemperature: null, duration: null, volume: null, flow: null } } };
    expect(loadWrite(after, bare, ONE, { profile, batch: null })).toBeNull();
  });
});

describe("when the plugin unloads a recipe", () => {
  const record = recipe("1");
  const dials = dialsOf(record);
  const bean = String(record.beanId);
  const loaded: WorkflowSetUp = { dial: workflowDial(applied("dye2-applies", "applySlot1")), bean };
  const changed = (dial: Partial<Dial>, to: string | null = bean): WorkflowSetUp => ({ dial: { ...loaded.dial, ...dial }, bean: to });

  it("unloads on a change of its profile, grinder or Bean to one the recipe does not name", () => {
    expect(unloads(loaded, changed({ profile: profileKey(library.profiles[1]!.profile) }), dials, bean)).toBe(true);
    expect(unloads(loaded, changed({ grinder: "another-grinder" }), dials, bean)).toBe(true);
    expect(unloads(loaded, changed({ grinder: null }), dials, bean)).toBe(true);
    expect(unloads(loaded, changed({}, "6b16db38-425e-48ec-93b7-e03e1d8707cd"), dials, bean)).toBe(true);
  });

  it("keeps it through a tweak of its dose, yield or grind setting, another batch of its Bean, or a batch cleared", () => {
    expect(unloads(loaded, changed({ dose: 19, yield: 40, grind: "2.9" }), dials, bean)).toBe(false);
    expect(unloads(loaded, changed({}, bean), dials, bean)).toBe(false);
    expect(unloads(loaded, changed({}, null), dials, bean)).toBe(false);
  });

  it("keeps it through a change of what the recipe names none of", () => {
    const loose: Dial[] = [{ profile: null, dose: 18.5, yield: 36, grinder: null, grind: "2.7" }];
    expect(unloads(loaded, changed({ profile: "another", grinder: "another-grinder" }, "another-bean"), loose, null)).toBe(false);
  });
});

describe("deciding each change of the Workflow in turn", () => {
  const ethiopia = String(recipe("1").beanId);
  const brazil = String(recipe("2").beanId);
  const recipes = [held(ONE, 1, recipe("1")), held(TWO, 2, recipe("2"))];
  const slot1 = applied("dye2-applies", "applySlot1");
  const slot2 = applied("streamline", "applySlot2");
  /** A Workflow derived from slot 1's as applied, its context changed as given. */
  const derived = (from: Record_, context: Record_) => ({ ...from, context: { ...(from.context as Record_), ...context } });
  const withId = (from: Record_, id: string | null) => derived(from, { extras: { ...((from.context as Record_).extras as Record_), [LOADED_RECIPE_KEY]: id } });
  /** Decides each Workflow in turn from the one before it, each batch's Bean as `beans` says, from nothing pending. */
  function decided(workflows: Record_[], beans: Record<string, string> = {}, tabletRecipes: readonly HeldRecipe[] = recipes): Pending {
    let pending: Pending = { kind: "none" };
    let before: Record_ | undefined;
    for (const workflow of workflows) {
      const named = (of: Record_) => ((((of.context as Record_).extras ?? {}) as Record_)[LOADED_RECIPE_KEY] as string | undefined) ?? null;
      // As the plugin reads a batch's Bean: as the batch changes, or for the first Workflow naming no recipe.
      const picked = before !== undefined ? (before.context as Record_).beanBatchId !== (workflow.context as Record_).beanBatchId : named(workflow) === null;
      const setUp = (of: Record_): ChangedSetUp => {
        const batch = ((of.context as Record_).beanBatchId as string | undefined) ?? null;
        return { dial: workflowDial(of), batch, bean: picked && batch !== null ? (beans[batch] ?? null) : null, named: named(of) };
      };
      pending = decideChange(pending, before && setUp(before), setUp(workflow), before ? changedParts(before, workflow) : new Set(), tabletRecipes);
      before = workflow;
    }
    return pending;
  }
  const beans = { "batch-e": ethiopia, "batch-e2": ethiopia, "batch-b": brazil };
  const loaded = withId(derived(slot1, { beanBatchId: "batch-e" }), ONE);
  const tweaked = derived(loaded, { grinderSetting: "2.8" });
  /** What a load of the recipe the Workflow names already leaves as the barista left it: all but its dial. */
  const afterLoaded = ["rpm", "basket", "batch", "targetTemperature", "duration", "volume", "flow"];

  it("loads a recipe applied, and writes the recipe the Workflow names already its dial alone as it is set back", () => {
    expect(decided([derived(slot1, { targetDoseWeight: 17 }), slot1])).toEqual({ kind: "load", globalId: ONE, kept: new Set() });
    expect(decided([tweaked, loaded])).toEqual({ kind: "load", globalId: ONE, kept: new Set(afterLoaded) });
  });

  it("loads the first Workflow the plugin hears of where it matches, of its batch's Bean, writing one naming it already its dial alone, and unloads nothing then", () => {
    expect(decided([slot1])).toEqual({ kind: "load", globalId: ONE, kept: new Set() });
    expect(decided([derived(slot1, { beanBatchId: "batch-e" })], beans)).toEqual({ kind: "load", globalId: ONE, kept: new Set() });
    // Unloaded before the plugin last loaded, by a batch of another Bean: no change loads it again.
    expect(decided([derived(slot1, { beanBatchId: "batch-b" })], beans)).toEqual({ kind: "none" });
    expect(decided([loaded], beans)).toEqual({ kind: "load", globalId: ONE, kept: new Set(afterLoaded) });
    expect(decided([withId(derived(slot1, { targetDoseWeight: 17 }), ONE)])).toEqual({ kind: "none" });
  });

  it("keeps the parts a barista changes after a load still to be written, and the load", () => {
    expect(decided([derived(slot1, { targetDoseWeight: 17 }), slot1, derived(slot1, { targetDoseWeight: 18.6 })])).toEqual({ kind: "load", globalId: ONE, kept: new Set(["dose"]) });
    const hotWater = { ...slot1, hotWaterData: { ...(slot1.hotWaterData as Record_), volume: 60 } };
    expect(decided([derived(slot1, { targetDoseWeight: 17 }), slot1, hotWater])).toEqual({ kind: "load", globalId: ONE, kept: new Set(["volume"]) });
    expect(decided([tweaked, loaded, derived(loaded, { beanBatchId: "batch-e2" })], beans)).toEqual({ kind: "load", globalId: ONE, kept: new Set(afterLoaded) });
    const nextBag = derived(slot1, { beanBatchId: "batch-e2", targetDoseWeight: 17 });
    expect(decided([nextBag, derived(nextBag, { targetDoseWeight: 18.5 }), derived(nextBag, { targetDoseWeight: 18.5, grinderSetting: "2.8" })], beans)).toEqual({
      kind: "load",
      globalId: ONE,
      kept: new Set(["grind"]),
    });
  });

  it("unloads a load still to be written on a batch of another Bean picked after it, or with it", () => {
    expect(decided([tweaked, loaded, derived(loaded, { beanBatchId: "batch-b" })], beans)).toEqual({ kind: "unload" });
    expect(decided([slot1, derived(slot1, { beanBatchId: "batch-b" })], beans)).toEqual({ kind: "unload" });
    // Picked in the same change as the dial: no app applying a recipe picks a batch, so it is the barista's.
    expect(decided([tweaked, derived(loaded, { beanBatchId: "batch-b" })], beans)).toEqual({ kind: "unload" });
  });

  it("keeps an unload through the changes after it, as had each been decided at once", () => {
    const another = derived(loaded, { grinderId: "another-grinder" });
    expect(decided([loaded, another])).toEqual({ kind: "unload" });
    expect(decided([loaded, another, derived(another, { targetDoseWeight: 19.25 })])).toEqual({ kind: "unload" });
    expect(decided([loaded, another, derived(loaded, { targetDoseWeight: 19.25 })])).toEqual({ kind: "unload" });
  });

  it("loads a recipe set back to its dial while its unload is still to be written as it would once written, its batch included", () => {
    const otherBean = derived(tweaked, { beanBatchId: "batch-b" });
    const setBack = derived(loaded, { beanBatchId: "batch-b" });
    const atOnce = decided([withId(otherBean, null), withId(setBack, null)], beans);
    expect(atOnce).toEqual({ kind: "load", globalId: ONE, kept: new Set() });
    expect(decided([tweaked, otherBean, setBack], beans)).toEqual(atOnce);
  });

  it("corrects all but the batch of the Recipe the Workflow names as a stale copy of it is applied", () => {
    const edited = recipe("1");
    Object.assign(edited.dashboardVariables as Record_, { dose: 19 });
    Object.assign((edited.workflow as Record_).context as Record_, { targetDoseWeight: 19 });
    const tablet = [held(ONE, 1, edited, [recipe("1")])];
    const current = derived(loaded, { targetDoseWeight: 19 });
    // Its grind tweaked on the machine, then a page read before its dose was edited applied.
    expect(decided([derived(current, { grinderSetting: "2.8" }), loaded], beans, tablet)).toEqual({ kind: "load", globalId: ONE, kept: new Set(["batch"]) });
    // As it is now, applied again: its dial alone.
    expect(decided([derived(current, { targetDoseWeight: 19.5 }), current], beans, tablet)).toEqual({ kind: "load", globalId: ONE, kept: new Set(afterLoaded) });
  });

  it("loads another recipe applied over a load still to be written", () => {
    expect(decided([derived(slot1, { targetDoseWeight: 17 }), slot1, slot2])).toEqual({ kind: "load", globalId: TWO, kept: new Set() });
  });
});
