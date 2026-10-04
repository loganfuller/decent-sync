import { Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;
/**
 * Bounds the table to a few tens of MB, since sign-in refuses emails longer
 * than 254 characters. Filling it means starting this many sign-ins for
 * distinct emails within one window, each costing a password hash: more than
 * the server can check in 15 minutes. Instances counting new emails at the
 * same moment can each take the last free slot, so it may be exceeded by as
 * many sign-ins as are in flight.
 */
const CAPACITY = 100_000;

const WINDOW = Prisma.raw(`interval '${WINDOW_SECONDS} seconds'`);
/** Whether the window of the row `w` has ended. */
const ENDED = Prisma.sql`w.started_at <= now() - ${WINDOW}`;

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
 * Counts live in PostgreSQL (`sign_in_windows`), so every server instance
 * enforces one limit and a restart keeps it (ADR-0016). Windows start and end
 * by the database's clock, and one statement that locks the email's row both
 * counts each attempt and decides it. It is keyed by email, not client
 * address, because behind a hosting proxy (fly.io) every client can share one
 * address.
 */
@Injectable()
export class SignInLimiter {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the start of an attempt for the email. Returns the seconds to wait
   * when the email has had too many attempts, or undefined to go ahead.
   */
  async begin(email: string): Promise<number | undefined> {
    // Forgets windows that have ended, so the table holds only live ones.
    await this.prisma.$executeRaw`
      DELETE FROM sign_in_windows AS w WHERE ${ENDED}`;

    // A window that ended since is restarted here rather than counted on. An
    // email over the limit is counted as one attempt past it, so the decision
    // and the wait both come from its row, locked by this statement.
    const [row] = await this.prisma.$queryRaw<{ attempts: number; seconds: number }[]>`
      INSERT INTO sign_in_windows AS w (email, attempts)
      SELECT ${email}, 1
      WHERE EXISTS (SELECT 1 FROM sign_in_windows WHERE email = ${email})
         OR (SELECT count(*) FROM sign_in_windows) < ${CAPACITY}
      ON CONFLICT (email) DO UPDATE SET
        attempts = CASE WHEN ${ENDED} THEN 1 ELSE least(w.attempts + 1, ${MAX_ATTEMPTS + 1}) END,
        started_at = CASE WHEN ${ENDED} THEN now() ELSE w.started_at END
      RETURNING w.attempts, ceil(extract(epoch FROM w.started_at + ${WINDOW} - now()))::int AS seconds`;
    if (row) return row.attempts > MAX_ATTEMPTS ? Math.max(row.seconds, 1) : undefined;

    // Not tracked, and every slot holds a live window: wait for the oldest to
    // end. It may have ended meanwhile, and then the wait is a second.
    const [{ seconds }] = await this.prisma.$queryRaw<[{ seconds: number | null }]>`
      SELECT ceil(extract(epoch FROM min(started_at) + ${WINDOW} - now()))::int AS seconds FROM sign_in_windows`;
    return Math.max(seconds ?? 1, 1);
  }

  /** Forgets the email's attempts after a successful sign-in. */
  async succeeded(email: string): Promise<void> {
    await this.prisma.signInWindow.deleteMany({ where: { email } });
  }
}
