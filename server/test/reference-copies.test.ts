import type { ReferenceCopy } from "@decent-sync/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DueCopy } from "../src/shots/location-references.js";
import { MAX_WAITING_FOR_COPIES_BYTES, ReferenceCopies } from "../src/sync/reference-copies.js";

// What one connection's ReferenceCopies sends (ticket #510), on its own:
// nothing before the plugin has said what it holds, what is due once, and
// nothing more while its connection is behind on what it was sent. Seam 1
// covers the copies themselves, through the built plugin
// (skin-references.test.ts).

const RECIPE = { id: "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a72", name: "Belmont espresso", recordId: "2" };
const copy = (slot: number, version: string): DueCopy => ({ slot, copy: { version, recipe: RECIPE, reference: null } });

/** A connection's copies, given the copies wanted for each slot, which a look sends where the tablet holds another version. */
function copies(wanted: Map<number, string>) {
  const sent: ReferenceCopy[] = [];
  const looks: Map<number, string>[] = [];
  const state = { waiting: 0, held: null as boolean | null };
  const errors: string[] = [];
  const inFlight: Promise<void>[] = [];
  const sender = new ReferenceCopies(
    async (held) => {
      looks.push(new Map(held));
      if (state.held === false) return null;
      const due = [...held.keys()].filter((slot) => !wanted.has(slot)).map((slot): DueCopy => ({ slot, copy: null }));
      for (const [slot, version] of wanted) if (held.get(slot) !== version) due.push(copy(slot, version));
      return due;
    },
    (message) => void sent.push(message),
    { error: (message) => void errors.push(message) },
    (work) => {
      inFlight.push(work);
      return work;
    },
    () => state.waiting,
  );
  /** Resolves once every look begun has ended. */
  const settled = async () => {
    for (let count = -1; count !== inFlight.length; ) {
      count = inFlight.length;
      await Promise.all(inFlight);
    }
  };
  return { sender, sent, looks, state, errors, settled };
}

afterEach(() => vi.useRealTimers());

describe("a connection's Reference Shot copies", () => {
  it("sends nothing before the plugin has said what it holds, then each slot that differs, once", async () => {
    const wanted = new Map([[1, "one"], [2, "two"]]);
    const { sender, sent, looks, settled } = copies(wanted);
    sender.wake();
    await settled();
    expect([looks, sent]).toEqual([[], []]);

    sender.stated({ "1": "one", "2": "stale", "9": "stale" });
    await settled();
    expect(sent.map(({ slot, copy: each }) => [slot, each?.version ?? null])).toEqual([[9, null], [2, "two"]]);
    expect(sent.every((message) => message.type === "referenceCopy" && message.id !== "")).toBe(true);
    // Woken with nothing changed, it sends nothing; a change is sent once.
    sender.wake();
    await settled();
    expect(sent).toHaveLength(2);
    wanted.set(1, "three");
    sender.wake();
    sender.wake();
    await settled();
    expect(sent.slice(2).map(({ slot, copy: each }) => [slot, each?.version])).toEqual([[1, "three"]]);
  });

  it("puts a look off while more than a copy's worth waits to be sent, and then sends each slot's latest copy alone", async () => {
    vi.useFakeTimers();
    const wanted = new Map([[1, "one"]]);
    const { sender, sent, looks, state, settled } = copies(wanted);
    sender.stated({});
    await settled();
    expect(sent).toHaveLength(1);

    state.waiting = MAX_WAITING_FOR_COPIES_BYTES + 1;
    for (const version of ["two", "three", "four"]) {
      wanted.set(1, version);
      sender.wake();
      await settled();
    }
    await vi.advanceTimersByTimeAsync(5_000);
    await settled();
    // Nothing was read or sent meanwhile.
    expect([looks.length, sent.length]).toEqual([1, 1]);

    state.waiting = MAX_WAITING_FOR_COPIES_BYTES;
    await vi.advanceTimersByTimeAsync(1_000);
    await settled();
    expect(sent.slice(1).map(({ slot, copy: each }) => [slot, each?.version])).toEqual([[1, "four"]]);
  });

  it("sends nothing more once its connection has closed, or no longer holds its Machine", async () => {
    vi.useFakeTimers();
    const wanted = new Map([[1, "one"]]);
    const lost = copies(wanted);
    lost.state.held = false;
    lost.sender.stated({});
    await lost.settled();
    expect(lost.sent).toEqual([]);

    const closed = copies(wanted);
    closed.state.waiting = MAX_WAITING_FOR_COPIES_BYTES + 1;
    closed.sender.stated({});
    await closed.settled();
    closed.sender.stop();
    closed.state.waiting = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    closed.sender.wake();
    await closed.settled();
    expect([closed.looks, closed.sent]).toEqual([[], []]);
  });
});
