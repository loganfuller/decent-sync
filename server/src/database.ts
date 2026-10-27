import { type ArgumentsHost, Catch, Logger, ServiceUnavailableException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import pg from "pg";
import { Prisma } from "./generated/prisma/client.js";

// How the server's connections to PostgreSQL notice that the database has
// gone away, as in a failover to the replica, so requests fail quickly and
// the server takes traffic again once it is back, without a restart
// (ADR-0025). The timeouts are set on the client: the server's connections
// send no settings at startup, which a pooler may refuse (ADR-0016).

/**
 * How long opening a connection may take, its sign-in included, before it
 * fails. For Prisma's pool, also how long a query waits for a free
 * connection.
 */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * How long a statement of Prisma's pool may run before it fails as though
 * its connection were lost, as it may have been: a query sent to a database
 * that vanished without closing the connection gets no answer, and TCP
 * keepalive probes only idle connections. It sits above the longest
 * statements, such as those crediting a Machine's long history again after a
 * change of its Location History, which took up to 15 s together for 250,000
 * Shots and as many Steam Records on the development database
 * (`CREDITING_TRANSACTION`), and the batches of the curves refresh and the
 * delivery id cleanup.
 */
export const QUERY_TIMEOUT_MS = 30_000;

/**
 * How long a connection sits idle before TCP keepalive probes it. Node then
 * probes it every second and gives up after 10 unanswered (Node 24.22 on
 * Linux, libuv 1.52), so a connection to a database that vanished without
 * closing it fails some 20 s after it was last used. Keepalive sees only
 * the first hop: a connection through a pooler or proxy that stays up is
 * left to its query timeout.
 */
const KEEPALIVE_DELAY_MS = 10_000;

const CONNECTION = {
  keepAlive: true,
  keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
} as const satisfies pg.ClientConfig;

/** The message pg gives a query that outlasted `query_timeout`. */
const QUERY_TIMED_OUT = "Query read timeout";

/**
 * A connection of Prisma's pool that ends itself once a query outlasts its
 * `query_timeout`. pg gives up on the query but keeps the connection, still
 * awaiting the answer, and Prisma hands a transaction's connection back to
 * the pool as though nothing had happened. The next query on it would wait
 * behind the lost one, or, once that answer came, run inside the
 * transaction it had left open. Ended, it fails at once whatever was queued
 * on it, such as Prisma's `ROLLBACK`, and the pool replaces it.
 */
class TimingOutClient extends pg.Client {
  // pg-pool calls it with a callback, and Prisma's adapter for a promise.
  override query(...args: any[]): any {
    const last = args.length - 1;
    const callback: unknown = args[last];
    if (typeof callback === "function") {
      args[last] = (error: unknown, ...results: unknown[]) => {
        this.endIfTimedOut(error);
        return callback(error, ...results);
      };
      return (super.query as (...args: unknown[]) => unknown)(...args);
    }
    const result: unknown = (super.query as (...args: unknown[]) => unknown)(...args);
    if (result instanceof Promise) result.catch((error: unknown) => this.endIfTimedOut(error));
    return result;
  }

  private endIfTimedOut(error: unknown): void {
    if (error instanceof Error && error.message === QUERY_TIMED_OUT) this.end().catch(() => {});
  }
}

/** Prisma's pool, of pg's default of up to 10 connections; `queryTimeoutMs` is for tests of the timeout itself. */
export function poolConfig(databaseUrl: string, queryTimeoutMs = QUERY_TIMEOUT_MS): pg.PoolConfig {
  return { connectionString: databaseUrl, ...CONNECTION, query_timeout: queryTimeoutMs, Client: TimingOutClient };
}

/** The notifications listener's connection, whose statements, `LISTEN` and its checks, take no time, so they time out with a connection. */
export function listenerConfig(databaseUrl: string): pg.ClientConfig {
  return { connectionString: databaseUrl, ...CONNECTION, query_timeout: CONNECT_TIMEOUT_MS };
}

/**
 * What Prisma's driver adapter calls a database it could not reach, a
 * connection lost or timed out, and PostgreSQL refusing more connections
 * (its `DriverAdapterError` kinds).
 */
const UNREACHABLE_KINDS = new Set(["DatabaseNotReachable", "ConnectionClosed", "SocketTimeout", "TooManyConnections"]);

/**
 * PostgreSQL's errors (SQLSTATE) for a server going away or not taking
 * connections: class 08's connection exceptions, but for 08P01, a protocol
 * violation, which the request's own query causes, as with too few values
 * bound; 57P01 to 57P03 (shut down by an administrator or a crash, or not
 * yet accepting connections, as while it starts or is promoted); and 53300
 * (too many connections).
 */
const UNREACHABLE_STATES = new Set(["08000", "08001", "08003", "08004", "08006", "08007", "57P01", "57P02", "57P03", "53300"]);

/**
 * Node's socket errors for a host refusing, unreachable or gone, or a
 * connection reset, which Prisma's driver adapter leaves for Prisma to pass
 * on with the code it carries, as a write to a connection already reset
 * fails with EPIPE.
 */
const SOCKET_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * pg's own errors for a query that timed out, a connection not opened in
 * time or none free in time, and one lost or already lost, which Prisma
 * passes on as they are.
 */
const UNREACHABLE_MESSAGES = new Set([
  QUERY_TIMED_OUT,
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "Connection terminated unexpectedly",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
]);

/**
 * Whether a request failed because the database could not be reached, or
 * dropped its connection, rather than for anything the request did: such a
 * request answers 503 (`DatabaseUnreachableFilter`), and the same request
 * may succeed once the database is back. Prisma's own timeout for a free
 * connection to start a transaction on (`maxWait`) counts too. Nothing here
 * is a failure that would repeat for the same delivery (`repeatingFailure`).
 */
export function databaseUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && SOCKET_ERRORS.has(code)) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2028") return error.message.includes("Unable to start a transaction in the given time");
    const cause = (error.meta?.driverAdapterError as { cause?: { kind?: unknown; originalCode?: unknown } } | undefined)?.cause;
    if (typeof cause?.kind === "string" && UNREACHABLE_KINDS.has(cause.kind)) return true;
    return typeof cause?.originalCode === "string" && UNREACHABLE_STATES.has(cause.originalCode);
  }
  return UNREACHABLE_MESSAGES.has(error.message);
}

/**
 * Answers a request that failed as the database could not be reached
 * (`databaseUnreachable`), in a guard or a handler, with 503 rather than 500,
 * and logs why without the request's path, which may hold an invite's or a
 * reset link's secret. Anything else goes on as Nest would send it. The root
 * module provides it, so Nest tries it after every other global filter,
 * such as `RetryAfterFilter`, which catch exceptions of their own.
 */
@Catch()
export class DatabaseUnreachableFilter extends BaseExceptionFilter {
  private readonly logger = new Logger("Database");

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!databaseUnreachable(exception)) return super.catch(exception, host);
    // Prisma's message ends with the driver's.
    this.logger.warn(`Answered a request with 503: the database is unreachable (${(exception as Error).message.trim().split("\n").at(-1)})`);
    super.catch(new ServiceUnavailableException("The database can't be reached right now. Try again in a moment."), host);
  }
}
