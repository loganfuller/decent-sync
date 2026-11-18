import { GLOBAL_ID_KEY, dye2GlobalIdOf, profileAtBrewTemperature } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeIdInWorkflow, recipeNamedInWorkflow, syncingTablet, workflowCauses } from "./support/loaded-tablets.js";
import {
  DYE2_NAMESPACE,
  SimulatedDye2,
  dye2List,
  dye2NeverUsed,
  openDye2Dashboard,
  openDye2RecipeEditor,
  recordedDye2MainTablet,
  selectRecipeInDye2,
  tapGrinderInDye2,
} from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import { type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #146, #173, #177, #187, #188, #189, #216, #389 and
// #570: a Machine follows its Loaded Recipe both ways (ADR-0022), and every
// change on it is saved into the Recipe. The plugin has DYE2 save each change
// of the Workflow into the Recipe's record (`record`): its dose, yield, grind
// setting, RPM, Basket and brew temperature where the record holds one, a
// Basket picked since the apply where it holds none, and a steam, hot water
// or flush setting it holds, or holds none of once it moves
// (recipe-settings.test.ts has the settings), an edit of the Recipe from
// that Machine's tablet, once. Decent Sync records itself what DYE2 saves
// none of: a grinder, with the grind setting and RPM its pick left, a batch,
// with its Bean where it is another Bean's, and a dose, yield, grind setting
// or RPM the Recipe holds none of. A load takes nothing into the Recipe,
// which is the whole Shot (#550; recipe-whole-shot.test.ts). A change made
// while the plugin writes into the Workflow is saved too. A Skin's write of
// the record before the Workflow is the Recipe's edit, read as the Workflow
// moves the bean or the profile, but a pick the Library retired or a Profile
// it does not have. A batch the Library retired and a value cleared stay the
// Machine's own, and nothing unloads it but a change of profile, which saves
// nothing into it. An edit of the Recipe from anywhere is written
// into the Workflow of every Machine that has it loaded, but the one it was
// made on, its brew temperature as on a load, and a Profile in one write,
// through which DYE2 keeps it loaded as the Machine's record of it holds that
// Profile, in PostgreSQL's key order (decentespresso/dye2#38, #43); a stale
// copy applied is brought to it. Archiving the Recipe, or making the Machine capture-only,
// clears it from the Workflow; taking it out of its slot, or moving it to
// another, keeps it loaded, and so does applying it again after its Profile
// was edited (decentespresso/dye2#43). Through the built plugin in simulated
// tablets running DYE2 v0.1.40 and Streamline v0.2.27 as recorded
// (fixtures/decaid/dye2-v0.1.26/ and later), Machine A, and D in the tests
// that use it, on one server instance and C on another sharing one database,
// with assertions through the REST API and what each simulated tablet holds.
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
  /** How many times the plugin read DYE2's recipes from Decaid's store. */
  const recipeReads = (tablet: SimulatedTablet) => tablet.requests.filter((route) => route === `/store/${DYE2_NAMESPACE}/recipes`).length;
  /** Writes the tablet's record of a recipe into DYE2's list in Decaid's store, as a Skin does, the rest of the list as it is. */
  const writeRecord = async (tablet: SimulatedTablet, id: string, change: (entry: Record_) => Record_) => {
    const list = records(tablet).map((entry) => (entry.id === id ? change(structuredClone(entry)) : entry));
    expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);
  };
  /** The plugin's writes into the tablet's Workflow from now on, as it sent them. */
  const workflowWrites = (tablet: SimulatedTablet) => {
    const writes: Record_[] = [];
    tablet.refuseWrites = ({ method, route, body }) => {
      if (method === "PUT" && route === "/workflow") writes.push(body as Record_);
      return undefined;
    };
    return writes;
  };
  /** A write into a Workflow as a check shows it: as sent, its profile by its title and its steps' temperatures. */
  const shownWrite = ({ profile: written, ...rest }: Record_) =>
    written === undefined ? rest : { ...rest, profile: { title: (written as Record_).title, temperatures: ((written as Record_).steps as Record_[] | undefined)?.map((step) => step.temperature) } };

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, on
   * one instance, C on the other, and, with `d`, D on the first, both
   * tablets where DYE2 was never used, each running DYE2. A brings its
   * recipes, which every tablet there is written under their record ids,
   * and the Ethiopia's (in no slot) is applied from DYE2's Select Recipe page
   * on A and C, and the Brazil's (in slot 2) on D, which each loads, in that
   * order, each once the server holds it loaded: the writes into its
   * Workflow the load sets off, the plugin's and then the server's, may
   * still be under way as the lab returns. A's machine is connected.
   * `apiDelayMs` slows the answers A's Decaid gives the plugin, as the
   * simulated tablet's option of that name does. `quiet()` resolves once
   * every tablet and Machine of the lab, and the Streamlines given, have
   * nothing left under way (`quiesced`), waiting for a whole poll unless A
   * polls too seldom for it (`pollSeconds`), so a wrong write a step set off has
   * landed before a check after it that it did not happen, and the writes
   * the loads set off before a count of writes begins.
   */
  async function lab<WithD extends boolean = false>(
    scenario: string,
    serial: number,
    options: { pollSeconds?: number; apiDelayMs?: (method: string, path: string) => number; answerOnArrival?: boolean; timeScale?: number; d?: WithD } = {},
  ) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      c: await api.createMachine(`${scenario} lab C`, here.id),
      d: options.d ? await api.createMachine(`${scenario} lab D`, here.id) : undefined,
    };
    const dye2 = { a: new SimulatedDye2(), c: new SimulatedDye2(), d: options.d ? new SimulatedDye2() : undefined };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: dye2.a, pollSeconds: options.pollSeconds, apiDelayMs: options.apiDelayMs, answerOnArrival: options.answerOnArrival, timeScale: options.timeScale });
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
    // A polling too seldom to wait for, as at a `pollSeconds` of 3600, waits for no whole poll.
    const polls = (options.pollSeconds ?? 5) < 60;
    const quiet = (streamlines: Record<string, SimulatedStreamline> = {}) => quiesced(api, { tablets, machines: followed, streamlines, polls });
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
    // Once the writes the loads set off are done, who made each Workflow change from now on (#434).
    await quiet();
    const before = { a: (await workflowCauses(api, machines.a)).length, c: (await workflowCauses(api, machines.c)).length };
    await a.changeSettings({ context: { grinderSetting: "3.1" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(3.1);
    await expect.poll(() => context(c).grinderSetting, { timeout: 15_000 }).toBe("3.1");
    expect(dye2.a.recorded.at(-1)).toMatchObject({ id: ETHIOPIA, patch: { grind: 3.1 } });
    // Once A's report of the Workflow holding the grind has been taken in.
    await quiet();
    // A barista's change on A is another's, and the server's write of the Recipe's edit into C's Workflow the plugin's.
    expect([(await workflowCauses(api, machines.a)).slice(before.a), (await workflowCauses(api, machines.c)).slice(before.c)]).toEqual([["other"], ["plugin:loadedRecipe"]]);
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

  it("takes an RPM set to 0 on A, which DYE2 saves as 0, as none of the Recipe's, and clears it from C's (#550)", async () => {
    const { dye2, a, c, one, quiet } = await lab("Zero", 48151);
    expect((await recipe(one)).content.rpm).toBe(900);
    await a.changeSettings({ context: { extras: { rpm: 0 } } });
    // DYE2 saves the 0 into a record holding an RPM: a 0 from a tablet is none.
    await expect.poll(async () => (await recipe(one)).content.rpm ?? null, { timeout: 15_000 }).toBeNull();
    expect(dye2.a.recorded.map((recorded) => recorded.patch)).toContainEqual(expect.objectContaining({ rpm: 0 }));
    await expect.poll(() => extras(c).rpm ?? null, { timeout: 15_000 }).toBeNull();
    await quiet();
    expect((await recipe(one)).content).not.toHaveProperty("rpm");
    expect(variables(record(c, ETHIOPIA)).rpm ?? null).toBeNull();
    // A's own record and Workflow keep the 0, which reads as none: neither is written again.
    expect([variables(record(a, ETHIOPIA)).rpm, extras(a).rpm]).toEqual([0, 0]);
  });

  it("takes a feed rate saved in DYE2's editor on A as typed into the Recipe, and writes it into C's record, its embedded Workflow and C's Workflow, as DYE2 v0.1.34 applies one (dye2-v0.1.35/feed-rate.json)", async () => {
    const { a, c, one } = await lab("Feed rate editor", 48301);
    const saved = await (await openDye2RecipeEditor(a, { id: ETHIOPIA })).set({ feedRate: " 1200 " }).save();
    expect([saved.patch.dashboardVariables, saved.reapplied]).toEqual([{ feedRate: "1200" }, true]);
    await expect.poll(async () => (await recipe(one)).content.feedRate, { timeout: 15_000 }).toBe("1200");
    for (const tablet of [a, c]) {
      await expect.poll(() => [variables(record(tablet, ETHIOPIA)).feedRate, extras(tablet).feedRate], { timeout: 15_000 }).toEqual(["1200", "1200"]);
    }
    expect((((record(c, ETHIOPIA)!.workflow as Record_).context as Record_).extras as Record_).feedRate).toBe("1200");
  });

  it("takes a feed rate changed on A as the RPM is: recorded by Decent Sync into a Recipe holding none, which DYE2 adopts into none, saved by DYE2 into one holding one, and written into C's", async () => {
    const { dye2, a, c, one, quiet } = await lab("Feed rate changed", 48311);
    expect((await recipe(one)).content).not.toHaveProperty("feedRate");
    await a.changeSettings({ context: { extras: { feedRate: "MF" } } });
    await expect.poll(async () => (await recipe(one)).content.feedRate, { timeout: 15_000 }).toBe("MF");
    await expect.poll(() => extras(c).feedRate, { timeout: 15_000 }).toBe("MF");
    expect(dye2.a.recorded.filter((recorded) => "feedRate" in recorded.patch)).toEqual([]);
    // Once A's report and the writes it set off are done: the Recipe holds one now, so DYE2 saves the next change into it.
    await quiet();
    await a.changeSettings({ context: { extras: { feedRate: "SF" } } });
    await expect.poll(async () => (await recipe(one)).content.feedRate, { timeout: 15_000 }).toBe("SF");
    expect(dye2.a.recorded.map((recorded) => recorded.patch)).toContainEqual(expect.objectContaining({ feedRate: "SF" }));
    await expect.poll(() => [variables(record(c, ETHIOPIA)).feedRate, extras(c).feedRate], { timeout: 15_000 }).toEqual(["SF", "SF"]);
    // A feed rate cleared on A, as DYE2's dashboard's Clear writes one, is A's own.
    await quiet();
    await a.changeSettings({ context: { extras: { feedRate: null } } });
    await quiet();
    expect([(await recipe(one)).content.feedRate, extras(c).feedRate, extras(a).feedRate ?? null]).toEqual(["SF", "SF", null]);
  });

  it("writes a Recipe's feed rate into the Workflow as a load of it, named there by another app, which applies none, as DYE2 v0.1.34's apply writes one", async () => {
    const { machines, c, two, quiet } = await lab("Feed rate load", 48321);
    await patch(two, { feedRate: "FF" });
    await expect.poll(() => variables(record(c, BRAZIL)).feedRate, { timeout: 15_000 }).toBe("FF");
    await quiet();
    expect(extras(c).feedRate ?? null).toBeNull();
    // Named in C's Workflow by a write of the recipe id alone, so only the plugin's load writes the Recipe's values.
    expect((await c.callApi("PUT", "/workflow", { context: { extras: { dye: { recipeId: BRAZIL } } } })).status).toBe(200);
    await loads(machines.c, two);
    await expect.poll(() => extras(c).feedRate, { timeout: 15_000 }).toBe("FF");
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

  it("reads A's recipes, and takes in a Skin's record edit of the Recipe's Profile, when the Skin changes the Workflow's profile alone while the plugin's write of a Recipe edit into A's Workflow waits for Decaid (#570)", async () => {
    let slow = false;
    // 25 s at the tablet's pace, within Decaid's 30 s fetch timeout: half a second here. A polls too seldom to read the
    // recipes in this test.
    const { a, c, one, quiet } = await lab("Skin during write", 48401, { pollSeconds: 3600, apiDelayMs: (method, path) => (slow && method === "PUT" && path === "/workflow" ? 25_000 : 0) });
    // As in the Skin's write test below: DYE2's save answers as one that found nothing new, and an RPM change keeps the
    // Workflow off the recipe, so no push of DYE2's reads the recipes.
    a.refuseWrites = ({ method, route }) => (method === "POST" && route === `/plugins/${DYE2_NAMESPACE}/record` ? { status: 200, body: { saved: false } } : undefined);
    await a.changeSettings({ context: { extras: { rpm: 950 } } });
    await quiet();
    // The Skin's profile keeps the Workflow's brew temperature, so nothing but the profile moves around the plugin's write.
    const listed = (((await a.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((entry) => entry.id === CLASSIC)!).profile as Record_;
    const temperature = (profile(a).steps as Record_[])[0]!.temperature;
    const classic: Record_ = { ...listed, steps: (listed.steps as Record_[]).map((step, index) => (index === 0 ? { ...step, temperature } : step)) };
    const reads = a.requests.filter((route) => route === "/workflow").length;
    slow = true;
    await patch(one, { hotWaterVolume: 130 });
    // The plugin reads the Workflow, then its write of the hot water waits; the Skin writes the record, then the Workflow's
    // profile, meanwhile, and Decaid merges the write over it, answering with both.
    await expect.poll(() => a.requests.filter((route) => route === "/workflow").length, { timeout: 15_000 }).toBeGreaterThan(reads);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const recipeReadsBefore = recipeReads(a);
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, profileId: CLASSIC, profileTitle: classic.title, profileSnapshot: classic, workflow: { ...(entry.workflow as Record_), profile: classic } }));
    expect((await a.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    await expect.poll(() => hotWater(a).volume, { timeout: 15_000 }).toBe(130);
    slow = false;
    expect(profile(a).title).toBe(classic.title);
    await expect.poll(async () => (await recipe(one)).content.profileId, { timeout: 15_000 }).toBe(CLASSIC);
    expect(recipeReads(a)).toBeGreaterThan(recipeReadsBefore);
    await expect.poll(() => record(c, ETHIOPIA)?.profileId, { timeout: 15_000 }).toBe(CLASSIC);
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
  });

  it("takes in a Skin's record edit of the Recipe's batch and name made while the plugin's write of the Recipe's new batch into A's Workflow waits for its answer, as the Workflow's batch put back is the Recipe's edit, which the server writes into A's record, reading its recipes (#570)", async () => {
    // Decaid carries the plugin's write out as it arrives, and its answer is held below.
    const { here, a, c, one, quiet } = await lab("Skin bean during write", 48411, { pollSeconds: 3600, answerOnArrival: true });
    // As in the Skin's write test below: no push of DYE2's reads the recipes.
    a.refuseWrites = ({ method, route }) => (method === "POST" && route === `/plugins/${DYE2_NAMESPACE}/record` ? { status: 200, body: { saved: false } } : undefined);
    await a.changeSettings({ context: { extras: { rpm: 950 } } });
    const bean = (await recipe(one)).content.beanId as string;
    const first = (await recipe(one)).content.beanBatchId as string;
    const next = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] }, 201)).batch.id;
    const nextLocal = await expect.poll(() => localId(a, "/bean-batches", next), { timeout: 15_000 }).toEqual(expect.any(String)).then(() => localId(a, "/bean-batches", next));
    await quiet();
    const firstLocal = context(a).beanBatchId;
    // The server's write of the new batch into A's record, then into its Workflow, whose answer is held: within Decaid's
    // 30 s fetch timeout, 600 ms here, the Skin writes the record with the first batch and a name, then the Workflow's batch.
    const held = a.holdRequests("PUT", "/workflow");
    await patch(one, { beanBatchId: next });
    await expect.poll(() => [record(a, ETHIOPIA)?.beanBatchId, held.arrived], { timeout: 15_000 }).toEqual([nextLocal, 1]);
    expect(context(a).beanBatchId).toBe(nextLocal);
    const reads = recipeReads(a);
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, name: "Fixture First Bag", beanBatchId: firstLocal }));
    await a.changeSettings({ context: { beanBatchId: firstLocal } });
    // Judged from the Workflow before the write, the batch did not move, so the plugin does not read the recipes for it
    // (`readSoon`); the server's write of the batch back into A's record reads them, name and all.
    held.release();
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ name: "Fixture First Bag", beanBatchId: first });
    expect(recipeReads(a)).toBeGreaterThan(reads);
    await expect.poll(() => record(c, ETHIOPIA)?.name, { timeout: 15_000 }).toBe("Fixture First Bag");
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
    const writes = a.writes.length;
    await patch(one, { grindSetting: 0.6 });
    await expect.poll(() => variables(record(a, ETHIOPIA)).grind, { timeout: 15_000 }).toBe(0.6);
    await expect.poll(() => a.writes.slice(writes).includes("PUT /workflow"), { timeout: 15_000 }).toBe(true);
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

  it("keeps an RPM edit that DYE2 saves A's Workflow's 0 over before the edit's write into it lands, the 0 being none (#550)", async () => {
    const { dye2, a, c, one, quiet } = await lab("Zero left behind", 48721);
    // Set to 0 on A, which DYE2 saves into the record: none of the Recipe's, A's Workflow and record keeping the 0.
    await a.changeSettings({ context: { extras: { rpm: 0 } } });
    await expect.poll(async () => (await recipe(one)).content.rpm ?? null, { timeout: 15_000 }).toBeNull();
    await quiet();
    expect([extras(a).rpm, variables(record(a, ETHIOPIA)).rpm]).toEqual([0, 0]);
    // An edit of the RPM reaches A's record, over the 0 it holds, and Decaid refuses its write into A's Workflow, which keeps 0.
    a.refuseWrites = ({ method, route, body }) =>
      method === "PUT" && route === "/workflow" && "rpm" in (((((body as Record_ | null)?.context ?? {}) as Record_).extras ?? {}) as Record_) ? { status: 400, body: { error: "refused" } } : undefined;
    const writes = a.writes.length;
    await patch(one, { rpm: 950 });
    await expect.poll(() => variables(record(a, ETHIOPIA)).rpm, { timeout: 15_000 }).toBe(950);
    await expect.poll(() => a.writes.slice(writes).includes("PUT /workflow"), { timeout: 15_000 }).toBe(true);
    await quiet();
    a.refuseWrites = undefined;
    expect(extras(a).rpm).toBe(0);
    // Streamline's Save changes on A has DYE2 save the Workflow's 0 over the edit's 950: a stale save of the RPM the write is
    // still to bring, not a barista's 0, so the server writes the Recipe's back over it.
    expect((await a.callApi("POST", `/plugins/${DYE2_NAMESPACE}/record`)).status).toBe(200);
    expect(dye2.a.recorded.at(-1)).toEqual({ id: ETHIOPIA, patch: { rpm: 0 } });
    await expect.poll(() => variables(record(a, ETHIOPIA)).rpm, { timeout: 15_000 }).toBe(950);
    // A, connecting again, is asked for the refused write again, which Decaid now takes.
    a.loseNetwork();
    a.restoreNetwork();
    await expect.poll(() => extras(a).rpm, { timeout: 15_000 }).toBe(950);
    await quiet();
    expect((await recipe(one)).content.rpm).toBe(950);
    expect([extras(c).rpm, variables(record(a, ETHIOPIA)).rpm]).toEqual([950, 950]);
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

  it("takes an RPM a Recipe holds none of as its own as it changes on its Machine, which DYE2 saves none of, leaves a Basket picked there to DYE2's save, as A's edit, and writes them into D's", async () => {
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
    // DYE2's save of the change fails, so the server takes the Workflow holding both without it: it records the RPM, and
    // no Basket (#389).
    dye2.a.refuse("record");
    await a.changeSettings({ context: { extras: { rpm: 1234, basketId: BASKET_18, basketName: "Fixture 18g Precision" } } });
    await expect.poll(async () => (await recipe(two)).content.rpm, { timeout: 15_000 }).toBe(1234);
    // Once A's report of the Workflow holding the Basket has been taken in.
    await quiet();
    expect((await recipe(two)).content).not.toHaveProperty("basketId");
    expect(dye2.a.recorded.filter((recorded) => recorded.id === BRAZIL)).toEqual([]);
    // The next change has DYE2 save the Basket, which moved off the none A held as the recipe was applied (163a7c8), with
    // it: an edit of A's record, so of the Recipe, from A.
    await a.changeSettings({ context: { grinderSetting: "3.2" } });
    const basket18 = dye2GlobalIdOf((dye2List(a, "baskets") as Record_[]).find((entry) => entry.id === BASKET_18));
    await expect.poll(async () => (await recipe(two)).content, { timeout: 15_000 }).toMatchObject({ rpm: 1234, grindSetting: 3.2, basketId: basket18 });
    expect(dye2.a.recorded).toContainEqual({ id: BRAZIL, patch: { grind: 3.2, basketId: BASKET_18, basketName: "Fixture 18g Precision" } });
    expect(dye2.a.recorded.filter((recorded) => recorded.id === BRAZIL && "rpm" in recorded.patch)).toEqual([]);
    expect((await versions(two)).filter((version) => version.fields.basketId === basket18).map((version) => version.source.machine?.id)).toEqual([machines.a.machine.id]);
    await expect.poll(() => extras(d).rpm, { timeout: 15_000 }).toBe(1234);
    await expect.poll(() => extras(d).basketId ?? null, { timeout: 15_000 }).toBe((dye2List(d, "baskets") as Record_[]).find((entry) => dye2GlobalIdOf(entry) === basket18)?.id);
    expect(await loadedRecipe(machines.a)).toBe(two);
    expect(loadedRecipeWrites(a, received)).toEqual([]);
  });

  it("takes nothing into a Recipe from the Workflow it is loaded on, clearing the grinder, Basket, RPM and dose it holds none of there, and takes each as a barista then sets it, writing it into D's (#550)", async () => {
    const { machines, a, d, two, load, quiet } = await lab("Gains", 48121, { d: true });
    await patch(two, { rpm: null, basketId: null, grinderId: null, dose: null });
    await expect.poll(() => [variables(record(a, BRAZIL)).rpm ?? null, variables(record(a, BRAZIL)).basketId ?? null, variables(record(a, BRAZIL)).dose ?? null], { timeout: 15_000 }).toEqual([
      null,
      null,
      null,
    ]);
    // D, which has it loaded, is cleared of each, as any edit of the Recipe reaches it.
    await expect.poll(() => [extras(d).rpm ?? null, extras(d).basketId ?? null, context(d).grinderId ?? null, context(d).targetDoseWeight ?? null], { timeout: 15_000 }).toEqual([null, null, null, null]);
    const held = { grinder: context(a).grinderId as string, basket: extras(a).basketId as string, rpm: extras(a).rpm, dose: context(a).targetDoseWeight };
    expect(Object.values(held)).not.toContain(undefined);
    // Loaded on A, whose Workflow held each: a Recipe is the whole Shot, so A is left with none, and the Recipe takes none.
    await load(a, machines.a, BRAZIL, two);
    await quiet();
    expect([extras(a).rpm ?? null, extras(a).basketId ?? null, context(a).grinderId ?? null, context(a).targetDoseWeight ?? null]).toEqual([null, null, null, null]);
    for (const field of ["grinderId", "rpm", "dose", "basketId"]) expect((await recipe(two)).content, field).not.toHaveProperty(field);

    // Set on A since, each is the Recipe's, as before: the RPM and dose Decent Sync records, and the grinder.
    await a.changeSettings({ context: { grinderId: held.grinder, targetDoseWeight: held.dose, extras: { rpm: held.rpm } } });
    const grinder = await globalOf(a, "/grinders", held.grinder);
    await expect.poll(async () => (await recipe(two)).content, { timeout: 15_000 }).toMatchObject({ grinderId: grinder, rpm: held.rpm, dose: held.dose });
    await expect.poll(async () => [extras(d).rpm, context(d).targetDoseWeight, context(d).grinderId], { timeout: 15_000 }).toEqual([held.rpm, held.dose, await localId(d, "/grinders", grinder!)]);
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

  it("takes a grinder tapped on DYE2's Grinders page on A, which writes it into the Workflow with no confirm from v0.1.36, as the Recipe's, writing it into C's with the grind setting and RPM the tap left, none for a grinder declaring neither, the Recipe loaded (#461, #550)", async () => {
    const { machines, dye2, a, c, one } = await lab("Tapped grinder", 48331);
    const grind = (await recipe(one)).content.grindSetting;
    const grinder = (await globalOf(a, "/grinders", RECORDED_GRINDER_83))!;
    expect((await recipe(one)).content.grinderId).not.toBe(grinder);
    expect(grind).toBe(2.5);
    // The tap writes the grinder's id and name, flagged as DYE2's, as its grinder picker's Confirm does
    // (fixtures/decaid/streamline-v0.2.24/grinders-page.json, `tapOther`), and from v0.1.37 its default grind setting and
    // RPM, none for this grinder, which declares neither (fixtures/decaid/dye2-v0.1.40/).
    expect((await tapGrinderInDye2(a, RECORDED_GRINDER_83)).status).toBe(200);
    expect(context(a)).toMatchObject({ grinderId: RECORDED_GRINDER_83, grinderModel: "Fixture Grinder 83" });
    expect([context(a).grinderSetting ?? null, extras(a).rpm ?? null]).toEqual([null, null]);
    expect(((context(a).extras as Record_).dye as Record_)).toMatchObject({ grinderId: true, grinderModel: true, recipeId: ETHIOPIA });
    // The Recipe's Grinder, which DYE2 saves none of, and C's Workflow's.
    await expect.poll(async () => (await recipe(one)).content.grinderId, { timeout: 15_000 }).toBe(grinder);
    await expect.poll(() => localId(c, "/grinders", grinder), { timeout: 15_000 }).toEqual(expect.any(String));
    await expect.poll(async () => context(c).grinderId, { timeout: 15_000 }).toBe(await localId(c, "/grinders", grinder));
    expect(dye2.a.selected()).toMatchObject({ kind: "recipe", id: ETHIOPIA });
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    // The grind setting and RPM were the other Grinder's: the Recipe holds none now, and neither does either Machine.
    await expect.poll(async () => [(await recipe(one)).content.grindSetting ?? null, (await recipe(one)).content.rpm ?? null], { timeout: 15_000 }).toEqual([null, null]);
    await expect.poll(() => [context(c).grinderSetting ?? null, extras(c).rpm ?? null], { timeout: 15_000 }).toEqual([null, null]);
    expect([context(a).grinderSetting ?? null, extras(a).rpm ?? null]).toEqual([null, null]);
  });

  it("takes another batch of the Recipe's Bean picked on A as its batch, and a batch of another Bean as its Bean and batch, writing each into C's Workflow and both tablets' records, the Recipe loaded on both, and keeps a grind cleared as A's own (#570)", async () => {
    const { here, machines, dye2, a, c, one, quiet } = await lab("Next bag", 48141);
    const { name, beanId: bean } = (await recipe(one)).content as { name: string; beanId: string };
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

    // A batch of the Brazil on A: the Recipe's Bean and batch, which DYE2 saves none of, written into C's Workflow and both
    // tablets' records, its name kept, as the owner chose on 2026-11-18 (#570).
    const received = a.received.length;
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(brazilBatch);
    const brazil = (await recipe(one)).content.beanId as string;
    expect(brazil).not.toBe(bean);
    expect((await recipe(one)).content.name).toBe(name);
    for (const tablet of [a, c]) {
      const held = [await localId(tablet, "/beans", brazil), await localId(tablet, "/bean-batches", brazilBatch)];
      expect(held).not.toContain(undefined);
      await expect.poll(() => [record(tablet, ETHIOPIA)?.beanId, record(tablet, ETHIOPIA)?.beanBatchId], { timeout: 15_000 }).toEqual(held);
    }
    await expect.poll(async () => context(c).beanBatchId, { timeout: 15_000 }).toBe(await localId(c, "/bean-batches", brazilBatch));
    await quiet();

    // A grind cleared on A: not the Recipe's, nor written back, and it stays loaded.
    const versionsBefore = (await versions(one)).length;
    await a.changeSettings({ context: { grinderSetting: null } });
    // Once A's report of the grind cleared has been taken in.
    await quiet();
    expect((await recipe(one)).content.grindSetting).toEqual(expect.any(Number));
    expect((await versions(one)).length).toBe(versionsBefore);
    expect([context(a).beanBatchId, context(a).grinderSetting ?? null]).toEqual([RECORDED_BRAZIL_BATCH, null]);
    expect(loadedRecipeWrites(a, received)).toEqual([]);
    expect(dye2.a.cleared).toEqual([]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    // A Shot pulled on the Brazil's batch is linked to the Recipe.
    a.pullShot(shotOf(a, "next-bag-brazil-48141", 48141));
    await expect.poll(async () => (await api.call("GET", "/shots/next-bag-brazil-48141")).status, { timeout: 15_000 }).toBe(200);
    expect((await api.get<{ shot: { recipe: { id: string } | null } }>("/shots/next-bag-brazil-48141")).shot.recipe?.id).toBe(one);
  });

  it("keeps a batch of another Bean picked on A as the Recipe's over C's pick of its Bean's next bag made just before it and taken in just after, which is kept as a Conflict, A's Workflow keeping its pick (#570)", async () => {
    const { here, machines, a, c, one, quiet } = await lab("Crossed picks", 48351);
    const bean = (await recipe(one)).content.beanId as string;
    const next = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] }, 201)).batch.id;
    await expect.poll(() => localId(c, "/bean-batches", next), { timeout: 15_000 }).toEqual(expect.any(String));
    await quiet();
    // C picks the next bag, and Decaid is slow to answer the read of the Workflow the plugin's save into the Recipe makes:
    // C's change is held back meanwhile, and so is any write of the server's to C.
    const releaseC = c.holdWorkflowReads();
    const requested = c.requests.length;
    await c.changeSettings({ context: { beanBatchId: await localId(c, "/bean-batches", next) } });
    // Once the plugin has observed it, and its save waits for Decaid.
    await expect.poll(() => c.requests.slice(requested).includes("/workflow"), { timeout: 15_000 }).toBe(true);
    // Then A picks a batch of the Brazil, which the server takes at once. It once kept it as A's own, so C's change, taken
    // in after it, was written into A's Workflow, setting A back to the Recipe's Bean.
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    const received = a.received.length;
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(brazilBatch);
    // C's change, made first, reaches the server after A's, made without having seen it: it loses, kept as a Conflict.
    releaseC();
    const conflicts = async () => (await api.get<{ conflicts: { field: string; value: unknown }[] }>(`/recipes/${one}/conflicts`)).conflicts;
    await expect.poll(conflicts, { timeout: 15_000 }).toContainEqual(expect.objectContaining({ field: "beanBatchId", value: next }));
    await quiet();
    expect((await recipe(one)).content.beanBatchId).toBe(brazilBatch);
    // A keeps its pick, and C is brought to it.
    expect(context(a).beanBatchId).toBe(RECORDED_BRAZIL_BATCH);
    expect(loadedRecipeWrites(a, received).filter((fields) => "context.beanBatchId" in fields)).toEqual([]);
    await expect.poll(async () => context(c).beanBatchId, { timeout: 15_000 }).toBe(await localId(c, "/bean-batches", brazilBatch));
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("keeps C's pick of the Bean's next bag as the Recipe's over a batch of another Bean picked on A just before it and taken in just after, A's Bean and batch both kept as Conflicts, so the Recipe never names one Bean and another's batch (#570)", async () => {
    const { here, machines, a, c, one, quiet } = await lab("Crossed picks reversed", 48391);
    const bean = (await recipe(one)).content.beanId as string;
    const next = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: bean, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] }, 201)).batch.id;
    await expect.poll(() => localId(c, "/bean-batches", next), { timeout: 15_000 }).toEqual(expect.any(String));
    await quiet();
    // A picks a batch of the Brazil, and Decaid is slow to answer the read of the Workflow the plugin's save into the Recipe
    // makes: A's change is held back meanwhile.
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    const releaseA = a.holdWorkflowReads();
    const requested = a.requests.length;
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });
    await expect.poll(() => a.requests.slice(requested).includes("/workflow"), { timeout: 15_000 }).toBe(true);
    // Then C picks the next bag, which the server takes at once: a change of the batch alone, as the Recipe names its Bean.
    await c.changeSettings({ context: { beanBatchId: await localId(c, "/bean-batches", next) } });
    await expect.poll(async () => (await recipe(one)).content.beanBatchId, { timeout: 15_000 }).toBe(next);
    // A's pick, made first, reaches the server after C's, made without having seen it: its batch loses, and its Bean, though
    // no edit since set the Bean, loses with it.
    releaseA();
    const conflicts = async () => (await api.get<{ conflicts: { field: string; value: unknown }[] }>(`/recipes/${one}/conflicts`)).conflicts;
    await expect.poll(conflicts, { timeout: 15_000 }).toContainEqual(expect.objectContaining({ field: "beanBatchId", value: brazilBatch }));
    expect(await conflicts()).toContainEqual(expect.objectContaining({ field: "beanId", value: (await globalOf(a, "/beans", record(a, BRAZIL)!.beanId as string))! }));
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ beanId: bean, beanBatchId: next });
    // A is brought to C's pick.
    await expect.poll(async () => context(a).beanBatchId, { timeout: 15_000 }).toBe(await localId(a, "/bean-batches", next));
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("writes the Recipe's batch back into A's Workflow over a batch of another Bean picked on A that lost to C's pick of the Recipe's own batch again, made just after it and taken in first, though that left the Recipe as A's Workflow held it before (#570)", async () => {
    const { machines, a, c, one, quiet } = await lab("Lost pick", 48431);
    const { beanBatchId: first } = (await recipe(one)).content as { beanBatchId: string };
    const firstOnA = context(a).beanBatchId;
    const firstOnC = context(c).beanBatchId;
    // C's batch cleared: the Machine's own, the Recipe unchanged.
    await c.changeSettings({ context: { beanBatchId: null } });
    await quiet();
    expect((await recipe(one)).content.beanBatchId).toBe(first);
    // A picks a batch of the Brazil, its change held back as in the crossed picks above.
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    const releaseA = a.holdWorkflowReads();
    const requested = a.requests.length;
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH } });
    await expect.poll(() => a.requests.slice(requested).includes("/workflow"), { timeout: 15_000 }).toBe(true);
    // Then C picks the Recipe's batch again, which the server takes as an edit leaving it as it was.
    const versionsBefore = (await versions(one)).length;
    await c.changeSettings({ context: { beanBatchId: firstOnC } });
    await expect.poll(async () => (await versions(one)).length, { timeout: 15_000 }).toBeGreaterThan(versionsBefore);
    // A's pick, made first, loses, and A is written the Recipe's batch, as it would be had C's edit changed it.
    releaseA();
    const conflicts = async () => (await api.get<{ conflicts: { field: string; value: unknown }[] }>(`/recipes/${one}/conflicts`)).conflicts;
    await expect.poll(conflicts, { timeout: 15_000 }).toContainEqual(expect.objectContaining({ field: "beanBatchId", value: brazilBatch }));
    await expect.poll(() => context(a).beanBatchId, { timeout: 15_000 }).toBe(firstOnA);
    expect((await recipe(one)).content.beanBatchId).toBe(first);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("writes the Recipe's Profile back over a `profileId` none of the Library's that a Skin wrote into A's record, read as the plugin writes an edit of the Recipe into the record, and not only at the poll (#570)", async () => {
    const { a, one, quiet } = await lab("Unknown profile answered", 48441, { pollSeconds: 3600 });
    const { profileId, dose } = (await recipe(one)).content as { profileId: string; dose: number };
    await quiet();
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, profileId: "profile:000000000000000000fe" }));
    // An edit of the dose, which the server writes into A's record: the plugin reads the record as it writes it, so the
    // server hears of the Skin's profileId then, refuses it, and writes the record again, with no poll for an hour.
    await patch(one, { dose: dose + 1 });
    await expect.poll(() => record(a, ETHIOPIA)?.profileId, { timeout: 15_000 }).toBe(profileId);
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ profileId, dose: dose + 1 });
  });

  it("takes no `profileId` a Skin writes into A's record that is none of the Library's Profiles, writing the Recipe's back into the record, the Recipe unchanged and loaded (#570)", async () => {
    const { machines, a, c, one, quiet } = await lab("Unknown profile", 48421);
    const { profileId } = (await recipe(one)).content as { profileId: string };
    await quiet();
    const versionsBefore = (await versions(one)).length;
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, profileId: "profile:000000000000000000ff" }));
    // Read at A's next poll, refused, and written back.
    await expect.poll(() => record(a, ETHIOPIA)?.profileId, { timeout: 15_000 }).toBe(profileId);
    await quiet();
    expect((await recipe(one)).content.profileId).toBe(profileId);
    expect((await versions(one)).length).toBe(versionsBefore);
    expect(record(c, ETHIOPIA)?.profileId).toBe(profileId);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
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

  it("takes a Skin's write of A's record of the Recipe before its Workflow, of its Profile and then of its Bean with a name, as the Recipe's edits, read as the Workflow changes and not at the poll, writing them into C's record and Workflow, the Recipe loaded on both (#570)", async () => {
    const { machines, dye2, a, c, one, quiet } = await lab("Skin record", 48361, { pollSeconds: 3600 });
    // DYE2 pushes as the Workflow moves off the recipe it applied, or back onto it (its selection's `modified`), which has
    // the plugin read the recipes. So its save answers as one that found nothing new, and an RPM change it saves none of
    // keeps the Workflow off the recipe: no push of DYE2's reports the Skin's writes below, only the plugin's own reads.
    a.refuseWrites = ({ method, route }) => (method === "POST" && route === `/plugins/${DYE2_NAMESPACE}/record` ? { status: 200, body: { saved: false } } : undefined);
    await a.changeSettings({ context: { extras: { rpm: 950 } } });
    await quiet();
    // The Profile, as the Streamline Cafe Skin writes it (loganfuller/streamline-cafe-js#50): the record's, whole, its
    // embedded Workflow's too, which DYE2 keeps the Workflow's recipe named through a change of profile onto, then the
    // Workflow's.
    const classic = (((await a.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((entry) => entry.id === CLASSIC)!).profile as Record_;
    let reads = recipeReads(a);
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, profileId: CLASSIC, profileTitle: classic.title, profileSnapshot: classic, workflow: { ...(entry.workflow as Record_), profile: classic } }));
    const pushes = dye2.a.pushes.length;
    expect((await a.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content.profileId, { timeout: 15_000 }).toBe(CLASSIC);
    expect(recipeReads(a)).toBeGreaterThan(reads);
    await expect.poll(() => [record(c, ETHIOPIA)?.profileId, profile(c).title], { timeout: 15_000 }).toEqual([CLASSIC, "Classic Italian espresso"]);
    await quiet();
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
    expect(dye2.a.cleared).toEqual([]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);

    // The Brazil, with its batch, and the name the Skin gives a Recipe still under the name DYE2 generated, then the
    // Workflow's batch, whose coffee and roaster DYE2 copies beside it.
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    const brazilRecord = record(a, BRAZIL)!;
    reads = recipeReads(a);
    await writeRecord(a, ETHIOPIA, (entry) => ({
      ...entry,
      name: "Fixture Brazil Classic",
      beanId: brazilRecord.beanId,
      beanName: brazilRecord.beanName,
      beanRoaster: brazilRecord.beanRoaster,
      beanBatchId: RECORDED_BRAZIL_BATCH,
    }));
    await a.changeSettings({ context: { beanBatchId: RECORDED_BRAZIL_BATCH, coffeeName: brazilRecord.beanName, coffeeRoaster: brazilRecord.beanRoaster } });
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ name: "Fixture Brazil Classic", beanBatchId: brazilBatch });
    expect(recipeReads(a)).toBeGreaterThan(reads);
    const brazil = (await recipe(one)).content.beanId as string;
    expect(brazil).toBe(await globalOf(a, "/beans", String(brazilRecord.beanId)));
    await expect.poll(() => [record(c, ETHIOPIA)?.name, record(c, ETHIOPIA)?.beanId], { timeout: 15_000 }).toEqual(["Fixture Brazil Classic", await localId(c, "/beans", brazil)]);
    await expect.poll(async () => context(c).beanBatchId, { timeout: 15_000 }).toBe(await localId(c, "/bean-batches", brazilBatch));
    await quiet();
    // No push of DYE2's read the Skin's writes: the plugin's own reads did.
    expect(dye2.a.pushes.length).toBe(pushes);
    expect(context(a).beanBatchId).toBe(RECORDED_BRAZIL_BATCH);
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("reads A's recipes as a change moves the bean or the profile under its Loaded Recipe, and not for a dose, yield or grind change, nor with no Recipe loaded (#570)", async () => {
    const { machines, dye2, a, quiet } = await lab("Narrow read", 48371, { pollSeconds: 3600 });
    await quiet();
    // DYE2's save answers each change as one that found nothing new, and the server takes nothing from these changes, so
    // writes nothing: a read of the recipes is the change's own.
    a.refuseWrites = ({ method, route }) => (method === "POST" && route === `/plugins/${DYE2_NAMESPACE}/record` ? { status: 200, body: { saved: false } } : undefined);
    // DYE2 pushes as the Workflow first moves off the recipe it applied (its selection's `modified`), which has the plugin
    // read the recipes: an RPM change first, so that read is done.
    await a.changeSettings({ context: { extras: { rpm: 950 } } });
    await quiet();
    const reads = recipeReads(a);
    const saved = saves(a);
    for (const change of [{ targetDoseWeight: 19.5 }, { targetYield: 41 }, { grinderSetting: "3.1" }]) await a.changeSettings({ context: change });
    await quiet();
    expect(saves(a)).toBeGreaterThan(saved);
    expect(recipeReads(a)).toBe(reads);
    // The bean's coffee and roaster.
    await a.changeSettings({ context: { coffeeName: "Fixture Kenya", coffeeRoaster: "Fixture Roasters" } });
    await quiet();
    expect(recipeReads(a)).toBeGreaterThan(reads);
    // The profile, picked as DYE2's profile picker does, which unloads the Recipe a moment later.
    const afterBean = recipeReads(a);
    const classic = (((await a.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((entry) => entry.id === CLASSIC)!).profile as Record_;
    expect((await a.callApi("PUT", "/workflow", { profile: classic })).status).toBe(200);
    await dye2.a.settled();
    await loads(machines.a, null);
    await quiet();
    expect(recipeReads(a)).toBeGreaterThan(afterBean);
    // With no Recipe loaded, nothing is read for the bean moving.
    const unloaded = recipeReads(a);
    await a.changeSettings({ context: { coffeeName: "Fixture Kenya AA" } });
    await quiet();
    expect(recipeReads(a)).toBe(unloaded);
  });

  it("takes a Profile saved on A just before a Skin writes it into A's record and Workflow as the Recipe's, the plugin reading A's profiles before its recipes, and writes it into C's Workflow, the Recipe loaded on both (#570)", async () => {
    const { machines, a, c, one, quiet } = await lab("Profile just made", 48461, { pollSeconds: 3600 });
    // As in the Skin's write test above: no push of DYE2's reads the recipes.
    a.refuseWrites = ({ method, route }) => (method === "POST" && route === `/plugins/${DYE2_NAMESPACE}/record` ? { status: 200, body: { saved: false } } : undefined);
    await a.changeSettings({ context: { extras: { rpm: 950 } } });
    await quiet();
    // Saved on A, as in Streamline, which the plugin reports at its poll, an hour away: the Library has no such Profile yet.
    const made = await a.addProfile(derivedProfile("Lab Just Made", 7.5));
    const id = made.id as string;
    expect((await api.call("GET", `/profiles/${encodeURIComponent(id)}`)).status).toBe(404);
    const madeProfile = made.profile as Record_;
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, profileId: id, profileTitle: madeProfile.title, profileSnapshot: madeProfile, workflow: { ...(entry.workflow as Record_), profile: madeProfile } }));
    expect((await a.callApi("PUT", "/workflow", { profile: madeProfile })).status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content.profileId, { timeout: 15_000 }).toBe(id);
    await expect.poll(() => profile(c).title, { timeout: 15_000 }).toBe("Lab Just Made");
    await quiet();
    expect(record(a, ETHIOPIA)?.profileId).toBe(id);
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("takes a batch of another Bean that a Skin puts into A's Workflow with the profile its record holds already, in one write, as the Recipe's, with the Profile, writing both into C's Workflow, the Recipe loaded on both (#570)", async () => {
    const { machines, dye2, a, c, one, quiet } = await lab("Profile and bag", 48451, { pollSeconds: 3600 });
    // As in the Skin's write test above: no push of DYE2's reads the recipes.
    a.refuseWrites = ({ method, route }) => (method === "POST" && route === `/plugins/${DYE2_NAMESPACE}/record` ? { status: 200, body: { saved: false } } : undefined);
    await a.changeSettings({ context: { extras: { rpm: 950 } } });
    await quiet();
    const classic = (((await a.callApi("GET", "/profiles?includeHidden=true")).body as Record_[]).find((entry) => entry.id === CLASSIC)!).profile as Record_;
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    const brazilRecord = record(a, BRAZIL)!;
    // The record holds the new profile, and not the batch; the Workflow is written both at once. DYE2 keeps the recipe named,
    // as the record holds the profile, so the batch is a pick of the Workflow's, as any.
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, profileId: CLASSIC, profileTitle: classic.title, profileSnapshot: classic, workflow: { ...(entry.workflow as Record_), profile: classic } }));
    const written = await a.callApi("PUT", "/workflow", { profile: classic, context: { beanBatchId: RECORDED_BRAZIL_BATCH, coffeeName: brazilRecord.beanName, coffeeRoaster: brazilRecord.beanRoaster } });
    expect(written.status).toBe(200);
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ profileId: CLASSIC, beanBatchId: brazilBatch });
    await expect.poll(async () => [profile(c).title, context(c).beanBatchId], { timeout: 15_000 }).toEqual(["Classic Italian espresso", await localId(c, "/bean-batches", brazilBatch)]);
    await quiet();
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
    expect(dye2.a.cleared).toEqual([]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("takes no batch of an Archived Bean, Archived batch or batch finished at the Location picked on A, in its Workflow or written into its record, the Recipe keeping its Bean and batch, which are written back into the record, A's Workflow keeping its pick with the Recipe loaded, and nothing offered or added at the Location (#570)", async () => {
    const { here, machines, a, c, one, quiet } = await lab("Retired", 48381);
    const brazilBatch = (await globalOf(a, "/bean-batches", RECORDED_BRAZIL_BATCH))!;
    const brazil = (await api.get<{ batch: { bean: { id: string } } }>(`/bean-batches/${brazilBatch}`)).batch.bean.id;
    const retiredBean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Fixture Roasters", name: "Retired lab Bean" } }, 201)).bean.id;
    const batchOf = async (beanId: string) =>
      (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] }, 201)).batch.id;
    const ofArchivedBean = await batchOf(retiredBean);
    const archivedBatch = await batchOf(brazil);
    for (const batch of [ofArchivedBean, archivedBatch]) await expect.poll(() => localId(a, "/bean-batches", batch), { timeout: 15_000 }).toEqual(expect.any(String));
    // A keeps its records of them, marked archived: its map still holds them.
    await api.send("PUT", `/beans/${retiredBean}/archived`, { archived: true });
    await api.send("PUT", `/bean-batches/${archivedBatch}/archived`, { archived: true });
    await api.send("PUT", `/bean-batches/${brazilBatch}/locations/${here.id}`, { atLocation: false });
    await quiet();
    const picks = [
      { batch: ofArchivedBean, bean: retiredBean },
      { batch: archivedBatch, bean: brazil },
      { batch: brazilBatch, bean: brazil },
    ];
    const content = (await recipe(one)).content;
    const versionsBefore = (await versions(one)).length;
    /** Where each batch is, and each Bean is offered. */
    const placed = async () => ({
      batches: await Promise.all(
        picks.map(async ({ batch }) => {
          const { archived, locations } = (await api.get<{ batch: { archived: boolean; locations: unknown[] } }>(`/bean-batches/${batch}`)).batch;
          return { archived, locations };
        }),
      ),
      beans: await Promise.all([retiredBean, brazil].map(async (bean) => (await api.get<{ bean: { offeredAt: unknown[] } }>(`/beans/${bean}`)).bean.offeredAt)),
    });
    const before = await placed();
    const held = [record(a, ETHIOPIA)?.beanId, record(a, ETHIOPIA)?.beanBatchId];
    const heldOnC = [record(c, ETHIOPIA)?.beanId, record(c, ETHIOPIA)?.beanBatchId, context(c).beanBatchId];
    const received = a.received.length;
    for (const pick of picks) {
      const localBatch = (await localId(a, "/bean-batches", pick.batch))!;
      const localBean = (await localId(a, "/beans", pick.bean))!;
      expect([localBatch, localBean]).not.toContain(undefined);
      // In the Workflow: A's own, the Recipe loaded.
      await a.changeSettings({ context: { beanBatchId: localBatch } });
      await quiet();
      expect((await recipe(one)).content).toEqual(content);
      expect(context(a).beanBatchId).toBe(localBatch);
      // Written into A's record, as a Skin does: no edit, and the Recipe's own is written back over it.
      await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, beanId: localBean, beanBatchId: localBatch }));
      await expect.poll(() => [record(a, ETHIOPIA)?.beanId, record(a, ETHIOPIA)?.beanBatchId], { timeout: 15_000 }).toEqual(held);
      await quiet();
      expect((await recipe(one)).content).toEqual(content);
      expect(context(a).beanBatchId).toBe(localBatch);
    }
    expect((await versions(one)).length).toBe(versionsBefore);
    expect(loadedRecipeWrites(a, received).filter((fields) => "context.beanBatchId" in fields)).toEqual([]);
    expect([record(c, ETHIOPIA)?.beanId, record(c, ETHIOPIA)?.beanBatchId, context(c).beanBatchId]).toEqual(heldOnC);
    expect(await placed()).toEqual(before);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  /** A new Bean, in no batch anywhere, by its global id. */
  const newBean = async (roaster: string, name: string) => (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster, name } }, 201)).bean.id;
  /**
   * Sets the Recipe's Bean alone, or none, in the management interface, as only using a Conflict's value about it does
   * (a Recipe's edit sets a batch, with its Bean): a Conflict about its Bean, as a tablet's edit that lost leaves, copied
   * in PostgreSQL, whose value is used. A Bean with no batch at the Location leaves the Recipe naming no batch.
   */
  const useBean = async (recipeId: string, beanId: string | null) => {
    const database = await server.connectDatabase();
    let id: string;
    try {
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO conflicts (id, kind, item_id, field, value, edited_at)
         VALUES (gen_random_uuid(), 'recipe', $1, 'beanId', $2::jsonb, transaction_timestamp()) RETURNING id::text AS id`,
        [recipeId, JSON.stringify(beanId)],
      );
      id = rows[0]!.id;
    } finally {
      await database.end();
    }
    const { conflicts } = await api.get<{ conflicts: { id: string; current: { versionId: string | null } }[] }>("/conflicts");
    const seen = conflicts.find((conflict) => conflict.id === id)!.current.versionId;
    expect((await api.call("POST", `/conflicts/${id}/use`, { seen })).status).toBe(200);
  };
  /** The batch, coffee and roaster the tablet's Workflow holds, none as null. */
  const coffee = (tablet: SimulatedTablet) => [context(tablet).beanBatchId ?? null, context(tablet).coffeeName ?? null, context(tablet).coffeeRoaster ?? null];
  /** The Bean each tablet's Workflow naming the Recipe took, as the server keeps it (`BEAN_TAKEN`), sorted, none as null, "missing" where it keeps none. */
  const beanTaken = async (recipeId: string) => {
    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query<{ bean: string | null }>(
        `SELECT CASE WHEN base ? 'bean' THEN base ->> 'bean' ELSE 'missing' END AS bean FROM tablet_loaded_recipes WHERE recipe_id = $1::uuid ORDER BY 1`,
        [recipeId],
      );
      return rows.map((row) => row.bean);
    } finally {
      await database.end();
    }
  };

  it("writes the Bean set in the management interface on a Recipe naming no batch, by a Conflict's value, into A's and C's Workflows, its name and roaster, or none once it is removed, over a coffee typed on A, which stays A's own until then, a Shot pulled on C recording it (#572)", async () => {
    const { machines, a, c, one, quiet } = await lab("Bean alone", 48801);
    const roaster = "Bean Alone Roasters";
    const [kenya, peru, sumatra] = [await newBean(roaster, "Bean alone Kenya"), await newBean(roaster, "Bean alone Peru"), await newBean(roaster, "Bean alone Sumatra")];
    // A Bean with no batch at the Location, set alone: the Recipe names it and no batch, which clears the Workflows' batch.
    await useBean(one, kenya);
    expect((await recipe(one)).content).not.toHaveProperty("beanBatchId");
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Bean alone Kenya", roaster]);
    await quiet();

    // Another Bean with no batch: the Workflows hold no batch on either side, and still follow the Bean.
    await useBean(one, peru);
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Bean alone Peru", roaster]);
    await quiet();
    // Each write's answer took the Bean it carried, so no write of it is still due.
    expect(await beanTaken(one)).toEqual([peru, peru]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    c.pullShot(shotOf(c, "bean-alone-48801", 48802));
    await expect.poll(async () => (await api.call("GET", "/shots/bean-alone-48801")).status, { timeout: 15_000 }).toBe(200);
    const { shot } = await api.get<{ shot: { recipe: { id: string } | null; coffeeName: string | null; coffeeRoaster: string | null } }>("/shots/bean-alone-48801");
    expect([shot.recipe?.id, shot.coffeeName, shot.coffeeRoaster]).toEqual([one, "Bean alone Peru", roaster]);

    // A coffee typed on A: A's own, not the Recipe's, not C's, and never written back while the Recipe's Bean stays.
    const received = a.received.length;
    const versionsBefore = (await versions(one)).length;
    await a.changeSettings({ context: { coffeeName: "Typed on A" } });
    await quiet();
    expect((await recipe(one)).content.beanId).toBe(peru);
    expect((await versions(one)).length).toBe(versionsBefore);
    expect([coffee(a), coffee(c)]).toEqual([
      [null, "Typed on A", roaster],
      [null, "Bean alone Peru", roaster],
    ]);
    expect(loadedRecipeWrites(a, received)).toEqual([]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);

    // A later change of the Recipe's Bean is written over it.
    await useBean(one, sumatra);
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Bean alone Sumatra", roaster]);
    await quiet();
    expect(await beanTaken(one)).toEqual([sumatra, sumatra]);

    // The Bean removed: both Workflows' coffee and roaster are cleared.
    await useBean(one, null);
    expect((await recipe(one)).content).not.toHaveProperty("beanId");
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, null, null]);
    await quiet();
    expect(await beanTaken(one)).toEqual([null, null]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("writes the Bean a Skin sets in A's record of a Recipe naming no batch, as the Recipe's, into C's Workflow and A's, the Recipe loaded on both (#572)", async () => {
    const { machines, a, c, one, two, quiet } = await lab("Skin bean", 48811);
    const roaster = "Skin Bean Roasters";
    const [kenya, peru] = [await newBean(roaster, "Skin bean Kenya"), await newBean(roaster, "Skin bean Peru")];
    await useBean(one, kenya);
    // The Peru set on the other Recipe, so it is offered at the Location and every tablet there holds a record of it.
    await useBean(two, peru);
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Skin bean Kenya", roaster]);
    let local: unknown;
    await expect.poll(async () => (local = await localId(a, "/beans", peru)), { timeout: 15_000 }).toEqual(expect.any(String));
    await quiet();

    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, beanId: local, beanName: "Skin bean Peru", beanRoaster: roaster, beanBatchId: null }));
    await expect.poll(async () => (await recipe(one)).content.beanId, { timeout: 15_000 }).toBe(peru);
    expect((await recipe(one)).content).not.toHaveProperty("beanBatchId");
    for (const tablet of [c, a]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Skin bean Peru", roaster]);
    await quiet();
    expect(await beanTaken(one)).toEqual([peru, peru]);
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  /** Takes the Bean taken out of the base of each of the Recipe's two tablets, as the previous release saves one. */
  const stripBeanTaken = async (recipeId: string) => {
    const database = await server.connectDatabase();
    try {
      const { rowCount } = await database.query(`UPDATE tablet_loaded_recipes SET base = base - 'bean' WHERE recipe_id = $1::uuid AND base ? 'bean'`, [recipeId]);
      expect(rowCount).toBe(2);
    } finally {
      await database.end();
    }
  };

  it("writes nothing of the Bean into a Workflow whose base the previous release saved, keeping no Bean taken, until the Recipe's Bean changes, which is then written into it (#572)", async () => {
    const { machines, a, c, one, quiet } = await lab("Kept base", 48821);
    const roaster = "Kept Base Roasters";
    const [kenya, peru] = [await newBean(roaster, "Kept base Kenya"), await newBean(roaster, "Kept base Peru")];
    await useBean(one, kenya);
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Kept base Kenya", roaster]);
    await quiet();
    // As the previous release saves it: the base keeps no Bean taken. A coffee typed on C meanwhile is C's own.
    await stripBeanTaken(one);
    await c.changeSettings({ context: { coffeeName: "Typed on C" } });
    await quiet();
    // Another edit of the Recipe is written, but nothing of the Bean, which the Workflows took as it is now.
    const received = c.received.length;
    await patch(one, { grindSetting: 3.3 });
    for (const tablet of [a, c]) await expect.poll(() => context(tablet).grinderSetting, { timeout: 15_000 }).toBe("3.3");
    await quiet();
    expect(loadedRecipeWrites(c, received).flatMap((fields) => Object.keys(fields))).not.toContain("context.coffeeName");
    expect([coffee(a), coffee(c)]).toEqual([
      [null, "Kept base Kenya", roaster],
      [null, "Typed on C", roaster],
    ]);
    // A change of the Recipe's Bean is written into both.
    await useBean(one, peru);
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Kept base Peru", roaster]);
    await quiet();
    expect(await beanTaken(one)).toEqual([peru, peru]);

    // And one a Skin makes in A's record, A's report re-saving A's row as it read it before the edit.
    await stripBeanTaken(one);
    let kenyaOnA: unknown;
    await expect.poll(async () => (kenyaOnA = await localId(a, "/beans", kenya)), { timeout: 15_000 }).toEqual(expect.any(String));
    await writeRecord(a, ETHIOPIA, (entry) => ({ ...entry, beanId: kenyaOnA, beanName: "Kept base Kenya", beanRoaster: roaster, beanBatchId: null }));
    await expect.poll(async () => (await recipe(one)).content.beanId, { timeout: 15_000 }).toBe(kenya);
    for (const tablet of [c, a]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Kept base Kenya", roaster]);
    await quiet();
    expect(await beanTaken(one)).toEqual([kenya, kenya]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("writes the Recipe's Bean back into A's Workflow where it was set back while the answer to A's write of the Bean it was set to was outstanding, A taking that one (#572)", async () => {
    // Decaid carries A's writes out as they arrive. At a tenth of the default time scale its 30 s fetch timeout is 3 s, so
    // the answer held below is not lost before it is released.
    const { machines, a, c, one, quiet } = await lab("Bean set back", 48831, { pollSeconds: 3600, answerOnArrival: true, timeScale: 10 });
    const roaster = "Bean Set Back Roasters";
    const [kenya, peru] = [await newBean(roaster, "Set back Kenya"), await newBean(roaster, "Set back Peru")];
    await useBean(one, kenya);
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Set back Kenya", roaster]);
    await quiet();
    // A takes the write of Peru, and its answer is held while the Recipe's Bean is set back to Kenya: the answer carried an
    // edit of the Bean since replaced, so A took another than the Recipe's, which is written into it again.
    const held = a.holdRequests("PUT", "/workflow");
    await useBean(one, peru);
    await expect.poll(() => [coffee(a), held.arrived], { timeout: 15_000 }).toEqual([[null, "Set back Peru", roaster], 1]);
    await useBean(one, kenya);
    held.release();
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, "Set back Kenya", roaster]);
    await quiet();
    expect(await beanTaken(one)).toEqual([kenya, kenya]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("writes the removal of a Recipe's Bean into A's Workflow where A picked the batch that brought it, then cleared the batch and typed a coffee, its own until then (#572)", async () => {
    const { here, a, c, one, quiet } = await lab("Picked bean", 48851);
    const roaster = "Picked Bean Roasters";
    // A Recipe naming no Bean, nor a batch.
    await patch(one, { beanBatchId: null });
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, null, null]);
    await quiet();
    const peru = await newBean(roaster, "Picked Peru");
    const batch = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: peru, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] }, 201)).batch.id;
    let local: unknown;
    await expect.poll(async () => (local = await localId(a, "/bean-batches", batch)), { timeout: 15_000 }).toEqual(expect.any(String));
    await quiet();
    // Picked on A, with its Bean's coffee: the Recipe's batch and Bean, written into C, and the Bean A's Workflow took.
    await a.changeSettings({ context: { beanBatchId: local, coffeeName: "Picked Peru", coffeeRoaster: roaster } });
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ beanBatchId: batch, beanId: peru });
    await expect.poll(async () => coffee(c), { timeout: 15_000 }).toEqual([await localId(c, "/bean-batches", batch), "Picked Peru", roaster]);
    await quiet();
    expect(await beanTaken(one)).toEqual([peru, peru]);
    // A clears the batch and types a coffee, its own: the Recipe keeps both.
    await a.changeSettings({ context: { beanBatchId: null, coffeeName: "Typed on A" } });
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ beanBatchId: batch, beanId: peru });
    expect(coffee(a)).toEqual([null, "Typed on A", roaster]);
    // The batch, and with it the Bean, cleared in the management interface: written into both, A's typed coffee too.
    await patch(one, { beanBatchId: null });
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, null, null]);
    await quiet();
    expect(await beanTaken(one)).toEqual([null, null]);
  });

  it("writes the removal of a Recipe's Bean into A's Workflow where A held the batch the Recipe then took, as its own, then cleared it and typed a coffee (#572)", async () => {
    const { here, a, c, one, quiet } = await lab("Held bean", 48861);
    const roaster = "Held Bean Roasters";
    await patch(one, { beanBatchId: null });
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, null, null]);
    await quiet();
    const peru = await newBean(roaster, "Held Peru");
    const batch = (await api.send<{ batch: { id: string } }>("POST", "/bean-batches", { beanId: peru, content: { roastDate: "2026-10-12" }, locations: [{ locationId: here.id }] }, 201)).batch.id;
    let local: unknown;
    await expect.poll(async () => (local = await localId(a, "/bean-batches", batch)), { timeout: 15_000 }).toEqual(expect.any(String));
    // Archived, A keeps its record: picked on A, it stays A's own, and the Recipe names none.
    await api.send("PUT", `/bean-batches/${batch}/archived`, { archived: true });
    await quiet();
    await a.changeSettings({ context: { beanBatchId: local, coffeeName: "Held Peru", coffeeRoaster: roaster } });
    await quiet();
    expect((await recipe(one)).content).not.toHaveProperty("beanBatchId");
    // Offered again and set as the Recipe's: A holds it already, so it is written nothing.
    await api.send("PUT", `/bean-batches/${batch}/archived`, { archived: false });
    await patch(one, { beanBatchId: batch });
    await expect.poll(async () => coffee(c), { timeout: 15_000 }).toEqual([await localId(c, "/bean-batches", batch), "Held Peru", roaster]);
    await quiet();
    // A clears the batch and types a coffee, its own: the Recipe keeps both.
    await a.changeSettings({ context: { beanBatchId: null, coffeeName: "Typed on A" } });
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ beanBatchId: batch, beanId: peru });
    expect(await beanTaken(one)).toEqual([peru, peru]);
    // The batch, and with it the Bean, cleared in the management interface: written into both, A's typed coffee too.
    await patch(one, { beanBatchId: null });
    for (const tablet of [a, c]) await expect.poll(() => coffee(tablet), { timeout: 15_000 }).toEqual([null, null, null]);
    await quiet();
    expect(await beanTaken(one)).toEqual([null, null]);
  });

  it("plans no write of the coffee into A's Workflow where DYE2 saves a recipe from it holding a coffee typed on A, no Bean's, which the Recipe takes no Bean from, the Bean taken none (#572)", async () => {
    const { machines, a, one, quiet } = await lab("Saved coffee", 48871);
    await patch(one, { beanBatchId: null });
    await expect.poll(() => coffee(a), { timeout: 15_000 }).toEqual([null, null, null]);
    await quiet();
    await a.changeSettings({ context: { coffeeName: "Typed House", coffeeRoaster: "Typed Roaster" } });
    await quiet();
    const received = a.received.length;
    expect((await a.callApi("POST", `/plugins/${DYE2_NAMESPACE}/save-recipe`, { slot: 7 })).status).toBe(200);
    const savedId = recipeIdInWorkflow(a) as string;
    expect(savedId).not.toBe(ETHIOPIA);
    let saved: string | null = null;
    await expect.poll(() => (saved = dye2GlobalIdOf(record(a, savedId))), { timeout: 15_000 }).toEqual(expect.any(String));
    await loads(machines.a, saved!);
    await quiet();
    expect((await recipe(saved!)).content).not.toHaveProperty("beanId");
    // The typed coffee is no Bean's, so the Workflow took the Recipe's none: nothing of the coffee is due into it. (The
    // record written back to A names no coffee, as the Recipe holds none, as before #572.)
    expect(await beanTaken(saved!)).toEqual([null]);
    expect(loadedRecipeWrites(a, received)).toEqual([]);
  });

  it("writes the Recipe's Bean into C's Workflow where C applied an out-of-date copy of a Recipe naming no batch, holding the Bean it named before (#572)", async () => {
    const { machines, c, one, two, load, quiet } = await lab("Stale bean", 48841);
    const roaster = "Stale Bean Roasters";
    const [kenya, peru] = [await newBean(roaster, "Stale bean Kenya"), await newBean(roaster, "Stale bean Peru")];
    await useBean(one, kenya);
    await expect.poll(() => [record(c, ETHIOPIA)?.beanName, coffee(c)], { timeout: 15_000 }).toEqual(["Stale bean Kenya", [null, "Stale bean Kenya", roaster]]);
    await load(c, machines.c, BRAZIL, two);
    await quiet();
    // C's record is written nothing while it is offline: it applies the copy it holds, naming Kenya.
    c.loseNetwork();
    await useBean(one, peru);
    expect((await selectRecipeInDye2(c, ETHIOPIA)).applied?.workflow?.status).toBe(200);
    expect(coffee(c)).toEqual([null, "Stale bean Kenya", roaster]);
    c.restoreNetwork();
    await loads(machines.c, one);
    await expect.poll(() => coffee(c), { timeout: 15_000 }).toEqual([null, "Stale bean Peru", roaster]);
    await quiet();
    expect(await beanTaken(one)).toEqual([peru, peru]);
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

  it("writes a Profile edit into A's and C's Workflows as one write each, through which DYE2 keeps the Recipe named and loaded on both, the server recording no unload", async () => {
    const { machines, dye2, a, c, one, quiet } = await lab("Profile", 48061);
    // Once the writes C's load set off are done, which would be counted below otherwise: the server's may land after the lab
    // returns.
    await quiet();
    const times = await Promise.all([loadedTimes(machines.a), loadedTimes(machines.c)]);
    const writes = [workflowWrites(a), workflowWrites(c)];
    await patch(one, { profileId: CLASSIC });
    await expect.poll(() => [profile(a).title, profile(c).title], { timeout: 15_000 }).toEqual(["Classic Italian espresso", "Classic Italian espresso"]);
    // Once each write, and A's and C's reports of it, are done.
    await quiet();
    // One write each, of the Profile alone, its four steps at the Recipe's brew temperature, 92: it names no recipe, as the
    // Workflow names it already.
    const profileWrite = { profile: { title: "Classic Italian espresso", temperatures: [92, 92, 92, 92] } };
    expect({ a: writes[0]!.map(shownWrite), c: writes[1]!.map(shownWrite) }).toEqual({ a: [profileWrite], c: [profileWrite] });
    for (const tablet of [a, c]) {
      // The tablet's record holds the Profile in jsonb's key order, as the server writes a record: another order than the
      // Workflow's, which DYE2 v0.1.33's fingerprint ignores.
      const held = (record(tablet, ETHIOPIA)!.workflow as Record_).profile as Record_;
      expect(held.title).toBe("Classic Italian espresso");
      expect(Object.keys((held.steps as Record_[])[0]!)).not.toEqual(Object.keys((profile(tablet).steps as Record_[])[0]!));
    }
    expect([recipeIdInWorkflow(a), recipeIdInWorkflow(c)]).toEqual([ETHIOPIA, ETHIOPIA]);
    expect([dye2.a.cleared, dye2.c.cleared]).toEqual([[], []]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    expect(await Promise.all([loadedTimes(machines.a), loadedTimes(machines.c)])).toEqual(times);
    // DYE2 holds the new profile as the one the recipe was named on, so A's next change is saved into it.
    await a.changeSettings({ context: { grinderSetting: "2.8" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(2.8);
    await expect.poll(() => context(c).grinderSetting, { timeout: 15_000 }).toBe("2.8");
  });

  it("keeps the Recipe loaded as a barista applies it again on DYE2's dashboard after its Profile was edited, A's record holding the Profile in PostgreSQL's key order (decentespresso/dye2#43)", async () => {
    const { machines, dye2, a, one, quiet } = await lab("Reapplied", 48271);
    const times = await loadedTimes(machines.a);
    // Decaid refuses the edit's write of the profile into A's Workflow, so A's record holds the new Profile, and its Workflow
    // the old one, still naming the recipe.
    a.refuseWrites = ({ method, route, body }) => (method === "PUT" && route === "/workflow" && "profile" in ((body as Record_ | null) ?? {}) ? { status: 400, body: { error: "refused" } } : undefined);
    await patch(one, { profileId: CLASSIC });
    const held = () => ((record(a, ETHIOPIA)?.workflow as Record_ | undefined)?.profile ?? null) as Record_ | null;
    await expect.poll(() => held()?.title, { timeout: 15_000 }).toBe("Classic Italian espresso");
    await quiet();
    a.refuseWrites = undefined;
    expect([profile(a).title, recipeIdInWorkflow(a)]).toEqual(["Adaptive v3", ETHIOPIA]);
    // In jsonb's key order, as the server writes a record: another order than the Workflow's.
    expect(Object.keys((held()!.steps as Record_[])[0]!)).not.toEqual(Object.keys(((profile(a).steps as Record_[]) ?? [])[0] ?? {}));
    const cleared = dye2.a.cleared.length;
    expect((await (await openDye2Dashboard(a)).applyRecipe(ETHIOPIA)).workflow?.status).toBe(200);
    await dye2.a.settled();
    expect([profile(a).title, recipeIdInWorkflow(a)]).toEqual(["Classic Italian espresso", ETHIOPIA]);
    expect(dye2.a.cleared.length).toBe(cleared);
    await quiet();
    await loads(machines.a, one);
    expect(await loadedTimes(machines.a)).toBe(times);
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
