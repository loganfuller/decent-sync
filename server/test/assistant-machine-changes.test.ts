import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #413 (#405, ADR-0026): Machines and Locations changed through an
// assistant, a test app on the MCP SDK's client connected as a Connected App,
// against the built server. A Settings Edit made through it reaches a
// simulated tablet at Uptown, connected to the other of two instances, and
// comes back with its outcome, in list_settings_edits and the REST API, as
// the account's through that Connected App. A move credits the Machine's
// Shots from then on to its new Location. An Admin turns its sharing off and
// on, and creates and edits Locations. Staff are refused what the REST API
// refuses them, with its message, the Admin-only tools included, and a
// Connected App that may only read, or a Viewer's, is refused with 403
// insufficient_scope. Serials are made up, from 41301.

type Record_ = Record<string, unknown>;

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const SERIAL = "41301";

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** The value with each ISO 8601 time as its instant: the REST API gives times in UTC, the tools with the offset of the Location the Machine was at then. */
function instants(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "string" && ISO_TIME.test(field) ? Date.parse(field) : field));
}

interface ConnectedApp {
  id: string;
  name: string;
  host: string;
}

interface SettingsEdit {
  id: string;
  collection: string;
  schedule: { action: string; id: string | null } | null;
  fields: Record_;
  account: { id: string; name: string | null } | null;
  connectedApp: ConnectedApp | null;
  outcome: string | null;
}

interface Machine {
  location: LocationView | null;
  locationHistory: { id?: string; location: LocationView; effectiveFrom: string }[];
  sharing: boolean;
  captureOnly: string[];
}

/** A Shot pulled on the Machine now, by the test's clock in UTC, as the Location History test times them, naming the Machine's hardware. */
function pulledNow(id: string): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return { ...fixture, id, timestamp: new Date().toISOString(), workflow: { ...workflow, machine: { ...(workflow.machine as Record_), serialNumber: SERIAL } } };
}

describe("Changing Machines and Locations through an assistant", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let app: TestApp;
  /** The Admin's assistant, which may read and change, and another of theirs, which may only read. */
  let assistant: Assistant;
  let reader: Assistant;
  let adminId: string;
  let uptown: LocationView;
  let harbor: LocationView;
  let machine: CreatedMachine;
  let machineId: string;
  let tablet: SimulatedTablet;
  /** The Admin's Connected App, as a Settings Edit made through it names it. */
  let adminsApp: ConnectedApp;
  const tablets = new LoadedTablets();
  const opened: Assistant[] = [];

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    const cookie = await signIn(server.url, admin);
    assistant = await Assistant.connect(server.url, app, cookie);
    reader = await Assistant.connect(server.url, app, cookie, { allowed: ["read"] });
    opened.push(assistant, reader);
    adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
    uptown = await api.createLocation("Uptown", "America/Chicago");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
  });
  afterAll(async () => {
    for (const each of opened) await each.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  /** A Staff member or Viewer, with an assistant connected as them that may read and change, their REST API and their account's id. */
  async function person(email: string, role: "staff" | "viewer", locations: LocationView[]): Promise<{ assistant: Assistant; api: AdminApi; id: string }> {
    const { link } = await api.invite(email, role, locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for apps" });
    const theirs = await Assistant.connect(server.url, app, cookie, { allowed: role === "viewer" ? ["read"] : ["read", "change"] });
    opened.push(theirs);
    const rest = AdminApi.signedInAs(server.url, cookie);
    return { assistant: theirs, api: rest, id: (await rest.get<{ account: { id: string } }>("/session")).account.id };
  }

  /** A tool's error, which the call must answer with. */
  async function toolError(by: Assistant, name: string, args: Record_): Promise<string> {
    const result = await by.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }

  /** The REST API's refusal of a request, which must be refused with the status, as its message. */
  async function restRefusal(as: AdminApi, method: string, path: string, body: unknown, status: number): Promise<string> {
    const response = await as.call(method, path, body);
    expect(response.status, path).toBe(status);
    const { message } = (await response.json()) as { message: string | string[] };
    return Array.isArray(message) ? message.join("; ") : message;
  }

  const editsPath = () => `/machines/${machineId}/settings-edits`;
  const restMachine = async () => (await api.get<{ machine: Machine }>(`/machines/${machineId}`)).machine;
  /** Where the Machine is and has been, and whether it shares, as the REST API gives them. */
  const placed = async () => {
    const { location, locationHistory, sharing } = await restMachine();
    return { location, locationHistory, sharing };
  };
  const restShot = async (id: string) => (await api.get<{ shot: { location: LocationView | null } }>(`/shots/${id}`)).shot;
  const settingsEdits = async (by = assistant) => (await by.call<{ settingsEdits: SettingsEdit[]; total: number }>("list_settings_edits", { machineId })).settingsEdits;

  /** The Settings Edit once it has an outcome, as list_settings_edits gives it to the assistant. */
  async function answered(id: string, by = assistant): Promise<SettingsEdit & Record_> {
    let found: (SettingsEdit & Record_) | undefined;
    await expect
      .poll(
        async () => {
          found = (await settingsEdits(by)).find((edit) => edit.id === id) as (SettingsEdit & Record_) | undefined;
          return found?.outcome;
        },
        { timeout: 15_000 },
      )
      .toEqual(expect.any(String));
    return found!;
  }

  it("has Uptown's bar online through the other instance, its Machine Settings and presence settings reported", async () => {
    machine = await api.createMachine("Uptown bar", uptown.id);
    machineId = machine.machine.id;
    tablet = tablets.syncing(machine, other, { api: emptyLibrary(SERIAL) });
    await api.waitForOnline(machine);
    for (const name of ["machineSettings", "presenceSettings"]) {
      await expect.poll(() => api.get<{ collection: unknown }>(`/machines/${machineId}/collections/${name}`), { timeout: 15_000 }).not.toEqual({ collection: null });
    }
  });

  it("makes a Settings Edit from the values get_machine gives, which reaches the tablet and comes back applied, the Admin's through the Connected App", async () => {
    const read = await assistant.call<{ machineSettings: { machineSettings: { value: Record_ } } }>("get_machine", { machineId });
    const fan = read.machineSettings.machineSettings.value.fan;
    expect(fan).toBe(50);
    const { settingsEdit } = await assistant.call<{ settingsEdit: SettingsEdit }>("edit_machine_settings", {
      machineId: machineId.toUpperCase(),
      collection: "machineSettings",
      fields: { fan: 40 },
      expected: { fan },
    });
    adminsApp = settingsEdit.connectedApp!;
    expect(settingsEdit).toMatchObject({
      collection: "machineSettings",
      fields: { fan: 40 },
      expected: { fan: 50 },
      account: { id: adminId, name: "Ada Admin" },
      connectedApp: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Test Assistant", host: new URL(app.clientId).host },
    });

    const applied = await answered(settingsEdit.id);
    expect(applied).toMatchObject({ outcome: "applied", readBack: { fan: 40 }, connectedApp: adminsApp });
    expect((await tablet.callApi("GET", "/machine/settings")).body).toMatchObject({ fan: 40 });
    // As the REST API gives it, with its times at Uptown's offset.
    const { machineId: _, ...rest } = (await api.get<{ settingsEdit: Record_ }>(`${editsPath()}/${settingsEdit.id}`)).settingsEdit;
    expect(instants(applied)).toEqual(instants(rest));
    expect(rest.connectedApp).toEqual(adminsApp);
    expect((applied.madeAt as string).slice(-6)).toMatch(/^-0[56]:00$/);
  });

  it("adds a wake schedule, and is refused by the tablet an edit expecting a value it no longer holds, each outcome read through list_settings_edits", async () => {
    const { settingsEdit: added } = await assistant.call<{ settingsEdit: SettingsEdit }>("edit_machine_settings", {
      machineId,
      collection: "presenceSettings",
      schedule: { action: "add" },
      fields: { time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true, keepAwakeFor: null },
      expected: {},
    });
    expect(await answered(added.id)).toMatchObject({ outcome: "applied", schedule: { action: "add", id: expect.any(String) }, connectedApp: adminsApp });
    const presence = (await tablet.callApi("GET", "/presence/settings")).body as { schedules: Record_[] };
    expect(presence.schedules).toContainEqual(expect.objectContaining({ time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true }));

    const { settingsEdit: stale } = await assistant.call<{ settingsEdit: SettingsEdit }>("edit_machine_settings", {
      machineId,
      collection: "machineSettings",
      fields: { fan: 45 },
      expected: { fan: 50 },
    });
    expect(await answered(stale.id)).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", current: { fan: 40 } } });
    expect((await tablet.callApi("GET", "/machine/settings")).body).toMatchObject({ fan: 40 });
  });

  it("refuses at once, with the REST API's message and nothing kept, an edit the REST API refuses", async () => {
    const before = (await api.get<{ total: number }>(editsPath())).total;
    for (const [args, status] of [
      [{ collection: "machineSettings", fields: { fan: 70 }, expected: { fan: 40 } }, 400],
      [{ collection: "machineSettings", fields: { steamFlow: 1.5 }, expected: { steamFlow: 1 } }, 400],
      [{ collection: "machineSettings", fields: { fan: 45 }, expected: {} }, 400],
      [{ collection: "presenceSettings", schedule: { action: "change" }, fields: { enabled: false }, expected: {} }, 400],
      [{ collection: "presenceSettings", schedule: { action: "add", id: "x" }, fields: { enabled: false }, expected: {} }, 400],
    ] as const) {
      expect(await toolError(assistant, "edit_machine_settings", { machineId, ...args }), JSON.stringify(args)).toBe(await restRefusal(api, "POST", editsPath(), args, status));
    }
    expect(await toolError(assistant, "edit_machine_settings", { machineId: randomUUID(), collection: "machineSettings", fields: { fan: 45 }, expected: { fan: 40 } })).toBe(
      await restRefusal(api, "POST", `/machines/${randomUUID()}/settings-edits`, { collection: "machineSettings", fields: { fan: 45 }, expected: { fan: 40 } }, 404),
    );
    // The tool's own schema: a collection that isn't one, and a field it doesn't take.
    expect(await toolError(assistant, "edit_machine_settings", { machineId, collection: "plugins", fields: { fan: 45 }, expected: { fan: 40 } })).toContain("collection");
    expect(await toolError(assistant, "edit_machine_settings", { machineId, collection: "machineSettings", fields: { fan: 45 }, expected: { fan: 40 }, effectiveFrom: "now" })).toContain("effectiveFrom");
    expect((await api.get<{ total: number }>(editsPath())).total).toBe(before);
  });

  it("moves the Machine to Harbor, crediting its Shots from then on to Harbor, as the REST API's Location History does", async () => {
    tablet.pullShot(pulledNow("before-move-413"));
    await expect.poll(async () => (await api.call("GET", "/shots/before-move-413")).status, { timeout: 15_000 }).toBe(200);
    expect((await restShot("before-move-413")).location?.id).toBe(uptown.id);

    // Well after it, whatever the drift between the test's clock and PostgreSQL's.
    await delay(1_000);
    const { machine: moved } = await assistant.call<{ machine: Machine }>("move_machine", { machineId, locationId: harbor.id.toUpperCase() });
    expect(moved.location).toEqual(harbor);
    const rest = await restMachine();
    expect(instants(moved.locationHistory)).toEqual(instants(rest.locationHistory.map(({ id: _, ...entry }) => entry)));
    expect(moved.locationHistory.map((entry) => entry.location.name)).toEqual(["Uptown", "Harbor"]);
    // Its arrival at Harbor with Tokyo's offset.
    expect(moved.locationHistory[1]!.effectiveFrom).toMatch(/\+09:00$/);

    await delay(1_000);
    tablet.pullShot(pulledNow("after-move-413"));
    await expect.poll(async () => (await api.call("GET", "/shots/after-move-413")).status, { timeout: 15_000 }).toBe(200);
    expect((await restShot("after-move-413")).location?.id).toBe(harbor.id);
    expect((await restShot("before-move-413")).location?.id).toBe(uptown.id);
    expect((await assistant.call<{ location: LocationView }>("get_shot", { id: "after-move-413" })).location).toEqual(harbor);

    // Refused as the REST API refuses it, changing nothing.
    for (const [locationId, status] of [
      [harbor.id, 409],
      [randomUUID(), 400],
      ["Harbor", 400],
    ] as const) {
      expect(await toolError(assistant, "move_machine", { machineId, locationId }), locationId).toBe(
        await restRefusal(api, "POST", `/machines/${machineId}/location-history`, { locationId }, status),
      );
    }
    expect(await toolError(assistant, "move_machine", { machineId, locationId: uptown.id, effectiveFrom: "2026-11-01T00:00:00Z" })).toContain("effectiveFrom");
    expect((await restMachine()).locationHistory).toHaveLength(2);
  });

  it("turns the Machine's sharing off and on, and creates and edits a Location, as an Admin does through the REST API", async () => {
    const off = await assistant.call<{ machine: Machine }>("set_machine_sharing", { machineId, sharing: false });
    expect(off.machine).toMatchObject({ sharing: false, captureOnly: ["sharingOff"] });
    expect(await restMachine()).toMatchObject({ sharing: false, captureOnly: ["sharingOff"] });
    // Again, changing nothing more.
    expect((await assistant.call<{ machine: Machine }>("set_machine_sharing", { machineId, sharing: false })).machine).toMatchObject({ sharing: false });
    const on = await assistant.call<{ machine: Machine }>("set_machine_sharing", { machineId, sharing: true });
    expect(on.machine).toMatchObject({ sharing: true, captureOnly: [] });
    expect(await restMachine()).toMatchObject({ sharing: true, captureOnly: [] });

    const { location } = await assistant.call<{ location: LocationView }>("create_location", { name: "Lab 413", timeZone: " europe/london " });
    expect(location).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Lab 413", timeZone: "Europe/London" });
    const restLocations = async () => (await api.get<{ locations: LocationView[] }>("/locations")).locations;
    expect(await restLocations()).toContainEqual(location);
    const { location: edited } = await assistant.call<{ location: LocationView }>("edit_location", { locationId: location.id.toUpperCase(), name: "Lab", timeZone: "America/Denver" });
    expect(edited).toEqual({ id: location.id, name: "Lab", timeZone: "America/Denver" });
    expect((await assistant.call<{ location: LocationView }>("edit_location", { locationId: location.id, name: "Lab" })).location).toEqual(edited);
    expect(await restLocations()).toContainEqual(edited);

    // Refused as the REST API refuses it.
    for (const [tool, args, method, path, status] of [
      ["create_location", { name: "Uptown", timeZone: "UTC" }, "POST", "/locations", 409],
      ["create_location", { name: " ", timeZone: "Mars/Olympus" }, "POST", "/locations", 400],
      ["edit_location", { locationId: location.id, name: "Harbor" }, "PATCH", `/locations/${location.id}`, 409],
      ["edit_location", { locationId: location.id }, "PATCH", `/locations/${location.id}`, 400],
      ["edit_location", { locationId: randomUUID(), name: "Nowhere" }, "PATCH", `/locations/${randomUUID()}`, 404],
    ] as const) {
      const { locationId: _, ...body } = args as Record_;
      expect(await toolError(assistant, tool, args), `${tool} ${JSON.stringify(args)}`).toBe(await restRefusal(api, method, path, body, status));
    }
    expect((await restLocations()).map((each) => each.name)).toEqual(["Harbor", "Lab", "Uptown"]);
  });

  it("lets Staff edit a Machine's settings marked for Staff and move it between their Locations, refusing the rest as the REST API does, the Admin-only tools included", async () => {
    const sam = await person("sam-413@example.com", "staff", [harbor]);
    const { settingsEdit } = await sam.assistant.call<{ settingsEdit: SettingsEdit }>("edit_machine_settings", {
      machineId,
      collection: "machineSettings",
      fields: { steamPurgeMode: 1 },
      expected: { steamPurgeMode: 0 },
    });
    const samsEdit = await answered(settingsEdit.id);
    expect(samsEdit).toMatchObject({ outcome: "applied", account: { id: sam.id, name: "sam-413@example.com" }, connectedApp: { name: "Test Assistant", host: new URL(app.clientId).host } });
    expect(samsEdit.connectedApp!.id).not.toBe(adminsApp.id);
    // To Staff, the account by its id only, the app by name.
    const [asStaff, , , adminsAsStaff] = await settingsEdits(sam.assistant);
    expect(asStaff).toMatchObject({ account: { id: sam.id, name: null }, connectedApp: samsEdit.connectedApp });
    expect(adminsAsStaff).toMatchObject({ account: { id: adminId, name: null }, connectedApp: adminsApp });
    expect((await sam.api.get<{ settingsEdits: Record_[] }>(editsPath())).settingsEdits[0]).toMatchObject({ account: { name: null }, connectedApp: samsEdit.connectedApp });

    const refused = async () => {
      for (const [tool, args, method, path, body, status] of [
        [
          "edit_machine_settings",
          { machineId, collection: "advancedSettings", fields: { heaterIdleTemp: 90 }, expected: { heaterIdleTemp: 98 } },
          "POST",
          editsPath(),
          { collection: "advancedSettings", fields: { heaterIdleTemp: 90 }, expected: { heaterIdleTemp: 98 } },
          403,
        ],
        ["move_machine", { machineId, locationId: uptown.id }, "POST", `/machines/${machineId}/location-history`, { locationId: uptown.id }, 403],
        ["set_machine_sharing", { machineId, sharing: false }, "PUT", `/machines/${machineId}/sharing`, { sharing: false }, 403],
        ["create_location", { name: "Sam's", timeZone: "UTC" }, "POST", "/locations", { name: "Sam's", timeZone: "UTC" }, 403],
        ["edit_location", { locationId: harbor.id, name: "Sam's" }, "PATCH", `/locations/${harbor.id}`, { name: "Sam's" }, 403],
      ] as const) {
        expect(await toolError(sam.assistant, tool, args), tool).toBe(await restRefusal(sam.api, method, path, body, status));
      }
    };
    await refused();
    expect(await toolError(sam.assistant, "set_machine_sharing", { machineId, sharing: false })).toBe("Only an Admin can do this");

    // Moved off Harbor, Sam is refused from the next call: neither moving the Machine nor editing its settings.
    await api.send("PUT", `/accounts/${sam.id}/access`, { role: "staff", locationIds: [uptown.id] });
    for (const [tool, args, path, body] of [
      ["move_machine", { machineId, locationId: uptown.id }, `/machines/${machineId}/location-history`, { locationId: uptown.id }],
      ["edit_machine_settings", { machineId, collection: "machineSettings", fields: { fan: 35 }, expected: { fan: 40 } }, editsPath(), { collection: "machineSettings", fields: { fan: 35 }, expected: { fan: 40 } }],
    ] as const) {
      expect(await toolError(sam.assistant, tool, args), tool).toBe(await restRefusal(sam.api, "POST", path, body, 403));
    }

    // Working at both, Sam moves it back to Uptown.
    await api.send("PUT", `/accounts/${sam.id}/access`, { role: "staff", locationIds: [harbor.id, uptown.id] });
    const { machine: moved } = await sam.assistant.call<{ machine: Machine }>("move_machine", { machineId, locationId: uptown.id });
    expect(moved.locationHistory.map((entry) => entry.location.name)).toEqual(["Uptown", "Harbor", "Uptown"]);
    expect((await restMachine()).location).toEqual(uptown);
  });

  it("refuses every one of these tools, from a Connected App that may only read and from a Viewer's, with 403 insufficient_scope naming read and change, changing nothing", async () => {
    const before = { machine: await placed(), edits: (await api.get<{ total: number }>(editsPath())).total, locations: await api.get("/locations") };
    const calls: [string, Record_][] = [
      ["move_machine", { machineId, locationId: harbor.id }],
      ["set_machine_sharing", { machineId, sharing: false }],
      ["edit_machine_settings", { machineId, collection: "machineSettings", fields: { fan: 30 }, expected: { fan: 40 } }],
      ["create_location", { name: "Refused 413", timeZone: "UTC" }],
      ["edit_location", { locationId: uptown.id, name: "Refused 413" }],
    ];
    const { tools } = await reader.client.listTools();
    for (const [name] of calls) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: name === "edit_machine_settings", openWorldHint: false });
    }
    const refuse = async (accessToken: string, who: string) => {
      for (const [name, args] of calls) {
        const refused = await Assistant.rawCall(server.url, accessToken, "tools/call", { name, arguments: args });
        expect(refused.status, `${who} ${name}`).toBe(403);
        const challenge = refused.headers.get("www-authenticate") ?? "";
        expect(challenge, `${who} ${name}`).toMatch(/^Bearer /);
        expect(challenge, `${who} ${name}`).toContain('error="insufficient_scope"');
        expect(challenge, `${who} ${name}`).toContain('scope="read change"');
      }
    };
    await refuse(reader.tokens.access_token, "Read-only");
    // It still reads.
    expect((await reader.call<{ machine: Machine }>("get_machine", { machineId })).machine.location).toEqual(uptown);

    // A Staff member's Connected App, allowed to change, changes nothing from the call after their account becomes a Viewer.
    const vic = await person("vic-413@example.com", "staff", [uptown]);
    await api.send("PUT", `/accounts/${vic.id}/access`, { role: "viewer" });
    await refuse(vic.assistant.tokens.access_token, "As Viewer");

    expect(await placed()).toEqual(before.machine);
    expect((await api.get<{ total: number }>(editsPath())).total).toBe(before.edits);
    expect(await api.get("/locations")).toEqual(before.locations);
  });
});
