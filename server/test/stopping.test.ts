import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { startRoutingProxy } from "./support/routing-proxy.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 with two server instances on one database behind a proxy that routes
// by their health, as fly.io's does. One is stopped, as a deploy stops the
// previous release's instances, with a request under way and a tablet
// connected to it (ADR-0025; `server/src/drain.ts`).

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: "0.5" };
/** The stopping instance's grace: long enough to check what it answers meanwhile. */
const GRACE_SECONDS = 2;

/** A real Shot naming no hardware, so it is credited to the Machine whose tablet sends it. */
function shot(id: string) {
  const { machine, ...workflow } = shotFixture().workflow as Record<string, unknown>;
  return derivedShot(id, { workflow });
}

/** Whether anything answers at the server's address. */
const answering = (server: TestServer) => fetch(`${server.url}/api/health`).then(() => true, () => false);

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
    const stopping = await startTestServer({ env: { ...env, DRAIN_GRACE_SECONDS: String(GRACE_SECONDS) }, sharing: staying });
    // The stopping instance first, so the tablet connects to it.
    const proxy = await startRoutingProxy([stopping, staying]);
    const database = await staying.connectDatabase();
    try {
      const created = await api.createMachine("Through a deploy");
      const tablet = syncingTablet(created, proxy);
      await api.waitForOnline(created);
      expect(proxy.routed).toEqual([stopping.url]);

      // A request under way: reissuing another Machine's token, inside its transaction, waits for that Machine's row.
      const other = await api.createMachine("Reissued while stopping");
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM machines WHERE id = $1 FOR UPDATE", [other.machine.id]);
      const reissuing = api.at(stopping.url).call("POST", `/machines/${other.machine.id}/token`);
      await waitForLockWaits(staying);

      const stopped = stopping.stop();
      // At once, its routing check answers 503, while it still answers other requests.
      await expect.poll(async () => (await fetch(`${stopping.url}/api/health`)).status, { timeout: 1_000 }).toBe(503);
      expect((await api.at(stopping.url).call("GET", "/machines")).status).toBe(200);
      // Its tablet reconnects, through the proxy, to the other instance.
      await expect.poll(() => proxy.routed.at(-1), { timeout: 5_000 }).toBe(staying.url);
      await api.waitForMachine(created.machine.name, (machine) => machine.online, 5_000);

      // After the grace it no longer listens, and the request under way still finishes.
      await expect.poll(() => answering(stopping), { timeout: (GRACE_SECONDS + 1) * 1000 }).toBe(false);
      await database.query("COMMIT");
      expect((await reissuing).status).toBe(201);
      await stopped;

      // A Shot pulled afterwards is captured through the other instance.
      const pulled = shot("pulled-after-the-stop");
      tablet.pullShot(pulled);
      await expect.poll(async () => (await api.call("GET", `/shots/${pulled.id}`)).status, { timeout: 5_000 }).toBe(200);
      expect(proxy.routed.slice(1).every((url) => url === staying.url)).toBe(true);
    } finally {
      await database.end();
      await proxy.close();
      await stopping.stop();
    }
  });
});
