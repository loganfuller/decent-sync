import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, acceptInvite, admin, secretOf } from "./support/admin-api.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Invites through the REST API of real servers: an Admin creates a one-time
// link and sends it themselves, and whoever opens it, with no session,
// chooses a name and password and gets the account the Admin chose.

const DAY_MS = 24 * 60 * 60_000;
const LIFETIME_MS = 7 * DAY_MS;

const open = (server: TestServer, link: string) => fetch(`${server.url}/api/invite-links/${secretOf(link)}`);
const accept = (server: TestServer, link: string, person: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.url}/api/invite-links/${secretOf(link)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(person),
  });
const signIn = (server: TestServer, credentials: { email: string; password: string }) =>
  fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
/** The refusal's message, after checking its status. */
const refusal = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  return ((await response.json()) as { message: unknown }).message;
};

describe("invites", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let uptown: LocationView;
  let belmont: LocationView;

  beforeAll(async () => {
    server = await startTestServer();
    other = await startTestServer({ sharing: server });
    api = await AdminApi.setUp(server.url);
    uptown = await api.createLocation("Uptown", "America/Chicago");
    belmont = await api.createLocation("Belmont", "America/Chicago");
  }, 60_000);
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  it("creates an invite for an email, as Staff at chosen Locations, with a link at the public URL", async () => {
    const { invite, link } = await api.invite("  Sam@Example.com ", "staff", [uptown.id, belmont.id, uptown.id]);

    expect(invite).toMatchObject({ email: "sam@example.com", role: "staff", locations: [belmont, uptown] });
    expect(new Date(invite.expiresAt).getTime() - new Date(invite.createdAt).getTime()).toBeCloseTo(LIFETIME_MS, -4);
    expect(link).toMatch(new RegExp(`^${server.url}/invite/[A-Za-z0-9_-]{43}$`));
    // The link's secret is never written to the log.
    expect(server.output()).not.toContain(secretOf(link));
  });

  it("refuses an incomplete invite, naming each problem", async () => {
    expect(await refusal(await api.call("POST", "/invites", {}), 400)).toEqual(["Enter a valid email address", "Choose Admin or Staff"]);
    expect(await refusal(await api.call("POST", "/invites", { email: "a@example.com", role: "owner" }), 400)).toEqual([
      "Choose Admin or Staff",
    ]);
    for (const locationIds of [undefined, []]) {
      expect(await refusal(await api.call("POST", "/invites", { email: "a@example.com", role: "staff", locationIds }), 400)).toEqual([
        "Choose the Locations a Staff member works at",
      ]);
    }
    for (const locationIds of [["Uptown"], [uptown.id, "0190b7a4-0000-7000-8000-000000000000"]]) {
      expect(await refusal(await api.call("POST", "/invites", { email: "a@example.com", role: "staff", locationIds }), 400)).toEqual([
        "Choose Locations from the list",
      ]);
    }
  });

  it("refuses an invite for an email that already has an account", async () => {
    const message = await refusal(await api.call("POST", "/invites", { email: admin.email.toUpperCase(), role: "admin" }), 409);
    expect(message).toBe(`${admin.email} already has an account`);
  });

  it("refuses creating invites without a session", async () => {
    const response = await fetch(`${server.url}/api/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", role: "admin" }),
    });
    expect(response.status).toBe(401);
  });

  it("shows whoever opens the link, with no session, what the invite offers", async () => {
    const { invite, link } = await api.invite("robin@example.com", "staff", [uptown.id]);

    const response = await open(other, link);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invite, passwordMinLength: 12 });
  });

  it("refuses a link that names no invite", async () => {
    const { link } = await api.invite("typo@example.com", "admin");
    const mangled = link.slice(0, -1) + (link.endsWith("A") ? "B" : "A");

    expect(await refusal(await open(server, mangled), 404)).toMatch(/^This invite link is not valid/);
    expect(await refusal(await accept(server, mangled, { name: "Typo", password: "correct horse battery" }), 404)).toMatch(
      /^This invite link is not valid/,
    );
  });

  it("refuses an incomplete acceptance, naming each problem, and keeps the invite usable", async () => {
    const { link } = await api.invite("kit@example.com", "staff", [uptown.id]);

    expect(await refusal(await accept(server, link, { name: " ", password: "short" }), 400)).toEqual([
      "Enter a name",
      "Use a password of at least 12 characters",
    ]);
    expect((await open(server, link)).status).toBe(200);
  });

  it("creates the account the Admin chose when the invite is accepted, and signs it in", async () => {
    const { link } = await api.invite("sam.staff@example.com", "staff", [uptown.id, belmont.id]);
    const sam = { name: "Sam Staff", password: "staff password 1" };

    const response = await accept(other, link, sam);
    expect(response.status).toBe(201);
    const { account } = (await response.json()) as { account: { id: string } };
    expect(account).toEqual({ id: expect.any(String), email: "sam.staff@example.com", name: "Sam Staff", role: "staff" });

    // The cookie it set signs them in, on any instance.
    const cookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
    const current = await fetch(`${server.url}/api/session`, { headers: { Cookie: cookie } });
    expect(await current.json()).toEqual({ account });
    // They work at the Locations the invite named.
    const locations = await AdminApi.signedInAs(server.url, cookie).call("GET", "/locations");
    expect(await locations.json()).toEqual({ locations: [belmont, uptown] });
    // And sign in again later with the email the invite named and the password they chose.
    expect((await signIn(server, { email: "sam.staff@example.com", password: sam.password })).status).toBe(200);
  });

  it("can be used once: a used link says so", async () => {
    const { link } = await api.invite("once@example.com", "staff", [uptown.id]);
    await acceptInvite(server.url, link, { name: "Once", password: "the first password" });

    const used = /^This invite has already been used/;
    expect(await refusal(await open(server, link), 410)).toMatch(used);
    expect(await refusal(await accept(other, link, { name: "Twice", password: "the second password" }), 410)).toMatch(used);
    expect((await signIn(server, { email: "once@example.com", password: "the second password" })).status).toBe(401);
  });

  it("accepts an invite once from concurrent requests on two instances", async () => {
    const { link } = await api.invite("race@example.com", "staff", [belmont.id]);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => accept(i % 2 === 0 ? server : other, link, { name: `Racer ${i}`, password: `racing password ${i}` })),
    );

    expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 410)).toHaveLength(attempts.length - 1);
    // Only the winner's password signs in.
    const winner = attempts.findIndex((response) => response.status === 201);
    const passwords = await Promise.all(
      attempts.map((_, i) => signIn(server, { email: "race@example.com", password: `racing password ${i}` })),
    );
    expect(passwords.map((response) => response.status)).toEqual(attempts.map((_, i) => (i === winner ? 200 : 401)));
  });

  it("makes an Admin of an Admin invite's account", async () => {
    const { invite, link } = await api.invite("alex@example.com", "admin", [uptown.id]);
    // An Admin sees every Location, so none are named.
    expect(invite.locations).toEqual([]);

    const cookie = await acceptInvite(server.url, link, { name: "Alex Admin", password: "admin password 1" });
    const alex = AdminApi.signedInAs(server.url, cookie);
    expect((await alex.call("POST", "/locations", { name: "Lab", timeZone: "America/Denver" })).status).toBe(201);
    expect(((await (await alex.call("GET", "/locations")).json()) as { locations: unknown[] }).locations).toHaveLength(3);
  });

  it("refuses a second invite for an email once the first has made its account", async () => {
    const first = await api.invite("twin@example.com", "staff", [uptown.id]);
    const second = await api.invite("twin@example.com", "admin");
    await acceptInvite(server.url, first.link, { name: "Twin", password: "the twin password" });

    const exists = "twin@example.com already has an account, so this invite can no longer be used. Sign in instead";
    expect(await refusal(await open(server, second.link), 410)).toBe(exists);
    expect(await refusal(await accept(server, second.link, { name: "Twin", password: "another password" }), 410)).toBe(exists);
  });

  it("refuses Staff creating invites", async () => {
    const { link } = await api.invite("nosy@example.com", "staff", [uptown.id]);
    const nosy = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Nosy", password: "nosy password 1" }));

    const response = await nosy.call("POST", "/invites", { email: "friend@example.com", role: "admin" });
    expect(await refusal(response, 403)).toBe("Only an Admin can do this");
  });

  it("refuses accepting an invite from another site", async () => {
    const { link } = await api.invite("forged@example.com", "admin");
    const forged = await accept(server, link, { name: "Forged", password: "forged password" }, { Origin: "https://attacker.example" });

    expect(forged.status).toBe(403);
    expect((await open(server, link)).status).toBe(200);
  });
});

// Invite expiry with several server instances on one database, as
// session-expiry.test.ts runs sessions: one instance's clock runs 30 days
// ahead and another's 30 days behind, more than an invite's lifetime, so
// expiry set or judged by an instance's clock would differ from the
// database's in every test below. Invites are aged through the database
// directly: waiting days would not fit in a test.
describe("invite expiry across server instances", { timeout: 30_000 }, () => {
  let first: TestServer;
  let ahead: TestServer;
  let behind: TestServer;
  let database: pg.Client;
  let api: AdminApi;

  /** Sets the invite to expire after the interval by the database's clock (before now if negative). */
  const expiresIn = (link: string, interval: string) =>
    database.query("UPDATE invites SET expires_at = now() + $2::interval WHERE secret_hash = $1", [
      createHash("sha256").update(secretOf(link)).digest(),
      interval,
    ]);

  beforeAll(async () => {
    first = await startTestServer();
    [ahead, behind] = await Promise.all([
      startTestServer({ sharing: first, clockOffsetMs: 30 * DAY_MS }),
      startTestServer({ sharing: first, clockOffsetMs: -30 * DAY_MS }),
    ]);
    api = await AdminApi.setUp(first.url);
    database = await first.connectDatabase();

    // The offsets reach the servers' code.
    expect(await api.at(ahead.url).instanceClockOffsetMs(database)).toBeGreaterThan(30 * DAY_MS - 60_000);
    expect(await api.at(behind.url).instanceClockOffsetMs(database)).toBeLessThan(-30 * DAY_MS + 60_000);
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    await Promise.all([ahead?.stop(), behind?.stop()]);
    await first?.stop();
  });

  it("sets an invite to expire 7 days from now by the database's clock on every instance", async () => {
    for (const [index, server] of [ahead, behind].entries()) {
      const { invite } = await api.at(server.url).invite(`expiry${index}@example.com`, "admin");
      const { rows } = await database.query<{ ms: string }>("SELECT extract(epoch FROM $1::timestamptz - now()) * 1000 AS ms", [
        invite.expiresAt,
      ]);
      expect(Number(rows[0]!.ms)).toBeGreaterThan(LIFETIME_MS - 60_000);
      expect(Number(rows[0]!.ms)).toBeLessThanOrEqual(LIFETIME_MS);
    }
  });

  it("accepts an invite that has not expired by the database's clock, on an instance whose clock says it has", async () => {
    const { link } = await api.invite("early@example.com", "admin");
    await expiresIn(link, "1 day");

    expect((await open(ahead, link)).status).toBe(200);
    expect((await accept(ahead, link, { name: "Early", password: "early password 1" })).status).toBe(201);
  });

  it("refuses an invite that has expired by the database's clock, on an instance whose clock says it has not", async () => {
    const { link } = await api.invite("late@example.com", "admin");
    await expiresIn(link, "-1 minute");

    const expired = "This invite has expired. Ask an Admin for a new one";
    expect(await refusal(await open(behind, link), 410)).toBe(expired);
    expect(await refusal(await accept(behind, link, { name: "Late", password: "late password 1" }), 410)).toBe(expired);
    expect((await signIn(first, { email: "late@example.com", password: "late password 1" })).status).toBe(401);
  });
});
