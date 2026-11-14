import { GLOBAL_ID_KEY, RECIPE_SHOWN_FIELD, RECIPE_SLOT_FIELD, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, openDye2RecipeEditor, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #506: a Recipe Slot is a whole number from 1 to 9
// wherever one is read. A tablet's record whose `stripSlot` is 6 to 9 moves
// its Recipe into that slot at its Location, by the rules a move into 1 to 5
// follows, and the Recipe is written to the Location's other tablets with
// its `stripSlot`, the plugin taking the slot from any other record holding
// it in the same post. A request still names only 1 to 5 (#502 has the
// rest): REST and the MCP endpoint refuse 6 to 9, and `next` gives the
// lowest free of 1 to 5; a Recipe already in 6 to 9 is shown in its slot,
// taken out of it, swapped with, Archived and restored as any other.
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

describe("Recipe Slots 6 to 9 are read and kept", { timeout: 90_000 }, () => {
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

  it("refuses a request's slot of 6 to 9 through REST and the MCP endpoint, gives the lowest free of 1 to 5 for next, and shows a Recipe in 7 to 9 in its slot, swapped with, taken out, Archived and restored", async () => {
    const here = await api.createLocation("Requests lab", "America/Chicago");
    const machine = await api.createMachine("Requests lab 1", here.id);
    const tablet = syncingTablet(machine, other, { api: dye2NeverUsed("50611") });
    await api.waitForOnline(machine);
    const seven = await create(here, null, "Requests seven");
    const eight = await create(here, null, "Requests eight");
    const nine = await create(here, null, "Requests nine");
    await expect.poll(() => [seven, eight, nine].map(({ id }) => dye2GlobalIdOf(recordOf(tablet, id)))).toEqual([seven.id, eight.id, nine.id]);
    await synced(machine);
    for (const [placed, slot] of [[seven, 7], [eight, 8], [nine, 9]] as const) await placeOnTablet(tablet, placed.id, slot);
    await expect.poll(async () => (await recipesAt(here)).map(({ name, slot }) => [name, slot])).toEqual([
      ["Requests seven", 7],
      ["Requests eight", 8],
      ["Requests nine", 9],
    ]);

    // REST and the MCP endpoint show each in its slot.
    expect((await recipe(seven.id)).slot).toBe(7);
    expect((await assistant.call<{ recipe: { slot: number | null } }>("get_library_item", { kind: "recipe", id: nine.id })).recipe.slot).toBe(9);
    const found = await assistant.call<{ recipes: { id: string; slot: number | null }[] }>("find_library_items", { kind: "recipe", locationId: here.id });
    expect(found.recipes.map(({ id, slot }) => [id, slot])).toEqual([
      [seven.id, 7],
      [eight.id, 8],
      [nine.id, 9],
    ]);

    // A request names only 1 to 5, refused alike through both.
    const message = "slot must be a whole number from 1 to 5, next for the lowest one free, or null for none";
    for (const slot of [6, 7, 9, 10]) {
      expect(await restRefusal("PUT", `/recipes/${eight.id}/slot`, { slot }, 400)).toBe(message);
      expect(await restRefusal("POST", "/recipes", { locationId: here.id, slot, content: { name: "Refused" } }, 400)).toBe(message);
      expect(await toolError("set_recipe_slot", { id: eight.id, slot })).toBe(message);
      expect(await toolError("create_recipe", { locationId: here.id, name: "Refused", slot })).toBe(message);
    }
    expect((await recipesAt(here)).map(({ slot }) => slot)).toEqual([7, 8, 9]);

    // `next` gives the lowest free of 1 to 5, and with those full answers as it does with five slots: none for a new
    // Recipe, 409 for a move.
    const filling: RecipeView[] = [];
    for (const number of [1, 2, 3, 4, 5]) filling.push(await create(here, "next", `Requests ${number}`));
    expect(filling.map(({ slot }) => slot)).toEqual([1, 2, 3, 4, 5]);
    expect((await create(here, "next", "Requests full")).slot).toBeNull();
    expect(await restRefusal("PUT", `/recipes/${eight.id}/slot`, { slot: "next" }, 409)).toContain("All 5 Recipe Slots here hold a Recipe");
    expect(await toolError("set_recipe_slot", { id: eight.id, slot: "next" })).toContain("All 5 Recipe Slots here hold a Recipe");
    expect(await slotOf(eight.id)).toBe(8);

    // Moved to slot 3, the Recipe in 7 swaps with the one there, which takes 7; that one is taken out of its slot through
    // REST, and the tablet's records follow.
    expect((await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${seven.id}/slot`, { slot: 3 })).recipe.slot).toBe(3);
    expect(await slotOf(filling[2]!.id)).toBe(7);
    await expect.poll(() => held(tablet, seven.id, filling[2]!.id)).toEqual([
      [3, true],
      [7, true],
    ]);
    expect((await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${filling[2]!.id}/slot`, { slot: null })).recipe.slot).toBeNull();
    // The one in 8 is taken out of its slot through the MCP endpoint.
    expect((await assistant.call<{ recipe: { slot: number | null } }>("set_recipe_slot", { id: eight.id, slot: null })).recipe.slot).toBeNull();
    await expect.poll(() => held(tablet, filling[2]!.id, eight.id)).toEqual([
      [null, false],
      [null, false],
    ]);
    // The one in 9 is Archived, which takes it out of its slot and off the tablet, and restored in none.
    await api.send("PUT", `/recipes/${nine.id}/archived`, { archived: true });
    expect(await recipe(nine.id)).toMatchObject({ archived: true, slot: null });
    await expect.poll(() => recordOf(tablet, nine.id)).toBeUndefined();
    await api.send("PUT", `/recipes/${nine.id}/archived`, { archived: false });
    expect(await recipe(nine.id)).toMatchObject({ archived: false, slot: null });
    await expect.poll(() => held(tablet, nine.id)).toEqual([[null, false]]);
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
