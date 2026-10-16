import fs from "node:fs";
import { LOADED_RECIPE_KEY, RECIPE_FIELD, profileAtBrewTemperature, shiftedTemperatures } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { dye2Fingerprint, loadWrite, profileKey, recipeSetUp, vacatedSlots } from "../src/loaded-recipe-rules.js";

// Module tests for what the plugin writes into the Workflow as DYE2's
// selection loads a Recipe (ADR-0022), and how it reads DYE2's fingerprint of
// a profile. With what DYE2 at 2cf631c and Streamline at c006dac were
// recorded holding and applying on Decaid's Linux release
// (server/test/fixtures/decaid/dye2-2cf631c/), or records derived from them
// by the named changes.

type Record_ = Record<string, unknown>;

function fixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/dye2-2cf631c/${file}.json`, import.meta.url), "utf8")) as T;
}

interface Exchange {
  request: { method: string; path: string };
  response: { body: unknown };
}

/** The Workflow Decaid answered the step's `PUT /workflow` with. */
function applied(file: "dye2-applies" | "streamline", step: string): Record_ {
  const exchange = fixture<Record<string, { exchanges: Exchange[] }>>(file)[step]!.exchanges.find(({ request }) => request.method === "PUT" && request.path === "/workflow");
  return structuredClone(exchange!.response.body) as Record_;
}

const keys = fixture<{ recipes: Record_[] }>("keys");
const library = fixture<{ profiles: { id: string; profile: Record_ }[]; workflow: Record_ }>("library");
const recipe = (slot: string) => structuredClone(keys.recipes.find((record) => record.id === slot)!);
const temperatures = (profile: unknown) => ((profile as Record_).steps as Record_[]).map((step) => step.temperature);

const ONE = "0190a5a2-0000-7000-8000-000000000001";

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

describe("a profile at a brew temperature", () => {
  const adaptive = library.profiles.find((profile) => profile.profile.title === "Adaptive v3")!.profile;

  it("moves its first step to it and every other by the same amount, as Streamline's Brew tile does", () => {
    expect(temperatures(adaptive).slice(0, 3)).toEqual([93, 93, 88]);
    expect(temperatures(profileAtBrewTemperature(adaptive, 92, null)).slice(0, 3)).toEqual([92, 92, 87]);
    expect(shiftedTemperatures([94, 90, 88], 92)).toEqual([92, 88, 86]);
    // A step without a temperature goes to it; rounding to 0.01 °C.
    expect(shiftedTemperatures([94, undefined, 88.333], 92.5)).toEqual([92.5, 92.5, 86.83]);
  });

  it("moves from the Profile's own step temperatures where given, so moving it again keeps its shape", () => {
    const moved = profileAtBrewTemperature(adaptive, 90, null)!;
    const again = profileAtBrewTemperature(moved, 92, temperatures(adaptive));
    expect(temperatures(again)).toEqual(temperatures(profileAtBrewTemperature(adaptive, 92, null)));
  });

  it("is none for a profile with no usable first step temperature", () => {
    expect(profileAtBrewTemperature({ title: "No steps" }, 92, null)).toBeNull();
    expect(profileAtBrewTemperature({ steps: [{ name: "pour" }] }, 92, null)).toBeNull();
    expect(shiftedTemperatures([], 92)).toBeNull();
  });
});

describe("DYE2's fingerprint of a profile", () => {
  const profile = library.profiles[0]!.profile;

  it("leaves out each step's temperature, as DYE2's does, so a brew temperature change is no change of profile", () => {
    expect(dye2Fingerprint(profileAtBrewTemperature(profile, 80, null))).toBe(dye2Fingerprint(profile));
    expect(dye2Fingerprint({ ...profile, title: "Another" })).not.toBe(dye2Fingerprint(profile));
    expect(dye2Fingerprint(null)).toBeNull();
  });

  it("leaves out the target weight and volume, as DYE2's does, so a yield set in Streamline is no change of profile (dye2#18)", () => {
    expect(dye2Fingerprint({ ...profile, target_weight: 40, target_volume: 50 })).toBe(dye2Fingerprint(profile));
  });
});

describe("recording a load", () => {
  const batch = { id: "6f741a24-ceb9-4ec6-aa51-750c6e9fec26", coffeeName: "Fixture Ethiopia", coffeeRoaster: "Fixture Roasters" };
  const hotWater = { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 };
  /** Slot 1 as the server writes it: its Bean Batch and all four hot water settings in its own field. */
  const written = (): Record_ => ({ ...recipe("1"), [RECIPE_FIELD]: { beanBatchId: batch.id, hotWaterData: hotWater } });
  const profile = library.profiles[0]!.profile;
  const adaptive = library.profiles.find((candidate) => candidate.profile.title === "Adaptive v3")!.profile;
  const basket = (recipe("1").dashboardVariables as Record_).basketId as string;
  /**
   * Slot 1 applied on DYE2's dashboard, which sets its brew temperature itself
   * (decentespresso/dye2#26), but for the Profile at its own step
   * temperatures, as from a copy read before the server wrote it at the
   * recipe's.
   */
  const appliedAtOwnTemperatures = (): Record_ => ({ ...applied("dye2-applies", "applySlot1"), profile: structuredClone(adaptive) });

  it("writes what the Workflow lacks of the recipe's current values, its brew temperature, batch, hot water and id, with what each part held", () => {
    const workflow = appliedAtOwnTemperatures();
    const write = loadWrite(workflow, written(), ONE, { profile, baseTemperatures: temperatures(adaptive), batch })!;
    expect(write.write.context).toEqual({
      beanBatchId: batch.id,
      coffeeName: "Fixture Ethiopia",
      coffeeRoaster: "Fixture Roasters",
      extras: { basketId: basket, basketName: "Fixture 18g Precision", [LOADED_RECIPE_KEY]: ONE },
    });
    expect(write.write.hotWaterData).toEqual(hotWater);
    // Adaptive v3 at its own 93 °C; the recipe's is 92, the Profile's shape kept.
    expect(temperatures(write.write.profile).slice(0, 3)).toEqual([92, 92, 87]);
    const context = workflow.context as Record_;
    expect(write.before).toEqual({
      batch: { before: context.beanBatchId ?? null, written: batch.id },
      basket: { before: (context.extras as Record_).basketId ?? null, written: basket },
      brewTemperature: { before: 93, written: 92 },
      ...Object.fromEntries(
        Object.entries(hotWater)
          .filter(([field, value]) => (workflow.hotWaterData as Record_)[field] !== value)
          .map(([field, value]) => [field, { before: (workflow.hotWaterData as Record_)[field] ?? null, written: value }]),
      ),
    });
  });

  it("writes the recipe's current dial over a stale copy's, and its Profile where the Workflow's is another, at the recipe's brew temperature", () => {
    const workflow = appliedAtOwnTemperatures();
    const record = written();
    Object.assign(record.dashboardVariables as Record_, { dose: 19.5, drink: 40, grind: 2.9, rpm: 950 });
    const other = library.profiles.find((candidate) => candidate.profile.title !== "Adaptive v3")!.profile;
    const write = loadWrite(workflow, record, ONE, { profile: other, baseTemperatures: temperatures(other), batch: null })!;
    expect(write.write.context).toMatchObject({ targetDoseWeight: 19.5, targetYield: 40, grinderSetting: "2.9", extras: { rpm: 950 } });
    expect(write.before).toMatchObject({ dose: { before: 18.5, written: 19.5 }, grind: { written: "2.9" }, rpm: { written: 950 } });
    expect((write.write.profile as Record_).title).toBe(other.title);
    expect(temperatures(write.write.profile)[0]).toBe(92);
    // The same profile is moved to the recipe's brew temperature alone.
    const same = loadWrite(workflow, record, ONE, { profile: adaptive, baseTemperatures: temperatures(adaptive), batch: null })!;
    expect((same.write.profile as Record_).title).toBe("Adaptive v3");
  });

  it("writes nothing to a Workflow holding it all, and leaves a value the recipe holds none of", () => {
    const workflow = appliedAtOwnTemperatures();
    const record = written();
    const first = loadWrite(workflow, record, ONE, { profile, baseTemperatures: null, batch })!.write;
    const after = structuredClone(workflow);
    after.context = { ...(after.context as Record_), ...(first.context as Record_), extras: { ...((after.context as Record_).extras as Record_), ...((first.context as Record_).extras as Record_) } };
    after.hotWaterData = { ...(after.hotWaterData as Record_), ...(first.hotWaterData as Record_) };
    after.profile = first.profile;
    expect(loadWrite(after, record, ONE, { profile, baseTemperatures: null, batch })).toBeNull();
    const bare = { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), brewC: undefined }, [RECIPE_FIELD]: { beanBatchId: null, hotWaterData: { targetTemperature: null, duration: null, volume: null, flow: null } } };
    expect(loadWrite(after, bare, ONE, { profile, baseTemperatures: null, batch: null })).toBeNull();
  });

  it("leaves out what it is told to, as the hot water while Decaid refuses it for want of a machine", () => {
    const workflow = applied("dye2-applies", "applySlot1");
    const write = loadWrite(workflow, written(), ONE, { profile, baseTemperatures: null, batch }, new Set(["targetTemperature", "duration", "volume", "flow"]))!;
    expect(write.write).not.toHaveProperty("hotWaterData");
    expect(Object.keys(write.before)).not.toContain("volume");
  });
});

describe("what a recipe names that a change of grinder or Bean is judged by", () => {
  it("is its grinder by the tablet's id and its Bean", () => {
    const record = recipe("1");
    expect(recipeSetUp(record)).toEqual({ grinder: (record.dashboardVariables as Record_).grinderId, bean: record.beanId });
    expect(recipeSetUp({})).toEqual({ grinder: null, bean: null });
  });
});

describe("the slots a post of DYE2's recipes vacates", () => {
  const LAB = "1b3d5f7a-9c1e-4a3b-8d5f-7a9c1e3b5d7f";
  const UPTOWN = "3d5f7b9c-2e4a-4c6d-8f9b-9c2e4a6d8f1b";
  /** One of the recording's recipes in a slot, carrying a Recipe's global id or none. */
  const inSlot = (slot: string, globalId: string | null = null): Record_ => ({ ...keys.recipes[0], id: slot, ...(globalId === null ? {} : { decentSyncId: globalId }) });

  it("names each slot whose recipe the post removes, or replaces with another Recipe's, as a Machine joining another Location", () => {
    // The tablet's own recipe in slot 1 removed, and the lab's Recipe in slot 2 replaced with Uptown's.
    expect(vacatedSlots([inSlot("1"), inSlot("2", LAB)], [inSlot("2", UPTOWN)])).toEqual([1, 2]);
    expect(vacatedSlots([inSlot("2", LAB)], [])).toEqual([2]);
  });

  it("names none the post keeps, writes, gives its global id or fills", () => {
    expect(vacatedSlots([inSlot("2", LAB)], [{ ...inSlot("2", LAB), name: "Renamed" }])).toEqual([]);
    // A Location taking the tablet's own recipe in writes its global id into it: the same recipe.
    expect(vacatedSlots([inSlot("1")], [inSlot("1", UPTOWN)])).toEqual([]);
    expect(vacatedSlots([], [inSlot("3", UPTOWN)])).toEqual([]);
  });
});
