import path from "node:path";
import { WIRE_REVISION, globalIdOf, refusedByOtherDefinitions } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "../support/admin-api.js";
import { repoDir } from "../support/build-table.mjs";
import { latestReleaseDir, latestReleaseTag, releaseWireRevision } from "../support/latest-release.mjs";
import { emptyLibrary, syncingTablet } from "../support/loaded-tablets.js";
import { quiesced } from "../support/quiet.js";
import { derivedShot } from "../support/shot-fixtures.js";
import { type SimulatedTablet, derivedWorkflow, readBuiltPlugin } from "../support/simulated-tablet.js";
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
  refusal: { reason: string; status?: number | null; message?: string | null } | null;
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

  // Until a release has #343's steps, whose plugin then applies the edit: the test skips then, and is to be deleted.
  it("has the latest release's plugin refuse a weight flow multiplier off its own step, writing nothing, shown as the plugin needing an update", async (context) => {
    const edit = { collection: "appSettings", fields: { weightFlowMultiplier: 0.86 }, expected: { weightFlowMultiplier: 1 } };
    const release = (await import(path.join(latestReleaseDir(), "protocol/dist/index.js"))) as typeof import("@decent-sync/protocol");
    if (release.validateSettingsEdit(edit, "admin").length === 0) context.skip("the latest release's definitions take 0.86");

    const location = await apis.change.createLocation("Settings off the release's step", "America/Chicago");
    const { machine, tablet } = await connected("Settings off the release's step", "latest release", "change", { location });
    const appSettings = async () =>
      (await apis.change.get<{ collection: { value: Record<string, unknown> } | null }>(`/machines/${machine.machine.id}/collections/appSettings`)).collection?.value;
    await expect.poll(async () => (await appSettings())?.weightFlowMultiplier).toBe(1);
    const edits = `/machines/${machine.machine.id}/settings-edits`;
    const made = (await apis.change.send<{ settingsEdit: SettingsEditView }>("POST", edits, edit, 201)).settingsEdit;
    const read = async () => (await apis.change.get<{ settingsEdit: SettingsEditView }>(`${edits}/${made.id}`)).settingsEdit;
    await expect.poll(async () => (await read()).outcome).not.toBeNull();

    const { outcome, refusal } = await read();
    expect(outcome).toBe("refused");
    expect(refusal).toMatchObject({ reason: "decaid", status: null, message: expect.stringMatching(/^Not written: Weight flow multiplier must be a multiple of /) });
    expect(tablet.writes.filter((write) => write === "POST /settings")).toEqual([]);
    expect(((await tablet.callApi("GET", "/settings")).body as { weightFlowMultiplier?: unknown }).weightFlowMultiplier).toBe(1);
    // The management interface shows that the Tablet's plugin must update, rather than the step it refused by.
    expect(refusedByOtherDefinitions(edit, refusal!)).toBe(true);
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
