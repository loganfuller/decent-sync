import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

// An assistant's app for tests at Seam 1 and Seam 2 (#405), apart from its
// MCP client (assistants.ts), so Playwright, which can't load Vitest, can
// use it too: a loopback server holding the app's Client ID Metadata
// Document, which the server fetches only with TEST_LOOPBACK_CLIENT_METADATA
// on, and its redirect, which records what it receives; and authorization
// URLs built by hand, as an app builds them.

/** The setting a test server needs to fetch a test app's Client ID Metadata Document. */
export const ASSISTANT_ENV = { TEST_LOOPBACK_CLIENT_METADATA: "true" };

/** A test app's loopback server: its Client ID Metadata Document and its redirect. */
export interface TestApp {
  /** The document's URL, which is its client id. */
  clientId: string;
  /** The redirect its document lists. */
  redirectUri: string;
  /** The query of each request its redirect received, oldest first. */
  callbacks: URLSearchParams[];
  /** Serves another document from now on, such as one listing other redirects. */
  serve(document: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** The scopes a person allows on the consent page. */
export type Allowed = ["read"] | ["read", "change"];

export async function serveTestApp(name = "Test Assistant"): Promise<TestApp> {
  const callbacks: URLSearchParams[] = [];
  let document: Record<string, unknown> = {};
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/client.json") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(document));
    } else if (url.pathname === "/callback") {
      callbacks.push(url.searchParams);
      response.writeHead(200, { "Content-Type": "text/plain" }).end("You can close this window.");
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clientId = `${origin}/client.json`;
  const redirectUri = `${origin}/callback`;
  document = {
    client_id: clientId,
    client_name: name,
    logo_uri: `${origin}/logo.png`,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  return {
    clientId,
    redirectUri,
    callbacks,
    serve: (next) => (document = next),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** PKCE's verifier and S256 challenge, for authorizing by hand. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** An authorization URL built by hand, as an app sends the browser to it, with any parameter replaced or left out (undefined). */
export function authorizationUrl(serverUrl: string, app: TestApp, challenge: string, changes: Record<string, string | undefined> = {}): string {
  const parameters: Record<string, string | undefined> = {
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${serverUrl}/api/mcp`,
    scope: "read change",
    state: "the app's state",
    ...changes,
  };
  const url = new URL("/api/oauth/authorize", serverUrl);
  for (const [name, value] of Object.entries(parameters)) if (value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

