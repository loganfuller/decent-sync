import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type ManagedAccountView, acceptInvite, admin, secretOf } from "./support/admin-api.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// The limit on password checks one server instance runs at once, through the
// REST API of a real server on a fresh database. Its password hashes wait
// while a gate file exists (startTestServer's `passwordHashGate`), so a test
// can hold checks running and waiting, and count the hashes the server
// starts. accounts.test.ts and sign-in-limits.test.ts cover sign-in within
// the limit. The tests share one server and run in order.

/** Password checks an instance runs at once, and how many more may wait. */
const RUNNING = 2;
const WAITING = 16;
const BUSY = "The server is busy checking other passwords. Try again in a moment.";

describe("password checks on one server instance", { timeout: 30_000 }, () => {
  let server: TestServer;
  let database: pg.Client;
  let gateDir: string;
  let gate: string;
  let api: AdminApi;
  let round = 0;

  const post = (path: string, body: unknown) =>
    fetch(`${server.url}/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const signIn = (email: string, password = "guess") => post("/session", { email, password });

  /** The hashes the server's output reports since `from`: how many started, and the most running at once. */
  const hashes = (from = 0) => {
    const running = [...server.output().slice(from).matchAll(/\[password hash\] started, (\d+) running/g)].map((match) => Number(match[1]));
    return { started: running.length, mostRunning: Math.max(0, ...running) };
  };
  const waitForHashes = async (from: number, started: number) => {
    const deadline = Date.now() + 10_000;
    while (hashes(from).started < started) {
      if (Date.now() > deadline) throw new Error(`${started} hashes did not start within 10 s:\n${server.output().slice(from)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const expectBusy = async (response: Response) => {
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(((await response.json()) as { message: string }).message).toBe(BUSY);
  };

  /**
   * Holds hashes, then starts one more sign-in, each for an unknown email,
   * than the instance runs and lets wait. Once one is refused, the rest are
   * running or waiting, and stay so until `release`: any later check is
   * refused. Returns the emails and responses of those still pending.
   */
  const fill = async () => {
    fs.writeFileSync(gate, "");
    round++;
    const emails = Array.from({ length: RUNNING + WAITING + 1 }, (_, i) => `held-${round}-${i}@example.com`);
    const pending = emails.map((email, i) => signIn(email).then((response) => ({ i, response })));
    // Nothing admitted can finish while hashes are held, so the first to settle was refused.
    const first = await Promise.race([
      ...pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`None of ${emails.length} sign-ins was refused`)), 5_000)),
    ]);
    await expectBusy(first.response);
    return {
      refusedEmail: emails[first.i]!,
      heldEmails: emails.filter((_, i) => i !== first.i),
      held: pending.filter((_, i) => i !== first.i),
    };
  };
  /** Lets held hashes run, and waits for the held sign-ins, each refused as a wrong password. */
  const release = async (held: Promise<{ response: Response }>[]) => {
    fs.rmSync(gate);
    const statuses = (await Promise.all(held)).map(({ response }) => response.status);
    expect(statuses).toEqual(Array(RUNNING + WAITING).fill(401));
  };

  beforeAll(async () => {
    gateDir = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-hash-gate-"));
    gate = path.join(gateDir, "closed");
    server = await startTestServer({ passwordHashGate: gate });
    database = await server.connectDatabase();
    // The first unknown email also hashes the dummy password it is checked against; done here, each later check hashes once.
    expect((await signIn("first@example.com")).status).toBe(401);
  }, 60_000);
  afterAll(async () => {
    fs.rmSync(gateDir, { recursive: true, force: true });
    await database?.end();
    await server?.stop();
  });

  it("runs two at once with sixteen waiting, and refuses a sign-in beyond them before any hash or limiter work", async () => {
    const from = server.output().length;
    const { refusedEmail, heldEmails, held } = await fill();

    // Two run, each having counted its attempt; the sixteen waiting have done nothing yet.
    await waitForHashes(from, RUNNING);
    const { rows } = await database.query<{ email: string }>("SELECT email FROM sign_in_windows WHERE email = ANY($1)", [
      [...heldEmails, refusedEmail],
    ]);
    expect(rows).toHaveLength(RUNNING);
    expect(rows.map(({ email }) => email)).not.toContain(refusedEmail);
    // Refused alike whatever the email, so the refusal reveals no accounts.
    await expectBusy(await signIn("someone-else@example.com"));
    expect(hashes(from)).toEqual({ started: RUNNING, mostRunning: RUNNING });

    // The rest then run in turn, never more than two at once, and the refused sign-ins hashed nothing.
    await release(held);
    expect(hashes(from)).toEqual({ started: RUNNING + WAITING, mostRunning: RUNNING });
    // And their emails count as before.
    const { rows: counted } = await database.query("SELECT 1 FROM sign_in_windows WHERE email = ANY($1)", [heldEmails]);
    expect(counted).toHaveLength(RUNNING + WAITING);
  });

  it("refuses first-run setup beyond them too, leaving setup open", async () => {
    const { held } = await fill();
    await expectBusy(await post("/setup", admin));
    await release(held);

    expect(await (await fetch(`${server.url}/api/setup`)).json()).toMatchObject({ required: true });
    api = await AdminApi.setUp(server.url);
  });

  it("refuses accepting an invite, using a password reset link and a right password beyond them, and each works afterwards", async () => {
    const invited = await api.invite("invited@example.com", "admin");
    const reset = await api.invite("reset@example.com", "admin");
    await acceptInvite(server.url, reset.link, { name: "Reese Reset", password: "the first password" });
    const account = (await api.accounts()).find((each: ManagedAccountView) => each.email === "reset@example.com")!;
    const issued = (await (await api.call("POST", `/accounts/${account.id}/password-reset`)).json()) as { link: string };
    const accept = () => post(`/invite-links/${secretOf(invited.link)}/accept`, { name: "Ivy Invited", password: "a long password" });
    const redeem = () => post(`/password-reset-links/${secretOf(issued.link)}/redeem`, { password: "the second password" });

    const from = server.output().length;
    const { held } = await fill();
    await expectBusy(await accept());
    await expectBusy(await redeem());
    await expectBusy(await signIn(admin.email, admin.password));
    // Opening a link checks no password, so it still answers.
    expect((await fetch(`${server.url}/api/invite-links/${secretOf(invited.link)}`)).status).toBe(200);
    await release(held);
    expect(hashes(from).started).toBe(RUNNING + WAITING);

    expect((await accept()).status).toBe(201);
    expect((await redeem()).status).toBe(200);
    expect((await signIn(admin.email, admin.password)).status).toBe(200);
    expect((await signIn("reset@example.com", "the second password")).status).toBe(200);
  });
});
