import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { SimulatedPlugins, bundledPlugins } from "./support/decaid-plugins.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #660 (ADR-0026, ADR-0034): a Machine's Tablet Software
// and its Software Actions read through an assistant, a test app on the MCP
// SDK's client connected as a Connected App, each tool's result matching
// what the REST API gives the same account, and no tool that makes a
// Software Action. Data comes from a simulated tablet whose Decaid lists the
// plugins a new v0.9.3 bundles (decaid-plugins.ts). Serials are made up.

type Record_ = Record<string, unknown>;
const VISUALIZER = "visualizer.reaplugin";
const instant = (at: unknown) => (typeof at === "string" ? Date.parse(at) : at);

describe("Tablet Software through an assistant", () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let cafe: LocationView;
  let machine: CreatedMachine;
  const env = { ...ASSISTANT_ENV, SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    cafe = await api.createLocation("Assistant software cafe", "America/Chicago");
  });
  afterAll(async () => {
    await assistant?.close();
    await app?.close();
    await server?.stop();
  });

  const software = async (as = api) => (await as.get<{ tabletSoftware: Record_ & { decaid: Record_ & { update: Record_ | null }; plugins: (Record_ & { id: string; settings: Record_[] })[] | null } }>(`/machines/${machine.machine.id}/tablet-software`)).tabletSoftware;

  it("reads a Machine's Tablet Software and its Software Actions as the REST API gives them, a setting's value to Admins only, and offers no tool that makes one", async () => {
    machine = await api.createMachine("Assistant software bar", cafe.id);
    syncingTablet(machine, server, { api: emptyLibrary(68_001), plugins: new SimulatedPlugins({ plugins: bundledPlugins() }) });
    await api.waitForOnline(machine);
    await expect.poll(async () => (await software()).plugins?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(1);
    await expect.poll(async () => (await software()).decaid.update).not.toBeNull();

    // An Admin configures and disables a plugin in the management interface.
    const path = `/machines/${machine.machine.id}/software-actions`;
    const done = async (body: unknown) => {
      const made = (await api.send<{ softwareAction: { id: string } }>("POST", path, body, 201)).softwareAction;
      await expect.poll(async () => (await api.get<{ softwareAction: { outcome: string | null } }>(`${path}/${made.id}`)).softwareAction.outcome, { timeout: 20_000 }).not.toBeNull();
      return made.id;
    };
    const configured = await done({ kind: "changePluginSettings", pluginId: VISUALIZER, values: { Username: "sam" }, expected: { Username: null } });
    await done({ kind: "disablePlugin", pluginId: VISUALIZER });

    const rest = await software();
    const read = await assistant.call<typeof rest>("get_machine_software", { machineId: machine.machine.id });
    // Its times with the offset of the Machine's Location; everything else as the REST API gives it.
    expect({ ...read, decaid: { ...read.decaid, update: { ...read.decaid.update, reportedAt: instant(read.decaid.update!.reportedAt) } } }).toEqual({
      ...rest,
      decaid: { ...rest.decaid, update: { ...rest.decaid.update, reportedAt: instant(rest.decaid.update!.reportedAt) } },
    });
    expect(String(read.decaid.update!.reportedAt)).toMatch(/-0[56]:00$/);
    const visualizer = read.plugins!.find((plugin) => plugin.id === VISUALIZER)!;
    expect(visualizer).toMatchObject({ state: "disabled", updates: { how: "notUpdated" } });
    expect(visualizer.settings.find((setting) => setting.name === "Username")).toMatchObject({ value: "sam" });
    expect(visualizer.settings.find((setting) => setting.name === "Password")).toMatchObject({ secret: true, value: { isSet: false } });

    interface Listed { softwareActions: (Record_ & { id: string; madeAt: string; sentAt: string; answeredAt: string })[]; total: number; more: boolean }
    const listed = await assistant.call<Listed>("list_software_actions", { machineId: machine.machine.id });
    const { softwareActions } = await api.get<{ softwareActions: (Record_ & { id: string; machineId: string })[] }>(path);
    expect(listed).toMatchObject({ total: 2, more: false });
    const timeless = ({ madeAt, sentAt, answeredAt, machineId: _machineId, ...rest }: Record_) => ({ ...rest, madeAt: instant(madeAt), sentAt: instant(sentAt), answeredAt: instant(answeredAt) });
    expect(listed.softwareActions.map(timeless)).toEqual(softwareActions.map(timeless));
    expect(listed.softwareActions.map((action) => [action.kind, action.outcome])).toEqual([["disablePlugin", "done"], ["changePluginSettings", "done"]]);
    expect(listed.softwareActions[1]).toMatchObject({ params: { plugin: { id: VISUALIZER, name: "Visualizer upload" }, settings: ["Username"] }, account: { name: "Ada Admin" } });
    expect(listed.softwareActions[0]!.madeAt).toMatch(/-0[56]:00$/);

    // The Settings History names the action that changed the plugins' settings.
    const { changes } = await assistant.call<{ changes: { softwareAction: { id: string; kind: string } | null; fields: Record_[] }[] }>("list_settings_history", { machineId: machine.machine.id, collections: ["pluginSettings"] });
    expect(changes).toMatchObject([{ softwareAction: { id: configured, kind: "changePluginSettings" }, fields: [{ field: `${VISUALIZER}/Username`, after: "sam" }] }]);

    // Staff read both, without the settings' values or who made an action.
    const { link } = await api.invite("assistant-software@example.com", "staff", [cafe.id]);
    const cookie = await acceptInvite(server.url, link, { name: "Sam Staff", password: "a password for apps" });
    const staff = await Assistant.connect(server.url, app, cookie);
    try {
      const forStaff = await staff.call<typeof rest>("get_machine_software", { machineId: machine.machine.id });
      expect(forStaff.plugins!.find((plugin) => plugin.id === VISUALIZER)!.settings.every((setting) => !("value" in setting))).toBe(true);
      expect((await staff.call<Listed>("list_software_actions", { machineId: machine.machine.id })).softwareActions[0]).toMatchObject({ account: { name: null } });
      const history = await staff.call<{ changes: { fields: Record_[] }[] }>("list_settings_history", { machineId: machine.machine.id, collections: ["pluginSettings"] });
      expect(history.changes[0]!.fields).toMatchObject([{ field: `${VISUALIZER}/Username`, after: { hidden: true } }]);
    } finally {
      await staff.close();
    }

    // No tool installs, enables, disables, configures, updates, approves or removes: the two reads are all there is.
    const { tools } = await assistant.client.listTools();
    const about = tools.filter((tool) => /software|plugin/i.test(tool.name));
    expect(about.map((tool) => tool.name).sort()).toEqual(["get_machine_software", "list_software_actions"]);
    for (const tool of about) expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true });
    for (const term of ["Plugin:", "Tablet Software:", "Pinned:", "Software Action"]) expect(assistant.client.getInstructions()).toContain(term);
  });
});
