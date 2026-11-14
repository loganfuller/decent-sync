import { GLOBAL_ID_KEY, RECIPE_SHOWN_FIELD, RECIPE_SLOT_FIELD, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, openDye2RecipeEditor, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for tickets #506 and #502: a Recipe Slot is a whole number from 1
// to 9 wherever one is read or named. A tablet's record whose `stripSlot` is
// 6 to 9 moves its Recipe into that slot at its Location, by the rules a move
// into 1 to 5 follows, and the Recipe is written to the Location's other
// tablets with its `stripSlot`, the plugin taking the slot from any other
// record holding it in the same post (#506). A request names any of the nine
// through REST and the MCP endpoint, swapping with or displacing the Recipe
// there as in 1 to 5, and `next` gives the lowest free of the nine (#502); a
// Recipe in 6 to 9 is shown in its slot, taken out of it, Archived and
// restored as any other.
//
// Nothing in DYE2 or Streamline places a recipe in 6 to 9, so a record is put
// there as another app on the tablet may, such as a Skin with nine buttons
// (#503): the list read, the record's `stripSlot` set, and the list posted.
// What DYE2 v0.1.36 and Streamline v0.2.24 then do with it is as run for the
// ticket on Decaid v0.9.1. Through the built plugin in simulated tablets, on
// two server instances sharing one database. Serials are made up, from
// 50601.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  name: string | null;
  slot: number | null;
  archived: boolean;
  content: Record_;
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The record id of the recording's recipe in no slot (fixtures/decaid/dye2-v0.1.26/recipes.json, `Fixture Library Recipe`). */
const LIBRARY_RECIPE = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";

describe("Recipe Slots 6 to 9 are read, kept and assigned", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
  });
  afterAll(async () => {
    await assistant?.close();
    await app?.close();
    await server?.stop();
  });

  const recipesAt = async (location: LocationView) => (await api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`)).recipes;
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const slotOf = async (id: string) => (await recipe(id)).slot;
  const versions = async (id: string) => (await api.get<{ versions: { fields: Record_; source: { machine: { name: string } | null } }[] }>(`/recipes/${id}/history`)).versions;
  const create = async (location: LocationView, slot: number | "next" | null, name: string) =>
    (await api.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId: location.id, slot, content: { name, dose: 18, yield: 36 } }, 201)).recipe;
  /** The tablet's recipe records, as its store holds them. */
  const records = (tablet: SimulatedTablet): Record_[] => {
    const value = dye2List(tablet, "recipes");
    return Array.isArray(value) ? (value as Record_[]) : [];
  };
  /** The tablet's recipe record carrying the Recipe's global id. */
  const recordOf = (tablet: SimulatedTablet, recipeId: string) => records(tablet).find((record) => record[GLOBAL_ID_KEY] === recipeId);
  /** The slot and whether it is shown of the tablet's record of each Recipe. */
  const held = (tablet: SimulatedTablet, ...recipeIds: string[]) => recipeIds.map((id) => [recordOf(tablet, id)?.[RECIPE_SLOT_FIELD], recordOf(tablet, id)?.[RECIPE_SHOWN_FIELD]]);
  /** Waits until the Machine's tablet is due nothing, so that a change of its list races none of the plugin's writes (ADR-0005). */
  const synced = (machine: CreatedMachine) =>
    expect.poll(async () => (await api.get<{ status: { waiting: number | null } }>(`/machines/${machine.machine.id}/sharing-status`)).status.waiting).toBe(0);
  /**
   * Puts the tablet's record of the Recipe in a slot as another app on the tablet may: the list read, the record's
   * `stripSlot` set and shown, the slot taken from any other record holding it, as DYE2's `takeSlot` does, and the
   * list posted.
   */
  async function placeOnTablet(tablet: SimulatedTablet, recipeId: string, slot: number): Promise<void> {
    const route = `/store/${DYE2_NAMESPACE}/recipes`;
    const list = (await tablet.callApi("GET", route)).body as Record_[];
    const placed = list.map((record) =>
      record[GLOBAL_ID_KEY] === recipeId
        ? { ...record, [RECIPE_SLOT_FIELD]: slot, [RECIPE_SHOWN_FIELD]: true, capturedAt: new Date().toISOString() }
        : record[RECIPE_SLOT_FIELD] === slot
          ? { ...record, [RECIPE_SLOT_FIELD]: null }
          : record,
    );
    expect((await tablet.callApi("POST", route, placed)).status).toBe(200);
  }
  /** What a tool refuses a call with. */
  async function toolError(name: string, args: Record_): Promise<string> {
    const result = await assistant.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }
  /** The REST API's refusal of a request, with the status, as its message. */
  async function restRefusal(method: string, path: string, body: unknown, status: number): Promise<string> {
    const response = await api.call(method, path, body);
    expect(response.status, path).toBe(status);
    return ((await response.json()) as { message: string }).message;
  }

  it("moves a Recipe into slot 7 as a tablet's record is put there, the Recipe there leaving it, and writes it to the Location's other tablet with stripSlot 7, taking the slot from the record holding it in the same post", async () => {
    const here = await api.createLocation("Seven lab", "America/Chicago");
    const machines = [await api.createMachine("Seven lab 1", here.id), await api.createMachine("Seven lab 2", here.id)] as const;
    const one = syncingTablet(machines[0], server, { api: dye2NeverUsed("50601") });
    const two = syncingTablet(machines[1], other, { api: dye2NeverUsed("50602") });
    await api.waitForOnline(...machines);
    const first = await create(here, 1, "Seven first");
    const second = await create(here, 2, "Seven second");
    for (const tablet of [one, two]) {
      await expect.poll(() => held(tablet, first.id, second.id)).toEqual([
        [1, true],
        [2, true],
      ]);
    }

    // The first tablet's record of the first Recipe is put in slot 7: the Recipe moves there, a version from that tablet.
    await synced(machines[0]);
    await placeOnTablet(one, first.id, 7);
    await expect.poll(() => slotOf(first.id)).toBe(7);
    expect((await versions(first.id))[0]).toMatchObject({ fields: { slot: 7 }, source: { machine: { name: "Seven lab 1" } } });
    expect((await recipesAt(here)).map(({ name, slot }) => [name, slot])).toEqual([
      ["Seven second", 2],
      ["Seven first", 7],
    ]);
    // The other tablet's record of it is written its stripSlot, shown, under the same id.
    await expect.poll(() => held(two, first.id, second.id)).toEqual([
      [7, true],
      [2, true],
    ]);
    expect(recordOf(two, first.id)!.id).toBe(recordOf(one, first.id)!.id);

    // The second Recipe's record is put in slot 7 on the first tablet: it takes the slot, and the Recipe there leaves it,
    // kept at the Location in none, each a version from that tablet, as a move into slots 1 to 5 goes.
    await synced(machines[0]);
    await synced(machines[1]);
    const posts = two.storeWrites.length;
    await placeOnTablet(one, second.id, 7);
    await expect.poll(async () => [await slotOf(second.id), await slotOf(first.id)]).toEqual([7, null]);
    expect((await versions(second.id))[0]).toMatchObject({ fields: { slot: 7 }, source: { machine: { name: "Seven lab 1" } } });
    expect((await versions(first.id))[0]).toMatchObject({ fields: { slot: null }, source: { machine: { name: "Seven lab 1" } } });
    await expect.poll(() => held(two, second.id, first.id)).toEqual([
      [7, true],
      [null, false],
    ]);
    // On the other tablet the plugin took slot 7 from the record holding it in the post that put the second there: no
    // post left two records in it.
    const slots = two.storeWrites
      .slice(posts)
      .filter((write) => write.key === "recipes")
      .map((write) => [second.id, first.id].map((id) => (write.value as Record_[]).find((record) => record[GLOBAL_ID_KEY] === id)?.[RECIPE_SLOT_FIELD]));
    expect(slots[0]).toEqual([7, null]);
    expect(slots.filter(([moved, holder]) => moved === 7 && holder === 7)).toEqual([]);
    // A record hidden from the strip is in no slot, whatever its stripSlot says, as now.
    await synced(machines[0]);
    const route = `/store/${DYE2_NAMESPACE}/recipes`;
    const hidden = ((await one.callApi("GET", route)).body as Record_[]).map((record) => (record[GLOBAL_ID_KEY] === second.id ? { ...record, [RECIPE_SHOWN_FIELD]: false } : record));
    expect((await one.callApi("POST", route, hidden)).status).toBe(200);
    await expect.poll(() => slotOf(second.id)).toBeNull();
  });

  it("puts a Recipe in slot 7 through REST and through the MCP endpoint, written to each tablet at its Location with stripSlot 7, swapping with or displacing the Recipe there, and refuses a slot of 0 or 10", async () => {
    const here = await api.createLocation("Requests lab", "America/Chicago");
    const machines = [await api.createMachine("Requests lab 1", here.id), await api.createMachine("Requests lab 2", here.id)] as const;
    const tablets = [syncingTablet(machines[0], server, { api: dye2NeverUsed("50611") }), syncingTablet(machines[1], other, { api: dye2NeverUsed("50612") })];
    await api.waitForOnline(...machines);
    /** Each tablet's record of each Recipe: its slot, and whether it is shown. */
    const onEach = (...recipeIds: string[]) => expect.poll(() => tablets.map((tablet) => held(tablet, ...recipeIds)));
    const twice = <T>(value: T) => [value, value];
    type Changed = { recipe: { id: string; slot: number | null } };

    // Created in slot 7 through REST, on the instance one tablet is connected to: each tablet's record holds stripSlot 7.
    const first = await create(here, 7, "Requests first");
    expect(first.slot).toBe(7);
    await onEach(first.id).toEqual(twice([[7, true]]));
    expect((await versions(first.id))[0]!.fields).toEqual({ slot: 7 });

    // Moved to slot 7 through REST, a Recipe in slot 2 swaps with the one there, which takes 2, each a version of its own.
    const second = await create(here, 2, "Requests second");
    await onEach(first.id, second.id).toEqual(twice([[7, true], [2, true]]));
    expect((await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${second.id}/slot`, { slot: 7 })).recipe.slot).toBe(7);
    expect(await slotOf(first.id)).toBe(2);
    expect([(await versions(second.id))[0]!.fields, (await versions(first.id))[0]!.fields]).toEqual([{ slot: 7 }, { slot: 2 }]);
    await onEach(first.id, second.id).toEqual(twice([[2, true], [7, true]]));

    // Created in slot 7 through the MCP endpoint, a Recipe displaces the one there, kept at the Location in no slot.
    const third = (await assistant.call<Changed>("create_recipe", { locationId: here.id, name: "Requests third", slot: 7 })).recipe;
    expect(third.slot).toBe(7);
    expect(await slotOf(second.id)).toBeNull();
    await onEach(third.id, second.id).toEqual(twice([[7, true], [null, false]]));

    // Moved to slot 9 and then 7 through the MCP endpoint, from none: into an empty slot, and displacing the one there.
    expect((await assistant.call<Changed>("set_recipe_slot", { id: second.id, slot: 9 })).recipe.slot).toBe(9);
    await onEach(second.id).toEqual(twice([[9, true]]));
    expect((await assistant.call<Changed>("set_recipe_slot", { id: second.id, slot: 7 })).recipe.slot).toBe(7);
    expect(await slotOf(third.id)).toBe(9);
    await onEach(first.id, second.id, third.id).toEqual(twice([[2, true], [7, true], [9, true]]));
    // REST and the MCP endpoint list each in its slot.
    const listed = [
      ["Requests first", 2],
      ["Requests second", 7],
      ["Requests third", 9],
    ];
    expect((await recipesAt(here)).map(({ name, slot }) => [name, slot])).toEqual(listed);
    const found = await assistant.call<{ recipes: { name: string | null; slot: number | null }[] }>("find_library_items", { kind: "recipe", locationId: here.id });
    expect(found.recipes.map(({ name, slot }) => [name, slot])).toEqual(listed);

    // A slot is a whole number from 1 to 9, refused alike through both otherwise.
    const message = "slot must be a whole number from 1 to 9, next for the lowest one free, or null for none";
    for (const slot of [0, 10, 7.5]) {
      expect(await restRefusal("PUT", `/recipes/${first.id}/slot`, { slot }, 400)).toBe(message);
      expect(await restRefusal("POST", "/recipes", { locationId: here.id, slot, content: { name: "Refused" } }, 400)).toBe(message);
      expect(await toolError("set_recipe_slot", { id: first.id, slot })).toBe(message);
      expect(await toolError("create_recipe", { locationId: here.id, name: "Refused", slot })).toBe(message);
    }
    expect((await recipesAt(here)).map(({ name, slot }) => [name, slot])).toEqual(listed);

    // Taken out of slot 7 through REST and of slot 9 through the MCP endpoint, and the tablets' records follow.
    expect((await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${second.id}/slot`, { slot: null })).recipe.slot).toBeNull();
    expect((await assistant.call<Changed>("set_recipe_slot", { id: third.id, slot: null })).recipe.slot).toBeNull();
    await onEach(second.id, third.id).toEqual(twice([[null, false], [null, false]]));
    // Put back in slot 9 and Archived, a Recipe leaves its slot and the tablets, and is restored in none.
    expect((await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${third.id}/slot`, { slot: 9 })).recipe.slot).toBe(9);
    await onEach(third.id).toEqual(twice([[9, true]]));
    await api.send("PUT", `/recipes/${third.id}/archived`, { archived: true });
    expect(await recipe(third.id)).toMatchObject({ archived: true, slot: null });
    await expect.poll(() => tablets.map((tablet) => recordOf(tablet, third.id))).toEqual([undefined, undefined]);
    await api.send("PUT", `/recipes/${third.id}/archived`, { archived: false });
    expect(await recipe(third.id)).toMatchObject({ archived: false, slot: null });
    await onEach(third.id).toEqual(twice([[null, false]]));
  });

  it("gives the lowest free of the nine slots for next, 6 where 1 to 5 hold a Recipe, and refuses a move there where all nine do, naming nine", async () => {
    const here = await api.createLocation("Next lab", "America/Chicago");
    const machine = await api.createMachine("Next lab 1", here.id);
    const tablet = syncingTablet(machine, other, { api: dye2NeverUsed("50613") });
    await api.waitForOnline(machine);
    const filling: RecipeView[] = [];
    for (const number of [1, 2, 3, 4, 5]) filling.push(await create(here, "next", `Next ${number}`));
    expect(filling.map(({ slot }) => slot)).toEqual([1, 2, 3, 4, 5]);

    // With 1 to 5 full, next gives 6: a new Recipe's through REST, a move's through the MCP endpoint, then a copy's.
    const six = await create(here, "next", "Next 6");
    expect(six.slot).toBe(6);
    const seven = await create(here, null, "Next 7");
    expect((await assistant.call<{ recipe: { slot: number | null } }>("set_recipe_slot", { id: seven.id, slot: "next" })).recipe.slot).toBe(7);
    const elsewhere = await api.createLocation("Next cafe", "America/Chicago");
    const original = await create(elsewhere, 1, "Next 8");
    const copied = await api.send<{ recipe: RecipeView }>("POST", `/recipes/${original.id}/copies`, { locationId: here.id, slot: "next", grinderId: null }, 201);
    expect(copied.recipe.slot).toBe(8);
    const nine = (await assistant.call<{ recipe: { id: string; slot: number | null } }>("create_recipe", { locationId: here.id, name: "Next 9", slot: "next" })).recipe;
    expect(nine.slot).toBe(9);
    // The tablet holds each in its slot.
    await expect.poll(() => held(tablet, six.id, seven.id, copied.recipe.id, nine.id)).toEqual([
      [6, true],
      [7, true],
      [8, true],
      [9, true],
    ]);

    // With all nine full, a new Recipe's next is none, and a move's is refused, naming nine, alike through both.
    const full = "All 9 Recipe Slots here hold a Recipe: choose one to swap with, or take a Recipe out of its slot first";
    const kept = await create(here, "next", "Next kept");
    expect(kept.slot).toBeNull();
    expect((await assistant.call<{ recipe: { slot: number | null } }>("create_recipe", { locationId: here.id, name: "Next kept too", slot: "next" })).recipe.slot).toBeNull();
    expect(await restRefusal("PUT", `/recipes/${kept.id}/slot`, { slot: "next" }, 409)).toBe(full);
    expect(await toolError("set_recipe_slot", { id: kept.id, slot: "next" })).toBe(full);
    expect(await slotOf(kept.id)).toBeNull();
    // One taken out of slot 8, next gives 8.
    await api.send("PUT", `/recipes/${copied.recipe.id}/slot`, { slot: null });
    expect((await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${kept.id}/slot`, { slot: "next" })).recipe.slot).toBe(8);
    await expect.poll(() => held(tablet, kept.id, copied.recipe.id)).toEqual([
      [8, true],
      [null, false],
    ]);
  });

  it("keeps a Recipe in slot 7 through a save of DYE2's editor that taps no tab and through DYE2's record, off Streamline's strip, and moves it to the tab tapped", async () => {
    const here = await api.createLocation("Run lab", "America/Chicago");
    const machine = await api.createMachine("Run lab 1", here.id);
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, server, { api: recordedDye2MainTablet("50621", "Run"), dye2 });
    await api.waitForOnline(machine);
    const record = () => records(tablet).find((entry) => entry.id === LIBRARY_RECIPE);
    const variables = () => (record()?.dashboardVariables ?? {}) as Record_;
    await expect.poll(() => dye2GlobalIdOf(record())).not.toBeNull();
    const recipeId = dye2GlobalIdOf(record())!;
    await synced(machine);
    await placeOnTablet(tablet, recipeId, 7);
    await expect.poll(() => slotOf(recipeId)).toBe(7);
    await synced(machine);

    // DYE2's dashboard lists it among the recipes in a slot, in slot order; Streamline's strip, of five cells, leaves it off.
    const pills = (await openDye2Dashboard(tablet)).recipePills();
    expect(pills.map((pill) => pill[RECIPE_SLOT_FIELD])).toEqual([...pills.map((pill) => pill[RECIPE_SLOT_FIELD] as number)].sort((a, b) => a - b));
    expect(pills.at(-1)).toMatchObject({ id: LIBRARY_RECIPE, [RECIPE_SLOT_FIELD]: 7 });
    const streamline = await startStreamline(tablet);
    expect(streamline.cells().map(({ slot }) => slot)).toEqual([1, 2, 3, 4, 5]);
    expect(streamline.cells().map((cell) => cell.recipe?.id)).not.toContain(LIBRARY_RECIPE);

    // The editor opens on it with none of its five tabs active, shown on the strip; its dose changed and saved, tapping no
    // tab, it keeps its stripSlot, and the Recipe its slot, with the edit.
    const editor = await openDye2RecipeEditor(tablet, { id: LIBRARY_RECIPE });
    expect(editor.strip()).toEqual({ activeTab: null, showOnStreamline: true });
    expect((await editor.set({ dose: 19.4 }).save()).saved[RECIPE_SLOT_FIELD]).toBe(7);
    await expect.poll(async () => (await recipe(recipeId)).content.dose).toBe(19.4);
    expect(await slotOf(recipeId)).toBe(7);
    // Saved again with nothing changed, it keeps it too.
    await synced(machine);
    expect((await (await openDye2RecipeEditor(tablet, { id: LIBRARY_RECIPE })).save()).saved[RECIPE_SLOT_FIELD]).toBe(7);
    expect(record()).toMatchObject({ [RECIPE_SLOT_FIELD]: 7, [RECIPE_SHOWN_FIELD]: true });

    // Applied from DYE2's dashboard, a change of the Workflow's grind is saved into it by DYE2's record, which keeps its
    // stripSlot.
    await synced(machine);
    tablet.connectMachine();
    expect((await (await openDye2Dashboard(tablet)).applyRecipe(LIBRARY_RECIPE)).workflow?.status).toBe(200);
    await expect.poll(() => recipeNamedInWorkflow(tablet)).toBe(recipeId);
    await expect
      .poll(async () => (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.machine.id}`)).machine.loadedRecipe?.recipe.id)
      .toBe(recipeId);
    await dye2.settled();
    await synced(machine);
    const saves = dye2.recorded.length;
    await tablet.changeSettings({ context: { grinderSetting: "3.75" } });
    await expect.poll(() => dye2.recorded.slice(saves)).toContainEqual({ id: LIBRARY_RECIPE, patch: expect.objectContaining({ grind: 3.75 }) });
    await expect.poll(async () => (await recipe(recipeId)).content.grindSetting).toBe(3.75);
    expect([variables().grind, record()![RECIPE_SLOT_FIELD], await slotOf(recipeId)]).toEqual([3.75, 7, 7]);

    // DYE2's save-recipe asked for slot 7 makes a recipe in no slot, as it places one only in 1 to 5.
    await dye2.settled();
    await synced(machine);
    expect((await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/save-recipe`, { slot: 7 })).status).toBe(200);
    expect(dye2.saved.at(-1)).toMatchObject({ stripSlot: null });
    expect(record()![RECIPE_SLOT_FIELD]).toBe(7);

    // Tab 4 tapped in the editor, it moves to slot 4, as from any slot.
    await dye2.settled();
    await synced(machine);
    expect((await (await openDye2RecipeEditor(tablet, { id: LIBRARY_RECIPE })).tapSlot(4).save()).saved[RECIPE_SLOT_FIELD]).toBe(4);
    await expect.poll(() => slotOf(recipeId)).toBe(4);
  });
});
