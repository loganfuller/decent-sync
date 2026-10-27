import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, admin, signIn } from "./support/admin-api.js";
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
    const hold = async (client: pg.Client, machineId: string) => {
      await client.query("BEGIN");
      await client.query("SELECT 1 FROM machines WHERE id = $1 FOR UPDATE", [machineId]);
    };
    try {
      const created = await api.createMachine("Through a deploy");
      const tablet = syncingTablet(created, proxy);
      await api.waitForOnline(created);
      expect(proxy.routed).toEqual([stopping.url]);

      // Two requests under way, each reissuing another Machine's token, waiting inside its transaction for that Machine's
      // row: one answered, and one whose client goes.
      const answered = await api.createMachine("Reissued while stopping");
      const abandoned = await api.createMachine("Reissued for a client that left");
      const cookie = await signIn(staying.url, admin);
      await hold(holdingAnswered, answered.machine.id);
      await hold(holdingAbandoned, abandoned.machine.id);
      const reissuing = api.at(stopping.url).call("POST", `/machines/${answered.machine.id}/token`);
      const leaving = new AbortController();
      const left = fetch(`${stopping.url}/api/machines/${abandoned.machine.id}/token`, { method: "POST", headers: { Cookie: cookie }, signal: leaving.signal });
      // A hello still being accepted, waiting for its Machine's row: the hand-over waits for it.
      const late = await api.createMachine("Accepted while stopping");
      await hold(holdingHandOver, late.machine.id);
      const raw = await RawConnection.open(stopping.url);
      raw.send(helloWith(late.token, { machine: { model: "DE1Pro", serial: "28201", firmware: "1333" } }));
      await waitForLockWaits(staying, { count: 3 });
      leaving.abort();
      await expect(left).rejects.toThrow();

      const stopped = stopping.stop();
      // Its routing check answers 503 at once, while it still answers other requests.
      await expect.poll(() => health(stopping), { timeout: 5_000 }).toBe(503);
      expect((await api.at(stopping.url).call("GET", "/machines")).status).toBe(200);
      // Its tablet reconnects, through the proxy, to the other instance.
      await expect.poll(() => proxy.routed.at(-1), { timeout: 5_000 }).toBe(staying.url);
      await api.waitForMachine(created.machine.name, (machine) => machine.online, 5_000);

      // Once its hand-over and grace are over it no longer listens, and the requests under way still finish.
      await holdingHandOver.query("COMMIT");
      await expect.poll(() => health(stopping), { timeout: 5_000 }).toBeUndefined();
      await holdingAnswered.query("COMMIT");
      expect((await reissuing).status).toBe(201);
      // It waits for the request whose client went too, still waiting for its row, before it lets go of the database.
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
      await Promise.all([holdingHandOver.end(), holdingAnswered.end(), holdingAbandoned.end()]);
      await proxy.close();
      await stopping.stop();
    }
  });

  it("answers requests for its grace, though it has nothing to hand over or finish", async () => {
    const stopping = await startTestServer({ env: graced, sharing: staying });
    try {
      const signalled = performance.now();
      const stopped = stopping.stop();
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
