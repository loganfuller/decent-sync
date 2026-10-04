import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Runs the built server (`npm run build` first) as a self-hoster does, on its
// own fresh PostgreSQL database, so each test file starts from an empty
// server. DATABASE_URL, from the environment or the repo's .env, names the
// PostgreSQL server to create test databases on; its user needs CREATEDB.

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const main = path.join(repoDir, "server/dist/main.js");

export interface TestServer {
  /** The server's origin, for example http://127.0.0.1:41234. */
  url: string;
  stop(): Promise<void>;
}

export interface TestServerOptions {
  /** PUBLIC_URL for the server; defaults to the address it listens on. */
  publicUrl?: string;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const baseUrl = adminDatabaseUrl();
  const database = `decent_sync_test_${randomBytes(6).toString("hex")}`;
  await withClient(baseUrl, (client) => client.query(`CREATE DATABASE "${database}"`));

  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${database}`;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const output: string[] = [];
  const child = spawn(process.execPath, [main], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: databaseUrl.href,
      PUBLIC_URL: options.publicUrl ?? url,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const stop = async () => {
    await terminate(child);
    await withClient(baseUrl, (client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
  };

  try {
    await waitForHealth(url, child, output);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, stop };
}

function adminDatabaseUrl(): string {
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
