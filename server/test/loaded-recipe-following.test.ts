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
import { quiesced } from "./support/quiet.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
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
// running DYE2 v0.1.32 and Streamline at cec5664 as recorded
// (fixtures/decaid/dye2-v0.1.26/), Machine A, and D in the tests that use
// it, on one server instance and C on another sharing one database, with
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

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, on
   * one instance, C on the other, and, with `d`, D on the first, both
   * tablets where DYE2 was never used, each running DYE2. A brings its
   * recipes, which every tablet there is written under their record ids,
   * and the Ethiopia's (in no slot) is applied from DYE2's Select Recipe page
   * on A and C, and the Brazil's (in slot 2) on D, which each loads, in that
   * order. A's machine is connected. `apiDelayMs` slows the answers A's
   * Decaid gives the plugin, and `timeScale` sets how much faster than real
   * time A's clock runs (50x by default), as the simulated tablet's options
   * of those names do. `quiet()` resolves once every tablet and Machine of the lab, and
   * the Streamlines given, have nothing left under way (`quiesced`), so a
   * wrong write a step set off has landed before a check after it that it
   * did not happen.
   */
  async function lab<WithD extends boolean = false>(
    scenario: string,
    serial: number,
    options: { pollSeconds?: number; apiDelayMs?: (method: string, path: string) => number; timeScale?: number; d?: WithD } = {},
  ) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      c: await api.createMachine(`${scenario} lab C`, here.id),
      d: options.d ? await api.createMachine(`${scenario} lab D`, here.id) : undefined,
    };
    const dye2 = { a: new SimulatedDye2(), c: new SimulatedDye2(), d: options.d ? new SimulatedDye2() : undefined };
    const a = syncingTablet(machines.a, server, {
      api: recordedDye2MainTablet(String(serial), scenario),
      dye2: dye2.a,
      pollSeconds: options.pollSeconds,
      apiDelayMs: options.apiDelayMs,
      timeScale: options.timeScale,
    });
    await api.waitForOnline(machines.a);
    await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => dye2GlobalIdOf(record(a, id))), { timeout: 15_000 }).not.toContain(null);
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 1)), dye2: dye2.c });
    const d = machines.d ? syncingTablet(machines.d, server, { api: dye2NeverUsed(String(serial + 2)), dye2: dye2.d }) : undefined;
    await api.waitForOnline(machines.c, ...(machines.d ? [machines.d] : []));
    const one = dye2GlobalIdOf(record(a, ETHIOPIA))!;
    const two = dye2GlobalIdOf(record(a, BRAZIL))!;
    // Each tablet holds both, naming the batch and Basket each uses by its own ids.
    for (const tablet of d ? [c, d] : [c]) {
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
    if (d && machines.d) await load(d, machines.d, BRAZIL, two);
    a.connectMachine();
    const tablets: Record<string, SimulatedTablet> = d ? { a, c, d } : { a, c };
    const followed: Record<string, CreatedMachine> = machines.d ? { a: machines.a, c: machines.c, d: machines.d } : { a: machines.a, c: machines.c };
    const quiet = (streamlines: Record<string, SimulatedStreamline> = {}) => quiesced(api, { tablets, machines: followed, streamlines });
    return {
      here,
      machines: machines as typeof machines & { d: WithD extends true ? CreatedMachine : undefined },
      dye2: dye2 as typeof dye2 & { d: WithD extends true ? SimulatedDye2 : undefined },
      a,
      c,
      d: d as WithD extends true ? SimulatedTablet : undefined,
      one,
      two,
      load,
      quiet,
    };
  }

  it("takes a grind and brew temperature change on A that DYE2 saves into the Recipe once each, and writes them into C's Workflow on the other instance, and no other's, A's included", async () => {
    const { machines, dye2, a, c, d, one, quiet } = await lab("Recorded", 48001, { d: true });
    const grinds = await editsOf(one, "grindSetting");
    const received = a.received.length;
    await a.changeSettings({ context: { grinderSetting: "3.1" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.1);
    await expect.poll(() => context(c).grinderSetting, { timeout: 15_000 }).toBe("3.1");
    expect(dye2.a.recorded.at(-1)).toMatchObject({ id: ETHIOPIA, patch: { grind: 3.1 } });
    // Once A's report of the Workflow holding the grind has been taken in.
    await quiet();
    // The Workflow's change on A, which reached the server after DYE2's save, is no second edit.
    expect(await editsOf(one, "grindSetting")).toBe(grinds + 1);

    // Its brew temperature, set on A as Streamline's Brew tile sets one: every step moved by the same amount.
    const temperatures = await editsOf(one, "brewTemperature");
    await a.changeSettings({ profile: profileAtBrewTemperature(profile(a), 90)! });
    await expect.poll(async () => (await recipe(one)).content.brewTemperature, { timeout: 15_000 }).toBe(90);
    await expect.poll(() => firstTemperature(c), { timeout: 15_000 }).toBe(90);
    expect(((profile(c).steps as Record_[])[2] ?? {}).temperature).toBe(85);
    // Once A's report of the Workflow holding the brew temperature has been taken in.
    await quiet();
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

  it("writes an RPM and dose saved in DYE2's editor on A, which has the Recipe loaded and applies it again, into C's Workflow, where they stay through A's next change, and keeps the RPM then cleared on A, writing the Recipe's back into none", async () => {
    const { a, c, one, quiet } = await lab("Editor cleared", 48231);
    // DYE2's editor on A saves the fields changed over a fresh read, and applies the recipe the Workflow names again, so A's
    // Workflow holds them before the server takes them in.
    const saved = await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ rpm: 1333, dose: 19.5 }).save();
    expect(saved.reapplied).toBe(true);
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ rpm: 1333, dose: 19.5 });
    for (const tablet of [a, c]) {
      await expect.poll(() => [extras(tablet).rpm, context(tablet).targetDoseWeight], { timeout: 15_000 }).toEqual([1333, 19.5]);
    }
    expect(recipeIdInWorkflow(a)).toBe(ETHIOPIA);
    // A's next change, which DYE2 saves before its Workflow, holding them, reaches the server, keeps them.
    await a.changeSettings({ context: { grinderSetting: "2.7" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.7);
    // Once A's report of the Workflow holding the grind, and the grind's write into C's, are done.
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ rpm: 1333, dose: 19.5 });
    expect([extras(c).rpm, context(c).targetDoseWeight]).toEqual([1333, 19.5]);
    // A value cleared on A is A's own: the Recipe's is not written back over it.
    const received = a.received.length;
    await a.changeSettings({ context: { extras: { rpm: null } } });
    // Once DYE2's save of the clear and A's report of it have been taken in, and any write they made the server due.
    await quiet();
    expect(extras(a).rpm ?? null).toBeNull();
    expect(loadedRecipeWrites(a, received)).toEqual([]);
    expect((await recipe(one)).content.rpm).toBe(1333);
    expect(extras(c).rpm).toBe(1333);
  });

  // The Workflow holding the RPM DYE2's editor applied reaches the server before the editor's save, so it is taken as the
  // Recipe's only as the clear arrives, from the Workflow held before it (`followMachine`).
  it("keeps an RPM cleared on A straight after DYE2's editor saved and applied it there, writing the Recipe's back into none", async () => {
    const { a, c, one, quiet } = await lab("Editor cleared at once", 48251);
    await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ rpm: 1333 }).save();
    await expect.poll(async () => (await recipe(one)).content.rpm, { timeout: 15_000 }).toBe(1333);
    await expect.poll(() => [extras(a).rpm, extras(c).rpm], { timeout: 15_000 }).toEqual([1333, 1333]);
    // Once the editor's save has been taken in and written, so the frames counted from here are the clear's.
    await quiet();
    const received = a.received.length;
    await a.changeSettings({ context: { extras: { rpm: null } } });
    // Once DYE2's save of the clear and A's report of it have been taken in, and any write they made the server due.
    await quiet();
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

  it("keeps a grind edit that DYE2 saves A's Workflow's `.5` over before the edit's write into it lands, `.5` being 0.5", async () => {
    const { dye2, a, c, one, quiet } = await lab("Typed grind", 48711);
    // Typed on A as `.5`, which DYE2 saves into the record as 0.5 (`grindValue`).
    await a.changeSettings({ context: { grinderSetting: ".5" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(0.5);
    await quiet();
    // An edit of the grind reaches A's record, and Decaid refuses its write into A's Workflow, so the Workflow keeps `.5`.
    a.refuseWrites = ({ method, route, body }) =>
      method === "PUT" && route === "/workflow" && "grinderSetting" in (((body as Record_ | null)?.context ?? {}) as Record_) ? { status: 400, body: { error: "refused" } } : undefined;
    await patch(one, { grindSetting: 0.6 });
    await expect.poll(() => variables(record(a, ETHIOPIA)).grind, { timeout: 15_000 }).toBe(0.6);
    await expect.poll(() => a.writes.includes("PUT /workflow"), { timeout: 15_000 }).toBe(true);
    await quiet();
    a.refuseWrites = undefined;
    expect(context(a).grinderSetting).toBe(".5");
    // Streamline's Save changes on A has DYE2 save the Workflow's dial into the record: its `.5`, as 0.5, over the edit's
    // 0.6, a stale save of the grind the write is still to bring, which the server writes the Recipe's back over.
    expect((await a.callApi("POST", `/plugins/${DYE2_NAMESPACE}/record`)).status).toBe(200);
    expect(dye2.a.recorded.at(-1)).toEqual({ id: ETHIOPIA, patch: { grind: 0.5 } });
    await expect.poll(() => variables(record(a, ETHIOPIA)).grind, { timeout: 15_000 }).toBe(0.6);
    // A, connecting again, is asked for the refused write again, which Decaid now takes.
    a.loseNetwork();
    a.restoreNetwork();
    await expect.poll(() => context(a).grinderSetting, { timeout: 15_000 }).toBe("0.6");
    await quiet();
    expect((await recipe(one)).content.grindSetting).toBe(0.6);
    expect([context(c).grinderSetting, variables(record(a, ETHIOPIA)).grind]).toEqual(["0.6", 0.6]);
  });

  it("keeps an RPM cleared on A while the plugin's read for writing a Recipe edit of it was on its way, writing the edit into none", async () => {
    let slow = false;
    let reading = false;
    // 25 s at the tablet's pace, within Decaid's 30 s fetch timeout: half a second here. Answered as it is then.
    const { a, c, one, quiet } = await lab("Cleared meanwhile", 48261, {
      apiDelayMs: (method, path) => {
        if (!slow || method !== "GET" || path !== "/workflow") return 0;
        reading = true;
        return 25_000;
      },
    });
    expect(extras(a).rpm).toBe(900);
    slow = true;
    await patch(one, { rpm: 1333 });
    // The plugin reads A's Workflow to write the edit, and the barista clears the RPM before Decaid answers.
    await expect.poll(() => reading, { timeout: 15_000 }).toBe(true);
    await a.changeSettings({ context: { extras: { rpm: null } } });
    await expect.poll(() => extras(c).rpm, { timeout: 15_000 }).toBe(1333);
    slow = false;
    // Once the edit's write into A's Workflow, and A's report of the clear, are done.
    await quiet();
    expect(extras(a).rpm ?? null).toBeNull();
    expect((await recipe(one)).content.rpm).toBe(1333);
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
    const { machines, dye2, a, d, two, load, quiet } = await lab("Unheld", 48131, { d: true });
    await patch(two, { rpm: null, basketId: null });
    await expect.poll(() => [variables(record(a, BRAZIL)).rpm ?? null, variables(record(a, BRAZIL)).basketId ?? null], { timeout: 15_000 }).toEqual([null, null]);
    // A's Workflow holds none either as it loads it, so the load gains the Recipe neither.
    await a.changeSettings({ context: { extras: { rpm: null, basketId: null, basketName: null } } });
    await load(a, machines.a, BRAZIL, two);
    // Once the load has been taken in.
    await quiet();
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
    const { machines, a, d, two, load } = await lab("Gains", 48121, { d: true });
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
    const { machines, c, one, two, load, quiet } = await lab("Stale", 48191);
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
    // Once C's report of the Workflow brought to the Recipe has been taken in.
    await quiet();
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
    await expect.poll(() => localId(c, "/grinders", grinder), { timeout: 15_000 }).toEqual(expect.any(String));
    await expect.poll(async () => context(c).grinderId, { timeout: 15_000 }).toBe(await localId(c, "/grinders", grinder));
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    expect(context(a).grinderId).toBe(RECORDED_GRINDER_83);
  });

  it("takes another batch of the Recipe's Bean picked on A as its batch, writing it into C's, and keeps a batch of another Bean and a grind cleared as A's own, the Recipe loaded", async () => {
    const { here, machines, dye2, a, c, one, quiet } = await lab("Next bag", 48141);
    const bean = (await recipe(one)).content.beanId as string;
    const created = await api.call("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] });
    expect(created.status).toBe(201);
    const next = ((await created.json()) as { batch: { id: string } }).batch.id;
    let local: unknown;
    await expect.poll(async () => (local = await localId(a, "/bean-batches", next)), { timeout: 15_000 }).toEqual(expect.any(String));
    await a.changeSettings({ context: { beanBatchId: local } });
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(next);
    // C's record of the batch first, so the id expected of C's Workflow is read once it exists.
    await expect.poll(() => localId(c, "/bean-batches", next), { timeout: 15_000 }).toEqual(expect.any(String));
    await expect.poll(async () => context(c).beanBatchId, { timeout: 15_000 }).toBe(await localId(c, "/bean-batches", next));
    await loads(machines.a, one);

    // A batch of the Brazil, and a grind cleared, on A: neither is the Recipe's, nor written back, and it stays loaded.
    const received = a.received.length;
    const versionsBefore = (await versions(one)).length;
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });
    await a.changeSettings({ context: { grinderSetting: null } });
    // Once A's reports of the batch and the grind cleared have been taken in.
    await quiet();
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

  it("takes a batch picked on A as a Recipe naming no Bean's, with its Bean, as any change, writing it into C's, the Recipe loaded", async () => {
    const { machines, a, c, one, quiet } = await lab("No bean bag", 48701);
    // The Recipe left with no Bean in the management interface: its records hold the nulls for one, and the Machines keep
    // their batch, which loading it again would clear.
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { beanBatchId: null } })).status).toBe(200);
    expect((await recipe(one)).content).not.toHaveProperty("beanId");
    await expect.poll(() => (record(c, ETHIOPIA)?.workflow as { context: Record_ }).context, { timeout: 15_000 }).toMatchObject({ coffeeName: null, coffeeRoaster: null, beanBatchId: null });
    await quiet();
    // A batch picked on A is a change like any other: the Recipe takes it, with its Bean (the owner, 2026-10-28), and C's
    // Workflow is written it.
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(brazilBatch);
    expect((await recipe(one)).content.beanId).toEqual(expect.any(String));
    await expect.poll(() => record(c, ETHIOPIA)?.beanBatchId, { timeout: 15_000 }).toBe(await localId(c, "/bean-batches", brazilBatch));
    await expect.poll(async () => context(c).beanBatchId, { timeout: 15_000 }).toBe(await localId(c, "/bean-batches", brazilBatch));
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("writes a batch picked in DYE2's editor on A, and a grinder set in the management interface, into A's and C's Workflows, which keep the Recipe loaded and saving, a Shot pulled then linked", async () => {
    const { here, machines, a, c, one, quiet } = await lab("New roast", 48501);
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

    // Neither unloaded it meanwhile: DYE2 clears nothing on a batch or grinder. Once the grinder's writes, and A's and C's
    // reports of them, are done.
    await quiet();
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
    const { machines, dye2, c, one, two, quiet } = await lab("Target", 48111);
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
    // Once C's report of the recipe applied, DYE2's checks of it and Streamline's replies are done.
    await quiet({ streamline });
    expect(dye2.c.cleared).toEqual([]);
    expect(dye2.c.selected()).toMatchObject({ kind: "recipe", id: BRAZIL });
    await loads(machines.c, two);
    expect(await loadedTimes(machines.c)).toBe(times + 1);
    expect(await loadedRecipe(machines.a)).toBe(one);
  });

  it("keeps the Recipe loaded through a yield set on Streamline's Drink tile, takes DYE2's save of it as the Recipe's yield, and writes it into C's Workflow", async () => {
    const { machines, dye2, a, c, one, quiet } = await lab("Drink", 48041);
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
    // Once A's report of the yield and DYE2's save of it have been taken in, and Streamline has replied.
    await quiet({ streamline });
    expect((await recipe(one)).content.brewTemperature).toBe(temperature);
    expect(await editsOf(one, "brewTemperature")).toBe(edits);
    expect(dye2.a.cleared).toEqual([]);
    await loads(machines.a, one);
    expect(named(a)).toBe(one);
  });

  it("leaves the Loaded Recipe's dial alone on a wake onto its profile in Streamline, and on a tap of that profile's button", async () => {
    const { machines, dye2, a, one, quiet } = await lab("Wake", 48051);
    const streamline = await startStreamline(a);
    await streamline.saveForProfile(ADAPTIVE, { targetDoseWeight: 18.8, targetYield: 39, brewTemperature: 91 });
    const content = (await recipe(one)).content;
    const dial = { dose: context(a).targetDoseWeight, yield: context(a).targetYield, grind: context(a).grinderSetting, temperature: firstTemperature(a) };
    const versionsBefore = (await versions(one)).length;
    // Streamline sends nothing, as DYE2's selection names a recipe on the profile the Workflow holds (decentespresso/streamline-js#153).
    expect(await streamline.wake(ADAPTIVE)).toBeUndefined();
    expect(await streamline.tapProfile(ADAPTIVE)).toBeUndefined();
    // Once anything the wake and the tap set off is done.
    await quiet({ streamline });
    expect({ dose: context(a).targetDoseWeight, yield: context(a).targetYield, grind: context(a).grinderSetting, temperature: firstTemperature(a) }).toEqual(dial);
    expect((await recipe(one)).content).toEqual(content);
    expect((await versions(one)).length).toBe(versionsBefore);
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    await loads(machines.a, one);
  });

  it("saves nothing into the Recipe as DYE2's profile picker switches A's profile, which unloads it", async () => {
    const { machines, dye2, a, c, one, quiet } = await lab("Picker", 48221);
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
    // Once A's report of the Workflow with the recipe cleared has been taken in.
    await quiet();
    expect(saves(a)).toBe(saved);
    expect(dye2.a.recorded.filter((recorded) => "brewC" in recorded.patch)).toEqual([]);
    expect((await recipe(one)).content).toEqual(content);
    expect((await versions(one)).length).toBe(versionsBefore);
    // C keeps it loaded on its own profile.
    await loads(machines.c, one);
    expect(profile(c).title).toBe("Adaptive v3");
  });

  it("writes a Profile edit into A's and C's Workflows as two writes each, which keep the Recipe named and loaded on both, the server recording no unload", async () => {
    const { machines, dye2, a, c, one, quiet } = await lab("Profile", 48061);
    const times = await Promise.all([loadedTimes(machines.a), loadedTimes(machines.c)]);
    await patch(one, { profileId: CLASSIC });
    await expect.poll(() => [profile(a).title, profile(c).title], { timeout: 15_000 }).toEqual(["Classic Italian espresso", "Classic Italian espresso"]);
    // Once the second of each pair of writes, and A's and C's reports of them, are done.
    await quiet();
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
    const { machines, dye2, a, c, one, quiet } = await lab("Away", 48211);
    dye2.a.unload();
    await loads(machines.a, null);
    await patch(one, { dose: 18.6 });
    await expect.poll(() => context(c).targetDoseWeight, { timeout: 15_000 }).toBe(18.6);
    // A's own wait: the edit's write into A's record of the Recipe, which goes ahead while DYE2 is away, has landed, and with
    // it anything else the edit made the server due on A.
    await expect.poll(() => variables(record(a, ETHIOPIA)).dose, { timeout: 15_000 }).toBe(18.6);
    await quiet();
    expect(context(a).targetDoseWeight).not.toBe(18.6);
    await dye2.a.load();
    await loads(machines.a, one);
    await expect.poll(() => context(a).targetDoseWeight, { timeout: 15_000 }).toBe(18.6);
    expect(recipeIdInWorkflow(a)).toBe(ETHIOPIA);
    expect(dye2.a.cleared).toEqual([]);
  });

  it("writes nothing back after a Shot stored with the Recipe loaded, as Streamline clears only the note", async () => {
    const { machines, a, one, quiet } = await lab("After Shot", 48071);
    const streamline = await startStreamline(a);
    await a.changeSettings({ context: { extras: { note: "After Shot note" } } });
    // Once A's report of the note, and Streamline's reply to it, are done.
    await quiet({ streamline });
    const held = { batch: context(a).beanBatchId, grinder: context(a).grinderId, basket: extras(a).basketId, rpm: extras(a).rpm };
    expect(Object.values(held)).not.toContain(undefined);
    const edits = (await versions(one)).length;
    const writes = a.writes.filter((write) => write === "PUT /workflow").length;
    // Only the note is cleared (decentespresso/streamline-js#164).
    expect(await streamline.shotStored()).toEqual({ extras: { note: null } });
    // Once A's report of the note cleared has been taken in, and Streamline has replied.
    await quiet({ streamline });
    expect({ batch: context(a).beanBatchId, grinder: context(a).grinderId, basket: extras(a).basketId, rpm: extras(a).rpm }).toEqual(held);
    expect(a.writes.filter((write) => write === "PUT /workflow").length).toBe(writes);
    expect(named(a)).toBe(one);
    await loads(machines.a, one);
    expect((await versions(one)).length).toBe(edits);
  });

  it("keeps D's Recipe loaded as it is taken out of its slot, and clears A's and C's as theirs is Archived, or A is made capture-only, where a recipe then applied stays named", async () => {
    const { machines, dye2, a, c, d, one, two, load, quiet } = await lab("Cleared", 48081, { d: true });
    expect((await api.call("PUT", `/recipes/${two}/slot`, { slot: null })).status).toBe(200);
    await expect.poll(() => record(d, BRAZIL)?.stripSlot, { timeout: 15_000 }).toBeNull();
    // Once D's report of its record out of its slot has been taken in, and DYE2 has checked it.
    await quiet();
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
    // Once A's reports of the recipe applied and the grind have been taken in.
    await quiet();
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    expect(await loadedRecipe(machines.a)).toBeNull();
    expect(saves(a)).toBe(saved);
    // Nor is the recipe's grind written over the barista's.
    expect(context(a).grinderSetting).toBe("2.2");
    // Sharing again, it is the Machine's Loaded Recipe.
    expect((await api.call("PUT", `/machines/${machines.a.machine.id}/sharing`, { sharing: true })).status).toBe(200);
    await loads(machines.a, one);
  });

  it("keeps a Recipe moved to another slot loaded, its record keeping its id, and saves a change into it alone", async () => {
    const { machines, dye2, a, c, d, one, two, quiet } = await lab("Moved", 48091, { d: true });
    const times = await loadedTimes(machines.d);
    expect((await api.call("PUT", `/recipes/${two}/slot`, { slot: 5 })).status).toBe(200);
    for (const tablet of [a, c, d]) await expect.poll(() => record(tablet, BRAZIL)?.stripSlot, { timeout: 15_000 }).toBe(5);
    // Once the tablets' reports of their records in the new slot have been taken in, and DYE2 has checked them.
    await quiet();
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
