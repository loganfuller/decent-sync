// Makes sure the shared test PostgreSQL, the decent-sync-test-db container, is
// running, then drops the test databases killed runs left on it. Tests use it
// when TEST_DATABASE_URL names it (server/test/support/test-server.ts).
//
// Every worktree's runs share the container, so this never stops, removes or
// recreates it, and never changes its flags: a run elsewhere may be using it.
// Change its flags by hand, while nothing uses it. Two copies may run at once.
// It never connects to DATABASE_URL's server, which holds development data.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const container = "decent-sync-test-db";
const defaultUrl = "postgresql://decent_sync:decent_sync@localhost:55432/decent_sync";
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** How old a test database must be, by the time in its name, before it is dropped. */
const maxAgeMs = 2 * 60 * 60 * 1000;
const readyWithinMs = 60_000;

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** The container's state, such as `running` or `exited`, or undefined when there is none. */
function state() {
  try {
    return docker("container", "inspect", "--format", "{{.State.Status}}", container);
  } catch (error) {
    if (/no such (container|object)/i.test(String(error.stderr))) return undefined;
    throw error;
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

const initial = state();
if (initial === undefined) {
  try {
    // No --rm, so that a stopped container is kept to be started again. Its
    // data is on a tmpfs, so each start begins with a fresh cluster. Published
    // on every interface of the Docker host, so an address reaching the host
    // directly works, not just localhost.
    docker(
      "run", "-d", "--name", container,
      "--tmpfs", "/var/lib/postgresql/data",
      "-p", "55432:5432",
      "-e", "POSTGRES_USER=decent_sync", "-e", "POSTGRES_PASSWORD=decent_sync", "-e", "POSTGRES_DB=decent_sync",
      "postgres:17",
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=600",
    );
    console.log(`Created and started ${container}.`);
  } catch (error) {
    // Another copy of this script took the name first.
    if (!/is already in use/.test(String(error.stderr))) throw error;
    console.log(`${container} was created by another run meanwhile.`);
  }
} else if (initial === "running") {
  console.log(`${container} is running; left as it is.`);
}
// A container another run is creating can be missing for a moment after its
// name is taken, and then not yet started. Starting one already running does
// nothing.
const startBy = Date.now() + readyWithinMs;
for (;;) {
  const current = state();
  if (current === "running") break;
  try {
    if (current === undefined) throw new Error(`${container} is not there`);
    docker("start", container);
    if (initial !== undefined) console.log(`Started ${container}, which was ${initial}; it starts with an empty cluster.`);
    break;
  } catch (error) {
    if (Date.now() > startBy) throw new Error(`Could not start ${container}`, { cause: error });
    await pause();
  }
}

// On its first start, the image sets the cluster up on a server listening
// only on its Unix socket, which a check over the socket would count as ready.
const deadline = Date.now() + readyWithinMs;
for (;;) {
  try {
    docker("exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "decent_sync", "-d", "decent_sync");
    break;
  } catch (error) {
    if (Date.now() > deadline) throw new Error(`${container} was not ready over TCP within ${readyWithinMs / 1000} s`, { cause: error });
    await pause();
  }
}

const envFile = path.join(repoDir, ".env");
if (!process.env.TEST_DATABASE_URL && fs.existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.TEST_DATABASE_URL || defaultUrl;
const development = process.env.DATABASE_URL && new URL(process.env.DATABASE_URL);
const target = new URL(url);
if (development && development.hostname === target.hostname && development.port === target.port) {
  throw new Error(`TEST_DATABASE_URL names DATABASE_URL's server (${target.host}), which holds development data: point it at ${container} on port 55432`);
}

// A forwarded port may still be refusing connections just after the server is ready.
const client = await (async () => {
  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      if (Date.now() > deadline) throw new Error(`Could not connect to ${target.host}`, { cause: error });
      await pause();
    }
  }
})();
try {
  // Test databases are named decent_sync_test_<unix seconds>_<hex> (testDatabaseName() in
  // server/test/support/test-server.ts). One over 2 hours old that no session is using was
  // left by a run that was killed. A plain DROP refuses one a session connected to meanwhile.
  const { rows } = await client.query(
    `SELECT datname FROM pg_database
     WHERE datname ~ '^decent_sync_test_[0-9]+_[0-9a-f]+$'
       AND datname NOT IN (SELECT datname FROM pg_stat_activity WHERE datname IS NOT NULL)
     ORDER BY datname`,
  );
  const old = rows.map((row) => row.datname).filter((name) => Number(name.split("_")[3]) * 1000 < Date.now() - maxAgeMs);
  const dropped = [];
  for (const name of old) {
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      dropped.push(name);
    } catch (error) {
      // 55006: a session connected to it after the query above.
      if (error.code !== "55006") throw error;
      console.log(`Kept ${name}: a session connected to it.`);
    }
  }
  console.log(dropped.length === 0 ? "No test databases over 2 hours old to drop." : `Dropped ${dropped.length} test databases over 2 hours old with no sessions: ${dropped.join(", ")}`);
} finally {
  await client.end();
}

console.log(
  process.env.TEST_DATABASE_URL
    ? `Tests use TEST_DATABASE_URL, ${url}.`
    : `Set TEST_DATABASE_URL=${url} in .env, or an address reaching the container directly (.env.example).`,
);
