import { RECIPE_SETTING_NAMES, profileAtBrewTemperature } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  BEAN_TAKEN,
  PARTS,
  type WorkflowParts,
  dueParts,
  heldAlready,
  heldByRecord,
  nonePart,
  partsWrite,
  readBase,
  readParts,
  recipeBean,
  recipeParts,
  RECORDED_PARTS,
  samePart,
  valuesFromWorkflow,
  workflowParts,
} from "../src/library/loaded-recipe-intake.js";
import type { FieldEdits } from "../src/library/merge.js";
import { withoutOwnEdits } from "../src/library/recipe-intake.js";

// How the parts of a Workflow that follow its Loaded Recipe map to the
// Recipe's content, both ways (ADR-0022, tickets #146, #173, #216, #550 and #570):
// which DYE2 saves into the Recipe's record, which Decent Sync takes in
// itself, and what is written into a Workflow that has it loaded, or cleared
// from it, of what changed since it took the Recipe. Ids are made up.

const BATCH = "11111111-1111-4111-8111-111111111111";
const NEXT_BAG = "22222222-2222-4222-8222-222222222222";
const OTHER_BEANS_BATCH = "33333333-3333-4333-8333-333333333333";
const BEAN = "44444444-4444-4444-8444-444444444444";
const OTHER_BEAN = "55555555-5555-4555-8555-555555555555";
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
  feedRate: "MF",
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
    extras: { rpm: 900, feedRate: "MF", basketId: "k1", basketName: "18g" },
  },
  steamSettings: { targetTemperature: 150, duration: 30, flow: 1.5, stopAtTemperature: 0 },
  hotWaterData: { targetTemperature: 88, duration: 40, volume: 120, flow: 7.5 },
  rinseData: { targetTemperature: 92, duration: 5, flow: 6 },
};

/** Its profile is the Library's `profile:adaptive`. */
const HELD: WorkflowParts = workflowParts(WORKFLOW, "profile:adaptive");

describe("A Workflow's parts that follow its Loaded Recipe", () => {
  it("are read as the Workflow holds them, the grind setting and feed rate as text and the Basket and batch by the tablet's ids", () => {
    expect(HELD).toEqual({
      profile: "profile:adaptive",
      grinder: "g1",
      dose: 18,
      yield: 36,
      grind: "2.7",
      rpm: 900,
      feedRate: "MF",
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
    // A feed rate is text as typed, as DYE2 v0.1.34 keeps one, never coerced; a blank one is none.
    expect(workflowParts({ context: { extras: { feedRate: " 1200 " } } }).feedRate).toBe(" 1200 ");
    expect(workflowParts({ context: { extras: { feedRate: " " } } }).feedRate).toBeNull();
    expect(readParts({ feedRate: "SF" }).feedRate).toBe("SF");
  });

  it("compare a grind setting as a number however it is written where both read as one, as the plugin does, and otherwise as text", () => {
    // A barista's `.5` is DYE2's 0.5, which Decaid keeps as "0.5", so DYE2 saving the Workflow's `.5` saves no other setting.
    for (const [a, b] of [[".5", "0.5"], [".5", 0.5], ["5.", "5"], ["1e1", 10], ["2.70", "2.7"]] as const) expect(samePart("grind", a, b), `${a} ${b}`).toBe(true);
    for (const [a, b] of [[".5", "0.6"], ["1.5.", "1.5"], ["fine", "coarse"]] as const) expect(samePart("grind", a, b), `${a} ${b}`).toBe(false);
    expect(samePart("grind", readParts({ grind: 0.5 }).grind, ".5")).toBe(true);
  });

  it("hold none of a dose, grind setting or RPM at 0, as a Recipe does, and of a yield, as 0 is stop-at-weight off", () => {
    for (const [part, value] of [["dose", 0], ["rpm", 0], ["grind", 0], ["grind", "0"], ["grind", "0.0"], ["yield", 0], ["yield", null], ["basket", null]] as const) {
      expect(nonePart(part, value), `${part} ${String(value)}`).toBe(true);
      expect(samePart(part, value, null), `${part} ${String(value)}`).toBe(true);
    }
    // A feed rate is text, and a steam setting of 0 is a value, as a milk stop of 0 is off.
    for (const [part, value] of [["feedRate", "0"], ["steamStopTemperature", 0], ["dose", 18], ["grind", "fine"]] as const) expect(nonePart(part, value), `${part} ${value}`).toBe(false);
    expect(samePart("dose", 0, 18)).toBe(false);
    // As stored and compared, a 0 stays what the Workflow holds, so a write expects it there.
    expect(workflowParts({ context: { targetDoseWeight: 0, targetYield: 0, extras: { rpm: 0 } } })).toMatchObject({ dose: 0, yield: 0, rpm: 0 });
  });

  it("are saved by DYE2 into the Recipe's record, every one but its Grinder, Bean Batch and Profile", () => {
    expect(RECORDED_PARTS).toEqual(["dose", "yield", "grind", "rpm", "feedRate", "basket", "brewTemperature", ...RECIPE_SETTING_NAMES]);
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
    retired: new Set<string>(),
  };
  const locals: Record<string, string> = { [`grinder:${GRINDER}`]: "g1", [`basket:${BASKET}`]: "k1", [`beanBatch:${BATCH}`]: "b1" };
  const local = (kind: string, itemId: string) => locals[`${kind}:${itemId}`];

  it("is a Grinder of the Location, and a batch, changed on the Machine, with its Bean where it is another Bean's (#570), but not a batch the Library retired, a Grinder of no Location's or a value cleared", () => {
    const target = recipeParts(CONTENT, local);
    const changed = { ...HELD, grinder: "g2", batch: "b2" };
    expect(valuesFromWorkflow(CONTENT, target, HELD, changed, context)).toEqual({ values: { grinderId: OTHER_GRINDER, beanBatchId: NEXT_BAG }, parts: ["grinder", "batch"] });
    // A batch of another Bean: the Recipe's batch, and its Bean.
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, batch: "b3" }, context)).toEqual({
      values: { beanBatchId: OTHER_BEANS_BATCH, beanId: "55555555-5555-4555-8555-555555555555" },
      parts: ["batch"],
    });
    // A batch the Library retired, Archived, of an Archived Bean or finished at the Location, of the Recipe's Bean or
    // another, a Grinder of no Location's, a value cleared: the Machine's own.
    const retired = { ...context, retired: new Set([NEXT_BAG, OTHER_BEANS_BATCH]) };
    for (const batch of ["b2", "b3"]) expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, batch }, retired)).toEqual({ values: {}, parts: [] });
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, grinder: "g9", basket: null, dose: null, batch: null }, context)).toEqual({ values: {}, parts: [] });
    // A Recipe naming no Bean takes a batch picked while it is loaded with its Bean, as any change.
    const { beanId: _, beanBatchId: __, ...beanless } = CONTENT;
    expect(valuesFromWorkflow(beanless, recipeParts(beanless, local), HELD, { ...HELD, batch: "b3" }, context).values).toEqual({
      beanBatchId: OTHER_BEANS_BATCH,
      beanId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("is, with a Grinder picked on the Machine, the grind setting and RPM the Workflow holds after it, none included, as DYE2 v0.1.37 writes the grinder's defaults with it", () => {
    const target = recipeParts(CONTENT, local);
    // A grinder declaring a default grind setting and no RPM: the pick left 5 and none.
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, grinder: "g2", grind: "5", rpm: null }, context)).toEqual({
      values: { grinderId: OTHER_GRINDER, grindSetting: 5, rpm: null },
      parts: ["grinder", "grind", "rpm"],
    });
    // One declaring neither: "dial me in". A setting of 0, which a grinder may declare, is none of a Recipe's.
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, grinder: "g2", grind: null, rpm: null }, context).values).toEqual({ grinderId: OTHER_GRINDER, grindSetting: null, rpm: null });
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, grinder: "g2", grind: "0", rpm: 1100 }, context).values).toEqual({ grinderId: OTHER_GRINDER, grindSetting: null, rpm: 1100 });
    // The ones the Recipe holds already come with it as they are.
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, grinder: "g2" }, context)).toEqual({ values: { grinderId: OTHER_GRINDER }, parts: ["grinder"] });
    // Only with a Grinder the server records: a grind setting or RPM cleared beside the Recipe's own Grinder, or one of no
    // Location's, stays the Machine's own.
    expect(valuesFromWorkflow(CONTENT, target, { ...HELD, grinder: null }, { ...HELD, grind: null, rpm: null }, context)).toEqual({ values: {}, parts: [] });
    expect(valuesFromWorkflow(CONTENT, target, HELD, { ...HELD, grinder: "g9", grind: null, rpm: null }, context)).toEqual({ values: {}, parts: [] });
  });

  it("is a dose, yield, grind setting, RPM or feed rate the Recipe holds none of, changed on the Machine, which DYE2 saves none of, the grind setting a number where it reads as one and the text as typed otherwise, the feed rate as typed, but no Basket, which DYE2 v0.1.33 saves (#389)", () => {
    const bare: Record<string, unknown> = { ...CONTENT };
    for (const field of ["dose", "yield", "ratio", "rpm", "feedRate", "basketId", "grindSetting"]) delete bare[field];
    const target = recipeParts(bare, local);
    const held = { ...HELD, basket: null };
    const changed = { ...HELD, dose: 18.5, yield: 40, rpm: 950, feedRate: "1200", basket: "k1", grind: "3.1" };
    expect(valuesFromWorkflow(bare, target, held, changed, context)).toEqual({
      values: { dose: 18.5, yield: 40, grindSetting: 3.1, rpm: 950, feedRate: "1200" },
      parts: ["dose", "yield", "grind", "rpm", "feedRate"],
    });
    // A Basket picked after the load is DYE2's to save, as it moved off the none the Workflow held as the recipe was applied.
    expect(valuesFromWorkflow(bare, target, held, { ...held, basket: "k1" }, context)).toEqual({ values: {}, parts: [] });
    // As DYE2 v0.1.32 saves one (d858b73): a three-dial grinder's setting, or a word.
    for (const typed of ["1.5.", "fine"]) expect(valuesFromWorkflow(bare, target, held, { ...held, grind: ` ${typed} ` }, context).values).toEqual({ grindSetting: typed });
    // One the Recipe holds is DYE2's to save; one unchanged is no edit.
    expect(valuesFromWorkflow(CONTENT, recipeParts(CONTENT, local), HELD, { ...HELD, rpm: 950, feedRate: "SF" }, context).values).toEqual({});
    expect(valuesFromWorkflow(bare, target, HELD, HELD, context).values).toEqual({});
  });

  it("is never a 0: a Recipe holding no yield takes none from a Workflow whose yield is 0, which is stop-at-weight off, and takes 40 once a barista sets it", () => {
    const { yield: _, ratio: __, dose: ___, rpm: ____, ...bare } = CONTENT;
    const target = recipeParts(bare, local);
    expect(target).toMatchObject({ yield: null, dose: null, rpm: null });
    // As DYE2 v0.1.37 applies a recipe naming no yield, and as a barista turns stop-at-weight off.
    const off = { ...HELD, dose: null, yield: 0, rpm: null };
    expect(valuesFromWorkflow(bare, target, HELD, off, context)).toEqual({ values: {}, parts: [] });
    expect(valuesFromWorkflow(bare, target, off, { ...off, dose: 0, rpm: 0 }, context)).toEqual({ values: {}, parts: [] });
    expect(valuesFromWorkflow(bare, target, off, { ...off, yield: 40 }, context)).toEqual({ values: { yield: 40 }, parts: ["yield"] });
    // A Recipe holding a yield of 0 holds none to stop at: one set on the Machine is taken too, as DYE2 saves it.
    expect(valuesFromWorkflow({ ...bare, yield: 0 }, recipeParts({ ...bare, yield: 0 }, local), off, { ...off, yield: 40 }, context).values).toEqual({ yield: 40 });
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

  it("are not the Machine's own since, a batch the Library retired, a value cleared or steam off, until the Recipe changes them", () => {
    const target = recipeParts(CONTENT, local);
    const base = heldAlready(target, HELD);
    const own = { ...HELD, batch: "b9", dose: null, steamTemperature: 0 };
    expect(Object.values(dueParts(target, own, base)).every((part) => part === undefined)).toBe(true);
    // An edit of the Recipe elsewhere is due, over the Machine's own.
    const edited = recipeParts({ ...CONTENT, beanBatchId: NEXT_BAG, dose: 19 }, local);
    expect(dueParts(edited, own, base)).toMatchObject({ batch: "b2", dose: 19, steamTemperature: undefined });
    expect(readBase(JSON.parse(JSON.stringify(base)))).toEqual(base);
  });

  it("are cleared where the Recipe holds none of a part it is the whole Shot in and the Workflow still holds one, as on a load by a Skin that clears nothing, but never a setting the Machine keeps its own of", () => {
    const { grinderId: _, grindSetting: __, basketId: ___, dose: ____, yield: _____, ratio: ______, rpm: _______, feedRate: ________, beanBatchId: _________, steamDuration: __________, ...bare } = CONTENT;
    const target = recipeParts(bare, local);
    const base = heldAlready(target, HELD);
    expect(base).not.toHaveProperty("grinder");
    expect(dueParts(target, HELD, base)).toMatchObject({ grinder: null, grind: null, basket: null, dose: null, yield: null, rpm: null, feedRate: null, batch: null, steamDuration: undefined, brewTemperature: undefined });
    // One the Workflow holds none of already is taken, and so a 0, which is none.
    const cleared = { ...HELD, grinder: null, grind: null, basket: null, dose: 0, yield: 0, rpm: 0, feedRate: null, batch: null };
    expect(heldAlready(target, cleared)).toMatchObject({ grinder: null, dose: null, yield: null, rpm: null });
    expect(Object.values(dueParts(target, cleared, heldAlready(target, cleared))).every((part) => part === undefined)).toBe(true);
    // A Recipe holding a dose, grind setting or RPM of 0, as 1.10.0 may take one in, holds none.
    expect(recipeParts({ ...bare, dose: 0, grindSetting: 0, rpm: 0 }, local)).toMatchObject({ dose: null, grind: null, rpm: null });
  });

  it("are cleared in a Workflow that took a part since cleared from the Recipe, as any other edit reaches it, and not a steam time cleared from it, nor a value a barista set since on the Machine", () => {
    const base = heldAlready(recipeParts(CONTENT, local), HELD);
    const { basketId: _, steamDuration: __, ...edited } = CONTENT;
    expect(dueParts(recipeParts(edited, local), HELD, base)).toMatchObject({ basket: null, steamDuration: undefined, dose: undefined });
    // A Basket picked on the Machine once it took none, which DYE2 has not saved: the Machine's own, as before.
    const taken = { ...base, basket: null };
    expect(dueParts(recipeParts(edited, local), HELD, taken).basket).toBeUndefined();
  });

  it("are, where the Recipe names a Bean and no batch, its batch part cleared once the Recipe's Bean is another than the Workflow took, over a coffee typed on the Machine, and only then (#572)", () => {
    const { beanBatchId: _, ...beanOnly } = CONTENT;
    // A Workflow holding no batch, its coffee typed or the Bean's: the parts hold no coffee name.
    const held = { ...HELD, batch: null };
    const target = recipeParts(beanOnly, local);
    const base = { ...heldAlready(target, held), [BEAN_TAKEN]: BEAN };
    expect(Object.values(dueParts(target, held, base, recipeBean(beanOnly))).every((part) => part === undefined)).toBe(true);
    // The Recipe's Bean changed to another, from anywhere: due, cleared, so the write brings the Bean's name and roaster.
    const otherBean = { ...beanOnly, beanId: OTHER_BEAN };
    expect(dueParts(target, held, base, recipeBean(otherBean))).toMatchObject({ batch: null, beanDue: true });
    // Removed: due the same, the write clearing the name and roaster.
    const { beanId: __, ...noBean } = beanOnly;
    expect(dueParts(recipeParts(noBean, local), held, base, recipeBean(noBean))).toMatchObject({ batch: null, beanDue: true });
    // Once the Workflow took it, nothing is due again, the Bean compared by its id in any case.
    expect(dueParts(target, held, { ...base, [BEAN_TAKEN]: OTHER_BEAN }, recipeBean(otherBean))).toMatchObject({ batch: undefined });
    expect(dueParts(target, held, { ...base, [BEAN_TAKEN]: OTHER_BEAN }, recipeBean({ beanId: OTHER_BEAN.toUpperCase() })).beanDue).toBeUndefined();
    // A base keeping no Bean, as a release before #572 saved, took the Recipe's as it is now: nothing is due.
    const { [BEAN_TAKEN]: ___, ...legacy } = base;
    expect(readBase(JSON.parse(JSON.stringify(legacy)))).not.toHaveProperty(BEAN_TAKEN);
    expect(dueParts(target, held, readBase(JSON.parse(JSON.stringify(legacy))), recipeBean(otherBean)).batch).toBeUndefined();
    // The Bean taken is kept through a save, none included.
    expect(readBase(JSON.parse(JSON.stringify({ ...base, [BEAN_TAKEN]: null })))).toMatchObject({ [BEAN_TAKEN]: null });
    expect(readBase({ [BEAN_TAKEN]: BEAN.toUpperCase() })).toEqual({ [BEAN_TAKEN]: BEAN });
  });

  it("are, where the Recipe names a batch, as before: a change of its Bean alone is due as its batch changes (#572)", () => {
    const target = recipeParts(CONTENT, local);
    const base = { ...heldAlready(target, HELD), [BEAN_TAKEN]: BEAN };
    expect(dueParts(target, HELD, base, OTHER_BEAN)).toMatchObject({ batch: undefined });
    expect(dueParts(target, HELD, base, OTHER_BEAN).beanDue).toBeUndefined();
    // One naming a batch the tablet holds no record of yet waits for it, a Workflow holding none included.
    const unmapped = recipeParts(CONTENT, (kind, itemId) => (kind === "beanBatch" ? undefined : local(kind, itemId)));
    expect(unmapped.batch).toBeUndefined();
    const none = { ...HELD, batch: null };
    expect(dueParts(unmapped, none, { ...heldAlready(unmapped, none), [BEAN_TAKEN]: BEAN }, OTHER_BEAN)).toMatchObject({ batch: undefined });
    expect(dueParts(unmapped, none, { ...heldAlready(unmapped, none), [BEAN_TAKEN]: BEAN }, OTHER_BEAN).beanDue).toBeUndefined();
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

  it("is nothing where it holds the Recipe's, a grind setting as a number, nor a setting or Profile the Recipe holds none of", () => {
    expect(partsWrite(recipeParts(CONTENT, local), HELD, names)).toBeNull();
    const none = { ...HELD, grinder: null, yield: null, grind: null, rpm: null, feedRate: null, basket: null, batch: null };
    expect(partsWrite(recipeParts({ dose: 18 }, local), none, names)).toBeNull();
    expect(partsWrite(recipeParts({ dose: 18 }, local), { ...none, yield: 0, rpm: 0 }, names)).toBeNull();
  });

  it("clears each part the Recipe holds none of that it is the whole Shot in, every field of it null, its yield 0, as Decaid refuses a null there, expecting what the Workflow held", () => {
    expect(partsWrite(recipeParts({ profileId: "profile:adaptive" }, local), HELD, { ...names, coffeeName: null, coffeeRoaster: null })).toEqual({
      fields: {
        "context.grinderId": null,
        "context.grinderModel": null,
        "context.targetDoseWeight": null,
        "context.targetYield": 0,
        "context.grinderSetting": null,
        "context.extras.rpm": null,
        "context.extras.feedRate": null,
        "context.extras.basketId": null,
        "context.extras.basketName": null,
        "context.beanBatchId": null,
        "context.coffeeName": null,
        "context.coffeeRoaster": null,
      },
      expected: {
        "context.grinderId": "g1",
        "context.targetDoseWeight": 18,
        "context.targetYield": 36,
        "context.grinderSetting": "2.7",
        "context.extras.rpm": 900,
        "context.extras.feedRate": "MF",
        "context.extras.basketId": "k1",
        "context.beanBatchId": "b1",
      },
    });
    // A Recipe naming a Bean and no batch leaves its Bean's name and roaster, as DYE2's apply does.
    const { beanBatchId: _, ...beanOnly } = CONTENT;
    expect(partsWrite(recipeParts(beanOnly, local), HELD, names)).toEqual({
      fields: { "context.beanBatchId": null, "context.coffeeName": "Ethiopia", "context.coffeeRoaster": "Fixture Roasters" },
      expected: { "context.beanBatchId": "b1" },
    });
  });

  it("is, where its batch part is due for a change of the Recipe's Bean, the Bean's name and roaster into a Workflow holding no batch already, or none, expecting it to hold none still (#572)", () => {
    const { beanBatchId: _, ...beanOnly } = CONTENT;
    const held = { ...HELD, batch: null };
    const target = recipeParts(beanOnly, local);
    // Without the Bean due, nothing: the Workflow holds no batch, as the Recipe.
    expect(partsWrite(dueParts(target, held, { ...heldAlready(target, held), [BEAN_TAKEN]: BEAN }, BEAN), held, names)).toBeNull();
    const due = dueParts(target, held, { ...heldAlready(target, held), [BEAN_TAKEN]: BEAN }, OTHER_BEAN);
    expect(partsWrite(due, held, { ...names, coffeeName: "Kenya", coffeeRoaster: "Other Roasters" })).toEqual({
      fields: { "context.beanBatchId": null, "context.coffeeName": "Kenya", "context.coffeeRoaster": "Other Roasters" },
      expected: { "context.beanBatchId": null },
    });
    expect(partsWrite(due, held, { ...names, coffeeName: null, coffeeRoaster: null })).toEqual({
      fields: { "context.beanBatchId": null, "context.coffeeName": null, "context.coffeeRoaster": null },
      expected: { "context.beanBatchId": null },
    });
    // Over a batch the Machine holds as its own, as one the Library retired: the Bean changed, so its batch goes.
    expect(partsWrite(dueParts(target, HELD, { ...heldAlready(target, HELD), batch: null, [BEAN_TAKEN]: BEAN }, OTHER_BEAN), HELD, names)?.expected).toEqual({ "context.beanBatchId": "b1" });
  });

  it("waits for a batch or Basket the tablet holds no record of yet, and works out the yield from the ratio where it holds none", () => {
    const { yield: _, ...ratioOnly } = CONTENT;
    const target = recipeParts({ ...ratioOnly, dose: 19, beanBatchId: OTHER_BEANS_BATCH }, local);
    expect(target).toMatchObject({ yield: 38, batch: undefined });
    expect(partsWrite(target, HELD, names)?.fields).toEqual({ "context.targetDoseWeight": 19, "context.targetYield": 38 });
  });
});

describe("The dial written into a Workflow", () => {
  const target = { ...HELD, profile: "profile:classic", grinder: "g2", batch: "b2", dose: 19, yield: 38, grind: "3.1", rpm: 950, feedRate: "SF", basket: "k2" };
  /** The Library's `profile:classic`, as the write carries it. */
  const classic = { title: "Classic", tank_temperature: 0, steps: [{ name: "fill", temperature: 92, pump: "flow" }, { name: "pour", temperature: 90, pump: "pressure" }] };
  const current = {
    profileId: "profile:classic",
    beanBatchId: "b2",
    dashboardVariables: { grinderId: "g2", dose: 19, ratio: 2, grind: 3.1, rpm: 950, feedRate: "SF", basketId: "k2", brewC: 92 },
    profileSnapshot: classic,
    workflow: { profile: profileAtBrewTemperature(classic, 88) },
  };

  it("waits for the tablet's record of the Recipe to hold it, as DYE2 records the Workflow's dial into the record, its Grinder, batch and the rest going ahead", () => {
    const stale = { profileId: "profile:adaptive", beanBatchId: "b1", dashboardVariables: { grinderId: "g1", dose: 18, drink: 36, grind: 2.7, rpm: 900, basketId: "k1" } };
    expect(heldByRecord(target, stale, classic)).toEqual({
      ...target,
      profile: undefined,
      dose: undefined,
      yield: undefined,
      grind: undefined,
      rpm: undefined,
      feedRate: undefined,
      basket: undefined,
      brewTemperature: undefined,
    });
    // A yield worked out from the ratio, and a grind setting as a number, are held.
    expect(heldByRecord(target, current, classic)).toEqual(target);
    expect(heldByRecord(target, null, classic)).toMatchObject({ profile: undefined, grinder: "g2", batch: "b2", dose: undefined, rpm: undefined, hotWaterFlow: 7.5 });
  });

  it("waits to clear a part until the tablet's record holds none of it, or a 0, which is none", () => {
    const cleared = { ...target, dose: null, grind: null, rpm: null, basket: null, yield: null };
    // The record still holds each: its write has not landed.
    expect(heldByRecord(cleared, current, classic)).toMatchObject({ dose: undefined, grind: undefined, rpm: undefined, basket: undefined, yield: undefined });
    const without = { ...current, dashboardVariables: { grinderId: "g2", feedRate: "SF", brewC: 92, rpm: 0, dose: 0, drink: 0 } };
    expect(heldByRecord(cleared, without, classic)).toMatchObject({ dose: null, grind: null, rpm: null, basket: null, yield: null });
    // With no record known there is none to wait for.
    expect(heldByRecord(cleared, null, classic)).toMatchObject({ dose: null, basket: null });
  });

  it("waits with the Profile while the record names it but holds it otherwise, by DYE2's fingerprint, as before an edit of its title, which DYE2 would clear the recipe on", () => {
    const renamed = { ...classic, title: "Classic, renamed" };
    expect(heldByRecord(target, current, renamed)).toEqual({ ...target, profile: undefined });
    // The record holds it in another key order, as Decaid and jsonb differ, or only as its snapshot, which DYE2 reads where it embeds none.
    const reordered = { steps: classic.steps.map(({ pump, temperature, name }) => ({ pump, temperature, name })), tank_temperature: 0, title: "Classic" };
    expect(heldByRecord(target, { ...current, workflow: { profile: reordered } }, classic)).toEqual(target);
    expect(heldByRecord(target, { ...current, workflow: { context: {} } }, classic)).toEqual(target);
    expect(heldByRecord(target, { ...current, workflow: { context: {} }, profileSnapshot: renamed }, classic)).toEqual({ ...target, profile: undefined });
    // A record holding no profile at all, which DYE2 compares nothing with, holds nothing back.
    expect(heldByRecord(target, { ...current, workflow: { context: {} }, profileSnapshot: null }, classic)).toEqual(target);
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
