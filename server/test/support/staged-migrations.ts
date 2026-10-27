import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuilt } from "./builds.js";
import type { TestServer } from "./test-server.js";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface StagedMigrations {
  /** The tree to run, as `startTestServer({ buildDir })`. */
  buildDir: string;
  /** Deletes the copy. */
  remove(): void;
}

/**
 * A copy of the change's built server, in a directory of its own, with these
 * migrations, keyed by name, after its own, as the next release would bring.
 * Name each so it sorts after every real migration. The copy runs on the
 * checkout's dependencies and management interface.
 */
export function stageMigrations(migrations: Record<string, string>): StagedMigrations {
  assertBuilt("protocol", "server");
  // Its real path, which the server's processes see, as macOS's temporary directory is behind a symlink.
  const buildDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-staged-")));
  for (const entry of ["dist", "prisma", "prisma.config.ts", "package.json"]) {
    fs.cpSync(path.join(repoDir, "server", entry), path.join(buildDir, "server", entry), { recursive: true });
  }
  fs.symlinkSync(path.join(repoDir, "node_modules"), path.join(buildDir, "node_modules"));
  fs.symlinkSync(path.join(repoDir, "web"), path.join(buildDir, "web"));
  for (const [name, sql] of Object.entries(migrations)) {
    const dir = path.join(buildDir, "server/prisma/migrations", name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "migration.sql"), sql);
  }
  return { buildDir, remove: () => fs.rmSync(buildDir, { recursive: true, force: true }) };
}

/** Prisma's records of the named migration in the server's database, one for each attempt, oldest first. */
export async function migrationRecords(server: TestServer, name: string): Promise<{ finished: boolean; rolledBack: boolean }[]> {
  const database = await server.connectDatabase();
  try {
    const { rows } = await database.query<{ finished: boolean; rolledBack: boolean }>(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
       FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
      [name],
    );
    return rows;
  } finally {
    await database.end();
  }
}
