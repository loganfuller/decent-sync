import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, recipeIdInWorkflow } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, recordedDye2MainTablet, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #203: every change on a Machine with a Recipe loaded is
// saved into it (ADR-0022), so while the Machine has a Loaded Recipe the
// plugin's `skin` answer holds a Clear button for Streamline's top bar, its
// text "Unload <name>". A tap opens the plugin's `ui` page, which writes
// `recipeId: null` into the Workflow, as DYE2 unloads one, and answers 303
// to Streamline's `returnTo`. The rest of the Workflow stays as it is, the
// server unloads the Recipe, and later changes are not saved into it. A
// failed unload, or one that has not begun within the page's 3 s, is never
// made later. The plugin pushes `{"what":"skin"}` as the button is to show,
// hide or change its name. Through the built plugin in simulated tablets
// running DYE2 v0.1.26 as recorded (fixtures/decaid/dye2-v0.1.26/), on two
// server instances sharing one database, at a tenth of the plugin's usual
// test pace so the page's 3 s are 300 ms. Serials are made up, from 49201.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The plugin's timers run this many times faster than real time, so the Clear button's page waits 300 ms. */
const TIME_SCALE = 10;

/** The recording's tablet's record id of the Brazil's recipe, in slot 2. */
const BRAZIL = "2";

/** The dashboard's address, as Streamline sends it as `returnTo`. */
const RETURN_TO = "http://127.0.0.1:8080/index.html?view=dashboard";

const SKIN_PUSH = { what: "skin" };

const tablets = new LoadedTablets();

describe("The Clear button in Streamline's top bar", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await other?.stop();
    await server?.stop();
  });

  const records = (tablet: SimulatedTablet) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []);
  const record = (tablet: SimulatedTablet, id: string) => records(tablet).find((entry) => entry.id === id);
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe;
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) =>
    expect.poll(async () => (await loadedRecipe(machine))?.recipe.id ?? null, { timeout: 15_000 }).toBe(recipeId);
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  /** The surfaces the plugin answers `skin` with. */
  const surfaces = async (tablet: SimulatedTablet) => {
    const answer = await tablet.callEndpoint("skin");
    expect(answer.status).toBe(200);
    return (JSON.parse(answer.body) as { surfaces: Record_[] }).surfaces;
  };
  const button = (text: string) => ({ id: "clear", kind: "header-button", label: "Clear", text, action: { type: "open", view: "clear", presentation: "page" } });
  const skinPushes = (tablet: SimulatedTablet) => tablet.pushes("changed").filter((push) => (push as Record_).what === "skin").length;
  /** Taps the Clear button, as Streamline opens its view of `ui` as a page. */
  const tap = (tablet: SimulatedTablet, query: Record<string, string> = { view: "clear", returnTo: RETURN_TO }) => tablet.callEndpoint("ui", { query });
  /** How many times the plugin, or DYE2 for it, posted to DYE2's `record`, as a save into the Loaded Recipe does once. */
  const saves = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === `POST /plugins/${DYE2_NAMESPACE}/record`).length;
  /** The Workflow without the recipe it names. */
  const besidesRecipe = (workflow: Record_) => {
    const copy = structuredClone(workflow);
    delete ((((copy.context as Record_).extras as Record_).dye ?? {}) as Record_).recipeId;
    return copy;
  };
  /** Waits a while for what should not happen, as a save or an unload. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  /** A Location with a Machine whose tablet is the v0.1.26 recording's, its DYE2 loaded, whose recipes the server takes in. */
  async function lab(scenario: string, serial: number, options: { instance?: TestServer; apiDelayMs?: (method: string, path: string) => number } = {}) {
    const here: LocationView = await api.createLocation(`${scenario} clear`, "America/Chicago");
    const machine = await api.createMachine(`${scenario} clear 1`, here.id);
    const dye2 = new SimulatedDye2();
    const tablet = tablets.syncing(machine, options.instance ?? server, {
      api: recordedDye2MainTablet(String(serial), scenario),
      dye2,
      timeScale: TIME_SCALE,
      apiDelayMs: options.apiDelayMs,
    });
    await api.waitForOnline(machine);
    await expect.poll(() => dye2GlobalIdOf(record(tablet, BRAZIL)), { timeout: 15_000 }).not.toBeNull();
    return { machine, tablet, dye2, brazil: dye2GlobalIdOf(record(tablet, BRAZIL))! };
  }

  it("shows while the Machine has a Loaded Recipe, and a tap unloads it, leaving the rest of the Workflow, so later changes are not saved into it", async () => {
    const { machine, tablet, brazil } = await lab("Tap", 49201, { instance: other });
    expect(await surfaces(tablet)).toEqual([]);
    const name = String(record(tablet, BRAZIL)!.name);

    const pushed = skinPushes(tablet);
    await selectRecipeInDye2(tablet, BRAZIL);
    await loads(machine, brazil);
    await expect.poll(() => surfaces(tablet)).toEqual([button(`Unload ${name}`)]);
    expect(skinPushes(tablet)).toBe(pushed + 1);
    // With it loaded, a change is saved into it.
    await tablet.changeSettings({ context: { targetDoseWeight: 18.6 } });
    await expect.poll(async () => (await recipe(brazil)).content.dose, { timeout: 15_000 }).toBe(18.6);

    const before = structuredClone(tablet.workflow());
    const answer = await tap(tablet);
    expect(answer.status).toBe(303);
    expect(answer.headers).toMatchObject({ Location: RETURN_TO, "Cache-Control": "no-store" });
    expect(answer.body).toBe("");
    // Unloaded as DYE2 unloads one, before the dashboard reloads, and nothing else of the Workflow changed.
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    expect(besidesRecipe(tablet.workflow())).toEqual(besidesRecipe(before));
    expect(await surfaces(tablet)).toEqual([]);
    expect(skinPushes(tablet)).toBe(pushed + 2);
    await loads(machine, null);

    const saved = saves(tablet);
    await tablet.changeSettings({ context: { targetDoseWeight: 19.4 } });
    await settle();
    expect(saves(tablet)).toBe(saved);
    expect((await recipe(brazil)).content.dose).toBe(18.6);
    expect(await loadedRecipe(machine)).toBeNull();

    // Applied again, it loads again, and the button is back.
    await selectRecipeInDye2(tablet, BRAZIL);
    await loads(machine, brazil);
    await expect.poll(() => surfaces(tablet)).toEqual([button(`Unload ${name}`)]);
  });

  it("names the Loaded Recipe as its record does, cut to Streamline's 40 characters, and changes with it", async () => {
    const { machine, tablet, brazil } = await lab("Named", 49211);
    await selectRecipeInDye2(tablet, BRAZIL);
    await loads(machine, brazil);
    await expect.poll(() => surfaces(tablet)).toHaveLength(1);

    const pushed = skinPushes(tablet);
    // A name renamed in the management interface reaches the tablet's record, and the button. The emoji is cut whole.
    expect((await api.call("PATCH", `/recipes/${brazil}`, { content: { name: "Brazil Cerrado Mineiro natural 18 g \u{1F600}\u{1F600}" } })).status).toBe(200);
    await expect.poll(() => surfaces(tablet), { timeout: 15_000 }).toEqual([button("Unload Brazil Cerrado Mineiro natural 1…")]);
    expect(skinPushes(tablet)).toBe(pushed + 1);
    expect((await api.call("PATCH", `/recipes/${brazil}`, { content: { name: "Brazil \u{1F600}" } })).status).toBe(200);
    await expect.poll(() => surfaces(tablet), { timeout: 15_000 }).toEqual([button("Unload Brazil \u{1F600}")]);
    expect(skinPushes(tablet)).toBe(pushed + 2);
  });

  it("does not show on a Capture-only Machine, where a tap writes nothing", async () => {
    const { machine, tablet } = await lab("Capture", 49221);
    expect((await api.call("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    await expect.poll(async () => (await api.get<{ machine: { captureOnly: string[] } }>(`/machines/${machine.machine.id}`)).machine.captureOnly).toEqual(["sharingOff"]);
    await settle();

    await selectRecipeInDye2(tablet, BRAZIL);
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
    await settle();
    expect(await surfaces(tablet)).toEqual([]);
    expect(await loadedRecipe(machine)).toBeNull();
    expect((await tap(tablet)).status).toBe(303);
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
  });

  it("still returns to the dashboard when Decaid refuses the unload, logs why, and never tries it again", async () => {
    const { machine, tablet, brazil } = await lab("Refused", 49231);
    await selectRecipeInDye2(tablet, BRAZIL);
    await loads(machine, brazil);
    await expect.poll(() => surfaces(tablet)).toHaveLength(1);

    let refused = 0;
    tablet.refuseWrites = ({ method, route, body }) => {
      if (method !== "PUT" || route !== "/workflow" || !JSON.stringify(body).includes('"recipeId":null')) return undefined;
      refused++;
      return { status: 500, body: { error: "Internal server error", message: "Disk full" } };
    };
    try {
      const answer = await tap(tablet);
      expect([answer.status, answer.headers.Location]).toEqual([303, RETURN_TO]);
      await tablet.waitForLog(/^Could not unload the Loaded Recipe for the Clear button: Decaid answered 500 clearing the Workflow's recipe/);
      // Several of the plugin's polls later, nothing tried it again: the Recipe is still loaded, and the button still shows.
      await settle();
      expect(refused).toBe(1);
    } finally {
      tablet.refuseWrites = undefined;
    }
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(brazil);
    expect((await surfaces(tablet)).length).toBe(1);
  });

  it("never makes an unload that has not begun within the page's 3 s, as behind a slow save, after the page returned", async () => {
    let slow = false;
    let saving = false;
    // 10 s at the tablet's pace, a second here: the save holds the plugin's turn past the page's 3 s.
    const { machine, tablet, brazil } = await lab("Late", 49241, {
      apiDelayMs: (method, path) => {
        if (!slow || method !== "POST" || path !== `/plugins/${DYE2_NAMESPACE}/record`) return 0;
        saving = true;
        return 10_000;
      },
    });
    await selectRecipeInDye2(tablet, BRAZIL);
    await loads(machine, brazil);
    await expect.poll(() => surfaces(tablet)).toHaveLength(1);

    slow = true;
    await tablet.changeSettings({ context: { targetDoseWeight: 18.2 } });
    await expect.poll(() => saving).toBe(true);
    const answer = await tap(tablet);
    expect(answer.status).toBe(303);
    await tablet.waitForLog(/^Could not unload the Loaded Recipe for the Clear button: the unload had not begun within 3 s, so it is not made$/);
    // The save lands, and nothing unloads the Recipe after it.
    await expect.poll(async () => (await recipe(brazil)).content.dose, { timeout: 15_000 }).toBe(18.2);
    slow = false;
    await settle();
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
    expect((await loadedRecipe(machine))?.recipe.id).toBe(brazil);
    expect((await surfaces(tablet)).length).toBe(1);
  });

  it("goes back to returnTo for any other view, as the settings card's Open button opens, clearing nothing; answers 204 without a page to go back to, and nothing but GET", async () => {
    const { machine, tablet, brazil } = await lab("Views", 49251);
    await selectRecipeInDye2(tablet, BRAZIL);
    await loads(machine, brazil);

    const open = await tap(tablet, { returnTo: RETURN_TO });
    expect([open.status, open.headers.Location]).toEqual([303, RETURN_TO]);
    expect((await tap(tablet, { view: "settings", returnTo: RETURN_TO })).status).toBe(303);
    expect((await tap(tablet, {})).status).toBe(404);
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
    expect((await tablet.callEndpoint("ui", { method: "POST", query: { view: "clear", returnTo: RETURN_TO } })).status).toBe(405);
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);

    // A returnTo that is not a page to go back to: the unload is made, and the browser stays where it is.
    for (const returnTo of ["javascript:alert(1)", "http://user:pass@127.0.0.1/", "http://127.0.0.1/\r\nSet-Cookie: x=1"]) {
      const answer = await tap(tablet, { view: "clear", returnTo });
      expect([answer.status, answer.headers.Location, answer.headers["Cache-Control"]]).toEqual([204, undefined, "no-store"]);
    }
    expect(recipeIdInWorkflow(tablet)).toBeNull();
    await loads(machine, null);
    // With nothing loaded, a tap writes nothing.
    const puts = tablet.writes.filter((write) => write === "PUT /workflow").length;
    expect((await tap(tablet)).status).toBe(303);
    expect(tablet.writes.filter((write) => write === "PUT /workflow").length).toBe(puts);
  });

  it("does not show, and a tap writes nothing, on a tablet whose plugin has no settings", async () => {
    const tablet = tablets.load({ settings: {}, api: recordedDye2MainTablet("49261"), dye2: new SimulatedDye2() });
    await selectRecipeInDye2(tablet, BRAZIL);
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
    expect(await surfaces(tablet)).toEqual([]);
    expect((await tap(tablet)).status).toBe(303);
    expect(recipeIdInWorkflow(tablet)).toBe(BRAZIL);
  });
});
