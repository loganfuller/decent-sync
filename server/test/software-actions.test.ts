import { DECENT_SYNC_PLUGIN_ID } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { SimulatedPlugins, bundledPlugins, recordedPlugin } from "./support/decaid-plugins.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
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
});
