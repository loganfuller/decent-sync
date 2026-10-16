import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #190: steam and flush settings are each Machine's own
// until a Recipe holds them (#173), and nothing syncs them. A change of one
// on a Machine stays there, though DYE2 records it into the recipe it has
// selected, and is never written back, as a purge set back to a value its
// recipes held once was; it reaches no other Machine, and changes nothing on
// the server but the Machine's events. The server's writes of a recipe
// record leave its steam and flush values as the tablet holds them. A
// Machine joining a Location keeps its own (joining.test.ts). Through the
// built plugin in simulated tablets running DYE2 at 2cf631c as recorded
// (fixtures/decaid/dye2-2cf631c/), Machines A and C on two server instances
// sharing one database, with assertions through the REST API and what each
// simulated tablet holds. Serials are made up, from 49001.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The steam and flush values a DYE2 recipe record holds. */
const STEAM_AND_FLUSH = ["steamMode", "steamTimeS", "steamFlowMls", "flushS"] as const;

describe("Steam and flush settings are each Machine's own", { timeout: 120_000 }, () => {
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
  /** The steam mode and the steam and flush values of the tablet's recipe in that slot; a value it holds none of is undefined. */
  const steamAndFlush = (tablet: SimulatedTablet, slot: string) => Object.fromEntries(STEAM_AND_FLUSH.map((name) => [name, variables(inSlot(tablet, slot))[name]]));
  /** The steam and rinse parts of the tablet's Workflow. */
  const parts = (tablet: SimulatedTablet) => ({ steamSettings: tablet.workflow().steamSettings, rinseData: tablet.workflow().rinseData });
  const flush = (tablet: SimulatedTablet) => (tablet.workflow().rinseData as Record_).duration;
  /** The latest Workflow the server stored for the Machine. */
  const latestWorkflow = async ({ machine }: CreatedMachine) =>
    (await api.get<{ events: { workflow: Record<string, Record_> }[] }>(`/machines/${machine.id}/workflow-events?limit=1`)).events[0]?.workflow;
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: unknown[] }>(`/recipes/${id}/history`)).versions;
  const conflicts = async () => (await api.get<{ conflicts: unknown[] }>("/conflicts")).conflicts;
  /** The writes the server sent the tablet's plugin from `from` on. */
  const writesTo = (tablet: SimulatedTablet, from: number) =>
    tablet.received.slice(from).filter((frame) => (frame as Record_).type === "write") as { kind: string; fields: Record_ }[];
  /** Those of the writes that set a steam or flush value, of the Workflow or of a recipe record. */
  const ofSteamOrFlush = (writes: { fields: Record_ }[]) =>
    writes.filter(({ fields }) => Object.keys(fields).some((field) => /^(steamSettings|rinseData)\.|\.(steamTimeS|steamFlowMls|flushS)$/.test(field)));
  /** Waits a while for what should not happen, as a write of a setting back. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  /**
   * A Location with Machines A, whose tablet is the 2cf631c recording's, on
   * one instance, and C on the other, its tablet where DYE2 was never used,
   * each running DYE2. A brings slots 1 and 2, which C is written, and slot
   * 1 is applied on DYE2's dashboard on both, which each loads. A's machine
   * is connected.
   */
  async function lab(scenario: string, serial: number) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = { a: await api.createMachine(`${scenario} lab A`, here.id), c: await api.createMachine(`${scenario} lab C`, here.id) };
    const dye2 = { a: new SimulatedDye2(), c: new SimulatedDye2() };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: dye2.a });
    await api.waitForOnline(machines.a);
    await expect.poll(() => ["1", "2"].map((slot) => dye2GlobalIdOf(inSlot(a, slot))), { timeout: 15_000 }).not.toContain(null);
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 1)), dye2: dye2.c });
    await api.waitForOnline(machines.c);
    await expect
      .poll(() => ["1", "2"].map((slot) => [dye2GlobalIdOf(inSlot(c, slot)), inSlot(c, slot)?.beanBatchId ?? null]).flat(), { timeout: 15_000 })
      .not.toContain(null);
    const one = dye2GlobalIdOf(inSlot(a, "1"))!;
    for (const [tablet, machine] of [
      [a, machines.a],
      [c, machines.c],
    ] as const) {
      expect((await (await openDye2Dashboard(tablet)).applyRecipe("1")).selection?.status).toBe(200);
      await expect
        .poll(async () => (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.machine.id}`)).machine.loadedRecipe?.recipe.id, {
          timeout: 15_000,
        })
        .toBe(one);
    }
    a.connectMachine();
    await settle();
    return { here, machines, dye2, a, c, one };
  }

  it("keeps a flush time changed on a Machine 10, 5, 10 and 5, with a recipe selected in DYE2, at each value, writing nothing back", async () => {
    const { machines, dye2, a, c, one } = await lab("Purge", 49001);
    // Slot 1, selected, holds a 5 s flush, as A's Workflow does.
    expect([variables(inSlot(a, "1")).flushS, flush(a)]).toEqual([5, 5]);
    const elsewhere = { parts: parts(c), recipe: steamAndFlush(c, "1") };
    const history = (await versions(one)).length;
    const received = a.received.length;
    const recordedFlushes = () => dye2.a.recorded.filter((record) => record.patch.flushS !== undefined).map((record) => record.patch.flushS);

    for (const [index, duration] of [10, 5, 10, 5].entries()) {
      await a.changeSettings({ rinseData: { duration } });
      // DYE2 records it into the selected recipe, and the server takes in the Workflow.
      await expect.poll(recordedFlushes, { timeout: 15_000 }).toHaveLength(index + 1);
      await expect.poll(async () => (await latestWorkflow(machines.a))?.rinseData?.duration, { timeout: 15_000 }).toBe(duration);
      await settle();
      expect([flush(a), variables(inSlot(a, "1")).flushS]).toEqual([duration, duration]);
    }
    expect(recordedFlushes()).toEqual([10, 5, 10, 5]);
    // Nothing was written of the flush, and the Recipe and the other Machine are as they were.
    expect(ofSteamOrFlush(writesTo(a, received))).toEqual([]);
    expect((await versions(one)).length).toBe(history);
    expect({ parts: parts(c), recipe: steamAndFlush(c, "1") }).toEqual(elsewhere);
  });

  it("keeps a steam and flush change on one Machine to it: no other Machine's Workflow or recipe, and nothing on the server but its events", async () => {
    const { machines, dye2, a, c, one } = await lab("Own", 49011);
    const elsewhere = { parts: parts(c), recipe: steamAndFlush(c, "1") };
    const content = (await recipe(one)).content;
    const history = (await versions(one)).length;
    const open = (await conflicts()).length;
    const received = { a: a.received.length, c: c.received.length };

    await a.changeSettings({ steamSettings: { duration: 27, flow: 1.6 }, rinseData: { duration: 7 } });
    // DYE2 records the steam time of slot 1's mode and its flush into it, and the server stores the Workflow.
    await expect.poll(() => dye2.a.recorded.some((record) => record.patch.steamTimeS === 27 && record.patch.flushS === 7), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await latestWorkflow(machines.a))?.steamSettings?.duration, { timeout: 15_000 }).toBe(27);
    await settle();

    expect(parts(a)).toMatchObject({ steamSettings: { duration: 27, flow: 1.6 }, rinseData: { duration: 7 } });
    expect(steamAndFlush(a, "1")).toMatchObject({ steamMode: "time", steamTimeS: 27, flushS: 7 });
    expect({ parts: parts(c), recipe: steamAndFlush(c, "1") }).toEqual(elsewhere);
    // The server may write slot 1's embedded Workflow, which DYE2 rebuilt as it recorded, as it derives it, but no steam or
    // flush value; and nothing to the other Machine.
    expect([ofSteamOrFlush(writesTo(a, received.a)), writesTo(c, received.c)]).toEqual([[], []]);
    expect((await recipe(one)).content).toEqual(content);
    expect((await versions(one)).length).toBe(history);
    expect((await conflicts()).length).toBe(open);
  });

  it("leaves the steam and flush values of each tablet's recipe records as it holds them when it writes them", async () => {
    const { here, a, c, one } = await lab("Written", 49021);
    // C's barista sets a steam time and flush in slot 1's record, as DYE2's editor saves them, which is no edit of the Recipe.
    const saved = records(c).map((record) =>
      record.id === "1" ? { ...record, dashboardVariables: { ...variables(record), steamTimeS: 41, flushS: 8 }, capturedAt: new Date().toISOString() } : record,
    );
    expect((await c.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, saved)).status).toBe(200);
    await settle();
    const held = { a: steamAndFlush(a, "1"), c: steamAndFlush(c, "1") };
    expect(held).toEqual({
      a: { steamMode: "time", steamTimeS: 30, steamFlowMls: undefined, flushS: 5 },
      c: { steamMode: "time", steamTimeS: 41, steamFlowMls: undefined, flushS: 8 },
    });

    // A change of the Recipe in the management interface is written to both, each keeping its own steam and flush values.
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { dose: 19.5 } })).status).toBe(200);
    for (const tablet of [a, c]) await expect.poll(() => variables(inSlot(tablet, "1")).dose, { timeout: 15_000 }).toBe(19.5);
    expect({ a: steamAndFlush(a, "1"), c: steamAndFlush(c, "1") }).toEqual(held);
    // A Recipe put in an empty slot is written without any, so applying it leaves each Machine's own.
    const created = await api.call("POST", "/recipes", { locationId: here.id, slot: 4, content: { name: "Written lab four" } });
    expect(created.status).toBe(201);
    for (const tablet of [a, c]) {
      await expect.poll(() => inSlot(tablet, "4")?.name, { timeout: 15_000 }).toBe("Written lab four");
      expect(steamAndFlush(tablet, "4")).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: undefined, flushS: undefined });
    }
  });

  it("maps none of the Location settings endpoints, which answer 404", async () => {
    const here = await api.createLocation("Gone lab", "America/Chicago");
    const machines = { a: await api.createMachine("Gone lab A", here.id) };
    const routes = [...server.output().matchAll(/Mapped \{(\/\S+), (\w+)\} route/g)].map(([, path, method]) => `${method} ${path}`);
    const gone = [
      ["GET", `/locations/${here.id}/settings`, "GET /api/locations/:id/settings"],
      ["PATCH", `/location-settings/${here.id}`, "PATCH /api/location-settings/:id"],
      ["PUT", `/machines/${machines.a.machine.id}/settings-sharing`, "PUT /api/machines/:id/settings-sharing"],
      ["GET", `/location-settings/${here.id}/history`, "GET /api/location-settings/:id/history"],
      ["GET", `/location-settings/${here.id}/conflicts`, "GET /api/location-settings/:id/conflicts"],
    ] as const;
    for (const [method, path, route] of gone) {
      expect(routes).not.toContain(route);
      expect((await api.call(method, path, method === "GET" ? undefined : {})).status, route).toBe(404);
    }
  });
});
