import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, type ManagedAccountView, acceptInvite, admin, secretOf, signIn } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Account management through the REST API of two server instances on one
// database: an Admin lists accounts and unused invites, changes an account's
// role and Locations, deactivates and reactivates it, revokes invites, and
// issues one-time password reset links that whoever holds them redeems with
// no session. Changes reach existing sessions on their next request to
// either instance, and the last active Admin stays an active Admin.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** The accounts lock in server/src/accounts/accounts.service.ts, held here to make requests wait for each other. */
const ACCOUNTS_LOCK = 4_000_004;

interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
  /** The session the invite's acceptance started. */
  cookie: string;
}

const session = (server: TestServer, cookie: string) => fetch(`${server.url}/api/session`, { headers: { Cookie: cookie } });
const signingIn = (server: TestServer, credentials: { email: string; password: string }) =>
  fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
const openReset = (server: TestServer, link: string) => fetch(`${server.url}/api/password-reset-links/${secretOf(link)}`);
const redeem = (server: TestServer, link: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.url}/api/password-reset-links/${secretOf(link)}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const openInvite = (server: TestServer, link: string) => fetch(`${server.url}/api/invite-links/${secretOf(link)}`);
const acceptingInvite = (server: TestServer, link: string, person: { name: string; password: string }) =>
  fetch(`${server.url}/api/invite-links/${secretOf(link)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(person),
  });
/** The refusal's message, after checking its status. */
const refusal = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  return ((await response.json()) as { message: unknown }).message;
};
const accountOf = async (response: Response) => ((await response.json()) as { account: ManagedAccountView }).account;
const cookieOf = (response: Response) => response.headers.getSetCookie()[0]!.split(";")[0]!;

/** Invites someone and accepts it as them, so they have an account and a session. */
async function invitePerson(api: AdminApi, name: string, role: "admin" | "staff", locationIds: string[] = []): Promise<Person> {
  const email = `${name.split(" ")[0]!.toLowerCase()}@example.com`;
  const password = `${name} password`;
  const { link } = await api.invite(email, role, locationIds);
  const cookie = await acceptInvite(api.serverUrl, link, { name, password });
  const { account } = (await (await fetch(`${api.serverUrl}/api/session`, { headers: { Cookie: cookie } })).json()) as {
    account: { id: string };
  };
  return { id: account.id, name, email, password, cookie };
}

/** Waits until the row's `expires_at` has passed by the database's clock. */
async function waitUntilExpired(database: pg.Client, table: "invites" | "password_resets", where: string, id: string) {
  await expect
    .poll(
      async () =>
        (await database.query<{ expired: boolean }>(`SELECT expires_at <= clock_timestamp() AS expired FROM ${table} WHERE ${where} = $1`, [id]))
          .rows[0]!.expired,
      { timeout: 10_000 },
    )
    .toBe(true);
}

describe("account management", () => {
  let server: TestServer;
  let other: TestServer;
  let database: pg.Client;
  let api: AdminApi;
  let lab: LocationView;
  let uptown: LocationView;
  let belmont: LocationView;
  /** Staff at Uptown and Belmont. */
  let sam: Person;

  beforeAll(async () => {
    server = await startTestServer();
    other = await startTestServer({ sharing: server });
    database = await server.connectDatabase();
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    uptown = await api.createLocation("Uptown", "America/Chicago");
    belmont = await api.createLocation("Belmont", "America/Chicago");
    sam = await invitePerson(api, "Sam Staff", "staff", [uptown.id, belmont.id]);
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    await other?.stop();
    await server?.stop();
  });

  it("lists every account with its role, Locations and whether it is active, and the invites that can still be used", async () => {
    const waiting = await api.invite("pat@example.com", "staff", [lab.id]);
    const revoked = await api.invite("rey@example.com", "admin");
    expect((await api.call("POST", `/invites/${revoked.invite.id}/revoke`)).status).toBe(204);
    const expired = await api.invite("old@example.com", "admin");
    await database.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.invite.id]);
    // Of two invites for one email, the second can no longer be used once the first has made its account.
    const twins = [await api.invite("wes@example.com", "staff", [lab.id]), await api.invite("wes@example.com", "admin")];
    const wes = await acceptInvite(server.url, twins[0]!.link, { name: "Wes Staff", password: "wes password 1" });
    const wesId = ((await (await session(server, wes)).json()) as { account: { id: string } }).account.id;

    const accounts = await api.at(other.url).accounts();
    expect(accounts).toEqual([
      { id: expect.any(String), email: admin.email, name: admin.name, role: "admin", locations: [], deactivatedAt: null },
      { id: sam.id, email: sam.email, name: sam.name, role: "staff", locations: [belmont, uptown], deactivatedAt: null },
      { id: wesId, email: "wes@example.com", name: "Wes Staff", role: "staff", locations: [lab], deactivatedAt: null },
    ]);
    expect(await api.at(other.url).invites()).toEqual([waiting.invite]);
  });

  it("changes a Staff member's Locations, which limits their next move on any instance", async () => {
    const kim = await invitePerson(api, "Kim Staff", "staff", [uptown.id]);
    const kimElsewhere = AdminApi.signedInAs(other.url, kim.cookie);
    const { machine } = await api.createMachine("Uptown 1", uptown.id);
    const move = (to: LocationView) => kimElsewhere.call("POST", `/machines/${machine.id}/location-history`, { locationId: to.id });

    expect(await refusal(await move(belmont), 403)).toBe("You can move a Machine only to a Location you work at");

    const changed = await api.call("PUT", `/accounts/${kim.id}/access`, { role: "staff", locationIds: [belmont.id, uptown.id] });
    expect(changed.status).toBe(200);
    expect(await accountOf(changed)).toMatchObject({ id: kim.id, role: "staff", locations: [belmont, uptown], deactivatedAt: null });
    expect((await move(belmont)).status).toBe(201);

    // Uptown and Belmont are taken away: Kim can move it neither back nor on.
    await api.call("PUT", `/accounts/${kim.id}/access`, { role: "staff", locationIds: [lab.id] });
    expect(await refusal(await move(uptown), 403)).toBe("You can move a Machine only from a Location you work at");
    const { account } = (await (await session(other, kim.cookie)).json()) as { account: { locations: LocationView[] } };
    expect(account.locations).toEqual([lab]);
  });

  it("makes Staff an Admin, and an Admin Staff, from their next request on any instance", async () => {
    const lou = await invitePerson(api, "Lou Staff", "staff", [uptown.id]);
    const louElsewhere = AdminApi.signedInAs(other.url, lou.cookie);
    expect((await louElsewhere.call("GET", "/accounts")).status).toBe(403);

    // An Admin works at no particular Location: those sent are not kept.
    const promoted = await api.call("PUT", `/accounts/${lou.id}/access`, { role: "admin", locationIds: [uptown.id] });
    expect(await accountOf(promoted)).toMatchObject({ role: "admin", locations: [] });
    expect((await louElsewhere.call("GET", "/accounts")).status).toBe(200);
    expect((await louElsewhere.call("POST", "/locations", { name: "Annex", timeZone: "America/Chicago" })).status).toBe(201);

    const demoted = await api.at(other.url).call("PUT", `/accounts/${lou.id}/access`, { role: "staff", locationIds: [belmont.id] });
    expect(await accountOf(demoted)).toMatchObject({ role: "staff", locations: [belmont] });
    expect((await AdminApi.signedInAs(server.url, lou.cookie).call("GET", "/accounts")).status).toBe(403);
    expect((await louElsewhere.call("POST", "/locations", { name: "Annex 2", timeZone: "America/Chicago" })).status).toBe(403);
  });

  it("refuses an incomplete change, or one to an account that does not exist, naming each problem", async () => {
    const path = `/accounts/${sam.id}/access`;
    expect(await refusal(await api.call("PUT", path, {}), 400)).toEqual(["Choose Admin or Staff"]);
    expect(await refusal(await api.call("PUT", path, { role: "staff", locationIds: [] }), 400)).toEqual([
      "Choose the Locations a Staff member works at",
    ]);
    expect(await refusal(await api.call("PUT", path, { role: "staff", locationIds: [uptown.id, randomUUID()] }), 400)).toEqual([
      "Choose Locations from the list",
    ]);
    for (const id of [randomUUID(), "sam"]) {
      expect(await refusal(await api.call("PUT", `/accounts/${id}/access`, { role: "admin" }), 404)).toBe("No such account");
      expect(await refusal(await api.call("POST", `/accounts/${id}/deactivate`), 404)).toBe("No such account");
      expect(await refusal(await api.call("POST", `/accounts/${id}/password-reset`), 404)).toBe("No such account");
    }
    expect((await api.accounts()).find((account) => account.id === sam.id)).toMatchObject({ role: "staff", locations: [belmont, uptown] });
  });

  it("deactivates an account: its sessions end on every instance and it can no longer sign in", async () => {
    const lee = await invitePerson(api, "Lee Staff", "staff", [lab.id]);
    const elsewhere = await signIn(other.url, lee);

    const response = await api.at(other.url).call("POST", `/accounts/${lee.id}/deactivate`);
    expect(response.status).toBe(200);
    const deactivated = await accountOf(response);
    expect(deactivated).toMatchObject({ id: lee.id, deactivatedAt: expect.any(String) });
    const { rows } = await database.query<{ ms: string }>("SELECT extract(epoch FROM now() - $1::timestamptz) * 1000 AS ms", [
      deactivated.deactivatedAt,
    ]);
    expect(Math.abs(Number(rows[0]!.ms))).toBeLessThan(60_000);

    for (const instance of [server, other]) {
      for (const cookie of [lee.cookie, elsewhere]) expect((await session(instance, cookie)).status).toBe(401);
    }
    const { rows: sessions } = await database.query("SELECT 1 FROM sessions WHERE account_id = $1", [lee.id]);
    expect(sessions).toEqual([]);
    // Refused with the right password, saying why; with a wrong one, as anyone is.
    expect(await refusal(await signingIn(server, lee), 403)).toBe("This account has been deactivated. Ask an Admin to reactivate it");
    expect(await refusal(await signingIn(other, { ...lee, password: "not the password" }), 401)).toBe("The email or password is incorrect");
    // Its email still has an account, so it cannot be invited again.
    expect((await api.call("POST", "/invites", { email: lee.email, role: "staff", locationIds: [lab.id] })).status).toBe(409);

    // Deactivating it again changes nothing.
    expect(await accountOf(await api.call("POST", `/accounts/${lee.id}/deactivate`))).toEqual(deactivated);
    expect((await api.accounts()).find((account) => account.id === lee.id)).toEqual(deactivated);

    // Reactivated, it signs in with the password it had.
    const reactivated = await api.call("POST", `/accounts/${lee.id}/reactivate`);
    expect(await accountOf(reactivated)).toMatchObject({ id: lee.id, deactivatedAt: null });
    expect((await session(server, await signIn(other.url, lee))).status).toBe(200);
  });

  it("refuses a deactivated account's session even if its deactivation missed it", async () => {
    const ray = await invitePerson(api, "Ray Staff", "staff", [lab.id]);
    // As if Ray signed in while being deactivated: the account is, the session survives.
    await database.query("UPDATE accounts SET deactivated_at = now() WHERE id = $1", [ray.id]);

    const response = await session(other, ray.cookie);
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()[0]).toContain("Max-Age=0");
  });

  it("revokes an unused invite, whose link then says it was revoked", async () => {
    const { invite, link } = await api.invite("tess@example.com", "staff", [lab.id]);

    expect((await api.at(other.url).call("POST", `/invites/${invite.id}/revoke`)).status).toBe(204);
    const revoked = "This invite was revoked. Ask an Admin for a new one";
    expect(await refusal(await openInvite(server, link), 410)).toBe(revoked);
    expect(await refusal(await acceptingInvite(other, link, { name: "Tess", password: "tess password 1" }), 410)).toBe(revoked);
    expect((await api.invites()).map((listed) => listed.id)).not.toContain(invite.id);
    // Revoking it again changes nothing.
    expect((await api.call("POST", `/invites/${invite.id}/revoke`)).status).toBe(204);

    // An invite already used has made its account, which is deactivated instead.
    const used = await api.invite("uma@example.com", "staff", [lab.id]);
    await acceptInvite(server.url, used.link, { name: "Uma", password: "uma password 1" });
    expect(await refusal(await api.call("POST", `/invites/${used.invite.id}/revoke`), 409)).toBe(
      "This invite has already been used, so uma@example.com has an account. Deactivate it instead",
    );
    for (const id of [randomUUID(), "tess"]) {
      expect(await refusal(await api.call("POST", `/invites/${id}/revoke`), 404)).toBe("No such invite");
    }
  });

  it("refuses an invite that expires while its acceptance waits for a revocation that then rolls back", async () => {
    const { invite, link } = await api.invite("gus@example.com", "staff", [lab.id]);
    await database.query("UPDATE invites SET expires_at = clock_timestamp() + interval '2 seconds' WHERE id = $1", [invite.id]);

    // A revocation, as on another instance, holds the invite's row and has not committed.
    const revoking = await server.connectDatabase();
    try {
      await revoking.query("BEGIN");
      await revoking.query("UPDATE invites SET revoked_at = now() WHERE id = $1", [invite.id]);
      const acceptance = acceptingInvite(other, link, { name: "Gus", password: "gus password 1" });
      // It found the invite usable and waits for it.
      await waitForLockWaits(server);
      await waitUntilExpired(database, "invites", "id", invite.id);
      await revoking.query("ROLLBACK");

      expect(await refusal(await acceptance, 410)).toBe("This invite has expired. Ask an Admin for a new one");
    } finally {
      await revoking.end();
    }
    expect((await signingIn(server, { email: "gus@example.com", password: "gus password 1" })).status).toBe(401);
  });

  it("revokes or accepts an invite, never both, from concurrent requests on two instances", async () => {
    for (let round = 0; round < 6; round++) {
      const { invite, link } = await api.invite(`race${round}@example.com`, "staff", [lab.id]);
      const [revoked, accepted] = await Promise.all([
        api.at(round % 2 === 0 ? server.url : other.url).call("POST", `/invites/${invite.id}/revoke`),
        acceptingInvite(round % 2 === 0 ? other : server, link, { name: `Racer ${round}`, password: `racing password ${round}` }),
      ]);
      expect([revoked.status, accepted.status]).toSatisfy(
        ([revoke, accept]: number[]) => (revoke === 204 && accept === 410) || (revoke === 409 && accept === 201),
      );
      const { rows } = await database.query<{ accepted: boolean; revoked: boolean }>(
        "SELECT accepted_at IS NOT NULL AS accepted, revoked_at IS NOT NULL AS revoked FROM invites WHERE id = $1",
        [invite.id],
      );
      expect(rows[0]).toEqual({ accepted: accepted.status === 201, revoked: revoked.status === 204 });
    }
  });

  describe("sign-ins racing a password reset or a deactivation", () => {
    /**
     * Signs in with the account's current password while another transaction,
     * as a password reset or deactivation on another instance would, has
     * changed its row and not committed. The sign-in checks the password
     * against what is committed, then waits for the row; `finish` then
     * completes the change before it commits.
     */
    async function signInDuring(person: Person, change: string, finish: (tx: pg.Client) => Promise<void>): Promise<Response> {
      const changing = await server.connectDatabase();
      try {
        await changing.query("BEGIN");
        await changing.query(change, [person.id]);
        const signingInMeanwhile = signingIn(other, person);
        await waitForLockWaits(server);
        await finish(changing);
        await changing.query("COMMIT");
        return await signingInMeanwhile;
      } finally {
        await changing.end();
      }
    }
    const sessionsOf = async (person: Person) =>
      (await database.query("SELECT 1 FROM sessions WHERE account_id = $1", [person.id])).rows;

    it("refuses a sign-in whose password a reset changed while it was checked", async () => {
      const joe = await invitePerson(api, "Joe Staff", "staff", [lab.id]);
      const response = await signInDuring(joe, "UPDATE accounts SET password_hash = 'scrypt$replaced' WHERE id = $1", (tx) =>
        tx.query("DELETE FROM sessions WHERE account_id = $1", [joe.id]).then(() => undefined),
      );

      expect(await refusal(response, 401)).toBe("The email or password is incorrect");
      expect(await sessionsOf(joe)).toEqual([]);
    });

    it("refuses a sign-in to an account deactivated while it was checked, leaving no session to come back", async () => {
      const kai = await invitePerson(api, "Kai Staff", "staff", [lab.id]);
      const response = await signInDuring(kai, "UPDATE accounts SET deactivated_at = now() WHERE id = $1", (tx) =>
        tx.query("DELETE FROM sessions WHERE account_id = $1", [kai.id]).then(() => undefined),
      );

      expect(await refusal(response, 403)).toBe("This account has been deactivated. Ask an Admin to reactivate it");
      expect(await sessionsOf(kai)).toEqual([]);
      expect((await api.call("POST", `/accounts/${kai.id}/reactivate`)).status).toBe(200);
      expect((await session(server, kai.cookie)).status).toBe(401);
    });
  });

  describe("password reset links", () => {
    it("issues a link that works once: it sets the new password, ends the account's other sessions and signs them in", async () => {
      const mo = await invitePerson(api, "Mo Staff", "staff", [uptown.id]);
      const elsewhere = await signIn(other.url, mo);

      const issued = await api.call("POST", `/accounts/${mo.id}/password-reset`);
      expect(issued.status).toBe(201);
      const { account, link, expiresAt } = (await issued.json()) as { account: ManagedAccountView; link: string; expiresAt: string };
      expect(account).toMatchObject({ id: mo.id, email: mo.email });
      expect(link).toMatch(new RegExp(`^${server.url}/reset-password/[A-Za-z0-9_-]{43}$`));
      const { rows } = await database.query<{ ms: string }>("SELECT extract(epoch FROM $1::timestamptz - now()) * 1000 AS ms", [expiresAt]);
      expect(Number(rows[0]!.ms)).toBeGreaterThan(DAY_MS - 60_000);
      expect(Number(rows[0]!.ms)).toBeLessThanOrEqual(DAY_MS);
      // The link's secret is stored only as its hash, and never written to the log.
      const { rows: stored } = await database.query<{ hash: Buffer }>("SELECT secret_hash AS hash FROM password_resets WHERE account_id = $1", [mo.id]);
      expect(stored[0]!.hash.equals(createHash("sha256").update(secretOf(link)).digest())).toBe(true);
      expect(server.output() + other.output()).not.toContain(secretOf(link));

      // Whoever opens it, with no session, sees whose password it sets.
      const opened = await openReset(other, link);
      expect(opened.status).toBe(200);
      expect(await opened.json()).toEqual({ passwordReset: { name: mo.name, email: mo.email, expiresAt }, passwordMinLength: 12 });

      // A password too short is refused, and the link still works.
      expect(await refusal(await redeem(server, link, { password: "short" }), 400)).toEqual(["Use a password of at least 12 characters"]);
      // So is a redemption from another site.
      expect((await redeem(server, link, { password: "forged password 1" }, { Origin: "https://attacker.example" })).status).toBe(403);

      const redeemed = await redeem(other, link, { password: "Mo's new password" });
      expect(redeemed.status).toBe(200);
      expect(await redeemed.json()).toEqual({
        account: { id: mo.id, email: mo.email, name: mo.name, role: "staff", locations: [uptown] },
      });
      // Signed in, on any instance; the account's other sessions ended.
      expect((await session(server, cookieOf(redeemed))).status).toBe(200);
      for (const instance of [server, other]) {
        for (const cookie of [mo.cookie, elsewhere]) expect((await session(instance, cookie)).status).toBe(401);
      }
      expect((await signingIn(server, mo)).status).toBe(401);
      expect((await signingIn(other, { email: mo.email, password: "Mo's new password" })).status).toBe(200);

      const usedAlready = /^This password reset link has already been used/;
      expect(await refusal(await openReset(server, link), 410)).toMatch(usedAlready);
      expect(await refusal(await redeem(server, link, { password: "Mo's third password" }), 410)).toMatch(usedAlready);
    });

    it("replaces the last link when another is issued", async () => {
      const first = (await (await api.call("POST", `/accounts/${sam.id}/password-reset`)).json()) as { link: string };
      const second = (await (await api.at(other.url).call("POST", `/accounts/${sam.id}/password-reset`)).json()) as { link: string };

      expect(await refusal(await openReset(server, first.link), 404)).toMatch(/^This password reset link is not valid/);
      expect(await refusal(await redeem(server, first.link, { password: "Sam's new password" }), 404)).toMatch(/^This password reset link is not valid/);
      expect((await openReset(server, second.link)).status).toBe(200);
    });

    it("withdraws a link when its account is deactivated, and issues none for a deactivated account", async () => {
      const nia = await invitePerson(api, "Nia Staff", "staff", [lab.id]);
      const { link } = (await (await api.call("POST", `/accounts/${nia.id}/password-reset`)).json()) as { link: string };
      expect((await api.call("POST", `/accounts/${nia.id}/deactivate`)).status).toBe(200);

      expect((await openReset(server, link)).status).toBe(404);
      expect((await redeem(other, link, { password: "Nia's new password" })).status).toBe(404);
      expect(await refusal(await api.call("POST", `/accounts/${nia.id}/password-reset`), 409)).toBe(
        "Nia Staff's account is deactivated. Reactivate it first",
      );

      // Reactivating it does not bring the link back.
      expect((await api.call("POST", `/accounts/${nia.id}/reactivate`)).status).toBe(200);
      expect((await redeem(other, link, { password: "Nia's new password" })).status).toBe(404);
      expect((await signingIn(server, nia)).status).toBe(200);
    });

    it("refuses a redemption waiting for the account's deactivation, once that commits", async () => {
      const ola = await invitePerson(api, "Ola Staff", "staff", [lab.id]);
      const { link } = (await (await api.call("POST", `/accounts/${ola.id}/password-reset`)).json()) as { link: string };

      // A deactivation, as on another instance, has locked the account's row but not committed yet.
      const deactivating = await server.connectDatabase();
      try {
        await deactivating.query("BEGIN");
        await deactivating.query("UPDATE accounts SET deactivated_at = now() WHERE id = $1", [ola.id]);
        const redemption = redeem(other, link, { password: "Ola's new password" });
        await waitForLockWaits(server);
        await deactivating.query("DELETE FROM sessions WHERE account_id = $1", [ola.id]);
        await deactivating.query("DELETE FROM password_resets WHERE account_id = $1", [ola.id]);
        await deactivating.query("COMMIT");

        expect(await refusal(await redemption, 410)).toBe(
          "This account has been deactivated, so its password can no longer be reset. Ask an Admin to reactivate it",
        );
      } finally {
        await deactivating.end();
      }
      const { rows } = await database.query("SELECT 1 FROM sessions WHERE account_id = $1", [ola.id]);
      expect(rows).toEqual([]);
      await database.query("UPDATE accounts SET deactivated_at = NULL WHERE id = $1", [ola.id]);
      expect((await signingIn(server, { email: ola.email, password: "Ola's new password" })).status).toBe(401);
    });

    it("refuses a link that expires while its redemption waits for the account", async () => {
      const eli = await invitePerson(api, "Eli Staff", "staff", [lab.id]);
      const { link } = (await (await api.call("POST", `/accounts/${eli.id}/password-reset`)).json()) as { link: string };
      await database.query("UPDATE password_resets SET expires_at = clock_timestamp() + interval '2 seconds' WHERE account_id = $1", [eli.id]);

      // Another transaction holds the account's row, as a deactivation in progress would.
      const holding = await server.connectDatabase();
      try {
        await holding.query("BEGIN");
        await holding.query("SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE", [eli.id]);
        const redemption = redeem(other, link, { password: "Eli's new password" });
        // It found the link usable, and waits for the account.
        await waitForLockWaits(server);
        await waitUntilExpired(database, "password_resets", "account_id", eli.id);
        await holding.query("ROLLBACK");

        expect(await refusal(await redemption, 410)).toBe("This password reset link has expired. Ask an Admin for a new one");
      } finally {
        await holding.end();
      }
      expect((await signingIn(server, { email: eli.email, password: "Eli's new password" })).status).toBe(401);
    });

    it("refuses a link that expires while its redemption waits for an issue that then rolls back", async () => {
      const fay = await invitePerson(api, "Fay Staff", "staff", [lab.id]);
      const { link } = (await (await api.call("POST", `/accounts/${fay.id}/password-reset`)).json()) as { link: string };
      await database.query("UPDATE password_resets SET expires_at = clock_timestamp() + interval '2 seconds' WHERE account_id = $1", [fay.id]);

      // Issuing another link, as on another instance, holds the link's row and has not committed.
      const issuing = await server.connectDatabase();
      try {
        await issuing.query("BEGIN");
        await issuing.query("UPDATE password_resets SET created_at = now() WHERE account_id = $1", [fay.id]);
        const redemption = redeem(other, link, { password: "Fay's new password" });
        // It found the link usable and has the account; it waits for the link.
        await waitForLockWaits(server);
        await waitUntilExpired(database, "password_resets", "account_id", fay.id);
        await issuing.query("ROLLBACK");

        expect(await refusal(await redemption, 410)).toBe("This password reset link has expired. Ask an Admin for a new one");
      } finally {
        await issuing.end();
      }
      expect((await signingIn(server, { email: fay.email, password: "Fay's new password" })).status).toBe(401);
    });

    it("redeems a link, and signs in, without waiting for another account's sessions", async () => {
      const ana = await invitePerson(api, "Ana Staff", "staff", [lab.id]);
      const ben = await invitePerson(api, "Ben Staff", "staff", [lab.id]);
      const { link } = (await (await api.call("POST", `/accounts/${ana.id}/password-reset`)).json()) as { link: string };
      // Ben's session has expired, and another transaction holds it, as resetting Ben's password would while ending it.
      await database.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE account_id = $1", [ben.id]);
      const holding = await server.connectDatabase();
      try {
        await holding.query("BEGIN");
        await holding.query("SELECT 1 FROM sessions WHERE account_id = $1 FOR UPDATE", [ben.id]);

        expect((await redeem(other, link, { password: "Ana's new password" })).status).toBe(200);
        expect((await signingIn(server, { email: ana.email, password: "Ana's new password" })).status).toBe(200);
      } finally {
        await holding.query("ROLLBACK");
        await holding.end();
      }
    });

    it("redeems a link once from concurrent requests on two instances", async () => {
      const vic = await invitePerson(api, "Vic Staff", "staff", [lab.id]);
      const { link } = (await (await api.call("POST", `/accounts/${vic.id}/password-reset`)).json()) as { link: string };

      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) => redeem(i % 2 === 0 ? server : other, link, { password: `racing password ${i}` })),
      );
      expect(attempts.filter((response) => response.status === 200)).toHaveLength(1);
      expect(attempts.filter((response) => response.status === 410)).toHaveLength(attempts.length - 1);
      // The account has the winner's password, not another's.
      const winner = attempts.findIndex((response) => response.status === 200);
      const loser = (winner + 1) % attempts.length;
      expect((await signingIn(server, { email: vic.email, password: `racing password ${winner}` })).status).toBe(200);
      expect((await signingIn(server, { email: vic.email, password: `racing password ${loser}` })).status).toBe(401);
    });
  });
});

// Its rounds each create two Admins, which costs two password hashes.
describe("the last active Admin", { timeout: 30_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let database: pg.Client;
  let ada: AdminApi;
  let adaId: string;
  let lab: LocationView;

  beforeAll(async () => {
    server = await startTestServer();
    other = await startTestServer({ sharing: server });
    database = await server.connectDatabase();
    ada = await AdminApi.setUp(server.url);
    adaId = ((await (await ada.call("GET", "/session")).json()) as { account: { id: string } }).account.id;
    lab = await ada.createLocation("Lab", "America/Denver");
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    await other?.stop();
    await server?.stop();
  });

  const activeAdmins = async () =>
    (await database.query<{ id: string }>("SELECT id FROM accounts WHERE role = 'ADMIN' AND deactivated_at IS NULL")).rows.map(({ id }) => id);

  it("cannot be demoted or deactivated, while a deactivated Admin does not count", async () => {
    const last = `${admin.name} is the last active Admin. Make another account an Admin first`;
    expect(await refusal(await ada.call("PUT", `/accounts/${adaId}/access`, { role: "staff", locationIds: [lab.id] }), 409)).toBe(last);
    expect(await refusal(await ada.call("POST", `/accounts/${adaId}/deactivate`), 409)).toBe(last);

    const bo = await invitePerson(ada, "Bo Admin", "admin");
    expect((await ada.call("POST", `/accounts/${bo.id}/deactivate`)).status).toBe(200);
    expect(await refusal(await ada.call("POST", `/accounts/${adaId}/deactivate`), 409)).toBe(last);
    expect(await activeAdmins()).toEqual([adaId]);

    // With Bo active again, Ada may step down; Ada's next request is Staff's.
    expect((await ada.call("POST", `/accounts/${bo.id}/reactivate`)).status).toBe(200);
    expect((await ada.at(other.url).call("PUT", `/accounts/${adaId}/access`, { role: "staff", locationIds: [lab.id] })).status).toBe(200);
    expect(await refusal(await ada.call("GET", "/accounts"), 403)).toBe("Only an Admin can do this");
    // Deactivating Bo ended Bo's sessions.
    const boApi = AdminApi.signedInAs(other.url, await signIn(server.url, bo));
    expect(await refusal(await boApi.call("POST", `/accounts/${bo.id}/deactivate`), 409)).toBe(
      "Bo Admin is the last active Admin. Make another account an Admin first",
    );
    expect((await boApi.call("PUT", `/accounts/${adaId}/access`, { role: "admin" })).status).toBe(200);
  });

  it("stays when the last two each demote or deactivate the other at once, on two instances", async () => {
    type Change = "demote" | "deactivate";
    const changes: Record<Change, (id: string) => [method: string, path: string, body?: unknown]> = {
      demote: (id) => ["PUT", `/accounts/${id}/access`, { role: "staff", locationIds: [lab.id] }],
      deactivate: (id) => ["POST", `/accounts/${id}/deactivate`],
    };
    const rounds: [Change, Change, "each other" | "the other, then themselves"][] = [
      ["deactivate", "deactivate", "each other"],
      ["demote", "demote", "each other"],
      ["demote", "deactivate", "each other"],
      ["demote", "demote", "the other, then themselves"],
      ["deactivate", "deactivate", "the other, then themselves"],
    ];
    for (const [index, [first, second, whom]] of rounds.entries()) {
      // Ada, made Staff by the round before, invites two Admins as an Admin again.
      await database.query("UPDATE accounts SET role = 'ADMIN' WHERE id = $1", [adaId]);
      const x = await invitePerson(ada, `X${index} Admin`, "admin");
      const y = await invitePerson(ada, `Y${index} Admin`, "admin");
      // X and Y are the only active Admins.
      await database.query("UPDATE accounts SET role = 'STAFF' WHERE role = 'ADMIN' AND id <> ALL($1::uuid[])", [[x.id, y.id]]);

      // X changes Y on one instance while, on the other, Y or X changes X.
      const xApi = AdminApi.signedInAs(server.url, x.cookie);
      const secondApi = AdminApi.signedInAs(other.url, whom === "each other" ? y.cookie : x.cookie);
      // Both wait for the accounts lock, so they are decided one after the other.
      const locker = await server.connectDatabase();
      let results: Response[];
      try {
        await locker.query("SELECT pg_advisory_lock($1::bigint)", [ACCOUNTS_LOCK]);
        const requests = Promise.all([xApi.call(...changes[first](y.id)), secondApi.call(...changes[second](x.id))]);
        await waitForLockWaits(server, { count: 2, advisory: true });
        await locker.query("SELECT pg_advisory_unlock($1::bigint)", [ACCOUNTS_LOCK]);
        results = await requests;
      } finally {
        await locker.end();
      }

      const statuses = results.map((response) => response.status).sort();
      expect(statuses[0], `round ${index}`).toBe(200);
      // Whichever came second found its Admin no longer one (403), or its target the last active Admin (409).
      expect([403, 409], `round ${index}`).toContain(statuses[1]);
      expect(await activeAdmins(), `round ${index}`).toHaveLength(1);
    }
  });
});

describe("password reset link expiry across server instances", { timeout: 30_000 }, () => {
  let first: TestServer;
  let ahead: TestServer;
  let behind: TestServer;
  let database: pg.Client;
  let api: AdminApi;
  let pia: Person;

  /** Sets the link to expire after the interval by the database's clock (before now if negative). */
  const expiresIn = (link: string, interval: string) =>
    database.query("UPDATE password_resets SET expires_at = now() + $2::interval WHERE secret_hash = $1", [
      createHash("sha256").update(secretOf(link)).digest(),
      interval,
    ]);
  const issue = async (at: TestServer) =>
    (await (await api.at(at.url).call("POST", `/accounts/${pia.id}/password-reset`)).json()) as { link: string; expiresAt: string };

  // Each instance's clock is 2 days off the database's, more than a link's lifetime.
  beforeAll(async () => {
    first = await startTestServer();
    [ahead, behind] = await Promise.all([
      startTestServer({ sharing: first, clockOffsetMs: 2 * DAY_MS }),
      startTestServer({ sharing: first, clockOffsetMs: -2 * DAY_MS }),
    ]);
    api = await AdminApi.setUp(first.url);
    database = await first.connectDatabase();
    const lab = await api.createLocation("Lab", "America/Denver");
    pia = await invitePerson(api, "Pia Staff", "staff", [lab.id]);

    // The offsets reach the servers' code.
    expect(await api.at(ahead.url).instanceClockOffsetMs(database)).toBeGreaterThan(2 * DAY_MS - 60_000);
    expect(await api.at(behind.url).instanceClockOffsetMs(database)).toBeLessThan(-2 * DAY_MS + 60_000);
  }, 60_000);
  afterAll(async () => {
    await database?.end();
    await Promise.all([ahead?.stop(), behind?.stop()]);
    await first?.stop();
  });

  it("sets a link to expire a day from now by the database's clock on every instance", async () => {
    for (const server of [ahead, behind]) {
      const { expiresAt } = await issue(server);
      const { rows } = await database.query<{ ms: string }>("SELECT extract(epoch FROM $1::timestamptz - now()) * 1000 AS ms", [expiresAt]);
      expect(Number(rows[0]!.ms)).toBeGreaterThan(DAY_MS - 60_000);
      expect(Number(rows[0]!.ms)).toBeLessThanOrEqual(DAY_MS);
    }
  });

  it("redeems a link that has not expired by the database's clock, on an instance whose clock says it has", async () => {
    const { link } = await issue(first);
    await expiresIn(link, "1 hour");

    expect((await openReset(ahead, link)).status).toBe(200);
    expect((await redeem(ahead, link, { password: "Pia's new password" })).status).toBe(200);
  });

  it("refuses a link that has expired by the database's clock, on an instance whose clock says it has not", async () => {
    const { link } = await issue(first);
    await expiresIn(link, "-1 minute");

    const expired = "This password reset link has expired. Ask an Admin for a new one";
    expect(await refusal(await openReset(behind, link), 410)).toBe(expired);
    expect(await refusal(await redeem(behind, link, { password: "Pia's late password" }), 410)).toBe(expired);
    expect((await signingIn(first, { email: pia.email, password: "Pia's late password" })).status).toBe(401);
  });
});
