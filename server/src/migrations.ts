import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { type Config, StartupError } from "./config.js";
import { PrismaClient } from "./generated/prisma/client.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logger = new Logger("Database");

/**
 * The idle-in-transaction timeout that migration `20261016000000_init` sets on
 * the database, and explains.
 */
const IDLE_IN_TRANSACTION_TIMEOUT = "30s";

/**
 * The advisory lock Prisma's `migrate deploy` takes, which is Prisma's own and
 * not public API: `server/test/migrations.test.ts` fails if a Prisma upgrade
 * changes it.
 */
export const MIGRATION_LOCK_ID = 72707369;

/** The `application_name` of the connection holding, or waiting for, the migration lock. */
export const MIGRATION_LOCK_CONNECTION = "decent-sync migration lock";

/**
 * Applies pending database migrations, so upgrading the server is starting a
 * newer build. Runs Prisma's own `migrate deploy`, which never resets data.
 *
 * Instances wait for each other's migrations however long they take: rather
 * than Prisma's lock, which it gives up on after 10 s, this holds the same
 * lock itself, with no timeout, and runs Prisma with its own turned off. The
 * previous release's instances, which take Prisma's lock, are still kept out,
 * and the lock is let go once migrated, as one restarting meanwhile gives up
 * after those 10 s (ADR-0025).
 *
 * A migration that fails, or whose instance is killed partway, leaves Prisma's
 * record of it unfinished, and every later `migrate deploy` then refuses to
 * run, the previous release's included. So, holding the lock, this records
 * any such migration as rolled back: as it starts, before migrating, and as a
 * migration fails, before exiting.
 */
export async function runMigrations(config: Config): Promise<void> {
  await requirePostgres14(config);
  const lock = await takeMigrationLock(config);
  try {
    for (const name of await recordUnfinishedAsRolledBack(lock)) {
      logger.warn(`Recorded migration ${name}, left unfinished by an instance that failed or was killed partway through it, as rolled back, so it is applied again`);
    }
    const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [prismaCli, "migrate", "deploy"], {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: config.databaseUrl, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1" },
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code !== 0) throw await migrationFailure(lock, code);
  } finally {
    await lock.end().catch(() => {});
  }
}

/** Why migrating failed, once the migration that failed is recorded as rolled back. */
async function migrationFailure(lock: pg.Client, code: number | null): Promise<StartupError> {
  const failed = `Database migrations failed (prisma migrate deploy exited with ${code})`;
  let names: string[];
  try {
    names = await recordUnfinishedAsRolledBack(lock);
  } catch (error) {
    return new StartupError(`${failed}, and recording the migration as rolled back failed too (${messageOf(error)}), so the next start records it`);
  }
  // Prisma stops at the first migration that fails, so there is one at most.
  return new StartupError(
    [
      failed,
      ...names.map(
        (name) =>
          `Recorded ${name} as rolled back, so the next start applies it again. If it had in fact been applied, by an instance killed ` +
          `after its commit but before Prisma recorded it, every retry fails on what it creates already existing: once you have checked ` +
          `it was applied whole, record it by running \`npx prisma migrate resolve --applied ${name}\` in the server's directory, with its DATABASE_URL`,
      ),
    ].join(". "),
  );
}

/**
 * Takes the migration lock on a connection of its own, named
 * `MIGRATION_LOCK_CONNECTION`, waiting however long another instance holds
 * it. PostgreSQL probes the connection with TCP keepalives, so it drops the
 * lock of a holder whose host vanished within a minute, and the server probes
 * it too, so a database that vanished doesn't leave it waiting for good.
 */
async function takeMigrationLock(config: Config): Promise<pg.Client> {
  const lock = new pg.Client({ connectionString: config.databaseUrl, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
  // Without a listener, a connection lost while Prisma migrates would crash the server; queries on it fail instead.
  lock.on("error", (error) => logger.warn(`Lost the migration lock's connection: ${error.message}`));
  try {
    await lock.connect();
    // Set once connected, as a pooler may refuse startup parameters. A host's timeouts would end the wait, or the lock while Prisma migrates.
    await lock.query(
      `SET application_name = '${MIGRATION_LOCK_CONNECTION}'; ` +
        "SET tcp_keepalives_idle = 10; SET tcp_keepalives_interval = 5; SET tcp_keepalives_count = 3; " +
        "SET statement_timeout = 0; SET lock_timeout = 0; SET idle_session_timeout = 0",
    );
    // Tried each second rather than waited for in one query, which would hold a snapshot all the while: a concurrent
    // index build among the holder's migrations waits for every older snapshot, so it would fail on its lock_timeout.
    const take = async () => (await lock.query<{ taken: boolean }>("SELECT pg_try_advisory_lock($1) AS taken", [MIGRATION_LOCK_ID])).rows[0]?.taken;
    if (!(await take())) {
      logger.log("Waiting for another instance's migrations to finish");
      do await new Promise((resolve) => setTimeout(resolve, 1_000));
      while (!(await take()));
    }
    return lock;
  } catch (error) {
    await lock.end().catch(() => {});
    throw new StartupError(`Cannot use the database in DATABASE_URL: ${messageOf(error)}`);
  }
}

/**
 * Records every migration Prisma left unfinished as rolled back, as `prisma
 * migrate resolve --rolled-back` would, and names them. Only while holding the
 * migration lock, so no instance still running is applying one.
 */
async function recordUnfinishedAsRolledBack(lock: pg.Client): Promise<string[]> {
  // A fresh database has no record of migrations yet.
  const { rows: [table] } = await lock.query<{ exists: boolean }>("SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists");
  if (!table?.exists) return [];
  const { rows } = await lock.query<{ name: string }>(
    "UPDATE _prisma_migrations SET rolled_back_at = now() WHERE finished_at IS NULL AND rolled_back_at IS NULL RETURNING migration_name AS name",
  );
  return rows.map((row) => row.name);
}

/**
 * Warns when PostgreSQL would never end a transaction left open on the
 * server's connections, and lets the server start: only the database's owner
 * or a superuser may set the timeout, so its migration may have skipped it,
 * or it was turned off since. Reads it on a new connection, since a database
 * setting applies to sessions started after it changes.
 */
export async function checkIdleInTransactionTimeout(config: Config): Promise<void> {
  const [row] = await queryOnNewConnection(config, (prisma) => prisma.$queryRaw<{ timeout: string; database: string }[]>`
    SELECT current_setting('idle_in_transaction_session_timeout') AS timeout, quote_ident(current_database()) AS database`);
  if (row?.timeout !== "0") return;
  logger.warn(
    "idle_in_transaction_session_timeout is off for the server's database connections, so a transaction abandoned " +
      "by a vanished host can keep its row locks until PostgreSQL notices the lost connection, which can take hours. " +
      "To set it, run this as the database's owner or a superuser, then restart the server: " +
      `ALTER DATABASE ${row.database} SET idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}';`,
  );
}

// Checked before migrating so an unsupported server leaves no failed migration
// behind; the first migration repeats the check for anyone migrating by hand.
async function requirePostgres14(config: Config): Promise<void> {
  const [row] = await queryOnNewConnection(config, (prisma) => prisma.$queryRaw<{ num: string; version: string }[]>`
    SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version`);
  if (!row || Number(row.num) < 140000) {
    throw new StartupError(`Decent Sync needs PostgreSQL 14 or newer; the database runs ${row?.version ?? "an unknown version"}`);
  }
}

/** Runs a query on a connection of its own, closed afterwards. */
async function queryOnNewConnection<T>(config: Config, query: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  try {
    return await query(prisma).catch((error: unknown) => {
      // The URL holds the database password, so name the variable instead.
      throw new StartupError(`Cannot use the database in DATABASE_URL: ${describeDatabaseError(error)}`);
    });
  } finally {
    await prisma.$disconnect();
  }
}

function describeDatabaseError(error: unknown): string {
  const { code, meta, message } = (error ?? {}) as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
    message?: string;
  };
  const lastLine = message?.trim().split("\n").at(-1)?.trim();
  return meta?.driverAdapterError?.cause?.originalMessage ?? (code && !code.startsWith("P") ? `connection failed (${code})` : lastLine) ?? String(error);
}

/** A `pg` error's message, which never holds the database password. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
