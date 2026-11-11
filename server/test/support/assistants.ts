import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { expect } from "vitest";
import { rememberSecret } from "./secrets.js";
import type { Allowed, TestApp } from "./test-app.js";

export { ASSISTANT_ENV, type Allowed, type TestApp, authorizationUrl, pkce, serveTestApp } from "./test-app.js";

// An assistant at Seam 1 (#405): a test app built on the MCP SDK's client,
// connecting to a server from startTestServer as Claude does. It serves its
// Client ID Metadata Document from a loopback server (test-app.ts), and
// takes its code at a loopback redirect there. The person signs in and
// approves through the REST API, as the consent page would.

/**
 * The test app's OAuth client, kept in memory as an app keeps it: its
 * client id is its document's URL, given as registered, since the SDK sends
 * a `clientMetadataUrl` only over HTTPS.
 */
class TestAppProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private verifier = "";
  private saved: StoredOAuthTokens | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private client: StoredOAuthClientInformation;

  constructor(private readonly app: TestApp) {
    this.client = { client_id: app.clientId };
  }

  get redirectUrl(): string {
    return this.app.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Test Assistant",
      redirect_uris: [this.app.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): StoredOAuthClientInformation {
    return this.client;
  }

  saveClientInformation(client: StoredOAuthClientInformation): void {
    this.client = client;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.saved;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    rememberSecret(tokens.access_token);
    rememberSecret(tokens.refresh_token);
    this.saved = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }
}

/** The most characters of one compact JSON copy of a tool's response (ADR-0028), as stated there, not read from the server. */
export const RESPONSE_BUDGET = 45_000;

/** A value as the tools give it outside the parts they give whole: each number in it that isn't whole to hundredths, as JSON then sends it, -0 as 0. */
export function asTools<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "number" && !Number.isInteger(field) ? Math.round(field * 100) / 100 || 0 : field)) as T;
}

/** A Shot Summary's group, as the REST API and summarise_shots both give one. */
export interface SummaryGroup {
  by: Record<string, unknown> & { beanBatch?: { roastDate: string | null } | null; barista?: string | null };
  counts: { shots: number; unfinished: number; cleaningAndCalibration: number; awaitingValues: number };
  numbers: Record<string, Record<string, unknown>>;
}

/**
 * What summarise_shots gives for the REST API's summary: its page of groups
 * as a tool's list pages, `total`, `offset` and `more` first, its numbers
 * to hundredths, and a Bean Batch's roast date as its day, as find_shots
 * gives one.
 */
export function toolSummary(rest: { groups: SummaryGroup[]; total: number; offset: number }): { total: number; offset: number; more: boolean; groups: SummaryGroup[] } {
  const groups = asTools(rest.groups).map(({ by, ...group }) => ({
    by: by.beanBatch ? { ...by, beanBatch: { ...by.beanBatch, roastDate: by.beanBatch.roastDate && by.beanBatch.roastDate.slice(0, 10) } } : by,
    ...group,
  }));
  return { total: rest.total, offset: rest.offset, more: rest.offset + groups.length < rest.total, groups };
}

/** Which protocol revisions the app's client speaks: the 2025 ones (`initialize`), or 2026-07-28. */
export type Era = "legacy" | "modern";

/** A test app connected to a server's MCP endpoint as a Connected App. */
export class Assistant {
  private constructor(
    private readonly provider: TestAppProvider,
    readonly client: Client,
    private readonly serverUrl: string,
    private readonly era: Era,
  ) {}

  /**
   * Connects as Claude does: the endpoint refuses it, it discovers the
   * authorization server, and sends the person's browser to authorize; the
   * person, signed in with `cookie`, approves `allowed` through the REST API
   * as the consent page would; the browser goes to the app's redirect; the
   * app exchanges the code there, and connects with its token.
   */
  static async connect(serverUrl: string, app: TestApp, cookie: string, { allowed = ["read", "change"], era = "legacy" }: { allowed?: Allowed; era?: Era } = {}): Promise<Assistant> {
    const provider = new TestAppProvider(app);
    const first = new Client({ name: "Test Assistant", version: "1.0.0" }, clientOptions(era));
    await expect(first.connect(new StreamableHTTPClientTransport(endpointOf(serverUrl), { authProvider: provider }))).rejects.toBeInstanceOf(UnauthorizedError);
    const callback = await approveInBrowser(serverUrl, app, provider.authorizationUrl!, cookie, allowed);
    const transport = new StreamableHTTPClientTransport(endpointOf(serverUrl), { authProvider: provider });
    await transport.finishAuth(callback);
    const client = new Client({ name: "Test Assistant", version: "1.0.0" }, clientOptions(era));
    await client.connect(transport);
    return new Assistant(provider, client, serverUrl, era);
  }

  /** The tokens it holds. */
  get tokens(): StoredOAuthTokens {
    return this.provider.tokens()!;
  }

  /** The same Connected App's client, connecting to another server instance with its tokens, as after a load balancer moves it. */
  async at(serverUrl: string): Promise<Assistant> {
    const client = new Client({ name: "Test Assistant", version: "1.0.0" }, clientOptions(this.era));
    await client.connect(new StreamableHTTPClientTransport(endpointOf(serverUrl), { authProvider: this.provider }));
    return new Assistant(this.provider, client, serverUrl, this.era);
  }

  /** The structured result of a tool, which must succeed. */
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result.structuredContent as T;
  }

  /**
   * A tool's result as a client receives it, which must succeed and keep
   * within the response budget (ADR-0028): its JSON text block, the one
   * compact copy the budget counts, at most RESPONSE_BUDGET characters, and
   * its structured content, the same JSON.
   */
  async callWithinBudget<T>(name: string, args: Record<string, unknown> = {}): Promise<{ result: T; text: string }> {
    const result = await this.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content).slice(0, 2_000)).toBeFalsy();
    const blocks = result.content as { type: string; text: string }[];
    expect(blocks.map((block) => block.type)).toEqual(["text"]);
    const text = blocks[0]!.text;
    expect(text.length, `${name}'s response`).toBeLessThanOrEqual(RESPONSE_BUDGET);
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    return { result: result.structuredContent as T, text };
  }

  close(): Promise<void> {
    return this.client.close();
  }

  /** The MCP endpoint, called with this access token or another, as raw JSON-RPC over the 2025 revisions. */
  static rawCall(serverUrl: string, accessToken: string | undefined, method = "tools/list", params: Record<string, unknown> = {}): Promise<Response> {
    return fetch(endpointOf(serverUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
        ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }
}

function clientOptions(era: Era) {
  return era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {};
}

function endpointOf(serverUrl: string): URL {
  return new URL("/api/mcp", serverUrl);
}

/**
 * The person's browser: opens the authorization URL, which sends it to the
 * consent page, where the person approves through the REST API, and follows
 * the redirect to the app, returning what the app's redirect received.
 */
async function approveInBrowser(serverUrl: string, app: TestApp, authorizationUrl: URL, cookie: string, allowed: Allowed): Promise<URLSearchParams> {
  const requestId = await openAuthorization(authorizationUrl);
  const read = await fetch(`${serverUrl}/api/oauth/requests/${requestId}`, { headers: { Cookie: cookie } });
  expect(read.status, await read.clone().text()).toBe(200);
  const redirect = await answer(serverUrl, requestId, cookie, "approve", { scopes: allowed });
  const received = app.callbacks.length;
  expect((await fetch(redirect)).status).toBe(200);
  expect(app.callbacks).toHaveLength(received + 1);
  return app.callbacks.at(-1)!;
}

/** Opens an authorization URL as a browser does, and returns the id of the request the consent page shows. */
export async function openAuthorization(authorizationUrl: URL | string): Promise<string> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  expect(response.status, await response.clone().text()).toBe(302);
  const location = response.headers.get("location")!;
  expect(location).toMatch(/^\/connect\/[0-9a-f-]{36}$/);
  return location.split("/").at(-1)!;
}

/** Approves or denies a request to connect as the consent page does, and returns where the browser goes next. */
export async function answer(serverUrl: string, requestId: string, cookie: string, choice: "approve" | "deny", body: unknown = {}): Promise<string> {
  const response = await fetch(`${serverUrl}/api/oauth/requests/${requestId}/${choice}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { redirect: string }).redirect;
}

/** Posts a form to the token endpoint, as an app does, and returns its status and JSON. */
export async function tokenRequest(serverUrl: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${serverUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body = (await response.json()) as Record<string, unknown>;
  rememberSecret(body.access_token);
  rememberSecret(body.refresh_token);
  return { status: response.status, body };
}
