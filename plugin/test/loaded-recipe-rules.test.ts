import fs from "node:fs";
import {
  RECIPE_SETTINGS,
  RECIPE_SETTING_NAMES,
  type RecipeSetting,
  dye2Fingerprint,
  dye2RecipeIdOf,
  profileAtBrewTemperature,
  shiftedTemperatures,
  workflowValueAt,
} from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { clearRecipe, loadWrite, loadable, profileKey, steamBackOnWrite, steamOnAt, vacatedIds } from "../src/loaded-recipe-rules.js";

// Module tests for what the plugin writes into the Workflow as it loads a
// Recipe the Workflow names, or as steam is turned back on with one loaded
// (ADR-0022), how it tells a write that changes
// the profile, as DYE2 fingerprints one, and which records a post of DYE2's
// recipes takes from the Workflow. With what DYE2 and Streamline were
// recorded holding and applying on Decaid's Linux release
// (server/test/fixtures/decaid/dye2-v0.1.26/), or records derived from them
// by the named changes.

type Record_ = Record<string, unknown>;

function read<T>(file: string): T {
  return JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/dye2-v0.1.26/${file}.json`, import.meta.url), "utf8")) as T;
}

const library = read<{ profiles: { id: string; profile: Record_ }[]; workflow: Record_; profileCopies: Record<string, Record_> }>("library");

/** A file of the recording, each `{"$profile": name}` in it the copy of that profile in library.json (its README's Edits). */
function fixture<T>(file: string): T {
  const profiles = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(profiles);
    if (!value || typeof value !== "object") return value;
    const record = value as Record_;
    if (Object.keys(record).length === 1 && typeof record.$profile === "string") return structuredClone(library.profileCopies[record.$profile]);
    return Object.fromEntries(Object.entries(record).map(([key, field]) => [key, profiles(field)]));
  };
  return profiles(read(file)) as T;
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

  it("reads a step limiter of value 0 as none, as Streamline sends it, so a profile Streamline sent is the same profile (dye2#32)", () => {
    const steps = (profile.steps as Record_[]).map((step) => ({ ...step, limiter: { value: 0, range: 0.6 } }));
    expect(dye2Fingerprint({ ...profile, steps })).toBe(dye2Fingerprint({ ...profile, steps: steps.map((step) => ({ ...step, limiter: null })) }));
    expect(dye2Fingerprint({ ...profile, steps: steps.map(({ limiter: _, ...step }) => step) })).toBe(dye2Fingerprint({ ...profile, steps }));
    expect(dye2Fingerprint({ ...profile, steps: steps.map((step) => ({ ...step, limiter: { value: 2, range: 0.6 } })) })).not.toBe(dye2Fingerprint({ ...profile, steps }));
  });
});

describe("an unload", () => {
  it("clears the recipe the Workflow names, alone, as DYE2 does", () => {
    expect(dye2RecipeIdOf(clearRecipe())).toBeNull();
    expect(clearRecipe()).toEqual({ context: { extras: { dye: { recipeId: null } } } });
  });
});

describe("recording a load", () => {
  const batch = "78bfdaaf-0fe9-49f3-9db4-b7d6c1f514d7";
  /** Every steam, hot water and flush setting, held by recipe `1` as the server writes it. */
  const settings: Record<RecipeSetting, number> = {
    steamTemperature: 150,
    steamDuration: 25,
    steamFlow: 1.4,
    steamStopTemperature: 60,
    hotWaterTemperature: 85,
    hotWaterDuration: 40,
    hotWaterVolume: 120,
    hotWaterFlow: 7.5,
    flushTemperature: 88,
    flushDuration: 4,
    flushFlow: 5.5,
  };
  /** Recipe `1` as the server writes it: its Bean Batch beside its Bean, as DYE2 holds one, and every setting in its `dashboardVariables`. */
  const written = (): Record_ => {
    const record: Record_ = { ...recipe("1"), beanBatchId: batch };
    for (const setting of RECIPE_SETTING_NAMES) (record.dashboardVariables as Record_)[RECIPE_SETTINGS[setting].dye2] = settings[setting];
    return record;
  };
  /** The settings the write sets, by the Workflow's paths. */
  const settingsWritten = (write: Record_) =>
    Object.fromEntries(RECIPE_SETTING_NAMES.flatMap((setting) => (workflowValueAt(write, RECIPE_SETTINGS[setting].workflow) === undefined ? [] : [[setting, workflowValueAt(write, RECIPE_SETTINGS[setting].workflow)]])));
  const adaptive = library.profiles.find((candidate) => candidate.profile.title === "Adaptive v3")!.profile;
  /** Recipe `1`'s Profile at its brew temperature, as the Workflow embedded in its record holds it. */
  const profile = profileAtBrewTemperature(adaptive, 92)!;
  const basket = (recipe("1").dashboardVariables as Record_).basketId as string;
  /**
   * Recipe `1` applied from DYE2's Select Recipe, but for the Profile at its own step
   * temperatures, as a skin applying it from a copy read before its brew
   * temperature changed.
   */
  const appliedAtOwnTemperatures = (): Record_ => ({ ...applied("dye2-applies", "applyFromSelectRecipe"), profile: structuredClone(adaptive) });

  it("writes what the Workflow lacks of the recipe's current values, its batch and its steam, hot water and flush settings, but no brew temperature or recipe id", () => {
    const workflow = appliedAtOwnTemperatures();
    const write = loadWrite(workflow, written(), { profile })!;
    expect(write.context).toEqual({
      beanBatchId: batch,
      coffeeName: "Fixture Ethiopia",
      coffeeRoaster: "Fixture Roasters",
      extras: { basketId: basket, basketName: "Fixture 18g Precision" },
    });
    // Only those the Workflow holds otherwise, as partial parts Decaid merges.
    const differing = RECIPE_SETTING_NAMES.filter((setting) => workflowValueAt(workflow, RECIPE_SETTINGS[setting].workflow) !== settings[setting]);
    expect(differing.length).toBeGreaterThan(6);
    expect(settingsWritten(write)).toEqual(Object.fromEntries(differing.map((setting) => [setting, settings[setting]])));
    // DYE2 and Streamline apply the recipe's brew temperature themselves (decentespresso/dye2#26): the profile's is left.
    expect(write).not.toHaveProperty("profile");
  });

  it("writes the recipe's current dial over a stale copy's, and its Profile at its brew temperature where the Workflow's is another", () => {
    const workflow = appliedAtOwnTemperatures();
    const record = written();
    Object.assign(record.dashboardVariables as Record_, { dose: 19.5, drink: 40, grind: 2.9, rpm: 950 });
    const other = profileAtBrewTemperature(library.profiles.find((candidate) => candidate.profile.title !== "Adaptive v3")!.profile, 92)!;
    const write = loadWrite(workflow, record, { profile: other })!;
    expect(write.context).toMatchObject({ targetDoseWeight: 19.5, targetYield: 40, grinderSetting: "2.9", extras: { rpm: 950 } });
    expect(write.profile).toEqual(other);
    expect(dye2Fingerprint(write.profile)).not.toBe(dye2Fingerprint(workflow.profile));
    // A grind setting the Workflow holds as written otherwise, `.5` for the recipe's 0.5, is the same one, as the server judges it.
    Object.assign(record.dashboardVariables as Record_, { grind: 0.5 });
    const typed = { ...workflow, context: { ...(workflow.context as Record_), grinderSetting: ".5" } };
    expect((loadWrite(typed, record, { profile: other })!.context as Record_).grinderSetting).toBeUndefined();
  });

  it("writes nothing to a Workflow holding it all, and leaves a value the recipe holds none of", () => {
    const workflow = appliedAtOwnTemperatures();
    const record = written();
    const first = loadWrite(workflow, record, { profile })!;
    const after = structuredClone(workflow);
    after.context = { ...(after.context as Record_), ...(first.context as Record_), extras: { ...((after.context as Record_).extras as Record_), ...((first.context as Record_).extras as Record_) } };
    for (const part of ["steamSettings", "hotWaterData", "rinseData"]) after[part] = { ...(after[part] as Record_), ...(first[part] as Record_) };
    expect(loadWrite(after, record, { profile })).toBeNull();
    // A setting the recipe holds none of is the Machine's own.
    const bare = { ...record, beanBatchId: null, dashboardVariables: { ...(record.dashboardVariables as Record_), steamTempC: null, flushS: null } };
    const otherwise = { ...after, steamSettings: { ...(after.steamSettings as Record_), targetTemperature: 160 }, rinseData: { ...(after.rinseData as Record_), duration: 9 } };
    expect(loadWrite(otherwise, bare, { profile: null })).toBeNull();
  });

  it("clears the Workflow's batch, coffee and roaster for a recipe naming no Bean, as DYE2 v0.1.32 applies one, but writes none where it holds none", () => {
    const beanless: Record_ = { ...written() };
    for (const field of ["beanId", "beanName", "beanRoaster", "beanBatchId"]) delete beanless[field];
    const workflow = appliedAtOwnTemperatures();
    workflow.context = { ...(workflow.context as Record_), beanBatchId: batch };
    const write = loadWrite(workflow, beanless, { profile })!;
    expect(write.context).toMatchObject({ beanBatchId: null, coffeeName: null, coffeeRoaster: null });
    const context = workflow.context as Record_;
    const cleared: Record_ = { ...workflow, context: { ...context, ...(write.context as Record_), extras: { ...(context.extras as Record_), ...((write.context as Record_).extras as Record_) } } };
    for (const part of ["steamSettings", "hotWaterData", "rinseData"]) cleared[part] = { ...(workflow[part] as Record_), ...(write[part] as Record_) };
    expect(loadWrite(cleared, beanless, { profile })).toBeNull();
    expect(loadWrite(workflow, beanless, { profile }, new Set(["batch", ...RECIPE_SETTING_NAMES]))?.context).not.toHaveProperty("beanBatchId");
  });

  it("writes no steam temperature into a Workflow whose steam is off, but the rest of its steam settings", () => {
    const workflow = appliedAtOwnTemperatures();
    workflow.steamSettings = { ...(workflow.steamSettings as Record_), targetTemperature: 0, duration: 0 };
    const write = loadWrite(workflow, written(), { profile })!;
    expect(write.steamSettings).toEqual({ duration: 25, flow: 1.4, stopAtTemperature: 60 });
  });

  it("leaves out what it is told to, as the steam, hot water and flush settings while Decaid refuses them for want of a machine", () => {
    const workflow = applied("dye2-applies", "applyFromSelectRecipe");
    const write = loadWrite(workflow, written(), { profile }, new Set(RECIPE_SETTING_NAMES))!;
    for (const part of ["steamSettings", "hotWaterData", "rinseData"]) expect(write).not.toHaveProperty(part);
  });
});

describe("steam turned back on with a recipe loaded", () => {
  /** The Workflow DYE2's Select Recipe applied recipe `1` with, its steam at that temperature. */
  const steamAt = (targetTemperature: unknown): Record_ => {
    const workflow = applied("dye2-applies", "applyFromSelectRecipe");
    workflow.steamSettings = { ...(workflow.steamSettings as Record_), targetTemperature };
    return workflow;
  };
  /** Recipe `1` holding that steam temperature, as the server writes it. */
  const holding = (steamTempC: unknown): Record_ => {
    const record = recipe("1");
    record.dashboardVariables = { ...(record.dashboardVariables as Record_), steamTempC };
    return record;
  };

  it("is on at a steam temperature of 135 °C or more, as Decaid judges it, and off below it or with none", () => {
    expect([135, 150, 165].map((on) => steamOnAt(steamAt(on)))).toEqual([135, 150, 165]);
    // Its record's as text, as Decaid reads a number.
    expect(steamOnAt(steamAt("150"))).toBe(150);
    expect([0, 120, 134, undefined, null].map((off) => steamOnAt(steamAt(off)))).toEqual([null, null, null, null, null]);
  });

  it("writes the recipe's steam temperature into a Workflow still holding the one steam came back at, and nothing else", () => {
    expect(steamBackOnWrite(steamAt(150), holding(160), 150)).toEqual({ steamSettings: { targetTemperature: 160 } });
    // Its record's as DYE2's editor saves it, as text.
    expect(steamBackOnWrite(steamAt(150), holding("158"), 150)).toEqual({ steamSettings: { targetTemperature: 158 } });
  });

  it("writes nothing where the recipe holds no steam temperature, holds Off, holds the one steam came back at, or the Workflow has moved on since", () => {
    expect(steamBackOnWrite(steamAt(150), holding(undefined), 150)).toBeNull();
    // "Off" as DYE2's editor saves it, which the server writes the Recipe's back over.
    expect(steamBackOnWrite(steamAt(150), holding(0), 150)).toBeNull();
    expect(steamBackOnWrite(steamAt(160), holding(160), 160)).toBeNull();
    // A temperature set once steam was on, which is the Recipe's edit, or steam turned off again.
    expect(steamBackOnWrite(steamAt(145), holding(160), 150)).toBeNull();
    expect(steamBackOnWrite(steamAt(0), holding(160), 150)).toBeNull();
  });
});

describe("the records a post of DYE2's recipes vacates", () => {
  const LAB = "1b3d5f7a-9c1e-4a3b-8d5f-7a9c1e3b5d7f";
  const UPTOWN = "3d5f7b9c-2e4a-4c6d-8f9b-9c2e4a6d8f1b";
  /** One of the recording's recipes under an id, carrying a Recipe's global id or none. */
  const record = (id: string, globalId: string | null = null): Record_ => ({ ...keys.recipes[0], id, ...(globalId === null ? {} : { decentSyncId: globalId }) });

  it("names each record the post removes, or gives to another Recipe's, as a Machine joining another Location whose Recipe has its id", () => {
    // The tablet's own recipe removed, and the lab's Recipe under "2" replaced with Uptown's, saved under that slot number.
    expect(vacatedIds([record("1"), record("2", LAB)], [record("2", UPTOWN)])).toEqual(["1", "2"]);
    expect(vacatedIds([record("2", LAB)], [])).toEqual(["2"]);
  });

  it("names none the post keeps, writes, gives its global id or adds", () => {
    expect(vacatedIds([record("2", LAB)], [{ ...record("2", LAB), name: "Renamed", stripSlot: 4 }])).toEqual([]);
    // A Location taking the tablet's own recipe in writes its global id into it: the same recipe.
    expect(vacatedIds([record("8b0f…")], [record("8b0f…", UPTOWN)])).toEqual([]);
    expect(vacatedIds([], [record("3", UPTOWN)])).toEqual([]);
  });
});

describe("the records that can be a Loaded Recipe", () => {
  it("are those carrying a Recipe's global id, in a Recipe Slot or not, by their ids", () => {
    const LAB = "1b3d5f7a-9c1e-4a3b-8d5f-7a9c1e3b5d7f";
    const records = [
      { ...keys.recipes[0], id: "recipe-mh2k1", stripSlot: null, decentSyncId: LAB },
      { ...keys.recipes[0], id: "3", stripSlot: 3 },
    ];
    expect([...loadable(records).entries()].map(([id, { globalId }]) => [id, globalId])).toEqual([["recipe-mh2k1", LAB]]);
  });
});
