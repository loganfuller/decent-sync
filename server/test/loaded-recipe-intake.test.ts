import { RECIPE_FIELD } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  type PartLookups,
  type WorkflowParts,
  changedParts,
  partEdits,
  partsWrite,
  readParts,
  recipeParts,
  workflowParts,
} from "../src/library/loaded-recipe-intake.js";
import type { FieldEdits } from "../src/library/merge.js";
import { withoutOwnEdits } from "../src/library/recipe-intake.js";

// How the parts of a Workflow that follow its Loaded Recipe map to the
// Recipe's content, both ways (ADR-0022, ticket #146): which changes are
// edits of the Recipe, and what is written into a Workflow that has it
// loaded. Ids are made up.

const BATCH = "11111111-1111-4111-8111-111111111111";
const NEXT_BAG = "22222222-2222-4222-8222-222222222222";
const OTHER_BEANS_BATCH = "33333333-3333-4333-8333-333333333333";
const BEAN = "44444444-4444-4444-8444-444444444444";
const OTHER_BEAN = "55555555-5555-4555-8555-555555555555";
const BASKET = "66666666-6666-4666-8666-666666666666";

/** The tablet's map: its batch, the next bag of the same Bean and a batch of another, and a Basket. */
const MAPPED: Record<string, string> = { "beanBatch:b1": BATCH, "beanBatch:b2": NEXT_BAG, "beanBatch:b3": OTHER_BEANS_BATCH, "basket:k1": BASKET };
const LOOKUPS: PartLookups = {
  item: (kind, localId) => MAPPED[`${kind}:${localId}`],
  beanOf: (batchId) => ({ [BATCH]: BEAN, [NEXT_BAG]: BEAN, [OTHER_BEANS_BATCH]: OTHER_BEAN })[batchId],
};

/** A Recipe, in the Library's terms. */
const CONTENT = {
  dose: 18,
  yield: 36,
  ratio: 2,
  grindSetting: 2.7,
  rpm: 900,
  beanId: BEAN,
  beanBatchId: BATCH,
  basketId: BASKET,
  hotWaterTemperature: 88,
  hotWaterDuration: 40,
  hotWaterVolume: 120,
  hotWaterFlow: 7.5,
};

/** A Workflow holding that Recipe, as Decaid keeps one, naming the tablet's records. */
const WORKFLOW = {
  context: { targetDoseWeight: 18, targetYield: 36, grinderSetting: "2.7", beanBatchId: "b1", extras: { rpm: 900, basketId: "k1", basketName: "18g" } },
  hotWaterData: { targetTemperature: 88, duration: 40, volume: 120, flow: 7.5 },
};

const HELD: WorkflowParts = workflowParts(WORKFLOW);

const NO_STALE = { beforeWrite: null, previous: {} };

describe("A Workflow's parts that follow its Loaded Recipe", () => {
  it("are read as the Workflow holds them, the grind setting as text and the Basket and batch by the tablet's ids", () => {
    expect(HELD).toEqual({ dose: 18, yield: 36, grind: "2.7", rpm: 900, basket: "k1", batch: "b1", targetTemperature: 88, duration: 40, volume: 120, flow: 7.5 });
    expect(readParts(JSON.parse(JSON.stringify(HELD)))).toEqual(HELD);
    expect(workflowParts({ context: { grinderSetting: 3 } })).toMatchObject({ grind: "3", dose: null, batch: null });
  });

  it("change where they differ, a grind setting compared as a number, and not where one is cleared, as Streamline clears them once a Shot is stored", () => {
    expect(changedParts(HELD, { ...HELD, grind: "2.70" })).toEqual([]);
    expect(changedParts(HELD, { ...HELD, grind: "2.8", volume: 140 })).toEqual(["grind", "volume"]);
    expect(changedParts(HELD, { ...HELD, batch: null, basket: null, rpm: null })).toEqual([]);
  });
});

describe("A change of a Workflow's parts", () => {
  it("edits the Recipe's dose, grind setting as a number, RPM and hot water", () => {
    const now = { ...HELD, dose: 18.5, grind: "2.8", rpm: 950, flow: 6 };
    expect(partEdits(["dose", "grind", "rpm", "flow"], now, CONTENT, LOOKUPS, NO_STALE)).toEqual({
      // The ratio no longer gives the yield.
      values: { dose: 18.5, grindSetting: 2.8, rpm: 950, hotWaterFlow: 6, ratio: null },
      taken: ["dose", "grind", "rpm", "flow"],
      unmapped: [],
    });
  });

  it("keeps the Workflow's yield as the Recipe's where it held none, but its ratio, as the dose changes", () => {
    const { yield: _, ...ratioOnly } = CONTENT;
    expect(partEdits(["dose"], { ...HELD, dose: 19 }, ratioOnly, LOOKUPS, NO_STALE).values).toEqual({ dose: 19, yield: 36, ratio: null });
  });

  it("moves the Recipe to another batch of its Bean, but not to one of another Bean, which the Workflow is not held to", () => {
    expect(partEdits(["batch"], { ...HELD, batch: "b2" }, CONTENT, LOOKUPS, NO_STALE)).toEqual({ values: { beanBatchId: NEXT_BAG }, taken: ["batch"], unmapped: [] });
    expect(partEdits(["batch"], { ...HELD, batch: "b3" }, CONTENT, LOOKUPS, NO_STALE)).toEqual({ values: {}, taken: [], unmapped: [] });
    const { beanId: _, ...noBean } = CONTENT;
    expect(partEdits(["batch"], { ...HELD, batch: "b2" }, noBean, LOOKUPS, NO_STALE).values).toEqual({});
  });

  it("waits for a Basket or batch the tablet's map does not hold yet", () => {
    expect(partEdits(["batch", "basket", "dose"], { ...HELD, batch: "new", basket: "new", dose: 17 }, CONTENT, LOOKUPS, NO_STALE)).toEqual({
      values: { dose: 17, ratio: null },
      taken: ["dose"],
      unmapped: ["batch", "basket"],
    });
  });

  it("is no edit where the Recipe holds the value already, as when Streamline's save into the recipe came first, or a grind setting is no number", () => {
    expect(partEdits(["dose", "grind"], { ...HELD, dose: 18.5, grind: "2+3" }, { ...CONTENT, dose: 18.5 }, LOOKUPS, NO_STALE)).toEqual({
      values: {},
      taken: ["dose"],
      unmapped: [],
    });
  });

  it("is no edit where a stale copy set it back to what the tablet's record held before the server's latest write, which was the Recipe's before", () => {
    const now = { ...HELD, grind: "2.7", batch: "b1", volume: 120 };
    const content = { ...CONTENT, grindSetting: 2.9, beanBatchId: NEXT_BAG, hotWaterVolume: 130 };
    const stale = {
      beforeWrite: { "dashboardVariables.grind": 2.7, [RECIPE_FIELD]: { beanBatchId: "b1", hotWaterData: { volume: 120 } } },
      previous: { grindSetting: 2.7, beanBatchId: BATCH, hotWaterVolume: 120 },
    };
    expect(partEdits(["grind", "batch", "volume"], now, content, LOOKUPS, stale)).toEqual({ values: {}, taken: ["grind", "batch", "volume"], unmapped: [] });
    // Another value than the Recipe's before, or one the server never wrote over, is an edit.
    expect(partEdits(["grind"], { ...HELD, grind: "2.6" }, content, LOOKUPS, stale).values).toEqual({ grindSetting: 2.6 });
    expect(partEdits(["grind"], now, content, LOOKUPS, { ...stale, previous: { grindSetting: 2.5 } }).values).toEqual({ grindSetting: 2.7 });
    expect(partEdits(["grind"], now, content, LOOKUPS, { beforeWrite: {}, previous: stale.previous }).values).toEqual({ grindSetting: 2.7 });
  });
});

describe("What a Workflow is written of its Loaded Recipe", () => {
  const locals: Record<string, string> = { [`beanBatch:${NEXT_BAG}`]: "b2", [`beanBatch:${BATCH}`]: "b1", [`basket:${BASKET}`]: "k1" };
  const local = (kind: string, itemId: string) => locals[`${kind}:${itemId}`];
  const names = { basketName: "18g", coffeeName: "Ethiopia", coffeeRoaster: "Fixture Roasters" };

  it("is each field of the Recipe's it holds otherwise, by the tablet's ids, expecting what it held, with the names DYE2 copies", () => {
    const target = recipeParts({ ...CONTENT, dose: 18.5, grindSetting: 2.8, beanBatchId: NEXT_BAG, hotWaterVolume: 140 }, local);
    expect(partsWrite(target, HELD, names)).toEqual({
      fields: {
        "context.targetDoseWeight": 18.5,
        "context.grinderSetting": "2.8",
        "context.beanBatchId": "b2",
        "context.coffeeName": "Ethiopia",
        "context.coffeeRoaster": "Fixture Roasters",
        "hotWaterData.volume": 140,
      },
      expected: { "context.targetDoseWeight": 18, "context.grinderSetting": "2.7", "context.beanBatchId": "b1", "hotWaterData.volume": 120 },
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
