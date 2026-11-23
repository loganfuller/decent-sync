import { DECENT_SYNC_PLUGIN_ID } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { SimulatedPlugins, bundledPlugins, recordedPlugin } from "./support/decaid-plugins.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { rememberSecret } from "./support/secrets.js";
import { RawConnection, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #660: Software Actions on a Tablet's plugins, made
// through the REST API, sent to the built plugin in a simulated tablet whose
// Decaid manages its plugins as Decaid v0.9.3 does (decaid-plugins.ts, from
// fixtures/decaid/tablet-software-v0.9.3/), and answered, against real
// servers sharing one PostgreSQL database. Assertions are made through the
// REST API and what the tablet's Decaid holds. Serials and repositories'
// contents are made up; the plugins are Decaid's own, as recorded.

interface ActionView {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  account: { id: string; name: string | null } | null;
  connectedApp: unknown;
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  outcome: "done" | "refused" | "notConfirmed" | null;
  late: boolean;
  refusal: { reason: string; state?: string | null; status?: number | null; message?: string | null } | null;
  result: Record<string, unknown> | null;
}
interface PluginView {
  id: string;
  name: string | null;
  version: string | null;
  state: string;
  updates: Record<string, unknown>;
  lastError: string | null;
  pendingUpdate: { version: string | null; addedPermissions: string[] } | null;
  own: boolean;
  settings: { name: string; kind: string; secret: boolean; value?: unknown; changeable: boolean }[];
}
interface SoftwareView {
  decaid: { version: string | null; build: string | null; update: Record<string, unknown> | null; automaticUpdateCheck: boolean | null };
  plugins: PluginView[] | null;
  skins: { id: string; default: boolean; served: boolean; updates: Record<string, unknown> }[] | null;
  pluginMustUpdate: boolean;
}
interface Frame { type: string; id?: string; name?: string; value?: unknown; softwareActionId?: string }

const VISUALIZER = "visualizer.reaplugin";

describe("Software Actions", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let serial = 66_000;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Software cafe", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine at the cafe whose tablet is connected to `server`, its Decaid listing the plugins a new v0.9.3 bundles, as recorded. */
  async function connected(name: string, options: Parameters<typeof syncingTablet>[2] = {}): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; plugins: SimulatedPlugins }> {
    const machine = await api.createMachine(name, cafe.id);
    const plugins = options.plugins ?? new SimulatedPlugins({ plugins: bundledPlugins() });
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++), ...options, plugins });
    await api.waitForOnline(machine);
    await expect.poll(async () => (await software(machine)).plugins?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    return { machine, tablet, plugins };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/software-actions`;
  const make = async (machine: CreatedMachine, body: unknown, as = api) => (await as.send<{ softwareAction: ActionView }>("POST", path(machine), body, 201)).softwareAction;
  async function refused(machine: CreatedMachine, body: unknown, status: number, as = api): Promise<string> {
    const response = await as.call("POST", path(machine), body);
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return text;
  }
  const read = async (machine: CreatedMachine, id: string, as = api) => (await as.get<{ softwareAction: ActionView }>(`${path(machine)}/${id}`)).softwareAction;
  /** Resolves with the action once it has an outcome, read as the page reads it. */
  async function answered(machine: CreatedMachine, id: string, as = api): Promise<ActionView> {
    await expect.poll(async () => (await read(machine, id, as)).outcome, { timeout: 20_000 }).not.toBeNull();
    return read(machine, id, as);
  }
  const done = async (machine: CreatedMachine, body: unknown) => answered(machine, (await make(machine, body)).id);
  const software = async (machine: CreatedMachine, as = api) => (await as.get<{ tabletSoftware: SoftwareView }>(`/machines/${machine.machine.id}/tablet-software`)).tabletSoftware;
  const plugin = async (machine: CreatedMachine, id: string, as = api) => (await software(machine, as)).plugins?.find((entry) => entry.id === id);

  it("shows a Tablet's Decaid, its plugins with how each updates, and its Skins", async () => {
    const { machine } = await connected("Software shown");
    const shown = await software(machine);
    expect(shown.decaid).toMatchObject({ version: "0.9.3", build: "3265", automaticUpdateCheck: true });
    await expect.poll(async () => (await software(machine)).decaid.update).toMatchObject({ phase: "idle", latestVersion: null, installable: false, error: null });
    expect(shown.pluginMustUpdate).toBe(false);
    // Its own plugin, never to be disabled or removed, and Decaid's bundled ones, none with a recorded source yet.
    expect(shown.plugins!.map((entry) => entry.id).sort()).toEqual([...bundledPlugins().map((entry) => entry.id), DECENT_SYNC_PLUGIN_ID].sort());
    expect(await plugin(machine, DECENT_SYNC_PLUGIN_ID)).toMatchObject({ own: true, state: "enabled", updates: { how: "notUpdated" }, pendingUpdate: null });
    expect(await plugin(machine, VISUALIZER)).toMatchObject({ own: false, name: "Visualizer upload", state: "enabled", updates: { how: "notUpdated" } });
    await expect.poll(async () => (await software(machine)).skins?.length ?? 0).toBeGreaterThan(0);
  });

  it("disables and enables a plugin, each done with what the Tablet then held", async () => {
    const { machine, tablet, plugins } = await connected("Software toggled");
    const disabled = await done(machine, { kind: "disablePlugin", pluginId: VISUALIZER });
    expect(disabled).toMatchObject({ kind: "disablePlugin", params: { plugin: { id: VISUALIZER, name: "Visualizer upload" } }, outcome: "done", refusal: null, result: { pluginId: VISUALIZER, loaded: false } });
    expect(disabled.account).toEqual({ id: expect.any(String), name: "Ada Admin" });
    expect(plugins.listed().find((entry) => entry.id === VISUALIZER)).toMatchObject({ loaded: false, autoLoad: false });
    expect(await plugin(machine, VISUALIZER)).toMatchObject({ state: "disabled" });
    // Through `host.localApi`, which Decaid takes whatever its setting asks of a plain request.
    expect(plugins.managed).toEqual([{ request: `POST /plugins/${VISUALIZER}/disable`, via: "localApi", status: 200 }]);

    const enabled = await done(machine, { kind: "enablePlugin", pluginId: VISUALIZER });
    expect(enabled).toMatchObject({ outcome: "done", result: { pluginId: VISUALIZER, loaded: true } });
    expect(await plugin(machine, VISUALIZER)).toMatchObject({ state: "enabled" });

    // The lists read back after each were sent before its answer, naming it.
    const sent = tablet.sent as Frame[];
    const answer = sent.findIndex((frame) => frame.type === "softwareActed" && frame.id === disabled.id);
    const readBack = sent.slice(0, answer).filter((frame) => frame.type === "collection" && frame.name === "plugins").at(-1);
    expect(readBack?.softwareActionId).toBe(disabled.id);
  });

  it("installs a plugin from a repository's latest release, not enabled, and from a commit, pinned", async () => {
    const { machine, plugins } = await connected("Software installed");
    const uploader = { ...recordedPlugin("shot-upload.reaplugin"), id: "uploader.reaplugin", name: "Uploader", version: "0.4.0" };
    plugins.offer("example/uploader", { manifest: uploader, tag: "v0.4.0" });
    const installed = await done(machine, { kind: "installPlugin", repo: "example/uploader" });
    expect(installed).toMatchObject({ params: { repo: "example/uploader", branch: null }, outcome: "done", result: { pluginId: "uploader.reaplugin", version: "0.4.0", loaded: false } });
    expect(await plugin(machine, "uploader.reaplugin")).toMatchObject({ name: "Uploader", version: "0.4.0", state: "disabled", updates: { how: "followsReleases", repo: "example/uploader" } });

    const commit = "3a4083728302b3d30e108718cc690d34a13debb0";
    plugins.offer("example/uploader", { manifest: { ...uploader, version: "0.4.1" }, branch: commit, commit });
    const pinned = await done(machine, { kind: "installPlugin", repo: "example/uploader", branch: commit });
    expect(pinned).toMatchObject({ outcome: "done", result: { pluginId: "uploader.reaplugin", version: "0.4.1" } });
    expect(await plugin(machine, "uploader.reaplugin")).toMatchObject({ version: "0.4.1", updates: { how: "pinned", repo: "example/uploader", commit } });

    // Decaid's own words where it finds no such repository.
    const missing = await done(machine, { kind: "installPlugin", repo: "example/no-such-plugin" });
    expect(missing).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", status: 500, message: "Couldn't install the plugin. The repository, release, or download was not found. Check the address and try again." }, result: null });
  });

  it("changes a plugin's settings, a secret among them, which only an Admin is shown and nothing keeps", async () => {
    const { machine, tablet, plugins } = await connected("Software configured");
    const password = "a made-up password for the test 4711";
    rememberSecret(password);
    // As reported: nothing set but the defaults Decaid holds none of, the secret not set.
    const before = (await plugin(machine, VISUALIZER))!.settings;
    expect(before.find((setting) => setting.name === "Password")).toMatchObject({ kind: "text", secret: true, value: { isSet: false }, changeable: true });
    expect(before.find((setting) => setting.name === "Username")).toMatchObject({ kind: "text", secret: false, value: null });
    expect(before.find((setting) => setting.name === "AutoUpload")).toMatchObject({ kind: "switch" });
    expect(before.find((setting) => setting.name === "LengthThreshold")).toMatchObject({ kind: "number" });

    const made = await make(machine, {
      kind: "changePluginSettings",
      pluginId: VISUALIZER,
      values: { Username: "sam", Password: password, LengthThreshold: 7 },
      expected: { Username: null, Password: { isSet: false }, LengthThreshold: null },
    });
    // What is kept names the settings, never their values.
    expect(made.params).toEqual({ plugin: { id: VISUALIZER, name: "Visualizer upload" }, settings: ["Username", "Password", "LengthThreshold"] });
    expect(JSON.stringify(made)).not.toContain(password);
    const changed = await answered(machine, made.id);
    expect(changed).toMatchObject({ outcome: "done", result: { pluginId: VISUALIZER } });
    expect(JSON.stringify(changed)).not.toContain(password);
    // The Tablet's Decaid holds them, the secret as set.
    expect((await tablet.callApi("GET", `/plugins/${VISUALIZER}/settings`)).body).toEqual({ Username: "sam", LengthThreshold: 7, Password: { isSet: true } });
    const after = (await plugin(machine, VISUALIZER))!.settings;
    expect(after.find((setting) => setting.name === "Username")!.value).toBe("sam");
    expect(after.find((setting) => setting.name === "Password")!.value).toEqual({ isSet: true });

    // The stored action holds no value once sent, and the secret is in no response, report or frame the server kept.
    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query("SELECT held, params::text AS params, result::text AS result FROM software_actions WHERE id = $1", [made.id]);
      expect(rows).toEqual([{ held: null, params: expect.not.stringContaining(password), result: expect.not.stringContaining(password) }]);
      const kept = await database.query("SELECT count(*)::int AS n FROM settings_history WHERE value::text LIKE $1", [`%${password}%`]);
      expect(kept.rows[0].n).toBe(0);
    } finally {
      await database.end();
    }
    expect(JSON.stringify((tablet.sent as Frame[]).filter((frame) => frame.type !== "hello"))).not.toContain(password);
    expect(JSON.stringify((await api.get(`${path(machine)}`)))).not.toContain(password);

    // Staff read the lists, without the values; a Viewer too.
    const staff = await api.staffAt("software-staff@example.com", cafe);
    const forStaff = (await plugin(machine, VISUALIZER, staff))!.settings;
    expect(forStaff.map((setting) => setting.name)).toEqual(after.map((setting) => setting.name));
    expect(forStaff.every((setting) => !("value" in setting))).toBe(true);
    const settingsFor = async (as: AdminApi) => (await as.get<{ collection: { value: Record<string, Record<string, unknown>> } }>(`/machines/${machine.machine.id}/collections/pluginSettings`)).collection.value[VISUALIZER];
    expect(await settingsFor(api)).toEqual({ Username: "sam", LengthThreshold: 7, Password: { isSet: true } });
    expect(await settingsFor(staff)).toEqual({ Username: { hidden: true }, LengthThreshold: { hidden: true }, Password: { isSet: true } });

    // The change is in the Settings History, tied to the action, its values shown to the Admin alone.
    interface Change { collection: string; softwareAction: { id: string; kind: string; account: { name: string | null } | null } | null; settingsEdit: unknown; fields: { field: string; before: unknown; after: unknown }[] }
    const history = async (as: AdminApi) => (await as.get<{ changes: Change[] }>(`/machines/${machine.machine.id}/settings-history?collection=pluginSettings`)).changes;
    await expect.poll(async () => (await history(api)).length).toBe(1);
    const [entry] = await history(api);
    expect(entry).toMatchObject({ collection: "pluginSettings", settingsEdit: null, softwareAction: { id: made.id, kind: "changePluginSettings", account: { name: "Ada Admin" } } });
    expect(entry!.fields).toEqual(
      expect.arrayContaining([
        { field: `${VISUALIZER}/Username`, change: "added", before: null, after: "sam", backAt: null },
        { field: `${VISUALIZER}/Password`, change: "changed", before: { isSet: false }, after: { isSet: true }, backAt: null },
      ]),
    );
    const [forStaffEntry] = await history(staff);
    expect(forStaffEntry!.softwareAction).toMatchObject({ id: made.id, account: { name: null } });
    expect(forStaffEntry!.fields.find((field) => field.field === `${VISUALIZER}/Username`)).toMatchObject({ before: null, after: { hidden: true } });
    expect(plugins.managed.at(-1)).toEqual({ request: `POST /plugins/${VISUALIZER}/settings`, via: "localApi", status: 200 });
  });

  it("refuses a settings change over values the Tablet no longer holds, and one the plugin's manifest does not declare", async () => {
    const { machine, tablet } = await connected("Software changed since");
    // Changed on the Tablet since the page was loaded: the report the form showed is stale by the time the plugin reads.
    await tablet.callApi("POST", `/plugins/${VISUALIZER}/settings`, { Username: "typed-on-the-tablet" });
    const stale = await done(machine, { kind: "changePluginSettings", pluginId: VISUALIZER, values: { Username: "sam" }, expected: { Username: null } });
    expect(stale).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", message: "Changed on the Tablet since the form was shown: Username" } });
    expect((await tablet.callApi("GET", `/plugins/${VISUALIZER}/settings`)).body).toMatchObject({ Username: "typed-on-the-tablet" });

    expect(await refused(machine, { kind: "changePluginSettings", pluginId: VISUALIZER, values: { NoSuch: 1 }, expected: { NoSuch: null } }, 400)).toMatch(/Visualizer upload declares no setting NoSuch/);
    expect(await refused(machine, { kind: "changePluginSettings", pluginId: VISUALIZER, values: { LengthThreshold: "seven" }, expected: { LengthThreshold: null } }, 400)).toMatch(/Minimum shot length: give a number/);
    expect(await refused(machine, { kind: "changePluginSettings", pluginId: VISUALIZER, values: { Username: "sam" }, expected: {} }, 400)).toMatch(/Give the value shown of Username/);
    expect(await refused(machine, { kind: "enablePlugin", pluginId: "no-such.reaplugin" }, 409)).toMatch(/reports no such plugin/);
    expect(await refused(machine, { kind: "installPlugin", repo: "not a repository" }, 400)).toMatch(/owner\/name/);
    expect(await refused(machine, { kind: "rebootTablet" }, 400)).toMatch(/Say what to do/);
  });

  it("checks plugins for updates with a result for each, leaves one adding a permission waiting, and approves it", async () => {
    const dye2 = { ...recordedPlugin("dye2.reaplugin", "releaseInstalled"), id: "recipes.reaplugin", name: "Recipes" };
    const uploader = { ...recordedPlugin("shot-upload.reaplugin", "checked"), id: "uploader.reaplugin", name: "Uploader", version: "0.3.1", permissions: ["log", "api"] };
    uploader.source = { ...(uploader.source as Record<string, unknown>), repo: "example/uploader", releaseTag: "v0.3.1" };
    dye2.source = { ...(dye2.source as Record<string, unknown>), repo: "example/recipes" };
    const plugins = new SimulatedPlugins({ plugins: [dye2, uploader, ...bundledPlugins()] });
    plugins.offer("example/recipes", { manifest: { ...dye2, version: "0.1.43" }, tag: "v0.1.43" });
    plugins.offer("example/uploader", { manifest: { ...uploader, version: "0.4.0", permissions: ["log", "api", "notifications"] }, tag: "v0.4.0" });
    const { machine } = await connected("Software updated", { plugins });
    expect(await plugin(machine, "uploader.reaplugin")).toMatchObject({ version: "0.3.1", updates: { how: "followsReleases", repo: "example/uploader" }, pendingUpdate: null });

    const checked = await done(machine, { kind: "checkPluginUpdates" });
    expect(checked).toMatchObject({
      outcome: "done",
      result: {
        results: [
          { item: "recipes.reaplugin", status: "updated", version: "0.1.43" },
          { item: "uploader.reaplugin", status: "pendingApproval", version: "0.3.1" },
        ],
      },
    });
    expect(await plugin(machine, "recipes.reaplugin")).toMatchObject({ version: "0.1.43" });
    const waiting = await plugin(machine, "uploader.reaplugin");
    expect(waiting).toMatchObject({ version: "0.3.1", pendingUpdate: { version: "0.4.0", addedPermissions: ["notifications"] } });

    // Approved as shown; another update than the one shown is refused at once.
    expect(await refused(machine, { kind: "approvePluginUpdate", pluginId: "uploader.reaplugin", version: "0.3.9", addedPermissions: ["notifications"] }, 409)).toMatch(/Another update of this plugin waits/);
    const approved = await done(machine, { kind: "approvePluginUpdate", pluginId: "uploader.reaplugin", version: "0.4.0", addedPermissions: ["notifications"] });
    expect(approved).toMatchObject({ params: { plugin: { id: "uploader.reaplugin" }, version: "0.4.0", addedPermissions: ["notifications"] }, outcome: "done", result: { pluginId: "uploader.reaplugin", version: "0.4.0" } });
    expect(await plugin(machine, "uploader.reaplugin")).toMatchObject({ version: "0.4.0", pendingUpdate: null });
    expect(await refused(machine, { kind: "approvePluginUpdate", pluginId: "uploader.reaplugin", version: "0.4.0", addedPermissions: ["notifications"] }, 409)).toMatch(/No update of this plugin waits/);

    // A check that fails for one says so in Decaid's words, on the row too.
    plugins.failUpdatesOf("recipes.reaplugin", "Couldn't update the plugin. Try again.");
    const failed = await done(machine, { kind: "checkPluginUpdates" });
    expect((failed.result!.results as { item: string; status: string; error?: string }[]).find((result) => result.item === "recipes.reaplugin")).toMatchObject({ status: "failed", error: "Couldn't update the plugin. Try again." });
    expect(await plugin(machine, "recipes.reaplugin")).toMatchObject({ lastError: "Couldn't update the plugin. Try again." });

    // Each change of the plugin list is in the Settings History, tied to the action that made it.
    const changes = (await api.get<{ changes: { softwareAction: { id: string } | null; fields: { field: string }[] }[] }>(`/machines/${machine.machine.id}/settings-history?collection=plugins`)).changes;
    expect(changes.find((change) => change.softwareAction?.id === checked.id)!.fields.map((field) => field.field).sort()).toEqual(["recipes.reaplugin", "uploader.reaplugin"]);
    expect(changes.find((change) => change.softwareAction?.id === approved.id)!.fields.map((field) => field.field)).toEqual(["uploader.reaplugin"]);
  });

  it("removes a plugin with its settings", async () => {
    const { machine, tablet, plugins } = await connected("Software removed");
    await tablet.callApi("POST", `/plugins/${VISUALIZER}/settings`, { Username: "sam" });
    const removed = await done(machine, { kind: "removePlugin", pluginId: VISUALIZER });
    expect(removed).toMatchObject({ params: { plugin: { id: VISUALIZER, name: "Visualizer upload" } }, outcome: "done", result: { pluginId: VISUALIZER } });
    expect(plugins.listed().some((entry) => entry.id === VISUALIZER)).toBe(false);
    expect(await plugin(machine, VISUALIZER)).toBeUndefined();
    expect((await tablet.callApi("GET", `/plugins/${VISUALIZER}/settings`)).body).toEqual({});
  });

  it("has Decaid check for its own update, in any Machine State, and says what it found", async () => {
    const { machine, tablet, plugins } = await connected("Software Decaid check");
    // Pulling a Shot: the check touches neither the Machine nor the Skin.
    tablet.reportState("espresso", "pouring");
    plugins.offerDecaid("0.9.4");
    const found = await done(machine, { kind: "checkDecaidUpdate" });
    expect(found).toMatchObject({ outcome: "done", result: { decaid: { phase: "available", latestVersion: "0.9.4", installable: true } } });
    await expect.poll(async () => (await software(machine)).decaid.update).toMatchObject({ phase: "available", latestVersion: "0.9.4", installable: true });

    plugins.offerDecaid(null);
    expect(await done(machine, { kind: "checkDecaidUpdate" })).toMatchObject({ outcome: "done", result: { decaid: { phase: "idle", latestVersion: null } } });

    // Where Decaid can't check, as on a platform it does not update itself on, its own words.
    plugins.refuseDecaidCheck(true);
    expect(await done(machine, { kind: "checkDecaidUpdate" })).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", status: null, message: "In-app install is not supported on this platform" } });
  });

  it("refuses an action while the Machine is busy, with its state, and one made while it is offline at once", async () => {
    const { machine, tablet, plugins } = await connected("Software busy");
    tablet.reportState("espresso", "pouring");
    const busy = await done(machine, { kind: "disablePlugin", pluginId: VISUALIZER });
    expect(busy).toMatchObject({ outcome: "refused", refusal: { reason: "machineBusy", state: "espresso" }, result: null });
    expect(plugins.managed).toEqual([]);
    expect(await plugin(machine, VISUALIZER)).toMatchObject({ state: "enabled" });

    await tablet.unload();
    await api.waitForMachine(machine.machine.name, (viewed) => !viewed.online);
    expect(await refused(machine, { kind: "disablePlugin", pluginId: VISUALIZER }, 409)).toMatch(/The Machine is offline: a Software Action is made only while its Tablet is connected, and is never kept for later/);
    // Nothing was kept of it.
    expect((await api.get<{ total: number }>(path(machine))).total).toBe(1);
  });

  it("goes ahead with no Machine connected to the Tablet, as a Tablet's software needs none", async () => {
    const { machine, plugins } = await connected("Software no machine", { machineConnected: false });
    expect(await done(machine, { kind: "disablePlugin", pluginId: VISUALIZER })).toMatchObject({ outcome: "done" });
    expect(plugins.listed().find((entry) => entry.id === VISUALIZER)).toMatchObject({ loaded: false });
  });

  it("works where the Tablet asks a token of every plain request that manages its plugins, as it goes through localApi", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins(), requireAuthorization: true });
    const { machine, tablet } = await connected("Software protected", { plugins });
    // A plain request is refused, as another app's on the Tablet would be.
    expect((await tablet.callApi("POST", `/plugins/${VISUALIZER}/disable`)).status).toBe(401);
    expect(await done(machine, { kind: "disablePlugin", pluginId: VISUALIZER })).toMatchObject({ outcome: "done", result: { loaded: false } });
    expect(plugins.managed.filter((taken) => taken.via === "localApi")).toEqual([{ request: `POST /plugins/${VISUALIZER}/disable`, via: "localApi", status: 200 }]);

    // The automatic update checks, a Settings Edit of an Admin's: off, and on again, which a plain request could not do.
    const edit = async (to: boolean) => {
      const made = (await api.send<{ settingsEdit: { id: string } }>("POST", `/machines/${machine.machine.id}/settings-edits`, { collection: "appSettings", fields: { automaticUpdateCheck: to }, expected: { automaticUpdateCheck: !to } }, 201)).settingsEdit;
      const read = async () => (await api.get<{ settingsEdit: { outcome: string | null; refusal: unknown } }>(`/machines/${machine.machine.id}/settings-edits/${made.id}`)).settingsEdit;
      await expect.poll(async () => (await read()).outcome, { timeout: 15_000 }).not.toBeNull();
      return read();
    };
    await expect.poll(async () => (await software(machine)).decaid.automaticUpdateCheck).toBe(true);
    expect(await edit(false)).toMatchObject({ outcome: "applied" });
    expect((await software(machine)).decaid.automaticUpdateCheck).toBe(false);
    expect((await tablet.callApi("POST", "/settings", { automaticUpdateCheck: true })).status).toBe(401);
    expect(await edit(true)).toMatchObject({ outcome: "applied" });
    expect((await software(machine)).decaid.automaticUpdateCheck).toBe(true);
    // Staff are refused the edit, as every Software Action.
    const staff = await api.staffAt("software-checks@example.com", cafe);
    const response = await staff.call("POST", `/machines/${machine.machine.id}/settings-edits`, { collection: "appSettings", fields: { automaticUpdateCheck: false }, expected: { automaticUpdateCheck: true } });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/Only an Admin can change Automatic update checks/);
  });

  it("is an Admin's alone: Staff and Viewers read the lists and the log, and are refused every action", async () => {
    const { machine } = await connected("Software roles");
    const made = await done(machine, { kind: "disablePlugin", pluginId: VISUALIZER });
    const staff = await api.staffAt("software-roles@example.com", cafe);
    const { link } = await api.invite("software-viewer@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Val Viewer", password: "val's password 1" }));
    for (const reader of [staff, viewer]) {
      expect((await software(machine, reader)).plugins!.length).toBeGreaterThan(0);
      const log = await reader.get<{ softwareActions: ActionView[]; total: number }>(path(machine));
      // Who made it is named to Admins only.
      expect(log.softwareActions).toMatchObject([{ id: made.id, kind: "disablePlugin", outcome: "done", account: { name: null } }]);
      expect((await read(machine, made.id, reader)).outcome).toBe("done");
      for (const body of [
        { kind: "enablePlugin", pluginId: VISUALIZER },
        { kind: "installPlugin", repo: "example/uploader" },
        { kind: "changePluginSettings", pluginId: VISUALIZER, values: { Username: "x" }, expected: { Username: null } },
        { kind: "checkPluginUpdates" },
        { kind: "approvePluginUpdate", pluginId: VISUALIZER, version: "1", addedPermissions: [] },
        { kind: "removePlugin", pluginId: VISUALIZER },
        { kind: "checkDecaidUpdate" },
      ]) {
        expect(await refused(machine, body, 403, reader)).toMatch(/Only an Admin can do this/);
      }
      // The install form's suggestions are an Admin's too.
      expect((await reader.call("GET", `/machines/${machine.machine.id}/plugin-sources`)).status).toBe(403);
    }
    expect((await api.get<{ total: number }>(path(machine))).total).toBe(1);
  });

  it("suggests the sources the other Machines' plugins were installed from, most used first", async () => {
    const sourced = (repo: string, id: string, name: string, version: string, commit?: string) => {
      const from = recordedPlugin("dye2.reaplugin", commit ? "commitInstalled" : "releaseInstalled");
      return { ...from, id, name, version, source: { ...(from.source as Record<string, unknown>), repo, ...(commit ? { branch: commit, commit } : {}) } };
    };
    const commit = "717fa95a2b3c4d5e6f708192a3b4c5d6e7f80910";
    const first = await connected("Software source A", { plugins: new SimulatedPlugins({ plugins: [sourced("example/recipes", "recipes.reaplugin", "Recipes", "0.1.42", commit), sourced("example/uploader", "uploader.reaplugin", "Uploader", "0.3.1")] }) });
    await connected("Software source B", { plugins: new SimulatedPlugins({ plugins: [sourced("example/recipes", "recipes.reaplugin", "Recipes", "0.1.42", commit)] }) });
    const { machine } = await connected("Software source C", { plugins: new SimulatedPlugins({ plugins: [sourced("example/only-here", "here.reaplugin", "Only here", "1.0.0")] }) });
    const sources = (await api.get<{ pluginSources: { pluginId: string; repo: string; branch: string | null; machines: number; updates: { how: string } }[] }>(`/machines/${machine.machine.id}/plugin-sources`)).pluginSources;
    const ofThese = sources.filter((source) => source.repo.startsWith("example/") && source.repo !== "example/uploader-other");
    expect(ofThese.filter((source) => ["example/recipes", "example/uploader", "example/only-here"].includes(source.repo) && ["recipes.reaplugin", "uploader.reaplugin", "here.reaplugin"].includes(source.pluginId))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: "recipes.reaplugin", name: "Recipes", version: "0.1.42", repo: "example/recipes", branch: commit, updates: expect.objectContaining({ how: "pinned" }), machines: 2 }),
      ]),
    );
    // Its own Machine's plugins are not suggested to it.
    expect(sources.some((source) => source.pluginId === "here.reaplugin")).toBe(false);
    expect(first.machine.machine.id).not.toBe(machine.machine.id);
  });

  it("is carried out by the instance holding the connection, whichever instance it was made through", async () => {
    const { machine, plugins } = await connected("Software two instances");
    const elsewhere = api.at(other.url);
    const made = await make(machine, { kind: "disablePlugin", pluginId: VISUALIZER }, elsewhere);
    expect(await answered(machine, made.id, elsewhere)).toMatchObject({ outcome: "done" });
    expect(plugins.listed().find((entry) => entry.id === VISUALIZER)).toMatchObject({ loaded: false });
    expect((await read(machine, made.id)).outcome).toBe("done");
  });

  it("sends a plugin of the previous release no Software Action, and says its plugin must update", async () => {
    const machine = await api.createMachine("Software old plugin", cafe.id);
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: { model: "DE1Pro", serial: String(serial++) }, wireRevision: 4 }));
    await api.waitForOnline(machine);
    expect((await software(machine)).pluginMustUpdate).toBe(true);
    expect(await refused(machine, { kind: "checkPluginUpdates" }, 409)).toMatch(/The Tablet's plugin must update before it takes a Software Action/);
    expect((await api.get<{ total: number }>(path(machine))).total).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((raw.messages as Frame[]).filter((message) => message.type === "softwareAction")).toEqual([]);
    await raw.close();
  });
});
