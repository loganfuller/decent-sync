import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { SimulatedPlugins, bundledPlugins } from "./support/decaid-plugins.js";
import { SimulatedSkins } from "./support/decaid-skins.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #660 (ADR-0026, ADR-0034): a Machine's Tablet Software
// and its Software Actions read through an assistant, a test app on the MCP
// SDK's client connected as a Connected App, each tool's result matching
// what the REST API gives the same account; and for #661 the one tool that
// makes a Software Action, reloading the Skin or restarting the Skin view,
// with Staff's Location limit. Data comes from a simulated tablet whose
// Decaid lists the plugins and Skins a new v0.9.3 has (decaid-plugins.ts,
// decaid-skins.ts). Serials are made up.

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

    // No tool installs, enables, disables, configures, updates, approves or removes: the two reads and the reload are all there is.
    const { tools } = await assistant.client.listTools();
    const about = tools.filter((tool) => /software|plugin|skin|decaid/i.test(tool.name));
    expect(about.map((tool) => tool.name).sort()).toEqual(["get_machine_software", "list_software_actions", "reload_skin"]);
    for (const tool of about) expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: tool.name !== "reload_skin" });
    for (const term of ["Plugin:", "Tablet Software:", "Pinned:", "Software Action", "reload_skin"]) expect(assistant.client.getInstructions()).toContain(term);
  });

  it("reloads the Skin and restarts the Skin view through reload_skin, made by the account through its Connected App, with Staff's Location limit, and makes nothing else", async () => {
    const skinned = await api.createMachine("Assistant software Skin", cafe.id);
    const skins = new SimulatedSkins();
    const tablet = syncingTablet(skinned, server, { api: emptyLibrary(68_002), plugins: new SimulatedPlugins({ plugins: bundledPlugins() }), skins });
    await api.waitForOnline(skinned);
    const restSoftware = async () => (await api.get<{ tabletSoftware: { showing: Record_ | null } }>(`/machines/${skinned.machine.id}/tablet-software`)).tabletSoftware;
    await expect.poll(async () => (await restSoftware()).showing, { timeout: 15_000 }).not.toBeNull();
    const path = `/machines/${skinned.machine.id}/software-actions`;
    const outcome = async (id: string) => {
      await expect.poll(async () => (await api.get<{ softwareAction: { outcome: string | null } }>(`${path}/${id}`)).softwareAction.outcome, { timeout: 20_000 }).not.toBeNull();
      return (await api.get<{ softwareAction: Record_ }>(`${path}/${id}`)).softwareAction;
    };

    // A Skin that ignores the page report can't be reloaded, only restarted: refused as the REST API refuses it.
    const refused = await assistant.client.callTool({ name: "reload_skin", arguments: { machineId: skinned.machine.id, how: "reload" } }).catch((error: unknown) => ({ isError: true, thrown: String(error) }));
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain("has not reported its page, so it can't be asked to reload");
    const { softwareAction: restart } = await assistant.call<{ softwareAction: Record_ & { id: string } }>("reload_skin", { machineId: skinned.machine.id, how: "restart" });
    expect(restart).toMatchObject({ kind: "restartSkinView", connectedApp: { name: expect.any(String) }, account: { name: "Ada Admin" } });
    expect(await outcome(restart.id)).toMatchObject({ outcome: "done", result: { skinId: "streamline.js" } });

    // A Skin that reports its page, and reloads when asked.
    const report = () => tablet.callEndpoint("page", { method: "PUT", body: { skinId: "streamline.js", version: "0.2.32", loadedAt: new Date(tablet.readClock()).toISOString() } });
    await report();
    tablet.onEmit = (event, payload) => {
      if (event === "changes" && (payload as Record_).what === "reload") setTimeout(() => void report(), 5);
    };
    await expect.poll(async () => (await restSoftware()).showing?.page).not.toBeNull();
    const { softwareAction: reload } = await assistant.call<{ softwareAction: Record_ & { id: string } }>("reload_skin", { machineId: skinned.machine.id, how: "reload" });
    expect(await outcome(reload.id)).toMatchObject({ kind: "reloadSkin", outcome: "done", result: { page: { skinId: "streamline.js" } } });

    // Staff at the Machine's Location may; Staff elsewhere are refused as the REST API refuses them.
    const other = await api.createLocation("Assistant software elsewhere", "America/Chicago");
    for (const [email, locations, allowed] of [
      ["assistant-skin-here@example.com", [cafe.id], true],
      ["assistant-skin-away@example.com", [other.id], false],
    ] as const) {
      const { link } = await api.invite(email, "staff", [...locations]);
      const staff = await Assistant.connect(server.url, app, await acceptInvite(server.url, link, { name: "Sam Staff", password: "a password for apps" }));
      try {
        const answer = await staff.client.callTool({ name: "reload_skin", arguments: { machineId: skinned.machine.id, how: "restart" } }).catch((error: unknown) => ({ isError: true, thrown: String(error) }));
        if (allowed) expect(answer).not.toMatchObject({ isError: true });
        else expect(JSON.stringify(answer)).toContain("You can reload or restart the Skin only of a Machine at a Location you work at");
      } finally {
        await staff.close();
      }
    }
    // The tool takes a reload or a restart, and nothing else.
    expect(JSON.stringify(await assistant.client.callTool({ name: "reload_skin", arguments: { machineId: skinned.machine.id, how: "removeSkin" } }).catch((error: unknown) => ({ isError: true, thrown: String(error) })))).toMatch(/how/);
    expect(skins.managed.filter((request) => !request.startsWith("POST /webui/server/"))).toEqual([]);
  });
});
