import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import pg from "pg";
import { assertBuilt } from "./builds.js";
import { latestReleaseDir } from "./latest-release.mjs";
import { watchLog, watchSecrets } from "./secrets.js";

// Runs the built server (`npm run build` first) as a self-hoster does, on its
// own fresh PostgreSQL database, so each test file starts from an empty
// server. TEST_DATABASE_URL, or else DATABASE_URL, from the environment or the
// repo's .env, names the PostgreSQL server to create test databases on
// (`adminDatabaseUrl()`); its user needs CREATEDB, and CREATEROLE for
// `notOwner`. The server under test gets its own database as DATABASE_URL.
// With `latestRelease` it runs the latest release's server instead.

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const clockOffset = path.join(repoDir, "server/test/support/clock-offset.mjs");
const secretCapture = path.join(repoDir, "server/test/support/secret-capture.mjs");
const passwordHashGate = path.join(repoDir, "server/test/support/password-hash-gate.mjs");

export interface TestServer {
  /** The server's origin, for example http://127.0.0.1:41234. */
  url: string;
  /** The test database it uses. */
  database: string;
  /** The tree whose built server it runs: the checkout, or with `latestRelease` the latest release's build. */
  buildDir: string;
  /** Everything the server has written to stdout and stderr so far. */
  output(): string;
  /**
   * Shuts the server down as a self-hoster's stop does. The server that owns
   * its database also stops every instance sharing it, all at once, and drops
   * the database once all of them have exited. A sharer's stop stops only
   * that sharer. Calling it again, or while it runs, does no harm.
   */
  stop(): Promise<void>;
  /**
   * Kills the server without letting it shut down, with every process it
   * started, such as Prisma's while it migrates, as its host crashing does.
   */
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
  /**
   * Runs another instance on this server's database instead of a fresh one,
   * as a horizontally scaled deployment does. The server that owns the
   * database stops it too, before dropping the database, so a test need not
   * stop it first.
   */
  sharing?: TestServer;
  /** Runs the server with its clock this far ahead of real time (behind if negative), as on a drifting host. */
  clockOffsetMs?: number;
  /**
   * A file path: while that file exists, every password hash the server
   * starts waits, and its output reports each hash started and finished as
   * `[password hash] started, <n> running`.
   */
  passwordHashGate?: string;
  /** Connects the server to PostgreSQL through this host and port, such as a pooler's. */
  databaseHost?: string;
  /**
   * Runs the server, on a fresh database, as a role of its own that does not
   * own that database, as a host may give it. The role may create in the
   * public schema, as migrating needs, and is dropped with the database.
   */
  notOwner?: boolean;
  /**
   * Runs the latest release's server, built from its tag by `npm run
   * build:latest-release` (latest-release.mjs), rather than the change's, as
   * an instance of the previous release runs during an upgrade (ADR-0025).
   * It migrates its database with its own migrations, so with `sharing` it
   * runs beside the change's server on a database the change migrated, or
   * the other way round.
   */
  latestRelease?: boolean;
  /** Runs the server built in this tree instead, such as a copy with migrations staged (`stageMigrations`). */
  buildDir?: string;
  /** Called once the server process starts, before it is ready, with its `kill`, to crash it partway through starting. */
  starting?: (kill: () => Promise<void>) => void;
  /** How long it may take to listen, such as while it waits for the migration lock. Defaults to 30 s. */
  readyTimeoutMs?: number;
}

/**
 * The halts of the instances sharing each test database, keyed by its owner
 * and by each of them: the owner's stop runs them all with its own before
 * dropping the database, so none is cut off from it while shutting down.
 */
const sharerHalts = new WeakMap<TestServer, (() => Promise<void>)[]>();
/** The halts of databases whose owner has begun to stop: an instance sharing one that is ready only after then stops at once. */
const stoppedHalts = new WeakSet<(() => Promise<void>)[]>();

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  if (!options.latestRelease) assertBuilt("protocol", "server");
  const buildDir = options.buildDir ?? (options.latestRelease ? latestReleaseDir() : repoDir);
  const main = path.join(buildDir, "server/dist/main.js");
  // The role's grant would outlive it on a shared database, which stays, so the role could not be dropped.
  if (options.notOwner && options.sharing) throw new Error("notOwner needs a fresh database; it cannot be combined with sharing");
  // Its owner must know of it, to stop it before dropping the database.
  const halts = options.sharing && sharerHalts.get(options.sharing);
  if (options.sharing && !halts) throw new Error("sharing names a server that startTestServer did not start");
  const baseUrl = adminDatabaseUrl();
  const database = options.sharing?.database ?? testDatabaseName();
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
  // Each secret the server hands out, recorded by secret-capture.mjs, read from its file until it stops.
  const secretsFile = path.join(os.tmpdir(), `decent-sync-secrets-${randomBytes(6).toString("hex")}`);
  let handedOut: string[] | undefined;
  const readHandedOut = () => handedOut ?? (fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile, "utf8").split("\n").filter(Boolean) : []);
  watchSecrets(readHandedOut);
  const preloads = [
    secretCapture,
    ...(options.clockOffsetMs === undefined ? [] : [clockOffset]),
    ...(options.passwordHashGate === undefined ? [] : [passwordHashGate]),
  ];
  const spawnServer = (port: number) => {
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
        NODE_OPTIONS: [options.env?.NODE_OPTIONS, ...preloads.map((preload) => `--import=${pathToFileURL(preload).href}`)].filter(Boolean).join(" "),
        TEST_SECRETS_FILE: secretsFile,
        ...(options.clockOffsetMs === undefined ? {} : { TEST_CLOCK_OFFSET_MS: String(options.clockOffsetMs) }),
        ...(options.passwordHashGate === undefined ? {} : { TEST_PASSWORD_HASH_GATE: options.passwordHashGate }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    watchLog(`the log of the server at ${url}`, () => output.join(""));
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    // Closed once it has exited and all it wrote has been read.
    let closed = false;
    child.once("close", () => { closed = true; });
    return { url, port, child, output, closed: () => closed };
  };

  // A port found free may be taken by another test file's server before this one binds it, which takes seconds,
  // so the server is started again on another port if it finds its port taken.
  let started = spawnServer(await freePort());
  // Shuts this instance down, once, however many stops ask for it.
  let halting: Promise<void> | undefined;
  const halt = () =>
    (halting ??= (async () => {
      await terminate(started.child);
      handedOut = readHandedOut();
      fs.rmSync(secretsFile, { force: true });
    })());
  // The halts of the instances sharing this one's database, if it owns it.
  const sharers: (() => Promise<void>)[] = [];
  const stop = async () => {
    if (options.sharing) return halt();
    stoppedHalts.add(sharers);
    await Promise.all([halt(), ...sharers.map((sharerHalt) => sharerHalt())]);
    await drop();
  };
  const kill = async () => {
    const { child } = started;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    killTree(child.pid!);
    await exited;
  };
  options.starting?.(kill);

  for (let attempt = 1; ; attempt++) {
    try {
      await waitForListening(started, options.readyTimeoutMs);
      break;
    } catch (error) {
      if (error instanceof PortTaken && attempt < 5) {
        started = spawnServer(await freePort());
        continue;
      }
      await stop();
      throw error;
    }
  }
  const { url, output } = started;
  const connectDatabase = async () => {
    const client = new pg.Client({ connectionString: databaseUrl.href });
    await client.connect();
    return client;
  };
  const server: TestServer = { url, database, buildDir, output: () => output.join(""), stop, kill, connectDatabase };
  // Only once it has started: a start that fails has stopped itself.
  if (halts && stoppedHalts.has(halts)) {
    await halt();
    throw new Error("The server's owner stopped while it was starting, so it has stopped too");
  }
  if (halts) halts.push(halt);
  sharerHalts.set(server, halts || sharers);
  return server;
}

/**
 * The warnings the server logged on ignoring a Shot or Steam Record from the
 * named Machine, in the order logged, each without the logger's prefix or colors.
 * A line a record's id forged would be one too, whatever characters it held.
 */
export function ignoredRecordWarnings(server: TestServer, machineName: string): string[] {
  return stripVTControlCharacters(server.output()).split("\n").flatMap((line) => {
    const warning = /\bWARN \[Sync\] (Ignored .*)$/s.exec(line)?.[1];
    return warning?.includes(` from Machine ${machineName} (`) ? [warning] : [];
  });
}

/**
 * TEST_DATABASE_URL, or else DATABASE_URL, naming the PostgreSQL server tests
 * create their databases on. Either may be in the repo's .env, which does not
 * override the environment.
 */
export function adminDatabaseUrl(): string {
  const envFile = path.join(repoDir, ".env");
  if ((!process.env.TEST_DATABASE_URL || !process.env.DATABASE_URL) && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Server tests need TEST_DATABASE_URL or DATABASE_URL (see .env.example) naming a PostgreSQL 14+ server; run npm run db:test, or npm run db:up",
    );
  }
  return url;
}

/**
 * A new test database's name, `decent_sync_test_<unix seconds>_<12 hex>`. The
 * time lets `npm run db:test` drop the databases killed runs left behind.
 */
export function testDatabaseName(): string {
  return `decent_sync_test_${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString("hex")}`;
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

/** The server could not bind its port, which something else took after `freePort` found it free. */
class PortTaken extends Error {}

/**
 * Resolves once the server has logged that it listens on its port, which it
 * does only once it has bound it, so the address then reaches this server
 * and no other. A server already on that port, such as another test file's,
 * would answer a health check there, and the test would run against it.
 */
async function waitForListening(
  { port, child, output, closed }: { port: number; child: ChildProcess; output: string[]; closed: () => boolean },
  timeoutMs = 30_000,
): Promise<void> {
  const listening = new RegExp(`\\bListening on 127\\.0\\.0\\.1:${port};`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = stripVTControlCharacters(output.join(""));
    if (listening.test(log)) return;
    if (closed()) {
      if (/\bEADDRINUSE\b/.test(log)) throw new PortTaken(`Port ${port} was taken before the server could listen on it`);
      throw new Error(`The server exited with ${child.exitCode ?? child.signalCode} before it was ready:\n${output.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The server was not ready within ${timeoutMs / 1000} seconds:\n${output.join("")}`);
}

/**
 * Kills a process and every process it started, at once, as its host crashing
 * does. Killed alone, the server would leave Prisma's CLI, and the schema
 * engine it runs, to finish a migration.
 */
function killTree(pid: number): void {
  const children = new Map<number, number[]>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    children.set(parent!, [...(children.get(parent!) ?? []), child!]);
  }
  const tree = [pid];
  for (const each of tree) tree.push(...(children.get(each) ?? []));
  for (const each of tree) {
    try {
      process.kill(each, "SIGKILL");
    } catch {
      // It has exited already.
    }
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}
