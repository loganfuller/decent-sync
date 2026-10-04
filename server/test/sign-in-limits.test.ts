import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, admin } from "./support/admin-api.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// The sign-in limit with two server instances on one database, through the
// REST API. accounts.test.ts covers how a refusal looks. The second instance's
// clock runs an hour ahead, so a window judged by either instance's clock
// would end at once there or outlast its 15 minutes on the first. Windows are
// aged and the table filled through the database directly: waiting 15
// minutes, or signing in for 100,000 emails, each costing a password hash,
// would not fit in a test.

/** The limiter's capacity, in emails with a live window. */
const CAPACITY = 100_000;
const ahead = { clockOffsetMs: 60 * 60_000 };

describe("sign-in limits across server instances", { timeout: 30_000 }, () => {
  let first: TestServer;
  let second: TestServer;
  let database: pg.Client;

  const signIn = (server: TestServer, email: string, password = "guess") =>
    fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  const lockOut = async (server: TestServer, email: string) => {
    for (let i = 0; i < 5; i++) expect((await signIn(server, email)).status).toBe(401);
    expect((await signIn(server, email)).status).toBe(429);
  };
  const expectRetryAfterAbout = (response: Response, seconds: number) => {
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(seconds - 10);
    expect(retryAfter).toBeLessThanOrEqual(seconds);
  };
  /** Moves the email's window back, as if it had started that many minutes ago. */
  const startedAgo = (minutes: number, emailPattern: string) =>
    database.query("UPDATE sign_in_windows SET started_at = now() - make_interval(mins => $1) WHERE email LIKE $2", [
      minutes,
      emailPattern,
    ]);

  beforeAll(async () => {
    first = await startTestServer();
    second = await startTestServer({ sharing: first, ...ahead });
    const api = await AdminApi.setUp(first.url);
    database = await first.connectDatabase();

    // The offset reaches the server's code.
    expect(await api.at(second.url).instanceClockOffsetMs(database)).toBeGreaterThan(ahead.clockOffsetMs - 60_000);
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    await second?.stop();
    await first?.stop();
  });

  it("limits attempts spread across instances as if they reached one", async () => {
    // All at once, so each instance counts while the other is still checking passwords.
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => signIn(i % 2 === 0 ? first : second, "spread@example.com")),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([...Array(5).fill(401), ...Array(7).fill(429)]);
  });

  it("keeps a lockout when an instance restarts", async () => {
    await lockOut(second, "restart@example.com");
    await second.stop();
    second = await startTestServer({ sharing: first, ...ahead });

    expect((await signIn(second, "restart@example.com")).status).toBe(429);
  });

  it("ends a window by the database's clock", async () => {
    await lockOut(first, "late@example.com");

    await startedAgo(10, "late@example.com");
    expectRetryAfterAbout(await signIn(second, "late@example.com"), 300);

    // A new window starts, with its own five attempts.
    await startedAgo(15, "late@example.com");
    await lockOut(second, "late@example.com");
  });

  it("keeps every live window when full, refusing other emails until the oldest ends", async () => {
    await database.query("DELETE FROM sign_in_windows");
    await signIn(first, "tracked@example.com");
    await lockOut(first, "locked@example.com");
    // One slot short of full.
    await database.query(
      `INSERT INTO sign_in_windows (email, attempts, started_at)
       SELECT 'flood' || n || '@example.com', 1, now() - interval '10 minutes' FROM generate_series(1, $1::int) n`,
      [CAPACITY - 3],
    );

    expect((await signIn(second, "last@example.com")).status).toBe(401);
    expectRetryAfterAbout(await signIn(second, "new@example.com"), 300);
    // Emails already tracked carry on as before, and a lockout holds.
    expect((await signIn(second, "tracked@example.com")).status).toBe(401);
    expect((await signIn(second, "locked@example.com")).status).toBe(429);

    // Once the flood's windows end, they are forgotten and new emails are counted again.
    await startedAgo(15, "flood%");
    expect((await signIn(first, "new@example.com")).status).toBe(401);
    const { rows } = await database.query<{ count: string }>("SELECT count(*) FROM sign_in_windows");
    expect(Number(rows[0]!.count)).toBe(4);
  });

  // Last: it locks the Admin's email.
  it("forgets an email's attempts when it signs in on any instance", async () => {
    for (let i = 0; i < 4; i++) expect((await signIn(first, admin.email)).status).toBe(401);
    expect((await signIn(second, admin.email, admin.password)).status).toBe(200);

    await lockOut(first, admin.email);
  });
});
