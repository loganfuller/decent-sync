import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestServer, startTestServer } from "./support/test-server.js";

// First-run setup, sign-in, sessions and their protections, through the REST
// API of a real server on a fresh database. The tests in each block share one
// server and run in order.

const firstAdmin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };

describe("accounts and sessions", () => {
  let server: TestServer;
  // Whoever wins concurrent setup below; their email may differ.
  const admin = { ...firstAdmin };
  const call = (method: string, path: string, init: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${server.url}/api${path}`, {
      method,
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    server = await startTestServer();
  }, 60_000);
  afterAll(() => server?.stop());

  it("requires first-run setup on a server with no accounts", async () => {
    expect(await (await call("GET", "/setup")).json()).toEqual({ required: true, passwordMinLength: 12 });
  });

  it("refuses protected endpoints without a session", async () => {
    expect((await call("GET", "/session")).status).toBe(401);
    expect((await call("DELETE", "/session")).status).toBe(401);
    expect((await call("GET", "/session", { cookie: "decent_sync_session=made-up" })).status).toBe(401);
  });

  it("refuses an incomplete first Admin, naming each problem", async () => {
    const response = await call("POST", "/setup", { body: { email: "not-an-email", password: "short" } });

    expect(response.status).toBe(400);
    const { message } = (await response.json()) as { message: string[] };
    expect(message).toEqual([
      "Enter a name",
      "Enter a valid email address",
      "Use a password of at least 12 characters",
    ]);
    expect(await (await call("GET", "/setup")).json()).toMatchObject({ required: true });
  });

  let adminCookie: string;

  it("creates exactly one first Admin from concurrent setup requests, and signs them in", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call("POST", "/setup", { body: { ...admin, email: i === 0 ? admin.email : `rival${i}@example.com` } }),
      ),
    );

    const created = attempts.filter((response) => response.status === 201);
    expect(created).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 409)).toHaveLength(attempts.length - 1);

    const winner = (await created[0]!.json()) as { account: { email: string; role: string } };
    expect(winner.account.role).toBe("admin");
    adminCookie = sessionCookie(created[0]!);
    const current = await call("GET", "/session", { cookie: adminCookie });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(winner);

    admin.email = winner.account.email;
  });

  it("sets a persistent session cookie that scripts cannot read and other sites do not send", async () => {
    const response = await call("POST", "/session", { body: admin });

    expect(response.status).toBe(200);
    const attributes = setCookie(response).split(";").map((part) => part.trim().toLowerCase());
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("samesite=lax");
    expect(attributes).toContain("path=/");
    // Over http the cookie must not be Secure, or the browser would drop it.
    expect(attributes).not.toContain("secure");
    // A Max-Age keeps the cookie across a browser restart.
    const maxAge = Number(attributes.find((part) => part.startsWith("max-age="))?.slice("max-age=".length));
    expect(maxAge).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
  });

  it("refuses setup once an account exists, signed in or not", async () => {
    expect(await (await call("GET", "/setup")).json()).toMatchObject({ required: false });

    const anonymous = await call("POST", "/setup", { body: { ...admin, email: "late@example.com" } });
    expect(anonymous.status).toBe(409);
    const signedIn = await call("POST", "/setup", { body: { ...admin, email: "late@example.com" }, cookie: adminCookie });
    expect(signedIn.status).toBe(409);

    const late = await call("POST", "/session", { body: { ...admin, email: "late@example.com" } });
    expect(late.status).toBe(401);
  });

  it("refuses wrong credentials without revealing which part was wrong", async () => {
    const wrongPassword = await call("POST", "/session", { body: { ...admin, password: "not the password" } });
    const unknownEmail = await call("POST", "/session", { body: { ...admin, email: "nobody@example.com" } });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    expect(wrongPassword.headers.getSetCookie()).toEqual([]);
  });

  it("signs in regardless of the email's case and surrounding spaces", async () => {
    const response = await call("POST", "/session", { body: { ...admin, email: `  ${admin.email.toUpperCase()} ` } });
    expect(response.status).toBe(200);
  });

  it("refuses cross-site state-changing requests", async () => {
    const forged = { Origin: "https://attacker.example" };

    expect((await call("POST", "/session", { body: admin, headers: forged })).status).toBe(403);
    expect((await call("POST", "/setup", { body: admin, headers: forged })).status).toBe(403);
    expect((await call("DELETE", "/session", { cookie: adminCookie, headers: forged })).status).toBe(403);
    expect((await call("DELETE", "/session", { cookie: adminCookie, headers: { Origin: "null" } })).status).toBe(403);
    expect(
      (await call("DELETE", "/session", { cookie: adminCookie, headers: { "Sec-Fetch-Site": "cross-site" } })).status,
    ).toBe(403);

    // None of them ended the session.
    expect((await call("GET", "/session", { cookie: adminCookie })).status).toBe(200);
  });

  it("accepts state-changing requests from the server's own origin", async () => {
    const sameOrigin = await call("POST", "/session", { body: admin, headers: { Origin: server.url } });
    expect(sameOrigin.status).toBe(200);
    const viaHost = await call("POST", "/session", {
      body: admin,
      headers: { Origin: `http://${new URL(server.url).host}`, "Sec-Fetch-Site": "same-origin" },
    });
    expect(viaHost.status).toBe(200);
  });

  it("ends the session on the server when signing out", async () => {
    const signIn = await call("POST", "/session", { body: admin });
    const cookie = sessionCookie(signIn);

    const signOut = await call("DELETE", "/session", { cookie });
    expect(signOut.status).toBe(204);
    expect(setCookie(signOut)).toMatch(/max-age=0/i);

    // Replaying the old cookie, as a browser that ignored the sign-out would.
    expect((await call("GET", "/session", { cookie })).status).toBe(401);
    // Other sessions of the same account are unaffected.
    expect((await call("GET", "/session", { cookie: adminCookie })).status).toBe(200);
  });

  // Last: it locks the Admin's email for the rest of this server's life.
  it("refuses sign-in after repeated failures, even with the right password", async () => {
    const failures = await Promise.all(
      Array.from({ length: 5 }, () => call("POST", "/session", { body: { ...admin, password: "guess" } })),
    );
    expect(failures.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);

    const refused = await call("POST", "/session", { body: admin });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(refused.headers.getSetCookie()).toEqual([]);

    // Unknown emails are limited alike, so the limit reveals no accounts.
    for (let i = 0; i < 5; i++) await call("POST", "/session", { body: { email: "ghost@example.com", password: "guess" } });
    expect((await call("POST", "/session", { body: { email: "ghost@example.com", password: "guess" } })).status).toBe(429);
  });
});

describe("accounts behind https", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ publicUrl: "https://sync.example.com" });
  }, 60_000);
  afterAll(() => server?.stop());

  it("refuses setup from a page that reached the server under another domain name (DNS rebinding)", async () => {
    // fetch cannot set Host, so send the request the rebound browser would.
    const { port } = new URL(server.url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(`${server.url}/api/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: `rebound.example:${port}`,
          Origin: `http://rebound.example:${port}`,
        },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end(JSON.stringify(firstAdmin));
    });

    expect(status).toBe(403);
    expect(await (await fetch(`${server.url}/api/setup`)).json()).toMatchObject({ required: true });
  });

  it("marks the session cookie Secure when the public URL is https", async () => {
    const response = await fetch(`${server.url}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(firstAdmin),
    });

    expect(response.status).toBe(201);
    expect(setCookie(response).split(";").map((part) => part.trim().toLowerCase())).toContain("secure");
  });

  it("accepts state-changing requests from the public URL", async () => {
    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://sync.example.com" },
      body: JSON.stringify(firstAdmin),
    });
    expect(response.status).toBe(200);
  });

  it("accepts state-changing requests from a page reached by the server's IP address", async () => {
    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify(firstAdmin),
    });
    expect(response.status).toBe(200);
  });
});

function setCookie(response: Response): string {
  const [cookie] = response.headers.getSetCookie();
  if (!cookie) throw new Error("The response set no cookie");
  return cookie;
}

/** The Cookie header a browser would send back. */
function sessionCookie(response: Response): string {
  return setCookie(response).split(";")[0]!;
}
