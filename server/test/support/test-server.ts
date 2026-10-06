import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

// Runs the built server (`npm run build` first) as a self-hoster does, on its
// own fresh PostgreSQL database, so each test file starts from an empty
// server. DATABASE_URL, from the environment or the repo's .env, names the
// PostgreSQL server to create test databases on; its user needs CREATEDB, and
// CREATEROLE for `notOwner`.

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const main = path.join(repoDir, "server/dist/main.js");
const clockOffset = path.join(repoDir, "server/test/support/clock-offset.mjs");

export interface TestServer {
  /** The server's origin, for example http://127.0.0.1:41234. */
  url: string;
  /** The test database it uses. */
  database: string;
  /** Everything the server has written to stdout and stderr so far. */
  output(): string;
  /** Shuts the server down as a self-hoster's stop does, then drops its database unless it shares another's. */
  stop(): Promise<void>;
  /** Kills the server without letting it shut down, as a crash does. */
  kill(): Promise<void>;
  /**
   * A client of its database, for changes the server is not told about, or
   * locks held while it works. The caller ends it.
   */
  connectDatabase(): Promise<pg.Client>;
}

export interface TestServerOptions {
  /** PUBLIC_URL for the server; defaults to the address it listens on. */
  publicUrl?: string;
  /** Further environment variables, such as SYNC_HELLO_TIMEOUT_SECONDS. */
  env?: Record<string, string>;
  /** Runs another instance on this server's database instead of a fresh one, as a horizontally scaled deployment does. */
  sharing?: TestServer;
  /** Runs the server with its clock this far ahead of real time (behind if negative), as on a drifting host. */
  clockOffsetMs?: number;
  /** Connects the server to PostgreSQL through this host and port, such as a pooler's. */
  databaseHost?: string;
  /**
   * Runs the server, on a fresh database, as a role of its own that does not
   * own that database, as a host may give it. The role may create in the
   * public schema, as migrating needs, and is dropped with the database.
   */
  notOwner?: boolean;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  // The role's grant would outlive it on a shared database, which stays, so the role could not be dropped.
  if (options.notOwner && options.sharing) throw new Error("notOwner needs a fresh database; it cannot be combined with sharing");
  const baseUrl = adminDatabaseUrl();
  const database = options.sharing?.database ?? `decent_sync_test_${randomBytes(6).toString("hex")}`;
  const role = options.notOwner ? `decent_sync_test_${randomBytes(6).toString("hex")}` : undefined;
  /** Drops the server's database, unless it shares another's, and its role. */
  const drop = async () => {
    if (!options.sharing) await withClient(baseUrl, (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
    if (role) await withClient(baseUrl, (client) => client.query(`DROP ROLE IF EXISTS "${role}"`));
  };

  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${database}`;
  const serverDatabaseUrl = new URL(databaseUrl);
  if (options.databaseHost) serverDatabaseUrl.host = options.databaseHost;
  try {
    if (!options.sharing) await withClient(baseUrl, (client) => client.query(`CREATE DATABASE "${database}"`));
    if (role) {
      const password = randomBytes(16).toString("hex");
      await withClient(baseUrl, (client) => client.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`));
      // From PostgreSQL 15, only the database's owner may create there by default.
      await withClient(databaseUrl.href, (client) => client.query(`GRANT CREATE ON SCHEMA public TO "${role}"`));
      serverDatabaseUrl.username = role;
      serverDatabaseUrl.password = password;
    }
  } catch (error) {
    // Report the failure, not a failure to clean up after it.
    await drop().catch(() => {});
    throw error;
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const output: string[] = [];
  const child = spawn(process.execPath, [main], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: serverDatabaseUrl.href,
      PUBLIC_URL: options.publicUrl ?? url,
      HOST: "127.0.0.1",
      PORT: String(port),
      ...options.env,
      ...(options.clockOffsetMs === undefined
        ? {}
        : {
            NODE_OPTIONS: [options.env?.NODE_OPTIONS, `--import=${pathToFileURL(clockOffset).href}`].filter(Boolean).join(" "),
            TEST_CLOCK_OFFSET_MS: String(options.clockOffsetMs),
          }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const stop = async () => {
    await terminate(child);
    await drop();
  };
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  };

  try {
    await waitForHealth(url, child, output);
  } catch (error) {
    await stop();
    throw error;
  }
  const connectDatabase = async () => {
    const client = new pg.Client({ connectionString: databaseUrl.href });
    await client.connect();
    return client;
  };
  return { url, database, output: () => output.join(""), stop, kill, connectDatabase };
}

/** DATABASE_URL, naming the PostgreSQL server tests create their databases on. */
export function adminDatabaseUrl(): string {
  const envFile = path.join(repoDir, ".env");
  if (!process.env.DATABASE_URL && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Server tests need DATABASE_URL (see .env.example) naming a PostgreSQL 14+ server; run npm run db:up");
  }
  return url;
}

async function withClient<T>(connectionString: string, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The server exited with ${child.exitCode} before it was ready:\n${output.join("")}`);
    }
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server was not ready within 30 seconds:\n${output.join("")}`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}
