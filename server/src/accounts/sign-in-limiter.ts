import { Injectable } from "@nestjs/common";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
/** Bounds memory when someone tries many different emails. */
const MAX_TRACKED = 10_000;

interface Attempts {
  count: number;
  windowStart: number;
}

/**
 * Limits password guessing per email: after five sign-ins that did not
 * succeed within 15 minutes, that email is refused until the window ends,
 * even with the right password. Attempts count when they start, so parallel
 * guesses cannot slip in while passwords are checked. Unknown emails are
 * limited the same way, so the limit reveals nothing about which accounts
 * exist.
 *
 * Kept in memory: one server instance is enough for v1 (ADR-0011), and a
 * restart only forgets recent failures. It is keyed by email, not client
 * address, because behind a hosting proxy (fly.io) every client can share one
 * address.
 */
@Injectable()
export class SignInLimiter {
  private readonly attempts = new Map<string, Attempts>();

  /**
   * Records the start of an attempt for the email. Returns the seconds to wait
   * when the email has had too many attempts, or undefined to go ahead.
   */
  begin(email: string, now = Date.now()): number | undefined {
    let entry = this.attempts.get(email);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      this.prune(now);
      entry = { count: 0, windowStart: now };
      this.attempts.set(email, entry);
    }
    if (entry.count >= MAX_ATTEMPTS) {
      return Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    }
    entry.count += 1;
    return undefined;
  }

  /** Forgets the email's attempts after a successful sign-in. */
  succeeded(email: string): void {
    this.attempts.delete(email);
  }

  private prune(now: number): void {
    if (this.attempts.size < MAX_TRACKED) return;
    for (const [email, entry] of this.attempts) {
      if (now - entry.windowStart >= WINDOW_MS) this.attempts.delete(email);
    }
    // Still full of live windows: drop the oldest rather than grow without bound.
    for (const email of this.attempts.keys()) {
      if (this.attempts.size < MAX_TRACKED) break;
      this.attempts.delete(email);
    }
  }
}
