import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { type PoolerProxy, startPoolerProxy } from "./support/pooler-proxy.js";
import { type TestServer, type TestServerOptions, startTestServer } from "./support/test-server.js";

// A migration sets idle_in_transaction_session_timeout on the database, so
// the server's connections need not send it at startup, which a pooler may
// refuse or drop. Only the database's owner or a superuser may set it, so the
// server warns at startup, and starts anyway, while it is off.

const WARNING = "idle_in_transaction_session_timeout is off";
const fix = (database: string) => `ALTER DATABASE ${database} SET idle_in_transaction_session_timeout = '30s';`;

describe("the idle-in-transaction timeout", { timeout: 60_000 }, () => {
  const servers: TestServer[] = [];
  const clients: pg.Client[] = [];
  const poolers: PoolerProxy[] = [];

  const start = async (options?: TestServerOptions) => {
    const server = await startTestServer(options);
    servers.push(server);
    return server;
  };
  const connect = async (server: TestServer) => {
    const client = await server.connectDatabase();
    clients.push(client);
    return client;
  };
  /** A session's timeout as `SHOW` reports it, and where that came from. */
  const timeoutOf = async (client: pg.Client) =>
    (
      await client.query<{ timeout: string; source: string }>(
        "SELECT current_setting(name) AS timeout, source FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'",
      )
    ).rows[0];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end()));
    // Instances sharing a database stop before the one that drops it.
    for (const server of servers.splice(0).reverse()) await server.stop();
    await Promise.all(poolers.splice(0).map((pooler) => pooler.close()));
  });

  it("is set on a fresh database, for connections that send no settings", async () => {
    const server = await start();

    expect(await timeoutOf(await connect(server))).toEqual({ timeout: "30s", source: "database" });
    expect(server.output()).not.toContain(WARNING);
  });

  it("reaches the server's connections through a pooler, without a startup setting it would refuse", async () => {
    const direct = await start();
    const pooler = await startPoolerProxy();
    poolers.push(pooler);
    // A refused connection pool leaves the server never healthy; say why.
    const pooled = await start({ sharing: direct, databaseHost: pooler.host }).catch((error: unknown) => {
      expect([...pooler.refused], "startup parameters the pooler refused").toEqual([]);
      throw error;
    });
    // Uses the server's connection pool, as its health check did.
    await AdminApi.setUp(pooled.url);

    expect([...pooler.refused]).toEqual([]);
    expect(pooler.sessions.length).toBeGreaterThan(0);
    for (const session of pooler.sessions) {
      expect(session.parameters).not.toHaveProperty("idle_in_transaction_session_timeout");
      expect(session.idleInTransactionTimeout).toBe("30s");
    }
  });

  it("is left off when the server migrates as a role that does not own the database, which then starts with a warning", async () => {
    const server = await start({ notOwner: true });
    const database = await connect(server);

    const { rows } = await database.query(
      "SELECT finished_at FROM _prisma_migrations WHERE migration_name = '20261006020933_idle_in_transaction_timeout'",
    );
    expect(rows).toEqual([{ finished_at: expect.any(Date) }]);
    expect(await timeoutOf(database)).toEqual({ timeout: "0", source: "default" });
    await expect.poll(() => server.output()).toContain(WARNING);
    expect(server.output()).toContain(fix(server.database));
    await AdminApi.setUp(server.url);
  });

  it("is warned of at startup when turned off, and the server still serves", async () => {
    const first = await start();
    await (await connect(first)).query(`ALTER DATABASE ${first.database} SET idle_in_transaction_session_timeout = 0`);
    const second = await start({ sharing: first });

    await expect.poll(() => second.output()).toContain(WARNING);
    expect(second.output()).toContain(fix(first.database));
    const api = await AdminApi.setUp(second.url);
    expect((await api.createMachine("Uptown")).machine).toMatchObject({ name: "Uptown" });
  });
});
