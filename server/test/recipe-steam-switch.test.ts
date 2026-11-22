import { RECIPE_SETTINGS, type RecipeSetting, dye2GlobalIdOf, workflowValueAt } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { recipeNamedInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, dye2NeverUsed, openDye2Dashboard, openDye2RecipeEditor, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #616: steam on and off follows DYE2's own rules
// (ADR-0022, Steam on and off). A load switches steam as the Recipe holds
// it: one holding a steam temperature turns a Machine's steam on at its
// values, one holding "Off" turns it off, and one holding neither leaves it,
// the same from DYE2's dashboard, Streamline's strip from v0.2.29 and the
// plugin's own load write, for a Skin that applies nothing. "Off" is the
// Recipe's: saved in DYE2's editor or set in the management interface, it
// turns steam off on every Machine with the Recipe loaded. Nothing written
// from elsewhere turns a Machine's steam on, and steam turned on at a
// Machine whose Loaded Recipe holds "Off" makes the Recipe hold what it came
// back with. recipe-settings.test.ts covers steam turned off at a Machine's
// own switch, which stays no edit. Through the built plugin in simulated
// tablets running DYE2 and Streamline as recorded, Machines A and B on one
// server instance and C on another sharing one database, with assertions
// through the REST API and what each simulated tablet holds. Serials are
// made up, from 61001.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record ids: its library recipe, in slot 1, and the Brazil's, in slot 2. */
const LIBRARY = "05fd1e80-61e3-46ef-b202-2cbad5eb7983";
const BRAZIL = "2";

/** The steam the library recipe's Recipe is given. */
const HELD = { steamTemperature: 150, steamDuration: 30, steamFlow: 1.5 } satisfies Partial<Record<RecipeSetting, number>>;

/** What applies a recipe: DYE2's dashboard, Streamline's strip, or a Skin that only names it in the Workflow, leaving the rest to the plugin's load write. */
type AppliedBy = "dashboard" | "strip" | "skin";

describe("A load switches steam, and Off is the Recipe's (#616)", { timeout: 180_000 }, () => {
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
  const setting = (tablet: SimulatedTablet, name: RecipeSetting) => workflowValueAt(tablet.workflow(), RECIPE_SETTINGS[name].workflow);
  /** The tablet's Workflow's steam temperature and steam time. */
  const steam = (tablet: SimulatedTablet) => [setting(tablet, "steamTemperature"), setting(tablet, "steamDuration")];
  /** The steam temperature and steam time the tablet's record of a recipe holds, null for none. */
  const recorded = (tablet: SimulatedTablet, id: string) =>
    [RECIPE_SETTINGS.steamTemperature.dye2, RECIPE_SETTINGS.steamDuration.dye2].map((field) => variables(record(tablet, id))[field] ?? null);
  const recipe = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: { fields: Record_ }[] }>(`/recipes/${id}/history`)).versions;
  /** How many of the Recipe's versions set its steam temperature, and its steam time. */
  const steamEdits = async (id: string) => {
    const all = await versions(id);
    return ["steamTemperature", "steamDuration"].map((field) => all.filter((version) => field in version.fields).length);
  };
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine), { timeout: 15_000 }).toBe(recipeId);
  const patch = async (id: string, content: Record_) => expect((await api.call("PATCH", `/recipes/${id}`, { content })).status).toBe(200);
  /** A second between two events timed by different clocks (`docs/AI_BUILD_NOTES.md`, Seam 1). */
  const apart = () => new Promise((resolve) => setTimeout(resolve, 1_000));
  const OFF = { steamSettings: { targetTemperature: 0, duration: 0 } };

  /**
   * A Location with Machines A, whose tablet is the v0.1.26 recording's, and
   * B on one instance and C on the other, both tablets where DYE2 was never
   * used, each running DYE2 with its machine connected and Streamline as C's
   * Skin. A brings its recipes, and the library recipe's Recipe is given
   * HELD's steam, and `content` besides, before B and C join, so every
   * tablet's record holds them. Nothing is loaded. `load` applies a recipe
   * on a tablet (`AppliedBy`) and waits for its Machine to have it loaded;
   * `quiet()` resolves once every tablet, Streamline and the server have
   * nothing left under way (`quiesced`).
   */
  async function lab(scenario: string, serial: number, content: Record_ = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      b: await api.createMachine(`${scenario} lab B`, here.id),
      c: await api.createMachine(`${scenario} lab C`, here.id),
    };
    const a = syncingTablet(machines.a, server, { api: recordedDye2MainTablet(String(serial), scenario), dye2: new SimulatedDye2() });
    await api.waitForOnline(machines.a);
    await expect.poll(() => [LIBRARY, BRAZIL].map((id) => dye2GlobalIdOf(record(a, id))), { timeout: 15_000 }).not.toContain(null);
    const one = dye2GlobalIdOf(record(a, LIBRARY))!;
    const two = dye2GlobalIdOf(record(a, BRAZIL))!;
    await patch(one, { ...HELD, ...content });
    await expect.poll(() => variables(record(a, LIBRARY))[RECIPE_SETTINGS.steamFlow.dye2], { timeout: 15_000 }).toBe(HELD.steamFlow);
    const b = syncingTablet(machines.b, server, { api: dye2NeverUsed(String(serial + 1)), dye2: new SimulatedDye2() });
    const c = syncingTablet(machines.c, other, { api: dye2NeverUsed(String(serial + 2)), dye2: new SimulatedDye2() });
    await api.waitForOnline(machines.b, machines.c);
    for (const tablet of [b, c]) {
      await expect
        .poll(() => [LIBRARY, BRAZIL].map((id) => [dye2GlobalIdOf(record(tablet, id)), record(tablet, id)?.beanBatchId ?? null]).flat(), { timeout: 15_000 })
        .not.toContain(null);
      await expect.poll(() => variables(record(tablet, LIBRARY))[RECIPE_SETTINGS.steamFlow.dye2]).toBe(HELD.steamFlow);
    }
    // Decaid writes the steam settings to the machine, and refuses them without one.
    for (const tablet of [a, b, c]) tablet.connectMachine();
    const streamline = await startStreamline(c, { "last-steam-temp": 140, "last-steam-duration": 25 });
    const tablets: Record<string, SimulatedTablet> = { a, b, c };
    const quiet = () => quiesced(api, { tablets, machines, streamlines: { streamline } });
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, id: string, recipeId: string, by: AppliedBy) => {
      if (by === "dashboard") expect((await (await openDye2Dashboard(tablet)).applyRecipe(id)).workflow?.status).toBe(200);
      else if (by === "strip") expect((await streamline.applyRecipe(id)).selection?.status).toBe(200);
      else expect((await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id })).status).toBe(200);
      await expect.poll(() => recipeNamedInWorkflow(tablet), { timeout: 15_000 }).toBe(recipeId);
      await loads(machine, recipeId);
    };
    await quiet();
    return { machines, a, b, c, one, two, streamline, load, quiet };
  }

  it("turns steam on at the Recipe's steam temperature and time on a Machine whose steam was off, from DYE2's dashboard, Streamline's strip and the plugin's own write, with no edit of the Recipe; and a Recipe holding neither leaves steam as it is", async () => {
    const { machines, a, b, c, one, two, streamline, load, quiet } = await lab("On", 61001);
    for (const tablet of [a, b, c]) await tablet.changeSettings(OFF);
    await quiet();
    expect([steam(a), steam(b), steam(c)]).toEqual([[0, 0], [0, 0], [0, 0]]);
    const edits = await steamEdits(one);

    await load(a, machines.a, LIBRARY, one, "dashboard");
    await load(b, machines.b, LIBRARY, one, "skin");
    await load(c, machines.c, LIBRARY, one, "strip");
    for (const tablet of [a, b, c]) await expect.poll(() => steam(tablet), { timeout: 15_000 }).toEqual([150, 30]);
    await quiet();
    expect([steam(a), steam(b), steam(c)]).toEqual([[150, 30], [150, 30], [150, 30]]);
    // The strip turned steam on at the recipe's, not the ones Streamline remembered, which it keeps as the recipe's now.
    expect([streamline.remembered("last-steam-temp"), streamline.remembered("last-steam-duration")]).toEqual([150, 30]);
    expect((await recipe(one)).content).toMatchObject(HELD);
    expect(await steamEdits(one)).toEqual(edits);

    // The Brazil's Recipe holds no steam temperature or time: it leaves steam on where it is on, and off where it is off.
    const brazil = (await recipe(two)).content;
    expect([brazil.steamTemperature ?? null, brazil.steamDuration ?? null]).toEqual([null, null]);
    await b.changeSettings(OFF);
    await quiet();
    const before = await steamEdits(two);
    await load(a, machines.a, BRAZIL, two, "dashboard");
    await load(b, machines.b, BRAZIL, two, "skin");
    await load(c, machines.c, BRAZIL, two, "strip");
    await quiet();
    expect([steam(a), steam(b), steam(c)]).toEqual([[150, 30], [0, 0], [150, 30]]);
    const after = (await recipe(two)).content;
    expect([after.steamTemperature ?? null, after.steamDuration ?? null, await steamEdits(two)]).toEqual([null, null, before]);
    // Steam turned off at B's own switch changed no Recipe.
    expect((await recipe(one)).content).toMatchObject(HELD);
    expect(await steamEdits(one)).toEqual(edits);
  });

  it("turns steam off on a Machine that loads a Recipe holding Off, from DYE2's dashboard, Streamline's strip and the plugin's own write, the Recipe still holding Off; and steam turned on there makes the Recipe hold what it came back with, turning on no other Machine", async () => {
    const { machines, a, b, c, one, streamline, load, quiet } = await lab("Off", 61011, { steamTemperature: 0 });
    // "Off" is written as DYE2's editor saves it, a steam temperature and a steam time of 0; the Recipe keeps its steam time.
    for (const tablet of [a, b, c]) await expect.poll(() => recorded(tablet, LIBRARY), { timeout: 15_000 }).toEqual([0, 0]);
    expect((await recipe(one)).content).toMatchObject({ steamTemperature: 0, steamDuration: 30 });
    expect((record(c, LIBRARY)!.workflow as Record_).steamSettings).toMatchObject({ targetTemperature: 0, duration: 0 });
    for (const tablet of [a, b, c]) await tablet.changeSettings({ steamSettings: { targetTemperature: 160, duration: 40 } });
    await quiet();
    const edits = await steamEdits(one);

    await load(a, machines.a, LIBRARY, one, "dashboard");
    await load(b, machines.b, LIBRARY, one, "skin");
    await load(c, machines.c, LIBRARY, one, "strip");
    for (const tablet of [a, b, c]) await expect.poll(() => steam(tablet), { timeout: 15_000 }).toEqual([0, 0]);
    await quiet();
    expect([steam(a), steam(b), steam(c)]).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect((await recipe(one)).content).toMatchObject({ steamTemperature: 0, steamDuration: 30 });
    expect(await steamEdits(one)).toEqual(edits);
    expect([recorded(a, LIBRARY), recorded(b, LIBRARY), recorded(c, LIBRARY)]).toEqual([[0, 0], [0, 0], [0, 0]]);

    // A change on C that DYE2 saves while steam is off leaves "Off" in the record and the Recipe.
    await c.changeSettings({ rinseData: { duration: 7 } });
    await expect.poll(async () => (await recipe(one)).content.flushDuration, { timeout: 15_000 }).toBe(7);
    await quiet();
    expect([(await recipe(one)).content.steamTemperature, recorded(c, LIBRARY)]).toEqual([0, [0, 0]]);

    // C's heater switch brings steam back at what Streamline kept as the strip turned it off, which DYE2 saves into the
    // record holding "Off": the Recipe's edit.
    await streamline.setSteamHeater(true);
    await expect.poll(() => steam(c), { timeout: 15_000 }).toEqual([160, 40]);
    await expect.poll(async () => (await recipe(one)).content, { timeout: 15_000 }).toMatchObject({ steamTemperature: 160, steamDuration: 40 });
    for (const tablet of [a, b]) await expect.poll(() => recorded(tablet, LIBRARY), { timeout: 15_000 }).toEqual([160, 40]);
    await quiet();
    // A and B stay off: nothing written from elsewhere turns a Machine's steam on.
    expect([steam(a), steam(b), steam(c)]).toEqual([[0, 0], [0, 0], [160, 40]]);
    const turnedOn = await steamEdits(one);
    expect(turnedOn).toEqual([edits[0]! + 1, edits[1]! + 1]);

    // A's steam turned on from its own switch, with others, takes the Recipe's: no edit.
    await a.changeSettings({ steamSettings: { targetTemperature: 145, duration: 20 } });
    await expect.poll(() => steam(a), { timeout: 15_000 }).toEqual([160, 40]);
    await quiet();
    expect((await recipe(one)).content).toMatchObject({ steamTemperature: 160, steamDuration: 40 });
    expect(await steamEdits(one)).toEqual(turnedOn);
    expect(steam(b)).toEqual([0, 0]);
  });

  it("takes Off saved in DYE2's editor as the Recipe's, turning steam off on every Machine with it loaded, once; an edit from Off to a steam temperature turns none back on; and Off set in the management interface turns them off again", async () => {
    const { machines, a, b, c, one, two, streamline, load, quiet } = await lab("Editor", 61021);
    await load(a, machines.a, LIBRARY, one, "dashboard");
    await load(b, machines.b, BRAZIL, two, "dashboard");
    await load(c, machines.c, LIBRARY, one, "strip");
    await quiet();
    expect([steam(a), steam(c)]).toEqual([[150, 30], [150, 30]]);
    const ownOnB = steam(b);
    const edits = await steamEdits(one);

    // DYE2's editor on A saves "Off", a steam temperature and a steam time of 0, and applies the recipe again there.
    const saved = await (await openDye2RecipeEditor(a, { id: LIBRARY })).set({ steamTempC: 0 }).save();
    expect(saved.patch.dashboardVariables).toEqual({ steamTempC: 0, steamTimeS: 0 });
    await expect.poll(async () => (await recipe(one)).content.steamTemperature, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => steam(c), { timeout: 15_000 }).toEqual([0, 0]);
    await quiet();
    expect([steam(a), steam(c), steam(b)]).toEqual([[0, 0], [0, 0], ownOnB]);
    expect([recorded(a, LIBRARY), recorded(b, LIBRARY), recorded(c, LIBRARY)]).toEqual([[0, 0], [0, 0], [0, 0]]);
    // One edit, of the steam temperature: the steam time of 0 beside it is the other half of "Off", and no write of the
    // plugin's is saved back as a second.
    expect((await recipe(one)).content).toMatchObject({ steamTemperature: 0, steamDuration: 30 });
    expect(await steamEdits(one)).toEqual([edits[0]! + 1, edits[1]]);

    // Edited from "Off" to a steam temperature in the management interface: every record holds it, with the steam time the
    // Recipe kept, and no Machine's steam comes on.
    await apart();
    await patch(one, { steamTemperature: 155 });
    for (const tablet of [a, b, c]) await expect.poll(() => recorded(tablet, LIBRARY), { timeout: 15_000 }).toEqual([155, 30]);
    await quiet();
    expect([steam(a), steam(c)]).toEqual([[0, 0], [0, 0]]);
    const back = await steamEdits(one);

    // C's steam turned back on takes the Recipe's, which is no edit; A stays off.
    await streamline.setSteamHeater(true);
    await expect.poll(() => steam(c), { timeout: 15_000 }).toEqual([155, 30]);
    await quiet();
    expect([steam(a), await steamEdits(one)]).toEqual([[0, 0], back]);

    // "Off" set in the management interface turns C's steam off, as the editor's did.
    await apart();
    await patch(one, { steamTemperature: 0 });
    await expect.poll(() => steam(c), { timeout: 15_000 }).toEqual([0, 0]);
    await quiet();
    expect([steam(a), steam(c), steam(b)]).toEqual([[0, 0], [0, 0], ownOnB]);
    expect([recorded(a, LIBRARY), recorded(c, LIBRARY)]).toEqual([[0, 0], [0, 0]]);
    expect((await recipe(one)).content).toMatchObject({ steamTemperature: 0, steamDuration: 30 });

    // Cleared, the steam temperature is each Machine's own again: nothing is written, and its records hold the steam time.
    await apart();
    await patch(one, { steamTemperature: null });
    for (const tablet of [a, c]) await expect.poll(() => recorded(tablet, LIBRARY), { timeout: 15_000 }).toEqual([null, 30]);
    await quiet();
    expect([steam(a), steam(c)]).toEqual([[0, 0], [0, 0]]);
  });

  it("writes only the one of a steam temperature and a steam time a Recipe holds as it loads, the strip turning steam on with the other as Streamline remembers it, which no Recipe takes from the load", async () => {
    const { machines, a, c, one, two, streamline, load, quiet } = await lab("One of two", 61031);
    // The Brazil's Recipe holds a steam time and no steam temperature.
    await patch(two, { steamDuration: 35 });
    for (const tablet of [a, c]) await expect.poll(() => recorded(tablet, BRAZIL), { timeout: 15_000 }).toEqual([null, 35]);
    for (const tablet of [a, c]) await tablet.changeSettings(OFF);
    await quiet();
    const edits = await steamEdits(two);

    // Streamline's strip turns steam on with it, at the temperature it remembers (`recipeSteamPatch`).
    await load(c, machines.c, BRAZIL, two, "strip");
    await expect.poll(() => steam(c), { timeout: 15_000 }).toEqual([140, 35]);
    // DYE2's dashboard writes the time alone, which leaves steam off.
    await load(a, machines.a, BRAZIL, two, "dashboard");
    await expect.poll(() => steam(a), { timeout: 15_000 }).toEqual([0, 35]);
    await quiet();
    // A change on C that DYE2 saves finds the temperature where the apply left it, and saves none of it.
    await c.changeSettings({ rinseData: { duration: 6 } });
    await expect.poll(async () => (await recipe(two)).content.flushDuration, { timeout: 15_000 }).toBe(6);
    await quiet();
    expect([steam(c), steam(a)]).toEqual([[140, 35], [0, 35]]);
    const held = (await recipe(two)).content;
    expect([held.steamTemperature ?? null, held.steamDuration, await steamEdits(two)]).toEqual([null, 35, edits]);
    expect([recorded(a, BRAZIL), recorded(c, BRAZIL)]).toEqual([[null, 35], [null, 35]]);

    // The library recipe's Recipe holds a steam temperature and no steam time.
    await patch(one, { steamDuration: null });
    for (const tablet of [a, c]) await expect.poll(() => recorded(tablet, LIBRARY), { timeout: 15_000 }).toEqual([150, null]);
    for (const tablet of [a, c]) await tablet.changeSettings(OFF);
    await quiet();
    await streamline.keep("last-steam-duration", 25);
    const temperatureOnly = await steamEdits(one);
    await load(c, machines.c, LIBRARY, one, "strip");
    await expect.poll(() => steam(c), { timeout: 15_000 }).toEqual([150, 25]);
    await quiet();
    await c.changeSettings({ steamSettings: { flow: 1.7 } });
    await expect.poll(async () => (await recipe(one)).content.steamFlow, { timeout: 15_000 }).toBe(1.7);
    await quiet();
    expect(steam(c)).toEqual([150, 25]);
    const kept = (await recipe(one)).content;
    expect([kept.steamTemperature, kept.steamDuration ?? null, await steamEdits(one)]).toEqual([150, null, temperatureOnly]);
  });
});
