import { type ArgumentsHost, Catch, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { Response } from "express";

/**
 * Password checks one instance runs at once. Each hash takes about 50 ms of
 * CPU and 32 MiB on Node's worker pool, four threads by default, which also
 * serves file reads and the DNS lookups `pg` makes when it opens a database
 * connection; two leave the rest of the pool for those.
 */
const RUNNING = 2;
/** Password checks that may wait for those running; more are refused. The last waits about half a second. */
const WAITING = 16;

/**
 * Bounds the password checks one server instance runs at once, and how many
 * wait their turn. Sign-in, first-run setup, accepting an invite and using
 * a password reset link each check or hash a password with no session, so
 * anyone can start them. Beyond the limit a check is refused before any of
 * its work starts, with 429 and a `Retry-After`.
 *
 * The counts live in this instance's memory: they protect its own CPU,
 * memory and worker pool, and decide nothing shared (ADR-0016). The
 * per-email sign-in limit, which must hold across instances, lives in
 * PostgreSQL (`SignInLimiter`).
 */
@Injectable()
export class PasswordChecks {
  private running = 0;
  /** Checks waiting for a place, in the order they arrived. */
  private readonly waiting: (() => void)[] = [];

  /** Runs the check once a place is free, in turn, or refuses it with PasswordChecksBusy without running it. */
  async run<T>(check: () => Promise<T>): Promise<T> {
    if (this.running < RUNNING) this.running++;
    else if (this.waiting.length < WAITING) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else throw new PasswordChecksBusy();
    try {
      return await check();
    } finally {
      // Its place goes straight to the next waiting, so a check arriving meanwhile cannot take it.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

/** A refusal with 429 Too Many Requests, which says in `Retry-After` how many seconds to wait. */
export class TooManyRequests extends HttpException {
  constructor(
    readonly retryAfterSeconds: number,
    message: string,
  ) {
    super({ statusCode: HttpStatus.TOO_MANY_REQUESTS, error: "Too Many Requests", message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** Refuses a password check while this instance runs and holds as many as it allows. */
export class PasswordChecksBusy extends TooManyRequests {
  constructor() {
    super(1, "The server is busy checking other passwords. Try again in a moment.");
  }
}

/** Sends a TooManyRequests refusal as any other is sent, with its `Retry-After`. */
@Catch(TooManyRequests)
export class RetryAfterFilter extends BaseExceptionFilter {
  override catch(exception: TooManyRequests, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().setHeader("Retry-After", String(exception.retryAfterSeconds));
    super.catch(exception, host);
  }
}
