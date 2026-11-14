import path from "node:path";
import { RECIPE_SETTINGS, WIRE_REVISION, dye2GlobalIdOf, globalIdOf, workflowValueAt } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "../support/admin-api.js";
import { repoDir } from "../support/build-table.mjs";
import { latestReleaseDir, latestReleaseTag, releaseWireRevision } from "../support/latest-release.mjs";
import { emptyLibrary, recipeNamedInWorkflow, syncingTablet } from "../support/loaded-tablets.js";
import { quiesced } from "../support/quiet.js";
import { derivedShot } from "../support/shot-fixtures.js";
import { SimulatedDye2, dye2List, openDye2Dashboard, recordedDye2MainTablet } from "../support/simulated-dye2.js";
import { startStreamline } from "../support/simulated-streamline.js";
import { type SimulatedTablet, derivedWorkflow, readBuiltPlugin, settingsFor } from "../support/simulated-tablet.js";
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

  // A recipe record's `stripSlot` of 6 to 9 came with the change's wire
  // revision (#506): the latest release's plugin writes one as given without
  // taking the slot from the record holding it, and its server reads one as no
  // slot. So the change's server writes that plugin the Recipe's record in no
  // slot, and its slot once the tablet's plugin is the change's.
  // A tablet the latest release's server holds meanwhile is written the slot
  // as it is, by that server, and the Recipe keeps it once that tablet connects
  // to the change's server holding 7, its plugin still the latest release's.
  it("writes a Recipe in slot 7 to the latest release's plugin in no slot, keeps it in slot 7 through that tablet's reports, and writes its slot once the tablet's plugin is the change's", async () => {
    const api = apis.change;
    const location = await api.createLocation("Slot 7, both plugins", "America/Chicago");
    const ahead = await connected("Slot 7, the change's plugin", "change", "change", { location });
    const behind = await connected("Slot 7, the latest release's plugin", "latest release", "change", { location });
    const onRelease = await connected("Slot 7, on the latest release", "latest release", "latest release", { location });
    type Record_ = Record<string, unknown>;
    const { recipe } = await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: location.id, slot: 1, content: { name: "Slot 7", dose: 18, yield: 36 } }, 201);
    const record = (tablet: SimulatedTablet) => (dye2List(tablet, "recipes") as Record_[] | null)?.find((entry) => dye2GlobalIdOf(entry) === recipe.id);
    const held = (tablet: SimulatedTablet) => [record(tablet)?.stripSlot, record(tablet)?.showOnStreamlineDashboard];
    const read = async () => (await api.get<{ recipe: { slot: number | null; name: string | null } }>(`/recipes/${recipe.id}`)).recipe;
    for (const { tablet } of [ahead, behind, onRelease]) await expect.poll(() => held(tablet)).toEqual([1, true]);

    // Put in slot 7 on the tablet with the change's plugin, as another app there may, once its writer is due nothing.
    await expect
      .poll(async () => (await api.get<{ status: { waiting: number | null } }>(`/machines/${ahead.machine.machine.id}/sharing-status`)).status.waiting)
      .toBe(0);
    const route = "/store/dye2.reaplugin/recipes";
    const post = async (tablet: SimulatedTablet, change: (entry: Record_) => Record_) => {
      const list = (await tablet.callApi("GET", route)).body as Record_[];
      expect((await tablet.callApi("POST", route, list.map((entry) => (dye2GlobalIdOf(entry) === recipe.id ? change(entry) : entry)))).status).toBe(200);
    };
    await post(ahead.tablet, (entry) => ({ ...entry, stripSlot: 7, showOnStreamlineDashboard: true }));
    await expect.poll(async () => (await read()).slot).toBe(7);

    // The latest release's plugin is written the record in no slot, and sent no stripSlot of 6 to 9.
    await expect.poll(() => held(behind.tablet)).toEqual([null, false]);
    const slotsSent = () =>
      (behind.tablet.received.filter((frame) => (frame as Record_).type === "write" && (frame as Record_).kind === "recipe") as { fields: Record_ }[]).map(({ fields }) => fields.stripSlot);
    expect(slotsSent().filter((slot) => typeof slot === "number" && slot > 5)).toEqual([]);
    // A report from that tablet, of an edit there, keeps the Recipe in slot 7.
    await post(behind.tablet, (entry) => ({ ...entry, name: "Slot 7, renamed", title: "Slot 7, renamed" }));
    await expect.poll(async () => (await read()).name).toBe("Slot 7, renamed");
    await expect.poll(() => record(ahead.tablet)?.name).toBe("Slot 7, renamed");
    expect((await read()).slot).toBe(7);
    expect(held(behind.tablet)).toEqual([null, false]);
    expect(held(ahead.tablet)).toEqual([7, true]);
    expect(slotsSent().filter((slot) => typeof slot === "number" && slot > 5)).toEqual([]);

    // The latest release's server wrote its tablet the slot as it is. Connected to the change's server with that record,
    // the tablet is written it in no slot, and neither that write nor its reports take the Recipe out of slot 7.
    await expect.poll(() => held(onRelease.tablet)).toEqual([7, true]);
    const moved = await onRelease.tablet.reload({ settings: { ...settingsFor({ token: onRelease.machine.token, serverUrl: servers.change.url }), PollSeconds: 5 } });
    loaded.push(moved);
    expect(moved.pluginDir).toBe(pluginDirs()["latest release"]);
    await expect.poll(() => held(moved)).toEqual([null, false]);
    await post(moved, (entry) => ({ ...entry, name: "Slot 7, renamed again", title: "Slot 7, renamed again" }));
    await expect.poll(async () => (await read()).name).toBe("Slot 7, renamed again");
    await expect.poll(() => record(ahead.tablet)?.name).toBe("Slot 7, renamed again");
    expect((await read()).slot).toBe(7);
    expect([held(moved), held(ahead.tablet)]).toEqual([[null, false], [7, true]]);

    // Once Decaid installs the change's plugin there, the tablet's record holds 7.
    const updated = await behind.tablet.reload({ latestRelease: false });
    loaded.push(updated);
    expect(updated.pluginDir).toBe(pluginDirs().change);
    await expect.poll(() => held(updated)).toEqual([7, true]);
    expect((await read()).slot).toBe(7);

    // On the tablet still running the latest release's plugin, DYE2's editor puts the Recipe on tab 4, which another
    // holds, taking the slot from it: the move is made whole, from the slot 7 that tablet was written as none, rather
    // than only emptying slot 4.
    const { recipe: holder } = await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: location.id, slot: 4, content: { name: "Slot 4", dose: 18, yield: 36 } }, 201);
    const slotsOf = (tablet: SimulatedTablet) =>
      [recipe.id, holder.id].map((id) => (dye2List(tablet, "recipes") as Record_[] | null)?.find((entry) => dye2GlobalIdOf(entry) === id)?.stripSlot);
    await expect.poll(() => slotsOf(moved)).toEqual([null, 4]);
    const list = (await moved.callApi("GET", route)).body as Record_[];
    const tapped = list.map((entry) =>
      dye2GlobalIdOf(entry) === recipe.id ? { ...entry, stripSlot: 4, showOnStreamlineDashboard: true } : dye2GlobalIdOf(entry) === holder.id ? { ...entry, stripSlot: null } : entry,
    );
    expect((await moved.callApi("POST", route, tapped)).status).toBe(200);
    const slotAt = async (id: string) => (await api.get<{ recipe: { slot: number | null } }>(`/recipes/${id}`)).recipe.slot;
    await expect.poll(async () => [await slotAt(recipe.id), await slotAt(holder.id)]).toEqual([4, null]);
    for (const tablet of [moved, updated, ahead.tablet]) await expect.poll(() => slotsOf(tablet)).toEqual([4, null]);
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

    // What a Shot's samples show of how it went (#467), of a Shot the latest release's server stored: that server works
    // it out as it stores the Shot, or, where its curves revision is below the change's, the change's refresh does. Each
    // is a real Shot of 4 samples under another id: its scale first read 1 g or more 21.45 s into its profile, which
    // ended in its Pressure Decline step at 3.216 g/s.
    it("gives what a Shot's samples show once the latest release's server has stored it, and keeps it through an edit that server stores", async () => {
      const { tablet } = await connected("Measured, on the latest release", "latest release", "latest release");
      const shot = derivedShot("mixed-measured-shot");
      tablet.pullShot(shot);
      await expect.poll(async () => (await apis["latest release"].call("GET", `/shots/${shot.id}`)).status).toBe(200);
      interface Measured { id: string; timeToFirstDrip: number | null; flowAtStop?: number | null; lastStep: { frame: number; name: string } | null; enjoyment: number | null }
      const read = async () => (await apis.change.get<{ shot: Measured }>(`/shots/${shot.id}`)).shot;
      const row = async () => (await apis.change.get<{ shots: Measured[] }>("/shots?limit=100")).shots.find((listed) => listed.id === shot.id);
      // Where the refresh is to work them out: the change's instance ran its own as it started, before the Shot was
      // pulled, and next runs it within the hour; another instance of the change runs it as it starts.
      const later = await startTestServer({ env, sharing: servers["latest release"] });
      try {
        await expect.poll(async () => (await read()).timeToFirstDrip).toBe(21.45);
      } finally {
        await later.stop();
      }
      const measured = { timeToFirstDrip: 21.45, lastStep: { frame: 4, name: "Pressure Decline" } };
      expect(await read()).toMatchObject({ ...measured, flowAtStop: 3.21596222288838 });
      expect(await row()).toMatchObject(measured);

      // An edit carries the Shot's metadata whole, without its measurements; the latest release's server stores it.
      const { measurements: _, ...metadata } = shot;
      tablet.fire("shotUpdated", { id: shot.id, shot: { ...metadata, updatedAt: "2026-11-01T12:00:00Z", annotations: { ...(metadata.annotations as object), enjoyment: 80 } } });
      await expect.poll(async () => (await read()).enjoyment).toBe(80);
      expect(await read()).toMatchObject({ ...measured, flowAtStop: 3.21596222288838 });
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
