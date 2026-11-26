import { GLOBAL_ID_KEY, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { quiesced } from "./support/quiet.js";
import {
  DYE2_NAMESPACE,
  SimulatedDye2,
  dye2List,
  dye2NeverUsed,
  editGrinderInDye2,
  openDye2Dashboard,
  openDye2RecipeEditor,
  recordedDye2MainTablet,
  selectRecipeInDye2,
  tapGrinderInDye2,
} from "./support/simulated-dye2.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #550: a Recipe is the whole Shot (ADR-0022). A Machine
// that loads one is left with none of what the Recipe names none of, its
// dose, grind setting, RPM, feed rate, Grinder, Basket and Bean Batch, and
// stop-at-weight off where it names no yield, whatever applied it: DYE2
// v0.1.40's dashboard and Streamline v0.2.27's strip clear them as they
// apply it, and the plugin's load write clears them for a Skin that clears
// nothing. The Recipe takes nothing from the Workflow as it loads. A part
// cleared from a Recipe is cleared in the Workflow of every Machine that has
// it loaded, but a steam, hot water or flush setting, which each Machine
// keeps its own of. A dose, grind setting or RPM of 0 is none, so a Recipe
// whose record holds an RPM of 0, as DYE2's editor saves one left blank, is
// applied with no Workflow write after it; a yield of 0 is stop-at-weight
// off, which a Recipe holding no yield never takes. And a Grinder picked on
// a Machine brings the grind setting and RPM its pick left into the Recipe,
// none included. Through the built plugin in simulated tablets running DYE2
// v0.1.40 and Streamline v0.2.27, Machine A on one server instance and C on
// another sharing one database, with assertions through the REST API and
// what each simulated tablet holds. Serials are made up, from 56001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  slot: number | null;
  content: Record_;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record ids: the Ethiopia's recipe, in no Recipe Slot, and the Brazil's, in slot 2. */
const ETHIOPIA = "1";
const BRAZIL = "2";

/** The recording's tablet's id for the grinder its recipes name none of. */
const RECORDED_GRINDER_83 = "f3d11140-520f-4d6c-a4c9-d79c217dffc8";

describe("A Recipe is the whole Shot", { timeout: 120_000 }, () => {
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
  /** The tablet's record of that Recipe, by the global id it carries. */
  const recordOf = (tablet: SimulatedTablet, recipeId: string) => records(tablet).find((entry) => dye2GlobalIdOf(entry) === recipeId);
  const variables = (entry: Record_ | undefined) => (entry?.dashboardVariables ?? {}) as Record_;
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const extras = (tablet: SimulatedTablet) => (context(tablet).extras ?? {}) as Record_;
  /** What the tablet's Workflow holds of the parts a Recipe is the whole Shot in, null for none, as Decaid drops a field cleared. */
  const held = (tablet: SimulatedTablet) => ({
    grinder: context(tablet).grinderId ?? null,
    grinderModel: context(tablet).grinderModel ?? null,
    grind: context(tablet).grinderSetting ?? null,
    basket: extras(tablet).basketId ?? null,
    basketName: extras(tablet).basketName ?? null,
    dose: context(tablet).targetDoseWeight ?? null,
    yield: context(tablet).targetYield ?? null,
    rpm: extras(tablet).rpm ?? null,
    feedRate: extras(tablet).feedRate ?? null,
    batch: context(tablet).beanBatchId ?? null,
    coffee: context(tablet).coffeeName ?? null,
  });
  /** A Workflow holding none of them, its yield 0: stop-at-weight off. */
  const NONE = { grinder: null, grinderModel: null, grind: null, basket: null, basketName: null, dose: null, yield: 0, rpm: null, feedRate: null, batch: null, coffee: null };
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  /** The fields of a Recipe's content it is the whole Shot in, of those it holds. */
  const WHOLE = ["grinderId", "grindSetting", "basketId", "dose", "yield", "ratio", "rpm", "feedRate", "beanId", "beanBatchId"];
  const wholeHeld = async (id: string) => Object.keys((await recipe(id)).content).filter((field) => WHOLE.includes(field));
  const versions = async (id: string) => (await api.get<{ versions: { fields: Record_ }[] }>(`/recipes/${id}/history`)).versions;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** The tablet's id for its record of a Library item, by the global id the record carries in its `extras`. */
  const localId = async (tablet: SimulatedTablet, route: string, globalId: string) => {
    const listed = (await tablet.callApi("GET", `${route}?includeArchived=true`)).body as Record_[];
    return listed.find((entry) => (entry.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] === globalId)?.id;
  };
  /**
   * The tablet's id for its record of a Library item, once it holds one. An expected value is read once, before
   * `expect.poll` first polls, so one read with `localId` before the record arrives would be fixed at none (#718).
   */
  const heldId = async (tablet: SimulatedTablet, route: string, globalId: string) => {
    let id: unknown;
    await expect.poll(async () => (id = await localId(tablet, route, globalId)), { timeout: 15_000 }).toEqual(expect.any(String));
    return id as string;
  };
  /** The global id the tablet's record of a Library item carries, by the tablet's id for it. */
  const globalOf = async (tablet: SimulatedTablet, route: string, local: string) => {
    const listed = (await tablet.callApi("GET", `${route}?includeArchived=true`)).body as Record_[];
    return (listed.find((entry) => entry.id === local)?.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] as string | undefined;
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

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, on
   * one instance, and C, where DYE2 was never used, on the other, each
   * running DYE2, their machines connected. A brings its recipes, which C is
   * written under their record ids, and the Ethiopia's, which names a
   * Grinder, grind setting, RPM, Basket, dose, yield and Bean Batch, is
   * applied from DYE2's Select Recipe page on both, which each loads.
   * `quiet()` resolves once both tablets, their DYE2s, both Machines and the
   * Streamlines given have nothing left under way (`quiesced`).
   */
  async function lab(scenario: string, serial: number) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = { a: await api.createMachine(`${scenario} lab A`, here.id), c: await api.createMachine(`${scenario} lab C`, here.id) };
    const dye2 = { a: new SimulatedDye2(), c: new SimulatedDye2() };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: dye2.a });
    await api.waitForOnline(machines.a);
    await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => dye2GlobalIdOf(record(a, id))), { timeout: 15_000 }).not.toContain(null);
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 1)), dye2: dye2.c });
    await api.waitForOnline(machines.c);
    const one = dye2GlobalIdOf(record(a, ETHIOPIA))!;
    const two = dye2GlobalIdOf(record(a, BRAZIL))!;
    await expect
      .poll(() => [ETHIOPIA, BRAZIL].map((id) => [dye2GlobalIdOf(record(c, id)), record(c, id)?.beanBatchId ?? null, variables(record(c, id)).basketId ?? null]).flat(), { timeout: 15_000 })
      .not.toContain(null);
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, id: string, recipeId: string) => {
      expect((await selectRecipeInDye2(tablet, id)).applied?.workflow?.status).toBe(200);
      await expect.poll(() => recipeNamedInWorkflow(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
    };
    a.connectMachine();
    c.connectMachine();
    await load(a, machines.a, ETHIOPIA, one);
    await load(c, machines.c, ETHIOPIA, one);
    const quiet = (streamlines: Record<string, SimulatedStreamline> = {}) => quiesced(api, { tablets: { a, c }, machines, streamlines });
    /** A Recipe naming a Profile alone, in that slot, made in the management interface, once both tablets hold its record: its record id there. */
    const bare = async (slot: number, content: Record_ = {}) => {
      const profileId = (await recipe(one)).content.profileId;
      const created = (await api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId: here.id, slot, content: { name: `${scenario} Bare`, profileId, ...content } }, 201)).recipe;
      await expect.poll(() => [recordOf(a, created.id)?.id ?? null, recordOf(c, created.id)?.id ?? null], { timeout: 15_000 }).not.toContain(null);
      return { id: created.id, recordId: String(recordOf(a, created.id)!.id) };
    };
    return { here, machines, dye2, a, c, one, two, load, quiet, bare };
  }

  it("leaves a Machine with none of what a Recipe names none of, applied from DYE2's dashboard or Streamline's strip, and takes nothing into the Recipe", async () => {
    const { machines, a, c, one, load, quiet, bare } = await lab("Applied", 56001);
    const none = await bare(3);
    await quiet();
    // Each Workflow holds the Ethiopia's: a Grinder, grind setting, RPM, Basket, dose, yield and Bean Batch.
    for (const tablet of [a, c]) expect(Object.entries(held(tablet)).filter(([part, value]) => part !== "feedRate" && value === null), JSON.stringify(held(tablet))).toEqual([]);
    const before = (await versions(none.id)).length;

    // From DYE2's dashboard on A.
    expect((await (await openDye2Dashboard(a)).applyRecipe(none.recordId)).workflow?.status).toBe(200);
    await loads(machines.a, none.id);
    // From Streamline's strip on C.
    const streamline = await startStreamline(c);
    expect((await streamline.applyRecipe(3)).workflow?.status).toBe(200);
    await loads(machines.c, none.id);
    await quiet({ streamline });
    for (const tablet of [a, c]) expect(held(tablet)).toEqual(NONE);
    // The Recipe took nothing from either Workflow as it loaded.
    expect(await wholeHeld(none.id)).toEqual([]);
    expect((await versions(none.id)).length).toBe(before);

    // The Ethiopia applied again brings each back, as the Recipe names it.
    await load(a, machines.a, ETHIOPIA, one);
    await quiet({ streamline });
    expect(held(a)).toMatchObject({ grind: "2.5", dose: 18, yield: 36, rpm: 900 });
    expect(Object.entries(held(a)).filter(([part, value]) => part !== "feedRate" && value === null)).toEqual([]);
    streamline.stop();
  });

  it("ends the same where a Skin that clears nothing applies the Recipe, by the plugin's load write, the tablet offline or not", async () => {
    const { machines, a, c, quiet, bare } = await lab("Uncleared", 56011);
    const none = await bare(3);
    await quiet();
    const before = (await versions(none.id)).length;
    // A Skin built for a Decent Sync deployment names the recipe in the Workflow, as DYE2's selection route does, and clears
    // nothing: the Workflow still holds the Ethiopia's as the plugin decides on the load.
    const writes = workflowWrites(a);
    expect((await a.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: none.recordId })).status).toBe(200);
    await loads(machines.a, none.id);
    await quiet();
    expect(held(a)).toEqual(NONE);
    // One write of the plugin's cleared them, its yield to 0, as Decaid refuses a null there.
    expect(writes.map((write) => (write.context as Record_ | undefined)?.targetYield)).toContain(0);
    expect(await wholeHeld(none.id)).toEqual([]);
    expect((await versions(none.id)).length).toBe(before);

    // Offline, the plugin clears them without the server, and the Recipe takes nothing once it reconnects.
    c.loseNetwork();
    await api.waitForMachine(machines.c.machine.name, (viewed) => !viewed.online, 15_000);
    expect((await c.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: none.recordId })).status).toBe(200);
    await expect.poll(() => held(c), { timeout: 15_000 }).toEqual(NONE);
    c.restoreNetwork();
    await loads(machines.c, none.id);
    await quiet();
    expect(held(c)).toEqual(NONE);
    expect(await wholeHeld(none.id)).toEqual([]);
    expect((await versions(none.id)).length).toBe(before);
  });

  it("clears a Basket cleared from a Recipe in the management interface in the Workflow of each Machine that has it loaded, and not a steam time cleared from it", async () => {
    const { a, c, one, quiet } = await lab("Cleared", 56021);
    await patch(one, { steamDuration: 40 });
    await expect.poll(() => [a, c].map((tablet) => (tablet.workflow().steamSettings as Record_).duration), { timeout: 15_000 }).toEqual([40, 40]);
    await quiet();
    expect([held(a).basket, held(c).basket]).not.toContain(null);
    const received = { a: a.received.length, c: c.received.length };

    await patch(one, { basketId: null, steamDuration: null, rpm: null });
    await expect.poll(() => [held(a).basket, held(c).basket, held(a).rpm, held(c).rpm], { timeout: 15_000 }).toEqual([null, null, null, null]);
    await quiet();
    for (const tablet of [a, c]) {
      expect(held(tablet)).toMatchObject({ basket: null, basketName: null, rpm: null, grind: "2.5", dose: 18 });
      // Each record holds none, and the steam time stays each Machine's own.
      expect([variables(record(tablet, ETHIOPIA)).basketId ?? null, variables(record(tablet, ETHIOPIA)).steamTimeS ?? null]).toEqual([null, null]);
      expect((tablet.workflow().steamSettings as Record_).duration).toBe(40);
    }
    // Each was sent the clear as a write of its Loaded Recipe, the Basket's id and name null together, expecting the Basket it held.
    for (const [tablet, from] of [[a, received.a], [c, received.c]] as const) {
      const sent = tablet.received.slice(from).filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "loadedRecipe") as { fields: Record_; expected: Record_ }[];
      expect(sent.map(({ fields }) => fields)).toContainEqual(expect.objectContaining({ "context.extras.basketId": null, "context.extras.basketName": null, "context.extras.rpm": null }));
      expect(sent.flatMap(({ fields }) => Object.keys(fields))).not.toContain("steamSettings.duration");
    }
    expect((await recipe(one)).content).not.toHaveProperty("basketId");
  });

  it("applies a Recipe whose record holds an RPM of 0, as DYE2's editor saves one left blank, with no Workflow write after it, the Recipe holding none", async () => {
    const { machines, a, two, load, quiet } = await lab("Zero", 56031);
    // Saved in DYE2's editor with its RPM at 0: none of the Recipe's, and the record keeps its 0.
    const { saved } = await (await openDye2RecipeEditor(a, { id: BRAZIL })).set({ rpm: 0 }).save();
    expect((saved.dashboardVariables as Record_).rpm).toBe(0);
    await expect.poll(async () => (await recipe(two)).content.rpm ?? null, { timeout: 15_000 }).toBeNull();
    await quiet();
    expect((await recipe(two)).content).not.toHaveProperty("rpm");
    expect(variables(record(a, BRAZIL)).rpm).toBe(0);
    expect(held(a).rpm).toBe(900);

    // Applied from DYE2's dashboard, which clears the Workflow's RPM for the 0: the plugin and the server write nothing more.
    const writes = workflowWrites(a);
    const received = a.received.length;
    await load(a, machines.a, BRAZIL, two);
    await quiet();
    expect(held(a).rpm).toBeNull();
    expect(writes).toEqual([]);
    expect(a.received.slice(received).filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "loadedRecipe")).toEqual([]);

    // A record whose embedded Workflow holds the 0 too, as one saved before DYE2 v0.1.37, is left as it is, and
    // Streamline's strip clears the RPM as it applies it.
    const list = structuredClone(records(a));
    const brazil = list.find((entry) => entry.id === BRAZIL)!;
    (((brazil.workflow as Record_).context as Record_).extras as Record_).rpm = 0;
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, list)).status).toBe(200);
    await a.changeSettings({ context: { extras: { rpm: 1000, dye: { recipeId: null } } } });
    await loads(machines.a, null);
    await quiet();
    const posts = a.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "recipes").length;
    const streamline = await startStreamline(a);
    expect((await streamline.applyRecipe(2)).workflow?.status).toBe(200);
    await loads(machines.a, two);
    await quiet({ streamline });
    expect(held(a).rpm).toBeNull();
    expect((((record(a, BRAZIL)!.workflow as Record_).context as Record_).extras as Record_).rpm).toBe(0);
    expect(a.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "recipes").length).toBe(posts);
    expect((await recipe(two)).content).not.toHaveProperty("rpm");
    streamline.stop();
  });

  it("takes no yield into a Recipe holding none from a Workflow whose yield is 0, and takes 40 once a barista sets it, which reaches the other Machine", async () => {
    const { machines, dye2, a, c, quiet, bare } = await lab("Yield", 56041);
    const none = await bare(3, { dose: 18 });
    for (const [tablet, machine] of [[a, machines.a], [c, machines.c]] as const) {
      expect((await (await openDye2Dashboard(tablet)).applyRecipe(none.recordId)).workflow?.status).toBe(200);
      await loads(machine, none.id);
    }
    await quiet();
    expect([held(a).yield, held(c).yield]).toEqual([0, 0]);
    expect((await recipe(none.id)).content).not.toHaveProperty("yield");
    // A change of anything else leaves it so: stop-at-weight off is no yield to take.
    await a.changeSettings({ context: { targetDoseWeight: 18.5 } });
    await expect.poll(async () => (await recipe(none.id)).content.dose, { timeout: 15_000 }).toBe(18.5);
    await quiet();
    expect((await recipe(none.id)).content).not.toHaveProperty("yield");

    // Set on A, as a barista turns stop-at-weight on: DYE2 saves none into a record holding none, so Decent Sync records it.
    await a.changeSettings({ context: { targetYield: 40 } });
    await expect.poll(async () => (await recipe(none.id)).content.yield, { timeout: 15_000 }).toBe(40);
    await expect.poll(() => held(c).yield, { timeout: 15_000 }).toBe(40);
    expect(dye2.a.recorded.filter((recorded) => "drink" in recorded.patch)).toEqual([]);
    await quiet();
    expect([held(a).yield, held(c).yield]).toEqual([40, 40]);
  });

  it("brings the grind setting and RPM a Grinder's pick left into the Recipe with it, none included, and to the other Machine", async () => {
    const { machines, a, c, one, quiet } = await lab("Picked", 56051);
    await quiet();
    const grinder64 = String(held(a).grinder);
    const [global64, global83] = [(await globalOf(a, "/grinders", grinder64))!, (await globalOf(a, "/grinders", RECORDED_GRINDER_83))!];
    expect((await recipe(one)).content).toMatchObject({ grinderId: global64, grindSetting: 2.5, rpm: 900 });
    // The other grinder declares a default grind setting and RPM on A's tablet, as DYE2 keeps them in its `extras`.
    const other = ((await a.callApi("GET", `/grinders/${RECORDED_GRINDER_83}`)).body as Record_).extras as Record_;
    expect((await a.callApi("PUT", `/grinders/${RECORDED_GRINDER_83}`, { extras: { ...other, settingDefault: 5, rpmDefault: 1100 } })).status).toBe(200);
    await quiet();

    // Picked on the dashboard's tabs on A: its defaults come with it, which DYE2 saves into the record, and the Recipe's
    // Grinder, which Decent Sync records.
    expect((await (await openDye2Dashboard(a)).pickGrinder(RECORDED_GRINDER_83))?.status).toBe(200);
    expect(held(a)).toMatchObject({ grinder: RECORDED_GRINDER_83, grind: "5", rpm: 1100 });
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ grinderId: global83, grindSetting: 5, rpm: 1100 });
    await expect.poll(async () => held(c), { timeout: 15_000 }).toMatchObject({ grinder: await heldId(c, "/grinders", global83), grind: "5", rpm: 1100 });
    await quiet();
    for (const machine of [machines.a, machines.c]) await loads(machine, one);

    // The first grinder, which declares neither, tapped on DYE2's Grinders page: "dial me in". The Recipe and both
    // Machines end on it with no grind setting and no RPM.
    expect((await tapGrinderInDye2(a, grinder64)).status).toBe(200);
    expect(held(a)).toMatchObject({ grinder: grinder64, grind: null, rpm: null });
    await expect.poll(async () => (await recipe(one)).content.grinderId, { timeout: 15_000 }).toBe(global64);
    await expect.poll(async () => held(c), { timeout: 15_000 }).toMatchObject({ grinder: await heldId(c, "/grinders", global64), grind: null, rpm: null });
    await quiet();
    const content = (await recipe(one)).content;
    expect(content).not.toHaveProperty("grindSetting");
    expect(content).not.toHaveProperty("rpm");
    expect(held(a)).toMatchObject({ grinder: grinder64, grind: null, rpm: null });
    for (const tablet of [a, c]) expect([variables(record(tablet, ETHIOPIA)).grind ?? null, variables(record(tablet, ETHIOPIA)).rpm ?? null]).toEqual([null, null]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  // Ticket #551: a Grinder's range and defaults are the Grinder's, shared across its Location's tablets.
  it("brings a default given to a Grinder on one tablet into the Workflow and the Recipe as the Grinder is picked on another Machine", async () => {
    const { machines, a, c, one, quiet } = await lab("Shared default", 56061);
    await quiet();
    const [global64, global83] = [(await globalOf(a, "/grinders", String(held(a).grinder)))!, (await globalOf(a, "/grinders", RECORDED_GRINDER_83))!];
    expect((await recipe(one)).content).toMatchObject({ grinderId: global64, grindSetting: 2.5, rpm: 900 });
    // Given on A, on DYE2's Grinders page: a default setting, and a range for its RPM with no default.
    expect((await editGrinderInDye2(a, RECORDED_GRINDER_83, { settingDefault: "5", rpmMin: "600", rpmMax: "1000" })).status).toBe(200);
    const onC = String(await localId(c, "/grinders", global83));
    await expect.poll(async () => ((await c.callApi("GET", `/grinders/${onC}`)).body as Record_).extras, { timeout: 15_000 }).toMatchObject({ settingDefault: 5, rpmMin: 600, rpmMax: 1000 });
    await quiet();

    // Picked on C, on DYE2's Grinders page: C's own record of it brings the default and the middle of the RPM's range.
    expect((await tapGrinderInDye2(c, onC)).status).toBe(200);
    expect(held(c)).toMatchObject({ grinder: onC, grind: "5", rpm: 800 });
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ grinderId: global83, grindSetting: 5, rpm: 800 });
    await expect.poll(async () => held(a), { timeout: 15_000 }).toMatchObject({ grinder: RECORDED_GRINDER_83, grind: "5", rpm: 800 });
    await quiet();
    expect(held(c)).toMatchObject({ grinder: onC, grind: "5", rpm: 800 });
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });
});
