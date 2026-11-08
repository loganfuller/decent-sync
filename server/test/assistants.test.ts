import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, type MachineView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import {
  ASSISTANT_ENV,
  Assistant,
  type TestApp,
  answer,
  authorizationUrl,
  openAuthorization,
  pkce,
  serveTestApp,
  tokenRequest,
} from "./support/assistants.js";
import { rememberSecret } from "./support/secrets.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Connecting an assistant (#406; #405, ADR-0026, ADR-0027) at Seam 1: a test
// app on the MCP SDK's client authorizes with PKCE, the person signs in and
// approves through the REST API as the consent page would, and the app
// exchanges and refreshes tokens, then lists and calls tools, against
// instances of the built server on one database, one with MCP_ENABLED off.

interface ListedLocation {
  id: string;
  name: string;
  timeZone: string;
  machines: { id: string; name: string }[];
}

/** The Locations, with the Machines at each, as the REST API lists them to the account. */
async function restLocations(api: AdminApi): Promise<ListedLocation[]> {
  const { locations } = await api.get<{ locations: LocationView[] }>("/locations");
  const { machines } = await api.get<{ machines: MachineView[] }>("/machines");
  return locations.map((location) => ({
    ...location,
    machines: machines.filter((machine) => machine.location?.id === location.id).map(({ id, name }) => ({ id, name })),
  }));
}

describe("connecting an assistant", () => {
  let server: TestServer;
  let api: AdminApi;
  let adminCookie: string;
  let app: TestApp;
  let uptown: LocationView;
  let lab: LocationView;

  beforeAll(async () => {
    server = await startTestServer({ env: ASSISTANT_ENV });
    api = await AdminApi.setUp(server.url);
    adminCookie = await signIn(server.url, admin);
    app = await serveTestApp();
    uptown = await api.createLocation("Uptown", "America/Chicago");
    lab = await api.createLocation("Lab", "Europe/London");
    await api.createMachine("Uptown Left", uptown.id);
    await api.createMachine("Uptown Right", uptown.id);
    await api.createMachine("Lab", lab.id);
    await api.createMachine("In the van");
  });
  afterAll(async () => {
    await app?.close();
    await server?.stop();
  });

  /** A Staff member or Viewer, signed in, with a cookie to approve apps with. */
  async function person(email: string, role: "staff" | "viewer", locations: LocationView[] = []): Promise<{ id: string; cookie: string; api: AdminApi }> {
    const { link } = await api.invite(email, role, locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for apps" });
    const id = (await api.accounts()).find((account) => account.email === email)!.id;
    return { id, cookie, api: AdminApi.signedInAs(server.url, cookie) };
  }

  /** Authorizes by hand and approves as the person, returning the code the app's redirect would receive, with its verifier. */
  async function approvedCode(cookie: string, allowed: string[] = ["read", "change"]): Promise<{ code: string; verifier: string; callback: URLSearchParams }> {
    const { verifier, challenge } = pkce();
    const requestId = await openAuthorization(authorizationUrl(server.url, app, challenge));
    const callback = new URL(await answer(server.url, requestId, cookie, "approve", { scopes: allowed })).searchParams;
    const code = callback.get("code")!;
    rememberSecret(code);
    return { code, verifier, callback };
  }

  const exchange = (url: string, code: string, verifier: string, changes: Record<string, string> = {}) =>
    tokenRequest(url, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: app.redirectUri,
      client_id: app.clientId,
      resource: `${server.url}/api/mcp`,
      ...changes,
    });

  const refresh = (url: string, refreshToken: string) =>
    tokenRequest(url, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: app.clientId });

  it("serves the authorization server's metadata, and the endpoint's protected resource metadata, which a refused call names", async () => {
    const metadata = await fetch(`${server.url}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      issuer: server.url,
      authorization_endpoint: `${server.url}/api/oauth/authorize`,
      token_endpoint: `${server.url}/api/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "change", "offline_access"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });

    const resource = await fetch(`${server.url}/.well-known/oauth-protected-resource/api/mcp`);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: `${server.url}/api/mcp`,
      authorization_servers: [server.url],
      scopes_supported: ["read", "change"],
    });

    const refused = await Assistant.rawCall(server.url, undefined);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain(`resource_metadata="${server.url}/.well-known/oauth-protected-resource/api/mcp"`);
    // A session is no access token.
    const withSession = await fetch(`${server.url}/api/mcp`, { method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: "{}" });
    expect(withSession.status).toBe(401);
  });

  it.each(["legacy", "modern"] as const)("connects over the %s revisions, and lists and calls list_locations, which answers as the REST API", async (era) => {
    const assistant = await Assistant.connect(server.url, app, adminCookie, { era });
    try {
      expect(assistant.tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read change" });
      expect(assistant.client.getInstructions()).toContain("A day, such as \"yesterday\", is each Location's own day in its time zone.");
      const { tools } = await assistant.client.listTools();
      const reading = [
        "find_library_items",
        "find_shots",
        "find_steam_records",
        "get_library_item",
        "get_machine",
        "get_machine_activity",
        "get_shot",
        "get_steam_record",
        "list_conflicts",
        "list_locations",
        "list_machines",
        "list_settings_edits",
      ];
      const changing = ["create_bean", "create_bean_batch", "edit_bean", "edit_bean_batch", "set_archived", "set_location_offering"];
      expect(tools.map((tool) => tool.name).sort()).toEqual([...reading, ...changing].sort());
      // Archiving retires an item everywhere, which an app may ask about more carefully; nothing else changing is destructive.
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toMatchObject(changing.includes(tool.name) ? { readOnlyHint: false, destructiveHint: tool.name === "set_archived" } : { readOnlyHint: true });
      }
      const { locations } = await assistant.call<{ locations: ListedLocation[] }>("list_locations");
      expect(locations).toEqual(await restLocations(api));
      expect(locations.find((location) => location.name === "Uptown")!.machines.map((machine) => machine.name)).toEqual(["Uptown Left", "Uptown Right"]);
    } finally {
      await assistant.close();
    }
  });

  it("returns the code with the app's state and the issuer, and refuses a code used twice or late, a wrong verifier, redirect or resource", async () => {
    const { code, verifier, callback } = await approvedCode(adminCookie);
    expect(callback.get("state")).toBe("the app's state");
    expect(callback.get("iss")).toBe(server.url);

    // A wrong verifier spends the code, as any attempt does.
    expect(await exchange(server.url, code, pkce().verifier)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect(await exchange(server.url, code, verifier)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const twice = await approvedCode(adminCookie);
    expect(await exchange(server.url, twice.code, twice.verifier)).toMatchObject({ status: 200 });
    expect(await exchange(server.url, twice.code, twice.verifier)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const late = await approvedCode(adminCookie);
    const database = await server.connectDatabase();
    try {
      // A minute later, by PostgreSQL's clock.
      await database.query("UPDATE authorization_codes SET expires_at = now() - interval '1 second'");
    } finally {
      await database.end();
    }
    expect(await exchange(server.url, late.code, late.verifier)).toMatchObject({ status: 400, body: { error: "invalid_grant", error_description: "The code has expired; connect again" } });

    const otherClient = await approvedCode(adminCookie);
    expect(await exchange(server.url, otherClient.code, otherClient.verifier, { client_id: "https://elsewhere.example/client.json" })).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
    const redirected = await approvedCode(adminCookie);
    expect(await exchange(server.url, redirected.code, redirected.verifier, { redirect_uri: `${app.redirectUri}?other` })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const elsewhere = await approvedCode(adminCookie);
    expect(await exchange(server.url, elsewhere.code, elsewhere.verifier, { resource: `${server.url}/api/other` })).toMatchObject({ status: 400, body: { error: "invalid_target" } });

    const json = await fetch(`${server.url}/api/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token" }) });
    expect(json.status).toBe(400);
    expect(await json.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses at the authorization endpoint a wrong resource and a missing PKCE challenge, back at the app, and an unlisted redirect or a document naming another client there", async () => {
    const { challenge } = pkce();
    const wrongResource = await fetch(authorizationUrl(server.url, app, challenge, { resource: "https://elsewhere.example/api/mcp" }), { redirect: "manual" });
    expect(wrongResource.status).toBe(302);
    const toApp = new URL(wrongResource.headers.get("location")!);
    expect(`${toApp.origin}${toApp.pathname}`).toBe(app.redirectUri);
    expect(Object.fromEntries(toApp.searchParams)).toMatchObject({ error: "invalid_target", state: "the app's state", iss: server.url });

    const noChallenge = await fetch(authorizationUrl(server.url, app, challenge, { code_challenge: undefined }), { redirect: "manual" });
    expect(new URL(noChallenge.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const plain = await fetch(authorizationUrl(server.url, app, challenge, { code_challenge_method: "plain" }), { redirect: "manual" });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    // Never sent to a redirect the app's document doesn't list.
    const unlisted = await fetch(authorizationUrl(server.url, app, challenge, { redirect_uri: "http://127.0.0.1:9/elsewhere" }), { redirect: "manual" });
    expect(unlisted.status).toBe(400);
    expect(((await unlisted.json()) as { message: string }).message).toBe("The app's redirect_uri is not one its Client ID Metadata Document lists");
    // A loopback redirect it lists may use any port.
    const port = new URL(app.redirectUri).port === "9" ? "10" : "9";
    const otherPort = new URL(app.redirectUri);
    otherPort.port = port;
    expect((await fetch(authorizationUrl(server.url, app, challenge, { redirect_uri: otherPort.href }), { redirect: "manual" })).headers.get("location")).toMatch(/^\/connect\//);

    const impostor = await serveTestApp("Claude");
    try {
      impostor.serve({ client_id: app.clientId, client_name: "Claude", redirect_uris: [impostor.redirectUri] });
      const named = await fetch(authorizationUrl(server.url, impostor, challenge), { redirect: "manual" });
      expect(named.status).toBe(400);
      expect(((await named.json()) as { message: string }).message).toBe("The app's Client ID Metadata Document names another client_id than its URL");

      // A redirect the consent page would send the browser to with location.assign, where it could run script, is
      // refused even when the document lists it, so no request reaches Allow or Deny.
      const hostile = ["javascript:globalThis.ran=true;//", "data:text/html,<script>parent.ran=true</script>", "http://sync.example/callback", `${impostor.redirectUri}#fragment`];
      impostor.serve({ client_id: impostor.clientId, client_name: "Claude", redirect_uris: hostile });
      for (const redirectUri of hostile) {
        const refused = await fetch(authorizationUrl(server.url, impostor, challenge, { redirect_uri: redirectUri }), { redirect: "manual" });
        expect({ redirectUri, status: refused.status, message: ((await refused.json()) as { message: string }).message }).toEqual({
          redirectUri,
          status: 400,
          message: "The app's redirect_uri must be an https:// URL, or an http:// one on this computer, with no fragment",
        });
      }
    } finally {
      await impostor.close();
    }
  });

  it("shows the request to the signed-in person, and denying it sends the app access_denied, once", async () => {
    const { challenge } = pkce();
    const requestId = await openAuthorization(authorizationUrl(server.url, app, challenge));
    const unsigned = await fetch(`${server.url}/api/oauth/requests/${requestId}`);
    expect(unsigned.status).toBe(401);
    expect(await api.get(`/oauth/requests/${requestId}`)).toEqual({
      request: { client: { id: app.clientId, host: new URL(app.clientId).host, name: "Test Assistant", logoUri: `${new URL(app.clientId).origin}/logo.png` }, scopes: ["read", "change"] },
    });
    const denied = new URL(await answer(server.url, requestId, adminCookie, "deny"));
    expect(Object.fromEntries(denied.searchParams)).toMatchObject({ error: "access_denied", state: "the app's state", iss: server.url });
    expect((await api.call("GET", `/oauth/requests/${requestId}`)).status).toBe(404);
    expect((await api.call("POST", `/oauth/requests/${requestId}/approve`, { scopes: ["read"] })).status).toBe(404);

    // An app asking only to read is offered nothing more.
    const readOnly = await openAuthorization(authorizationUrl(server.url, app, challenge, { scope: "read offline_access" }));
    expect(await api.get(`/oauth/requests/${readOnly}`)).toMatchObject({ request: { scopes: ["read"] } });
    expect((await api.call("POST", `/oauth/requests/${readOnly}/approve`, { scopes: ["read", "change"] })).status).toBe(400);
  });

  it("offers a Viewer only read, and gives their Connected App only read", async () => {
    const viewer = await person("vi@example.com", "viewer");
    const { challenge, verifier } = pkce();
    const requestId = await openAuthorization(authorizationUrl(server.url, app, challenge));
    expect(await viewer.api.get(`/oauth/requests/${requestId}`)).toMatchObject({ request: { scopes: ["read"] } });
    const refused = await viewer.api.call("POST", `/oauth/requests/${requestId}/approve`, { scopes: ["read", "change"] });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toBe("A Viewer can allow an app only to read");
    const code = new URL(await answer(server.url, requestId, viewer.cookie, "approve", { scopes: ["read"] })).searchParams.get("code")!;
    rememberSecret(code);
    const tokens = await exchange(server.url, code, verifier);
    expect(tokens).toMatchObject({ status: 200, body: { scope: "read" } });
    expect((await Assistant.rawCall(server.url, tokens.body.access_token as string)).status).toBe(200);
  });

  it("refreshes through the SDK once its access token expires, replacing the refresh token, which is then refused", async () => {
    const assistant = await Assistant.connect(server.url, app, adminCookie);
    try {
      const first = assistant.tokens;
      const database = await server.connectDatabase();
      try {
        // An hour later, by PostgreSQL's clock.
        await database.query("UPDATE access_tokens SET expires_at = now() - interval '1 second'");
      } finally {
        await database.end();
      }
      expect((await Assistant.rawCall(server.url, first.access_token)).status).toBe(401);
      // Refused, the SDK refreshes and calls again.
      await assistant.call("list_locations");
      expect(assistant.tokens.access_token).not.toBe(first.access_token);
      expect(assistant.tokens.refresh_token).not.toBe(first.refresh_token);
      expect(await refresh(server.url, first.refresh_token!)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      const again = await refresh(server.url, assistant.tokens.refresh_token!);
      expect(again).toMatchObject({ status: 200, body: { token_type: "Bearer", expires_in: 3600, scope: "read change" } });
      // Refreshed by another app's client id, it is refused, and kept.
      const otherApp = await tokenRequest(server.url, { grant_type: "refresh_token", refresh_token: again.body.refresh_token as string, client_id: "https://elsewhere.example/client.json" });
      expect(otherApp).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
      expect(await refresh(server.url, again.body.refresh_token as string)).toMatchObject({ status: 200 });
    } finally {
      await assistant.close();
    }
  });

  it("refuses a lapsed Connected App, and a deactivated account's", async () => {
    const lapsing = await person("la@example.com", "staff", [uptown]);
    const lapsed = await Assistant.connect(server.url, app, lapsing.cookie);
    const deactivating = await person("de@example.com", "staff", [uptown]);
    const deactivated = await Assistant.connect(server.url, app, deactivating.cookie);
    try {
      const database = await server.connectDatabase();
      try {
        // 30 days without use, by PostgreSQL's clock.
        await database.query("UPDATE connected_apps SET last_used_at = now() - interval '30 days 1 second' WHERE account_id = $1", [lapsing.id]);
      } finally {
        await database.end();
      }
      expect((await Assistant.rawCall(server.url, lapsed.tokens.access_token)).status).toBe(401);
      expect(await refresh(server.url, lapsed.tokens.refresh_token!)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

      expect((await Assistant.rawCall(server.url, deactivated.tokens.access_token)).status).toBe(200);
      await api.send("POST", `/accounts/${deactivating.id}/deactivate`);
      expect((await Assistant.rawCall(server.url, deactivated.tokens.access_token)).status).toBe(401);
      expect(await refresh(server.url, deactivated.tokens.refresh_token!)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    } finally {
      await lapsed.client.close();
      await deactivated.client.close();
    }
  });

  it("applies a change of the account's role or Locations at its Connected App's next call", async () => {
    const staff = await person("ro@example.com", "staff", [uptown]);
    const assistant = await Assistant.connect(server.url, app, staff.cookie);
    try {
      expect(assistant.tokens.scope).toBe("read change");
      expect(await assistant.call("list_locations")).toEqual({ locations: await restLocations(staff.api) });

      // A Viewer reads as before, and their Connected App changes nothing from its next call: its tokens carry only read.
      await api.send("PUT", `/accounts/${staff.id}/access`, { role: "viewer" });
      expect(await assistant.call("list_locations")).toEqual({ locations: await restLocations(staff.api) });
      const asViewer = await refresh(server.url, assistant.tokens.refresh_token!);
      expect(asViewer).toMatchObject({ status: 200, body: { scope: "read" } });

      // Staff again, at other Locations: change is back, as granted.
      await api.send("PUT", `/accounts/${staff.id}/access`, { role: "staff", locationIds: [lab.id] });
      expect((await Assistant.rawCall(server.url, asViewer.body.access_token as string)).status).toBe(200);
      expect(await refresh(server.url, asViewer.body.refresh_token as string)).toMatchObject({ status: 200, body: { scope: "read change" } });
    } finally {
      await assistant.close();
    }
  });

  it("logs a tool call's unexpected failure, as a route's, telling the app only that it failed", async () => {
    const assistant = await Assistant.connect(server.url, app, adminCookie);
    const database = await server.connectDatabase();
    try {
      // The table gone for a moment, as an unexpected failure of the server's own.
      await database.query("ALTER TABLE locations RENAME TO locations_away");
      const logged = server.output().length;
      const result = await assistant.client.callTool({ name: "list_locations", arguments: {} });
      expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Internal server error" }] });
      await expect.poll(() => stripVTControlCharacters(server.output().slice(logged))).toMatch(/ERROR \[ExceptionsHandler\] PrismaClientKnownRequestError/);
    } finally {
      await database.query("ALTER TABLE IF EXISTS locations_away RENAME TO locations");
      await database.end();
      await assistant.close();
    }
  });

  // Every instance of a deployment has the same public URL, which names the issuer and the endpoint its tokens are for.
  describe("on several instances", () => {
    let other: TestServer;

    beforeAll(async () => {
      other = await startTestServer({ env: ASSISTANT_ENV, sharing: server, publicUrl: server.url });
    });

    it("authorizes on one instance, takes the token from the other, and calls either", async () => {
      const { code, verifier } = await approvedCode(adminCookie);
      const tokens = await exchange(other.url, code, verifier);
      expect(tokens).toMatchObject({ status: 200 });
      for (const url of [server.url, other.url]) expect((await Assistant.rawCall(url, tokens.body.access_token as string)).status).toBe(200);

      // Replaced on one, refused on the other.
      const refreshed = await refresh(server.url, tokens.body.refresh_token as string);
      expect(refreshed).toMatchObject({ status: 200 });
      expect(await refresh(other.url, tokens.body.refresh_token as string)).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

      // The SDK's client, moved to the other instance.
      const assistant = await Assistant.connect(server.url, app, adminCookie);
      const moved = await assistant.at(other.url);
      try {
        expect(await moved.call("list_locations")).toEqual({ locations: await restLocations(api) });
      } finally {
        await moved.close();
        await assistant.close();
      }
    });

    it("answers a request to connect, a code and a refresh token once, used on both instances at once", async () => {
      const { challenge, verifier } = pkce();
      const requestId = await openAuthorization(authorizationUrl(server.url, app, challenge));
      const answer = (url: string) =>
        fetch(`${url}/api/oauth/requests/${requestId}/approve`, {
          method: "POST",
          headers: { Cookie: adminCookie, "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: ["read"] }),
        });
      const approvals = await Promise.all([answer(server.url), answer(other.url)]);
      expect(approvals.map((response) => response.status).sort()).toEqual([200, 404]);
      const code = new URL(((await approvals.find((response) => response.status === 200)!.json()) as { redirect: string }).redirect).searchParams.get("code")!;
      rememberSecret(code);

      const exchanges = await Promise.all([exchange(server.url, code, verifier), exchange(other.url, code, verifier)]);
      expect(exchanges.map(({ status }) => status).sort()).toEqual([200, 400]);
      const tokens = exchanges.find(({ status }) => status === 200)!.body;

      const refreshes = await Promise.all([refresh(server.url, tokens.refresh_token as string), refresh(other.url, tokens.refresh_token as string)]);
      expect(refreshes.map(({ status }) => status).sort()).toEqual([200, 400]);
      const replaced = refreshes.find(({ status }) => status === 200)!.body;
      expect((await Assistant.rawCall(other.url, replaced.access_token as string)).status).toBe(200);
      expect(await refresh(server.url, replaced.refresh_token as string)).toMatchObject({ status: 200 });
    });

    it("ends a subscriptions/listen stream at once as its instance stops, while it still answers", async () => {
      const stopping = await startTestServer({ env: { ...ASSISTANT_ENV, DRAIN_GRACE_SECONDS: "3" }, sharing: server, publicUrl: server.url });
      const assistant = await Assistant.connect(server.url, app, adminCookie, { era: "modern" });
      const listening = await assistant.at(stopping.url);
      try {
        const subscription = await listening.client.listen({ toolsListChanged: true });
        expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });
        const stopped = stopping.stop();
        expect(await subscription.closed).toBe("remote");
        // Ended during its grace, rather than as it exits: an open stream would hold up its finish.
        expect((await fetch(`${stopping.url}/api/health`)).status).toBe(503);
        await stopped;
      } finally {
        await listening.close();
        await assistant.close();
        await stopping.stop();
      }
    });

    it("deletes expired requests, codes and access tokens, and lapsed Connected Apps but those the Library's history names, as an instance starts, keeping the rest", async () => {
      const hash = (secret: string) => createHash("sha256").update(secret).digest();
      const kept = await approvedCode(adminCookie);
      const keptTokens = await exchange(server.url, kept.code, kept.verifier);
      const unanswered = await openAuthorization(authorizationUrl(server.url, app, pkce().challenge));
      const unexchanged = await approvedCode(adminCookie);
      const expiring = await approvedCode(adminCookie);
      const expiringTokens = await exchange(server.url, expiring.code, expiring.verifier);
      const lapsing = await person("cl@example.com", "staff", [uptown]);
      const lapsed = await approvedCode(lapsing.cookie);
      const lapsedTokens = await exchange(server.url, lapsed.code, lapsed.verifier);
      // A lapsed Connected App that changed the Library is kept, so its history still names it, but refused.
      const changing = await person("ch@example.com", "staff", [uptown]);
      const changer = await Assistant.connect(server.url, app, changing.cookie);
      const { bean } = await changer.call<{ bean: { id: string } }>("create_bean", { roaster: "Roux", name: "Kept through a lapsed app" });
      await changer.close();
      const database = await server.connectDatabase();
      try {
        // Aged by PostgreSQL's clock, as waiting would not fit in a test.
        await database.query("UPDATE authorization_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [unanswered]);
        await database.query("UPDATE authorization_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [hash(unexchanged.code)]);
        await database.query("UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hash(expiringTokens.body.access_token as string)]);
        await database.query("UPDATE connected_apps SET last_used_at = now() - interval '30 days 1 second' WHERE account_id = ANY($1)", [[lapsing.id, changing.id]]);

        const starting = await startTestServer({ env: ASSISTANT_ENV, sharing: server, publicUrl: server.url });
        try {
          // The last of its deletions as it starts.
          await expect.poll(() => starting.output()).toMatch(/Deleted \d+ lapsed Connected Apps/);
          const { rows } = await database.query<{ requests: number; codes: number; tokens: number; apps: number }>(
            `SELECT (SELECT count(*)::int FROM authorization_requests WHERE id = $1) AS requests,
               (SELECT count(*)::int FROM authorization_codes WHERE code_hash = $2) AS codes,
               (SELECT count(*)::int FROM access_tokens WHERE token_hash = ANY($3)) AS tokens,
               (SELECT count(*)::int FROM connected_apps WHERE account_id = $4) AS apps`,
            [unanswered, hash(unexchanged.code), [hash(expiringTokens.body.access_token as string), hash(lapsedTokens.body.access_token as string)], lapsing.id],
          );
          expect(rows[0]).toEqual({ requests: 0, codes: 0, tokens: 0, apps: 0 });
          const kept = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM connected_apps WHERE account_id = $1", [changing.id]);
          expect(kept.rows[0]!.count).toBe(1);
        } finally {
          await starting.stop();
        }
      } finally {
        await database.end();
      }
      expect((await Assistant.rawCall(server.url, keptTokens.body.access_token as string)).status).toBe(200);
      expect((await Assistant.rawCall(server.url, changer.tokens.access_token)).status).toBe(401);
      const [created] = (await api.get<{ versions: { source: { connectedApp: { name: string } | null } }[] }>(`/beans/${bean.id}/history`)).versions;
      expect(created!.source.connectedApp).toMatchObject({ name: "Test Assistant" });
      // An expired access token's Connected App stays, and refreshes.
      expect(await refresh(server.url, expiringTokens.body.refresh_token as string)).toMatchObject({ status: 200 });
    });

    it("with MCP_ENABLED off, answers 404 at the endpoint, the authorization server and both metadata documents, refusing every token", async () => {
      const off = await startTestServer({ env: { MCP_ENABLED: "false" }, sharing: server, publicUrl: server.url });
      try {
        const { code, verifier } = await approvedCode(adminCookie);
        const tokens = await exchange(server.url, code, verifier);
        expect((await Assistant.rawCall(server.url, tokens.body.access_token as string)).status).toBe(200);
        expect((await Assistant.rawCall(off.url, tokens.body.access_token as string)).status).toBe(404);
        for (const path of [
          "/.well-known/oauth-authorization-server",
          "/.well-known/oauth-protected-resource/api/mcp",
          "/.well-known/oauth-protected-resource",
          "/api/mcp",
          `/api/oauth/authorize?client_id=${encodeURIComponent(app.clientId)}`,
        ]) {
          expect({ path, status: (await fetch(`${off.url}${path}`)).status }).toEqual({ path, status: 404 });
        }
        expect(await refresh(off.url, tokens.body.refresh_token as string)).toMatchObject({ status: 404 });
        // The management interface still answers.
        expect((await AdminApi.signedInAs(off.url, adminCookie).call("GET", "/locations")).status).toBe(200);
      } finally {
        await off.stop();
      }
    });
  });
});
