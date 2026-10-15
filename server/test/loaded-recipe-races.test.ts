import { LOADED_RECIPE_KEY, RECIPE_FIELD } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { DYE2_NAMESPACE, dye2Keys, dye2Library, dye2Recording, replayWrites } from "./support/simulated-dye2.js";
import { type DecaidApi, SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";

// Seam 1 for ticket #145: the plugin decides each change of a Workflow in
// turn, as though at once, whatever a barista changes while it reads what a
// decision needs from Decaid (ADR-0022). Through the built plugin in a
// simulated tablet that reaches no server, as a load is decided on the
// tablet alone, with slot 1 as DYE2 v0.1.19 was recorded keeping it
// (fixtures/decaid/dye2-v0.1.19/), carrying a Recipe's global id, Bean Batch
// and hot water as the server writes them. Serials are made up, from 47201.

type Record_ = Record<string, unknown>;

const RECIPE = "0190a5a2-0000-7000-8000-000000000145";
const HOT_WATER = { targetTemperature: 85, duration: 40, volume: 120, flow: 7.5 };

describe("Deciding a Loaded Recipe while the Workflow changes", () => {

  const library = dye2Library();
  const batchOf = (bean: string) => (library["/bean-batches"] as Record_[]).find((batch) => batch.beanId === (library["/beans"] as Record_[]).find((record) => String(record.name).endsWith(bean))!.id)!.id as string;
  const ethiopia = batchOf("Ethiopia");
  const brazil = batchOf("Brazil");
  const applied = dye2Recording("dye2-applies").applySlot1;

  /** A second batch of the recording's Ethiopia, as a barista adds the next bag. */
  const nextBag = { ...(library["/bean-batches"] as Record_[]).find((batch) => batch.id === ethiopia)!, id: "0190a5a2-0000-7000-8000-000000000999" };

  /**
   * The recording's tablet, holding slot 1 with its Recipe's id, Bean Batch
   * and hot water, its dial changed as `dial` says since the Workflow
   * embedded in it was written, as Streamline's strip then applies a stale
   * one, its Workflow as given, the first read of the Recipe's Bean, or
   * whatever request `slowed` names, taking 300 ms, as `during` changes the
   * Workflow.
   */
  function load(
    serial: string,
    workflow: Record_,
    during?: (tablet: SimulatedTablet) => Promise<unknown>,
    dial: Record_ = {},
    slowed = (method: string, path: string, slot1: Record_) => method === "GET" && path === `/beans/${String(slot1.beanId)}`,
    others: Record_[] = [],
  ) {
    const [slot1] = dye2Keys().recipes as [Record_];
    Object.assign(slot1.dashboardVariables as Record_, dial);
    const api: DecaidApi = {
      ...derivedDe1Pro({ serial }),
      ...library,
      "/bean-batches": [...(library["/bean-batches"] as Record_[]), nextBag],
      "/workflow": workflow,
      [`/store/${DYE2_NAMESPACE}/recipes`]: [{ ...slot1, decentSyncId: RECIPE, [RECIPE_FIELD]: { beanBatchId: ethiopia, hotWaterData: HOT_WATER } }, ...others],
    };
    let changing: Promise<unknown> | undefined;
    const tablet: SimulatedTablet = SimulatedTablet.load({
      // No server: a load is decided and recorded on the tablet alone.
      settings: settingsFor({ token: `races-${serial}`, serverUrl: "http://127.0.0.1:9" }),
      api,
      apiDelayMs: (method, path) => {
        if (!during || changing || !slowed(method, path, slot1)) return 0;
        changing = during(tablet);
        return 300;
      },
    });
    return { tablet, changed: () => expect.poll(() => changing).toBeDefined().then(() => changing) };
  }

  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const named = (tablet: SimulatedTablet) => ((context(tablet).extras ?? {}) as Record_)[LOADED_RECIPE_KEY] ?? null;
  /** Resolves after the plugin has had time to decide on and write what the changes leave, of which it reports nothing. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 1_000));

  it("keeps a batch of another Bean picked as a load of the Recipe is decided, and loads nothing", async () => {
    const { tablet, changed } = load("47201", structuredClone(library["/workflow"]) as Record_, (tablet) => tablet.changeSettings({ context: { beanBatchId: brazil } }));
    // DYE2's dashboard applying slot 1, as recorded, with no batch.
    for (const answer of await replayWrites(tablet, applied)) expect(answer.status).toBe(200);
    const before = tablet.workflow().hotWaterData;
    await changed();
    await settled();
    expect(context(tablet).beanBatchId).toBe(brazil);
    expect(named(tablet)).toBeNull();
    expect(tablet.workflow().hotWaterData).toEqual(before);
  });

  it("records a load whose dose is tweaked as it is decided, keeping the dose tweaked", async () => {
    const { tablet, changed } = load("47211", structuredClone(library["/workflow"]) as Record_, (tablet) => tablet.changeSettings({ context: { targetDoseWeight: 18.6 } }));
    for (const answer of await replayWrites(tablet, applied)) expect(answer.status).toBe(200);
    await changed();
    await expect.poll(() => named(tablet)).toBe(RECIPE);
    await settled();
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 18.6, beanBatchId: ethiopia, grinderSetting: "2.7" });
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
  });

  it("keeps hot water changed as a load of a stale dial is decided, after the plugin writes the current dial", async () => {
    const { tablet, changed } = load("47221", structuredClone(library["/workflow"]) as Record_, (tablet) => tablet.changeSettings({ hotWaterData: { volume: 61 } }), { dose: 19.5, grind: 2.9 });
    for (const answer of await replayWrites(tablet, applied)) expect(answer.status).toBe(200);
    await changed();
    await expect.poll(() => named(tablet)).toBe(RECIPE);
    await settled();
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 19.5, grinderSetting: "2.9", beanBatchId: ethiopia });
    expect(tablet.workflow().hotWaterData).toEqual({ ...HOT_WATER, volume: 61 });
  });

  it("keeps the next bag of the Recipe's Bean picked as a load of a stale dial is decided, after the plugin writes the current dial", async () => {
    const { tablet, changed } = load("47231", structuredClone(library["/workflow"]) as Record_, (tablet) => tablet.changeSettings({ context: { beanBatchId: nextBag.id } }), { dose: 19.5, grind: 2.9 });
    for (const answer of await replayWrites(tablet, applied)) expect(answer.status).toBe(200);
    await changed();
    await expect.poll(() => named(tablet)).toBe(RECIPE);
    await settled();
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 19.5, grinderSetting: "2.9", beanBatchId: nextBag.id });
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
  });

  it("unloads a load whose grinder a barista changes as Decaid takes its write, which leaves the grinder", async () => {
    const { tablet, changed } = load(
      "47241",
      structuredClone(library["/workflow"]) as Record_,
      (tablet) => tablet.changeSettings({ context: { grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" } }),
      {},
      (method, path) => method === "PUT" && path === "/workflow",
    );
    // DYE2's dashboard applying slot 1, as recorded: the load's write sets the Recipe's batch, hot water and id, not its
    // grinder, which the apply set.
    for (const answer of await replayWrites(tablet, applied)) expect(answer.status).toBe(200);
    await changed();
    await settled();
    expect(context(tablet)).toMatchObject({ grinderId: "a-grinder-the-recipe-does-not-name" });
    expect(named(tablet)).toBeNull();
  });

  /** Slot 1's dial as DYE2 applied it, with that batch, the Recipe's id where loaded, and that hot water volume. */
  const appliedWith = (batch: string, loaded: boolean, volume?: number): Record_ => {
    const workflow = structuredClone(applied.find(({ request }) => request.method === "PUT")!.response.body) as Record_;
    const context = workflow.context as Record_;
    context.beanBatchId = batch;
    if (loaded) context.extras = { ...(context.extras as Record_), [LOADED_RECIPE_KEY]: RECIPE };
    if (volume !== undefined) workflow.hotWaterData = { ...HOT_WATER, volume };
    return workflow;
  };

  it("loads nothing as the plugin loads with a Workflow holding the Recipe's dial and a batch of another Bean, as when the barista unloaded it so", async () => {
    const { tablet } = load("47261", appliedWith(brazil, false));
    await settled();
    expect(named(tablet)).toBeNull();
    expect(context(tablet).beanBatchId).toBe(brazil);
  });

  it("leaves a Workflow the plugin loads with naming the Recipe as it is, then writes the Recipe nothing as a tweak of it is set back, leaving the next bag and hot water the barista set", async () => {
    const { tablet } = load("47271", appliedWith(nextBag.id, true, 61));
    await settled();
    // The plugin loads with the Workflow naming the Recipe, and leaves it as it is.
    expect(named(tablet)).toBe(RECIPE);
    expect(context(tablet).beanBatchId).toBe(nextBag.id);
    expect(tablet.workflow().hotWaterData).toEqual({ ...HOT_WATER, volume: 61 });
    await tablet.changeSettings({ context: { targetDoseWeight: 19 } });
    await settled();
    await tablet.changeSettings({ context: { targetDoseWeight: 18.5 } });
    await settled();
    expect(named(tablet)).toBe(RECIPE);
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 18.5, beanBatchId: nextBag.id });
    expect(tablet.workflow().hotWaterData).toEqual({ ...HOT_WATER, volume: 61 });
  });

  it("loads the Recipe again, writing its batch, from a tweak set back while its unload by another Bean's batch is still to be written, as had each been decided at once", async () => {
    const tweaked = appliedWith(ethiopia, true);
    (tweaked.context as Record_).targetDoseWeight = 19;
    const { tablet, changed } = load("47281", tweaked, (tablet) => tablet.changeSettings({ context: { targetDoseWeight: 18.5 } }), {}, (method, path) => method === "GET" && path === `/bean-batches/${brazil}`);
    await settled();
    expect(named(tablet)).toBe(RECIPE);
    // A batch of another Bean unloads it; as the plugin reads that batch's Bean, the dose is set back to the Recipe's.
    await tablet.changeSettings({ context: { beanBatchId: brazil } });
    await changed();
    await settled();
    expect(named(tablet)).toBe(RECIPE);
    expect(context(tablet)).toMatchObject({ beanBatchId: ethiopia, targetDoseWeight: 18.5 });
  });

  /** Slot 1's recipe saved again in slot 3, for a batch of another Bean, before its grind was settled. */
  function looseSlot3(): Record_ {
    const [slot1] = dye2Keys().recipes as [Record_];
    const variables = { ...(slot1.dashboardVariables as Record_) };
    delete variables.grind;
    const embedded = { ...((slot1.workflow as Record_).context as Record_) };
    delete embedded.grinderSetting;
    return {
      ...slot1,
      id: "3",
      name: "Tomorrow's roast",
      dashboardVariables: variables,
      workflow: { ...(slot1.workflow as Record_), context: embedded },
      decentSyncId: "0190a5a2-0000-7000-8000-000000000146",
      [RECIPE_FIELD]: { beanBatchId: brazil, hotWaterData: { ...HOT_WATER, volume: 200 } },
    };
  }

  it("keeps the Recipe loaded through a tweak of its grind, though a recipe in another slot that leaves its grind blank then matches", async () => {
    const slot3 = looseSlot3();
    const { tablet } = load("47291", appliedWith(ethiopia, true), undefined, {}, undefined, [slot3]);
    await settled();
    await tablet.changeSettings({ context: { grinderSetting: "2.6" } });
    await settled();
    expect(named(tablet)).toBe(RECIPE);
    expect(context(tablet)).toMatchObject({ beanBatchId: ethiopia, grinderSetting: "2.6" });
    expect((tablet.workflow().hotWaterData as Record_).volume).not.toBe(200);
  });

  it("keeps the Recipe a Workflow the plugin loads with names, though it no longer matches it and a recipe in another slot that leaves its grind blank does", async () => {
    const tweaked = appliedWith(ethiopia, true);
    (tweaked.context as Record_).grinderSetting = "2.6";
    const { tablet } = load("47301", tweaked, undefined, {}, undefined, [looseSlot3()]);
    await settled();
    expect(named(tablet)).toBe(RECIPE);
    expect(context(tablet)).toMatchObject({ beanBatchId: ethiopia, grinderSetting: "2.6" });
    expect((tablet.workflow().hotWaterData as Record_).volume).not.toBe(200);
  });
});

