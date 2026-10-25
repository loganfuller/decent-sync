import { randomUUID } from "node:crypto";
import {
  ANOTHER_ITEMS_RECORD,
  DYE2_RECIPE_FIELD,
  GLOBAL_ID_KEY,
  LOADED_RECIPE_KIND,
  RECORD_CHANGED,
  type ServerMessage,
  WORKFLOW_BASKET,
  WORKFLOW_BATCH,
  WORKFLOW_GRINDER,
  WORKFLOW_KIND,
  dye2RecipeIdOf,
} from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2Library, dye2List } from "./support/simulated-dye2.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { type SimulatedTablet, settingsFor } from "./support/simulated-tablet.js";
import { StandInServer } from "./support/stand-in-server.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Ticket #168: the plugin tells the skins listening on its `changed`
// endpoint, as Streamline's dashboard does, each time it has written DYE2's
// recipes, so a dashboard left visible shows the change (ADR-0005). Ticket
// #207: and each time it has changed the Workflow, by the server's writes of
// a Loaded Recipe, its unloads, which clear the Workflow's `recipeId`, and its
// clears of the Workflow's Grinder, Bean Batch and Basket, and by its own
// loads of the recipe the Workflow names (ticket #216), so Streamline's tiles
// and strip show the change at once rather than at their 20 s poll. A
// Recipe's record keeps its id as it moves between slots, only its
// `stripSlot` written (#216). Through the
// built plugin in simulated tablets: against a stand-in server for each
// kind of write and for the writes that post or change nothing, as the real
// server reaches most of those only in a race, and against two server
// instances sharing PostgreSQL for Recipes changed in the management
// interface. Serials are made up, from 46001.

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

  it("pushes once after each write that posts the recipes: a create, an update, a move between slots, one out of its slot, a removal, a set-aside and a hard delete", async () => {
    await holdRecipes([]);
    const espresso = randomUUID();
    // Under an opaque record id, as DYE2's editor gives one.
    const record = randomUUID();
    const created = await pushesFor(write({ id: record, name: "Espresso", "dashboardVariables.dose": 18, stripSlot: 1 }, espresso));
    expect(created.answer).toMatchObject({ type: "written", globalId: espresso });
    expect(created.pushes).toEqual([PUSH]);
    expect(recipes()).toEqual([expect.objectContaining({ id: record, name: "Espresso", stripSlot: 1, [GLOBAL_ID_KEY]: espresso })]);

    const updated = await pushesFor(write({ "dashboardVariables.dose": 19 }, espresso, record, { "dashboardVariables.dose": 18 }));
    expect(updated.answer).toMatchObject({ type: "written", writtenFields: ["dashboardVariables.dose"] });
    expect(updated.pushes).toEqual([PUSH]);

    // A Recipe moved keeps its record and id: only its slot is written, taken from the slot's previous holder in the same post.
    const holder = randomUUID();
    await holdRecipes([...recipes(), { id: "recipe-held2", name: "Held in 2", stripSlot: 2, [GLOBAL_ID_KEY]: holder }]);
    const moved = await pushesFor(write({ stripSlot: 2 }, espresso, record, { stripSlot: 1 }));
    expect(moved.answer).toMatchObject({ type: "written", writtenFields: ["stripSlot"] });
    expect(moved.pushes).toEqual([PUSH]);
    expect(recipes().map((held) => [held.id, held.stripSlot])).toEqual([
      [record, 2],
      ["recipe-held2", null],
    ]);

    // Taken out of its slot, it stays in DYE2's library.
    const unslotted = await pushesFor(write({ stripSlot: null }, espresso, record, { stripSlot: 2 }));
    expect(unslotted.answer).toMatchObject({ type: "written", writtenFields: ["stripSlot"] });
    expect(unslotted.pushes).toEqual([PUSH]);
    expect(recipes()[0]).toMatchObject({ id: record, stripSlot: null });

    // Archived, or of another Location.
    const removed = await pushesFor({ type: "remove", id: id(), kind: "recipe", globalId: holder, localId: "recipe-held2" });
    expect(removed.answer).toMatchObject({ type: "removed" });
    expect(removed.pushes).toEqual([PUSH]);

    // A joining Machine's own recipe the Library leaves out.
    await holdRecipes([{ id: "3", name: "Own", stripSlot: 3 }]);
    const setAside = await pushesFor({ type: "leaveOut", id: id(), kind: "recipe", localId: "3" });
    expect(setAside.answer).toMatchObject({ type: "leftOut", outcome: "setAside" });
    expect(setAside.pushes).toEqual([PUSH]);

    const doomed = randomUUID();
    await holdRecipes([{ id: "recipe-doomed", name: "Doomed", stripSlot: null, [GLOBAL_ID_KEY]: doomed }]);
    const deleted = await pushesFor({ type: "delete", id: id(), kind: "recipe", globalId: doomed, localId: "recipe-doomed" });
    expect(deleted.answer).toMatchObject({ type: "deleted" });
    expect(deleted.pushes).toEqual([PUSH]);
    expect(recipes()).toEqual([]);
  });

  it("pushes nothing for a write Decaid or the plugin refuses", async () => {
    const mine = randomUUID();
    const other = randomUUID();

    tablet.failNextApiReads(RECIPES, 1);
    const refusedRead = await pushesFor(write({ id: "recipe-unread", name: "Unread" }, mine));
    expect(refusedRead.answer).toMatchObject({ type: "writeRefused", status: 503 });
    expect(refusedRead.pushes).toEqual([]);

    tablet.refuseWrites = ({ method, route }) => (method === "POST" && route === RECIPES ? { status: 500, body: { error: "Disk full" } } : undefined);
    const refusedPost = await pushesFor(write({ id: "recipe-unposted", name: "Unposted" }, mine));
    tablet.refuseWrites = undefined;
    expect(refusedPost.answer).toMatchObject({ type: "writeRefused", status: 500 });
    expect(refusedPost.pushes).toEqual([]);

    // Two records under one id: a list in a shape not recognised.
    await holdRecipes([
      { id: "espresso", name: "One" },
      { id: "espresso", name: "Two" },
    ]);
    for (const request of [
      write({ id: "recipe-unrecognised", name: "Unrecognised" }, mine),
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

    await holdRecipes([{ id: "recipe-another", name: "Another's", [GLOBAL_ID_KEY]: other }]);
    const idTaken = await pushesFor(write({ id: "recipe-another", name: "Mine" }, mine));
    expect(idTaken.answer).toMatchObject({ type: "writeRefused", error: "The record recipe-another is another item's" });
    expect(idTaken.pushes).toEqual([]);

    const missing = await pushesFor(write({ name: "Gone" }, mine, "recipe-gone", { name: "Here" }));
    expect(missing.answer).toMatchObject({ type: "writeRefused", status: 404, error: "Record not found" });
    expect(missing.pushes).toEqual([]);

    for (const request of [
      { type: "remove", id: id(), kind: "recipe", globalId: mine, localId: "recipe-another" } as const,
      { type: "delete", id: id(), kind: "recipe", globalId: mine, localId: "recipe-another" } as const,
    ]) {
      const anotherItems = await pushesFor(request);
      expect(anotherItems.answer).toMatchObject({ type: "writeRefused", error: ANOTHER_ITEMS_RECORD });
      expect(anotherItems.pushes).toEqual([]);
    }

    await holdRecipes([{ id: "recipe-mine", name: "Changed on the tablet", [GLOBAL_ID_KEY]: mine }]);
    const changed = await pushesFor({
      type: "remove",
      id: id(),
      kind: "recipe",
      globalId: mine,
      localId: "recipe-mine",
      expected: { id: "recipe-mine", name: "As reported", [GLOBAL_ID_KEY]: mine },
    });
    expect(changed.answer).toMatchObject({ type: "writeRefused", error: RECORD_CHANGED });
    expect(changed.pushes).toEqual([]);
    expect(recipes()).toEqual([{ id: "recipe-mine", name: "Changed on the tablet", [GLOBAL_ID_KEY]: mine }]);
  });

  it("pushes nothing for a write that changes nothing, and so posts nothing", async () => {
    const held = randomUUID();
    await holdRecipes([
      { id: "recipe-held", name: "Held", stripSlot: 1, [GLOBAL_ID_KEY]: held },
      { id: "recipe-taken", name: "Taken", stripSlot: null, [GLOBAL_ID_KEY]: randomUUID() },
    ]);
    const posts = () => tablet.storeWrites.filter((written) => written.key === "recipes").length;
    const postsBefore = posts();
    for (const request of [
      // Made by a write whose answer was lost.
      write({ id: "recipe-held", name: "Held", stripSlot: 1 }, held),
      // Set to what it holds, its slot included.
      write({ name: "Held" }, held, "recipe-held", { name: "Held" }),
      write({ stripSlot: 1 }, held, "recipe-held", { stripSlot: 1 }),
      // Changed on the tablet since, which the write leaves as it is.
      write({ name: "Renamed" }, held, "recipe-held", { name: "As reported" }),
      // Gone already.
      { type: "remove", id: id(), kind: "recipe", globalId: held, localId: "recipe-gone" } as const,
      { type: "delete", id: id(), kind: "recipe", globalId: held, localId: "recipe-gone" } as const,
      { type: "leaveOut", id: id(), kind: "recipe", localId: "recipe-gone" } as const,
      // A Library item's now.
      { type: "leaveOut", id: id(), kind: "recipe", localId: "recipe-taken" } as const,
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
      const answer = await server.ask(write({ id: "recipe-unheard", name: "Unheard" }, globalId));
      expect(answer).toMatchObject({ type: "written", globalId, record: { id: "recipe-unheard", name: "Unheard", [GLOBAL_ID_KEY]: globalId } });
    } finally {
      tablet.failEmits = undefined;
    }
    expect(recipes()).toEqual([expect.objectContaining({ id: "recipe-unheard", name: "Unheard" })]);
    expect(tablet.emits.length).toBe(pushed);
    await tablet.waitForLog(/^Could not tell skins that DYE2's recipes changed: PluginPermissionError: .* requires manifest permission emit$/);
    // The next write is told of again.
    expect((await pushesFor(write({ name: "Heard" }, globalId, "recipe-unheard", { name: "Unheard" }))).pushes).toEqual([PUSH]);
  });
});

describe("Telling skins of each write of the server's into the Workflow", () => {
  let server: StandInServer;
  let tablet: SimulatedTablet;
  let asked = 0;
  const recipe = randomUUID();
  /** The record id of the recipe the Workflow names. */
  const NAMED = "recipe-skin-workflow";

  /** Names the recipe in the Workflow, as Streamline's strip does as it applies it (`recipeIdPatch`). */
  const name = (recordId: string) => tablet.changeSettings({ context: { extras: { dye: { v: 1, recipeId: recordId } } } });

  beforeAll(async () => {
    server = await StandInServer.start();
    // Without DYE2, which answers 404, so nothing else changes the recipe the Workflow names.
    tablet = tablets.load({ settings: settingsFor({ token: "stand-in token 46005", serverUrl: server.url }), api: emptyLibrary(46005) });
    await server.welcomed();
    await name(NAMED);
  });
  afterAll(() => server?.stop());

  const id = () => `skin-workflow-${++asked}`;
  const context = () => tablet.workflow().context as Record_;
  /** The server's write of its Loaded Recipe into the Workflow, setting `fields` where it holds `expected`, while the Workflow names the recipe's record. */
  const loaded = (fields: Record_, expected: Record_ = {}): ServerMessage & { id: string } => ({
    type: "write",
    id: id(),
    kind: LOADED_RECIPE_KIND,
    globalId: recipe,
    localId: null,
    fields,
    expected: { [DYE2_RECIPE_FIELD]: NAMED, ...expected },
  });
  /** The server's clear of each group of the Workflow's fields whose id it holds as `expected`, as its Machine joins a Location. */
  const clear = (expected: Record_): ServerMessage & { id: string } => {
    const groups = [WORKFLOW_GRINDER, WORKFLOW_BATCH, WORKFLOW_BASKET].filter(([first]) => first in expected);
    return { type: "write", id: id(), kind: WORKFLOW_KIND, globalId: randomUUID(), localId: null, fields: Object.fromEntries(groups.flat().map((field) => [field, null])), expected };
  };
  const workflowPuts = () => tablet.writes.filter((write) => write === "PUT /workflow").length;
  const refusePuts = () => {
    tablet.refuseWrites = ({ method, route }) => (method === "PUT" && route === "/workflow" ? { status: 500, body: { error: "Internal server error", message: "Disk full" } } : undefined);
  };

  /** Asks the plugin, and resolves with its answer, the pushes the request led to, and the Workflow the tablet held as each was made. */
  async function pushesFor(request: ServerMessage & { id: string }): Promise<{ answer: Record_; pushes: unknown[]; held: Record_[] }> {
    const before = tablet.pushes("changed").length;
    const held: Record_[] = [];
    tablet.onEmit = () => held.push(structuredClone(tablet.workflow()));
    try {
      const answer = await server.ask(request);
      return { answer, pushes: tablet.pushes("changed").slice(before), held };
    } finally {
      tablet.onEmit = undefined;
    }
  }

  it("pushes once after a Loaded Recipe write Decaid takes, with the Workflow holding what it wrote", async () => {
    const { answer, pushes, held } = await pushesFor(loaded({ "context.targetDoseWeight": 19, "context.targetYield": 40 }, { "context.targetDoseWeight": 18, "context.targetYield": 36 }));
    expect(answer).toMatchObject({ type: "written", kind: LOADED_RECIPE_KIND, writtenFields: ["context.targetDoseWeight", "context.targetYield"] });
    expect(pushes).toEqual([PUSH]);
    expect(held).toEqual([expect.objectContaining({ context: expect.objectContaining({ targetDoseWeight: 19, targetYield: 40 }) })]);
  });

  it("pushes once after a Loaded Recipe write changing the profile, made as two writes, with the Workflow naming the recipe", async () => {
    const adaptive = (dye2Library()["/profiles"] as Record_[]).find((profile) => profile.id === "profile:98fa00c191551b435845")!.profile as Record_;
    const puts = workflowPuts();
    const { answer, pushes, held } = await pushesFor(loaded({ profile: adaptive }));
    expect(answer).toMatchObject({ type: "written", kind: LOADED_RECIPE_KIND, writtenFields: ["profile"] });
    expect(workflowPuts()).toBe(puts + 2);
    expect(pushes).toEqual([PUSH]);
    expect(held).toHaveLength(1);
    expect(dye2RecipeIdOf(held[0])).toBe(NAMED);
    expect((held[0]!.profile as Record_).title).toBe("Adaptive v3");
  });

  it("pushes once after a Loaded Recipe write unloading the Recipe, and nothing for one that leaves the Workflow as it was, that Decaid refuses, or that the Workflow names another recipe for", async () => {
    // Held already, as after a write whose answer was lost: written again, so its answer has the server hold it, changing nothing.
    const puts = workflowPuts();
    const held = await pushesFor(loaded({ "context.targetDoseWeight": 19 }, { "context.targetDoseWeight": 18 }));
    expect(held.answer).toMatchObject({ type: "written", writtenFields: ["context.targetDoseWeight"] });
    expect(workflowPuts()).toBe(puts + 1);
    expect(held.pushes).toEqual([]);

    // Changed on the tablet since, which the write leaves as it is: nothing is written.
    const changed = await pushesFor(loaded({ "context.targetDoseWeight": 21 }, { "context.targetDoseWeight": 17 }));
    expect(changed.answer).toMatchObject({ type: "written", writtenFields: [] });
    expect(changed.pushes).toEqual([]);

    refusePuts();
    try {
      const refused = await pushesFor(loaded({ "context.targetDoseWeight": 21 }, { "context.targetDoseWeight": 19 }));
      expect(refused.answer).toMatchObject({ type: "writeRefused", status: 500 });
      expect(refused.pushes).toEqual([]);
    } finally {
      tablet.refuseWrites = undefined;
    }

    // An unload clears the recipe the Workflow names, as DYE2 does, and nothing else.
    const puts2 = workflowPuts();
    const unloaded = await pushesFor(loaded({ [DYE2_RECIPE_FIELD]: null }));
    expect(unloaded.answer).toMatchObject({ type: "written", writtenFields: [DYE2_RECIPE_FIELD] });
    expect(unloaded.pushes).toEqual([PUSH]);
    expect(workflowPuts()).toBe(puts2 + 1);
    expect(dye2RecipeIdOf(tablet.workflow())).toBeNull();
    expect(context()).toMatchObject({ targetDoseWeight: 19, targetYield: 40 });

    // With another recipe named, or none, an unload writes nothing, and a write of the Loaded Recipe is refused.
    await name("recipe-applied-since");
    const puts3 = workflowPuts();
    const notNamed = await pushesFor(loaded({ [DYE2_RECIPE_FIELD]: null }));
    expect(notNamed.answer).toMatchObject({ type: "written", writtenFields: [] });
    expect(notNamed.pushes).toEqual([]);
    const another = await pushesFor(loaded({ "context.targetDoseWeight": 21 }, { "context.targetDoseWeight": 19 }));
    expect(another.answer).toMatchObject({ type: "writeRefused", error: expect.stringContaining("names another recipe") });
    expect(another.pushes).toEqual([]);
    expect(workflowPuts()).toBe(puts3);
    await name(NAMED);
  });

  it("pushes once after a clear of the Workflow's Grinder, Bean Batch and Basket that clears something, and nothing for one that clears nothing or that Decaid refuses", async () => {
    const { grinderId } = context();
    const { basketId } = context().extras as Record_;
    expect([grinderId, basketId]).toEqual([expect.any(String), expect.any(String)]);

    refusePuts();
    try {
      const refused = await pushesFor(clear({ "context.grinderId": grinderId }));
      expect(refused.answer).toMatchObject({ type: "writeRefused", status: 500 });
      expect(refused.pushes).toEqual([]);
    } finally {
      tablet.refuseWrites = undefined;
    }

    // The Workflow names another Grinder now.
    const puts = workflowPuts();
    const other = await pushesFor(clear({ "context.grinderId": randomUUID() }));
    expect(other.answer).toMatchObject({ type: "written", writtenFields: [] });
    expect(other.pushes).toEqual([]);
    expect(workflowPuts()).toBe(puts);

    const cleared = await pushesFor(clear({ "context.grinderId": grinderId, "context.extras.basketId": basketId }));
    expect(cleared.answer).toMatchObject({ type: "written", writtenFields: [...WORKFLOW_GRINDER, ...WORKFLOW_BASKET] });
    expect(cleared.pushes).toEqual([PUSH]);
    expect(cleared.held).toHaveLength(1);
    const clearedContext = cleared.held[0]!.context as Record_;
    // Decaid drops a field of the context merged in as null, and keeps a key of its extras as null.
    expect(clearedContext).not.toHaveProperty("grinderId");
    expect((clearedContext.extras as Record_).basketId ?? null).toBeNull();
  });

  it("answers each write as it would have when Decaid refuses the push, and logs why", async () => {
    const { beanBatchId } = context();
    expect(beanBatchId).toEqual(expect.any(String));
    tablet.failEmits = new Error("PluginPermissionError: Plugin decent-sync.reaplugin requires manifest permission emit");
    const pushed = tablet.emits.length;
    try {
      expect(await server.ask(loaded({ "context.targetYield": 44 }, { "context.targetYield": 40 }))).toMatchObject({
        type: "written",
        writtenFields: ["context.targetYield"],
        record: { context: expect.objectContaining({ targetYield: 44 }) },
      });
      expect(await server.ask(clear({ "context.beanBatchId": beanBatchId }))).toMatchObject({ type: "written", writtenFields: [...WORKFLOW_BATCH] });
    } finally {
      tablet.failEmits = undefined;
    }
    expect(context().targetYield).toBe(44);
    expect(context()).not.toHaveProperty("beanBatchId");
    expect(tablet.emits.length).toBe(pushed);
    await tablet.waitForLogs(/^Could not tell skins that the Workflow changed: PluginPermissionError: .* requires manifest permission emit$/, 2);
    // The next write is told of again.
    expect((await pushesFor(loaded({ "context.targetYield": 45 }, { "context.targetYield": 44 }))).pushes).toEqual([PUSH]);
  });

  // Last: the machine coming back has the plugin reconnect.
  it("pushes once after a Loaded Recipe write retried without its steam, hot water and flush settings, as no machine is connected, and not for the attempt Decaid refused", async () => {
    tablet.machineConnected = false;
    try {
      const puts = workflowPuts();
      const { answer, pushes, held } = await pushesFor(loaded({ "context.targetDoseWeight": 20, "steamSettings.duration": 60 }, { "context.targetDoseWeight": 19, "steamSettings.duration": 120 }));
      expect(answer).toMatchObject({ type: "written", writtenFields: ["context.targetDoseWeight"] });
      expect(workflowPuts()).toBe(puts + 2);
      expect(pushes).toEqual([PUSH]);
      expect(held).toEqual([expect.objectContaining({ context: expect.objectContaining({ targetDoseWeight: 20 }), steamSettings: expect.objectContaining({ duration: 120 }) })]);
    } finally {
      tablet.connectMachine();
    }
  });
});

describe("Telling skins of each load of a recipe the Workflow names", () => {
  let server: StandInServer;
  let tablet: SimulatedTablet;
  const [one, two, three] = [randomUUID(), randomUUID(), randomUUID()];
  /** The records' ids, opaque as DYE2's editor gives them. */
  const [ONE, TWO, THREE] = ["recipe-skin-load-20", "recipe-skin-load-18", "recipe-skin-load-22"];

  beforeAll(async () => {
    server = await StandInServer.start();
    // Timers ten times faster: the plugin polls every 0.5 s.
    tablet = tablets.load({
      settings: { ...settingsFor({ token: "stand-in token 46006", serverUrl: server.url }), PollSeconds: 5 },
      timeScale: 10,
      api: {
        ...emptyLibrary(46006),
        [RECIPES]: [
          { id: ONE, name: "Skin load 20 g", stripSlot: 1, [GLOBAL_ID_KEY]: one, dashboardVariables: { dose: 20 } },
          { id: TWO, name: "Skin load 18 g", stripSlot: 2, [GLOBAL_ID_KEY]: two, dashboardVariables: { dose: 18 } },
          { id: THREE, name: "Skin load 22 g", stripSlot: null, [GLOBAL_ID_KEY]: three, dashboardVariables: { dose: 22 } },
        ],
      },
      dye2: new SimulatedDye2(),
    });
    await server.welcomed();
  });
  afterAll(() => server?.stop());

  const dose = () => (tablet.workflow().context as Record_).targetDoseWeight;
  /** Names the recipe in the Workflow through DYE2's selection route, as Streamline's strip does once it has applied it, here without applying it. */
  const select = async (recordId: string) => expect((await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: recordId })).status).toBe(200);
  /** How many times the plugin read the Workflow, as each load does before it writes. */
  const workflowReads = () => tablet.requests.filter((route) => route === "/workflow").length - tablet.writes.filter((write) => write === "PUT /workflow").length;
  /** How many times the plugin wrote into the Workflow, as each load that writes does once. */
  const workflowPuts = () => tablet.writes.filter((write) => write === "PUT /workflow").length;

  /** Runs `work`, and resolves with the pushes made meanwhile and the Workflow the tablet held as each was made. */
  async function pushesDuring(work: () => Promise<void>): Promise<{ pushes: unknown[]; held: Record_[] }> {
    const before = tablet.pushes("changed").length;
    const held: Record_[] = [];
    tablet.onEmit = () => held.push(structuredClone(tablet.workflow()));
    try {
      await work();
      return { pushes: tablet.pushes("changed").slice(before), held };
    } finally {
      tablet.onEmit = undefined;
    }
  }

  it("pushes once after a load's write Decaid takes, with the Workflow holding what it wrote, and nothing for a load the Workflow holds already", async () => {
    const { pushes, held } = await pushesDuring(async () => {
      // The 18 g recipe's dose is the Workflow's, so its load writes nothing.
      const reads = workflowReads();
      const puts = workflowPuts();
      await select(TWO);
      await expect.poll(workflowReads).toBeGreaterThan(reads);
      await tablet.dye2!.settled();
      expect(workflowPuts()).toBe(puts);
      await select(ONE);
      await expect.poll(workflowPuts).toBe(puts + 1);
      await expect.poll(dose).toBe(20);
    });
    expect(pushes).toEqual([PUSH]);
    expect(held).toEqual([expect.objectContaining({ context: expect.objectContaining({ targetDoseWeight: 20 }) })]);

    // A Loaded Recipe write for the 18 g recipe while the Workflow names the 20 g one is refused, and pushes nothing.
    const before = tablet.pushes("changed").length;
    const refused = await server.ask({
      type: "write",
      id: "skin-load-1",
      kind: LOADED_RECIPE_KIND,
      globalId: two,
      localId: null,
      fields: { "context.targetYield": 40 },
      expected: { "context.targetYield": 36, [DYE2_RECIPE_FIELD]: TWO },
    });
    expect(refused).toMatchObject({ type: "writeRefused", error: expect.stringContaining("names another recipe") });
    expect(tablet.pushes("changed").length).toBe(before);
  });

  it("pushes nothing for a load's write Decaid refuses, and once for the next load Decaid takes, of a recipe in no slot", async () => {
    tablet.refuseWrites = ({ method, route }) => (method === "PUT" && route === "/workflow" ? { status: 500, body: { error: "Internal server error", message: "Disk full" } } : undefined);
    const refused = await pushesDuring(async () => {
      await select(THREE);
      await tablet.waitForLog(new RegExp(`^The Loaded Recipe could not be followed: Decaid answered 500 loading the recipe ${THREE}`));
    });
    tablet.refuseWrites = undefined;
    expect(refused.pushes).toEqual([]);
    expect(dose()).toBe(20);

    const puts = workflowPuts();
    const again = await pushesDuring(async () => {
      await select(TWO);
      await expect.poll(workflowPuts).toBe(puts + 1);
      await expect.poll(dose).toBe(18);
    });
    expect(again.pushes).toEqual([PUSH]);
    expect(again.held).toEqual([expect.objectContaining({ context: expect.objectContaining({ targetDoseWeight: 18 }) })]);
  });

  it("loads as it would have when Decaid refuses the push, and logs why", async () => {
    tablet.failEmits = new Error("PluginPermissionError: Plugin decent-sync.reaplugin requires manifest permission emit");
    const pushed = tablet.emits.length;
    const logged = tablet.logs.filter((log) => log.startsWith("Could not tell skins that the Workflow changed")).length;
    try {
      const puts = workflowPuts();
      await select(ONE);
      await expect.poll(workflowPuts).toBe(puts + 1);
    } finally {
      tablet.failEmits = undefined;
    }
    expect(dose()).toBe(20);
    expect(tablet.emits.length).toBe(pushed);
    await tablet.waitForLogs(/^Could not tell skins that the Workflow changed: PluginPermissionError: .* requires manifest permission emit$/, logged + 1);
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

  /** Each of the tablet's recipes as its name and strip slot. */
  const slots = (tablet: SimulatedTablet) => ((dye2List(tablet, "recipes") ?? []) as Record_[]).map((record) => `${String(record.name)}:${String(record.stripSlot)}`);

  it("pushes on each tablet at the Location as a Recipe is created, edited, moved, taken out of its slot and Archived there, and not for a Basket", async () => {
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
    await pushedOnEach(before, ["Skin espresso:1"]);
    // Under the same record id on each.
    const ids = () => here.map((tablet) => ((dye2List(tablet, "recipes") ?? []) as Record_[]).map((record) => record.id));
    expect(new Set(ids().flat()).size).toBe(1);

    before = pushes();
    await api.send("PATCH", `/recipes/${created.id}`, { content: { name: "Skin ristretto" } });
    await pushedOnEach(before, ["Skin ristretto:1"]);

    before = pushes();
    // Its record keeps its id, and only its slot is written.
    await api.send("PUT", `/recipes/${created.id}/slot`, { slot: 3 });
    await pushedOnEach(before, ["Skin ristretto:3"]);

    before = pushes();
    // Out of its slot, it stays on each tablet, in DYE2's library.
    await api.send("PUT", `/recipes/${created.id}/slot`, { slot: null });
    await pushedOnEach(before, ["Skin ristretto:null"]);
    expect(new Set(ids().flat()).size).toBe(1);

    before = pushes();
    await api.send("PUT", `/recipes/${created.id}/archived`, { archived: true });
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
