import { dye2GlobalIdOf, dye2SelectionOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Ticket #203: while DYE2 has a recipe or favourite selected, the plugin's
// `skin` answer holds a Clear button for Streamline's top bar, which opens
// the plugin's `ui` page; the page clears DYE2's selection once, whatever it
// names, and sends the skin back to its dashboard, and the server unloads
// the Loaded Recipe through DYE2's field in the Workflow. The plugin pushes
// `{"what":"skin"}` on each push from DYE2. Through the built plugin in
// simulated tablets running DYE2 at 2cf631c as recorded
// (fixtures/decaid/dye2-2cf631c/), at real time where `skin` is read, as its
// 1 s wait for DYE2 runs on the tablet's clock, and on two server instances
// sharing one database. Serials are made up, from 51001.

type Record_ = Record<string, unknown>;

const SELECTION = `/plugins/${DYE2_NAMESPACE}/selection`;
const FAVOURITES = `/store/${DYE2_NAMESPACE}/autoFavourites`;
/** Where Streamline's dashboard sends the page back to (`returnTo`), as it opens it from the top bar. */
const DASHBOARD = "http://localhost:8080/streamline/index.html?machine=1";
const SKIN_PUSH = { what: "skin" };

/** The plugin's `skin` answer's surfaces. */
async function surfaces(tablet: SimulatedTablet): Promise<Record_[]> {
  const answer = await tablet.callEndpoint("skin");
  expect(answer.status).toBe(200);
  const body = JSON.parse(answer.body) as Record_;
  expect(body.live).toEqual({ endpoint: "changed" });
  return body.surfaces as Record_[];
}

/** The Clear button the plugin's `skin` answer holds for that text. */
const clearButton = (text: string) => ({ id: "clear", kind: "header-button", label: "Clear", text, action: { type: "open", view: "clear", presentation: "page" } });

/** A barista's tap on the Clear button: Streamline opens the plugin's `ui` page as a page, with its view and `returnTo`. */
const tapClear = (tablet: SimulatedTablet, returnTo: string | null = DASHBOARD) =>
  tablet.callEndpoint("ui", { query: { view: "clear", ...(returnTo === null ? {} : { returnTo }) } });

/** DYE2 asked to select an item, as its dashboard or Streamline's strip asks it. */
async function select(tablet: SimulatedTablet, kind: "recipe" | "favourite", id: string): Promise<void> {
  expect((await tablet.callApi("POST", SELECTION, { kind, id })).status).toBe(200);
}

/** The Workflow as the tablet holds it, without DYE2's field, which its clear writes. */
function withoutSelection(workflow: Record_): Record_ {
  const copy = structuredClone(workflow);
  const extras = ((copy.context as Record_ | undefined)?.extras ?? {}) as Record_;
  delete (extras.dye as Record_ | undefined)?.selection;
  return copy;
}

describe("The Clear button in the plugin's skin answer", () => {
  /** A tablet whose plugin has no settings, so it does not connect, running DYE2 as recorded. */
  function unconnected(serial: number, dye2 = new SimulatedDye2()) {
    return { tablet: SimulatedTablet.load({ settings: {}, api: recordedDye2MainTablet(String(serial)), dye2 }), dye2 };
  }

  it("shows while DYE2 has a recipe or favourite selected, named as the DYE strip names it, and not while it has none", async () => {
    const { tablet, dye2 } = unconnected(51001);
    expect(dye2.selected()).toBeNull();
    expect(await surfaces(tablet)).toEqual([]);

    await select(tablet, "recipe", "1");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Fixture Ethiopia Espresso")]);

    // A favourite by its title, else its subtitle, else its coffee; a recipe by its title, else its name.
    await tablet.callApi("POST", FAVOURITES, [
      { id: "favourite-51001", title: "House", subtitle: "Roaster · Coffee", snapshot: { coffeeName: "Coffee" } },
      { id: "favourite-51002", title: "", subtitle: "Roaster · Coffee", snapshot: { coffeeName: "Coffee" } },
      { id: "favourite-51003", snapshot: { coffeeName: "Coffee" } },
    ]);
    await select(tablet, "favourite", "favourite-51001");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload House")]);
    await select(tablet, "favourite", "favourite-51002");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Roaster · Coffee")]);
    await select(tablet, "favourite", "favourite-51003");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Coffee")]);
    const recipes = dye2List(tablet, "recipes") as Record_[];
    await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, [{ ...recipes[0], title: undefined }, ...recipes.slice(1)]);
    await select(tablet, "recipe", "1");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Fixture Ethiopia Espresso")]);
    // One DYE2's lists do not hold, by its kind.
    await select(tablet, "recipe", "4");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Recipe")]);
    await select(tablet, "favourite", "favourite-gone");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Favourite")]);

    expect((await tablet.callApi("POST", SELECTION, {})).status).toBe(200);
    expect(await surfaces(tablet)).toEqual([]);
  });

  it("cuts a long name to the 40 characters Streamline shows", async () => {
    const { tablet } = unconnected(51002);
    await tablet.callApi("POST", FAVOURITES, [{ id: "favourite-long", title: "Ethiopia Yirgacheffe Natural, Lot 7, for milk" }]);
    await select(tablet, "favourite", "favourite-long");
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Ethiopia Yirgacheffe Natural, Lo…")]);
    // Cut by code point: a character outside the Basic Multilingual Plane at the cut is left whole or out, never halved.
    await tablet.callApi("POST", FAVOURITES, [{ id: "favourite-long", title: "Ethiopia Yirgacheffe Natural, L\u{1F525}\u{1F525} for milk" }]);
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Ethiopia Yirgacheffe Natural, L\u{1F525}…")]);
  });

  it("does not show while DYE2 is not loaded or absent", async () => {
    const { tablet, dye2 } = unconnected(51003);
    await select(tablet, "recipe", "2");
    dye2.unload();
    expect(await surfaces(tablet)).toEqual([]);

    const without = SimulatedTablet.load({ settings: {}, api: recordedDye2MainTablet("51004") });
    expect(await surfaces(without)).toEqual([]);
  });

  it("does not show where DYE2 is slow to answer, so the rest of the answer reaches the skin in time", async () => {
    const dye2 = new SimulatedDye2();
    const tablet = SimulatedTablet.load({
      settings: {},
      api: recordedDye2MainTablet("51005"),
      dye2,
      apiDelayMs: (method, path) => (method === "GET" && path === SELECTION ? 5_000 : 0),
    });
    await select(tablet, "recipe", "1");
    const started = Date.now();
    expect(await surfaces(tablet)).toEqual([]);
    // Well short of DYE2's 5 s, which an answer that waited for it would take.
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("A tap on the Clear button", () => {
  function unconnected(serial: number, options: { apiDelayMs?: (method: string, path: string) => number } = {}) {
    const dye2 = new SimulatedDye2();
    return { tablet: SimulatedTablet.load({ settings: {}, api: recordedDye2MainTablet(String(serial)), dye2, ...options }), dye2 };
  }

  it("clears DYE2's selection, whatever it names, and sends the skin back to its dashboard", async () => {
    const { tablet, dye2 } = unconnected(51011);
    await select(tablet, "favourite", "favourite-51011");
    const workflow = withoutSelection(tablet.workflow());

    const answer = await tapClear(tablet);
    expect(answer.status).toBe(303);
    expect(answer.headers).toMatchObject({ Location: DASHBOARD, "Cache-Control": "no-store" });
    expect(dye2.selected()).toBeNull();
    expect(dye2.asked.at(-1)).toBeNull();
    // DYE2 stores the clear, which the dashboard's strip reads as it reloads, and writes its field; nothing else changes.
    expect(tablet.storeValue(DYE2_NAMESPACE, "selection")).toEqual({});
    await dye2.markersWritten();
    expect(dye2SelectionOf(tablet.workflow()).named).toBe(false);
    expect(withoutSelection(tablet.workflow())).toEqual(workflow);
    expect(await surfaces(tablet)).toEqual([]);

    // With nothing selected, the clear is made all the same.
    expect((await tapClear(tablet)).status).toBe(303);
    expect(dye2.asked.slice(-2)).toEqual([null, null]);
  });

  it("returns to the dashboard where DYE2 answers 404, refuses the clear or is slow to answer, and logs it", async () => {
    let slow = false;
    const { tablet, dye2 } = unconnected(51012, { apiDelayMs: (method, path) => (method === "POST" && path === SELECTION && slow ? 10_000 : 0) });
    await select(tablet, "recipe", "1");

    dye2.refuseSelections(1);
    expect((await tapClear(tablet)).headers.Location).toBe(DASHBOARD);
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: "1" });
    await tablet.waitForLog(/^Could not clear DYE2's selection for the Clear button: Decaid answered 503 setting DYE2's selection$/);

    slow = true;
    const started = Date.now();
    expect((await tapClear(tablet)).headers.Location).toBe(DASHBOARD);
    expect(Date.now() - started).toBeLessThan(8_000);
    await tablet.waitForLog(/^Could not clear DYE2's selection for the Clear button: DYE2 did not answer within 3 s$/);
    slow = false;

    dye2.unload();
    expect((await tapClear(tablet)).headers.Location).toBe(DASHBOARD);
    await tablet.waitForLog(/^Could not clear DYE2's selection for the Clear button: DYE2 is not loaded$/);
  });

  it("goes back only to an http or https page, sends any other view straight back, and answers nothing else", async () => {
    const { tablet, dye2 } = unconnected(51013);
    for (const returnTo of [null, "", "javascript:alert(1)", "http://user:secret@localhost:8080/", "http://localhost:8080/\r\nSet-Cookie: x=1", "/streamline/index.html"]) {
      await select(tablet, "recipe", "2");
      const answer = await tapClear(tablet, returnTo);
      // The page is cleared all the same, and the browser stays where it is.
      expect([answer.status, answer.headers.Location]).toEqual([204, undefined]);
      expect(dye2.selected()).toBeNull();
    }
    expect((await tapClear(tablet, "https://tablet.local/streamline/?page=dashboard#top")).headers.Location).toBe("https://tablet.local/streamline/?page=dashboard#top");

    const asked = dye2.asked.length;
    expect((await tablet.callEndpoint("ui", { method: "POST", query: { view: "clear", returnTo: DASHBOARD } })).status).toBe(405);
    // Streamline's settings card opens `ui` with no view from its Open button: straight back, clearing nothing.
    const settings = "http://localhost:13999/?page=settings";
    for (const query of [{ returnTo: settings }, { view: "main", returnTo: settings }] as Record<string, string>[]) {
      const answer = await tablet.callEndpoint("ui", { query });
      expect([answer.status, answer.headers.Location, answer.headers["Cache-Control"]]).toEqual([303, settings, "no-store"]);
    }
    expect((await tablet.callEndpoint("ui")).status).toBe(404);
    expect((await tablet.callEndpoint("ui", { query: { view: "main", returnTo: "javascript:alert(1)" } })).status).toBe(404);
    expect(dye2.asked.length).toBe(asked);
  });
});

describe("Clearing a Machine's Loaded Recipe from Streamline's top bar", { timeout: 120_000 }, () => {
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

  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  /** How many selections or clears the plugin posted to DYE2. */
  const selectionPosts = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === `POST ${SELECTION}`).length;
  const skinPushes = (tablet: SimulatedTablet) => tablet.pushes("changed").filter((push) => JSON.stringify(push) === JSON.stringify(SKIN_PUSH)).length;

  /** A Machine at a Location of its own, its tablet the recording's at real time, polling every 2 s, with its recipes in slots 1 and 2 the Location's. */
  async function lab(scenario: string, serial: number, instance: TestServer) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machine = await api.createMachine(`${scenario} lab 1`, here.id);
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, instance, { api: recordedDye2MainTablet(String(serial), scenario), dye2, pollSeconds: 2, timeScale: 1 });
    await api.waitForOnline(machine);
    const inSlot = (slot: string) => (dye2List(tablet, "recipes") as Record_[]).find((record) => record.id === slot);
    await expect.poll(() => ["1", "2"].map((slot) => dye2GlobalIdOf(inSlot(slot))), { timeout: 15_000 }).not.toContain(null);
    return { machine, tablet, dye2, one: dye2GlobalIdOf(inSlot("1"))! };
  }

  it("shows the Loaded Recipe's Clear button, pushing as DYE2 selects and clears, and a tap unloads it, leaving the Workflow as it is", async () => {
    const { machine, tablet, dye2, one } = await lab("Clear", 51021, server);
    const dashboard = await openDye2Dashboard(tablet);
    let pushes = skinPushes(tablet);
    expect((await dashboard.applyRecipe("1")).selection?.status).toBe(200);
    await loads(machine, one);
    await expect.poll(() => skinPushes(tablet)).toBeGreaterThan(pushes);
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Fixture Ethiopia Espresso")]);

    // Past the plugin's read after the load's Workflow changes.
    await dye2.markersWritten();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const posts = selectionPosts(tablet);
    const workflow = withoutSelection(tablet.workflow());
    pushes = skinPushes(tablet);
    expect((await tapClear(tablet)).headers.Location).toBe(DASHBOARD);
    expect(dye2.selected()).toBeNull();
    await loads(machine, null);
    await expect.poll(() => skinPushes(tablet)).toBeGreaterThan(pushes);
    expect(await surfaces(tablet)).toEqual([]);
    // Nothing is restored, and the plugin selects nothing again.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(withoutSelection(tablet.workflow())).toEqual(workflow);
    expect(selectionPosts(tablet)).toBe(posts + 1);
    expect(dye2.selected()).toBeNull();
    expect(await loadedRecipe(machine)).toBeNull();
  });

  it("does not try a refused clear again: the recipe stays loaded, and the button shows", async () => {
    const { machine, tablet, dye2, one } = await lab("Refused clear", 51022, other);
    const dashboard = await openDye2Dashboard(tablet);
    expect((await dashboard.applyRecipe("1")).selection?.status).toBe(200);
    await loads(machine, one);

    dye2.refuseSelections(1);
    const posts = selectionPosts(tablet);
    expect((await tapClear(tablet)).headers.Location).toBe(DASHBOARD);
    // Several of the plugin's polls later.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(selectionPosts(tablet)).toBe(posts + 1);
    expect(dye2.selected()).toMatchObject({ kind: "recipe", id: "1" });
    expect(await loadedRecipe(machine)).toBe(one);
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Fixture Ethiopia Espresso")]);
  });

  it("clears DYE2's selection on a Capture-only Machine too", async () => {
    const machine = await api.createMachine("Clear capture-only 1");
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, server, { api: recordedDye2MainTablet("51023", "Clear capture-only"), dye2, pollSeconds: 2, timeScale: 1 });
    await api.waitForOnline(machine);
    const dashboard = await openDye2Dashboard(tablet);
    expect((await dashboard.applyRecipe("2")).selection?.status).toBe(200);
    expect(await surfaces(tablet)).toEqual([clearButton("Unload Fixture Brazil Espresso")]);

    expect((await tapClear(tablet)).headers.Location).toBe(DASHBOARD);
    expect(dye2.selected()).toBeNull();
    expect(await surfaces(tablet)).toEqual([]);
  });
});
