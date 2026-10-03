import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Config, StartupError } from "./config.js";
import { PrismaClient } from "./generated/prisma/client.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

// Checked before migrating so an unsupported server leaves no failed migration
// behind; the first migration repeats the check for anyone migrating by hand.
async function requirePostgres14(config: Config): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  try {
    const [row] = await prisma.$queryRaw<{ num: string; version: string }[]>`
      SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version`
      .catch((error: unknown) => {
        // The URL holds the database password, so name the variable instead.
        throw new StartupError(`Cannot use the database in DATABASE_URL: ${describeDatabaseError(error)}`);
      });
    if (!row || Number(row.num) < 140000) {
      throw new StartupError(`Decent Sync needs PostgreSQL 14 or newer; the database runs ${row?.version ?? "an unknown version"}`);
    }
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
