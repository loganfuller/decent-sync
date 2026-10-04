import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, admin } from "./support/admin-api.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Session expiry with several server instances on one database, through the
// REST API. accounts.test.ts covers the session cookie itself. One instance's
// clock runs two days ahead and another's two days behind, more than the day
// after which a used session is renewed, so expiry set or judged by an
// instance's clock would differ from the database's in every test below.
// Sessions are aged through the database directly: waiting days would not fit
// in a test.

const DAY_MS = 24 * 60 * 60_000;
const LIFETIME_SECONDS = 30 * 24 * 60 * 60;

describe("session expiry across server instances", { timeout: 30_000 }, () => {
  let first: TestServer;
  let ahead: TestServer;
  let behind: TestServer;
  let database: pg.Client;

  /** Signs in on the server and returns the Cookie header a browser would send back. */
  const signIn = async (server: TestServer) => {
    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    });
    expect(response.status).toBe(200);
    return response.headers.getSetCookie()[0]!.split(";")[0]!;
  };
  const current = (server: TestServer, cookie: string) => fetch(`${server.url}/api/session`, { headers: { Cookie: cookie } });
  /** The stored hash of the cookie's token, which identifies its session. */
  const hashOf = (cookie: string) => createHash("sha256").update(cookie.split("=")[1]!).digest();
  /** Sets the session to expire after the interval by the database's clock (before now if negative). */
  const expiresIn = (cookie: string, interval: string) =>
    database.query("UPDATE sessions SET expires_at = now() + $2::interval WHERE token_hash = $1", [hashOf(cookie), interval]);
  /** Seconds from the database's now until the session expires, or undefined once it is deleted. */
  const secondsLeft = async (cookie: string) => {
    const { rows } = await database.query<{ seconds: string }>(
      "SELECT extract(epoch FROM expires_at - now()) AS seconds FROM sessions WHERE token_hash = $1",
      [hashOf(cookie)],
    );
    return rows[0] && Number(rows[0].seconds);
  };
  const expectFullLifetime = async (cookie: string) => {
    const seconds = await secondsLeft(cookie);
    expect(seconds).toBeGreaterThan(LIFETIME_SECONDS - 60);
    expect(seconds).toBeLessThanOrEqual(LIFETIME_SECONDS);
  };
  const expectRenewed = (response: Response) => {
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()[0]).toContain(`Max-Age=${LIFETIME_SECONDS}`);
  };
  const expectNotRenewed = (response: Response) => {
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
  };

  beforeAll(async () => {
    first = await startTestServer();
    [ahead, behind] = await Promise.all([
      startTestServer({ sharing: first, clockOffsetMs: 2 * DAY_MS }),
      startTestServer({ sharing: first, clockOffsetMs: -2 * DAY_MS }),
    ]);
    const api = await AdminApi.setUp(first.url);
    database = await first.connectDatabase();

    // The offsets reach the servers' code.
    expect(await api.at(ahead.url).instanceClockOffsetMs(database)).toBeGreaterThan(2 * DAY_MS - 60_000);
    expect(await api.at(behind.url).instanceClockOffsetMs(database)).toBeLessThan(-2 * DAY_MS + 60_000);
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    await Promise.all([ahead?.stop(), behind?.stop()]);
    await first?.stop();
  });

  it("starts sessions that last 30 days by the database's clock on every instance", async () => {
    for (const server of [ahead, behind]) await expectFullLifetime(await signIn(server));
  });

  it("renews a session used on another instance at most once a day, as one instance would", async () => {
    const cookie = await signIn(first);
    expectNotRenewed(await current(ahead, cookie));

    // Last renewed just under a day ago.
    await expiresIn(cookie, "29 days 1 hour");
    expectNotRenewed(await current(ahead, cookie));

    // Last renewed just over a day ago.
    await expiresIn(cookie, "29 days -1 hour");
    expectRenewed(await current(behind, cookie));
    await expectFullLifetime(cookie);
    expectNotRenewed(await current(ahead, cookie));
  });

  it("keeps a session that has not expired by the database's clock, and renews it", async () => {
    const cookie = await signIn(first);
    await expiresIn(cookie, "1 day");

    expectRenewed(await current(ahead, cookie));
    await expectFullLifetime(cookie);
  });

  it("refuses a session that has expired by the database's clock", async () => {
    const cookie = await signIn(first);
    await expiresIn(cookie, "-1 minute");

    for (const server of [behind, first]) {
      const response = await current(server, cookie);
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
    }
  });

  it("deletes only the sessions that have expired by the database's clock when one starts", async () => {
    for (const server of [ahead, behind]) {
      const expired = await signIn(first);
      const live = await signIn(first);
      await expiresIn(expired, "-1 minute");
      await expiresIn(live, "1 day");

      await signIn(server);
      expect(await secondsLeft(expired)).toBeUndefined();
      expect((await current(first, live)).status).toBe(200);
    }
  });
});
