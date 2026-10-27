// Runs the latest release's Vitest suite on databases with this checkout's
// schema, as CI's `latest release's vitest` jobs do, so a migration the
// running release would break on fails before it merges (ADR-0025). It
// migrates a PostgreSQL server's template1 with this checkout's migrations,
// so every database the suite creates there is a copy its server finds
// nothing to migrate in, then runs the suite in the latest release's build
// (`npm run build:latest-release`). It leaves out the release's
// server/test/latest-release/, as CI's shards of this checkout's suite do:
// those tests run a release beside the one before it, and read the tags from
// a git checkout, which that build is not.
//
// The PostgreSQL is a throwaway container of its own, removed afterwards,
// never the development database's or the shared test database's: every
// database created on a server copies its template1. In CI, `--database-url`
// names the job's own PostgreSQL instead; it is refused outside CI.
//
// Usage: node scripts/latest-release-suite.mjs [--database-url <url>] [Vitest options, such as --shard=1/4]
//   (npm run test:latest-release-suite -- [options])

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";
import { repoDir } from "../server/test/support/build-table.mjs";
import { latestReleaseDir, latestReleaseTag } from "../server/test/support/latest-release.mjs";

const IMAGE = "postgres:17";
const readyWithinMs = 60_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const urlAt = args.findIndex((arg) => arg === "--database-url" || arg.startsWith("--database-url="));
let givenUrl;
if (urlAt !== -1) {
  const [arg] = args.splice(urlAt, 1);
  givenUrl = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args.splice(urlAt, 1)[0];
  if (!givenUrl) fail("--database-url needs a URL.");
  if (!process.env.CI) {
    fail("--database-url is for CI's own PostgreSQL: this migrates its template1, which every database created there copies. Run without it to use a throwaway container.");
  }
}

let releaseDir;
try {
  releaseDir = latestReleaseDir();
} catch (error) {
  fail(error.message);
}
const tag = latestReleaseTag();

let container;
let vitest;
const removeContainer = () => {
  if (container === undefined) return;
  try {
    execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  } catch {
    console.warn(`Could not remove the container ${container}; remove it with \`docker rm --force ${container}\`.`);
  }
  container = undefined;
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    vitest?.kill(signal);
    removeContainer();
    process.exit(1);
  });
}

let code;
try {
  const url = givenUrl ?? (await startPostgres());
  await migrateTemplate1(url);
  code = await runSuite(url);
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  removeContainer();
}
process.exit(code);

/**
 * Starts PostgreSQL in a throwaway container, its data in memory, published
 * on a free port of the loopback address, and resolves with its URL once it
 * takes connections there.
 */
async function startPostgres() {
  const name = `decent-sync-latest-release-suite-${process.pid}`;
  console.log(`Starting ${IMAGE} in the container ${name}, removed afterwards.`);
  docker(
    "run", "--detach", "--rm", "--name", name,
    "--tmpfs", "/var/lib/postgresql/data",
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER=decent_sync", "--env", "POSTGRES_PASSWORD=decent_sync", "--env", "POSTGRES_DB=decent_sync",
    IMAGE,
    "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=300",
  );
  container = name;
  const port = docker("port", name, "5432/tcp").split("\n")[0].split(":").at(-1);
  const url = `postgresql://decent_sync:decent_sync@127.0.0.1:${port}/decent_sync`;
  // On its first start, the image sets the cluster up on a server listening
  // only on its Unix socket, which a check over the socket would count as ready.
  const deadline = Date.now() + readyWithinMs;
  for (;;) {
    try {
      docker("exec", name, "pg_isready", "--quiet", "--host", "127.0.0.1", "--username", "decent_sync", "--dbname", "decent_sync");
      // A published port may still refuse connections just after the server is ready.
      await withClient(url, () => {});
      return url;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`PostgreSQL in ${name} was not ready within ${readyWithinMs / 1000} s`, { cause: error });
      await pause();
    }
  }
}

/**
 * Migrates the server's template1 with this checkout's migrations, through
 * Prisma's `migrate deploy` as the server runs it, and waits until nothing is
 * connected to it: PostgreSQL refuses to copy a database others are using.
 */
async function migrateTemplate1(url) {
  const template1 = new URL(url);
  template1.pathname = "/template1";
  console.log(`Migrating template1 with the migrations of ${repoDir}.`);
  const prisma = createRequire(path.join(repoDir, "server/package.json")).resolve("prisma/build/index.js");
  await run(process.execPath, [prisma, "migrate", "deploy"], {
    cwd: path.join(repoDir, "server"),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: template1.href },
  }).then((exit) => {
    if (exit !== 0) throw new Error(`Migrating template1 failed (exit ${exit})`);
  });
  await withClient(url, async (client) => {
    const deadline = Date.now() + readyWithinMs;
    for (;;) {
      const { rows: [{ sessions }] } = await client.query("SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = 'template1'");
      if (sessions === 0) return;
      if (Date.now() > deadline) throw new Error(`${sessions} sessions stayed connected to template1`);
      await pause();
    }
  });
}

/** Runs the latest release's Vitest suite with its test databases on the server, resolving with its exit code. */
async function runSuite(url) {
  console.log(`Running the Vitest suite of ${tag}, built in ${releaseDir}, but server/test/latest-release/.`);
  // The variables npm sets for a script it runs describe this checkout, not the release's.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("npm_") && name !== "INIT_CWD"));
  return run(
    process.execPath,
    [path.join(releaseDir, "node_modules/vitest/vitest.mjs"), "run", "--exclude", "server/test/latest-release/**", ...args],
    { cwd: releaseDir, env: { ...env, TEST_DATABASE_URL: url, DATABASE_URL: url } },
    (child) => void (vitest = child),
  );
}

/** Runs a command, its output shown, resolving with its exit code. */
function run(command, commandArgs, options, started) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "inherit", "inherit"], ...options });
    started?.(child);
    child.once("error", reject);
    child.once("exit", (exit, signal) => resolve(exit ?? (signal ? 1 : 0)));
  });
}

function docker(...dockerArgs) {
  return execFileSync("docker", dockerArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function withClient(url, use) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return await use(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}
