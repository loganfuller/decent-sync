import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeIdInWorkflow, recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { SimulatedDye2, dye2List, dye2NeverUsed, recordedDye2MainTablet, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { shotFixture } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #217: the plugin holds its writes into the Workflow
// while its Machine pulls a Shot (ADR-0022), as Decaid writes a changed
// profile to the machine mid-Shot, and stores the Shot with the Workflow it
// holds as it ends. From the machine state `espresso` until Decaid stores
// the Shot, the plugin carries out none of the server's changes, answering
// the one it holds once the Shot is stored, and the server plans afresh
// then, so a Recipe edited twice is written once, with its latest values, a
// change of Profile with the rest; and it holds its own load
// of a Recipe applied meanwhile, which it keeps in Decaid's plugin storage,
// so a load held as it stops is made after it starts again. Saves into the
// Recipe are not held, but for those after steam turned back on during the
// Shot, held with its write of the Recipe's steam temperature (#374).
// Through the built plugin in simulated tablets running DYE2 v0.1.33 as
// recorded (fixtures/decaid/dye2-v0.1.26/ and later), A on one server
// instance and C, which pulls the Shots, on another sharing one database.
// Serials are made up, from 51001.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record ids: the Ethiopia's recipe, in no Recipe Slot, and the Brazil's, in slot 2. */
const ETHIOPIA = "1";
const BRAZIL = "2";

/** The recording's profile the Brazil's recipe holds, which the Ethiopia's does not. */
const CLASSIC = "profile:39e939592679fb194706";

describe("The plugin holds its Workflow writes while its Machine pulls a Shot", { timeout: 120_000 }, () => {
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
  const record = (tablet: SimulatedTablet, id: string) => records(tablet).find((entry) => entry.id === id);
  const variables = (entry: Record_ | undefined) => (entry?.dashboardVariables ?? {}) as Record_;
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const firstTemperature = (tablet: SimulatedTablet) => (((tablet.workflow().profile as Record_).steps as Record_[])[0] ?? {}).temperature;
  const dial = (tablet: SimulatedTablet) => [context(tablet).targetDoseWeight, context(tablet).grinderSetting];
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  const loadedTimes = async ({ machine }: CreatedMachine) => (await api.get<{ total: number }>(`/machines/${machine.id}/loaded-recipes`)).total;
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** How many writes of the Workflow the tablet's plugin made. */
  const workflowWrites = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === "PUT /workflow").length;
  /** The writes the server sent the tablet's plugin. */
  const serverWrites = (tablet: SimulatedTablet) => tablet.received.filter((frame) => (frame as Record_).type === "write");
  /** The Recipe whose load the tablet's plugin keeps held for a Shot in its storage (`heldLoad`), by its global id, or null. */
  const heldLoad = (tablet: SimulatedTablet) => {
    const kept = tablet.storage.read("heldLoad");
    return typeof kept === "string" ? ((JSON.parse(kept) as { globalId?: string }).globalId ?? null) : null;
  };

  /** The steam temperature the tablet's Workflow holds. */
  const steam = (tablet: SimulatedTablet) => ((tablet.workflow().steamSettings ?? {}) as Record_).targetTemperature;
  /** The latest Workflow the server stored for the Machine. */
  const latestWorkflow = async ({ machine }: CreatedMachine) =>
    (await api.get<{ events: { workflow: Record_ }[] }>(`/machines/${machine.id}/workflow-events?limit=1`)).events[0]?.workflow;
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  /** Each steam temperature the DYE2 saved into a record from its `from`th save on. */
  const steamSaved = (dye2: SimulatedDye2, from: number) => dye2.recorded.slice(from).flatMap(({ patch }) => ("steamTempC" in patch ? [patch.steamTempC] : []));
  /** Gives the Ethiopia's Recipe a steam temperature of 160 °C, which C's record and Workflow take, then turns C's steam off. */
  async function steamOffOn(c: SimulatedTablet, one: string, quiet: () => Promise<void>) {
    await patch(one, { steamTemperature: 160 });
    await expect.poll(() => [variables(record(c, ETHIOPIA)).steamTempC, steam(c)], { timeout: 15_000 }).toEqual([160, 160]);
    await c.changeSettings({ steamSettings: { targetTemperature: 0 } });
    // Once C's report of steam off, and anything it set off, are done.
    await quiet();
  }

  /** C pulls a Shot: its machine state is espresso until Decaid stores it, as `end()` does. */
  function shotOn(tablet: SimulatedTablet, id: string, serial: number) {
    tablet.reportState("espresso", "pouring");
    return {
      end() {
        tablet.reportState("idle", "idle");
        tablet.pullShot(shotOf(tablet, id, serial));
      },
    };
  }

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, on
   * one instance, and C, a tablet where DYE2 was never used, on the other,
   * each running DYE2. A brings its recipes, and the Ethiopia's is applied
   * from DYE2's Select Recipe page on A, then on C the Ethiopia's, or the
   * recipe whose record id `c` gives, which each loads. Each load returns
   * once both tablets and the server have nothing left to do (`quiet()`).
   * `quiet()` resolves once both tablets, their DYE2s and both Machines have
   * nothing left under way (`quiesced`). During a Shot on C the server's
   * writes to C are held on purpose, so C's Machine keeps them waiting:
   * `quiet({ shotOnC: true })` leaves it out, and the site waits first for
   * a sign of its own that the write is held.
   */
  async function lab(scenario: string, serial: number, options: { c?: typeof ETHIOPIA | typeof BRAZIL } = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = { a: await api.createMachine(`${scenario} lab A`, here.id), c: await api.createMachine(`${scenario} lab C`, here.id) };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: new SimulatedDye2() });
    await api.waitForOnline(machines.a);
    await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => dye2GlobalIdOf(record(a, id))), { timeout: 15_000 }).not.toContain(null);
    const dye2 = new SimulatedDye2();
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 1)), dye2 });
    await api.waitForOnline(machines.c);
    await expect.poll(() => [ETHIOPIA, BRAZIL].map((id) => [dye2GlobalIdOf(record(c, id)), record(c, id)?.beanBatchId ?? null]).flat(), { timeout: 15_000 }).not.toContain(null);
    const one = dye2GlobalIdOf(record(a, ETHIOPIA))!;
    const two = dye2GlobalIdOf(record(a, BRAZIL))!;
    const quiet = ({ shotOnC = false } = {}) => quiesced(api, { tablets: { a, c }, machines: shotOnC ? { a: machines.a } : machines });
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, id: string, recipeId: string) => {
      expect((await selectRecipeInDye2(tablet, id)).applied?.workflow?.status).toBe(200);
      await expect.poll(() => recipeNamedInWorkflow(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
      // The writes that follow a load land, so none is under way as a Shot begins.
      await quiet();
    };
    await load(a, machines.a, ETHIOPIA, one);
    const onC = options.c ?? ETHIOPIA;
    await load(c, machines.c, onC, onC === BRAZIL ? two : one);
    return { machines, a, c, one, two, dye2, quiet };
  }

  /**
   * Applies the Ethiopia's recipe on the tablet from an out-of-date copy, as
   * a Streamline dashboard that has not read its recipes again does: its
   * old dose and grind, with its record id, which the plugin's load write
   * brings to the record's.
   */
  const applyStaleEthiopia = (tablet: SimulatedTablet) =>
    tablet.callApi("PUT", "/workflow", { context: { targetDoseWeight: 18, grinderSetting: "2.5", extras: { dye: { recipeId: ETHIOPIA } } } });

  it("writes two Recipe edits made during C's Shot into its Workflow once it is stored, with the latest values, a Profile change with the rest as one write", async () => {
    const { machines, c, one, quiet } = await lab("Edits", 51001);
    const times = await loadedTimes(machines.c);
    const grinds: unknown[] = [];
    c.onWorkflowChange((workflow) => grinds.push(((workflow.context ?? {}) as Record_).grinderSetting));
    const writes = workflowWrites(c);
    const sent = serverWrites(c).length;
    const shot = shotOn(c, "edits-51001", 51002);
    await patch(one, { grindSetting: 3.1 });
    // The server asked for the first of its writes, of C's record of the Recipe, which the plugin holds.
    await expect.poll(() => serverWrites(c).length, { timeout: 15_000 }).toBeGreaterThan(sent);
    await patch(one, { grindSetting: 3.2, profileId: CLASSIC, brewTemperature: 91 });
    // The site's own wait is the server's first write above, which the plugin holds through the Shot; then nothing under way
    // on the tablets, C's Machine left out, as it has the held writes waiting.
    await quiet({ shotOnC: true });
    expect(workflowWrites(c)).toBe(writes);
    expect(context(c).grinderSetting).toBe("2.5");

    shot.end();
    await expect.poll(() => [context(c).grinderSetting, (c.workflow().profile as Record_).title, firstTemperature(c)], { timeout: 15_000 }).toEqual(["3.2", "Classic Italian espresso", 91]);
    // Once the held writes, their reports and anything else they set off are done.
    await quiet();
    // Written once, the profile's change with the rest, which DYE2 keeps the recipe named through.
    expect(workflowWrites(c)).toBe(writes + 1);
    expect(grinds).not.toContain("3.1");
    expect(recipeIdInWorkflow(c)).toBe(ETHIOPIA);
    await loads(machines.c, one);
    expect(await loadedTimes(machines.c)).toBe(times);
  });

  it("holds a load and an unload made during C's Shot until it is stored, while a change made on C during it is saved into the Recipe at once", async () => {
    const { machines, c, one, quiet } = await lab("Load", 51011, { c: BRAZIL });
    await patch(one, { dose: 18.6, grindSetting: 2.9 });
    await expect.poll(() => [variables(record(c, ETHIOPIA)).dose, variables(record(c, ETHIOPIA)).grind], { timeout: 15_000 }).toEqual([18.6, 2.9]);
    const writes = workflowWrites(c);
    let shot = shotOn(c, "load-51011", 51012);
    expect((await applyStaleEthiopia(c)).status).toBe(200);
    await loads(machines.c, one);
    // The site's own wait: the plugin keeps the load held for the Shot; then nothing under way on the tablets, C's Machine
    // left out.
    await expect.poll(() => heldLoad(c), { timeout: 15_000 }).toBe(one);
    await quiet({ shotOnC: true });
    expect(workflowWrites(c)).toBe(writes);
    expect(dial(c)).toEqual([18, "2.5"]);
    shot.end();
    await expect.poll(() => dial(c), { timeout: 15_000 }).toEqual([18.6, "2.9"]);
    // Once the held load, its report and anything else it set off are done.
    await quiet();

    // A change on C during its next Shot is saved into the Recipe, but its unload waits.
    shot = shotOn(c, "unload-51011", 51012);
    await c.changeSettings({ context: { targetDoseWeight: 18.8 } });
    await expect.poll(async () => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${one}`)).recipe.content.dose, { timeout: 15_000 }).toBe(18.8);
    const sent = c.received.length;
    expect((await api.call("PUT", `/recipes/${one}/archived`, { archived: true })).status).toBe(200);
    // The site's own wait: the server's removal of C's record of the Recipe has reached the plugin, which holds it through
    // the Shot; then nothing under way on the tablets, C's Machine left out, as it has the removal and the unload waiting.
    await expect.poll(() => (c.received.slice(sent) as Record_[]).some((frame) => frame.type === "remove" && frame.kind === "recipe"), { timeout: 15_000 }).toBe(true);
    await quiet({ shotOnC: true });
    expect(recipeIdInWorkflow(c)).toBe(ETHIOPIA);
    shot.end();
    await expect.poll(() => recipeIdInWorkflow(c), { timeout: 15_000 }).toBeNull();
    await loads(machines.c, null);
  });

  it("makes a load held as the plugin stops once it loads again, where the Workflow still names its Recipe", async () => {
    const { machines, c, one, quiet } = await lab("Reload", 51021, { c: BRAZIL });
    await patch(one, { dose: 18.6, grindSetting: 2.9 });
    await expect.poll(() => [variables(record(c, ETHIOPIA)).dose, variables(record(c, ETHIOPIA)).grind], { timeout: 15_000 }).toEqual([18.6, 2.9]);
    const writes = workflowWrites(c);
    c.reportState("espresso", "pouring");
    expect((await applyStaleEthiopia(c)).status).toBe(200);
    await loads(machines.c, one);
    // The site's own wait: the plugin keeps the load held for the Shot; then nothing under way on the tablets, C's Machine
    // left out.
    await expect.poll(() => heldLoad(c), { timeout: 15_000 }).toBe(one);
    await quiet({ shotOnC: true });
    expect(workflowWrites(c)).toBe(writes);
    // Loaded again, as on an update, and cut off from the server, so only the plugin's own load writes the Workflow.
    const reloaded = await c.reload();
    reloaded.loseNetwork();
    reloaded.reportState("idle", "idle");
    reloaded.pullShot(shotOf(reloaded, "reload-51021", 51022));
    await expect.poll(() => dial(reloaded), { timeout: 15_000 }).toEqual([18.6, "2.9"]);
    expect(recipeIdInWorkflow(reloaded)).toBe(ETHIOPIA);
    reloaded.restoreNetwork();
    await loads(machines.c, one);
  });

  it("holds steam turned back on during C's Shot, and every save after it, until the Shot is stored, then turns it on at the Recipe's steam temperature and saves the rest", async () => {
    const { machines, c, one, dye2, quiet } = await lab("Steam", 51041);
    await steamOffOn(c, one, quiet);
    const writes = workflowWrites(c);
    const saves = dye2.recorded.length;
    const shot = shotOn(c, "steam-51041", 51042);
    // Turned back on at 140 °C on Decaid's own screen during the Shot, and the dose changed after.
    await c.changeSettings({ steamSettings: { targetTemperature: 140 } });
    await c.changeSettings({ context: { targetDoseWeight: 18.8 } });
    // The site's own wait: the plugin delivers the dose change once its save of it is done, here held for the Shot; then
    // nothing under way on the tablets, C's Machine left out.
    await expect.poll(async () => ((await latestWorkflow(machines.c))?.context as Record_ | undefined)?.targetDoseWeight, { timeout: 15_000 }).toBe(18.8);
    await quiet({ shotOnC: true });
    expect([workflowWrites(c), dye2.recorded.length, steam(c)]).toEqual([writes, saves, 140]);

    shot.end();
    await expect.poll(() => steam(c), { timeout: 15_000 }).toBe(160);
    await expect.poll(async () => (await recipe(one)).content.dose, { timeout: 15_000 }).toBe(18.8);
    // Once the held write, the save after it, its report and the write into A are done.
    await quiet();
    expect([workflowWrites(c), steamSaved(dye2, saves), (await recipe(one)).content.steamTemperature]).toEqual([writes + 1, [], 160]);
  });

  it("saves a change made on C while the plugin, loaded again, is still reading the load it may have held", async () => {
    const { c, dye2 } = await lab("Restore", 51031);
    // At the tablet's own pace, so its storage read waits Decaid's 10 s before it gives up.
    const reloaded = await c.reload({ timeScale: 1 });
    const release = reloaded.holdStorageAnswers();
    try {
      await expect.poll(() => reloaded.requests.filter((route) => route.endsWith("/dye2.reaplugin/recipes")).length, { timeout: 5_000 }).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const saves = dye2.recorded.length;
      await reloaded.changeSettings({ context: { targetDoseWeight: 18.9 } });
      await expect.poll(() => dye2.recorded.length, { timeout: 5_000 }).toBeGreaterThan(saves);
      expect(dye2.recorded.at(-1)).toMatchObject({ id: ETHIOPIA, patch: { dose: 18.9 } });
    } finally {
      release();
    }
  });
});

/** A Shot the tablet's Decaid stores as one pulled with its Workflow now, on the machine with that serial. */
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
