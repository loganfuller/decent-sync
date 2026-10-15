import fs from "node:fs";
import { LOADED_RECIPE_KEY, RECIPE_FIELD } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  type Dial,
  type HeldRecipe,
  type WorkflowSetUp,
  chooseLoad,
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
