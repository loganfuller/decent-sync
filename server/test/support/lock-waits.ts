import { vi } from "vitest";
import type { TestServer } from "./test-server.js";

export interface LockWaits {
  /** How many queries must be waiting. Defaults to 1. */
  count?: number;
  /** Counts only queries waiting for a lock on this table, such as one a test holds with LOCK TABLE. */
  relation?: string;
  /** Counts only queries waiting for an advisory lock. */
  advisory?: boolean;
}

/**
 * Resolves once at least `count` queries on the server's database wait for a
 * lock, so a test knows work has reached a lock it holds before it goes on,
 * rather than sleeping and hoping it has. It reads through a connection of its
 * own: one inside a transaction sees other sessions' activity only as it was
 * when the transaction first looked. It gives up after 4 s, within a test's
 * default 5 s, so a failure says which lock nothing waited for.
 *
 * It counts every such wait in the database, so nothing else may wait for a
 * lock meanwhile: a connection the server releases for its silence, for one,
 * waits for its Machine's row if the test holds it.
 */
export async function waitForLockWaits(server: TestServer, { count = 1, relation, advisory = false }: LockWaits = {}): Promise<void> {
  const database = await server.connectDatabase();
  try {
    await vi.waitFor(
      async () => {
        const { rows } = await database.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity AS a
           WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
             AND (NOT $1 OR a.wait_event = 'advisory')
             AND ($2::regclass IS NULL OR EXISTS (SELECT 1 FROM pg_locks AS l WHERE l.pid = a.pid AND NOT l.granted AND l.relation = $2::regclass))`,
          [advisory, relation ?? null],
        );
        const waiting = rows[0]!.waiting;
        if (waiting < count) {
          const what = [advisory ? "an advisory lock" : "a lock", relation ? `on ${relation}` : ""].filter(Boolean).join(" ");
          throw new Error(`${waiting} of ${count} queries wait for ${what}`);
        }
      },
      { timeout: 4_000, interval: 20 },
    );
  } finally {
    await database.end();
  }
}
