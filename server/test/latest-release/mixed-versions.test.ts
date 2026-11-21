import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  RECIPE_SETTINGS,
  WIRE_REVISION,
  dye2GlobalIdOf,
  globalIdOf,
  workflowValueAt,
} from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "../support/admin-api.js";
import { repoDir } from "../support/build-table.mjs";
import { latestReleaseDir, latestReleaseTag, releaseWireRevision } from "../support/latest-release.mjs";
import { emptyLibrary, recipeNamedInWorkflow, syncingTablet } from "../support/loaded-tablets.js";
import { quiesced } from "../support/quiet.js";
import { derivedShot, preheatShotFixture } from "../support/shot-fixtures.js";
import { DYE2_NAMESPACE, SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet, selectRecipeInDye2 } from "../support/simulated-dye2.js";
import { startStreamline } from "../support/simulated-streamline.js";
import { PluginStorage, RawConnection, type SimulatedTablet, derivedWorkflow, helloWith, readBuiltPlugin, settingsFor } from "../support/simulated-tablet.js";
import { derivedSteam, withSteams } from "../support/steam-fixtures.js";
import { type TestServer, startTestServer } from "../support/test-server.js";

// The mixed-versions suite (ADR-0025): through Seam 1, every pairing of the
// latest release and the change that a deploy creates. The latest release's
// plugin with the change's server, the change's plugin with the latest
// release's server, and the two servers as instances on one database, each
// holding a tablet. As in a deploy, the latest release's server starts first,
// and the change's migrates their database as it starts beside it.
//
// Every tablet is checked once its test has run. A plugin that logged it
// ignored a message from the server, or a server that refused a plugin with
// `protocol_error`, fails the test: either is a message one release sends
// that the other doesn't know, sent without the check that keeps it from the
// previous release. Capture is checked by each record's id alone, as what a
// server stores of a record may differ between releases. Serials are made up,
// from 28901.

/** What the plugin logs on a message from the server it can't read (plugin/src/connection.ts). */
const IGNORED = "Ignoring a message from the server";

// The defaults, set here as the tests rely on them. Heartbeats every 30 s:
// each checks its connection's token, so the test of a token reissued runs
// its tablets at real time, which then send none while it runs. 10 s for a
// hello: a connection refused for a late one is a protocol_error too, which
// a busy machine must not turn into a failure.
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "30" };

/** The fan threshold the tablets' machines start with (machine-settings.json), and an edit of it. */
const FAN_TO_40 = { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } };

/** Which release's plugin, or server: the change's, or the latest release's. */
type Release = "change" | "latest release";

/**
 * The directory of each release's plugin: the checkout's, or the latest
 * release's as committed at its tag. While main's version is still the latest
 * release's, the plugin's version can't tell them apart.
 */
const pluginDirs = (): Record<Release, string> => ({
  change: path.join(repoDir, "decent-sync.reaplugin"),
  "latest release": path.join(latestReleaseDir(), "decent-sync.reaplugin"),
});

/** Each release's wire revision: the change's, and the latest release's as its tag sets it, 1 where it sets none. */
const wireRevisions = (): Record<Release, number> => ({ change: WIRE_REVISION, "latest release": releaseWireRevision(latestReleaseTag()) });

interface SettingsEditView {
  id: string;
  outcome: string | null;
}

describe("the latest release beside the change", () => {
  let servers: Record<Release, TestServer>;
  /** The Admin on each release's server. */
  let apis: Record<Release, AdminApi>;
  let serial = 28_901;
  /** The tablets the running test loaded, checked once it has run. */
  const loaded: SimulatedTablet[] = [];

  beforeAll(async () => {
    // Kept as soon as it starts, so that afterAll stops it if the change's fails to.
    servers = {} as Record<Release, TestServer>;
    servers["latest release"] = await startTestServer({ env, latestRelease: true });
    servers.change = await startTestServer({ env, sharing: servers["latest release"] });
    const api = await AdminApi.setUp(servers.change.url);
    apis = { change: api, "latest release": api.at(servers["latest release"].url) };
  });
  afterEach(() => {
    const dirs = pluginDirs();
    for (const tablet of loaded.splice(0)) {
      const plugin = tablet.pluginDir === dirs.change ? "the change's plugin" : "the latest release's plugin";
      // The first of each, as a plugin refused reconnects and is refused again.
      expect(tablet.logs.find((line) => line.includes(IGNORED)), `${plugin} ignored a message from the server`).toBeUndefined();
      const refusal = tablet.received.find((frame) => {
        const { type, code } = frame as { type?: unknown; code?: unknown };
        return type === "error" && code === "protocol_error";
      });
      expect(refusal, `the server refused ${plugin}`).toBeUndefined();
    }
  });
  afterAll(async () => {
    await servers?.["latest release"]?.stop();
  });

  /**
   * A Machine, at the Location if one is given, whose tablet runs that
   * release's plugin, connected to that release's server, its Decaid's
   * Library empty and holding the Steam Records given; once the Machine is
   * online.
   */
  async function connected(
    name: string,
    plugin: Release,
    server: Release,
    options: { location?: LocationView; steams?: Record<string, unknown>[]; timeScale?: number } = {},
  ): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await apis.change.createMachine(name, options.location?.id);
    const tablet = syncingTablet(machine, servers[server], {
      latestRelease: plugin === "latest release",
      api: withSteams(emptyLibrary(serial++), options.steams ?? []),
      timeScale: options.timeScale,
    });
    loaded.push(tablet);
    expect(tablet.pluginDir).toBe(pluginDirs()[plugin]);
    await apis.change.waitForOnline(machine);
    return { machine, tablet };
  }

  const heldGrinder = (tablet: SimulatedTablet, id: string) => tablet.grinders().find((record) => globalIdOf(record) === id);
  const machineSettings = async (machine: CreatedMachine) =>
    (await apis.change.get<{ collection: { value: Record<string, unknown> } | null }>(`/machines/${machine.machine.id}/collections/machineSettings`)).collection?.value;
  /** Makes the edit of the fan threshold through that release's server, and resolves with its outcome, once it has one. */
  async function editFan(machine: CreatedMachine, through: Release): Promise<string | null> {
    // The machine's settings as the tablet reported them, which the edit expects.
    await expect.poll(async () => (await machineSettings(machine))?.fan).toBe(50);
    const edits = `/machines/${machine.machine.id}/settings-edits`;
    const made = (await apis[through].send<{ settingsEdit: SettingsEditView }>("POST", edits, FAN_TO_40, 201)).settingsEdit;
    const outcome = async () => (await apis.change.get<{ settingsEdit: SettingsEditView }>(`${edits}/${made.id}`)).settingsEdit.outcome;
    await expect.poll(outcome).not.toBeNull();
    return outcome();
  }
  /** The fan threshold the tablet's Decaid holds, read as another app on the tablet would. */
  const heldFan = async (tablet: SimulatedTablet) => ((await tablet.callApi("GET", "/machine/settings")).body as { fan?: unknown }).fan;

  it("runs each release's server, and each release's plugin logs the message the suite looks for", () => {
    // Which tree each runs: while main's version is still the latest release's, nothing else tells them apart.
    expect(servers.change.buildDir).toBe(repoDir);
    expect(servers["latest release"].buildDir).toBe(latestReleaseDir());
    // A plugin that no longer logged it would pass this suite whatever it ignored.
    expect(readBuiltPlugin({ latestRelease: true }).source).toContain(IGNORED);
    expect(readBuiltPlugin().source).toContain(IGNORED);
  });

  describe.each([
    { pairing: "the latest release's plugin with the change's server", plugin: "latest release", server: "change" },
    { pairing: "the change's plugin with the latest release's server", plugin: "change", server: "latest release" },
  ] as const)("$pairing", ({ plugin, server }) => {
    const id = (what: string) => `mixed-${plugin.replace(" ", "-")}-plugin-${what}`;

    it("welcomes the plugin, each sending the wire revision it has, or none from a release before it", async () => {
      const { tablet } = await connected(`Wire revision, the ${plugin}'s plugin`, plugin, server);
      const revisions = wireRevisions();
      // The Machine is online once the server has accepted the hello, which it answers a query later, so the welcome may
      // still be on its way.
      await expect.poll(() => tablet.received.length).toBeGreaterThan(0);
      const [hello, welcome] = [tablet.sent[0], tablet.received[0]] as { type?: unknown; wireRevision?: unknown }[];
      expect(hello).toMatchObject({ type: "hello" });
      // A plugin or server of 1.3.1 or earlier sends none, so is at revision 1.
      expect(hello!.wireRevision ?? 1).toBe(revisions[plugin]);
      expect(welcome).toMatchObject({ type: "welcome" });
      expect(welcome!.wireRevision ?? 1).toBe(revisions[server]);
      expect(tablet.logs.filter((line) => line.startsWith("The server needs upgrading"))).toEqual([]);
    });

    it("captures a Shot, a Steam Record and Workflow changes", async () => {
      const steam = derivedSteam(id("steam"));
      const { machine, tablet } = await connected(`Capture, the ${plugin}'s plugin`, plugin, server, { steams: [steam] });
      const shot = derivedShot(id("shot"));
      tablet.pullShot(shot);
      tablet.setWorkflow(derivedWorkflow({ targetYield: 40, grinderSetting: "7.5" }));

      const api = apis[server];
      await expect.poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);
      await expect.poll(async () => (await api.call("GET", `/steam-records/${steam.id}`)).status).toBe(200);
      const workflows = async () =>
        (await api.get<{ events: { workflow: { context: unknown } }[] }>(`/machines/${machine.machine.id}/workflow-events?limit=100`)).events.map(
          (event) => event.workflow.context,
        );
      await expect.poll(workflows).toContainEqual(expect.objectContaining({ targetYield: 40, grinderSetting: "7.5" }));
    });

    it("writes a Library edit made in the management interface to the tablet, and takes in one made on the tablet", async () => {
      const api = apis[server];
      const location = await api.createLocation(`Library, the ${plugin}'s plugin`, "America/Chicago");
      const { tablet } = await connected(`Library, the ${plugin}'s plugin`, plugin, server, { location });
      const { grinder } = await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: location.id, content: { model: "EG-1" } }, 201);
      await expect.poll(() => heldGrinder(tablet, grinder.id)).toMatchObject({ model: "EG-1" });

      await api.send("PATCH", `/grinders/${grinder.id}`, { content: { notes: "Edited in the management interface" } });
      await expect.poll(() => heldGrinder(tablet, grinder.id)?.notes).toBe("Edited in the management interface");

      await tablet.editGrinder(heldGrinder(tablet, grinder.id)!.id, { notes: "Edited on the tablet" });
      await expect.poll(async () => (await api.get<{ grinder: { content: { notes?: unknown } } }>(`/grinders/${grinder.id}`)).grinder.content.notes).toBe(
        "Edited on the tablet",
      );
    });

    // A Grinder's range and defaults (#551), which a tablet's record holds in its `extras`. 1.10.0's plugin writes them
    // at the record's top, where Decaid drops them, and 1.10.0's server takes none in from a record. Neither loses one
    // the other holds: a tablet written none is not taken to have cleared the Grinder's, and one typed on a tablet
    // stays in its record through that server's writes.
    it("keeps a Grinder's range and defaults where the other release knows none of them", async () => {
      const api = apis[server];
      const location = await api.createLocation(`Range, the ${plugin}'s plugin`, "America/Chicago");
      const { tablet } = await connected(`Range, the ${plugin}'s plugin`, plugin, server, { location });
      const range = { settingMin: 0, settingMax: 10, rpmDefault: 900 };
      if (server === "change") {
        const { grinder } = await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: location.id, content: { model: "Ranged EG-1", ...range } }, 201);
        await expect.poll(() => heldGrinder(tablet, grinder.id)).toMatchObject({ model: "Ranged EG-1" });
        await api.send("PATCH", `/grinders/${grinder.id}`, { content: { settingDefault: 4 } });
        // An edit on the tablet, whose record holds whatever its plugin could write of them, is its notes alone.
        await tablet.editGrinder(heldGrinder(tablet, grinder.id)!.id, { notes: "Edited on the tablet" });
        const content = async () => (await api.get<{ grinder: { content: Record<string, unknown> } }>(`/grinders/${grinder.id}`)).grinder.content;
        await expect.poll(async () => (await content()).notes).toBe("Edited on the tablet");
        expect(await content()).toMatchObject({ ...range, settingDefault: 4 });
        const history = (await api.get<{ versions: { fields: Record<string, unknown> }[] }>(`/grinders/${grinder.id}/history`)).versions;
        expect(history.map((version) => Object.keys(version.fields)).filter((fields) => fields.some((field) => field in range) && !fields.includes("model"))).toEqual([]);
      } else {
        const record = await tablet.addGrinder({ model: "Ranged EG-2", extras: { bcUuid: "fixture-bc-uuid", ...range } });
        const listed = async () => (await api.get<{ grinders: { id: string; model: string | null }[] }>("/grinders")).grinders.find((grinder) => grinder.model === "Ranged EG-2");
        await expect.poll(listed).toBeDefined();
        const grinder = (await listed())!;
        await expect.poll(() => heldGrinder(tablet, grinder.id)?.id).toBe(record.id);
        await api.send("PATCH", `/grinders/${grinder.id}`, { content: { notes: "Edited in the management interface" } });
        await expect.poll(() => heldGrinder(tablet, grinder.id)?.notes).toBe("Edited in the management interface");
        expect(heldGrinder(tablet, grinder.id)?.extras).toMatchObject({ bcUuid: "fixture-bc-uuid", ...range });
      }
    });

    it("writes a Settings Edit and confirms it", async () => {
      const location = await apis[server].createLocation(`Settings, the ${plugin}'s plugin`, "America/Chicago");
      const { machine, tablet } = await connected(`Settings, the ${plugin}'s plugin`, plugin, server, { location });
      expect(await editFan(machine, server)).toBe("applied");
      expect(await heldFan(tablet)).toBe(40);
    });
  });

  // Turning steam back on takes the Loaded Recipe's steam temperature in the
  // plugin alone (ADR-0022, #374), so a tablet with the change's plugin keeps
  // the rule on the latest release's server. One with 1.6.0's plugin saves
  // the temperature steam came back at into the Recipe, on either server, as
  // that release did.
  it("turns steam back on at the Loaded Recipe's steam temperature with the change's plugin on the latest release's server, saving nothing of the one it came back at", async () => {
    const api = apis["latest release"];
    const location = await api.createLocation("Steam back on, the change's plugin", "America/Chicago");
    const machine = await api.createMachine("Steam back on, the change's plugin", location.id);
    const dye2 = new SimulatedDye2();
    const tablet = syncingTablet(machine, servers["latest release"], { api: recordedDye2MainTablet(String(serial++), "Steam back on"), dye2 });
    loaded.push(tablet);
    expect(tablet.pluginDir).toBe(pluginDirs().change);
    await apis.change.waitForOnline(machine);
    // The recording's library recipe, which the tablet brings to the Location.
    const record = () => (dye2List(tablet, "recipes") as Record<string, unknown>[] | null)?.find((entry) => entry.id === "05fd1e80-61e3-46ef-b202-2cbad5eb7983");
    const held = () => ((record()?.dashboardVariables ?? {}) as Record<string, unknown>).steamTempC;
    const steam = () => workflowValueAt(tablet.workflow(), RECIPE_SETTINGS.steamTemperature.workflow);
    await expect.poll(() => dye2GlobalIdOf(record())).not.toBeNull();
    const recipeId = dye2GlobalIdOf(record())!;
    await api.send("PATCH", `/recipes/${recipeId}`, { content: { steamTemperature: 160 } });
    await expect.poll(held).toBe(160);
    tablet.connectMachine();
    expect((await (await openDye2Dashboard(tablet)).applyRecipe("05fd1e80-61e3-46ef-b202-2cbad5eb7983")).workflow?.status).toBe(200);
    await expect.poll(() => recipeNamedInWorkflow(tablet)).toBe(recipeId);
    const loadedRecipe = async () =>
      (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.machine.id}`)).machine.loadedRecipe?.recipe.id;
    await expect.poll(loadedRecipe).toBe(recipeId);
    // Streamline's heater switch with its DYE2 switch off turns steam back on at the 140 °C it remembers.
    const streamline = await startStreamline(tablet, { "last-steam-temp": 140 }, { dye2Enabled: false });
    await tablet.changeSettings({ steamSettings: { targetTemperature: 0 } });
    // The sharing status as the latest release's server plans what the tablet is due: the change's plans writes it doesn't.
    const quiet = () => quiesced(api, { tablets: { tablet }, machines: { machine }, streamlines: { streamline } });
    // Once the tablet's report of steam off, and anything it set off, are done.
    await quiet();
    const saves = dye2.recorded.length;
    await streamline.setSteamHeater(true);
    await expect.poll(steam).toBe(160);
    // Once the report of the heater on, the plugin's write and its save are done.
    await quiet();
    const content = async () => (await api.get<{ recipe: { content: Record<string, unknown> } }>(`/recipes/${recipeId}`)).recipe.content;
    expect([dye2.recorded.slice(saves).filter(({ patch }) => "steamTempC" in patch), held(), (await content()).steamTemperature]).toEqual([[], 160, 160]);
  });

  // A Recipe is the whole Shot (#550): a Machine that loads one is left with
  // none of what it names none of, whatever applied it. The change's server
  // clears them through a write of the Loaded Recipe holding a null for each
  // part, its yield 0, which the latest release's plugin writes as any other
  // value, its own load write clearing nothing but the Bean, so the wire is
  // unchanged. The latest release's server still takes what a Recipe holds
  // none of from the Workflow as it loads, and writes it back: beside it,
  // while a deploy runs, a Recipe applied by DYE2 v0.1.40, which clears the
  // Workflow itself, takes at most a yield of 0, which is stop-at-weight
  // off, and one applied by a Skin that clears nothing takes the Workflow's
  // values as it did in that release.
  it("leaves a tablet with none of what its Loaded Recipe names none of: on the latest release's plugin by the change's server's write, where a Skin clears nothing, and on the change's plugin on the latest release's server, where DYE2 clears as it applies", async () => {
    type Record_ = Record<string, unknown>;
    const ETHIOPIA = "1";
    for (const { name, plugin, server } of [
      { name: "the latest release's plugin", plugin: "latest release", server: "change" },
      { name: "the change's plugin on the latest release", plugin: "change", server: "latest release" },
    ] as const) {
      const api = apis[server];
      const location = await api.createLocation(`Whole Shot, ${name}`, "America/Chicago");
      const machine = await api.createMachine(`Whole Shot, ${name}`, location.id);
      const dye2 = new SimulatedDye2();
      const tablet = syncingTablet(machine, servers[server], { latestRelease: plugin === "latest release", api: recordedDye2MainTablet(String(serial++), `Whole Shot ${server}`), dye2 });
      loaded.push(tablet);
      expect(tablet.pluginDir).toBe(pluginDirs()[plugin]);
      await apis.change.waitForOnline(machine);
      const records = () => (dye2List(tablet, "recipes") as Record_[] | null) ?? [];
      await expect.poll(() => dye2GlobalIdOf(records().find((entry) => entry.id === ETHIOPIA)), { timeout: 15_000 }).not.toBeNull();
      const ethiopia = dye2GlobalIdOf(records().find((entry) => entry.id === ETHIOPIA))!;
      const content = async (id: string) => (await api.get<{ recipe: { content: Record_ } }>(`/recipes/${id}`)).recipe.content;
      // A Recipe naming a Profile alone, made in the management interface, once the tablet holds its record.
      const { recipe: bare } = await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: location.id, slot: 3, content: { name: "Whole Shot Bare", profileId: (await content(ethiopia)).profileId } }, 201);
      await expect.poll(() => records().find((entry) => dye2GlobalIdOf(entry) === bare.id)?.id ?? null, { timeout: 15_000 }).not.toBeNull();
      const bareRecord = String(records().find((entry) => dye2GlobalIdOf(entry) === bare.id)!.id);
      const loadedRecipe = async () => (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.machine.id}`)).machine.loadedRecipe?.recipe.id;
      const quiet = () => quiesced(api, { tablets: { tablet }, machines: { machine } });
      const context = () => (tablet.workflow().context ?? {}) as Record_;
      const held = () => {
        const extras = (context().extras ?? {}) as Record_;
        return [context().grinderId ?? null, context().grinderSetting ?? null, extras.basketId ?? null, context().targetDoseWeight ?? null, context().targetYield ?? null, extras.rpm ?? null];
      };

      // The Ethiopia, naming each, applied from DYE2's Select Recipe page.
      expect((await selectRecipeInDye2(tablet, ETHIOPIA)).applied?.workflow?.status, name).toBe(200);
      await expect.poll(loadedRecipe, { timeout: 15_000 }).toBe(ethiopia);
      await quiet();
      expect(held(), name).not.toContain(null);
      // Then the bare one: named with nothing cleared, as a Skin that clears nothing applies it, where the change's server
      // holds the tablet; and from DYE2's dashboard, which clears as it applies, where the latest release's does.
      if (server === "change") expect((await tablet.callApi("POST", `/plugins/${DYE2_NAMESPACE}/selection`, { kind: "recipe", id: bareRecord })).status, name).toBe(200);
      else expect((await (await openDye2Dashboard(tablet)).applyRecipe(bareRecord)).workflow?.status, name).toBe(200);
      await expect.poll(loadedRecipe, { timeout: 15_000 }).toBe(bare.id);
      await expect.poll(held, { timeout: 15_000 }).toEqual([null, null, null, null, 0, null]);
      await quiet();
      expect(held(), name).toEqual([null, null, null, null, 0, null]);
      // Nothing is taken into the Recipe as it loads, but a yield of 0 by the latest release's server.
      for (const field of ["grinderId", "grindSetting", "basketId", "dose", "rpm"]) expect(await content(bare.id), `${name}: ${field}`).not.toHaveProperty(field);
      if (server === "change") expect(await content(bare.id), name).not.toHaveProperty("yield");
      else expect((await content(bare.id)).yield ?? 0, name).toBe(0);
    }
  });

  // A request puts a Recipe in a slot of 6 to 9 (#502), which each release's
  // server and plugin read and keep (#506): the Recipe is in the slot the
  // change's server put it in on every tablet, whichever release's plugin it
  // runs and whichever release's instance holds it.
  it("keeps a Recipe put in slot 7 through REST in slot 7, on each release's plugin and each release's instance, through their reports", async () => {
    const api = apis.change;
    const location = await api.createLocation("Slot 7 through REST", "America/Chicago");
    const pairings = [
      { name: "the change's plugin", plugin: "change", server: "change" },
      { name: "the latest release's plugin", plugin: "latest release", server: "change" },
      { name: "on the latest release", plugin: "latest release", server: "latest release" },
      { name: "the change's plugin on the latest release", plugin: "change", server: "latest release" },
    ] as const;
    const tablets: SimulatedTablet[] = [];
    for (const { name, plugin, server } of pairings) tablets.push((await connected(`Slot 7 through REST, ${name}`, plugin, server, { location })).tablet);
    type Record_ = Record<string, unknown>;
    type Slotted = { recipe: { id: string; slot: number | null; name: string | null } };
    const record = (tablet: SimulatedTablet, id: string) => (dye2List(tablet, "recipes") as Record_[] | null)?.find((entry) => dye2GlobalIdOf(entry) === id);
    /** Each tablet's record of each Recipe: its slot, and whether it is shown. */
    const held = (...ids: string[]) => tablets.map((tablet) => ids.map((id) => [record(tablet, id)?.stripSlot, record(tablet, id)?.showOnStreamlineDashboard]));
    const onEach = <T>(value: T) => tablets.map(() => value);
    /** What each tablet holds of a Recipe in slot 7: the slot, shown. */
    const inSeven = [7, true];
    /** The Recipe as each release's server reads it. */
    const read = async (id: string) => [(await api.get<Slotted>(`/recipes/${id}`)).recipe, (await apis["latest release"].get<Slotted>(`/recipes/${id}`)).recipe];

    const { recipe } = await api.send<Slotted>("POST", "/recipes", { locationId: location.id, slot: 1, content: { name: "Seven", dose: 18, yield: 36 } }, 201);
    await expect.poll(() => held(recipe.id)).toEqual(onEach([[1, true]]));

    // Moved to slot 7 through the change's server: each tablet's record holds stripSlot 7, shown.
    expect((await api.send<Slotted>("PUT", `/recipes/${recipe.id}/slot`, { slot: 7 })).recipe.slot).toBe(7);
    await expect.poll(() => held(recipe.id)).toEqual(onEach([inSeven]));
    expect((await read(recipe.id)).map(({ slot }) => slot)).toEqual([7, 7]);

    // A report from each tablet, of an edit there, keeps the Recipe in slot 7 and reaches the others.
    const route = "/store/dye2.reaplugin/recipes";
    for (const [index, tablet] of tablets.entries()) {
      const name = `Seven, renamed ${index + 1}`;
      const list = (await tablet.callApi("GET", route)).body as Record_[];
      expect((await tablet.callApi("POST", route, list.map((entry) => (dye2GlobalIdOf(entry) === recipe.id ? { ...entry, name, title: name } : entry)))).status).toBe(200);
      await expect.poll(async () => (await read(recipe.id)).map((seen) => seen.name)).toEqual([name, name]);
      await expect.poll(() => tablets.map((other) => record(other, recipe.id)?.name)).toEqual(onEach(name));
      expect((await read(recipe.id)).map(({ slot }) => slot)).toEqual([7, 7]);
      expect(held(recipe.id)).toEqual(onEach([inSeven]));
    }

    // Another created in slot 7 through the change's server takes the slot, and the first is kept in none, on every tablet.
    const { recipe: taking } = await api.send<Slotted>("POST", "/recipes", { locationId: location.id, slot: 7, content: { name: "Seven too", dose: 18, yield: 36 } }, 201);
    await expect.poll(() => held(taking.id, recipe.id)).toEqual(onEach([inSeven, [null, false]]));
    expect([(await read(taking.id)).map(({ slot }) => slot), (await read(recipe.id)).map(({ slot }) => slot)]).toEqual([[7, 7], [null, null]]);
  });

  // A Skin's requests (#507, ADR-0030) are answered by each release's server
  // and sent by each release's plugin, so a Skin is answered whichever
  // release's instance holds its tablet, as during a deploy, and whichever
  // release's plugin the tablet runs.
  it("answers a Skin whichever release's instance holds its tablet, and whichever release's plugin it runs", async () => {
    const location = await apis.change.createLocation("Skin status, both releases", "America/Chicago");
    const status = async (tablet: SimulatedTablet) => {
      const answer = await tablet.callEndpoint("status");
      return { status: answer.status, body: JSON.parse(answer.body) as Record<string, unknown> };
    };
    /** Once the plugin has been welcomed, as a Skin listening is told. */
    const welcomed = (tablet: SimulatedTablet) => expect.poll(() => tablet.pushes("changes").at(-1)).toEqual({ what: "connection", connected: true });
    const served = (machine: CreatedMachine) => ({
      status: 200,
      body: { connected: true, served: true, machine: { id: machine.machine.id, name: machine.machine.name }, location: { id: location.id, name: location.name } },
    });
    const noShots = [200, { shots: [], nextCursor: null }];
    const shots = async (tablet: SimulatedTablet) => {
      const listed = await tablet.callEndpoint("shots");
      return [listed.status, JSON.parse(listed.body)];
    };

    // The change's plugin, held by the latest release's instance.
    const held = await connected("Skin status, held by the latest release", "change", "latest release", { location });
    await welcomed(held.tablet);
    expect(await status(held.tablet)).toEqual(served(held.machine));
    expect(await shots(held.tablet)).toEqual(noShots);
    // Held by the change's instance, as once the deploy is done.
    const moved = await held.tablet.reload({ settings: { ...settingsFor({ token: held.machine.token, serverUrl: servers.change.url }), PollSeconds: 5 } });
    loaded.push(moved);
    await welcomed(moved);
    expect(await status(moved)).toEqual(served(held.machine));
    expect(await shots(moved)).toEqual(noShots);

    // The latest release's plugin on the change's server, and Streamline's endpoint as it was.
    const behind = await connected("Skin status, the latest release's plugin", "latest release", "change", { location });
    await welcomed(behind.tablet);
    expect(await status(behind.tablet)).toEqual(served(behind.machine));
    expect(await shots(behind.tablet)).toEqual(noShots);
    const skin = await behind.tablet.callEndpoint("skin");
    expect([skin.status, JSON.parse(skin.body)]).toEqual([200, { version: 1, surfaces: [], live: { endpoint: "changed" } }]);
  });

  // Each release's server sends a tablet the Reference Shot copies it is due
  // (#510), and each release's plugin says which it holds and keeps them, so
  // a copy reaches every tablet, whichever release's plugin it runs and
  // whichever release's instance holds it.
  it("sends each tablet its Reference Shot copy, whichever release's plugin it runs and whichever release's instance holds it", async () => {
    const location = await apis.change.createLocation("Reference copies, both releases", "America/Chicago");
    const typed = (frames: unknown[], type: string) => frames.filter((frame) => (frame as { type?: unknown }).type === type);
    const recipeRecords = (tablet: SimulatedTablet) => {
      const list = dye2List(tablet, "recipes");
      return Array.isArray(list) ? list.filter((record) => dye2GlobalIdOf(record) !== null) : [];
    };
    const current = await connected("Reference copies, the change's plugin", "change", "change", { location });
    const behind = await connected("Reference copies, the latest release's plugin", "latest release", "change", { location });
    const held = await connected("Reference copies, held by the latest release", "change", "latest release", { location });

    // A Shot, and a Recipe in a slot whose Reference Shot it is, chosen through the change's server.
    current.tablet.pullShot(derivedShot("mixed-reference-shot"));
    await expect.poll(async () => (await apis.change.call("GET", "/shots/mixed-reference-shot")).status).toBe(200);
    const { recipe } = await apis.change.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: location.id, slot: "next", content: { name: "Mixed reference" } }, 201);
    await apis.change.send("PUT", `/recipes/${recipe.id}/reference-shot`, { shotId: "mixed-reference-shot" });

    // Every tablet is written the Recipe and keeps its copy.
    for (const { tablet } of [current, behind, held]) {
      await expect.poll(() => recipeRecords(tablet).length).toBe(1);
      await expect.poll(() => String(tablet.storage.read("reference.1"))).toContain("mixed-reference-shot");
      expect(typed(tablet.sent, "referencesHeld")).toEqual([{ type: "referencesHeld", held: {} }]);
    }
    // Asked for the reference, the tablet the latest release's server holds answers from that server.
    const answer = await held.tablet.callEndpoint("reference", { query: { recipe: String((recipeRecords(held.tablet)[0] as { id: unknown }).id) } });
    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, expect.objectContaining({ reference: expect.objectContaining({ shot: expect.objectContaining({ id: "mixed-reference-shot" }) }) })]);
  });

  // Choosing a Reference Shot from a tablet (#511) is a request each
  // release's server answers: a tablet the latest release's instance holds,
  // as during a deploy, has the choice made by that server.
  it("makes a Skin's choice of a Reference Shot through the latest release's server while it holds the tablet", async () => {
    const location = await apis.change.createLocation("Reference choices, both releases", "America/Chicago");
    const recipeRecords = (tablet: SimulatedTablet) => {
      const list = dye2List(tablet, "recipes");
      return Array.isArray(list) ? list.filter((record) => dye2GlobalIdOf(record) !== null) : [];
    };
    const referenceShot = async (id: string) => (await apis.change.get<{ recipe: { referenceShot: { id: string } | null } }>(`/recipes/${id}`)).recipe.referenceShot?.id ?? null;
    const held = await connected("Reference choices, held by the latest release", "change", "latest release", { location });
    // Pulled now, on the tablet's own machine, so it is one of the Location's Shots, which its tablet may choose.
    const fixture = derivedShot("mixed-chosen-shot", { timestamp: new Date().toISOString() });
    const { model, serialNumber } = (await held.tablet.callApi("GET", "/machine/info")).body as { model: string; serialNumber: string };
    const workflow = fixture.workflow as Record<string, unknown>;
    held.tablet.pullShot({ ...fixture, workflow: { ...workflow, machine: { ...(workflow.machine as Record<string, unknown>), model, serialNumber } } });
    await expect.poll(async () => (await apis.change.get<{ shots: { id: string }[] }>(`/shots?locationId=${location.id}`)).shots.map((shot) => shot.id)).toEqual(["mixed-chosen-shot"]);
    const { recipe } = await apis.change.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: location.id, slot: "next", content: { name: "Mixed choice" } }, 201);
    await expect.poll(() => recipeRecords(held.tablet).length).toBe(1);

    const answer = await held.tablet.callEndpoint("reference", { method: "PUT", query: { recipe: String((recipeRecords(held.tablet)[0] as { id: unknown }).id) }, body: { shotId: "mixed-chosen-shot" } });
    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      200,
      expect.objectContaining({ reference: expect.objectContaining({ shot: expect.objectContaining({ id: "mixed-chosen-shot" }) }), source: "server" }),
    ]);
    // As the change's server reads it.
    expect(await referenceShot(recipe.id)).toBe("mixed-chosen-shot");
  });

  // A Skin edits a Shot's rating and note through the plugin (#515). A Shot
  // its tablet holds is written through Decaid's own Shot update, which
  // needs no server, and the edit reaches the instance holding the tablet as
  // any edit made on it. Any other Shot is a request, which each release's
  // server answers: the latest release's instance, holding the tablet as
  // during a deploy, makes the edit, and it is written to the Shot's own
  // tablet, which the change's instance holds.
  it("edits a tablet's own Shot through Decaid, and another tablet's through the latest release's server while it holds the tablet", async () => {
    const api = apis.change;
    type Record_ = Record<string, unknown>;
    const location = await api.createLocation("Shot edits from a tablet, both releases", "America/Chicago");
    const held = await connected("Tablet edits, held by the latest release", "change", "latest release", { location });
    const other = await connected("Tablet edits, the other tablet", "change", "change", { location });
    // Pulled now, each on its tablet's own machine, so both are the Location's Shots.
    for (const [id, { tablet }] of [["mixed-skin-own", held], ["mixed-skin-other", other]] as const) {
      const fixture = derivedShot(id, { timestamp: new Date().toISOString() });
      const { model, serialNumber } = (await tablet.callApi("GET", "/machine/info")).body as { model: string; serialNumber: string };
      const workflow = fixture.workflow as Record_;
      tablet.pullShot({ ...fixture, workflow: { ...workflow, machine: { ...(workflow.machine as Record_), model, serialNumber } } });
    }
    await expect.poll(async () => (await api.get<{ shots: { id: string }[] }>(`/shots?locationId=${location.id}`)).shots.map((shot) => shot.id).sort()).toEqual(["mixed-skin-other", "mixed-skin-own"]);
    const read = async (id: string) => (await api.get<{ shot: { enjoyment: number | null; edits: { machine: { name: string } | null; account: unknown }[] } }>(`/shots/${id}`)).shot;
    const edit = async (tablet: SimulatedTablet, id: string, rating: number) => {
      const answer = await tablet.callEndpoint("shot", { method: "PUT", query: { id }, body: { rating } });
      return [answer.status, JSON.parse(answer.body)];
    };
    // Its own Shot: Decaid writes it, and the latest release's instance takes the tablet's report of it.
    expect(await edit(held.tablet, "mixed-skin-own", 8)).toEqual([200, expect.objectContaining({ rating: 8 })]);
    await expect.poll(async () => (await read("mixed-skin-own")).enjoyment).toBe(8);
    expect((await read("mixed-skin-own")).edits).toEqual([]);

    // The other tablet's, made by the latest release's server as the Machine's, with no account.
    expect(await edit(held.tablet, "mixed-skin-other", 3)).toEqual([200, expect.objectContaining({ rating: 3 })]);
    expect(await read("mixed-skin-other")).toMatchObject({
      enjoyment: 3,
      edits: [expect.objectContaining({ machine: expect.objectContaining({ name: "Tablet edits, held by the latest release" }), account: null })],
    });
    await expect.poll(async () => (((await other.tablet.callApi("GET", "/shots/mixed-skin-other")).body as Record_).annotations as Record_ | undefined)?.enjoyment).toBe(3);
  });

  // An edit of a Shot's rating or note made through the server (#512) is
  // written to the tablet that holds the Shot by a message each release's
  // server sends and each release's plugin carries out: an edit made through
  // the change's server is written to a tablet on the latest release's
  // plugin, and to one the latest release's instance holds, by that
  // instance.
  it("writes an edit of a Shot to a tablet on the latest release's plugin, and to one the latest release's server holds", async () => {
    const api = apis.change;
    type Record_ = Record<string, unknown>;
    const behind = await connected("Shot edits, the latest release's plugin", "latest release", "change");
    const held = await connected("Shot edits, held by the latest release", "change", "latest release");
    const shots = [["mixed-edit-behind", behind], ["mixed-edit-held", held]] as const;
    for (const [id, { tablet }] of shots) tablet.pullShot(derivedShot(id));
    for (const [id] of shots) await expect.poll(async () => (await api.call("GET", `/shots/${id}`)).status).toBe(200);
    const read = async (id: string) => (await api.get<{ shot: { enjoyment: number | null; edits: { state: string }[] } }>(`/shots/${id}`)).shot;
    const states = async (id: string) => (await read(id)).edits.map((edit) => edit.state);
    const ratingOn = async (tablet: SimulatedTablet, id: string) => (((await tablet.callApi("GET", `/shots/${id}`)).body as Record_).annotations as Record_ | undefined)?.enjoyment;

    // Made through the change's server, applied there at once, and written to each tablet where it is.
    for (const [id] of shots) expect((await api.send<{ shot: { enjoyment: number } }>("PATCH", `/shots/${id}`, { rating: 8 })).shot.enjoyment).toBe(8);
    for (const [id, { tablet }] of shots) {
      await expect.poll(() => states(id)).toEqual(["written"]);
      expect(await ratingOn(tablet, id)).toBe(8);
      expect((await read(id)).enjoyment).toBe(8);
    }
  });

  // Edits of a Shot made through the change's server while the latest
  // release's instance holds the Shot's tablet, which changes the Shot too
  // (#513). Each release's server decides a version of the Shot its tablet
  // reports against the edits, so the later of each field wins whichever
  // instance stored it.
  describe("a Shot edited through the change's server and changed on a tablet the latest release's instance holds", () => {
    type Record_ = Record<string, unknown>;
    const read = async (id: string) => (await apis.change.get<{ shot: { enjoyment: number | null; notes: string | null; edits: { state: string }[] } }>(`/shots/${id}`)).shot;
    const states = async (id: string) => (await read(id)).edits.map((edit) => edit.state);
    const edit = (id: string, fields: Record_) => apis.change.send("PATCH", `/shots/${id}`, fields);
    const annotationsOn = async (tablet: SimulatedTablet, id: string) => ((await tablet.callApi("GET", `/shots/${id}`)).body as Record_).annotations as Record_;
    const changeOn = async (tablet: SimulatedTablet, id: string, annotations: Record_) => expect((await tablet.callApi("PUT", `/shots/${id}`, { annotations })).status).toBe(200);
    /** A second, between two events timed by different clocks, the tablet's Decaid's and PostgreSQL's. */
    const aSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

    /** A tablet running the change's plugin, held by the latest release's instance, having pulled the Shot, rated 4 with a note. */
    async function held(name: string, id: string) {
      const connection = await connected(name, "change", "latest release");
      connection.tablet.pullShot(derivedShot(id, { annotations: { ...(derivedShot(id).annotations as Record_), enjoyment: 4, espressoNotes: "As pulled" } }));
      await expect.poll(async () => (await apis.change.call("GET", `/shots/${id}`)).status).toBe(200);
      return connection;
    }

    /** The tablet once the change's instance holds it, as once a deploy is done, and nothing is under way. */
    async function moved(connection: { machine: CreatedMachine; tablet: SimulatedTablet }): Promise<SimulatedTablet> {
      const tablet = await connection.tablet.reload({ settings: { ...settingsFor({ token: connection.machine.token, serverUrl: servers.change.url }), PollSeconds: 5 } });
      loaded.push(tablet);
      await apis.change.waitForOnline(connection.machine);
      return tablet;
    }

    it("writes an edit of a field the tablet left alone, and one made after the tablet's change of the other", async () => {
      const id = "mixed-edit-later";
      const connection = await held("Shot edits, edited again on the latest release", id);
      await edit(id, { rating: 8 });
      await aSecond();
      // The tablet changes the note alone, which the latest release's instance stores.
      await changeOn(connection.tablet, id, { espressoNotes: "Said at the tablet" });
      await expect.poll(async () => (await read(id)).notes).toBe("Said at the tablet");
      await aSecond();
      // Seeing that, an Admin edits the note: later than the tablet's change, so it wins, and the rating's edit stands.
      await edit(id, { note: "Said at the office, later" });
      expect(await read(id)).toMatchObject({ enjoyment: 8, notes: "Said at the office, later" });
      // The tablet changes something else, which the latest release's instance stores too: neither edit's field moved in it.
      await changeOn(connection.tablet, id, { actualYield: 36.2 });
      await expect.poll(() => connection.tablet.acknowledgedEvery((frame: Record_) => frame.type === "shotUpdated")).toBe(true);

      const tablet = await moved(connection);
      await expect.poll(() => states(id)).toEqual(["written", "written"]);
      expect(await annotationsOn(tablet, id)).toMatchObject({ enjoyment: 8, espressoNotes: "Said at the office, later" });
      // The tablet's next change of something else leaves both as they are.
      await changeOn(tablet, id, { actualYield: 36.5 });
      await quiesced(apis.change, { tablets: { tablet } });
      expect(await read(id)).toMatchObject({ enjoyment: 8, notes: "Said at the office, later" });
      expect(await states(id)).toEqual(["written", "written"]);
    });

    it("decides a version the latest release's instance stored before a newer one, reported by a tablet that is written no edits", async () => {
      const id = "mixed-edit-stored";
      const machine = await apis.change.createMachine("Shot edits, stored by the latest release");
      // A tablet on the latest release's plugin, with hand-made frames, so that nothing but its reports decides the Shot.
      const hello = helloWith(machine.token, { machine: { model: "DE1Pro", serial: String(serial++) }, tabletId: randomUUID(), wireRevision: wireRevisions()["latest release"] });
      const shot = derivedShot(id);
      const { measurements: _measurements, ...metadata } = shot;
      /** The Shot's metadata as Decaid reports an update of it, that many seconds from now by the tablet's clock. */
      const version = (seconds: number, annotations: Record_) => ({
        type: "shotUpdated",
        id: randomUUID(),
        shotId: id,
        shot: { ...metadata, updatedAt: new Date(Date.now() + seconds * 1000).toISOString(), annotations: { ...(shot.annotations as Record_), ...annotations } },
      });

      const onRelease = await RawConnection.welcomed(servers["latest release"].url, hello);
      await onRelease.deliver({ type: "shot", id: randomUUID(), shotId: id, shot });
      await edit(id, { rating: 8 });
      // The tablet had changed the rating a minute before that edit, which the latest release's instance now stores.
      await onRelease.deliver(version(-60, { enjoyment: 6 }));
      await onRelease.close();
      await apis.change.waitForMachine("Shot edits, stored by the latest release", (viewed) => !viewed.online);

      // Its next version, later than the edit, repeats that rating with its note changed. The change's instance decides
      // the version before it first: the rating was changed before the edit, not in this version, so the edit stands.
      const onChange = await RawConnection.welcomed(servers.change.url, hello);
      await onChange.deliver(version(60, { enjoyment: 6, espressoNotes: "Said at the tablet" }));
      expect(await read(id)).toMatchObject({ enjoyment: 8, notes: "Said at the tablet" });
      expect(await states(id)).toEqual(["awaitingTablet"]);
      await onChange.close();
    });
  });

  // A tablet with the latest release's plugin on each instance, as a deploy
  // finds them before Decaid installs the change's.
  describe("both releases' servers on one database the change migrated, a tablet on each", () => {
    it("closes a tablet's connection on one instance once its token is reissued through the other", async () => {
      // At real time, so neither tablet sends a heartbeat, whose check would close its connection too, for 30 s.
      const onRelease = await connected("Token, on the latest release", "latest release", "latest release", { timeScale: 1 });
      const onChange = await connected("Token, on the change", "latest release", "change", { timeScale: 1 });

      await apis.change.send("POST", `/machines/${onRelease.machine.machine.id}/token`, undefined, 201);
      await apis["latest release"].send("POST", `/machines/${onChange.machine.machine.id}/token`, undefined, 201);
      for (const { machine, tablet } of [onRelease, onChange]) {
        await expect.poll(() => tablet.received).toContainEqual(expect.objectContaining({ type: "error", code: "bad_token" }));
        await apis.change.waitForMachine(machine.machine.name, (viewed) => !viewed.online);
        expect(tablet.sent).not.toContainEqual(expect.objectContaining({ type: "heartbeat" }));
      }
    });

    it("writes a Library edit made through one instance to the tablet the other holds", async () => {
      const location = await apis.change.createLocation("Library, on both", "America/Chicago");
      const onRelease = await connected("Library, on the latest release", "latest release", "latest release", { location });
      const onChange = await connected("Library, on the change", "latest release", "change", { location });
      const tablets = { onRelease: onRelease.tablet, onChange: onChange.tablet };
      const { grinder } = await apis.change.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: location.id, content: { model: "EK43" } }, 201);
      for (const tablet of Object.values(tablets)) await expect.poll(() => heldGrinder(tablet, grinder.id)).toMatchObject({ model: "EK43" });

      // Quiet first, so no report of what was written before wakes the other instance's writer: only the notification does.
      for (const [through, holding] of [["change", onRelease.tablet], ["latest release", onChange.tablet]] as const) {
        await quiesced(apis.change, { tablets, machines: { onRelease: onRelease.machine, onChange: onChange.machine } });
        await apis[through].send("PATCH", `/grinders/${grinder.id}`, { content: { notes: `Edited through the ${through}` } });
        await expect.poll(() => heldGrinder(holding, grinder.id)?.notes).toBe(`Edited through the ${through}`);
      }
    });

    // What publishing a Draft (#580) makes is a Library Profile as any other: the latest release's plugin takes it, saved
    // from the one before, through either release's server.
    it("writes a Profile published from a Draft, and the new version of it, to tablets on the latest release's plugin through both instances", async () => {
      const location = await apis.change.createLocation("Published, on both", "America/Chicago");
      const onRelease = await connected("Published, on the latest release", "latest release", "latest release", { location });
      const onChange = await connected("Published, on the change", "latest release", "change", { location });
      type DraftRead = { id: string; saves: number; profile: { steps: Record<string, unknown>[] } & Record<string, unknown> };
      const publish = async (start: Record<string, unknown>, change: (profile: DraftRead["profile"]) => Record<string, unknown>) => {
        const { draft } = await apis.change.send<{ draft: DraftRead }>("POST", "/drafts", start, 201);
        const { draft: saved } = await apis.change.send<{ draft: DraftRead }>("PUT", `/drafts/${draft.id}`, { profile: change(draft.profile), saves: draft.saves });
        return (await apis.change.send<{ published: { profile: { id: string }; hiddenAt: { id: string }[] } }>("POST", `/drafts/${saved.id}/publish`, { saves: saved.saves, locations: [location.id] }, 200)).published;
      };
      const first = (await publish({ shape: "classic" }, (profile) => ({ ...profile, title: "Published on both" }))).profile.id;
      for (const tablet of [onRelease.tablet, onChange.tablet]) {
        await expect.poll(() => tablet.profiles().find((record) => record.id === first)).toMatchObject({ visibility: "visible", profile: { title: "Published on both" } });
      }
      // A new version, its last step's pressure lowered, saved from the first, which it takes the place of.
      const second = await publish({ profileId: first, as: "version" }, (profile) => ({
        ...profile,
        steps: profile.steps.map((step, index) => (index === profile.steps.length - 1 ? { ...step, pressure: Number(step.pressure ?? 6) - 0.5 } : step)),
      }));
      expect(second.hiddenAt.map((place) => place.id)).toEqual([location.id]);
      for (const tablet of [onRelease.tablet, onChange.tablet]) {
        await expect.poll(() => tablet.profiles().find((record) => record.id === second.profile.id)).toMatchObject({ visibility: "visible", parentId: first });
        await expect.poll(() => tablet.profiles().find((record) => record.id === first)?.visibility).toBe("hidden");
      }
    });

    // A range typed into a grinder under 1.10.0, whose server kept the record as sent and took none of it in (#551):
    // the change's server takes it in from the tablet's next report, where the Grinder never had one, rather than
    // writing the Grinder's none over it. The tablet keeps the latest release's plugin, as in the minutes after a deploy.
    it("takes in a range a tablet's record held while the latest release served it, once the change serves it, and writes none over it", async () => {
      const location = await apis.change.createLocation("Range, held before", "America/Chicago");
      const machine = await apis.change.createMachine("Range, held before", location.id);
      const decaid = emptyLibrary(serial++);
      const storage = new PluginStorage();
      const before = syncingTablet(machine, servers["latest release"], { latestRelease: true, api: decaid, storage });
      loaded.push(before);
      await apis.change.waitForOnline(machine);
      const range = { settingMin: 0, settingMax: 10, settingDefault: 4, rpmMin: 400, rpmMax: 1200 };
      const record = await before.addGrinder({ model: "Held EG-1", extras: { bcUuid: "fixture-bc-uuid", ...range } });
      const listed = async () => (await apis.change.get<{ grinders: { id: string; model: string | null }[] }>("/grinders")).grinders.find((grinder) => grinder.model === "Held EG-1");
      await expect.poll(listed).toBeDefined();
      const grinder = (await listed())!;
      await expect.poll(() => heldGrinder(before, grinder.id)?.id).toBe(record.id);
      const held = before.grinders();
      await before.unload();
      await apis.change.waitForMachine(machine.machine.name, (viewed) => !viewed.online);

      const after = syncingTablet(machine, servers.change, { latestRelease: true, api: { ...decaid, "/grinders": held }, storage });
      loaded.push(after);
      await apis.change.waitForOnline(machine);
      const content = async () => (await apis.change.get<{ grinder: { content: Record<string, unknown> } }>(`/grinders/${grinder.id}`)).grinder.content;
      await expect.poll(content).toMatchObject(range);
      await quiesced(apis.change, { tablets: { after }, machines: { machine } });
      expect(heldGrinder(after, grinder.id)?.extras).toMatchObject({ bcUuid: "fixture-bc-uuid", ...range });
      expect(await content()).toMatchObject(range);
      // Taken in as one edit of the Grinder, so one version of it, unless the latest release took them in itself as the Grinder joined.
      const history = (await apis.change.get<{ versions: { fields: Record<string, unknown> }[] }>(`/grinders/${grinder.id}/history`)).versions;
      const taken = history.filter((version) => "settingMin" in version.fields);
      expect(taken.map((version) => Object.keys(range).every((field) => field in version.fields))).toEqual([true]);
    });

    // What a Shot's samples show of how it went (#467), of a Shot the latest release's server stored: that server works
    // it out as it stores the Shot, or, where its curves revision is below the change's, the change's refresh does. Each
    // is a real Shot with a Preheat under another id: the latest release reads its first drip at 7.945 s, where its scale
    // first read 1 g, and the change at 6.235 s, where its rise to 1 g reached 0.3 g (#609), so only the change's refresh
    // gives 6.235 s. Its profile ended in its Extraction step at 2.819 g/s.
    it("gives what a Shot's samples show once the latest release's server has stored it, and keeps it through an edit that server stores", async () => {
      const { tablet } = await connected("Measured, on the latest release", "latest release", "latest release");
      const shot = { ...preheatShotFixture(), id: "mixed-measured-shot" };
      tablet.pullShot(shot);
      await expect.poll(async () => (await apis["latest release"].call("GET", `/shots/${shot.id}`)).status).toBe(200);
      interface Measured { id: string; timeToFirstDrip: number | null; flowAtStop?: number | null; lastStep: { frame: number; name: string } | null; enjoyment: number | null }
      const read = async () => (await apis.change.get<{ shot: Measured }>(`/shots/${shot.id}`)).shot;
      const row = async () => (await apis.change.get<{ shots: Measured[] }>("/shots?limit=100")).shots.find((listed) => listed.id === shot.id);
      // Where the refresh is to work them out: the change's instance ran its own as it started, before the Shot was
      // pulled, and next runs it within the hour; another instance of the change runs it as it starts.
      const later = await startTestServer({ env, sharing: servers["latest release"] });
      try {
        await expect.poll(async () => (await read()).timeToFirstDrip).toBe(6.235);
      } finally {
        await later.stop();
      }
      const measured = { timeToFirstDrip: 6.235, lastStep: { frame: 6, name: "Extraction" } };
      expect(await read()).toMatchObject({ ...measured, flowAtStop: 2.8189155419461156 });
      expect(await row()).toMatchObject(measured);

      // An edit carries the Shot's metadata whole, without its measurements; the latest release's server stores it.
      const { measurements: _, ...metadata } = shot;
      tablet.fire("shotUpdated", { id: shot.id, shot: { ...metadata, updatedAt: "2026-11-01T12:00:00Z", annotations: { ...(metadata.annotations as object), enjoyment: 80 } } });
      await expect.poll(async () => (await read()).enjoyment).toBe(80);
      expect(await read()).toMatchObject({ ...measured, flowAtStop: 2.8189155419461156 });
      expect(await row()).toMatchObject(measured);
    });

    it("sends a Settings Edit made through one instance from the other", async () => {
      const location = await apis.change.createLocation("Settings, on both", "America/Chicago");
      const onRelease = await connected("Settings, on the latest release", "latest release", "latest release", { location });
      const onChange = await connected("Settings, on the change", "latest release", "change", { location });

      expect(await editFan(onRelease.machine, "change")).toBe("applied");
      expect(await editFan(onChange.machine, "latest release")).toBe("applied");
      for (const { tablet } of [onRelease, onChange]) expect(await heldFan(tablet)).toBe(40);
    });
  });
});
