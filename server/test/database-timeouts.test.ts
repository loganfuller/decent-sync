import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { databaseUnreachable, poolConfig } from "../src/database.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { Notifications } from "../src/notifications.js";
import { type OutageProxy, startOutageProxy } from "./support/outage-proxy.js";
import { adminDatabaseUrl } from "./support/test-server.js";

// The server's connections to the PostgreSQL server tests use
// (`server/src/database.ts`), through a proxy that takes it away
// (`outage-proxy.ts`): what each way of losing it fails with, which a
// request answers with 503, that a statement outlasting its query timeout
// leaves behind no connection for a later query to wait on, and that the
// notifications listener notices a connection gone silent. The pool's
// timeouts are shortened here. It runs only `SELECT`s and notifications.

const QUERY_TIMEOUT_MS = 1_000;
const CONNECT_TIMEOUT_MS = 500;

describe("the server's database client", () => {
  let proxy: OutageProxy;
  const clients: PrismaClient[] = [];

  beforeAll(async () => {
    proxy = await startOutageProxy();
  });
  afterEach(async () => {
    proxy.restore();
    await Promise.all(clients.splice(0).map((client) => client.$disconnect().catch(() => {})));
  });
  afterAll(async () => {
    await proxy?.close();
  });

  /** The database's URL through the proxy. */
  function throughProxy(): string {
    const url = new URL(adminDatabaseUrl());
    url.host = proxy.host;
    return url.href;
  }
  /** A client of the server's pool through the proxy, its timeouts short, holding at most `max` connections. */
  function connect(max = 10): PrismaClient {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ ...poolConfig(throughProxy(), QUERY_TIMEOUT_MS), connectionTimeoutMillis: CONNECT_TIMEOUT_MS, max }),
    });
    clients.push(prisma);
    return prisma;
  }
  /** Resolves with what the work failed with. */
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => {
        throw new Error("It succeeded");
      },
      (error: unknown) => error,
    );

  it("fails a transaction's statement on a silenced connection at its timeout, and leaves the connection out of the pool", async () => {
    const prisma = connect(1);
    const started = Date.now();
    const failed = await failure(
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        proxy.silence();
        await tx.$queryRaw`SELECT 2`;
      }),
    );
    expect(databaseUnreachable(failed)).toBe(true);
    // Its ROLLBACK, queued on the same connection, failed at once rather than waiting out a timeout of its own.
    expect(Date.now() - started).toBeLessThan(2 * QUERY_TIMEOUT_MS);

    proxy.restore();
    // The pool's one connection is a new one, not the one still awaiting an answer.
    const at = Date.now();
    expect(await prisma.$queryRaw`SELECT 3 AS n`).toEqual([{ n: 3 }]);
    expect(Date.now() - at).toBeLessThan(QUERY_TIMEOUT_MS);
  });

  it("takes every way of losing the database for one", async () => {
    const prisma = connect();
    // Connections reset and new ones refused.
    await prisma.$queryRaw`SELECT 1`;
    proxy.cut();
    expect(databaseUnreachable(await failure(prisma.$queryRaw`SELECT 1`))).toBe(true);
    expect(databaseUnreachable(await failure(prisma.$transaction((tx) => tx.$queryRaw`SELECT 1`)))).toBe(true);
    proxy.restore();

    // A connection reset while in use.
    const inUse = failure(prisma.$executeRaw`SELECT pg_sleep(5)`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    proxy.resetConnections();
    expect(databaseUnreachable(await inUse)).toBe(true);

    // A statement on a silenced connection, and new connections accepted but never answered.
    await prisma.$queryRaw`SELECT 1`;
    proxy.silence();
    expect(databaseUnreachable(await failure(prisma.$queryRaw`SELECT 1`))).toBe(true);
    expect(databaseUnreachable(await failure(prisma.$queryRaw`SELECT 1`))).toBe(true);
    expect(databaseUnreachable(await failure(prisma.$transaction((tx) => tx.$queryRaw`SELECT 1`, { maxWait: 200 })))).toBe(true);
    proxy.restore();

    // No connection free in time.
    const busy = connect(1);
    // Longer than a wait for a connection may take, within the query timeout. Prisma sends a query only once awaited.
    const holding = busy.$executeRaw`SELECT pg_sleep(0.8)`.then(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(databaseUnreachable(await failure(busy.$queryRaw`SELECT 1`))).toBe(true);
    await holding;

    // PostgreSQL ending the connection mid-statement, as a database shutting down for a failover does (57P01).
    const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
    await admin.connect();
    try {
      let pid: number | undefined;
      const terminated = failure(
        prisma.$transaction(async (tx) => {
          [{ pid }] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
          await tx.$executeRaw`SELECT pg_sleep(5)`;
        }),
      );
      await expect.poll(async () => pid !== undefined && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active'", [pid])).rowCount).toBe(1);
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      expect(databaseUnreachable(await terminated)).toBe(true);
    } finally {
      await admin.end();
    }
  });

  it("takes no other failure for one", async () => {
    const prisma = connect();
    expect(databaseUnreachable(await failure(prisma.$queryRaw`SELECT 1 / 0`))).toBe(false);
    expect(databaseUnreachable(await failure(prisma.$queryRaw`SELECT * FROM no_such_table`))).toBe(false);
    // Too few values bound: a protocol violation (08P01), of the request's own making.
    expect(databaseUnreachable(await failure(prisma.$queryRawUnsafe("SELECT $1::int + $2::int", 1)))).toBe(false);
    expect(databaseUnreachable(await failure(prisma.$transaction(async () => { throw new Error("Not the database's"); })))).toBe(false);
    // A transaction that outlasts its own limit is the request's doing.
    expect(databaseUnreachable(await failure(prisma.$transaction((tx) => tx.$executeRaw`SELECT pg_sleep(0.3)`, { timeout: 100 })))).toBe(false);
  });

  it("has the notifications listener notice its connection gone silent behind a hop that stays up, and listen again", async () => {
    const notifications = new Notifications({ databaseUrl: throughProxy(), heartbeatIntervalMs: 200 } as Config);
    const heard: (string | null)[] = [];
    notifications.subscribe("library_changes", (payload) => heard.push(payload));
    await notifications.onModuleInit();
    const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
    await admin.connect();
    try {
      expect(heard).toEqual([null]);
      // New connections are relayed again at once, but the listener's stays silent, as through a pooler whose own
      // connection to the database went silent: keepalive, answered by the proxy, never ends it.
      proxy.silence();
      proxy.restore();
      await expect.poll(() => heard, { timeout: 10_000 }).toEqual([null, null]);
      await admin.query("SELECT pg_notify('library_changes', 'after the outage')");
      await expect.poll(() => heard).toEqual([null, null, "after the outage"]);
    } finally {
      await admin.end();
      await notifications.onModuleDestroy();
    }
  });
});
