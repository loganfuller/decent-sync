import type { Server } from "node:http";
import { type CallHandler, type ExecutionContext, Injectable, type INestApplication, Logger, type NestInterceptor } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { type Observable, finalize } from "rxjs";
import type { Config } from "./config.js";
import { LiveViews } from "./live-view/live-views.js";
import { SyncGateway } from "./sync/sync.gateway.js";

/** The signals that stop the server: fly.io's default, Docker's and a terminal's. */
const STOPPING_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Whether this instance is stopping, and the requests it has under way, for
 * the drain `stopOnSignals` runs. Its routing check (`HealthController`)
 * answers 503 once it is stopping.
 */
@Injectable()
export class Drain implements NestInterceptor {
  stopping = false;
  /** Responses not yet closed. */
  private responses = 0;
  /** Route handlers still running, which go on after their response closes when its client goes. */
  private handlers = 0;
  private idle: (() => void) | undefined;

  /**
   * Middleware counting the responses under way. Once stopping, each response
   * closes its connection, so a client's next request opens another, which
   * the proxy can send elsewhere, and no connection is left between
   * requests once those under way finish.
   */
  readonly track = (_req: Request, res: Response, next: NextFunction): void => {
    this.responses++;
    if (this.stopping) res.setHeader("Connection", "close");
    res.once("close", () => {
      this.responses--;
      this.settle();
    });
    next();
  };

  /** Counts each route handler until it finishes (`APP_INTERCEPTOR`), so one whose client has gone still finishes before the database disconnects. */
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    this.handlers++;
    return next.handle().pipe(
      finalize(() => {
        this.handlers--;
        this.settle();
      }),
    );
  }

  /** Resolves once no request is under way. */
  async finished(): Promise<void> {
    while (this.responses > 0 || this.handlers > 0) await new Promise<void>((resolve) => (this.idle = resolve));
  }

  private settle(): void {
    if (this.responses === 0 && this.handlers === 0) this.idle?.();
  }
}

/**
 * Stops the server without failing anyone's request (ADR-0025): on SIGINT,
 * SIGTERM or SIGHUP, rather than through Nest's own shutdown hooks, whose
 * `onModuleDestroy` hooks, Prisma's disconnect among them, run before the
 * HTTP server closes. Once a signal arrives:
 *
 * - the routing check answers 503, the tablets are handed to another
 *   instance (`SyncGateway.handOver`), and the Live Views' streams end, which
 *   the browser opens again (`LiveViews.end`);
 * - requests that still arrive are answered for the grace
 *   (`DRAIN_GRACE_SECONDS`), until the proxy has noticed;
 * - then the server stops listening, finishes the requests under way, and
 *   shuts Nest down, disconnecting from the database last.
 *
 * Signals that arrive meanwhile are ignored, as Nest's hooks ignored them: a
 * terminal's Ctrl-C reaches the server twice under `npm start`, from the
 * terminal and from npm. The host's kill still ends a drain that runs too long.
 */
export function stopOnSignals(app: INestApplication, config: Config): void {
  const logger = new Logger("DecentSync");
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.log(`Stopping on ${signal}: answering requests for ${config.drainGraceMs / 1000} s more, then finishing those under way`);
    try {
      const drain = app.get(Drain);
      drain.stopping = true;
      // Long-lived streams end here too, at once: a response still open would hold up `drain.finished()`.
      await Promise.all([app.get(SyncGateway).handOver(), app.get(LiveViews).end(), new Promise((resolve) => setTimeout(resolve, config.drainGraceMs))]);
      const server = app.getHttpServer() as Server;
      const closed = new Promise((resolve) => server.close(resolve));
      await drain.finished();
      // A request begun before the drain left its connection open after it; `close` closed only those idle then.
      server.closeIdleConnections();
      await closed;
      // No request starts once no connection is left, but one begun since on a connection still sending its headers may
      // be running, its client gone.
      await drain.finished();
      await app.close();
    } catch (error) {
      logger.error(`Could not stop cleanly: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exit(1);
    }
    // Ends as the signal would have, with no listener left for it.
    for (const each of STOPPING_SIGNALS) process.off(each, stop);
    process.kill(process.pid, signal);
  };
  for (const signal of STOPPING_SIGNALS) process.on(signal, stop);
}
