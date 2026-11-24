import { randomUUID } from "node:crypto";
import { DECENT_SYNC_PLUGIN_ID } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { SimulatedPlugins, bundledPlugins, recordedPlugin } from "./support/decaid-plugins.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { rememberSecret } from "./support/secrets.js";
import { type SimulatedTablet, readBuiltPlugin } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #660: what a Software Action is never, and what the
// plugin does to itself. An action no connection claims in its time is never
// sent later, and is not confirmed; the plugin refuses to disable or remove
// itself or to change its server address or Token, whatever it is sent; and
// an action that has Decaid load the plugin again is answered by its next
// load. Against real servers sharing one PostgreSQL database, with the built
// plugin in simulated tablets (decaid-plugins.ts). Serials are made up.

interface ActionView {
  id: string;
  kind: string;
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  outcome: "done" | "refused" | "notConfirmed" | null;
  late: boolean;
  refusal: { reason: string; state?: string | null; status?: number | null; message?: string | null } | null;
  result: Record<string, unknown> | null;
}
interface Frame { type: string; id?: string; kind?: string; timeLeftMs?: number }

const VISUALIZER = "visualizer.reaplugin";

describe("Software Actions, their time and the plugin's own protections", () => {
  let server: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let serial = 67_000;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Software deadline cafe", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
  });

  async function connected(name: string, instance = server, options: Parameters<typeof syncingTablet>[2] = {}): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; plugins: SimulatedPlugins }> {
    const machine = await api.createMachine(name, cafe.id);
    const plugins = options.plugins ?? new SimulatedPlugins({ plugins: bundledPlugins() });
    const tablet = syncingTablet(machine, instance, { api: emptyLibrary(serial++), ...options, plugins });
    await api.waitForOnline(machine);
    await expect.poll(async () => (await software(machine))?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    return { machine, tablet, plugins };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/software-actions`;
  const make = async (machine: CreatedMachine, body: unknown) => (await api.send<{ softwareAction: ActionView }>("POST", path(machine), body, 201)).softwareAction;
  const read = async (machine: CreatedMachine, id: string) => (await api.get<{ softwareAction: ActionView }>(`${path(machine)}/${id}`)).softwareAction;
  async function answered(machine: CreatedMachine, id: string): Promise<ActionView> {
    await expect.poll(async () => (await read(machine, id)).answeredAt, { timeout: 20_000 }).not.toBeNull();
    return read(machine, id);
  }
  const software = async (machine: CreatedMachine) =>
    (await api.get<{ tabletSoftware: { plugins: { id: string; version: string | null; state: string; pendingUpdate: unknown; updates: Record<string, unknown> }[] | null } }>(`/machines/${machine.machine.id}/tablet-software`)).tabletSoftware.plugins;
  const own = async (machine: CreatedMachine) => (await software(machine))?.find((plugin) => plugin.id === DECENT_SYNC_PLUGIN_ID);
  const actionsReceived = (tablet: SimulatedTablet) => tablet.received.filter((frame) => (frame as Frame).type === "softwareAction") as Frame[];

  /**
   * Puts an action in the database for the connection holding the Machine
   * now, as the server keeps one, without its checks and without telling
   * any instance unless `announce`: what the plugin is sent whatever the
   * server would refuse, or an action whose notification was lost.
   */
  async function stored(machine: CreatedMachine, action: { kind: string; params: unknown; held?: unknown; timeMs?: number; madeMsAgo?: number }, announce: boolean): Promise<string> {
    const id = randomUUID();
    const database = await server.connectDatabase();
    try {
      await database.query(
        `INSERT INTO software_actions (id, machine_id, session_id, tablet_id, kind, params, held, time_ms, made_at)
         SELECT $1::uuid, id, connected_session_id, connected_tablet_id, $3, $4::jsonb, $5::jsonb, $6, clock_timestamp() - $7 * interval '1 millisecond'
         FROM machines WHERE id = $2::uuid`,
        [id, machine.machine.id, action.kind, JSON.stringify(action.params), action.held === undefined ? null : JSON.stringify(action.held), action.timeMs ?? 60_000, action.madeMsAgo ?? 0],
      );
      if (announce) await database.query("SELECT pg_notify('software_actions', $1)", [machine.machine.id]);
    } finally {
      await database.end();
    }
    return id;
  }
  /**
   * Whether every connection of the instance whose `application_name` is `name` is idle, with no statement running, none waiting
   * on a lock and no transaction open: then it holds no lock, and takes none until it runs again. It must have connections.
   */
  const idle = async (name: string) => {
    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query<{ connections: number; busy: number }>(
        "SELECT count(*)::int AS connections, count(*) FILTER (WHERE state <> 'idle')::int AS busy FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1",
        [name],
      );
      expect(rows[0].connections, `connections named ${name}`).toBeGreaterThan(0);
      return rows[0].busy === 0;
    } finally {
      await database.end();
    }
  };
  const heldOf = async (id: string) => {
    const database = await server.connectDatabase();
    try {
      return (await database.query("SELECT held, sent_at FROM software_actions WHERE id = $1", [id])).rows[0] as { held: unknown; sent_at: Date | null };
    } finally {
      await database.end();
    }
  };

  it("gives an install, an update check and an approval two minutes, and the rest one", async () => {
    const { machine, tablet, plugins } = await connected("Deadline times");
    plugins.offer("example/uploader", { manifest: { ...recordedPlugin("shot-upload.reaplugin"), id: "uploader.reaplugin", version: "0.4.0" } });
    for (const body of [{ kind: "installPlugin", repo: "example/uploader" }, { kind: "checkPluginUpdates" }, { kind: "checkDecaidUpdate" }, { kind: "disablePlugin", pluginId: VISUALIZER }, { kind: "enablePlugin", pluginId: VISUALIZER }]) {
      await answered(machine, (await make(machine, body)).id);
    }
    // As the server sent each, before the simulated tablet scaled it to its own pace.
    const left = Object.fromEntries(actionsReceived(tablet).map((frame) => [frame.kind, frame.timeLeftMs!]));
    for (const kind of ["installPlugin", "checkPluginUpdates", "checkDecaidUpdate"]) {
      expect(left[kind], kind).toBeGreaterThan(110_000);
      expect(left[kind], kind).toBeLessThanOrEqual(120_000);
    }
    for (const kind of ["disablePlugin", "enablePlugin"]) {
      expect(left[kind], kind).toBeGreaterThan(50_000);
      expect(left[kind], kind).toBeLessThanOrEqual(60_000);
    }
  });

  it("goes on capturing the Tablet's lists while a Software Action waits on Decaid", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    plugins.installMs = 12_000;
    plugins.offer("example/uploader", { manifest: { ...recordedPlugin("shot-upload.reaplugin"), id: "uploader.reaplugin", version: "0.4.0" } });
    const { machine, tablet } = await connected("Deadline capture meanwhile", server, { plugins });
    const install = await make(machine, { kind: "installPlugin", repo: "example/uploader" });
    await expect.poll(async () => (await read(machine, install.id)).sentAt).not.toBeNull();
    // A Bean added on the Tablet while Decaid installs reaches the server well before the install is done.
    await tablet.callApi("POST", "/beans", { roaster: "Roux", name: "Added meanwhile" });
    const beans = async () => ((await api.get<{ collection: { value: { name: string }[] } | null }>(`/machines/${machine.machine.id}/collections/beans`)).collection?.value ?? []).map((bean) => bean.name);
    await expect.poll(beans, { timeout: 6_000 }).toContain("Added meanwhile");
    expect((await read(machine, install.id)).answeredAt).toBeNull();
    expect(await answered(machine, install.id)).toMatchObject({ outcome: "done", result: { pluginId: "uploader.reaplugin" } });
  });

  it("answers an install Decaid stopped waiting on, but went on with, once the plugin list shows it", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    // host.localApi gives up after its time, as Decaid's does after a minute, while the install goes on.
    plugins.localApiTimeoutMs = 1_000;
    plugins.installMs = 2_500;
    plugins.offer("example/uploader", { manifest: { ...recordedPlugin("shot-upload.reaplugin"), id: "uploader.reaplugin", name: "Uploader", version: "0.4.0" } });
    const { machine } = await connected("Deadline install timed out", server, { plugins });
    const install = await make(machine, { kind: "installPlugin", repo: "example/uploader" });
    expect(await answered(machine, install.id)).toMatchObject({ outcome: "done", result: { pluginId: "uploader.reaplugin", name: "Uploader", version: "0.4.0" }, refusal: null });
    expect((await software(machine))?.find((plugin) => plugin.id === "uploader.reaplugin")).toMatchObject({ version: "0.4.0" });
  });

  it("never sends an action no connection claimed, after a reconnect or once its time is up, and shows it not confirmed", async () => {
    const { machine, tablet, plugins } = await connected("Deadline never queued");
    const password = "another made-up password 0815 for the test";
    rememberSecret(password);
    // Its notification lost, it waits unsent for the connection it was made for, holding a settings change's values.
    const unsent = await stored(machine, { kind: "changePluginSettings", params: { plugin: { id: VISUALIZER, name: "Visualizer upload" }, settings: ["Password"] }, held: { values: { Password: password }, expected: { Password: { isSet: false } } } }, false);
    expect(await read(machine, unsent)).toMatchObject({ outcome: null, sentAt: null });
    expect((await heldOf(unsent)).held).not.toBeNull();

    // The connection drops and the Tablet connects again: the action was for the one before, and is never sent.
    tablet.dropConnections();
    await expect.poll(async () => (await read(machine, unsent)).outcome).toBe("notConfirmed");
    await api.waitForOnline(machine);
    // An action made for this connection goes ahead, and the old one is not sent with it, even when announced again.
    const now = await make(machine, { kind: "disablePlugin", pluginId: VISUALIZER });
    expect(await answered(machine, now.id)).toMatchObject({ outcome: "done" });
    const database = await server.connectDatabase();
    try {
      await database.query("SELECT pg_notify('software_actions', $1)", [machine.machine.id]);
    } finally {
      await database.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(actionsReceived(tablet).map((frame) => frame.id)).toEqual([now.id]);
    expect(await read(machine, unsent)).toMatchObject({ outcome: "notConfirmed", sentAt: null, answeredAt: null });
    // Its values went as it stopped being awaited, at the next read of the Machine's actions.
    await api.get(path(machine));
    expect(await heldOf(unsent)).toEqual({ held: null, sent_at: null });
    expect(plugins.managed.map((taken) => taken.request)).toEqual([`POST /plugins/${VISUALIZER}/disable`]);

    // One whose time was up before any connection claimed it, though made for this connection, is not sent either.
    const late = await stored(machine, { kind: "enablePlugin", params: { plugin: { id: VISUALIZER, name: "Visualizer upload" } }, madeMsAgo: 61_000 }, true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await read(machine, late)).toMatchObject({ outcome: "notConfirmed", sentAt: null });
    expect(actionsReceived(tablet).map((frame) => frame.id)).toEqual([now.id]);
    expect(plugins.listed().find((entry) => entry.id === VISUALIZER)).toMatchObject({ loaded: false });
  });

  it("refuses an action under way as its connection drops as expired, asking nothing of Decaid", async () => {
    const { machine, tablet, plugins } = await connected("Deadline reconnect");
    const state = tablet.holdRequests("GET", "/machine/state");
    const made = await make(machine, { kind: "disablePlugin", pluginId: VISUALIZER });
    await expect.poll(() => state.arrived).toBe(1);
    tablet.dropConnections();
    await api.waitForOnline(machine);
    state.release();
    // The plugin heard its connection close before it would ask Decaid: its answer reaches the next connection.
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "refused", refusal: { reason: "expired" }, late: false });
    expect(actionsReceived(tablet)).toHaveLength(1);
    expect(plugins.managed).toEqual([]);
  });

  it("drops an action under way as the plugin unloads, which its next load is sent nothing of", async () => {
    const { machine, tablet, plugins } = await connected("Deadline unload");
    const state = tablet.holdRequests("GET", "/machine/state");
    const made = await make(machine, { kind: "disablePlugin", pluginId: VISUALIZER });
    await expect.poll(() => state.arrived).toBe(1);
    await tablet.unload();
    const reloaded = await tablet.reload();
    await api.waitForOnline(machine);
    state.release();
    await expect.poll(() => reloaded.received.some((frame) => (frame as Frame).type === "welcome")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // Sent, so awaited for its time, and never answered: nothing was asked of Decaid.
    expect(await read(machine, made.id)).toMatchObject({ outcome: null, answeredAt: null });
    expect(actionsReceived(reloaded)).toEqual([]);
    expect(plugins.managed).toEqual([]);
  });

  it("is refused by the plugin itself, whatever it is sent, where it would disable or remove the plugin or change its server address or Token", async () => {
    const { machine, tablet, plugins } = await connected("Deadline protections");
    const itself = { plugin: { id: DECENT_SYNC_PLUGIN_ID, name: "Decent Sync" } };
    // The server refuses each at once, with nothing kept.
    for (const [body, said] of [
      [{ kind: "disablePlugin", pluginId: DECENT_SYNC_PLUGIN_ID }, /Decent Sync's own plugin can't be disabled from here/],
      [{ kind: "removePlugin", pluginId: DECENT_SYNC_PLUGIN_ID }, /Decent Sync's own plugin can't be removed from here/],
      [{ kind: "changePluginSettings", pluginId: DECENT_SYNC_PLUGIN_ID, values: { ServerUrl: "https://elsewhere.example" }, expected: { ServerUrl: server.url } }, /Server URL of Decent Sync's own plugin can't be changed from here/],
      [{ kind: "changePluginSettings", pluginId: DECENT_SYNC_PLUGIN_ID, values: { Token: "x".repeat(30) }, expected: { Token: { isSet: true } } }, /Token of Decent Sync's own plugin can't be changed from here/],
    ] as const) {
      const response = await api.call("POST", path(machine), body);
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(said);
    }
    expect((await api.get<{ total: number }>(path(machine))).total).toBe(0);

    // Sent all the same, as by a server that checked nothing, the plugin refuses each and asks Decaid for none.
    const sent = [
      await stored(machine, { kind: "disablePlugin", params: itself }, true),
      await stored(machine, { kind: "removePlugin", params: itself }, true),
      await stored(machine, { kind: "changePluginSettings", params: { ...itself, settings: ["ServerUrl"] }, held: { values: { ServerUrl: "https://elsewhere.example" }, expected: { ServerUrl: server.url } } }, true),
      await stored(machine, { kind: "changePluginSettings", params: { ...itself, settings: ["Token", "PollSeconds"] }, held: { values: { Token: "x".repeat(30), PollSeconds: 9 }, expected: { Token: { isSet: true }, PollSeconds: 5 } } }, true),
    ];
    for (const id of sent) {
      expect(await answered(machine, id)).toMatchObject({ outcome: "refused", refusal: { reason: "notAllowed", message: expect.stringMatching(/^The Decent Sync plugin /) } });
    }
    expect(plugins.managed).toEqual([]);
    expect(tablet.logs.filter((line) => line.startsWith("Did not carry out Software Action"))).toHaveLength(4);
    // Still connected, with the settings it had.
    expect(await own(machine)).toMatchObject({ state: "enabled" });
    expect((await tablet.callApi("GET", `/plugins/${DECENT_SYNC_PLUGIN_ID}/settings`)).body).toEqual({ ServerUrl: server.url, PollSeconds: 5, Token: { isSet: true } });
  });

  it("changes the plugin's own poll interval, answered by the plugin's next load, as Decaid loads it again to save it", async () => {
    const { machine, tablet } = await connected("Deadline own settings");
    const made = await make(machine, { kind: "changePluginSettings", pluginId: DECENT_SYNC_PLUGIN_ID, values: { PollSeconds: 9 }, expected: { PollSeconds: 5 } });
    const changed = await answered(machine, made.id);
    expect(changed).toMatchObject({ outcome: "done", result: { pluginId: DECENT_SYNC_PLUGIN_ID, loaded: true } });
    const next = await tablet.successor!;
    expect((await next.callApi("GET", `/plugins/${DECENT_SYNC_PLUGIN_ID}/settings`)).body).toEqual({ ServerUrl: server.url, PollSeconds: 9, Token: { isSet: true } });
    // The load that asked was unloaded under its call, and answered nothing; its successor did.
    expect((tablet.sent as Frame[]).some((frame) => frame.type === "softwareActed")).toBe(false);
    expect((next.sent as Frame[]).filter((frame) => frame.type === "softwareActed").map((frame) => frame.id)).toEqual([made.id]);
    await api.waitForOnline(machine);
  });

  it("approves the plugin's own waiting update, answered after the plugin loads again, with the version then installed", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    const { manifest } = readBuiltPlugin();
    // As Decaid holds a plugin installed from a release whose newer release adds a permission (pending-update.json).
    plugins.ownSource = { ...(recordedPlugin(DECENT_SYNC_PLUGIN_ID, "staged", "pending").source as Record<string, unknown>), releaseTag: `v${String(manifest.version)}` };
    plugins.offer("loganfuller/decent-sync", { manifest: { ...manifest, version: "99.0.0", permissions: [...(manifest.permissions as string[]), "proxy.decent_api"] }, tag: "v99.0.0" });
    // Decaid clears the waiting update only after the next load has started.
    plugins.ownSourceAfterLoadMs = 2_000;
    const { machine, tablet } = await connected("Deadline own update", server, { plugins });
    expect(await own(machine)).toMatchObject({ version: manifest.version, updates: { how: "followsReleases", repo: "loganfuller/decent-sync" }, pendingUpdate: null });

    // The check finds it, and it waits, as it adds a permission.
    const check = await make(machine, { kind: "checkPluginUpdates" });
    expect(await answered(machine, check.id)).toMatchObject({ outcome: "done", result: { results: [{ item: DECENT_SYNC_PLUGIN_ID, status: "pendingApproval" }] } });
    await expect.poll(async () => (await own(machine))?.pendingUpdate).toEqual({ version: "99.0.0", addedPermissions: ["proxy.decent_api"] });

    const approval = await make(machine, { kind: "approvePluginUpdate", pluginId: DECENT_SYNC_PLUGIN_ID, version: "99.0.0", addedPermissions: ["proxy.decent_api"] });
    const approved = await answered(machine, approval.id);
    expect(approved).toMatchObject({ outcome: "done", result: { pluginId: DECENT_SYNC_PLUGIN_ID, version: "99.0.0", loaded: true }, refusal: null });
    const next = await tablet.successor!;
    expect((tablet.sent as Frame[]).some((frame) => frame.type === "softwareActed" && frame.id === approval.id)).toBe(false);
    expect((next.sent as Frame[]).filter((frame) => frame.type === "softwareActed").map((frame) => frame.id)).toEqual([approval.id]);
    await expect.poll(async () => await own(machine)).toMatchObject({ version: "99.0.0", pendingUpdate: null });
    await api.waitForOnline(machine);
    // The change of its entry is in the Settings History, tied to the approval.
    const changes = (await api.get<{ changes: { softwareAction: { id: string } | null; fields: { field: string }[] }[] }>(`/machines/${machine.machine.id}/settings-history?collection=plugins`)).changes;
    expect(changes.find((change) => change.softwareAction?.id === approval.id)?.fields.map((field) => field.field)).toEqual([DECENT_SYNC_PLUGIN_ID]);
  });

  it("answers an update check that installed the plugin's own update from what the next load finds", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    const { manifest } = readBuiltPlugin();
    plugins.ownSource = { ...(recordedPlugin(DECENT_SYNC_PLUGIN_ID, "staged", "pending").source as Record<string, unknown>), releaseTag: `v${String(manifest.version)}` };
    // A newer release that adds no permission is installed by the check itself.
    plugins.offer("loganfuller/decent-sync", { manifest: { ...manifest, version: "99.1.0" }, tag: "v99.1.0" });
    const { machine, tablet } = await connected("Deadline own update by check", server, { plugins });
    const check = await make(machine, { kind: "checkPluginUpdates" });
    expect(await answered(machine, check.id)).toMatchObject({ outcome: "done", result: { results: [{ item: DECENT_SYNC_PLUGIN_ID, status: "updated", version: "99.1.0" }] } });
    expect((await tablet.successor!).logs.some((line) => line.includes("loaded"))).toBe(true);
    await api.waitForOnline(machine);
  });

  it("answers an update check that loaded the plugin again partway through with the check's results once it ends, as Decaid goes on to the plugins after it", async () => {
    const uploader = { ...recordedPlugin("shot-upload.reaplugin", "checked"), id: "uploader.reaplugin", name: "Uploader", version: "0.3.1" };
    const plugins = new SimulatedPlugins({ plugins: [uploader, ...bundledPlugins()] });
    const { manifest } = readBuiltPlugin();
    plugins.ownSource = { ...(recordedPlugin(DECENT_SYNC_PLUGIN_ID, "staged", "pending").source as Record<string, unknown>), releaseTag: `v${String(manifest.version)}` };
    plugins.offer("loganfuller/decent-sync", { manifest: { ...manifest, version: "99.1.0" }, tag: "v99.1.0" });
    plugins.offer(String((uploader.source as Record<string, unknown>).repo), { manifest: { ...uploader, version: "0.3.2" }, tag: "v0.3.2" });
    // The plugin is checked first, and each check takes a while: the next load starts while the uploader is still to come.
    plugins.ownCheckedFirst = true;
    plugins.checkStepMs = 1_500;
    const { machine, tablet } = await connected("Deadline own update mid-check", server, { plugins });
    const check = await make(machine, { kind: "checkPluginUpdates" });
    expect(await answered(machine, check.id)).toMatchObject({
      outcome: "done",
      result: { results: [{ item: DECENT_SYNC_PLUGIN_ID, status: "updated", version: "99.1.0" }, { item: "uploader.reaplugin", status: "updated", version: "0.3.2" }] },
    });
    const next = await tablet.successor!;
    expect((next.sent as Frame[]).filter((frame) => frame.type === "softwareActed").map((frame) => frame.id)).toEqual([check.id]);
    await api.waitForOnline(machine);
  });

  it("answers an update check that installed a new commit of the plugin's own branch under the same version", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    const { manifest } = readBuiltPlugin();
    plugins.ownSource = { ...(recordedPlugin("dye2.reaplugin", "branchInstalled").source as Record<string, unknown>), repo: "loganfuller/decent-sync", branch: "trial", commit: "1".repeat(40) };
    plugins.offer("loganfuller/decent-sync", { manifest, branch: "trial", commit: "2".repeat(40) });
    // Decaid writes the new commit only after the next load has started.
    plugins.ownSourceAfterLoadMs = 2_000;
    const { machine, tablet } = await connected("Deadline own branch commit", server, { plugins });
    const check = await make(machine, { kind: "checkPluginUpdates" });
    expect(await answered(machine, check.id)).toMatchObject({ outcome: "done", result: { results: [{ item: DECENT_SYNC_PLUGIN_ID, status: "updated", version: manifest.version }] } });
    expect(((await tablet.successor!).sent as Frame[]).filter((frame) => frame.type === "softwareActed").map((frame) => frame.id)).toEqual([check.id]);
    await api.waitForOnline(machine);
  });

  it("marks an action no instance could send not confirmed once its time is up, its values gone by then without a read, and never sends it", async () => {
    // Its connection's instance stops answering, as when its host hangs: the action is made through the other one.
    // Named, so that its connections can be told from the other instance's.
    const frozenName = `decent-sync-frozen-${randomUUID()}`;
    const frozen = await startTestServer({ env: { ...env, PGAPPNAME: frozenName }, sharing: server });
    try {
      const { machine, tablet, plugins } = await connected("Deadline frozen instance", frozen);
      const password = "a third made-up password 2342 for the test";
      rememberSecret(password);
      // Stopped inside one of its transactions on the Machine's row, as a heartbeat's, or with a statement on it still running, it
      // would hold that row until PostgreSQL ends the transaction (idle_in_transaction_session_timeout), and the action couldn't be
      // made meanwhile: it is let go and stopped again until all its connections are idle. A moment after the stop, so that a
      // statement it sent just before has reached PostgreSQL by then.
      for (let attempt = 1; ; attempt++) {
        frozen.signal("SIGSTOP");
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (await idle(frozenName)) break;
        expect(attempt, "the stopped instance was in a transaction or running a statement at every stop").toBeLessThan(20);
        frozen.signal("SIGCONT");
        await new Promise((resolve) => setTimeout(resolve, 500));
        await api.waitForOnline(machine);
      }
      const made = await make(machine, { kind: "changePluginSettings", pluginId: VISUALIZER, values: { Password: password }, expected: { Password: { isSet: false } } });
      expect((await heldOf(made.id)).held).not.toBeNull();
      // 61 s and a moment on, the instance that made it has taken its values out, with no read of the Machine's actions.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(made.madeAt) + 63_000 - Date.now())));
      expect(await heldOf(made.id)).toEqual({ held: null, sent_at: null });
      expect(await read(machine, made.id)).toMatchObject({ outcome: "notConfirmed", sentAt: null, answeredAt: null });
      // The instance answers again, and hears of the action: its time is up, so it is not sent.
      frozen.signal("SIGCONT");
      await api.waitForOnline(machine);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(actionsReceived(tablet)).toEqual([]);
      expect(plugins.managed).toEqual([]);
      expect(await read(machine, made.id)).toMatchObject({ outcome: "notConfirmed", sentAt: null });
    } finally {
      frozen.signal("SIGCONT");
      await frozen.stop();
    }
  }, 200_000);
});
