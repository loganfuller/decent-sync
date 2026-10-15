import { LOADED_RECIPE_KEY, RECIPE_FIELD } from "@decent-sync/protocol";
import { afterEach, describe, expect, it } from "vitest";
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

describe("Deciding a Loaded Recipe while the Workflow changes", { timeout: 30_000 }, () => {
  const tablets: SimulatedTablet[] = [];
  afterEach(async () => {
    await Promise.all(tablets.splice(0).map((tablet) => tablet.unload()));
  });

  const library = dye2Library();
  const batchOf = (bean: string) => (library["/bean-batches"] as Record_[]).find((batch) => batch.beanId === (library["/beans"] as Record_[]).find((record) => String(record.name).endsWith(bean))!.id)!.id as string;
  const ethiopia = batchOf("Ethiopia");
  const brazil = batchOf("Brazil");
  const applied = dye2Recording("dye2-applies").applySlot1;

  /**
   * The recording's tablet, holding slot 1 with its Recipe's id, Bean Batch
   * and hot water, its Workflow as given, the first read of the Recipe's
   * Bean taking 300 ms, as `during` changes the Workflow.
   */
  function load(serial: string, workflow: Record_, during: (tablet: SimulatedTablet) => Promise<unknown>) {
    const [slot1] = dye2Keys().recipes as [Record_];
    const api: DecaidApi = {
      ...derivedDe1Pro({ serial }),
      ...library,
      "/workflow": workflow,
      [`/store/${DYE2_NAMESPACE}/recipes`]: [{ ...slot1, decentSyncId: RECIPE, [RECIPE_FIELD]: { beanBatchId: ethiopia, hotWaterData: HOT_WATER } }],
    };
    let changing: Promise<unknown> | undefined;
    const tablet: SimulatedTablet = SimulatedTablet.load({
      // No server: a load is decided and recorded on the tablet alone.
      settings: settingsFor({ token: `races-${serial}`, serverUrl: "http://127.0.0.1:9" }),
      api,
      apiDelayMs: (method, path) => {
        if (changing || method !== "GET" || path !== `/beans/${String(slot1.beanId)}`) return 0;
        changing = during(tablet);
        return 300;
      },
    });
    tablets.push(tablet);
    return { tablet, changed: () => expect.poll(() => changing, { timeout: 10_000 }).toBeDefined().then(() => changing) };
  }

  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const named = (tablet: SimulatedTablet) => ((context(tablet).extras ?? {}) as Record_)[LOADED_RECIPE_KEY] ?? null;
  /** Resolves after the plugin has had time to decide on and write what the changes leave, of which it reports nothing. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 1_000));

  it("keeps a batch of another Bean picked as the plugin decides the Workflow it loaded with, and loads nothing", async () => {
    // Slot 1's dial, applied before the plugin loaded, with no batch.
    const workflow = structuredClone(applied.find(({ request }) => request.method === "PUT")!.response.body) as Record_;
    const { tablet, changed } = load("47201", workflow, (tablet) => tablet.changeSettings({ context: { beanBatchId: brazil } }));
    await changed();
    await settled();
    expect(context(tablet).beanBatchId).toBe(brazil);
    expect(named(tablet)).toBeNull();
    expect(tablet.workflow().hotWaterData).toEqual(workflow.hotWaterData);
  });

  it("records a load whose dose is tweaked as it is decided, keeping the dose tweaked", async () => {
    const { tablet, changed } = load("47211", structuredClone(library["/workflow"]) as Record_, (tablet) => tablet.changeSettings({ context: { targetDoseWeight: 18.6 } }));
    for (const answer of await replayWrites(tablet, applied)) expect(answer.status).toBe(200);
    await changed();
    await expect.poll(() => named(tablet), { timeout: 10_000 }).toBe(RECIPE);
    await settled();
    expect(context(tablet)).toMatchObject({ targetDoseWeight: 18.6, beanBatchId: ethiopia, grinderSetting: "2.7" });
    expect(tablet.workflow().hotWaterData).toEqual(HOT_WATER);
  });
});
