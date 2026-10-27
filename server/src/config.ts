import path from "node:path";
import { fileURLToPath } from "node:url";

// The server's deployment configuration comes only from environment variables,
// so it is the same under Docker, fly.io and a local shell. Settings for each
// Machine's plugin live in Decaid, not here.

export interface Config {
  /** PostgreSQL 14 or newer. */
  databaseUrl: string;
  /** The URL people and plugins use to reach this server. */
  publicUrl: URL;
  host: string;
  port: number;
  /** The built management interface (web/dist). */
  webDistDir: string;
  /** How long a new plugin connection has to send `hello`. */
  helloTimeoutMs: number;
  /** How often plugins send a heartbeat; a connection silent for three intervals is closed. */
  heartbeatIntervalMs: number;
  /**
   * The request header, lower-cased, whose last comma-separated entry, if an
   * IP address, is a sync connection's address instead of its socket's. Set
   * only behind a proxy that sets or overwrites it, as any client can send it.
   */
  clientAddressHeader?: string;
  /**
   * How long a stopping instance still answers requests that arrive, so a
   * proxy's routing check sees it stopping and sends them elsewhere: at least
   * the check's interval plus its timeout (`drain.ts`).
   */
  drainGraceMs: number;
}

/** A reason the server cannot start that its message fully explains. */
export class StartupError extends Error {
  override name = "StartupError";
}

class ConfigError extends StartupError {
  override name = "ConfigError";

  constructor(public readonly problems: string[]) {
    super(
      [
        "Decent Sync cannot start because of its environment variables:",
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
  }
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    problems.push(
      "DATABASE_URL is required: the PostgreSQL connection URL, for example postgresql://decent_sync:password@localhost:5432/decent_sync",
    );
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must start with postgresql:// or postgres://");
  }

  const publicUrl = parsePublicUrl(env.PUBLIC_URL, problems);

  const port = parsePort(env.PORT, problems);
  const helloTimeoutMs = parseSeconds("SYNC_HELLO_TIMEOUT_SECONDS", env.SYNC_HELLO_TIMEOUT_SECONDS, 10, problems);
  const heartbeatIntervalMs = parseSeconds("SYNC_HEARTBEAT_SECONDS", env.SYNC_HEARTBEAT_SECONDS, 30, problems);
  const clientAddressHeader = parseHeaderName("CLIENT_ADDRESS_HEADER", env.CLIENT_ADDRESS_HEADER, problems);
  // fly.io's routing check every 10 s, with a timeout of 5 s.
  const drainGraceMs = parseSeconds("DRAIN_GRACE_SECONDS", env.DRAIN_GRACE_SECONDS, 15, problems, { zero: true });

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    databaseUrl,
    publicUrl: publicUrl!,
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    webDistDir: path.resolve(env.WEB_DIST_DIR?.trim() || path.join(serverDir, "../web/dist")),
    helloTimeoutMs,
    heartbeatIntervalMs,
    clientAddressHeader,
    drainGraceMs,
  };
}

function parsePublicUrl(value: string | undefined, problems: string[]): URL | undefined {
  const raw = value?.trim() ?? "";
  if (!raw) {
    problems.push(
      "PUBLIC_URL is required: the http:// or https:// address people and plugins use to reach this server, for example https://sync.example.com",
    );
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`PUBLIC_URL is not a valid URL: ${raw}`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    problems.push(`PUBLIC_URL must start with http:// or https://, not ${url.protocol}//`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    problems.push("PUBLIC_URL must be an origin only, with no path, query or credentials");
  }
  return url;
}

function parsePort(value: string | undefined, problems: string[]): number {
  const raw = value?.trim();
  if (!raw) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be a whole number from 1 to 65535, not ${raw}`);
  }
  return port;
}

/** A positive number of seconds, or with `zero` also 0, possibly fractional, in milliseconds. */
function parseSeconds(
  name: string,
  value: string | undefined,
  defaultSeconds: number,
  problems: string[],
  { zero = false }: { zero?: boolean } = {},
): number {
  const raw = value?.trim();
  if (!raw) return defaultSeconds * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0 || (seconds === 0 && !zero)) {
    problems.push(`${name} must be a ${zero ? "non-negative" : "positive"} number of seconds, not ${raw}`);
  }
  return Math.round(seconds * 1000);
}

/** An HTTP header name (a token, RFC 9110), lower-cased, or undefined when blank. */
function parseHeaderName(name: string, value: string | undefined, problems: string[]): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(raw)) {
    problems.push(`${name} must be an HTTP header name, such as X-Forwarded-For or X-Real-IP, not ${raw}`);
  }
  return raw.toLowerCase();
}
