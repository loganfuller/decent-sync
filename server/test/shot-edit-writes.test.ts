import type { ShotEdit } from "@decent-sync/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShotEditWrites } from "../src/sync/shot-edit-writes.js";

// A connection's writer of the edits of Shots (ticket #512, ADR-0031),
// through its own interface: what it sends, and when, as the plugin answers,
// refuses or stays silent, on a clock the test moves. What is due stands in
// for the database: the edits not yet written, in the order they were made,
// each a write of its own here, which an answer of `written` marks, as the
// gateway records one before it tells the writer. That a Shot's edits go as
// one write, and the gateway's use of the writer, are tested through Seam 1
// and with hand-made frames in shot-edits.test.ts.

const RETRY_MS = 300_000;
/** How long the writer waits for an answer (ANSWER_TIMEOUT_MS). */
const ANSWER_MS = 60_000;

interface Made extends ShotEdit {
  written: boolean;
}

/** A writer over the edits `made`, with what it has sent. */
function connection() {
  const made: Made[] = [];
  const sent: string[] = [];
  const warnings: string[] = [];
  let holds = true;
  let failing = false;
  const writes = new ShotEditWrites(
    async (skipped) => {
      // Read as the look begins, and answered a moment later, as a query is.
      const due = holds ? (made.find((edit) => !edit.written && !skipped.includes(edit.shotId)) ?? null) : null;
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (failing) throw new Error("The database could not be reached");
      return due;
    },
    (edit) => sent.push(edit.id),
    { warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
    (work) => work,
    RETRY_MS,
  );
  /** Makes an edit of the Shot and tells the writer, as its notification does. */
  const make = (id: string, shotId: string) => {
    made.push({ type: "shotEdit", id, shotId, rating: 5, written: false });
    writes.wake();
  };
  /** The plugin's answer, recorded before the writer is told, if the connection awaits it, as the gateway does. */
  const answer = (id: string, written: boolean) => {
    if (!writes.awaits(id)) return;
    if (written) made.find((edit) => edit.id === id)!.written = true;
    writes.answered(id, written);
  };
  return { writes, made, sent, warnings, make, answer, release: () => (holds = false), fail: (fails: boolean) => (failing = fails) };
}

/** Lets the writer's looks under way, and what follows them, run. */
const settled = () => vi.advanceTimersByTimeAsync(10);

describe("A connection's writer of the edits of Shots", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("sends one edit at a time, in the order they were made, each once the one before it is answered as written", async () => {
    const { sent, make, answer } = connection();
    make("a1", "shot-a");
    make("a2", "shot-a");
    make("b1", "shot-b");
    await settled();
    expect(sent).toEqual(["a1"]);
    answer("a1", true);
    await settled();
    expect(sent).toEqual(["a1", "a2"]);
    answer("a2", true);
    await settled();
    answer("b1", true);
    await settled();
    expect(sent).toEqual(["a1", "a2", "b1"]);
  });

  it("holds back a Shot's later edits once one is refused, sends the other Shots' on, and tries again after the retry time", async () => {
    const { sent, make, answer } = connection();
    make("a1", "shot-a");
    make("a2", "shot-a");
    make("b1", "shot-b");
    await settled();
    answer("a1", false);
    await settled();
    // The Shot's next edit never goes ahead of the one refused.
    expect(sent).toEqual(["a1", "b1"]);
    answer("b1", true);
    make("a3", "shot-a");
    await settled();
    expect(sent).toEqual(["a1", "b1"]);

    await vi.advanceTimersByTimeAsync(RETRY_MS - 1000);
    expect(sent).toEqual(["a1", "b1"]);
    await vi.advanceTimersByTimeAsync(1000);
    // Again from the oldest.
    expect(sent).toEqual(["a1", "b1", "a1"]);
    answer("a1", true);
    await settled();
    answer("a2", true);
    await settled();
    expect(sent).toEqual(["a1", "b1", "a1", "a2", "a3"]);
  });

  it("gives up waiting for an answer after a minute, and takes one that comes later, letting the Shot's edits go on if it was written", async () => {
    const { sent, warnings, make, answer } = connection();
    make("a1", "shot-a");
    make("a2", "shot-a");
    await settled();
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    expect(warnings).toEqual([expect.stringContaining("did not answer edit a1")]);
    expect(sent).toEqual(["a1"]);
    // Late, and written all the same: the Shot's next edit goes at once, without waiting to try again.
    answer("a1", true);
    await settled();
    expect(sent).toEqual(["a1", "a2"]);

    // A late refusal changes nothing: the Shot waits to be tried again.
    await vi.advanceTimersByTimeAsync(ANSWER_MS);
    answer("a2", false);
    await settled();
    expect(sent).toEqual(["a1", "a2"]);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(sent).toEqual(["a1", "a2", "a2"]);
  });

  it("awaits only an edit it has sent and has no answer to", async () => {
    const { writes, sent, make, answer } = connection();
    make("a1", "shot-a");
    make("a2", "shot-a");
    await settled();
    expect([writes.awaits("a1"), writes.awaits("a2"), writes.awaits("no-such-edit")]).toEqual([true, false, false]);
    // An answer to an edit still to be sent, or to none, is not taken: the edit is sent in its turn.
    answer("a2", true);
    answer("no-such-edit", true);
    await settled();
    expect(sent).toEqual(["a1"]);
    answer("a1", true);
    await settled();
    expect(writes.awaits("a1")).toBe(false);
    // Answered twice, the second changes nothing.
    answer("a1", false);
    await settled();
    expect(sent).toEqual(["a1", "a2"]);
  });

  it("looks again after the retry time when a look fails, as nothing else may wake it", async () => {
    const { sent, warnings, make, fail } = connection();
    fail(true);
    make("a1", "shot-a");
    await settled();
    expect([sent, warnings]).toEqual([[], [expect.stringContaining("The database could not be reached")]]);
    fail(false);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual(["a1"]);
  });

  it("looks again for an edit made while it was looking, and sends nothing once stopped or once its connection no longer holds its Machine", async () => {
    const { writes, sent, make, answer, release } = connection();
    // A look that finds nothing due is still reading as an edit is made and notified.
    writes.wake();
    make("a1", "shot-a");
    await settled();
    expect(sent).toEqual(["a1"]);
    make("b1", "shot-b");
    answer("a1", true);
    await settled();
    expect(sent).toEqual(["a1", "b1"]);
    answer("b1", false);
    await settled();

    release();
    make("c1", "shot-c");
    await settled();
    expect(sent).toEqual(["a1", "b1"]);
    writes.stop();
    // Neither a wake nor the retry sends anything more, and no timer is left.
    make("d1", "shot-d");
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(sent).toEqual(["a1", "b1"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
