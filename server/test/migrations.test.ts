import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitForLockWaits } from "./support/lock-waits.js";
import { type StagedMigrations, migrationRecords, stageMigrations } from "./support/staged-migrations.js";
import { type TestServer, type TestServerOptions, adminDatabaseUrl, startTestServer } from "./support/test-server.js";

// Instances migrate one at a time under the advisory lock Prisma takes, which
// they hold themselves, with no timeout, while Prisma runs with its own lock
// off. A migration that fails, or whose instance is killed partway, is
// recorded as rolled back, so that every release's next `migrate deploy` runs
// (ADR-0025). The migrations staged here come after the change's own, as the
// next release's would.

/** Prisma's advisory lock, which the server holds itself, and the name of its connection for it (`server/src/migrations.ts`). */
const MIGRATION_LOCK = 72707369;
const MIGRATION_LOCK_CONNECTION = "decent-sync migration lock";
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COLUMN = "99990101000000_staged_column";
const INDEX = "99990101000001_staged_index";

describe("migrations", () => {
  let staged: StagedMigrations;
  const owners: TestServer[] = [];
  const clients: pg.Client[] = [];

  beforeAll(() => {
    staged = stageMigrations({
      // Waiting longer than the format's 5 s for a table a test holds, so that only the server can end the wait in time.
      [COLUMN]: `BEGIN;\nSET LOCAL lock_timeout = '1min';\n\nALTER TABLE "machines" ADD COLUMN "staged" INTEGER;\nALTER TABLE "shots" ADD COLUMN "staged" INTEGER;\n\nCOMMIT;\n`,
      [INDEX]: `SET lock_timeout = '5s';\nDROP INDEX IF EXISTS "shots_staged_idx";\nCREATE INDEX CONCURRENTLY "shots_staged_idx" ON "shots" ("staged");\n`,
    });
  });
  afterAll(() => staged.remove());

  const start = async (options?: TestServerOptions) => {
    const server = await startTestServer(options);
    owners.push(server);
    return server;
  };
  const startStaged = (owner: TestServer, options?: TestServerOptions) =>
    startTestServer({ sharing: owner, buildDir: staged.buildDir, ...options });
  const connect = async (server: TestServer) => {
    const client = await server.connectDatabase();
    clients.push(client);
    return client;
  };
  /** Whether the staged concurrent index exists and is valid, as one built whole is. */
  const indexBuilt = async (database: pg.Client) =>
    (await database.query<{ valid: boolean }>("SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('shots_staged_idx')")).rows[0]?.valid ?? false;
  /** How many instances hold or wait for the migration lock. */
  const lockConnections = async (database: pg.Client) =>
    (
      await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1",
        [MIGRATION_LOCK_CONNECTION],
      )
    ).rows[0]!.count;
  const hasColumn = async (database: pg.Client, table: string) =>
    (await database.query("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'staged'", [table])).rowCount === 1;

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end()));
    // Each stops the instances sharing its database.
    for (const owner of owners.splice(0)) await owner.stop();
  });

  it("start together and wait for the migration lock however long it is held, where Prisma's own gives up after 10 s, then migrate once", { timeout: 120_000 }, async () => {
    const owner = await start();
    const holder = await connect(owner);
    await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    // Settled together, so neither is still starting when the test ends.
    const instances = Promise.allSettled([1, 2].map(() => startStaged(owner, { readyTimeoutMs: 90_000 })));
    await expect.poll(() => lockConnections(holder)).toBe(2);

    // Prisma takes the same lock, as the latest release's instances do, and gives up after 10 s: this fails if a Prisma upgrade changes the lock.
    const prisma = await runPrisma(owner, serverDir, ["migrate", "deploy"]);
    expect(prisma.code).not.toBe(0);
    expect(prisma.output).toContain(`Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(${MIGRATION_LOCK}))`);
    // Both instances still wait, beyond those 10 s.
    expect(await lockConnections(holder)).toBe(2);

    await holder.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    for (const instance of await instances) {
      if (instance.status === "rejected") throw instance.reason;
      expect(instance.value.output()).toContain("Waiting for another instance's migrations to finish");
    }
    // The first to take the lock migrated, and the other then found nothing to do. It built the concurrent index while
    // the other waited, which a wait holding a snapshot all the while would have failed on its lock_timeout.
    expect(await migrationRecords(owner, COLUMN)).toEqual([{ finished: true, rolledBack: false }]);
    expect(await migrationRecords(owner, INDEX)).toEqual([{ finished: true, rolledBack: false }]);
  });

  it("killed partway through a migration, leave it unfinished, and the next to start records it as rolled back and applies it, the concurrent index one statement at a time", async () => {
    const owner = await start();
    const holder = await connect(owner);
    await holder.query("BEGIN; LOCK TABLE shots IN ACCESS SHARE MODE");
    let crash = async () => {};
    const killed = startStaged(owner, { starting: (kill) => void (crash = kill) });
    killed.catch(() => {});
    // The migration has altered machines, and waits for shots.
    await waitForLockWaits(owner, { relation: "shots" });
    await crash();
    await expect(killed).rejects.toThrow("exited with SIGKILL before it was ready");
    expect(await migrationRecords(owner, COLUMN)).toEqual([{ finished: false, rolledBack: false }]);

    // PostgreSQL rolls the migration back once it finds its connection gone.
    await holder.query("COMMIT");
    const restarted = await startStaged(owner);
    expect(restarted.output()).toContain(`Recorded migration ${COLUMN}, left unfinished by an instance that failed or was killed partway through it, as rolled back`);
    expect(await migrationRecords(owner, COLUMN)).toEqual([{ finished: false, rolledBack: true }, { finished: true, rolledBack: false }]);
    expect(await migrationRecords(owner, INDEX)).toEqual([{ finished: true, rolledBack: false }]);
    // In one transaction, Prisma would have failed it: a transaction refuses CREATE INDEX CONCURRENTLY.
    expect(await indexBuilt(holder)).toBe(true);
  });

  it("stop Prisma's migration and fail on losing the lock's connection alone, as another instance may then take the lock", async () => {
    const owner = await start();
    const holder = await connect(owner);
    await holder.query("BEGIN; LOCK TABLE shots IN ACCESS SHARE MODE");
    const losing = startStaged(owner);
    losing.catch(() => {});
    await waitForLockWaits(owner, { relation: "shots" });
    // As an administrator, or a lost network path, ends that connection and no other.
    await (await connect(owner)).query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1",
      [MIGRATION_LOCK_CONNECTION],
    );
    // Before the migration's own lock_timeout, a minute, could end it.
    await expect(losing).rejects.toThrow("Lost the migration lock's connection while migrating");

    // Left running, Prisma's engine would now take shots and finish the migration without the lock.
    await holder.query("COMMIT");
    await startStaged(owner);
    expect(await migrationRecords(owner, COLUMN)).toEqual([{ finished: false, rolledBack: true }, { finished: true, rolledBack: false }]);
  });

  it("stop Prisma's engine when its CLI dies alone, before recording the migration as rolled back and letting go of the lock", async () => {
    const owner = await start();
    const holder = await connect(owner);
    await holder.query("BEGIN; LOCK TABLE shots IN ACCESS SHARE MODE");
    const failure = startStaged(owner).then(() => "started", (error: Error) => error.message);
    await waitForLockWaits(owner, { relation: "shots" });
    process.kill(migratingProcesses(staged.buildDir).cli, "SIGKILL");
    expect(await failure).toContain(`Database migrations failed (prisma migrate deploy exited with SIGKILL). Recorded ${COLUMN} as rolled back`);

    // Left running, the engine would now take shots and finish the migration without the lock.
    await holder.query("COMMIT");
    await startStaged(owner);
    expect(await migrationRecords(owner, COLUMN)).toEqual([{ finished: false, rolledBack: true }, { finished: true, rolledBack: false }]);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("stop Prisma's CLI and engine with them on %s while migrating, as their own process group doesn't get the signal", async (signal, code) => {
    const owner = await start();
    const holder = await connect(owner);
    await holder.query("BEGIN; LOCK TABLE shots IN ACCESS SHARE MODE");
    const stopped = startStaged(owner).then(() => "started", (error: Error) => error.message);
    await waitForLockWaits(owner, { relation: "shots" });
    process.kill(migratingProcesses(staged.buildDir).server, signal);
    expect(await stopped).toContain(`The server exited with ${code} before it was ready`);

    // Left running, the engine would now take shots and finish the migration without the lock.
    await holder.query("COMMIT");
    await startStaged(owner);
    expect(await migrationRecords(owner, COLUMN)).toEqual([{ finished: false, rolledBack: true }, { finished: true, rolledBack: false }]);
  });

  it("name `migrate resolve --applied` when a migration fails, for one an instance killed after its commit left applied but unfinished", async () => {
    const owner = await start();
    const database = await connect(owner);
    // What such an instance leaves.
    await database.query(`ALTER TABLE machines ADD COLUMN staged INTEGER; ALTER TABLE shots ADD COLUMN staged INTEGER`);
    await database.query("INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES (gen_random_uuid()::text, '', $1)", [COLUMN]);

    const failure = await startStaged(owner).then(() => "started", (error: Error) => error.message);
    expect(failure).toContain(`Recorded ${COLUMN} as rolled back, so the next start applies it again`);
    expect(failure).toContain(`record it by running \`npx prisma migrate resolve --applied ${COLUMN}\` with this release`);
    expect(await migrationRecords(owner, COLUMN)).toEqual([{ finished: false, rolledBack: true }, { finished: false, rolledBack: true }]);

    // What the message says to do, once checked, then starts the next deploy normally.
    const resolve = await runPrisma(owner, path.join(staged.buildDir, "server"), ["migrate", "resolve", "--applied", COLUMN]);
    expect(resolve, resolve.output).toMatchObject({ code: 0 });
    await startStaged(owner);
    expect(await migrationRecords(owner, INDEX)).toEqual([{ finished: true, rolledBack: false }]);
    expect(await indexBuilt(database)).toBe(true);
    expect(await hasColumn(database, "machines")).toBe(true);
  });
});

/**
 * The Prisma CLI running the staged migrations in `buildDir`, the parent of the
 * schema engine reading its schema, and the server that started it.
 */
function migratingProcesses(buildDir: string): { cli: number; server: number } {
  const processes = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command: command! }));
  const engine = processes.find(({ command }) => command.includes("schema-engine") && command.includes(buildDir));
  if (!engine) throw new Error(`No schema engine runs the migrations staged in ${buildDir}`);
  const server = processes.find(({ pid }) => pid === engine.ppid)?.ppid;
  if (!server) throw new Error("The schema engine's Prisma CLI has gone");
  return { cli: engine.ppid, server };
}

/** Runs the checkout's Prisma CLI in `cwd`, which names the migrations through its prisma.config.ts, on the server's database. */
function runPrisma(server: TestServer, cwd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  const databaseUrl = new URL(adminDatabaseUrl());
  databaseUrl.pathname = `/${server.database}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl.href },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output: output.join("") }));
  });
}
