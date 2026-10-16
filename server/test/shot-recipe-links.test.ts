import { LOADED_RECIPE_KEY, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import {
  type Dye2Key,
  applyInDye2,
  dye2List,
  dye2NeverUsed,
  dye2Recording,
  recordedDye2Tablet,
  replayWrites,
  saveInDye2,
  withDye2Selection,
} from "./support/simulated-dye2.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import type { SimulatedTablet, SimulatedTabletOptions } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #147: each Shot is linked to the Recipe its Machine had
// loaded as it was pulled, a Shot pulled while the tablet was offline
// included, and not to one its Workflow names that was not the Machine's
// Loaded Recipe then, as on a Capture-only Machine; and to the Basket DYE2
// recorded, picked on its dashboard or set on its Edit Shot page, through
// the reporting tablet's map. The Shots list filters by both, and an Admin
// hard-deletes a Recipe no Shot is linked to, and a Basket or Tool no Shot or
// Recipe names, from every tablet. Through the built plugin in simulated
// tablets acting as DYE2 does with the steps recorded from it
// (fixtures/decaid/dye2-v0.1.19/), on two server instances sharing one
// database, with assertions through the REST API and what each simulated
// tablet holds. Serials are made up, from 49001.

type Record_ = Record<string, unknown>;

interface Link {
  id: string;
  name: string | null;
}

interface ShotView {
  id: string;
  recipe: Link | null;
  basket: Link | null;
}

interface FilterOptions {
  recipes: ((Link & { location: LocationView | null }) | null)[];
  baskets: (Link | null)[];
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The time between a pulled Shot's samples. */
const SAMPLE_MS = 100;

describe("Shots linked to their Recipe and Basket, and the hard deletes those links decide", { timeout: 120_000 }, () => {
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

  const recipes = dye2Recording("recipes");
  const applies = dye2Recording("dye2-applies");

  const list = (tablet: SimulatedTablet, key: Dye2Key) => (Array.isArray(dye2List(tablet, key)) ? (dye2List(tablet, key) as Record_[]) : []);
  const inSlot = (tablet: SimulatedTablet, slot: string) => list(tablet, "recipes").find((record) => record.id === slot);
  /** The tablet's DYE2 record of the item, by the global id it carries. */
  const recordOf = (tablet: SimulatedTablet, key: Dye2Key, id: string) => list(tablet, key).find((record) => dye2GlobalIdOf(record) === id);
  const extras = (tablet: SimulatedTablet) => (((tablet.workflow().context ?? {}) as Record_).extras ?? {}) as Record_;
  /** The Recipe id the tablet's Workflow names as loaded, or null. */
  const named = (tablet: SimulatedTablet) => extras(tablet)[LOADED_RECIPE_KEY] ?? null;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine)).toBe(recipeId);
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  /** The Shot as the REST API reads it, once it is stored. */
  async function storedShot(id: string): Promise<ShotView> {
    await expect.poll(async () => (await api.call("GET", `/shots/${id}`)).status, { timeout: 15_000 }).toBe(200);
    return (await api.get<{ shot: ShotView }>(`/shots/${id}`)).shot;
  }
  /** The ids of the Shots a filtered list holds, in list order. */
  const listed = async (query: string) => (await api.get<{ shots: ShotView[] }>(`/shots?${query}`)).shots.map((shot) => shot.id);
  /** Waits a while for what should not happen. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  /**
   * A Shot the tablet's Decaid saves as one pulled now ends: the fixture's
   * curves, recorded on the Machine of that serial, with the tablet's
   * Workflow as it stands, which Decaid copies onto it, and the changes given.
   * Its samples are a tenth of a second apart, so it started a moment ago.
   */
  function pull(tablet: SimulatedTablet, id: string, serial: number, changes: Record_ = {}): Record_ {
    const shot = pulledNow(tablet, id, serial, changes);
    tablet.pullShot(shot);
    return shot;
  }

  /** The Shot `pull` saves, not saved yet. */
  function pulledNow(tablet: SimulatedTablet, id: string, serial: number, changes: Record_ = {}): Record_ {
    const fixture = shotFixture();
    const samples = fixture.measurements as Record_[];
    const startedAt = Date.now() - (samples.length - 1) * SAMPLE_MS;
    const measurements = samples.map((sample, index) => ({
      ...sample,
      machine: { ...(sample.machine as Record_), timestamp: new Date(startedAt + index * SAMPLE_MS).toISOString().slice(0, -1) },
    }));
    const machine = { ...((fixture.workflow as Record_).machine as Record_), serialNumber: String(serial) };
    const workflow = { ...structuredClone(tablet.workflow()), machine };
    return { ...fixture, id, timestamp: new Date(startedAt).toISOString(), workflow, measurements, ...changes };
  }

  /**
   * A Location with a Machine whose tablet is the recording's, DYE2 v0.1.20's
   * selection included, on the first instance, and another whose tablet has
   * never used DYE2 on the other, both holding slots 1 and 2 as the first
   * tablet's DYE2 editor saved and edited them, each naming a Basket.
   */
  async function lab(scenario: string, serial: number, tabletOptions: Pick<SimulatedTabletOptions, "apiDelayMs" | "answerOnArrival"> = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machine = await api.createMachine(`${scenario} lab A`, here.id);
    const second = await api.createMachine(`${scenario} lab B`, here.id);
    const tablet = syncingTablet(machine, server, { api: withDye2Selection(recordedDye2Tablet(String(serial), scenario)), ...tabletOptions });
    const neverUsed = syncingTablet(second, other, { api: withDye2Selection(dye2NeverUsed(String(serial + 1))) });
    await api.waitForOnline(machine, second);
    await saveInDye2(tablet, recipes.saveSlot1);
    await saveInDye2(tablet, recipes.saveSlot2);
    await saveInDye2(tablet, recipes.editSlot1);
    const slotted = async () => (await api.get<{ recipes: { id: string; slot: number | null }[] }>(`/locations/${here.id}/recipes`)).recipes;
    await expect.poll(async () => (await slotted()).map((listedRecipe) => listedRecipe.slot).sort()).toEqual([1, 2]);
    const inSlots = await slotted();
    const ids = { one: inSlots.find((slotted) => slotted.slot === 1)!.id, two: inSlots.find((slotted) => slotted.slot === 2)!.id };
    for (const each of [tablet, neverUsed]) await expect.poll(() => [ids.one, ids.two].map((id) => recordOf(each, "recipes", id) !== undefined)).toEqual([true, true]);
    return { here, machine, second, tablet, neverUsed, ...ids };
  }

  /** Applies the slot on DYE2's dashboard, and resolves once the Machine has its Recipe loaded. */
  async function load(tablet: SimulatedTablet, machine: CreatedMachine, slot: string, recipeId: string): Promise<void> {
    expect((await applyInDye2(tablet, slot)).status).toBe(200);
    await expect.poll(() => named(tablet)).toBe(recipeId);
    await loads(machine, recipeId);
  }

  it("links a Shot pulled with a Recipe loaded to it and its Basket, one pulled while the tablet was offline included, and filters by them", async () => {
    const { here, machine, tablet, one, two } = await lab("Linked", 49001);
    await load(tablet, machine, "1", one);
    const basket = (await recipe(one)).content.basketId as string;
    expect(basket).toEqual(expect.any(String));
    pull(tablet, "recipe-linked-online", 49001);
    expect(await storedShot("recipe-linked-online")).toMatchObject({ recipe: { id: one }, basket: { id: basket } });

    // Offline, slot 2 applied and a Shot pulled with it: both reach the server as the tablet reconnects.
    tablet.loseNetwork();
    await api.waitForMachine(machine.machine.name, (viewed) => !viewed.online, 15_000);
    expect((await applyInDye2(tablet, "2")).status).toBe(200);
    await expect.poll(() => named(tablet)).toBe(two);
    pull(tablet, "recipe-linked-offline", 49001);
    tablet.restoreNetwork();
    await loads(machine, two);
    const offline = await storedShot("recipe-linked-offline");
    expect(offline.recipe).toMatchObject({ id: two, name: expect.any(String) });
    expect(offline.basket).toMatchObject({ id: (await recipe(two)).content.basketId });

    // A Shot pulled with no Recipe loaded, as after the Workflow's grinder changed.
    await tablet.changeSettings({ context: { grinderId: "a-grinder-no-recipe-names", grinderModel: "Another grinder" } });
    await expect.poll(() => named(tablet)).toBeNull();
    await loads(machine, null);
    pull(tablet, "recipe-linked-none", 49001);
    expect((await storedShot("recipe-linked-none")).recipe).toBeNull();

    expect(await listed(`recipeId=${one}`)).toEqual(["recipe-linked-online"]);
    expect(await listed(`recipeId=${two}`)).toEqual(["recipe-linked-offline"]);
    expect(await listed(`recipeId=none&machineId=${machine.machine.id}`)).toEqual(["recipe-linked-none"]);
    expect(await listed(`basketId=${basket}`)).toContain("recipe-linked-online");
    const options = await api.get<FilterOptions>("/shots/filters");
    expect(options.recipes).toEqual(expect.arrayContaining([expect.objectContaining({ id: one, location: expect.objectContaining({ id: here.id }) }), expect.objectContaining({ id: two })]));
    expect(options.recipes.at(-1)).toBeNull();
    expect(options.baskets).toEqual(expect.arrayContaining([expect.objectContaining({ id: basket })]));
    // A malformed id names nothing, as in a path.
    expect((await api.call("GET", "/shots?recipeId=not-a-recipe")).status).toBe(404);
    expect((await api.call("GET", "/shots?basketId=not-a-basket")).status).toBe(404);
  });

  it("does not link a Shot to the Recipe its Workflow names where it was not its Machine's Loaded Recipe as it was pulled, as on a Capture-only Machine", async () => {
    const { machine, tablet, one, two } = await lab("Capture-only", 49011);
    await load(tablet, machine, "1", one);
    expect((await api.call("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    await expect.poll(() => named(tablet)).toBeNull();
    await loads(machine, null);

    // Slot 2 applied while capture-only stays selected there, its id in the Workflow, but is not its Loaded Recipe.
    expect((await applyInDye2(tablet, "2")).status).toBe(200);
    await expect.poll(() => named(tablet)).toBe(two);
    await settle();
    const shot = pull(tablet, "recipe-capture-only", 49011);
    expect(((shot.workflow as Record_).context as Record_).extras).toMatchObject({ [LOADED_RECIPE_KEY]: two });
    expect((await storedShot("recipe-capture-only")).recipe).toBeNull();

    // Sharing again, it is the Machine's Loaded Recipe from then on: the Shot pulled before stays unlinked.
    expect((await api.call("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: true })).status).toBe(200);
    await loads(machine, two);
    expect((await storedShot("recipe-capture-only")).recipe).toBeNull();
    expect(await listed(`recipeId=${two}`)).not.toContain("recipe-capture-only");
    pull(tablet, "recipe-sharing-again", 49011);
    expect((await storedShot("recipe-sharing-again")).recipe).toMatchObject({ id: two });
  });

  it("links a Shot to the Basket picked for it on DYE2's dashboard, and to the one DYE2's Edit Shot page sets", async () => {
    const { tablet } = await lab("Basket", 49021);
    // DYE2's dashboard picking a basket for the next Shot, as recorded.
    for (const answer of await replayWrites(tablet, applies.pickBasket)) expect(answer.status).toBe(200);
    const picked = extras(tablet).basketId as string;
    expect(picked).toEqual(expect.any(String));
    const pickedBasket = dye2GlobalIdOf(list(tablet, "baskets").find((record) => record.id === picked));
    expect(pickedBasket).toEqual(expect.any(String));
    pull(tablet, "basket-picked", 49021);
    expect((await storedShot("basket-picked")).basket).toMatchObject({ id: pickedBasket });

    // A Shot pulled with no Basket, given one on DYE2's Edit Shot page, which records it in the annotations' extras.
    await tablet.changeSettings({ context: { extras: { basketId: null, basketName: null } } });
    const shot = pull(tablet, "basket-edited", 49021);
    expect((await storedShot("basket-edited")).basket).toBeNull();
    const other = list(tablet, "baskets").find((record) => record.id !== picked && dye2GlobalIdOf(record) !== null)!;
    const { measurements: _measurements, ...metadata } = shot;
    tablet.fire("shotUpdated", {
      id: shot.id,
      shot: { ...metadata, updatedAt: "2026-11-01T12:01:00Z", annotations: { extras: { basketId: other.id, basketName: other.name } } },
    });
    await expect.poll(async () => (await storedShot("basket-edited")).basket?.id).toBe(dye2GlobalIdOf(other));
    // Each test's recorded tablet brings the same Baskets, matched by name.
    expect(await listed(`basketId=${dye2GlobalIdOf(other)}`)).toContain("basket-edited");
    expect(await listed(`basketId=${dye2GlobalIdOf(other)}`)).not.toContain("basket-picked");
  });

  it("hard-deletes a Recipe no Shot is linked to from every tablet, but not one a Shot is linked to, and only for an Admin", async () => {
    const { here, machine, tablet, neverUsed, one, two } = await lab("Deleted", 49031);
    await load(tablet, machine, "1", one);
    pull(tablet, "recipe-deleted-shot", 49031);
    expect((await storedShot("recipe-deleted-shot")).recipe).toMatchObject({ id: one });

    const staff = await api.staffAt("deleted-recipes-staff@example.com", here);
    expect((await staff.call("DELETE", `/recipes/${two}`)).status).toBe(403);
    const refused = await api.call("DELETE", `/recipes/${one}`);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("A Shot names this Recipe");

    // Slot 2, loaded on the Machine but with no Shot pulled with it, goes from both tablets, and from the Workflow naming it.
    await load(tablet, machine, "2", two);
    expect((await api.call("DELETE", `/recipes/${two}`)).status).toBe(204);
    expect((await api.call("GET", `/recipes/${two}`)).status).toBe(404);
    for (const each of [tablet, neverUsed]) await expect.poll(() => recordOf(each, "recipes", two)).toBeUndefined();
    await expect.poll(() => inSlot(tablet, "2")).toBeUndefined();
    await expect.poll(() => named(tablet)).toBeNull();
    await loads(machine, null);
    expect(recordOf(tablet, "recipes", one)).toBeDefined();
  });

  it("stores a Shot's full record after its early edit under its Recipe's lock, so a delete racing it finds the Shot linked", async () => {
    const { machine, tablet, one } = await lab("Early edit", 49051);
    await load(tablet, machine, "1", one);
    // DYE2's Edit Shot page saves the Shot before the plugin has sent it: its edit reaches the server first.
    const shot = pulledNow(tablet, "recipe-early-edit", 49051);
    const { measurements: _measurements, ...metadata } = shot;
    tablet.fire("shotUpdated", { id: shot.id, shot: metadata });
    await expect.poll(() => tablet.acknowledgedSome((frame: Record_) => frame.type === "shotUpdated" && frame.shotId === shot.id)).toBe(true);

    // A delete holding the Recipe's row, as it does once it has looked for linked Shots, holds back the full record's storage.
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM recipes WHERE id = $1 FOR UPDATE", [one]);
      tablet.pullShot(shot);
      await waitForLockWaits(server);
      expect((await api.call("GET", `/shots/${shot.id}`)).status).toBe(404);
      await database.query("ROLLBACK");
    } finally {
      await database.end();
    }
    expect((await storedShot("recipe-early-edit")).recipe).toMatchObject({ id: one });
    expect((await api.call("DELETE", `/recipes/${one}`)).status).toBe(409);
  });

  it("deletes a Basket from a tablet whose Shot named it until DYE2's Edit Shot page set another", async () => {
    const { here, tablet, neverUsed } = await lab("Basket edited", 49061);
    const create = async (name: string) => (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: here.id, content: { name } }, 201)).basket.id;
    const [picked, edited] = [await create("Basket edited 18 g"), await create("Basket edited 20 g")];
    for (const id of [picked, edited]) await expect.poll(() => recordOf(tablet, "baskets", id)).toBeDefined();
    const local = (id: string) => recordOf(tablet, "baskets", id)!.id as string;
    await tablet.changeSettings({ context: { extras: { basketId: local(picked), basketName: "Basket edited 18 g" } } });
    const shot = pull(tablet, "basket-edited-away", 49061);
    expect((await storedShot("basket-edited-away")).basket).toMatchObject({ id: picked });
    const { measurements: _measurements, ...metadata } = shot;
    tablet.fire("shotUpdated", {
      id: shot.id,
      shot: { ...metadata, updatedAt: "2026-11-01T12:01:00Z", annotations: { extras: { basketId: local(edited), basketName: "Basket edited 20 g" } } },
    });
    await expect.poll(async () => (await storedShot("basket-edited-away")).basket?.id).toBe(edited);

    // The Shot names the other Basket now, on the server and on the tablet, so the first goes from both tablets.
    expect((await api.call("DELETE", `/baskets/${picked}`)).status).toBe(204);
    for (const each of [tablet, neverUsed]) await expect.poll(() => recordOf(each, "baskets", picked)).toBeUndefined();
    expect((await api.call("DELETE", `/baskets/${edited}`)).status).toBe(409);
  });

  it("deletes a Basket from a tablet whose Shot's record, read slowly, named it after a newer edit named another", async () => {
    let edit: (() => void) | undefined;
    // The plugin's read of the Shot is answered from what Decaid held as it arrived, 25 s of the tablet's time later
    // (half a second here), and DYE2's Edit Shot page sets another Basket meanwhile.
    const apiDelayMs = (method: string, path: string) => {
      if (method !== "GET" || path !== "/shots/basket-slow-read" || !edit) return 0;
      setTimeout(edit, 0);
      edit = undefined;
      return 25_000;
    };
    const { here, tablet, neverUsed } = await lab("Slow read", 49071, { apiDelayMs, answerOnArrival: true });
    const create = async (name: string) => (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: here.id, content: { name } }, 201)).basket.id;
    const [picked, edited] = [await create("Slow read 18 g"), await create("Slow read 20 g")];
    for (const id of [picked, edited]) await expect.poll(() => recordOf(tablet, "baskets", id)).toBeDefined();
    const local = (id: string) => recordOf(tablet, "baskets", id)!.id as string;
    await tablet.changeSettings({ context: { extras: { basketId: local(picked), basketName: "Slow read 18 g" } } });
    const shot = pulledNow(tablet, "basket-slow-read", 49071);
    const { measurements: _measurements, ...metadata } = shot;
    edit = () =>
      tablet.fire("shotUpdated", {
        id: shot.id,
        shot: { ...metadata, updatedAt: "2026-11-01T12:01:00.000002Z", annotations: { extras: { basketId: local(edited), basketName: "Slow read 20 g" } } },
      });
    tablet.pullShot(shot);
    await expect.poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);
    await expect.poll(async () => (await storedShot(shot.id as string)).basket?.id).toBe(edited);

    expect((await api.call("DELETE", `/baskets/${picked}`)).status).toBe(204);
    for (const each of [tablet, neverUsed]) await expect.poll(() => recordOf(each, "baskets", picked)).toBeUndefined();
  });

  it("hard-deletes a Basket or Tool no Shot or Recipe names from every tablet, and refuses one either names", async () => {
    const { here, tablet, neverUsed, one } = await lab("Equipment", 49041);
    const create = async (kind: "baskets" | "tools", name: string) =>
      Object.values(await api.send<Record<string, { id: string }>>("POST", `/${kind}`, { locationId: here.id, content: { name } }, 201))[0]!.id;
    const key = (kind: "baskets" | "tools"): Dye2Key => (kind === "baskets" ? "baskets" : "equipment");
    const held = async (kind: "baskets" | "tools", id: string) => {
      for (const each of [tablet, neverUsed]) await expect.poll(() => recordOf(each, key(kind), id)).toBeDefined();
      return recordOf(tablet, key(kind), id)!.id as string;
    };

    // Named by a Recipe.
    const recipeBasket = await create("baskets", "Deleted lab 18 g");
    const recipeTool = await create("tools", "Deleted lab puck screen");
    await held("baskets", recipeBasket);
    await held("tools", recipeTool);
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { basketId: recipeBasket, toolIds: [recipeTool] } })).status).toBe(200);
    const refusedBasket = await api.call("DELETE", `/baskets/${recipeBasket}`);
    expect(refusedBasket.status).toBe(409);
    expect(await refusedBasket.text()).toContain("A Recipe names this Basket");
    expect((await api.call("DELETE", `/tools/${recipeTool}`)).status).toBe(409);

    // Named by a Shot, by the tablet's ids.
    const shotBasket = await create("baskets", "Deleted lab 22 g");
    const shotTool = await create("tools", "Deleted lab WDT");
    const [shotBasketId, shotToolId] = [await held("baskets", shotBasket), await held("tools", shotTool)];
    pull(tablet, "equipment-named", 49041, { annotations: { extras: { basketId: shotBasketId, equipmentIds: [shotToolId], equipmentNames: ["Deleted lab WDT"] } } });
    expect((await storedShot("equipment-named")).basket).toMatchObject({ id: shotBasket });
    const refusedTool = await api.call("DELETE", `/tools/${shotTool}`);
    expect(refusedTool.status).toBe(409);
    expect(await refusedTool.text()).toContain("A Shot names this Tool");
    expect((await api.call("DELETE", `/baskets/${shotBasket}`)).status).toBe(409);
    // Still named once their records leave the tablets, the Tool Archived and the Basket hidden at the Location.
    expect((await api.call("PUT", `/tools/${shotTool}/archived`, { archived: true })).status).toBe(200);
    expect((await api.call("PUT", `/baskets/${shotBasket}/locations/${here.id}`, { shown: false })).status).toBe(200);
    for (const each of [tablet, neverUsed]) {
      await expect.poll(() => recordOf(each, "equipment", shotTool)).toBeUndefined();
      await expect.poll(() => recordOf(each, "baskets", shotBasket)).toBeUndefined();
    }
    expect((await api.call("DELETE", `/tools/${shotTool}`)).status).toBe(409);
    expect((await api.call("DELETE", `/baskets/${shotBasket}`)).status).toBe(409);

    // Named by neither: gone from the Library and from both tablets.
    const unusedBasket = await create("baskets", "Deleted lab 15 g");
    const unusedTool = await create("tools", "Deleted lab tamper");
    await held("baskets", unusedBasket);
    await held("tools", unusedTool);
    const staff = await api.staffAt("deleted-equipment-staff@example.com", here);
    expect((await staff.call("DELETE", `/baskets/${unusedBasket}`)).status).toBe(403);
    expect((await api.call("DELETE", `/baskets/${unusedBasket}`)).status).toBe(204);
    expect((await api.call("DELETE", `/tools/${unusedTool}`)).status).toBe(204);
    expect((await api.call("GET", `/baskets/${unusedBasket}`)).status).toBe(404);
    for (const each of [tablet, neverUsed]) {
      await expect.poll(() => recordOf(each, "baskets", unusedBasket)).toBeUndefined();
      await expect.poll(() => recordOf(each, "equipment", unusedTool)).toBeUndefined();
    }
    expect((await api.call("GET", `/baskets/${shotBasket}`)).status).toBe(200);
  });
});
