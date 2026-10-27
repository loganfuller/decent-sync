import type { Server } from "node:http";
import { Injectable, type INestApplication, Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { SyncGateway } from "./sync/sync.gateway.js";

/** The signals that stop the server: fly.io's default, Docker's and a terminal's. */
const STOPPING_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Whether this instance is stopping, and the requests it has under way, for
 * the drain `stopOnSignals` runs. Its routing check (`HealthController`)
 * answers 503 once it is stopping.
 */
@Injectable()
export class Drain {
  stopping = false;
  private requests = 0;
  private idle: (() => void) | undefined;

  /**
   * Middleware counting the requests under way. Once stopping, each response
   * closes its connection, so a client's next request opens another, which
   * the proxy can send elsewhere, and no connection is left between
   * requests once those under way finish.
   */
  readonly track = (_req: Request, res: Response, next: NextFunction): void => {
    this.requests++;
    if (this.stopping) res.setHeader("Connection", "close");
    res.once("close", () => {
      if (--this.requests === 0) this.idle?.();
    });
    next();
  };

  /** Resolves once no request is under way. */
  async finished(): Promise<void> {
    while (this.requests > 0) await new Promise<void>((resolve) => (this.idle = resolve));
  }
}

/**
 * Stops the server without failing anyone's request (ADR-0025): on SIGINT,
 * SIGTERM or SIGHUP, rather than through Nest's own shutdown hooks, whose
 * `onModuleDestroy` hooks, Prisma's disconnect among them, run before the
 * HTTP server closes. Once a signal arrives:
 *
 * - the routing check answers 503, and the tablets are handed to another
 *   instance (`SyncGateway.handOver`);
 * - requests that still arrive are answered for the grace
 *   (`DRAIN_GRACE_SECONDS`), until the proxy has noticed;
 * - then the server stops listening, finishes the requests under way, and
 *   shuts Nest down, disconnecting from the database last.
 *
 * A second signal ends the server at once, as no listener is left for it.
 */
export function stopOnSignals(app: INestApplication, config: Config): void {
  const logger = new Logger("DecentSync");
  const stop = async (signal: NodeJS.Signals) => {
    for (const each of STOPPING_SIGNALS) process.off(each, stop);
    logger.log(`Stopping on ${signal}: answering requests for ${config.drainGraceMs / 1000} s more, then finishing those under way`);
    try {
      const drain = app.get(Drain);
      drain.stopping = true;
      // Long-lived streams, such as the Live View's (#258), end here too, at once.
      await Promise.all([app.get(SyncGateway).handOver(), new Promise((resolve) => setTimeout(resolve, config.drainGraceMs))]);
      const server = app.getHttpServer() as Server;
      const closed = new Promise((resolve) => server.close(resolve));
      await drain.finished();
      // A request begun before the drain left its connection open after it; `close` closed only those idle then.
      server.closeIdleConnections();
      await closed;
      await app.close();
    } catch (error) {
      logger.error(`Could not stop cleanly: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exit(1);
    }
    // Ends as the signal would have, with no listener left for it.
    process.kill(process.pid, signal);
  };
  for (const signal of STOPPING_SIGNALS) process.on(signal, stop);
}
