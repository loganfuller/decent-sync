import { GLOBAL_ID_KEY, dye2GlobalIdOf, profileAtBrewTemperature } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeIdInWorkflow, recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import {
  DYE2_NAMESPACE,
  SimulatedDye2,
  dye2List,
  dye2NeverUsed,
  openDye2Dashboard,
  openDye2RecipeEditor,
  recordedDye2MainTablet,
  selectRecipeInDye2,
} from "./support/simulated-dye2.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #146, #173, #177, #187, #188, #189 and #216: a Machine
// follows its Loaded Recipe both ways (ADR-0022), and every change on it is
// saved into the Recipe. The plugin has DYE2 save each change of the
// Workflow into the Recipe's record (`record`): its dose, yield, grind
// setting, RPM, Basket and brew temperature where the record holds one, and
// a steam, hot water or flush setting it holds, or holds none of once it
// moves (recipe-settings.test.ts has the settings), an edit of the Recipe
// from that Machine's tablet, once. Decent Sync records itself what DYE2
// saves none of: a grinder, a batch of the Recipe's Bean, and a dose, yield,
// grind setting, RPM or Basket the Recipe holds none of, which a load also
// gains it from the Workflow. A change made while the plugin writes into
// the Workflow is saved too. A batch of another Bean and a value cleared
// stay the Machine's own, and nothing unloads it but a change of profile,
// which saves nothing into it. An edit of the Recipe from anywhere is written
// into the Workflow of every Machine that has it loaded, but the one it was
// made on, its brew temperature as on a load, and a Profile as two writes
// that keep it loaded (decentespresso/dye2#38); a stale copy applied is
// brought to it. Archiving the Recipe, or making the Machine capture-only,
// clears it from the Workflow; taking it out of its slot, or moving it to
// another, keeps it loaded. Through the built plugin in simulated tablets
// running DYE2 v0.1.26 and Streamline at cec5664 as recorded
// (fixtures/decaid/dye2-v0.1.26/), Machines A and D on one server instance
// and C on another sharing one database, with assertions through the REST
// API and what each simulated tablet holds. Serials are made up, from 48001.

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

/** The recording's profiles, by their ids: the Ethiopia's recipe's, and the Brazil's and the Workflow's. */
const ADAPTIVE = "profile:98fa00c191551b435845";
const CLASSIC = "profile:39e939592679fb194706";

/** The recording's tablet's record ids: the Ethiopia's recipe, in no Recipe Slot, and the Brazil's, in slot 2. */
const ETHIOPIA = "1";
const BRAZIL = "2";

/** The recording's tablet's ids for its batch of the Brazil, the grinder its recipes name none of, and its baskets. */
const RECORDED_BRAZIL_BATCH = "f4d73c51-7660-48ca-8deb-4c301443f2ce";
const RECORDED_GRINDER_83 = "f3d11140-520f-4d6c-a4c9-d79c217dffc8";
const BASKET_18 = "8f9702df-a615-4942-84db-882137fedcce";

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
  /** The tablet's recipe with that record id. */
  const record = (tablet: SimulatedTablet, id: string) => records(tablet).find((entry) => entry.id === id);
  const variables = (entry: Record_ | undefined) => (entry?.dashboardVariables ?? {}) as Record_;
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const extras = (tablet: SimulatedTablet) => (context(tablet).extras ?? {}) as Record_;
  const hotWater = (tablet: SimulatedTablet) => (tablet.workflow().hotWaterData ?? {}) as Record_;
  const profile = (tablet: SimulatedTablet) => tablet.workflow().profile as Record_;
  const firstTemperature = (tablet: SimulatedTablet) => ((profile(tablet).steps as Record_[])[0] ?? {}).temperature;
  /** The Recipe the tablet's Workflow names, through its records, or null. */
  const named = recipeNamedInWorkflow;
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: VersionView[] }>(`/recipes/${id}/history`)).versions;
  /** How many of the Recipe's versions set the field. */
  const editsOf = async (id: string, field: string) => (await versions(id)).filter((version) => field in version.fields).length;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  /** How many Loaded Recipes the Machine has had, its current one included. */
  const loadedTimes = async ({ machine }: CreatedMachine) => (await api.get<{ total: number }>(`/machines/${machine.id}/loaded-recipes`)).total;
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** The tablet's id for its record of a Library item, by the global id the record carries in its `extras`. */
  const localId = async (tablet: SimulatedTablet, route: string, globalId: string) => {
    const listed = (await tablet.callApi("GET", `${route}?includeArchived=true`)).body as Record_[];
    return listed.find((entry) => (entry.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] === globalId)?.id;
  };
  /** The global id the tablet's record of a Library item carries, by the tablet's id for it. */
  const globalOf = async (tablet: SimulatedTablet, route: string, local: string) => {
    const listed = (await tablet.callApi("GET", `${route}?includeArchived=true`)).body as Record_[];
    return (listed.find((entry) => entry.id === local)?.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] as string | undefined;
  };
  /** The Machine's current Workflow as the server holds it, or null. */
  const currentWorkflow = async ({ machine }: CreatedMachine) =>
    (await api.get<{ workflow: { workflow: Record_ } | null }>(`/machines/${machine.id}/workflow`)).workflow?.workflow ?? null;
  /** The fields of each write of a Loaded Recipe the server sent the tablet's plugin from `from` on. */
  const loadedRecipeWrites = (tablet: SimulatedTablet, from: number) =>
    (tablet.received.slice(from).filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "loadedRecipe") as { fields: Record_ }[]).map(({ fields }) => fields);
  /** How many times the plugin had DYE2 save into the recipe the Workflow names. */
  const saves = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === `POST /plugins/${DYE2_NAMESPACE}/record`).length;
  /** Waits a while for what should not happen, as a write to a Workflow that does not follow the Recipe. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, on
   * one instance, C on the other, and D on the first, both tablets where
   * DYE2 was never used, each running DYE2. A brings its recipes, which every
   * tablet there is written under their record ids, and the Ethiopia's (in no
   * slot) is applied from DYE2's Select Recipe page on A and C, and the
   * Brazil's (in slot 2) on D, which each loads. A's machine is connected.
   * `apiDelayMs` slows the answers A's Decaid gives the plugin, as the
   * simulated tablet's option of that name does.
   */
  async function lab(scenario: string, serial: number, options: { pollSeconds?: number; apiDelayMs?: (method: string, path: string) => number } = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      c: await api.createMachine(`${scenario} lab C`, here.id),
      d: await api.createMachine(`${scenario} lab D`, here.id),
    };
    const dye2 = { a: new SimulatedDye2(), c: new SimulatedDye2(), d: new SimulatedDye2() };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: dye2.a, pollSeconds: options.pollSeconds, apiDelayMs: options.apiDelayMs });
    await api.waitForOnline(machines.a);
    await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => dye2GlobalIdOf(record(a, id))), { timeout: 15_000 }).not.toContain(null);
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 1)), dye2: dye2.c });
    const d = syncingTablet(machines.d, server, { api: dye2NeverUsed(String(serial + 2)), dye2: dye2.d });
    await api.waitForOnline(machines.c, machines.d);
    const one = dye2GlobalIdOf(record(a, ETHIOPIA))!;
    const two = dye2GlobalIdOf(record(a, BRAZIL))!;
    // Each tablet holds both, naming the batch and Basket each uses by its own ids.
    for (const tablet of [c, d]) {
      await expect
        .poll(() => [ETHIOPIA, BRAZIL].map((id) => [dye2GlobalIdOf(record(tablet, id)), record(tablet, id)?.beanBatchId ?? null]).flat(), { timeout: 15_000 })
        .not.toContain(null);
      await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => variables(record(tablet, id)).basketId ?? null)).not.toContain(null);
    }
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, id: string, recipeId: string) => {
      expect((await selectRecipeInDye2(tablet, id)).applied?.workflow?.status).toBe(200);
      await expect.poll(() => named(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
    };
    await load(a, machines.a, ETHIOPIA, one);
    await load(c, machines.c, ETHIOPIA, one);
    await load(d, machines.d, BRAZIL, two);
    a.connectMachine();
    return { here, machines, dye2, a, c, d, one, two, load };
  }

  it("takes a grind and brew temperature change on A that DYE2 saves into the Recipe once each, and writes them into C's Workflow on the other instance, and no other's, A's included", async () => {
    const { machines, dye2, a, c, d, one } = await lab("Recorded", 48001);
    const grinds = await editsOf(one, "grindSetting");
    const received = a.received.length;
    await a.changeSettings({ context: { grinderSetting: "3.1" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.1);
    await expect.poll(() => context(c).grinderSetting, { timeout: 15_000 }).toBe("3.1");
    expect(dye2.a.recorded.at(-1)).toMatchObject({ id: ETHIOPIA, patch: { grind: 3.1 } });
    await settle();
    // The Workflow's change on A, which reached the server after DYE2's save, is no second edit.
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
      await expect.poll(() => ((((record(tablet, ETHIOPIA)!.workflow as Record_).profile as Record_).steps as Record_[])[0] ?? {}).temperature).toBe(90);
    }
    expect(context(d).grinderSetting).not.toBe("3.1");
    // Neither is written back into A's Workflow, which holds them.
    expect(loadedRecipeWrites(a, received).filter((fields) => "context.grinderSetting" in fields || "profile" in fields)).toEqual([]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("takes an RPM, Basket and hot water duration change on A that DYE2 saves into the Recipe, the duration one it held none of, and writes them into C's", async () => {
    const { dye2, a, c, one, two } = await lab("Workflow", 48011);
    const basket20 = (await recipe(two)).content.basketId as string;
    const basket = (dye2List(a, "baskets") as Record_[]).find((entry) => dye2GlobalIdOf(entry) === basket20)!.id;
    expect((await recipe(one)).content).not.toHaveProperty("hotWaterDuration");
    await a.changeSettings({ context: { extras: { rpm: 950, basketId: basket } }, hotWaterData: { duration: 33 } });
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ rpm: 950, hotWaterDuration: 33 });
    expect((await recipe(one)).content.basketId).toBe(basket20);
    await expect.poll(() => [extras(c).rpm, hotWater(c).duration], { timeout: 15_000 }).toEqual([950, 33]);
    expect(dye2.a.recorded.map((recorded) => recorded.patch)).toContainEqual(expect.objectContaining({ rpm: 950, basketId: basket, hotWaterTimeS: 33 }));
  });

  it("takes an RPM DYE2 saves as 0 as 0, not as blank (decentespresso/dye2#29), and writes it into C's", async () => {
    const { dye2, a, c, one } = await lab("Zero", 48151);
    await a.changeSettings({ context: { extras: { rpm: 0 } } });
    await expect.poll(async () => (await recipe(one)).content.rpm, { timeout: 15_000 }).toBe(0);
    expect(dye2.a.recorded.map((recorded) => recorded.patch)).toContainEqual(expect.objectContaining({ rpm: 0 }));
    await expect.poll(() => extras(c).rpm, { timeout: 15_000 }).toBe(0);
    expect(variables(record(c, ETHIOPIA)).rpm).toBe(0);
  });

  it("writes an RPM and dose saved in DYE2's editor on A, which has the Recipe loaded and applies it again, into C's Workflow, where they stay through A's next change", async () => {
    const { a, c, one } = await lab("Editor", 48161);
    // DYE2's editor saves the fields changed over a fresh read, and applies the recipe the Workflow names again.
    const saved = await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ rpm: 1333, dose: 19.5 }).save();
    expect(saved.reapplied).toBe(true);
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ rpm: 1333, dose: 19.5 });
    for (const tablet of [a, c]) {
      await expect.poll(() => [extras(tablet).rpm, context(tablet).targetDoseWeight], { timeout: 15_000 }).toEqual([1333, 19.5]);
    }
    expect(recipeIdInWorkflow(a)).toBe(ETHIOPIA);
    // A's next change of the Workflow, which DYE2 saves, keeps them.
    await a.changeSettings({ context: { grinderSetting: "3.3" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.3);
    await settle();
    expect((await recipe(one)).content).toMatchObject({ rpm: 1333, dose: 19.5 });
    expect([extras(c).rpm, context(c).targetDoseWeight]).toEqual([1333, 19.5]);
  });

  it("keeps an RPM cleared on A after DYE2's editor saved and applied it there and A changed on, writing the Recipe's back into none", async () => {
    const { a, c, one } = await lab("Editor cleared", 48231);
    // DYE2's editor on A saves the RPM and applies the recipe again, so A's Workflow holds it before the server takes it in.
    await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ rpm: 1333 }).save();
    await expect.poll(async () => (await recipe(one)).content.rpm, { timeout: 15_000 }).toBe(1333);
    await expect.poll(() => [extras(a).rpm, extras(c).rpm], { timeout: 15_000 }).toEqual([1333, 1333]);
    // A's next change, which DYE2 saves before its Workflow, holding the RPM, reaches the server.
    await a.changeSettings({ context: { grinderSetting: "2.7" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.7);
    await settle();
    // A value cleared on A is A's own: the Recipe's is not written back over it.
    const received = a.received.length;
    await a.changeSettings({ context: { extras: { rpm: null } } });
    await settle();
    await settle();
    expect(extras(a).rpm ?? null).toBeNull();
    expect(loadedRecipeWrites(a, received)).toEqual([]);
    expect((await recipe(one)).content.rpm).toBe(1333);
    expect(extras(c).rpm).toBe(1333);
  });

  // Fails: the Workflow holding the RPM DYE2's editor applied reaches the server before the editor's save, so it is not
  // taken as the Recipe's then (`heldAlready` against the Recipe as it was), and no Workflow of A's follows before the
  // clear, which `followMachine` judges from that Workflow alone: base keeps the RPM before the save, and the Recipe's is
  // written back over the clear. Taking each part the previous Workflow (`known.held`) holds as the Recipe does too would
  // cover it.
  it.fails("keeps an RPM cleared on A straight after DYE2's editor saved and applied it there, writing the Recipe's back into none", async () => {
    const { a, c, one } = await lab("Editor cleared at once", 48251);
    await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ rpm: 1333 }).save();
    await expect.poll(async () => (await recipe(one)).content.rpm, { timeout: 15_000 }).toBe(1333);
    await expect.poll(() => [extras(a).rpm, extras(c).rpm], { timeout: 15_000 }).toEqual([1333, 1333]);
    await settle();
    const received = a.received.length;
    await a.changeSettings({ context: { extras: { rpm: null } } });
    await settle();
    await settle();
    expect(extras(a).rpm ?? null).toBeNull();
    expect(loadedRecipeWrites(a, received)).toEqual([]);
  });

  it("saves into the Recipe a grind changed on A while the plugin's write of a Recipe edit into A's Workflow waits for Decaid", async () => {
    let slow = false;
    // 25 s at the tablet's pace, within Decaid's 30 s fetch timeout: half a second here.
    const { dye2, a, c, one } = await lab("During write", 48241, { apiDelayMs: (method, path) => (slow && method === "PUT" && path === "/workflow" ? 25_000 : 0) });
    expect(context(a).grinderSetting).toBe("2.5");
    const reads = a.requests.filter((route) => route === "/workflow").length;
    slow = true;
    await patch(one, { hotWaterVolume: 130 });
    // The plugin reads the Workflow, then its write of the hot water waits; the barista's grind change lands meanwhile, and
    // Decaid merges the write over it, answering with both.
    await expect.poll(() => a.requests.filter((route) => route === "/workflow").length, { timeout: 15_000 }).toBeGreaterThan(reads);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await a.changeSettings({ context: { grinderSetting: "9.9" } });
    await expect.poll(() => hotWater(a).volume, { timeout: 15_000 }).toBe(130);
    slow = false;
    expect(context(a).grinderSetting).toBe("9.9");
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(9.9);
    expect(dye2.a.recorded.map((recorded) => recorded.patch)).toContainEqual(expect.objectContaining({ grind: 9.9 }));
    await expect.poll(() => context(c).grinderSetting, { timeout: 15_000 }).toBe("9.9");
  });

  it("follows a grind DYE2 saved and an editor save made while A was offline, which reach the server in one report, writing a later edit into A's Workflow", async () => {
    // A's recipes are read at a welcome, not at its poll.
    const { machines, a, c, one } = await lab("Coalesced", 48171, { pollSeconds: 3600 });
    a.loseNetwork();
    await a.changeSettings({ context: { grinderSetting: "3.3" } });
    await expect.poll(() => variables(record(a, ETHIOPIA)).grind, { timeout: 15_000 }).toBe(3.3);
    // Then DYE2's editor saves a rename of the recipe, and the plugin reports both once it is back.
    await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ name: "Coalesced rename" }).save();
    a.restoreNetwork();
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ name: "Coalesced rename", grindSetting: 3.3 });
    await expect.poll(() => currentWorkflow(machines.a).then((workflow) => (workflow?.context as Record_ | undefined)?.grinderSetting), { timeout: 15_000 }).toBe("3.3");
    // An edit of the grind from elsewhere reaches A's Workflow as C's.
    await patch(one, { grindSetting: 3.5 });
    for (const tablet of [a, c]) await expect.poll(() => context(tablet).grinderSetting, { timeout: 15_000 }).toBe("3.5");
  });

  it("writes an RPM saved in A's record of the Recipe, read as the plugin writes the record, into A's Workflow too", async () => {
    const { a, c, one } = await lab("Answered", 48181, { pollSeconds: 3600 });
    // A save of the record DYE2's editor makes, stamping `capturedAt` anew (decentespresso/dye2#28), without its apply.
    const saved = records(a).map((entry) => (entry.id === ETHIOPIA ? { ...entry, capturedAt: new Date().toISOString(), dashboardVariables: { ...variables(entry), rpm: 1444 } } : entry));
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, saved)).status).toBe(200);
    // The Recipe's own edit has the plugin read and write its record: its answer carries the save.
    await patch(one, { dose: 19 });
    await expect.poll(async () => (await recipe(one)).content.rpm, { timeout: 15_000 }).toBe(1444);
    for (const tablet of [a, c]) await expect.poll(() => [extras(tablet).rpm, context(tablet).targetDoseWeight], { timeout: 15_000 }).toEqual([1444, 19]);
  });

  it("takes an RPM and Basket a Recipe holds none of as its own as they change on its Machine, which DYE2 saves none of, and writes them into D's", async () => {
    const { machines, dye2, a, d, two, load } = await lab("Unheld", 48131);
    await patch(two, { rpm: null, basketId: null });
    await expect.poll(() => [variables(record(a, BRAZIL)).rpm ?? null, variables(record(a, BRAZIL)).basketId ?? null], { timeout: 15_000 }).toEqual([null, null]);
    // A's Workflow holds none either as it loads it, so the load gains the Recipe neither.
    await a.changeSettings({ context: { extras: { rpm: null, basketId: null, basketName: null } } });
    await load(a, machines.a, BRAZIL, two);
    await settle();
    expect((await recipe(two)).content).not.toHaveProperty("rpm");
    expect((await recipe(two)).content).not.toHaveProperty("basketId");
    const received = a.received.length;
    await a.changeSettings({ context: { extras: { rpm: 1234, basketId: BASKET_18, basketName: "Fixture 18g Precision" } } });
    const basket18 = dye2GlobalIdOf((dye2List(a, "baskets") as Record_[]).find((entry) => entry.id === BASKET_18));
    await expect.poll(async () => (await recipe(two)).content, { timeout: 15_000 }).toMatchObject({ rpm: 1234, basketId: basket18 });
    expect(dye2.a.recorded.filter((recorded) => recorded.id === BRAZIL && "rpm" in recorded.patch)).toEqual([]);
    await expect.poll(() => extras(d).rpm, { timeout: 15_000 }).toBe(1234);
    await expect.poll(() => extras(d).basketId ?? null, { timeout: 15_000 }).toBe((dye2List(d, "baskets") as Record_[]).find((entry) => dye2GlobalIdOf(entry) === basket18)?.id);
    expect(await loadedRecipe(machines.a)).toBe(two);
    expect(loadedRecipeWrites(a, received)).toEqual([]);
  });

  it("gains a Recipe the grinder, Basket, RPM and dose it holds none of from the Workflow it is loaded on, and writes them into D's", async () => {
    const { machines, a, d, two, load } = await lab("Gains", 48121);
    await patch(two, { rpm: null, basketId: null, grinderId: null, dose: null });
    await expect.poll(() => [variables(record(a, BRAZIL)).rpm ?? null, variables(record(a, BRAZIL)).basketId ?? null, variables(record(a, BRAZIL)).dose ?? null], { timeout: 15_000 }).toEqual([
      null,
      null,
      null,
    ]);
    const held = { grinder: context(a).grinderId as string, basket: extras(a).basketId as string, rpm: extras(a).rpm, dose: context(a).targetDoseWeight };
    expect(Object.values(held)).not.toContain(undefined);
    await load(a, machines.a, BRAZIL, two);
    const grinder = await globalOf(a, "/grinders", held.grinder);
    await expect.poll(async () => (await recipe(two)).content, { timeout: 15_000 }).toMatchObject({ grinderId: grinder, rpm: held.rpm, dose: held.dose, basketId: expect.any(String) });
    await expect.poll(async () => [extras(d).rpm, context(d).targetDoseWeight, context(d).grinderId], { timeout: 15_000 }).toEqual([held.rpm, held.dose, await localId(d, "/grinders", grinder!)]);
    expect(extras(d).basketId).toBe(variables(record(d, BRAZIL)).basketId);
  });

  it("brings a Machine that applied an out-of-date copy of the Recipe to its dial, which the copy never sets back", async () => {
    const { machines, c, one, two, load } = await lab("Stale", 48191);
    await load(c, machines.c, BRAZIL, two);
    const doses = await editsOf(one, "dose");
    // C's record is written nothing while it is offline: it applies the copy it holds.
    c.loseNetwork();
    await patch(one, { dose: 18.6, grindSetting: 2.9 });
    expect((await selectRecipeInDye2(c, ETHIOPIA)).applied?.workflow?.status).toBe(200);
    expect([context(c).targetDoseWeight, context(c).grinderSetting]).toEqual([18, "2.5"]);
    c.restoreNetwork();
    await loads(machines.c, one);
    await expect.poll(() => [context(c).targetDoseWeight, context(c).grinderSetting], { timeout: 15_000 }).toEqual([18.6, "2.9"]);
    await settle();
    expect((await recipe(one)).content).toMatchObject({ dose: 18.6, grindSetting: 2.9 });
    expect(await editsOf(one, "dose")).toBe(doses + 1);
  });

  it("takes A's own set-back of its grind as an edit, and a grinder picked on A as the Recipe's, writing it into C's and keeping it loaded", async () => {
    const { machines, dye2, a, c, one } = await lab("Undo", 48021);
    const grind = (await recipe(one)).content.grindSetting;
    await a.changeSettings({ context: { grinderSetting: "2.9" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.9);
    // Set back by A's own barista: an undo, so an edit.
    await a.changeSettings({ context: { grinderSetting: String(grind) } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(grind);

    // The Location's other grinder picked on A: the Recipe's grinder, which DYE2 saves none of.
    const grinder = (await globalOf(a, "/grinders", RECORDED_GRINDER_83))!;
    await a.changeSettings({ context: { grinderId: RECORDED_GRINDER_83, grinderModel: "Fixture Grinder 83" } });
    await expect.poll(async () => (await recipe(one)).content.grinderId, { timeout: 15_000 }).toBe(grinder);
    await expect.poll(async () => context(c).grinderId, { timeout: 15_000 }).toBe(await localId(c, "/grinders", grinder));
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    expect(context(a).grinderId).toBe(RECORDED_GRINDER_83);
  });

  it("takes another batch of the Recipe's Bean picked on A as its batch, writing it into C's, and keeps a batch of another Bean and a grind cleared as A's own, the Recipe loaded", async () => {
    const { here, machines, dye2, a, c, one } = await lab("Next bag", 48141);
    const bean = (await recipe(one)).content.beanId as string;
    const created = await api.call("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const next = ((await created.json()) as { batch: { id: string } }).batch.id;
    let local: unknown;
    await expect.poll(async () => (local = await localId(a, "/bean-batches", next)), { timeout: 15_000 }).toEqual(expect.any(String));
    await a.changeSettings({ context: { beanBatchId: local } });
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(next);
    await expect.poll(async () => context(c).beanBatchId, { timeout: 15_000 }).toBe(await localId(c, "/bean-batches", next));
    await loads(machines.a, one);

    // A batch of the Brazil, and a grind cleared, on A: neither is the Recipe's, nor written back, and it stays loaded.
    const received = a.received.length;
    const versionsBefore = (await versions(one)).length;
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });
    await a.changeSettings({ context: { grinderSetting: null } });
    await settle();
    expect((await recipe(one)).content.beanBatchId).toBe(next);
    expect((await recipe(one)).content.grindSetting).toEqual(expect.any(Number));
    expect((await versions(one)).length).toBe(versionsBefore);
    expect([context(a).beanBatchId, context(a).grinderSetting ?? null]).toEqual([RECORDED_BRAZIL_BATCH, null]);
    expect(loadedRecipeWrites(a, received)).toEqual([]);
    expect(context(c).beanBatchId).toBe(await localId(c, "/bean-batches", next));
    expect(dye2.a.cleared).toEqual([]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    // A Shot pulled on the Brazil's batch is linked to the Recipe.
    a.pullShot(shotOf(a, "next-bag-brazil-48141", 48141));
    await expect.poll(async () => (await api.call("GET", "/shots/next-bag-brazil-48141")).status, { timeout: 15_000 }).toBe(200);
    expect((await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/next-bag-brazil-48141")).shot.recipe?.id).toBe(one);
  });

  it("writes a batch picked in DYE2's editor on A, and a grinder set in the management interface, into A's and C's Workflows, which keep the Recipe loaded and saving, a Shot pulled then linked", async () => {
    const { here, machines, a, c, one } = await lab("New roast", 48501);
    const times = await Promise.all([loadedTimes(machines.a), loadedTimes(machines.c)]);
    const bean = (await recipe(one)).content.beanId as string;
    const created = await api.call("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const next = ((await created.json()) as { batch: { id: string } }).batch.id;
    for (const tablet of [a, c]) await expect.poll(() => localId(tablet, "/bean-batches", next), { timeout: 15_000 }).toEqual(expect.any(String));

    // DYE2's editor on A picks the new batch for the recipe, which every Machine with the Recipe loaded is written.
    const held = record(a, ETHIOPIA)!;
    const picked = String(await localId(a, "/bean-batches", next));
    await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ bean: { id: String(held.beanId), name: String(held.beanName), batchId: picked } }).save();
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(next);
    for (const tablet of [a, c]) await expect.poll(async () => context(tablet).beanBatchId, { timeout: 15_000 }).toBe(await localId(tablet, "/bean-batches", next));

    // And a grinder set in the management interface.
    const grinder = (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: here.id, content: { model: "New roast Grinder 2" } }, 201)).grinder.id;
    for (const tablet of [a, c]) await expect.poll(() => localId(tablet, "/grinders", grinder), { timeout: 15_000 }).toEqual(expect.any(String));
    await patch(one, { grinderId: grinder });
    for (const tablet of [a, c]) await expect.poll(async () => context(tablet).grinderId, { timeout: 15_000 }).toBe(await localId(tablet, "/grinders", grinder));

    // Neither unloaded it meanwhile: DYE2 clears nothing on a batch or grinder.
    await settle();
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    expect([named(a), named(c)]).toEqual([one, one]);
    expect(await Promise.all([loadedTimes(machines.a), loadedTimes(machines.c)])).toEqual(times);
    c.pullShot(shotOf(c, "new-roast-48501", 48502));
    await expect.poll(async () => (await api.call("GET", "/shots/new-roast-48501")).status, { timeout: 15_000 }).toBe(200);
    expect((await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/new-roast-48501")).shot.recipe?.id).toBe(one);
    // DYE2 on C still saves into the Recipe.
    await c.changeSettings({ context: { grinderSetting: "3.4" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.4);
  });

  it("loads a recipe applied from Streamline's strip on a profile with a target weight, with the Workflow on the Recipe's batch, which DYE2 keeps named", async () => {
    const { machines, dye2, c, one, two } = await lab("Target", 48111);
    // Classic Italian espresso, the Brazil's, stops at a target weight, which DYE2's fingerprint leaves out (decentespresso/dye2#18).
    expect((await recipe(two)).content.profileId).toBe(CLASSIC);
    const held = record(c, BRAZIL)?.beanBatchId;
    expect(held).toEqual(expect.any(String));
    expect(context(c).beanBatchId).not.toBe(held);
    const times = await loadedTimes(machines.c);
    const streamline = await startStreamline(c);
    expect((await streamline.applyRecipe(2)).selection?.status).toBe(200);
    expect(typeof profile(c).target_weight).toBe("number");
    await loads(machines.c, two);
    await expect.poll(() => named(c), { timeout: 15_000 }).toBe(two);
    // The strip applies the batch the record's embedded Workflow holds.
    expect(context(c).beanBatchId).toBe(held);
    await settle();
    await dye2.c.settled();
    expect(dye2.c.cleared).toEqual([]);
    expect(dye2.c.selected()).toMatchObject({ kind: "recipe", id: BRAZIL });
    await loads(machines.c, two);
    expect(await loadedTimes(machines.c)).toBe(times + 1);
    expect(await loadedRecipe(machines.a)).toBe(one);
  });

  it("keeps the Recipe loaded through a yield set on Streamline's Drink tile, takes DYE2's save of it as the Recipe's yield, and writes it into C's Workflow", async () => {
    const { machines, dye2, a, c, one } = await lab("Drink", 48041);
    const streamline = await startStreamline(a);
    const temperature = (await recipe(one)).content.brewTemperature;
    expect(firstTemperature(a)).toBe(temperature);
    const edits = await editsOf(one, "brewTemperature");
    expect((await streamline.setYield(38.5)).status).toBe(200);
    await expect.poll(() => dye2.a.recorded.some((recorded) => recorded.id === ETHIOPIA && recorded.patch.drink === 38.5), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await recipe(one)).content.yield, { timeout: 15_000 }).toBe(38.5);
    await expect.poll(() => context(c).targetYield, { timeout: 15_000 }).toBe(38.5);
    // Sent with the Workflow's own profile, its target weight the yield (decentespresso/streamline-js#155).
    expect(firstTemperature(a)).toBe(temperature);
    await settle();
    expect((await recipe(one)).content.brewTemperature).toBe(temperature);
    expect(await editsOf(one, "brewTemperature")).toBe(edits);
    expect(dye2.a.cleared).toEqual([]);
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
    // Streamline sends nothing, as DYE2's selection names a recipe on the profile the Workflow holds (decentespresso/streamline-js#153).
    expect(await streamline.wake(ADAPTIVE)).toBeUndefined();
    expect(await streamline.tapProfile(ADAPTIVE)).toBeUndefined();
    await settle();
    expect({ dose: context(a).targetDoseWeight, yield: context(a).targetYield, grind: context(a).grinderSetting, temperature: firstTemperature(a) }).toEqual(dial);
    expect((await recipe(one)).content).toEqual(content);
    expect((await versions(one)).length).toBe(versionsBefore);
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    await loads(machines.a, one);
  });

  it("saves nothing into the Recipe as DYE2's profile picker switches A's profile, which unloads it", async () => {
    const { machines, dye2, a, c, one } = await lab("Picker", 48221);
    const content = (await recipe(one)).content;
    const versionsBefore = (await versions(one)).length;
    const saved = saves(a);
    // The picker writes only the profile, the other profile at its own brew temperature, and DYE2 clears the recipe a
    // moment later.
    const classic = (((await a.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((entry) => entry.id === CLASSIC)!).profile as Record_;
    expect((await a.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    await dye2.a.settled();
    expect(recipeIdInWorkflow(a)).toBeNull();
    await loads(machines.a, null);
    await settle();
    expect(saves(a)).toBe(saved);
    expect(dye2.a.recorded.filter((recorded) => "brewC" in recorded.patch)).toEqual([]);
    expect((await recipe(one)).content).toEqual(content);
    expect((await versions(one)).length).toBe(versionsBefore);
    // C keeps it loaded on its own profile.
    await loads(machines.c, one);
    expect(profile(c).title).toBe("Adaptive v3");
  });

  it("writes a Profile edit into A's and C's Workflows as two writes each, which keep the Recipe named and loaded on both, the server recording no unload", async () => {
    const { machines, dye2, a, c, one } = await lab("Profile", 48061);
    const times = await Promise.all([loadedTimes(machines.a), loadedTimes(machines.c)]);
    await patch(one, { profileId: CLASSIC });
    await expect.poll(() => [profile(a).title, profile(c).title], { timeout: 15_000 }).toEqual(["Classic Italian espresso", "Classic Italian espresso"]);
    await Promise.all([dye2.a.settled(), dye2.c.settled()]);
    await settle();
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
    expect([dye2.a.cleared, dye2.c.cleared]).toEqual([[], []]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    expect(await Promise.all([loadedTimes(machines.a), loadedTimes(machines.c)])).toEqual(times);
    // DYE2 holds the new profile as the one the recipe was named on, so A's next change is saved into it.
    await a.changeSettings({ context: { grinderSetting: "2.8" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.8);
    await expect.poll(() => context(c).grinderSetting, { timeout: 15_000 }).toBe("2.8");
  });

  it("writes an edit made while A's DYE2 was away into A's Workflow once it is back, A having no Loaded Recipe meanwhile", async () => {
    const { machines, dye2, a, c, one } = await lab("Away", 48211);
    dye2.a.unload();
    await loads(machines.a, null);
    await patch(one, { dose: 18.6 });
    await expect.poll(() => context(c).targetDoseWeight, { timeout: 15_000 }).toBe(18.6);
    await settle();
    expect(context(a).targetDoseWeight).not.toBe(18.6);
    await dye2.a.load();
    await loads(machines.a, one);
    await expect.poll(() => context(a).targetDoseWeight, { timeout: 15_000 }).toBe(18.6);
    expect(recipeIdInWorkflow(a)).toBe(ETHIOPIA);
    expect(dye2.a.cleared).toEqual([]);
  });

  it("writes nothing back after a Shot stored with the Recipe loaded, as Streamline clears only the note", async () => {
    const { machines, a, one } = await lab("After Shot", 48071);
    const streamline = await startStreamline(a);
    await a.changeSettings({ context: { extras: { note: "After Shot note" } } });
    await settle();
    const held = { batch: context(a).beanBatchId, grinder: context(a).grinderId, basket: extras(a).basketId, rpm: extras(a).rpm };
    expect(Object.values(held)).not.toContain(undefined);
    const edits = (await versions(one)).length;
    const writes = a.writes.filter((write) => write === "PUT /workflow").length;
    // Only the note is cleared (decentespresso/streamline-js#164).
    expect(await streamline.shotStored()).toEqual({ extras: { note: null } });
    await settle();
    expect({ batch: context(a).beanBatchId, grinder: context(a).grinderId, basket: extras(a).basketId, rpm: extras(a).rpm }).toEqual(held);
    expect(a.writes.filter((write) => write === "PUT /workflow").length).toBe(writes);
    expect(named(a)).toBe(one);
    await loads(machines.a, one);
    expect((await versions(one)).length).toBe(edits);
  });

  it("keeps D's Recipe loaded as it is taken out of its slot, and clears A's and C's as theirs is Archived, or A is made capture-only, where a recipe then applied stays named", async () => {
    const { machines, dye2, a, c, d, one, two, load } = await lab("Cleared", 48081);
    expect((await api.call("PUT", `/recipes/${two}/slot`, { slot: null })).status).toBe(200);
    await expect.poll(() => record(d, BRAZIL)?.stripSlot, { timeout: 15_000 }).toBeNull();
    await settle();
    expect(recipeIdInWorkflow(d)).toBe(BRAZIL);
    await loads(machines.d, two);

    expect((await api.call("PUT", `/recipes/${one}/archived`, { archived: true })).status).toBe(200);
    for (const tablet of [a, c]) await expect.poll(() => recipeIdInWorkflow(tablet), { timeout: 15_000 }).toBeNull();
    for (const machine of [machines.a, machines.c]) await loads(machine, null);
    expect(recipeIdInWorkflow(d)).toBe(BRAZIL);
    expect((await api.call("PUT", `/recipes/${one}/archived`, { archived: false })).status).toBe(200);
    await expect.poll(() => dye2GlobalIdOf(record(a, ETHIOPIA)), { timeout: 15_000 }).toBe(one);

    await load(a, machines.a, ETHIOPIA, one);
    expect((await api.call("PUT", `/machines/${machines.a.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    await loads(machines.a, null);
    await expect.poll(() => recipeIdInWorkflow(a), { timeout: 15_000 }).toBeNull();
    await expect.poll(() => a.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    // A recipe applied while capture-only stays named, and nothing is saved into it.
    const saved = saves(a);
    await selectRecipeInDye2(a, ETHIOPIA);
    await a.changeSettings({ context: { grinderSetting: "2.2" } });
    await settle();
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    expect(await loadedRecipe(machines.a)).toBeNull();
    expect(saves(a)).toBe(saved);
    // Sharing again, it is the Machine's Loaded Recipe.
    expect((await api.call("PUT", `/machines/${machines.a.machine.id}/sharing`, { sharing: true })).status).toBe(200);
    await loads(machines.a, one);
  });

  it("keeps a Recipe moved to another slot loaded, its record keeping its id, and saves a change into it alone", async () => {
    const { machines, dye2, a, c, d, one, two } = await lab("Moved", 48091);
    const times = await loadedTimes(machines.d);
    expect((await api.call("PUT", `/recipes/${two}/slot`, { slot: 5 })).status).toBe(200);
    for (const tablet of [a, c, d]) await expect.poll(() => record(tablet, BRAZIL)?.stripSlot, { timeout: 15_000 }).toBe(5);
    await settle();
    expect(recipeIdInWorkflow(d)).toBe(BRAZIL);
    await loads(machines.d, two);
    expect(await loadedTimes(machines.d)).toBe(times);
    // The Ethiopia's, in no slot, put in slot 2: a grind change on A is saved into it alone.
    expect((await api.call("PUT", `/recipes/${one}/slot`, { slot: 2 })).status).toBe(200);
    await expect.poll(() => record(a, ETHIOPIA)?.stripSlot, { timeout: 15_000 }).toBe(2);
    const grind = (await recipe(two)).content.grindSetting;
    await a.changeSettings({ context: { grinderSetting: "2.2" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.2);
    expect((await recipe(two)).content.grindSetting).toBe(grind);
    expect(dye2.a.recorded.filter((recorded) => recorded.id === BRAZIL)).toEqual([]);
    expect([named(a), named(c)]).toEqual([one, one]);
  });
});

/** A Shot pulled on the tablet now, with its Workflow as it stands, its samples a tenth of a second apart, on the machine with that serial. */
function shotOf(tablet: SimulatedTablet, id: string, serial: number): Record_ {
  const fixture = shotFixture();
  const samples = fixture.measurements as Record_[];
  const startedAt = Date.now() - (samples.length - 1) * 100;
  const measurements = samples.map((sample, index) => ({
    ...sample,
    machine: { ...(sample.machine as Record_), timestamp: new Date(startedAt + index * 100).toISOString().slice(0, -1) },
  }));
  const machine = { ...((fixture.workflow as Record_).machine as Record_), serialNumber: String(serial) };
  return { ...fixture, id, timestamp: new Date(startedAt).toISOString(), workflow: { ...structuredClone(tablet.workflow()), machine }, measurements };
}
