import fs from "node:fs";
import { RECIPE_FIELD, profileAtBrewTemperature, shiftedTemperatures } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { armedOn, clearsSelection, dye2Fingerprint, loadWrite, profileKey, selectedOn, vacatedSlots } from "../src/loaded-recipe-rules.js";

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
    expect(temperatures(profileAtBrewTemperature(adaptive, 92)).slice(0, 3)).toEqual([92, 92, 87]);
    expect(shiftedTemperatures([94, 90, 88], 92)).toEqual([92, 88, 86]);
    // A step without a temperature goes to it; rounding to 0.01 °C.
    expect(shiftedTemperatures([94, undefined, 88.333], 92.5)).toEqual([92.5, 92.5, 86.83]);
  });

  it("keeps its shape however often it is moved", () => {
    const moved = profileAtBrewTemperature(adaptive, 90)!;
    expect(temperatures(profileAtBrewTemperature(moved, 92))).toEqual(temperatures(profileAtBrewTemperature(adaptive, 92)));
  });

  it("is none for a profile with no usable first step temperature", () => {
    expect(profileAtBrewTemperature({ title: "No steps" }, 92)).toBeNull();
    expect(profileAtBrewTemperature({ steps: [{ name: "pour" }] }, 92)).toBeNull();
    expect(shiftedTemperatures([], 92)).toBeNull();
  });
});

describe("DYE2's fingerprint of a profile", () => {
  const profile = library.profiles[0]!.profile;

  it("leaves out each step's temperature, as DYE2's does, so a brew temperature change is no change of profile", () => {
    expect(dye2Fingerprint(profileAtBrewTemperature(profile, 80))).toBe(dye2Fingerprint(profile));
    expect(dye2Fingerprint({ ...profile, title: "Another" })).not.toBe(dye2Fingerprint(profile));
    expect(dye2Fingerprint(null)).toBeNull();
  });

  it("leaves out the target weight and volume, as DYE2's does, so a yield set in Streamline is no change of profile (dye2#18)", () => {
    expect(dye2Fingerprint({ ...profile, target_weight: 40, target_volume: 50 })).toBe(dye2Fingerprint(profile));
  });
});

describe("recording a load", () => {
  const batch = "6f741a24-ceb9-4ec6-aa51-750c6e9fec26";
  const hotWater = { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 };
  /** Slot 1 as the server writes it: its Bean Batch beside its Bean, as DYE2 holds one, and all four hot water settings in its own field. */
  const written = (): Record_ => ({ ...recipe("1"), beanBatchId: batch, [RECIPE_FIELD]: { hotWaterData: hotWater } });
  const adaptive = library.profiles.find((candidate) => candidate.profile.title === "Adaptive v3")!.profile;
  /** Slot 1's Profile at its brew temperature, as the Workflow embedded in its record holds it. */
  const profile = profileAtBrewTemperature(adaptive, 92)!;
  const basket = (recipe("1").dashboardVariables as Record_).basketId as string;
  /**
   * Slot 1 applied on DYE2's dashboard, but for the Profile at its own step
   * temperatures, as a skin applying it from a copy read before its brew
   * temperature changed.
   */
  const appliedAtOwnTemperatures = (): Record_ => ({ ...applied("dye2-applies", "applySlot1"), profile: structuredClone(adaptive) });

  it("writes what the Workflow lacks of the recipe's current values, its batch and hot water, with what each part held, but no brew temperature or Recipe id", () => {
    const workflow = appliedAtOwnTemperatures();
    const write = loadWrite(workflow, written(), { profile })!;
    expect(write.write.context).toEqual({
      beanBatchId: batch,
      coffeeName: "Fixture Ethiopia",
      coffeeRoaster: "Fixture Roasters",
      extras: { basketId: basket, basketName: "Fixture 18g Precision" },
    });
    expect(write.write.hotWaterData).toEqual(hotWater);
    // DYE2 and Streamline apply the recipe's brew temperature themselves (decentespresso/dye2#26): the profile's is left.
    expect(write.write).not.toHaveProperty("profile");
    const context = workflow.context as Record_;
    expect(write.before).toEqual({
      batch: { before: context.beanBatchId ?? null, written: batch },
      basket: { before: (context.extras as Record_).basketId ?? null, written: basket },
      ...Object.fromEntries(
        Object.entries(hotWater)
          .filter(([field, value]) => (workflow.hotWaterData as Record_)[field] !== value)
          .map(([field, value]) => [field, { before: (workflow.hotWaterData as Record_)[field] ?? null, written: value }]),
      ),
    });
  });

  it("writes the recipe's current dial over a stale copy's, and its Profile at its brew temperature where the Workflow's is another", () => {
    const workflow = appliedAtOwnTemperatures();
    const record = written();
    Object.assign(record.dashboardVariables as Record_, { dose: 19.5, drink: 40, grind: 2.9, rpm: 950 });
    const other = profileAtBrewTemperature(library.profiles.find((candidate) => candidate.profile.title !== "Adaptive v3")!.profile, 92)!;
    const write = loadWrite(workflow, record, { profile: other })!;
    expect(write.write.context).toMatchObject({ targetDoseWeight: 19.5, targetYield: 40, grinderSetting: "2.9", extras: { rpm: 950 } });
    expect(write.before).toMatchObject({ dose: { before: 18.5, written: 19.5 }, grind: { written: "2.9" }, rpm: { written: 950 } });
    expect(write.write.profile).toEqual(other);
  });

  it("writes nothing to a Workflow holding it all, and leaves a value the recipe holds none of", () => {
    const workflow = appliedAtOwnTemperatures();
    const record = written();
    const first = loadWrite(workflow, record, { profile })!.write;
    const after = structuredClone(workflow);
    after.context = { ...(after.context as Record_), ...(first.context as Record_), extras: { ...((after.context as Record_).extras as Record_), ...((first.context as Record_).extras as Record_) } };
    after.hotWaterData = { ...(after.hotWaterData as Record_), ...(first.hotWaterData as Record_) };
    expect(loadWrite(after, record, { profile })).toBeNull();
    const bare = { ...record, beanBatchId: null, [RECIPE_FIELD]: { hotWaterData: { targetTemperature: null, duration: null, volume: null, flow: null } } };
    expect(loadWrite(after, bare, { profile: null })).toBeNull();
  });

  it("leaves out what it is told to, as the hot water while Decaid refuses it for want of a machine", () => {
    const workflow = applied("dye2-applies", "applySlot1");
    const write = loadWrite(workflow, written(), { profile }, new Set(["targetTemperature", "duration", "volume", "flow"]))!;
    expect(write.write).not.toHaveProperty("hotWaterData");
    expect(Object.keys(write.before)).not.toContain("volume");
  });
});

describe("whether DYE2's selection holds for the Workflow, as DYE2 judges it", () => {
  const workflow = applied("dye2-applies", "applySlot1");
  const context = workflow.context as Record_;
  const BATCH = "837c5af9-aa43-44ed-a857-5009969e3217";
  /** The Workflow with its `context` changed so. */
  const withContext = (change: Record_) => ({ ...workflow, context: { ...context, ...change } });
  /** A selection made on the Workflow, with the batch given. */
  const armed = { fingerprint: dye2Fingerprint(workflow.profile), batch: BATCH, grinder: context.grinderId as string };

  it("holds on the profile, batch and grinder it was made on, a brew temperature changed, or a batch set where it was made on none", () => {
    expect(selectedOn(armed, withContext({ beanBatchId: BATCH }))).toBe(true);
    expect(selectedOn(armed, { ...withContext({ beanBatchId: BATCH }), profile: profileAtBrewTemperature(workflow.profile, 90) })).toBe(true);
    expect(selectedOn({ ...armed, batch: null }, withContext({ beanBatchId: "another" }))).toBe(true);
    expect(selectedOn({ fingerprint: null, batch: null, grinder: null }, workflow)).toBe(true);
  });

  it("holds on what a Workflow holds, as a selection made on it now", () => {
    expect(armedOn(withContext({ beanBatchId: BATCH }))).toEqual(armed);
    expect(selectedOn(armedOn(workflow), withContext({ beanBatchId: BATCH }))).toBe(true);
    expect(selectedOn(armedOn(withContext({ beanBatchId: BATCH })), withContext({ beanBatchId: "another" }))).toBe(false);
  });

  it("does not hold on another profile, batch or grinder, or a batch or grinder cleared, nor before a Workflow is seen", () => {
    const other = { ...(workflow.profile as Record_), title: "Another" };
    expect(selectedOn(armed, { ...withContext({ beanBatchId: BATCH }), profile: other })).toBe(false);
    expect(selectedOn(armed, withContext({ beanBatchId: "another" }))).toBe(false);
    expect(selectedOn(armed, withContext({ beanBatchId: null }))).toBe(false);
    expect(selectedOn(armed, withContext({ beanBatchId: BATCH, grinderId: "another" }))).toBe(false);
    expect(selectedOn(armed, withContext({ beanBatchId: BATCH, grinderId: "" }))).toBe(false);
    expect(selectedOn(armed, undefined)).toBe(false);
  });

  it("is cleared by a write changing the profile, batch or grinder, and not by one of the dial", () => {
    const at = (context: Record_) => ({ context });
    expect(clearsSelection(workflow, at({ targetDoseWeight: 19.5, grinderSetting: "3.3" }))).toBe(false);
    expect(clearsSelection(workflow, { profile: profileAtBrewTemperature(workflow.profile, 90) })).toBe(false);
    expect(clearsSelection(workflow, { profile: { ...(workflow.profile as Record_), title: "Another" } })).toBe(true);
    expect(clearsSelection(workflow, at({ beanBatchId: BATCH }))).toBe(true);
    expect(clearsSelection(withContext({ beanBatchId: BATCH }), at({ beanBatchId: null }))).toBe(true);
    expect(clearsSelection(workflow, at({ grinderId: "another" }))).toBe(true);
    expect(clearsSelection(workflow, at({ grinderId: context.grinderId }))).toBe(false);
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
