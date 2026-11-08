import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, type Allowed, Assistant, type TestApp, serveTestApp, tokenRequest } from "./support/assistants.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seeing and disconnecting Connected Apps (#410; #405, ADR-0027) at Seam 1:
// each account lists and disconnects its own through the REST API, and an
// Admin every account's; a Connected App disconnected through one instance
// is refused on the other at its next request; deactivating an account
// disconnects its Connected Apps; and Staff and Viewers neither list nor
// disconnect another account's. Apps connect as a test app on the MCP SDK's
// client, approved through the REST API as the consent page would.

/** A Connected App as the REST API lists it. */
interface ConnectedAppView {
  id: string;
  name: string;
  host: string;
  scopes: string[];
  approvedAt: string;
  lastUsedAt: string;
}

interface AccountConnectedAppView extends ConnectedAppView {
  account: { id: string; name: string; email: string };
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("Connected Apps", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let adminCookie: string;
  let adminId: string;
  let app: TestApp;
  let uptown: LocationView;
  /** Connected as each test needs, and closed once they have run. */
  const assistants: Assistant[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env: ASSISTANT_ENV });
    // Every instance of a deployment has the same public URL, which names the endpoint its tokens are for.
    other = await startTestServer({ env: ASSISTANT_ENV, sharing: server, publicUrl: server.url });
    api = await AdminApi.setUp(server.url);
    adminCookie = await signIn(server.url, admin);
    adminId = (await api.accounts()).find((account) => account.email === admin.email)!.id;
    app = await serveTestApp();
    uptown = await api.createLocation("Uptown", "America/Chicago");
  });
  afterAll(async () => {
    await Promise.all(assistants.map((assistant) => assistant.close()));
    await app?.close();
    await other?.stop();
    await server?.stop();
  });

  /** A Staff member at Uptown or a Viewer, signed in, with their own REST API, named after their email. */
  async function person(email: string, role: "staff" | "viewer"): Promise<{ id: string; name: string; email: string; cookie: string; api: AdminApi }> {
    const { link } = await api.invite(email, role, role === "staff" ? [uptown.id] : []);
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for apps" });
    const id = (await api.accounts()).find((account) => account.email === email)!.id;
    return { id, name: email, email, cookie, api: AdminApi.signedInAs(server.url, cookie) };
  }

  /** Connects the test app as the account signed in with `cookie`, allowing it `allowed`. */
  async function connect(cookie: string, allowed: Allowed = ["read", "change"]): Promise<Assistant> {
    const assistant = await Assistant.connect(server.url, app, cookie, { allowed });
    assistants.push(assistant);
    return assistant;
  }

  /** The account's Connected App approved last, which its list gives first. */
  async function newest(asWho: AdminApi): Promise<ConnectedAppView> {
    return (await listed(asWho))[0]!;
  }

  async function listed(asWho: AdminApi): Promise<ConnectedAppView[]> {
    return (await asWho.get<{ connectedApps: ConnectedAppView[] }>("/connected-apps")).connectedApps;
  }

  async function listedForAdmin(): Promise<AccountConnectedAppView[]> {
    return (await api.get<{ connectedApps: AccountConnectedAppView[] }>("/accounts/connected-apps")).connectedApps;
  }

  const refresh = (url: string, refreshToken: string) =>
    tokenRequest(url, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: app.clientId });

  const callStatus = async (url: string, assistant: Assistant) => (await Assistant.rawCall(url, assistant.tokens.access_token)).status;

  it("lists each account's own Connected Apps, the latest approved first, and an Admin every account's", async () => {
    const staff = await person("li-staff@example.com", "staff");
    const viewer = await person("li-viewer@example.com", "viewer");

    await connect(adminCookie, ["read"]);
    const adminsFirst = await newest(api);
    await connect(adminCookie);
    const adminsSecond = await newest(api);
    await connect(staff.cookie);
    await connect(viewer.cookie, ["read"]);

    expect(adminsFirst).toEqual({ id: expect.any(String), name: "Test Assistant", host: new URL(app.clientId).host, scopes: ["read"], approvedAt: expect.stringMatching(ISO_TIME), lastUsedAt: expect.stringMatching(ISO_TIME) });
    // Two approvals of one app, as on two laptops, are two Connected Apps.
    expect(adminsSecond.scopes).toEqual(["read", "change"]);
    expect(await listed(api)).toEqual([adminsSecond, adminsFirst]);
    expect((await listed(staff.api)).map((listedApp) => listedApp.scopes)).toEqual([["read", "change"]]);
    expect((await listed(viewer.api)).map((listedApp) => listedApp.scopes)).toEqual([["read"]]);

    // An Admin's list: by account name, each account's as it lists its own.
    const all = await listedForAdmin();
    const owners = [
      { id: adminId, name: admin.name, email: admin.email, api },
      staff,
      viewer,
    ];
    const expected: AccountConnectedAppView[] = [];
    for (const { id, name, email, api: theirs } of owners) {
      expected.push(...(await listed(theirs)).map((listedApp) => ({ ...listedApp, account: { id, name, email } })));
    }
    expect(all).toEqual(expected);

    // What it may do now: a Staff member made a Viewer has an app that only reads, until made Staff again.
    await api.send("PUT", `/accounts/${staff.id}/access`, { role: "viewer" });
    expect((await listed(staff.api)).map((listedApp) => listedApp.scopes)).toEqual([["read"]]);
    await api.send("PUT", `/accounts/${staff.id}/access`, { role: "staff", locationIds: [uptown.id] });
    expect((await listed(staff.api)).map((listedApp) => listedApp.scopes)).toEqual([["read", "change"]]);
  });

  it("gives when each was last used, by PostgreSQL's clock, at most once an hour, and leaves out one lapsed 30 days after", async () => {
    const user = await person("lu@example.com", "staff");
    const assistant = await connect(user.cookie);
    const { id, approvedAt, lastUsedAt } = await newest(user.api);
    const database = await server.connectDatabase();
    try {
      // Two hours on, by PostgreSQL's clock.
      await database.query("UPDATE connected_apps SET approved_at = approved_at - interval '2 hours', last_used_at = last_used_at - interval '2 hours' WHERE id = $1", [id]);
      const aged = await newest(user.api);
      expect(Date.parse(aged.lastUsedAt)).toBe(Date.parse(lastUsedAt) - 2 * 3600_000);
      await assistant.call("list_locations");
      const used = await newest(user.api);
      expect(Date.parse(used.lastUsedAt)).toBeGreaterThan(Date.parse(aged.lastUsedAt) + 3600_000);
      expect(used.approvedAt).toBe(new Date(Date.parse(approvedAt) - 2 * 3600_000).toISOString());

      // Unused for 30 days, it is refused, and listed to no one.
      await database.query("UPDATE connected_apps SET last_used_at = now() - interval '30 days 1 second' WHERE id = $1", [id]);
      expect(await callStatus(server.url, assistant)).toBe(401);
      expect(await listed(user.api)).toEqual([]);
      expect((await listedForAdmin()).map((listedApp) => listedApp.id)).not.toContain(id);
    } finally {
      await database.end();
    }
  });

  it("refuses a Connected App disconnected through one instance on the other at its next request, leaving the account's others", async () => {
    const laptop = await connect(adminCookie);
    const disconnected = await newest(api);
    const otherLaptop = await connect(adminCookie);
    expect(await callStatus(server.url, laptop)).toBe(200);

    await api.at(other.url).send("POST", `/connected-apps/${disconnected.id}/disconnect`, undefined, 204);
    expect(await callStatus(server.url, laptop)).toBe(401);
    expect(await callStatus(other.url, laptop)).toBe(401);
    expect(await refresh(server.url, laptop.tokens.refresh_token!)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    // The other laptop's is another Connected App, still working.
    expect(await callStatus(server.url, otherLaptop)).toBe(200);
    expect((await listed(api)).map((listedApp) => listedApp.id)).not.toContain(disconnected.id);
    expect((await listedForAdmin()).map((listedApp) => listedApp.id)).not.toContain(disconnected.id);

    // Again changes nothing; one not there, or no id at all, is not found.
    await api.send("POST", `/connected-apps/${disconnected.id}/disconnect`, undefined, 204);
    expect(await callStatus(server.url, laptop)).toBe(401);
    for (const id of ["01900000-0000-7000-8000-000000000000", "not-an-id"]) {
      const response = await api.call("POST", `/connected-apps/${id}/disconnect`);
      expect({ id, status: response.status, body: await response.json() }).toMatchObject({ id, status: 404, body: { message: "No such Connected App" } });
    }
  });

  it("lets an Admin disconnect any account's, and Staff and Viewers only their own, and list only their own", async () => {
    const staff = await person("own-staff@example.com", "staff");
    const viewer = await person("own-viewer@example.com", "viewer");
    const adminsApp = await connect(adminCookie);
    const adminsId = (await newest(api)).id;
    const staffsApp = await connect(staff.cookie);
    const staffsId = (await newest(staff.api)).id;
    const viewersApp = await connect(viewer.cookie, ["read"]);
    const viewersId = (await newest(viewer.api)).id;

    // Neither lists every account's, nor sees another's in their own.
    for (const someone of [staff, viewer]) {
      expect((await someone.api.call("GET", "/accounts/connected-apps")).status).toBe(403);
      expect((await listed(someone.api)).map((listedApp) => listedApp.id)).toEqual([someone === staff ? staffsId : viewersId]);
    }
    // Nor disconnects another's: not found, as if it were not there, and it still works.
    for (const [someone, id] of [
      [staff, adminsId],
      [staff, viewersId],
      [viewer, adminsId],
      [viewer, staffsId],
    ] as const) {
      const response = await someone.api.call("POST", `/connected-apps/${id}/disconnect`);
      expect({ who: someone.name, id, status: response.status }).toEqual({ who: someone.name, id, status: 404 });
    }
    for (const assistant of [adminsApp, staffsApp, viewersApp]) expect(await callStatus(server.url, assistant)).toBe(200);

    // A Viewer disconnects their own, as signing out ends their own session.
    await viewer.api.send("POST", `/connected-apps/${viewersId}/disconnect`, undefined, 204);
    expect(await callStatus(server.url, viewersApp)).toBe(401);
    // An Admin disconnects a Staff member's.
    await api.send("POST", `/connected-apps/${staffsId}/disconnect`, undefined, 204);
    expect(await callStatus(server.url, staffsApp)).toBe(401);
    expect(await listed(staff.api)).toEqual([]);
    expect(await callStatus(server.url, adminsApp)).toBe(200);

    // Signed out, nothing.
    expect((await fetch(`${server.url}/api/connected-apps`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/connected-apps/${adminsId}/disconnect`, { method: "POST" })).status).toBe(401);
    expect(await callStatus(server.url, adminsApp)).toBe(200);
  });

  it("disconnects an account's Connected Apps as it is deactivated, and they stay disconnected once it is reactivated", async () => {
    const leaving = await person("leaving@example.com", "staff");
    const phone = await connect(leaving.cookie);
    const laptop = await connect(leaving.cookie, ["read"]);
    const staying = await connect(adminCookie);
    expect(await listed(leaving.api)).toHaveLength(2);

    await api.send("POST", `/accounts/${leaving.id}/deactivate`);
    await api.send("POST", `/accounts/${leaving.id}/reactivate`);
    const cookie = await signIn(server.url, { email: "leaving@example.com", password: "a password for apps" });
    expect(await listed(AdminApi.signedInAs(server.url, cookie))).toEqual([]);
    expect((await listedForAdmin()).filter((listedApp) => listedApp.account.id === leaving.id)).toEqual([]);
    for (const assistant of [phone, laptop]) {
      expect(await callStatus(server.url, assistant)).toBe(401);
      expect(await refresh(server.url, assistant.tokens.refresh_token!)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    }
    expect(await callStatus(server.url, staying)).toBe(200);
    // Connecting again makes a new Connected App, which works.
    const again = await connect(cookie);
    expect(await callStatus(server.url, again)).toBe(200);
  });

  it("with MCP_ENABLED off, still lists and disconnects them", async () => {
    const off = await startTestServer({ env: { MCP_ENABLED: "false" }, sharing: server, publicUrl: server.url });
    try {
      const assistant = await connect(adminCookie);
      const { id } = await newest(api);
      const offApi = api.at(off.url);
      expect((await listed(offApi)).map((listedApp) => listedApp.id)).toContain(id);
      expect((await offApi.get<{ connectedApps: AccountConnectedAppView[] }>("/accounts/connected-apps")).connectedApps.map((listedApp) => listedApp.id)).toContain(id);
      await offApi.send("POST", `/connected-apps/${id}/disconnect`, undefined, 204);
      expect(await callStatus(server.url, assistant)).toBe(401);
    } finally {
      await off.stop();
    }
  });
});
