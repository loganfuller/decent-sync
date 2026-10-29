import { RECIPE_SETTING_NAMES } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  PARTS,
  type WorkflowParts,
  dueParts,
  heldAlready,
  heldByRecord,
  partsWrite,
  readBase,
  readParts,
  recipeParts,
  RECORDED_PARTS,
  valuesFromWorkflow,
  workflowParts,
} from "../src/library/loaded-recipe-intake.js";
import type { FieldEdits } from "../src/library/merge.js";
import { withoutOwnEdits } from "../src/library/recipe-intake.js";

// How the parts of a Workflow that follow its Loaded Recipe map to the
// Recipe's content, both ways (ADR-0022, tickets #146, #173 and #216): which
// DYE2 saves into the Recipe's record, which Decent Sync takes in itself,
// and what is written into a Workflow that has it loaded, of what changed
// since it took the Recipe. Ids are made up.

const BATCH = "11111111-1111-4111-8111-111111111111";
const NEXT_BAG = "22222222-2222-4222-8222-222222222222";
const OTHER_BEANS_BATCH = "33333333-3333-4333-8333-333333333333";
const BEAN = "44444444-4444-4444-8444-444444444444";
const BASKET = "66666666-6666-4666-8666-666666666666";
const GRINDER = "77777777-7777-4777-8777-777777777777";
const OTHER_GRINDER = "88888888-8888-4888-8888-888888888888";

/** A Recipe, in the Library's terms. */
const CONTENT = {
  profileId: "profile:adaptive",
  grinderId: GRINDER,
  dose: 18,
  yield: 36,
  ratio: 2,
  grindSetting: 2.7,
  rpm: 900,
  beanId: BEAN,
  beanBatchId: BATCH,
  basketId: BASKET,
  steamTemperature: 150,
  steamDuration: 30,
  hotWaterTemperature: 88,
  hotWaterDuration: 40,
  hotWaterVolume: 120,
  hotWaterFlow: 7.5,
  flushDuration: 5,
};

/** A Workflow holding that Recipe, as Decaid keeps one, naming the tablet's records. */
const WORKFLOW = {
  profile: { title: "Adaptive v3", steps: [{ name: "pour", temperature: 92 }] },
  context: {
    targetDoseWeight: 18,
    targetYield: 36,
    grinderId: "g1",
    grinderModel: "Niche",
    grinderSetting: "2.7",
    beanBatchId: "b1",
    extras: { rpm: 900, basketId: "k1", basketName: "18g" },
  },
  steamSettings: { targetTemperature: 150, duration: 30, flow: 1.5, stopAtTemperature: 0 },
  hotWaterData: { targetTemperature: 88, duration: 40, volume: 120, flow: 7.5 },
  rinseData: { targetTemperature: 92, duration: 5, flow: 6 },
};

/** Its profile is the Library's `profile:adaptive`. */
const HELD: WorkflowParts = workflowParts(WORKFLOW, "profile:adaptive");

describe("A Workflow's parts that follow its Loaded Recipe", () => {
  it("are read as the Workflow holds them, the grind setting as text and the Basket and batch by the tablet's ids", () => {
    expect(HELD).toEqual({
      profile: "profile:adaptive",
      grinder: "g1",
      dose: 18,
      yield: 36,
      grind: "2.7",
      rpm: 900,
      basket: "k1",
      batch: "b1",
      // Its first step's temperature.
      brewTemperature: 92,
      steamTemperature: 150,
      steamDuration: 30,
      steamFlow: 1.5,
      steamStopTemperature: 0,
      hotWaterTemperature: 88,
      hotWaterDuration: 40,
      hotWaterVolume: 120,
      hotWaterFlow: 7.5,
      flushTemperature: 92,
      flushDuration: 5,
      flushFlow: 6,
    });
    expect(readParts(JSON.parse(JSON.stringify(HELD)))).toEqual(HELD);
    expect(workflowParts({ context: { grinderSetting: 3 } })).toMatchObject({ grind: "3", dose: null, batch: null });
  });

  it("are saved by DYE2 into the Recipe's record, every one but its Grinder, Bean Batch and Profile", () => {
    expect(RECORDED_PARTS).toEqual(["dose", "yield", "grind", "rpm", "basket", "brewTemperature", ...RECIPE_SETTING_NAMES]);
    expect(PARTS.filter((part) => !RECORDED_PARTS.includes(part))).toEqual(["profile", "grinder", "batch"]);
  });
});

describe("What Decent Sync takes into a Recipe from its Machine's Workflow", () => {
  const items: Record<string, string> = { "beanBatch:b2": NEXT_BAG, "beanBatch:b3": OTHER_BEANS_BATCH, "basket:k1": BASKET, "grinder:g2": OTHER_GRINDER, "grinder:g9": "99999999-9999-4999-8999-999999999999" };
  const context = {
    item: (kind: string, localId: string) => items[`${kind}:${localId}`],
    grinders: new Set([GRINDER, OTHER_GRINDER]),
    batchBeans: new Map([
      [NEXT_BAG, BEAN],
      [OTHER_BEANS_BATCH, "55555555-5555-4555-8555-555555555555"],
    ]),
  };
  const locals: Record<string, string> = { [`grinder:${GRINDER}`]: "g1", [`basket:${BASKET}`]: "k1", [`beanBatch:${BATCH}`]: "b1" };
  const local = (kind: string, itemId: string) => locals[`${kind}:${itemId}`];

  it("is a Grinder of the Location, and a batch of the Recipe's Bean, changed on the Machine, but not a batch of another Bean or a value cleared", () => {
    const target = recipeParts(CONTENT, local);
    const changed = { ...HELD, grinder: "g2", batch: "b2" };
    expect(valuesFromWorkflow(CONTENT, target, HELD, changed, context)).toEqual({ values: { grinderId: OTHER_GRINDER, beanBatchId: NEXT_BAG }, parts: ["grinder", "batch"] });
    // A batch of another Bean, a Grinder of no Location's, a value cleared: the Machine's own.
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, batch: "b3", grinder: "g9", basket: null, dose: null }, context)).toEqual({ values: {}, parts: [] });
    // A Recipe naming no Bean takes a batch picked while it is loaded with its Bean, as any change, but none on a load: it means
    // no bean as it is loaded, as DYE2 v0.1.32 applies one.
    const { beanId: _, beanBatchId: __, ...beanless } = CONTENT;
    expect(valuesFromWorkflow(beanless, recipeParts(beanless, local), HELD, { ...HELD, batch: "b3" }, context).values).toEqual({
      beanBatchId: OTHER_BEANS_BATCH,
      beanId: "55555555-5555-4555-8555-555555555555",
    });
    expect(valuesFromWorkflow(beanless, recipeParts(beanless, local), null, { ...HELD, batch: "b3" }, context).values).not.toHaveProperty("beanBatchId");
  });

  it("is a dial value the Recipe holds none of, changed on the Machine, which DYE2 saves none of, the grind setting a number where it reads as one and the text as typed otherwise", () => {
    const { rpm: _, basketId: __, grindSetting: ___, ...bare } = CONTENT;
    const target = recipeParts(bare, local);
    const held = { ...HELD, basket: null };
    const changed = { ...HELD, rpm: 950, basket: "k1", grind: "3.1" };
    expect(valuesFromWorkflow(bare, target, held, changed, context)).toEqual({ values: { grindSetting: 3.1, rpm: 950, basketId: BASKET }, parts: ["grind", "rpm", "basket"] });
    // As DYE2 v0.1.32 saves one (d858b73): a three-dial grinder's setting, or a word.
    for (const typed of ["1.5.", "fine"]) expect(valuesFromWorkflow(bare, target, held, { ...held, grind: ` ${typed} ` }, context).values).toEqual({ grindSetting: typed });
    // One the Recipe holds is DYE2's to save; one unchanged is no edit.
    expect(valuesFromWorkflow(CONTENT, recipeParts(CONTENT, local), HELD, { ...HELD, rpm: 950 }, context).values).toEqual({});
    expect(valuesFromWorkflow(bare, target, HELD, HELD, context).values).toEqual({});
  });

  it("is, on a load, each of those values the Recipe holds none of, as the Workflow stands, never one it holds", () => {
    const { rpm: _, basketId: __, grinderId: ___, beanBatchId: ____, ...bare } = CONTENT;
    const now = { ...HELD, grinder: "g2", batch: "b2" };
    expect(valuesFromWorkflow(bare, recipeParts(bare, local), null, now, context)).toEqual({
      values: { rpm: 900, basketId: BASKET, grinderId: OTHER_GRINDER, beanBatchId: NEXT_BAG },
      parts: ["rpm", "basket", "grinder", "batch"],
    });
    expect(valuesFromWorkflow(CONTENT, recipeParts(CONTENT, local), null, now, context).values).toEqual({});
  });
});

describe("The parts of its Loaded Recipe a Workflow is due", () => {
  const locals: Record<string, string> = { [`grinder:${GRINDER}`]: "g1", [`basket:${BASKET}`]: "k1", [`beanBatch:${BATCH}`]: "b1", [`beanBatch:${NEXT_BAG}`]: "b2" };
  const local = (kind: string, itemId: string) => locals[`${kind}:${itemId}`];

  it("are those the Recipe holds that the Workflow holds otherwise, once, on a load", () => {
    const target = recipeParts({ ...CONTENT, dose: 18.5 }, local);
    const base = heldAlready(target, HELD);
    expect(base).not.toHaveProperty("dose");
    expect(base).toMatchObject({ grind: "2.7", batch: "b1" });
    expect(dueParts(target, HELD, base)).toMatchObject({ dose: 18.5, grind: undefined, batch: undefined });
    // Once the Workflow took it, written or kept, nothing is due again.
    expect(Object.values(dueParts(target, HELD, { ...base, dose: 18.5 })).every((part) => part === undefined)).toBe(true);
  });

  it("are not the Machine's own since, a batch of another Bean, a value cleared or steam off, until the Recipe changes them", () => {
    const target = recipeParts(CONTENT, local);
    const base = heldAlready(target, HELD);
    const own = { ...HELD, batch: "b9", dose: null, steamTemperature: 0 };
    expect(Object.values(dueParts(target, own, base)).every((part) => part === undefined)).toBe(true);
    // An edit of the Recipe elsewhere is due, over the Machine's own.
    const edited = recipeParts({ ...CONTENT, beanBatchId: NEXT_BAG, dose: 19 }, local);
    expect(dueParts(edited, own, base)).toMatchObject({ batch: "b2", dose: 19, steamTemperature: undefined });
    expect(readBase(JSON.parse(JSON.stringify(base)))).toEqual(base);
  });

  it("carry the Recipe's brew temperature with a Profile written whole", () => {
    const target = recipeParts({ ...CONTENT, profileId: "profile:classic", brewTemperature: 92 }, local);
    expect(dueParts(target, HELD, heldAlready(target, HELD))).toMatchObject({ profile: "profile:classic", brewTemperature: 92 });
  });
});

describe("What a Workflow is written of its Loaded Recipe", () => {
  const locals: Record<string, string> = {
    [`beanBatch:${NEXT_BAG}`]: "b2",
    [`beanBatch:${BATCH}`]: "b1",
    [`basket:${BASKET}`]: "k1",
    [`grinder:${GRINDER}`]: "g1",
    [`grinder:${OTHER_GRINDER}`]: "g2",
  };
  const local = (kind: string, itemId: string) => locals[`${kind}:${itemId}`];
  const CLASSIC = { title: "Classic Italian espresso", steps: [{ name: "pour" }] };
  const names = { profile: CLASSIC, grinderModel: "EK43", basketName: "18g", coffeeName: "Ethiopia", coffeeRoaster: "Fixture Roasters" };

  it("is its Grinder, with its model, and its Profile whole, expecting nothing of the Profile, at the Recipe's brew temperature, or its first step's", () => {
    expect(partsWrite(recipeParts({ ...CONTENT, grinderId: OTHER_GRINDER, profileId: "profile:classic" }, local), HELD, names)).toEqual({
      fields: { profile: CLASSIC, "context.grinderId": "g2", "context.grinderModel": "EK43" },
      expected: { "context.grinderId": "g1" },
    });
    // The Profile written holds its own step temperatures, so the Recipe's brew temperature is written with it, whatever the
    // Workflow held.
    expect(partsWrite(recipeParts({ ...CONTENT, profileId: "profile:classic", brewTemperature: 92 }, local), HELD, names)).toEqual({
      fields: { profile: CLASSIC, "profile.steps.0.temperature": 92 },
      expected: {},
    });
    expect(recipeParts({ ...CONTENT }, local, 94).brewTemperature).toBe(94);
    expect(recipeParts({ ...CONTENT, brewTemperature: 91 }, local, 94).brewTemperature).toBe(91);
    // A Profile the Library does not hold whole is not written.
    expect(partsWrite(recipeParts({ ...CONTENT, profileId: "profile:classic" }, local), HELD, { ...names, profile: null })).toBeNull();
  });

  it("is each field of the Recipe's it holds otherwise, by the tablet's ids, expecting what it held, with the names DYE2 copies", () => {
    const target = recipeParts({ ...CONTENT, dose: 18.5, grindSetting: 2.8, beanBatchId: NEXT_BAG, hotWaterVolume: 140, steamTemperature: 155, flushFlow: 5 }, local);
    expect(partsWrite(target, HELD, names)).toEqual({
      fields: {
        "context.targetDoseWeight": 18.5,
        "context.grinderSetting": "2.8",
        "context.beanBatchId": "b2",
        "context.coffeeName": "Ethiopia",
        "context.coffeeRoaster": "Fixture Roasters",
        "steamSettings.targetTemperature": 155,
        "hotWaterData.volume": 140,
        "rinseData.flow": 5,
      },
      expected: {
        "context.targetDoseWeight": 18,
        "context.grinderSetting": "2.7",
        "context.beanBatchId": "b1",
        "steamSettings.targetTemperature": 150,
        "hotWaterData.volume": 120,
        "rinseData.flow": 6,
      },
    });
  });

  it("is the Recipe's brew temperature, expecting the Workflow's first step's", () => {
    expect(partsWrite(recipeParts({ ...CONTENT, brewTemperature: 90 }, local), HELD, names)).toEqual({
      fields: { "profile.steps.0.temperature": 90 },
      expected: { "profile.steps.0.temperature": 92 },
    });
  });

  it("is nothing where it holds the Recipe's, a grind setting as a number, nor a field the Recipe holds none of", () => {
    expect(partsWrite(recipeParts(CONTENT, local), HELD, names)).toBeNull();
    expect(partsWrite(recipeParts({ dose: 18 }, local), { ...HELD, grind: "9" }, names)).toBeNull();
  });

  it("waits for a batch or Basket the tablet holds no record of yet, and works out the yield from the ratio where it holds none", () => {
    const { yield: _, ...ratioOnly } = CONTENT;
    const target = recipeParts({ ...ratioOnly, dose: 19, beanBatchId: OTHER_BEANS_BATCH }, local);
    expect(target).toMatchObject({ yield: 38, batch: undefined });
    expect(partsWrite(target, HELD, names)?.fields).toEqual({ "context.targetDoseWeight": 19, "context.targetYield": 38 });
  });
});

describe("The dial written into a Workflow", () => {
  const target = { ...HELD, profile: "profile:classic", grinder: "g2", batch: "b2", dose: 19, yield: 38, grind: "3.1", rpm: 950, basket: "k2" };
  const current = {
    profileId: "profile:classic",
    beanBatchId: "b2",
    dashboardVariables: { grinderId: "g2", dose: 19, ratio: 2, grind: 3.1, rpm: 950, basketId: "k2", brewC: 92 },
  };

  it("waits for the tablet's record of the Recipe to hold it, as DYE2 records the Workflow's dial into the record, its Grinder, batch and the rest going ahead", () => {
    const stale = { profileId: "profile:adaptive", beanBatchId: "b1", dashboardVariables: { grinderId: "g1", dose: 18, drink: 36, grind: 2.7, rpm: 900, basketId: "k1" } };
    expect(heldByRecord(target, stale)).toEqual({
      ...target,
      profile: undefined,
      dose: undefined,
      yield: undefined,
      grind: undefined,
      rpm: undefined,
      basket: undefined,
      brewTemperature: undefined,
    });
    // A yield worked out from the ratio, and a grind setting as a number, are held.
    expect(heldByRecord(target, current)).toEqual(target);
    expect(heldByRecord(target, null)).toMatchObject({ profile: undefined, grinder: "g2", batch: "b2", dose: undefined, rpm: undefined, hotWaterFlow: 7.5 });
  });
});

describe("An edit read from a tablet's recipe record", () => {
  const edits: FieldEdits = {
    dose: { at: "2026-10-15T10:00:00.000Z", decidedAt: "2026-10-15T10:00:00.000Z", tabletId: "tablet-a", versionId: "1" },
    brewTemperature: { at: "2026-10-15T09:00:00.000Z", decidedAt: "2026-10-15T09:00:00.000Z", tabletId: "tablet-b", versionId: "0" },
  };

  it("leaves out a field the Recipe holds already by the same tablet's own latest edit, as its Workflow brought it first", () => {
    expect(withoutOwnEdits({ dose: 20, brewTemperature: 94 }, { dose: 20, brewTemperature: 93 }, edits, "tablet-a")).toEqual({ brewTemperature: 94 });
    // Another tablet's, or another value, is its edit.
    expect(withoutOwnEdits({ dose: 20 }, { dose: 20 }, edits, "tablet-b")).toEqual({ dose: 20 });
    expect(withoutOwnEdits({ dose: 21 }, { dose: 20 }, edits, "tablet-a")).toEqual({ dose: 21 });
  });
});
