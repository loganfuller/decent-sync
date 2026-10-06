import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Config, StartupError } from "./config.js";
import { PrismaClient } from "./generated/prisma/client.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The idle-in-transaction timeout that migration
 * `20261006020933_idle_in_transaction_timeout` sets on the database, and
 * explains.
 */
const IDLE_IN_TRANSACTION_TIMEOUT = "30s";

/**
 * Applies pending database migrations, so upgrading the server is starting a
 * newer build. Runs Prisma's own `migrate deploy`, which takes an advisory
 * lock and never resets data.
 */
export async function runMigrations(config: Config): Promise<void> {
  await requirePostgres14(config);
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, "migrate", "deploy"], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new StartupError(`Database migrations failed (prisma migrate deploy exited with ${code})`);
  }
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
  new Logger("Database").warn(
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
