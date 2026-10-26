import { expect } from "vitest";

// A backlog of hundreds or thousands of deliveries, sent one at a time, each
// stored before the next, takes a minute or more on a busy machine, though
// each takes milliseconds. A poll's timeout bounds a wait for one thing to
// happen; a guess at how long a whole backlog takes fails on a machine
// busier than the one it was made on. So a test waits for a backlog for as
// long as it keeps moving, within a test timeout of minutes.

/**
 * Resolves once `done` holds, waiting as long as `progress`, such as how many
 * records are stored or how many frames the tablet sent, rises within each
 * poll's timeout. Fails once it stops rising for that long. Each poll attempt
 * checks `done` once, and `progress` only while not done; the first attempt
 * runs at once, so `done` is still checked before any wait.
 */
export async function whileProgressing(done: () => boolean | Promise<boolean>, progress: () => number | Promise<number>): Promise<void> {
  let reached = await progress();
  for (;;) {
    const before = reached;
    let finished = false;
    await expect
      .poll(async () => (finished = await done()) || (reached = await progress()) > before, { message: `progress stopped at ${before}` })
      .toBe(true);
    if (finished) return;
  }
}
