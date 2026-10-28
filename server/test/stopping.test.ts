import { once } from "node:events";
import net from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, admin, signIn } from "./support/admin-api.js";
import { openLiveView } from "./support/live-views.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { startRoutingProxy } from "./support/routing-proxy.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 with two server instances on one database behind a proxy that routes
// by their health, as fly.io's does. One is stopped, as a deploy stops the
// previous release's instances, with requests under way and a tablet
// connected to it (ADR-0025; `server/src/drain.ts`).

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: "0.5" };
const GRACE_SECONDS = 1;
const graced = { ...env, DRAIN_GRACE_SECONDS: String(GRACE_SECONDS) };

/** A real Shot naming no hardware, so it is credited to the Machine whose tablet sends it. */
function shot(id: string) {
  const { machine, ...workflow } = shotFixture().workflow as Record<string, unknown>;
  return derivedShot(id, { workflow });
}

/** Its routing check's status, or undefined once nothing answers at the server's address. */
const health = (server: TestServer) => fetch(`${server.url}/api/health`).then((response) => response.status, () => undefined);

describe("stopping an instance", () => {
  let staying: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    staying = await startTestServer({ env });
    api = await AdminApi.setUp(staying.url);
  });
  afterAll(async () => {
    await staying?.stop();
  });

  it("answers 503 to its routing check, hands its tablet to the other instance, and finishes its requests before letting go of the database", async () => {
    const stopping = await startTestServer({ env: graced, sharing: staying });
    // The stopping instance first, so the tablet connects to it.
    const proxy = await startRoutingProxy([stopping, staying]);
    // Transactions holding rows: one holds the drain at its hand-over, so the instance keeps answering until the test is
    // done with that; the others hold the requests under way past it.
    const holdingHandOver = await staying.connectDatabase();
    const holdingAnswered = await staying.connectDatabase();
    const holdingAbandoned = await staying.connectDatabase();
    let leaving: net.Socket | undefined;
    const hold = async (client: pg.Client, machineId: string) => {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM machines WHERE id = $1 FOR UPDATE", [machineId]);
    };
    try {
      const created = await api.createMachine("Through a deploy");
      const tablet = syncingTablet(created, proxy);
      await api.waitForOnline(created);
      expect(proxy.routed).toEqual([stopping.url]);

      // Two requests reissuing other Machines' tokens, each to wait inside its transaction for that Machine's row: one
      // answered, and one whose client sends the end of its headers only once the instance no longer listens, then goes.
      const answered = await api.createMachine("Reissued while stopping");
      const abandoned = await api.createMachine("Reissued for a client that left");
      const cookie = await signIn(staying.url, admin);
      await hold(holdingAnswered, answered.machine.id);
      await hold(holdingAbandoned, abandoned.machine.id);
      const reissuing = api.at(stopping.url).call("POST", `/machines/${answered.machine.id}/token`);
      leaving = net.connect(Number(new URL(stopping.url).port), "127.0.0.1");
      await once(leaving, "connect");
      leaving.write(`POST /api/machines/${abandoned.machine.id}/token HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n`);
      // A hello still being accepted, waiting for its Machine's row: the hand-over waits for it.
      const late = await api.createMachine("Accepted while stopping");
      await hold(holdingHandOver, late.machine.id);
      const raw = await RawConnection.open(stopping.url);
      raw.send(helloWith(late.token, { machine: { model: "DE1Pro", serial: "28201", firmware: "1333" } }));
      await waitForLockWaits(staying, { count: 2 });

      const stopped = stopping.stop();
      // Its routing check answers 503 at once, while it still answers other requests.
      await expect.poll(() => health(stopping), { timeout: 5_000 }).toBe(503);
      expect((await api.at(stopping.url).call("GET", "/machines")).status).toBe(200);
      // Its tablet reconnects, through the proxy, to the other instance.
      await expect.poll(() => proxy.routed.at(-1), { timeout: 5_000 }).toBe(staying.url);
      await api.waitForMachine(created.machine.name, (machine) => machine.online, 5_000);

      // Once its hand-over and grace are over it no longer listens, and the request under way still finishes.
      await holdingHandOver.query("COMMIT");
      await expect.poll(() => health(stopping), { timeout: 5_000 }).toBeUndefined();
      await holdingAnswered.query("COMMIT");
      expect((await reissuing).status).toBe(201);
      // Half a second on, it has finished the requests it knew of and waits for its last connection to close. That one's
      // request now starts, and its client goes while it waits for its row.
      await new Promise((resolve) => setTimeout(resolve, 500));
      leaving.write("Content-Length: 0\r\n\r\n");
      await waitForLockWaits(staying);
      leaving.destroy();
      // It waits for that request too before it lets go of the database.
      const exited = await Promise.race([stopped.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 500))]);
      expect(exited).toBe(false);
      await holdingAbandoned.query("COMMIT");
      await stopped;
      const tokens = await holdingAbandoned.query<{ count: number }>("SELECT count(*)::int AS count FROM machine_tokens WHERE machine_id = $1", [
        abandoned.machine.id,
      ]);
      expect(tokens.rows[0]!.count).toBe(2);

      // A Shot pulled afterwards is captured through the other instance.
      const pulled = shot("pulled-after-the-stop");
      tablet.pullShot(pulled);
      await expect.poll(async () => (await api.call("GET", `/shots/${pulled.id}`)).status, { timeout: 5_000 }).toBe(200);
      expect(proxy.routed.slice(1).every((url) => url === staying.url)).toBe(true);
    } finally {
      leaving?.destroy();
      await Promise.all([holdingHandOver.end(), holdingAnswered.end(), holdingAbandoned.end()]);
      await proxy.close();
      await stopping.stop();
    }
  });

  it("ends its Live Views at once, and any opened during its grace, which the browser opens again elsewhere", async () => {
    const stopping = await startTestServer({ env: graced, sharing: staying });
    const holdingHandOver = await staying.connectDatabase();
    try {
      const machine = await api.createMachine("Watched through a deploy");
      const watched = await openLiveView(api.at(stopping.url), machine.machine.id);
      expect(watched.status).toBe(200);
      // A hello still being accepted, waiting for its Machine's row, holds the hand-over, so the instance answers
      // requests until the test is done.
      const late = await api.createMachine("Accepted while its Live Views end");
      await holdingHandOver.query("BEGIN");
      await holdingHandOver.query("SELECT 1 FROM machines WHERE id = $1 FOR UPDATE", [late.machine.id]);
      const raw = await RawConnection.open(stopping.url);
      raw.send(helloWith(late.token, { machine: { model: "DE1Pro", serial: "28202", firmware: "1333" } }));
      await waitForLockWaits(staying);

      const stopped = stopping.stop();
      // Ended while it still answers requests, rather than as it exits: an open stream would hold up its finish.
      await expect.poll(() => watched.ended).toBe(true);
      await expect.poll(() => health(stopping), { timeout: 5_000 }).toBe(503);
      const opened = await openLiveView(api.at(stopping.url), machine.machine.id);
      expect(opened.status).toBe(200);
      await expect.poll(() => opened.ended).toBe(true);
      await holdingHandOver.query("COMMIT");
      await stopped;
    } finally {
      await holdingHandOver.end();
      await stopping.stop();
    }
  });

  it("answers requests for its grace, though it has nothing to hand over or finish, and ignores another signal meanwhile", async () => {
    const stopping = await startTestServer({ env: graced, sharing: staying });
    try {
      const signalled = performance.now();
      const stopped = stopping.stop();
      // As a terminal's Ctrl-C reaches it twice under `npm start`, from the terminal and from npm.
      await expect.poll(() => stopping.output(), { timeout: 5_000 }).toMatch(/Stopping on SIGTERM/);
      stopping.signal("SIGINT");
      const statuses: number[] = [];
      for (let status = await health(stopping); status !== undefined; status = await health(stopping)) {
        statuses.push(status);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Only the server's own timer, begun once the signal reached it, ends the grace.
      expect(performance.now() - signalled).toBeGreaterThanOrEqual(GRACE_SECONDS * 1000);
      expect(statuses.at(-1)).toBe(503);
      await stopped;
    } finally {
      await stopping.stop();
    }
  });
});
