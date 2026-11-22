import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, openDye2RecipeEditor, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #617: from DYE2 v0.1.42 a grind setting of 0 is a dial
// position (decentespresso/dye2#47), so it is a Recipe's, as any other
// setting is, while a dose or RPM of 0 stays none (ADR-0022). A Recipe saved
// at 0 in DYE2's editor holds 0, is shown so, and reaches the Location's
// other tablets as 0; loading it from DYE2's dashboard or Streamline's strip
// leaves the Workflow's grind setting at 0 with no write of the plugin's, and
// the plugin's own load write, for a Skin that applies nothing, writes it; a
// Recipe holding none still clears the Workflow's. A 0 dialled on a Machine
// reaches its Loaded Recipe through DYE2's `record`. DYE2's repair, as it
// loads, of a recipe saved at 0 before v0.1.42, holding none in its embedded
// Workflow, is no edit and starts no write. Through the built plugin in
// simulated tablets running DYE2 and Streamline, Machine A on one server
// instance and B on another sharing one database, with assertions through
// the REST API and what each simulated tablet holds. Serials are made up,
// from 61701.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record ids: its library recipe, in slot 1, and the Brazil's, in slot 2. */
const LIBRARY = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";
const BRAZIL = "2";

/** What applies a recipe: DYE2's dashboard, Streamline's strip, or a Skin that only names it in the Workflow, leaving the rest to the plugin's load write. */
type AppliedBy = "dashboard" | "strip" | "skin";

describe("A grind setting of 0 is a Recipe's (#617)", { timeout: 180_000 }, () => {
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
  /** The grind setting a tablet's record of a recipe holds, and the one its embedded Workflow holds, null for none. */
  const recorded = (tablet: SimulatedTablet, id: string) => {
    const entry = record(tablet, id);
    return [variables(entry).grind ?? null, (((entry?.workflow as Record_ | undefined)?.context as Record_ | undefined)?.grinderSetting as unknown) ?? null];
  };
  /** The tablet's Workflow's grind setting, null for none. */
  const grind = (tablet: SimulatedTablet) => ((tablet.workflow().context as Record_ | undefined)?.grinderSetting as unknown) ?? null;
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: { fields: Record_ }[] }>(`/recipes/${id}/history`)).versions;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** The grind settings of the plugin's writes into a tablet's Workflow from now on, as it sent them: one entry per write naming one. */
  const grindWrites = (tablet: SimulatedTablet) => {
    const writes: unknown[] = [];
    tablet.refuseWrites = ({ method, route, body }) => {
      const context = (body as { context?: Record_ } | undefined)?.context;
      if (method === "PUT" && route === "/workflow" && context && "grinderSetting" in context) writes.push(context.grinderSetting);
      return undefined;
    };
    return writes;
  };
  /** How many times the plugin has written DYE2's recipes on a tablet. */
  const recipeWrites = (tablet: SimulatedTablet) => tablet.storeWrites.filter((write) => write.namespace === DYE2_NAMESPACE && write.key === "recipes").length;

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, on
   * one instance, and B, a tablet where DYE2 was never used, on the other,
   * each running DYE2, B with Streamline as its Skin. A brings its recipes,
   * the library recipe's Recipe given a grind setting of 2.5 and the
   * Brazil's none, before B joins, so both tablets' records hold them.
   * Nothing is loaded. `load` applies a recipe on a tablet (`AppliedBy`)
   * and waits for its Machine to have it loaded; `quiet()` resolves once
   * every tablet, Streamline and the server have nothing left under way.
   */
  async function lab(scenario: string, serial: number) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = { a: await api.createMachine(`${scenario} lab A`, here.id), b: await api.createMachine(`${scenario} lab B`, here.id) };
    const dye2 = new SimulatedDye2();
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2 });
    await api.waitForOnline(machines.a);
    await expect.poll(() => [LIBRARY, BRAZIL].map((id) => dye2GlobalIdOf(record(a, id))), { timeout: 15_000 }).not.toContain(null);
    const one = dye2GlobalIdOf(record(a, LIBRARY))!;
    const two = dye2GlobalIdOf(record(a, BRAZIL))!;
    await patch(one, { grindSetting: 2.5 });
    await patch(two, { grindSetting: null });
    await expect.poll(() => [recorded(a, LIBRARY), recorded(a, BRAZIL)], { timeout: 15_000 }).toEqual([[2.5, "2.5"], [null, null]]);
    const b = syncingTablet(machines.b, other, { api: dye2NeverUsed(String(serial + 1)), dye2: new SimulatedDye2() });
    await api.waitForOnline(machines.b);
    await expect.poll(() => [recorded(b, LIBRARY), recorded(b, BRAZIL)], { timeout: 15_000 }).toEqual([[2.5, "2.5"], [null, null]]);
    const streamline = await startStreamline(b);
    const tablets: Record<string, SimulatedTablet> = { a, b };
    const quiet = () => quiesced(api, { tablets, machines, streamlines: { streamline } });
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, id: string, recipeId: string, by: AppliedBy) => {
      if (by === "dashboard") expect((await (await openDye2Dashboard(tablet)).applyRecipe(id)).workflow?.status).toBe(200);
      else if (by === "strip") expect((await streamline.applyRecipe(id)).selection?.status).toBe(200);
      else expect((await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id })).status).toBe(200);
      await expect.poll(() => recipeNamedInWorkflow(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
    };
    await quiet();
    return { machines, a, b, dye2, one, two, load, quiet };
  }

  it("takes a grind setting of 0 saved in DYE2's editor as the Recipe's, shows it and writes it to the other tablet; a load of it leaves the Workflow at 0, with no write of the plugin's after DYE2's dashboard or Streamline's strip; and a Recipe holding none still clears it", async () => {
    const { machines, a, b, one, two, load, quiet } = await lab("Zero grind", 61701);
    const before = (await versions(one)).length;

    // Saved at 0 in A's DYE2 editor: the Recipe's, one version setting it, written to B as DYE2 v0.1.42 holds it.
    await (await openDye2RecipeEditor(a, { id: LIBRARY })).set({ grind: 0 }).save();
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => recorded(b, LIBRARY), { timeout: 15_000 }).toEqual([0, "0"]);
    await quiet();
    expect(recorded(a, LIBRARY)).toEqual([0, "0"]);
    const edits = await versions(one);
    expect(edits.length).toBe(before + 1);
    expect(edits[0]!.fields).toMatchObject({ grindSetting: 0 });

    // Loaded from DYE2's dashboard on A and Streamline's strip on B: each applies "0", and the plugin writes no grind setting.
    const writes = { a: grindWrites(a), b: grindWrites(b) };
    await load(a, machines.a, LIBRARY, one, "dashboard");
    await load(b, machines.b, LIBRARY, one, "strip");
    await quiet();
    expect([grind(a), grind(b)]).toEqual(["0", "0"]);
    expect(writes).toEqual({ a: [], b: [] });

    // The Brazil's Recipe holds none: loading it clears the Workflow's 0, from the dashboard, the strip and the plugin alike.
    await load(a, machines.a, BRAZIL, two, "dashboard");
    await load(b, machines.b, BRAZIL, two, "strip");
    await quiet();
    expect([grind(a), grind(b)]).toEqual([null, null]);
    // Loaded by a Skin that applies nothing, the plugin's load write does it: the Recipe's 0 written over none, and none
    // over the 0.
    await load(a, machines.a, LIBRARY, one, "skin");
    await expect.poll(() => grind(a), { timeout: 15_000 }).toBe("0");
    await quiet();
    await load(a, machines.a, BRAZIL, two, "skin");
    await expect.poll(() => grind(a), { timeout: 15_000 }).toBeNull();
    await quiet();
    // Its load write, and the server's write of the Loaded Recipe through it where that lands first, each as the Recipe holds it.
    expect([...new Set(writes.a)]).toEqual(["0", null]);

    // None of it was an edit: the Recipe still holds 0, the Brazil's none, and neither has a version since.
    expect([(await recipe(one)).content.grindSetting, (await recipe(two)).content.grindSetting ?? null]).toEqual([0, null]);
    expect((await versions(one)).length).toBe(edits.length);
    // A dose or RPM of 0 is still none: no edit sets one.
    for (const field of ["dose", "rpm"]) expect((await api.call("PATCH", `/recipes/${one}`, { content: { [field]: 0 } })).status, field).toBe(400);
  });

  it("saves a grind setting of 0 dialled on a Machine into its Loaded Recipe through DYE2's record; and DYE2's repair of a recipe saved at 0 before v0.1.42 is no edit and starts no write", async () => {
    const { machines, a, b, dye2, one, load, quiet } = await lab("Repair", 61711);
    await load(a, machines.a, LIBRARY, one, "dashboard");
    await quiet();

    // Dialled to 0 on A: DYE2's record saves the number 0 into the record and "0" into its embedded Workflow, the Recipe's edit.
    await a.changeSettings({ context: { grinderSetting: "0" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => recorded(b, LIBRARY), { timeout: 15_000 }).toEqual([0, "0"]);
    await quiet();
    expect([recorded(a, LIBRARY), grind(a)]).toEqual([[0, "0"], "0"]);

    // A's record as DYE2 v0.1.41's editor saved one at 0: none in its embedded Workflow. Taken in, it is no edit.
    const edits = (await versions(one)).length;
    const oldRow = records(a).map((entry) =>
      entry.id === LIBRARY ? { ...entry, workflow: { ...(entry.workflow as Record_), context: { ...((entry.workflow as Record_).context as Record_), grinderSetting: null } } } : entry,
    );
    expect((await a.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, oldRow)).status).toBe(200);
    await quiet();
    expect(recorded(a, LIBRARY)).toEqual([0, null]);
    expect((await versions(one)).length).toBe(edits);
    const written = { a: recipeWrites(a), b: recipeWrites(b) };

    // DYE2 v0.1.42 loads again, as after an update, and repairs it: "0" back in its embedded Workflow.
    await dye2.reload();
    await expect.poll(() => recorded(a, LIBRARY), { timeout: 15_000 }).toEqual([0, "0"]);
    await quiet();
    // No Recipe changed, and the plugin wrote no tablet's recipes for it.
    expect((await recipe(one)).content.grindSetting).toBe(0);
    expect((await versions(one)).length).toBe(edits);
    expect({ a: recipeWrites(a), b: recipeWrites(b) }).toEqual(written);
    expect(recorded(b, LIBRARY)).toEqual([0, "0"]);
  });
});
