import { GLOBAL_ID_KEY, LOADED_RECIPE_KEY, dye2GlobalIdOf, profileAtBrewTemperature } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #146, #177, #187 and #188: a Machine follows its Loaded
// Recipe both ways (ADR-0022). DYE2 records a change on one Machine of the
// dose, yield, grind setting, RPM, Basket, brew temperature and hot water
// value of the Recipe's mode into the Recipe's record, where it holds one,
// an edit of the Recipe from that Machine's tablet, once; a change of its
// other hot water settings is one through the Workflow; another batch, of
// its Bean or not, unloads it through DYE2's own clear; and an edit of the
// Recipe from anywhere is written into the Workflow of every Machine that
// has it loaded, its brew temperature as on a load, the plugin selecting the
// Recipe again after a write of its batch or grinder, which DYE2 clears its
// selection on (#188). A part set back to what a stale copy or the load
// replaced is written back. Taking the Recipe out
// of its slot, Archiving it, or making the Machine capture-only clears it
// from the Workflow and from DYE2's selection; moving it to another slot
// selects it there. Through the built plugin in simulated tablets running
// DYE2 at 2cf631c and Streamline at c006dac as recorded (fixtures/decaid/dye2-2cf631c/),
// Machines A and C on two server instances sharing one database, with
// assertions through the REST API and what each simulated tablet holds.
// Serials are made up, from 48001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  slot: number | null;
  archived: boolean;
  content: Record_;
}

interface VersionView {
  fields: Record_;
  source: { machine: { id: string } | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's profiles, by their ids: slot 1's, and slot 2's and the Workflow's. */
const ADAPTIVE = "profile:98fa00c191551b435845";
const CLASSIC = "profile:39e939592679fb194706";

describe("A Machine follows its Loaded Recipe both ways", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  const records = (tablet: SimulatedTablet) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []);
  const inSlot = (tablet: SimulatedTablet, slot: string) => records(tablet).find((record) => record.id === slot);
  const variables = (record: Record_ | undefined) => (record?.dashboardVariables ?? {}) as Record_;
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const extras = (tablet: SimulatedTablet) => (context(tablet).extras ?? {}) as Record_;
  const hotWater = (tablet: SimulatedTablet) => (tablet.workflow().hotWaterData ?? {}) as Record_;
  const profile = (tablet: SimulatedTablet) => tablet.workflow().profile as Record_;
  const firstTemperature = (tablet: SimulatedTablet) => ((profile(tablet).steps as Record_[])[0] ?? {}).temperature;
  /** The Recipe id the tablet's Workflow names as loaded, or null. */
  const named = (tablet: SimulatedTablet) => extras(tablet)[LOADED_RECIPE_KEY] ?? null;
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: VersionView[] }>(`/recipes/${id}/history`)).versions;
  /** How many of the Recipe's versions set the field. */
  const editsOf = async (id: string, field: string) => (await versions(id)).filter((version) => field in version.fields).length;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** The tablet's id for its record of a Library item, by the global id the record carries in its `extras`. */
  const localId = async (tablet: SimulatedTablet, route: string, globalId: string) => {
    const listed = (await tablet.callApi("GET", `${route}?includeArchived=true`)).body as Record_[];
    return listed.find((record) => (record.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] === globalId)?.id;
  };
  /** The Machine's current Workflow as the server holds it, or null. */
  const currentWorkflow = async ({ machine }: CreatedMachine) =>
    (await api.get<{ workflow: { workflow: Record_ } | null }>(`/machines/${machine.id}/workflow`)).workflow?.workflow ?? null;
  /** Waits a while for what should not happen, as a write to a Workflow that does not follow the Recipe. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  /**
   * A Location with Machines A, whose tablet is the 2cf631c recording's, on
   * one instance, C on the other, and D on the first, both tablets where
   * DYE2 was never used, each running DYE2. A brings slots 1 and 2, which
   * every tablet there is written, and slot 1 is applied on DYE2's dashboard
   * on A and C, and slot 2 on D, which each loads. A's machine is connected.
   */
  async function lab(scenario: string, serial: number, options: { pollSeconds?: number } = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      c: await api.createMachine(`${scenario} lab C`, here.id),
      d: await api.createMachine(`${scenario} lab D`, here.id),
    };
    const dye2 = { a: new SimulatedDye2(), c: new SimulatedDye2(), d: new SimulatedDye2() };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: dye2.a, pollSeconds: options.pollSeconds });
    await api.waitForOnline(machines.a);
    await expect.poll(() => ["1", "2"].map((slot) => dye2GlobalIdOf(inSlot(a, slot))), { timeout: 15_000 }).not.toContain(null);
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 1)), dye2: dye2.c });
    const d = syncingTablet(machines.d, server, { api: dye2NeverUsed(String(serial + 2)), dye2: dye2.d });
    await api.waitForOnline(machines.c, machines.d);
    const one = dye2GlobalIdOf(inSlot(a, "1"))!;
    const two = dye2GlobalIdOf(inSlot(a, "2"))!;
    // Each tablet holds both, naming the batch and Basket each uses by its own ids.
    for (const tablet of [c, d]) {
      await expect
        .poll(() => ["1", "2"].map((slot) => [dye2GlobalIdOf(inSlot(tablet, slot)), inSlot(tablet, slot)?.beanBatchId ?? null]).flat(), { timeout: 15_000 })
        .not.toContain(null);
      await expect.poll(() => ["1", "2"].map((slot) => variables(inSlot(tablet, slot)).basketId ?? null)).not.toContain(null);
    }
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, slot: string, recipeId: string) => {
      expect((await (await openDye2Dashboard(tablet)).applyRecipe(slot)).selection?.status).toBe(200);
      await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
    };
    await load(a, machines.a, "1", one);
    await load(c, machines.c, "1", one);
    await load(d, machines.d, "2", two);
    a.connectMachine();
    return { here, machines, dye2, a, c, d, one, two, load };
  }

  it("takes a grind and brew temperature change on A that DYE2 records into the Recipe once each, and writes them into C's Workflow on the other instance, and no other's", async () => {
    const { machines, dye2, a, c, d, one } = await lab("Recorded", 48001);
    const grinds = await editsOf(one, "grindSetting");
    await a.changeSettings({ context: { grinderSetting: "3.1" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.1);
    await expect.poll(() => context(c).grinderSetting, { timeout: 15_000 }).toBe("3.1");
    expect(dye2.a.recorded.at(-1)).toMatchObject({ kind: "recipe", id: "1", patch: { grind: 3.1 } });
    await settle();
    // The Workflow's change on A, which reached the server first, is no second edit.
    expect(await editsOf(one, "grindSetting")).toBe(grinds + 1);

    // Its brew temperature, set on A as Streamline's Brew tile sets one: every step moved by the same amount.
    const temperatures = await editsOf(one, "brewTemperature");
    await a.changeSettings({ profile: profileAtBrewTemperature(profile(a), 90)! });
    await expect.poll(async () => (await recipe(one)).content.brewTemperature, { timeout: 15_000 }).toBe(90);
    await expect.poll(() => firstTemperature(c), { timeout: 15_000 }).toBe(90);
    expect(((profile(c).steps as Record_[])[2] ?? {}).temperature).toBe(85);
    await settle();
    expect(await editsOf(one, "brewTemperature")).toBe(temperatures + 1);
    // Every recipe record's embedded Workflow, which Streamline's strip applies, holds the Recipe's profile at its brew
    // temperature.
    for (const tablet of [a, c]) {
      await expect.poll(() => ((((inSlot(tablet, "1")!.workflow as Record_).profile as Record_).steps as Record_[])[0] ?? {}).temperature).toBe(90);
    }
    expect(context(d).grinderSetting).not.toBe("3.1");
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("takes an RPM and Basket change on A that DYE2 records into the Recipe, and a hot water duration change through the Workflow, and writes them into C's", async () => {
    const { dye2, a, c, one, two } = await lab("Workflow", 48011);
    const basket20 = (await recipe(two)).content.basketId as string;
    const basket = (dye2List(a, "baskets") as Record_[]).find((record) => dye2GlobalIdOf(record) === basket20)!.id;
    await a.changeSettings({ context: { extras: { rpm: 950, basketId: basket } }, hotWaterData: { duration: 33 } });
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ rpm: 950, hotWaterDuration: 33 });
    expect((await recipe(one)).content.basketId).toBe(basket20);
    await expect.poll(() => [extras(c).rpm, hotWater(c).duration], { timeout: 15_000 }).toEqual([950, 33]);
    expect(dye2.a.recorded.map((recorded) => recorded.patch)).toContainEqual(expect.objectContaining({ rpm: 950, basketId: basket }));
  });

  it("takes an RPM DYE2 records as 0 as 0, not as blank (decentespresso/dye2#29), and writes it into C's", async () => {
    const { dye2, a, c, one } = await lab("Zero", 48151);
    await a.changeSettings({ context: { extras: { rpm: 0 } } });
    await expect.poll(async () => (await recipe(one)).content.rpm, { timeout: 15_000 }).toBe(0);
    expect(dye2.a.recorded.map((recorded) => recorded.patch)).toContainEqual(expect.objectContaining({ rpm: 0 }));
    await expect.poll(() => extras(c).rpm, { timeout: 15_000 }).toBe(0);
    expect(variables(inSlot(c, "1")).rpm).toBe(0);
  });

  it("writes an RPM and dose saved in DYE2's editor on A, which has the Recipe loaded, into A's Workflow too, where they stay", async () => {
    const { a, c, one } = await lab("Editor", 48161);
    // DYE2's editor saves the fields changed over a fresh read, stamping `capturedAt` anew (decentespresso/dye2#28).
    const saved = records(a).map((record) =>
      record.id === "1" ? { ...record, capturedAt: new Date().toISOString(), dashboardVariables: { ...variables(record), rpm: 1333, dose: 19.5 } } : record,
    );
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, saved)).status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ rpm: 1333, dose: 19.5 });
    for (const tablet of [a, c]) {
      await expect.poll(() => [extras(tablet).rpm, context(tablet).targetDoseWeight], { timeout: 15_000 }).toEqual([1333, 19.5]);
    }
    // A's next change of the Workflow, which DYE2 records, keeps them.
    await a.changeSettings({ context: { grinderSetting: "3.3" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.3);
    await settle();
    expect((await recipe(one)).content).toMatchObject({ rpm: 1333, dose: 19.5 });
    expect([extras(c).rpm, context(c).targetDoseWeight]).toEqual([1333, 19.5]);
  });

  it("follows a grind DYE2 records and an editor save that reach the server in one report, writing a later edit into A's Workflow", async () => {
    // A's recipes are read at a welcome, not at its poll.
    const { machines, a, c, one } = await lab("Coalesced", 48171, { pollSeconds: 3600 });
    await a.changeSettings({ context: { grinderSetting: "3.3" } });
    await expect.poll(() => variables(inSlot(a, "1")).grind, { timeout: 15_000 }).toBe(3.3);
    await expect.poll(() => currentWorkflow(machines.a).then((workflow) => (workflow?.context as Record_ | undefined)?.grinderSetting), { timeout: 15_000 }).toBe("3.3");
    // Then DYE2's editor saves a rename of slot 1, and the plugin reports both at its next welcome.
    const renamed = records(a).map((record) => (record.id === "1" ? { ...record, capturedAt: new Date().toISOString(), name: "Coalesced rename" } : record));
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, renamed)).status).toBe(200);
    a.dropConnections();
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ name: "Coalesced rename", grindSetting: 3.3 });
    // An edit of the grind from elsewhere reaches A's Workflow as C's.
    await patch(one, { grindSetting: 3.5 });
    for (const tablet of [a, c]) await expect.poll(() => context(tablet).grinderSetting, { timeout: 15_000 }).toBe("3.5");
  });

  it("writes an RPM saved in DYE2's editor on A, read as the plugin writes the record, into A's Workflow too", async () => {
    const { a, c, one } = await lab("Answered", 48181, { pollSeconds: 3600 });
    const saved = records(a).map((record) => (record.id === "1" ? { ...record, capturedAt: new Date().toISOString(), dashboardVariables: { ...variables(record), rpm: 1444 } } : record));
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, saved)).status).toBe(200);
    // The Recipe's own edit has the plugin read and write slot 1: its answer carries the save.
    await patch(one, { dose: 19 });
    await expect.poll(async () => (await recipe(one)).content.rpm, { timeout: 15_000 }).toBe(1444);
    for (const tablet of [a, c]) await expect.poll(() => [extras(tablet).rpm, context(tablet).targetDoseWeight], { timeout: 15_000 }).toEqual([1444, 19]);
  });

  it("changes nothing of a Recipe holding no RPM or Basket as they change on its Machine, as DYE2 records neither into it", async () => {
    const { machines, a, c, one, two, load } = await lab("Unheld", 48131);
    await patch(two, { rpm: null, basketId: null });
    await expect.poll(() => [variables(inSlot(a, "2")).rpm ?? null, variables(inSlot(a, "2")).basketId ?? null], { timeout: 15_000 }).toEqual([null, null]);
    await load(a, machines.a, "2", two);
    const basket18 = (await recipe(one)).content.basketId as string;
    const other = (dye2List(a, "baskets") as Record_[]).find((record) => dye2GlobalIdOf(record) !== basket18 && dye2GlobalIdOf(record) !== null)!.id;
    await a.changeSettings({ context: { extras: { rpm: 1234, basketId: other } } });
    await settle();
    await settle();
    expect((await recipe(two)).content).not.toHaveProperty("rpm");
    expect((await recipe(two)).content).not.toHaveProperty("basketId");
    expect(await loadedRecipe(machines.a)).toBe(two);
    expect(variables(inSlot(c, "2")).rpm ?? null).toBeNull();
  });

  it("takes a Basket picked in DYE2's editor on A for its Loaded Recipe holding none, though A's Workflow holds that Basket already", async () => {
    const { machines, a, c, two, load } = await lab("Basket picked", 48121);
    // Slot 2's Recipe holds no Basket; A's Workflow holds slot 1's, which loading slot 2 leaves, as it writes none.
    await patch(two, { basketId: null });
    await expect.poll(() => variables(inSlot(a, "2")).basketId ?? null, { timeout: 15_000 }).toBeNull();
    const basket = extras(a).basketId as string;
    expect(basket).toEqual(expect.any(String));
    await load(a, machines.a, "2", two);
    expect(extras(a).basketId).toBe(basket);
    // DYE2's editor saves slot 2 with that Basket picked: the Recipe's first.
    const saved = records(a).map((record) =>
      record.id === "2" ? { ...record, dashboardVariables: { ...variables(record), basketId: basket, basketName: "Fixture 18g Precision" } } : record,
    );
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, saved)).status).toBe(200);
    await expect.poll(async () => (await recipe(two)).content.basketId ?? null, { timeout: 15_000 }).toEqual(expect.any(String));
    await expect.poll(() => variables(inSlot(c, "2")).basketId ?? null, { timeout: 15_000 }).toEqual(expect.any(String));
    await settle();
    expect(variables(inSlot(a, "2")).basketId).toBe(basket);
  });

  it("edits the Recipe from A's own set-back of its grind, and unloads it as A's barista picks the grinder the load replaced", async () => {
    const { machines, dye2, a, one } = await lab("Undo", 48021);
    const grind = (await recipe(one)).content.grindSetting;
    await a.changeSettings({ context: { grinderSetting: "2.9" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.9);
    // Set back by A's own barista: an undo, so an edit.
    await a.changeSettings({ context: { grinderSetting: String(grind) } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(grind);

    // Another grinder on A, picked before slot 2 is loaded and picked again after.
    const created = await a.callApi("POST", "/grinders", { model: "Undo Grinder 2", settingType: "numeric" });
    const grinder2 = (created.body as Record_).id as string;
    await a.changeSettings({ context: { grinderId: grinder2, grinderModel: "Undo Grinder 2" } });
    await loads(machines.a, null);
    await (await openDye2Dashboard(a)).applyRecipe("1");
    await loads(machines.a, one);
    expect(context(a).grinderId).not.toBe(grinder2);
    await a.changeSettings({ context: { grinderId: grinder2, grinderModel: "Undo Grinder 2" } });
    await loads(machines.a, null);
    expect(dye2.a.selected()).toBeNull();
    expect(context(a).grinderId).toBe(grinder2);
  });

  it("does not take a value the plugin wrote over for a Recipe loaded before as stale for the one loaded now, and unloads it as its batch is set back to the one its apply replaced", async () => {
    const { machines, a, one, two, load } = await lab("Before", 48031);
    // Nothing loaded, RPM 800; then slot 1 loaded (900), and slot 2 over it (1100): 800 is what slot 1's load replaced, not
    // slot 2's, so set back to it is slot 2's edit.
    expect((await a.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, {})).status).toBe(200);
    await loads(machines.a, null);
    await a.changeSettings({ context: { extras: { rpm: 800 } } });
    await load(a, machines.a, "1", one);
    expect(extras(a).rpm).toBe(900);
    await load(a, machines.a, "2", two);
    expect(extras(a).rpm).toBe(1100);
    await a.changeSettings({ context: { extras: { rpm: 800 } } });
    await expect.poll(async () => (await recipe(two)).content.rpm, { timeout: 15_000 }).toBe(800);
    expect((await recipe(one)).content.rpm).toBe(900);

    // Slot 1 applied again, replacing slot 2's batch: the batch set back before a Shot is a change of batch, which DYE2 clears
    // its selection on, so the Recipe unloads and nothing is written back (ADR-0022).
    const batch2 = context(a).beanBatchId;
    await load(a, machines.a, "1", one);
    const batch1 = context(a).beanBatchId;
    expect(batch1).not.toBe(batch2);
    await a.changeSettings({ context: { beanBatchId: batch2 } });
    await loads(machines.a, null);
    await settle();
    expect(context(a).beanBatchId).toBe(batch2);
    expect(await localId(a, "/bean-batches", (await recipe(one)).content.beanBatchId as string)).toBe(batch1);
  });

  it("unloads the Recipe as another batch of its Bean is picked on the Machine, leaving the Recipe's batch, as DYE2 clears its selection on it", async () => {
    const { here, machines, dye2, a, c, one } = await lab("Next bag", 48141);
    const batch = (await recipe(one)).content.beanBatchId as string;
    const bean = (await recipe(one)).content.beanId as string;
    const created = await api.call("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const next = ((await created.json()) as { batch: { id: string } }).batch.id;
    let local: unknown;
    await expect.poll(async () => (local = await localId(a, "/bean-batches", next)), { timeout: 15_000 }).toEqual(expect.any(String));
    await a.changeSettings({ context: { beanBatchId: local } });
    await loads(machines.a, null);
    expect(dye2.a.selected()).toBeNull();
    await settle();
    expect((await recipe(one)).content.beanBatchId).toBe(batch);
    expect(context(a).beanBatchId).toBe(local);
    // C keeps it loaded, on the Recipe's batch.
    expect(await loadedRecipe(machines.c)).toBe(one);
    expect(context(c).beanBatchId).toBe(await localId(c, "/bean-batches", batch));
  });

  it("writes a batch picked in DYE2's editor on A, and a grinder set in the management interface, into A's and C's Workflows, which keep the Recipe selected and recording", async () => {
    const { here, machines, dye2, a, c, one } = await lab("New roast", 48171);
    const bean = (await recipe(one)).content.beanId as string;
    const created = await api.call("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const next = ((await created.json()) as { batch: { id: string } }).batch.id;
    for (const tablet of [a, c]) await expect.poll(() => localId(tablet, "/bean-batches", next), { timeout: 15_000 }).toEqual(expect.any(String));
    const clears = () => [dye2.a, dye2.c].map((selection) => selection.asked.filter((asked) => asked === null).length);
    const cleared = clears();

    // DYE2's editor on A picks the new batch for slot 1, which every Machine with the Recipe loaded is written, A's included.
    const picked = await localId(a, "/bean-batches", next);
    const edited = records(a).map((record) => (record.id === "1" ? { ...record, beanBatchId: picked, capturedAt: new Date().toISOString() } : record));
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, edited)).status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(next);
    for (const tablet of [a, c]) await expect.poll(async () => context(tablet).beanBatchId, { timeout: 15_000 }).toBe(await localId(tablet, "/bean-batches", next));

    // And a grinder set in the management interface.
    const grinder = (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: here.id, content: { model: "New roast Grinder 2" } }, 201)).grinder.id;
    for (const tablet of [a, c]) await expect.poll(() => localId(tablet, "/grinders", grinder), { timeout: 15_000 }).toEqual(expect.any(String));
    await patch(one, { grinderId: grinder });
    for (const tablet of [a, c]) await expect.poll(async () => context(tablet).grinderId, { timeout: 15_000 }).toBe(await localId(tablet, "/grinders", grinder));

    // DYE2 cleared each selection on the write, and the plugin selected it again on the Workflow holding them, posting no clear.
    await settle();
    for (const [tablet, selection] of [[a, dye2.a], [c, dye2.c]] as const) {
      expect(selection.selected()).toMatchObject({
        kind: "recipe",
        id: "1",
        armedBeanBatchId: await localId(tablet, "/bean-batches", next),
        armedGrinderId: await localId(tablet, "/grinders", grinder),
      });
    }
    expect(clears()).toEqual(cleared);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    expect([named(a), named(c)]).toEqual([one, one]);
    // DYE2 on C still records into the Recipe.
    await c.changeSettings({ context: { grinderSetting: "3.4" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.4);
  });

  it("selects the Recipe again after its grinder is written into A's Workflow only while A's barista has not picked another batch since, which unloads it", async () => {
    const { here, machines, dye2, a, c, one } = await lab("Switched since", 48181);
    const grinder = (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: here.id, content: { model: "Switched since Grinder 2" } }, 201)).grinder.id;
    for (const tablet of [a, c]) await expect.poll(() => localId(tablet, "/grinders", grinder), { timeout: 15_000 }).toEqual(expect.any(String));
    // Decaid refuses the plugin's selection on A for now, so its selection again after the write is still to be made.
    dye2.a.refuseSelections(1_000);
    await patch(one, { grinderId: grinder });
    await expect.poll(async () => context(a).grinderId, { timeout: 15_000 }).toBe(await localId(a, "/grinders", grinder));
    expect(dye2.a.selected()).toBeNull();
    // Meanwhile A's barista picks slot 2's batch, which DYE2 would have cleared a selection on.
    await a.changeSettings({ context: { beanBatchId: inSlot(a, "2")!.beanBatchId } });
    await settle();
    dye2.a.refuseSelections(0);
    await loads(machines.a, null);
    await settle();
    expect(dye2.a.selected()).toBeNull();
    expect(named(a)).toBeNull();
    // C, which nothing switched, stays loaded on the new grinder.
    await expect.poll(async () => context(c).grinderId, { timeout: 15_000 }).toBe(await localId(c, "/grinders", grinder));
    await settle();
    expect(dye2.c.selected()).toMatchObject({ kind: "recipe", id: "1" });
    await loads(machines.c, one);
  });

  it("selects nothing again after a grinder written into A's Workflow while A's DYE2 answers 404, over a batch A's barista picked meanwhile, which unloads it", async () => {
    const { here, machines, dye2, a, c, one } = await lab("Away switch", 48191);
    const grinder = (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: here.id, content: { model: "Away switch Grinder 2" } }, 201)).grinder.id;
    for (const tablet of [a, c]) await expect.poll(() => localId(tablet, "/grinders", grinder), { timeout: 15_000 }).toEqual(expect.any(String));
    dye2.a.unload();
    // A's barista picks slot 2's batch, which nothing judges while DYE2 answers 404, then the Recipe's new grinder is written.
    await a.changeSettings({ context: { beanBatchId: inSlot(a, "2")!.beanBatchId } });
    await patch(one, { grinderId: grinder });
    for (const tablet of [a, c]) await expect.poll(async () => context(tablet).grinderId, { timeout: 15_000 }).toBe(await localId(tablet, "/grinders", grinder));
    // DYE2 restores the selection made on the batch before, which loads nothing, and the plugin selects nothing over it.
    await dye2.a.load();
    await loads(machines.a, null);
    await settle();
    expect(dye2.a.selected()).toBeNull();
    expect(named(a)).toBeNull();
    // C, which nothing switched, stays loaded on the new grinder.
    await settle();
    expect(dye2.c.selected()).toMatchObject({ kind: "recipe", id: "1" });
    await loads(machines.c, one);
  });

  it("loads a recipe selected from Streamline's strip on a profile with a target weight, with the Workflow on the Recipe's batch, selecting it once", async () => {
    const { machines, dye2, c, one, two } = await lab("Target", 48111);
    // Classic Italian espresso, slot 2's, stops at a target weight, which DYE2's fingerprint leaves out (decentespresso/dye2#18).
    expect((await recipe(two)).content.profileId).toBe(CLASSIC);
    const held = inSlot(c, "2")?.beanBatchId;
    expect(held).toEqual(expect.any(String));
    expect(context(c).beanBatchId).not.toBe(held);
    const streamline = await startStreamline(c);
    expect((await streamline.applyRecipe("2")).selection?.status).toBe(200);
    expect(typeof (profile(c).target_weight)).toBe("number");
    await loads(machines.c, two);
    await expect.poll(() => named(c), { timeout: 15_000 }).toBe(two);
    // The strip applies the batch the record's embedded Workflow holds.
    expect(context(c).beanBatchId).toBe(held);
    const asked = dye2.c.asked.length;
    await settle();
    await settle();
    // Nothing selects it again on each read: the plugin's fingerprint is DYE2's.
    expect(dye2.c.asked.slice(asked)).toEqual([]);
    expect(dye2.c.selected()).toMatchObject({ kind: "recipe", id: "2" });
    await loads(machines.c, two);
    expect(await loadedRecipe(machines.a)).toBe(one);
  });

  it("keeps the Recipe loaded through a yield set on Streamline's Drink tile, takes DYE2's recording of it as the Recipe's yield, and writes it into C's Workflow, selecting nothing again", async () => {
    const { machines, dye2, a, c, one } = await lab("Drink", 48041);
    const streamline = await startStreamline(a);
    // Applied again from Streamline's strip, which sends a step limiter of 0 as null: its tiles send the profile so too, which
    // DYE2's fingerprint would take for another profile than one DYE2's dashboard applied (an accepted gap, ADR-0022).
    expect((await streamline.applyRecipe("1")).selection?.status).toBe(200);
    await settle();
    await loads(machines.a, one);
    const temperature = (await recipe(one)).content.brewTemperature;
    expect(firstTemperature(a)).toBe(temperature);
    const asked = dye2.a.asked.length;
    const edits = await editsOf(one, "brewTemperature");
    expect((await streamline.setYield(38.5)).status).toBe(200);
    await expect.poll(() => dye2.a.recorded.some((record) => record.id === "1" && record.patch.drink === 38.5), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await recipe(one)).content.yield, { timeout: 15_000 }).toBe(38.5);
    await expect.poll(() => context(c).targetYield, { timeout: 15_000 }).toBe(38.5);
    // Sent with the Workflow's own profile, at the Recipe's brew temperature (decentespresso/streamline-js#155).
    expect(firstTemperature(a)).toBe(temperature);
    await settle();
    expect((await recipe(one)).content.brewTemperature).toBe(temperature);
    expect(await editsOf(one, "brewTemperature")).toBe(edits);
    expect(dye2.a.asked.slice(asked)).toEqual([]);
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: "1" });
    await loads(machines.a, one);
    expect(named(a)).toBe(one);
  });

  it("leaves the Loaded Recipe's dial alone on a wake onto its profile in Streamline, and on a tap of that profile's button", async () => {
    const { machines, dye2, a, one } = await lab("Wake", 48051);
    const streamline = await startStreamline(a);
    await streamline.saveForProfile(ADAPTIVE, { targetDoseWeight: 18.8, targetYield: 39, brewTemperature: 91 });
    const content = (await recipe(one)).content;
    const dial = { dose: context(a).targetDoseWeight, yield: context(a).targetYield, grind: context(a).grinderSetting, temperature: firstTemperature(a) };
    const versionsBefore = (await versions(one)).length;
    // Streamline sends nothing, as DYE2 has a recipe selected on the profile the Workflow holds (decentespresso/streamline-js#153).
    expect(await streamline.wake(ADAPTIVE)).toBeUndefined();
    expect(await streamline.tapProfile(ADAPTIVE)).toBeUndefined();
    await settle();
    expect({ dose: context(a).targetDoseWeight, yield: context(a).targetYield, grind: context(a).grinderSetting, temperature: firstTemperature(a) }).toEqual(dial);
    expect((await recipe(one)).content).toEqual(content);
    expect((await versions(one)).length).toBe(versionsBefore);
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: "1" });
    await loads(machines.a, one);
  });

  it("writes an edit from another Machine into A's Workflow while A's DYE2 answers 404, and selects the slot again once DYE2 answers, after a Profile edit", async () => {
    const { machines, dye2, a, c, one } = await lab("Away", 48061);
    dye2.a.unload();
    await patch(one, { dose: 18.6 });
    await expect.poll(() => [context(a).targetDoseWeight, context(c).targetDoseWeight], { timeout: 15_000 }).toEqual([18.6, 18.6]);
    // A Profile edit written while DYE2 answers 404, which it would clear its selection on.
    await patch(one, { profileId: CLASSIC });
    await expect.poll(() => [profile(a).title, profile(c).title], { timeout: 15_000 }).toEqual(["Classic Italian espresso", "Classic Italian espresso"]);
    await expect.poll(() => dye2.c.selected()).toMatchObject({ kind: "recipe", id: "1" });
    await dye2.a.load();
    await expect.poll(() => dye2.a.selected()?.profileFingerprint, { timeout: 15_000 }).toBe(dye2.c.selected()?.profileFingerprint);
    await settle();
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    expect([named(a), named(c)]).toEqual([one, one]);
  });

  it("writes nothing back after a Shot stored with the Recipe selected, as Streamline leaves its batch, grinder, Basket and RPM in the Workflow", async () => {
    const { machines, a, one } = await lab("After Shot", 48071);
    const streamline = await startStreamline(a);
    const held = { batch: context(a).beanBatchId, grinder: context(a).grinderId, basket: extras(a).basketId, rpm: extras(a).rpm };
    expect(Object.values(held)).not.toContain(undefined);
    const edits = (await versions(one)).length;
    const writes = a.writes.filter((write) => write === "PUT /workflow").length;
    // Only who pulled it and for whom, and its note, are cleared (decentespresso/streamline-js#149).
    expect(await streamline.shotStored()).toEqual({ baristaName: null, drinkerName: null });
    await settle();
    expect({ batch: context(a).beanBatchId, grinder: context(a).grinderId, basket: extras(a).basketId, rpm: extras(a).rpm }).toEqual(held);
    expect(a.writes.filter((write) => write === "PUT /workflow").length).toBe(writes);
    expect(named(a)).toBe(one);
    await loads(machines.a, one);
    expect((await versions(one)).length).toBe(edits);
  });

  it("clears A's selection as its Recipe is taken out of its slot, Archived, or A is made capture-only, where a recipe then selected stays selected", async () => {
    const { machines, dye2, a, c, d, one, two, load } = await lab("Cleared", 48081);
    expect((await api.call("PUT", `/recipes/${one}/slot`, { slot: null })).status).toBe(200);
    for (const tablet of [a, c]) await expect.poll(() => named(tablet), { timeout: 15_000 }).toBeNull();
    for (const machine of [machines.a, machines.c]) await loads(machine, null);
    for (const selection of [dye2.a, dye2.c]) await expect.poll(() => selection.selected()).toBeNull();
    expect(dye2.d.selected()).toMatchObject({ kind: "recipe", id: "2" });

    await load(a, machines.a, "2", two);
    expect((await api.call("PUT", `/recipes/${two}/archived`, { archived: true })).status).toBe(200);
    for (const selection of [dye2.a, dye2.d]) await expect.poll(() => selection.selected(), { timeout: 15_000 }).toBeNull();
    for (const machine of [machines.a, machines.d]) await loads(machine, null);
    expect((await api.call("PUT", `/recipes/${two}/archived`, { archived: false })).status).toBe(200);
    expect((await api.call("PUT", `/recipes/${two}/slot`, { slot: 2 })).status).toBe(200);
    await expect.poll(() => dye2GlobalIdOf(inSlot(a, "2")), { timeout: 15_000 }).toBe(two);

    await load(a, machines.a, "2", two);
    expect((await api.call("PUT", `/machines/${machines.a.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    await loads(machines.a, null);
    await expect.poll(() => dye2.a.selected(), { timeout: 15_000 }).toBeNull();
    await expect.poll(() => a.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    // A recipe selected while capture-only stays selected, and DYE2 records into it.
    await (await openDye2Dashboard(a)).applyRecipe("2");
    await settle();
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: "2" });
    expect(await loadedRecipe(machines.a)).toBeNull();
    // Sharing again, it is the Machine's Loaded Recipe.
    expect((await api.call("PUT", `/machines/${machines.a.machine.id}/sharing`, { sharing: true })).status).toBe(200);
    await loads(machines.a, two);
  });

  it("selects a Recipe moved to another slot there, keeping it loaded, and records nothing into the recipe put in its old slot", async () => {
    const { machines, dye2, a, c, one, two } = await lab("Moved", 48091);
    expect((await api.call("PUT", `/recipes/${one}/slot`, { slot: 5 })).status).toBe(200);
    for (const selection of [dye2.a, dye2.c]) await expect.poll(() => selection.selected(), { timeout: 15_000 }).toMatchObject({ kind: "recipe", id: "5" });
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    // Slot 1 taken by slot 2's Recipe: a grind change on A is recorded into the Recipe in slot 5 alone.
    expect((await api.call("PUT", `/recipes/${two}/slot`, { slot: 1 })).status).toBe(200);
    await expect.poll(() => dye2GlobalIdOf(inSlot(a, "1")), { timeout: 15_000 }).toBe(two);
    const grind = (await recipe(two)).content.grindSetting;
    await a.changeSettings({ context: { grinderSetting: "2.2" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.2);
    expect((await recipe(two)).content.grindSetting).toBe(grind);
    expect(dye2.a.recorded.filter((record) => record.id === "1")).toEqual([]);
    expect([named(a), named(c)]).toEqual([one, one]);
  });
});
