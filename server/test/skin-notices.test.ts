import { randomUUID } from "node:crypto";
import { ANOTHER_ITEMS_RECORD, GLOBAL_ID_KEY, RECORD_CHANGED, type ServerMessage } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { DYE2_NAMESPACE, dye2List } from "./support/simulated-dye2.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { type SimulatedTablet, settingsFor } from "./support/simulated-tablet.js";
import { StandInServer } from "./support/stand-in-server.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Ticket #168: the plugin tells the skins listening on its `changed`
// endpoint, as Streamline's dashboard does, each time it has written DYE2's
// recipes, so a dashboard left visible shows the change (ADR-0005). Through
// the built plugin in simulated tablets: against a stand-in server for each
// kind of write and for the writes that post nothing, as the real server
// reaches most of those only in a race, and against two server instances
// sharing PostgreSQL for Recipes changed in the management interface. Serials
// are made up, from 46001.

type Record_ = Record<string, unknown>;

const RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;
const BASKETS = `/store/${DYE2_NAMESPACE}/baskets`;
const PUSH = { what: "workflow" };

const tablets = new LoadedTablets();
afterAll(() => tablets.unloadAll());

describe("The plugin's skin endpoint", () => {
  it("answers a GET of skin with no surfaces and its changed endpoint to listen on, and nothing else", async () => {
    // Without settings the plugin does not connect, and still answers: a skin asks every loaded plugin.
    const tablet = tablets.load({ settings: {} });

    const answer = await tablet.callEndpoint("skin");
    expect(answer.status).toBe(200);
    expect(answer.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(answer.body)).toEqual({ version: 1, surfaces: [], live: { endpoint: "changed" } });
    expect((await tablet.callEndpoint("skin", { method: "POST", body: {} })).status).toBe(405);
    // Decaid answers these itself: one not declared, and the WebSocket endpoint.
    expect((await tablet.callEndpoint("ui")).status).toBe(404);
    expect((await tablet.callEndpoint("changed")).status).toBe(400);
    expect(tablet.pushes("changed")).toEqual([]);
  });
});

describe("Telling skins of each write to DYE2's recipes", () => {
  let server: StandInServer;
  let tablet: SimulatedTablet;
  let asked = 0;

  beforeAll(async () => {
    server = await StandInServer.start();
    tablet = tablets.load({ settings: settingsFor({ token: "stand-in token 46001", serverUrl: server.url }), api: emptyLibrary(46001) });
    await server.welcomed();
  });
  afterAll(() => server?.stop());

  const id = () => `skin-${++asked}`;
  const write = (fields: Record_, globalId: string, localId: string | null = null, expected?: Record_): ServerMessage & { id: string } => ({
    type: "write",
    id: id(),
    kind: "recipe",
    globalId,
    localId,
    fields,
    ...(expected ? { expected } : {}),
  });
  /** Sets the tablet's recipes as DYE2 saves them, which the plugin is not told of. */
  const holdRecipes = async (records: Record_[]) => expect((await tablet.callApi("POST", RECIPES, records)).status).toBe(200);
  const recipes = () => dye2List(tablet, "recipes") as Record_[];

  /** Asks the plugin, and resolves with its answer and the pushes the request led to. */
  async function pushesFor(request: ServerMessage & { id: string }): Promise<{ answer: Record_; pushes: unknown[] }> {
    const before = tablet.pushes("changed").length;
    const answer = await server.ask(request);
    return { answer, pushes: tablet.pushes("changed").slice(before) };
  }

  it("pushes once after each write that posts the recipes: a create, an update, a move between slots, a removal, a set-aside and a hard delete", async () => {
    await holdRecipes([]);
    const espresso = randomUUID();
    const created = await pushesFor(write({ id: "1", name: "Espresso", "dashboardVariables.dose": 18 }, espresso));
    expect(created.answer).toMatchObject({ type: "written", globalId: espresso });
    expect(created.pushes).toEqual([PUSH]);
    expect(recipes()).toEqual([expect.objectContaining({ id: "1", name: "Espresso", [GLOBAL_ID_KEY]: espresso })]);

    const updated = await pushesFor(write({ "dashboardVariables.dose": 19 }, espresso, "1", { "dashboardVariables.dose": 18 }));
    expect(updated.answer).toMatchObject({ type: "written", writtenFields: ["dashboardVariables.dose"] });
    expect(updated.pushes).toEqual([PUSH]);

    // A Recipe moved is removed from its old slot and written in its new one, each pushed.
    const left = await pushesFor({ type: "remove", id: id(), kind: "recipe", globalId: espresso, localId: "1" });
    expect(left.answer).toMatchObject({ type: "removed" });
    expect(left.pushes).toEqual([PUSH]);
    const moved = await pushesFor(write({ id: "2", name: "Espresso", "dashboardVariables.dose": 19 }, espresso));
    expect(moved.answer).toMatchObject({ type: "written" });
    expect(moved.pushes).toEqual([PUSH]);

    // Taken out of its slot.
    const unslotted = await pushesFor({ type: "remove", id: id(), kind: "recipe", globalId: espresso, localId: "2", expected: recipes()[0] });
    expect(unslotted.answer).toMatchObject({ type: "removed" });
    expect(unslotted.pushes).toEqual([PUSH]);

    // A joining Machine's own recipe the Library leaves out.
    await holdRecipes([{ id: "3", name: "Own" }]);
    const setAside = await pushesFor({ type: "leaveOut", id: id(), kind: "recipe", localId: "3" });
    expect(setAside.answer).toMatchObject({ type: "leftOut", outcome: "setAside" });
    expect(setAside.pushes).toEqual([PUSH]);

    const doomed = randomUUID();
    await holdRecipes([{ id: "4", name: "Doomed", [GLOBAL_ID_KEY]: doomed }]);
    const deleted = await pushesFor({ type: "delete", id: id(), kind: "recipe", globalId: doomed, localId: "4" });
    expect(deleted.answer).toMatchObject({ type: "deleted" });
    expect(deleted.pushes).toEqual([PUSH]);
    expect(recipes()).toEqual([]);
  });

  it("pushes nothing for a write Decaid or the plugin refuses", async () => {
    const mine = randomUUID();
    const other = randomUUID();

    tablet.failNextApiReads(RECIPES, 1);
    const refusedRead = await pushesFor(write({ id: "1", name: "Unread" }, mine));
    expect(refusedRead.answer).toMatchObject({ type: "writeRefused", status: 503 });
    expect(refusedRead.pushes).toEqual([]);

    tablet.refuseWrites = ({ method, route }) => (method === "POST" && route === RECIPES ? { status: 500, body: { error: "Disk full" } } : undefined);
    const refusedPost = await pushesFor(write({ id: "1", name: "Unposted" }, mine));
    tablet.refuseWrites = undefined;
    expect(refusedPost.answer).toMatchObject({ type: "writeRefused", status: 500 });
    expect(refusedPost.pushes).toEqual([]);

    await holdRecipes([{ id: "espresso", name: "Not in a slot" }]);
    for (const request of [
      write({ id: "1", name: "Unrecognised" }, mine),
      { type: "remove", id: id(), kind: "recipe", globalId: mine, localId: "espresso" } as const,
      { type: "delete", id: id(), kind: "recipe", globalId: mine, localId: "espresso" } as const,
    ]) {
      const unrecognised = await pushesFor(request);
      expect(unrecognised.answer).toMatchObject({ type: "listUnrecognised" });
      expect(unrecognised.pushes).toEqual([]);
    }
    const unrecognisedLeaveOut = await pushesFor({ type: "leaveOut", id: id(), kind: "recipe", localId: "espresso" });
    expect(unrecognisedLeaveOut.answer).toMatchObject({ type: "listUnrecognised" });
    expect(unrecognisedLeaveOut.pushes).toEqual([]);

    await holdRecipes([{ id: "1", name: "Another's", [GLOBAL_ID_KEY]: other }]);
    const slotTaken = await pushesFor(write({ id: "1", name: "Mine" }, mine));
    expect(slotTaken.answer).toMatchObject({ type: "writeRefused", error: "Slot 1 holds another item's record" });
    expect(slotTaken.pushes).toEqual([]);

    const missing = await pushesFor(write({ name: "Gone" }, mine, "2", { name: "Here" }));
    expect(missing.answer).toMatchObject({ type: "writeRefused", status: 404, error: "Record not found" });
    expect(missing.pushes).toEqual([]);

    for (const request of [
      { type: "remove", id: id(), kind: "recipe", globalId: mine, localId: "1" } as const,
      { type: "delete", id: id(), kind: "recipe", globalId: mine, localId: "1" } as const,
    ]) {
      const anotherItems = await pushesFor(request);
      expect(anotherItems.answer).toMatchObject({ type: "writeRefused", error: ANOTHER_ITEMS_RECORD });
      expect(anotherItems.pushes).toEqual([]);
    }

    await holdRecipes([{ id: "1", name: "Changed on the tablet", [GLOBAL_ID_KEY]: mine }]);
    const changed = await pushesFor({ type: "remove", id: id(), kind: "recipe", globalId: mine, localId: "1", expected: { id: "1", name: "As reported", [GLOBAL_ID_KEY]: mine } });
    expect(changed.answer).toMatchObject({ type: "writeRefused", error: RECORD_CHANGED });
    expect(changed.pushes).toEqual([]);
    expect(recipes()).toEqual([{ id: "1", name: "Changed on the tablet", [GLOBAL_ID_KEY]: mine }]);
  });

  it("pushes nothing for a write that changes nothing, and so posts nothing", async () => {
    const held = randomUUID();
    await holdRecipes([
      { id: "1", name: "Held", [GLOBAL_ID_KEY]: held },
      { id: "2", name: "Taken", [GLOBAL_ID_KEY]: randomUUID() },
    ]);
    const posts = () => tablet.storeWrites.filter((written) => written.key === "recipes").length;
    const postsBefore = posts();
    for (const request of [
      // Made by a write whose answer was lost.
      write({ id: "1", name: "Held" }, held),
      // Set to what it holds.
      write({ name: "Held" }, held, "1", { name: "Held" }),
      // Changed on the tablet since, which the write leaves as it is.
      write({ name: "Renamed" }, held, "1", { name: "As reported" }),
      // Gone already.
      { type: "remove", id: id(), kind: "recipe", globalId: held, localId: "3" } as const,
      { type: "delete", id: id(), kind: "recipe", globalId: held, localId: "3" } as const,
      { type: "leaveOut", id: id(), kind: "recipe", localId: "3" } as const,
      // A Library item's now.
      { type: "leaveOut", id: id(), kind: "recipe", localId: "2" } as const,
    ]) {
      const unchanged = await pushesFor(request);
      expect(unchanged.answer.type).not.toBe("writeRefused");
      expect(unchanged.pushes).toEqual([]);
    }
    expect(posts()).toBe(postsBefore);
  });

  it("pushes nothing for writes of Baskets and Tools, which the DYE strip does not show", async () => {
    const posts = () => tablet.storeWrites.filter((written) => written.key === "baskets" || written.key === "equipment").length;
    const postsBefore = posts();
    const basket = randomUUID();
    const tool = randomUUID();
    const before = tablet.pushes("changed").length;
    expect(await server.ask({ type: "write", id: id(), kind: "basket", globalId: basket, localId: null, fields: { name: "Skin 18 g" } })).toMatchObject({ type: "written" });
    expect(await server.ask({ type: "write", id: id(), kind: "tool", globalId: tool, localId: null, fields: { name: "Skin WDT" } })).toMatchObject({ type: "written" });
    const basketId = String((dye2List(tablet, "baskets") as Record_[]).find((record) => record[GLOBAL_ID_KEY] === basket)?.id);
    expect(await server.ask({ type: "remove", id: id(), kind: "basket", globalId: basket, localId: basketId })).toMatchObject({ type: "removed" });
    expect(posts()).toBe(postsBefore + 3);
    expect(tablet.pushes("changed").length).toBe(before);
    expect((await tablet.callApi("GET", BASKETS)).body).toEqual([]);
  });

  it("answers a write as it would have when Decaid refuses the push, and logs why", async () => {
    await holdRecipes([]);
    tablet.failEmits = new Error("PluginPermissionError: Plugin decent-sync.reaplugin requires manifest permission emit");
    const pushed = tablet.emits.length;
    const globalId = randomUUID();
    try {
      const answer = await server.ask(write({ id: "5", name: "Unheard" }, globalId));
      expect(answer).toMatchObject({ type: "written", globalId, record: { id: "5", name: "Unheard", [GLOBAL_ID_KEY]: globalId } });
    } finally {
      tablet.failEmits = undefined;
    }
    expect(recipes()).toEqual([expect.objectContaining({ id: "5", name: "Unheard" })]);
    expect(tablet.emits.length).toBe(pushed);
    await tablet.waitForLog(/^Could not tell skins that DYE2's recipes changed: PluginPermissionError: .* requires manifest permission emit$/);
    // The next write is told of again.
    expect((await pushesFor(write({ name: "Heard" }, globalId, "5", { name: "Unheard" }))).pushes).toEqual([PUSH]);
  });
});

describe("Telling skins of Recipes changed in the management interface", { timeout: 90_000 }, () => {
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };
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

  function load(machine: CreatedMachine, serial: number, instance: TestServer): SimulatedTablet {
    return tablets.syncing(machine, instance, { api: emptyLibrary(serial) });
  }

  const slots = (tablet: SimulatedTablet) => ((dye2List(tablet, "recipes") ?? []) as Record_[]).map((record) => `${String(record.id)}:${String(record.name)}`);

  it("pushes on each tablet at the Location as a Recipe is created, edited, moved and taken out of its slot there, and not for a Basket", async () => {
    const location: LocationView = await api.createLocation("Skin lab", "America/Chicago");
    const elsewhere: LocationView = await api.createLocation("Skin cafe", "America/Chicago");
    const lab = [await api.createMachine("Skin lab 1", location.id), await api.createMachine("Skin lab 2", location.id)];
    const cafeMachine = await api.createMachine("Skin cafe 1", elsewhere.id);
    const here = [load(lab[0]!, 46002, server), load(lab[1]!, 46003, other)];
    const cafe = load(cafeMachine, 46004, server);
    await api.waitForOnline(...lab, cafeMachine);
    const pushes = () => here.map((tablet) => tablet.pushes("changed").length);

    /** Waits until each tablet at the Location holds `expected`, and has pushed at least `count` times since `before`. */
    const pushedOnEach = async (before: number[], expected: string[], count = 1) => {
      for (const tablet of here) await expect.poll(() => slots(tablet)).toEqual(expected);
      await expect.poll(() => pushes().every((pushed, index) => pushed - before[index]! >= count)).toBe(true);
    };

    let before = pushes();
    const created = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: location.id, slot: 1, content: { name: "Skin espresso" } }, 201)).recipe;
    await pushedOnEach(before, ["1:Skin espresso"]);

    before = pushes();
    await api.send("PATCH", `/recipes/${created.id}`, { content: { name: "Skin ristretto" } });
    await pushedOnEach(before, ["1:Skin ristretto"]);

    before = pushes();
    // Removed from slot 1, then written in slot 3, each pushed.
    await api.send("PUT", `/recipes/${created.id}/slot`, { slot: 3 });
    await pushedOnEach(before, ["3:Skin ristretto"], 2);

    before = pushes();
    await api.send("PUT", `/recipes/${created.id}/slot`, { slot: null });
    await pushedOnEach(before, []);

    before = pushes();
    const basket = (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: location.id, content: { name: "Skin 20 g" } }, 201)).basket;
    for (const tablet of here) await expect.poll(() => ((dye2List(tablet, "baskets") ?? []) as Record_[]).some((record) => record[GLOBAL_ID_KEY] === basket.id)).toBe(true);
    expect(pushes()).toEqual(before);
    for (const tablet of here) expect(new Set(tablet.pushes("changed").map((push) => JSON.stringify(push)))).toEqual(new Set([JSON.stringify(PUSH)]));
    // No Recipe was ever at the cafe.
    expect(cafe.pushes("changed")).toEqual([]);
  });
});
