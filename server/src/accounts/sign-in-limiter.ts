const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
/**
 * Bounds memory to a few tens of MB, since sign-in refuses emails longer than
 * 254 characters. Filling it means starting this many sign-ins for distinct
 * emails within one window, each costing a password hash: more than the
 * server can check in 15 minutes.
 */
const DEFAULT_CAPACITY = 100_000;

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
 * A window is never forgotten before it ends, or flooding sign-in with other
 * emails could lift a lockout. When every slot holds a live window, emails
 * not already tracked are refused until the oldest window ends.
 *
 * Kept in memory: one server instance is enough for v1 (ADR-0011), and a
 * restart only forgets recent failures. It is keyed by email, not client
 * address, because behind a hosting proxy (fly.io) every client can share one
 * address.
 */
export class SignInLimiter {
  /** In order of window start, oldest first. */
  private readonly attempts = new Map<string, Attempts>();

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  /**
   * Records the start of an attempt for the email. Returns the seconds to wait
   * when the email has had too many attempts, or undefined to go ahead.
   */
  begin(email: string, now = Date.now()): number | undefined {
    this.prune(now);
    let entry = this.attempts.get(email);
    if (!entry) {
      if (this.attempts.size >= this.capacity) {
        const [oldest] = this.attempts.values();
        return secondsUntilEnd(oldest!, now);
      }
      entry = { count: 0, windowStart: now };
      this.attempts.set(email, entry);
    }
    if (entry.count >= MAX_ATTEMPTS) return secondsUntilEnd(entry, now);
    entry.count += 1;
    return undefined;
  }

  /** Forgets the email's attempts after a successful sign-in. */
  succeeded(email: string): void {
    this.attempts.delete(email);
  }

  /** Forgets windows that have ended; they are all at the front. */
  private prune(now: number): void {
    for (const [email, entry] of this.attempts) {
      if (now - entry.windowStart < WINDOW_MS) break;
      this.attempts.delete(email);
    }
  }
}

function secondsUntilEnd(entry: Attempts, now: number): number {
  return Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
}
