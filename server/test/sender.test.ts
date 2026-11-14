import { CHUNK_LIMITS, type Chunk, MAX_FRAME_BYTES, Reassembly } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { MAX_UNCONFIRMED_BYTES, MAX_WHOLE_BYTES, Sender } from "../src/sync/sender.js";

// A connection's sender of the server's writes and answers (ticket #508),
// through its own interface: what it hands the connection, and when, as the
// plugin confirms chunks. The gateway's use of it is tested with hand-made
// frames in confirmed-chunks.test.ts. The messages are made up: only their
// sizes matter here, and no answer the server gives yet is large.

/** Decaid's limit on the frames it holds for a plugin. */
const DECAID_INBOUND_LIMIT = 1 << 20;

/** A message of `bytes` bytes, as its encoding. */
function message(type: string, bytes: number): string {
  const sized = (notes: string) => JSON.stringify({ type, id: `${type}-1`, notes });
  return sized("n".repeat(bytes - sized("").length));
}

/** A sender, with the frames it has handed its connection, as a plugin that confirms when told to sees them. */
function connection() {
  const frames: string[] = [];
  const sender = new Sender((text) => frames.push(text));
  const chunks = () => frames.map((text) => JSON.parse(text) as Chunk).filter((frame) => frame.type === "chunk");
  /** The bytes of the chunks handed over from `from` on, as Decaid counts them. */
  const bytes = (from = 0) => frames.slice(from).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  return { sender, frames, chunks, bytes };
}

/** Confirms each chunk as it is read, as the plugin does, until nothing more comes: every message put back together, in the order completed. */
function confirmAll(sender: Sender, frames: string[], from = 0): string[] {
  const reassembly = new Reassembly();
  const whole: string[] = [];
  for (let at = from; at < frames.length; at++) {
    const frame = JSON.parse(frames[at]!) as Chunk;
    if (frame.type !== "chunk") {
      whole.push(frames[at]!);
      continue;
    }
    const added = reassembly.add(frame, CHUNK_LIMITS);
    expect(added.status).not.toBe("invalid");
    if (added.status === "complete") whole.push(added.text);
    sender.received(frame.id, frame.index);
  }
  return whole;
}

describe("The server's sender", () => {
  it("sends a small message whole, at once, and counts nothing for it", () => {
    const { sender, frames } = connection();
    const small = message("answer", 200);
    const atTheLimit = message("write", MAX_WHOLE_BYTES);
    sender.send(small);
    sender.send(atTheLimit);
    expect(frames).toEqual([small, atTheLimit]);
    // Nothing was counted: a large message still has the whole limit.
    sender.send(message("write", MAX_UNCONFIRMED_BYTES));
    expect(frames).toHaveLength(4);
  });

  it("sends a message past the small size as chunks, even one that would fit a frame", () => {
    const { sender, frames, chunks } = connection();
    const text = message("write", MAX_WHOLE_BYTES + 1);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_FRAME_BYTES);
    sender.send(text);
    expect(chunks()).toMatchObject([{ type: "chunk", index: 0, count: 1 }]);
    expect(confirmAll(sender, frames)).toEqual([text]);
  });

  it("holds back once the chunks unconfirmed would pass the limit, and carries on as they are confirmed", () => {
    const { sender, frames, chunks, bytes } = connection();
    const text = message("write", 5 * DECAID_INBOUND_LIMIT);
    sender.send(text);
    const first = chunks();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(first[0]!.count);
    expect(bytes()).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);
    // One more would pass it.
    expect(bytes() + MAX_FRAME_BYTES).toBeGreaterThan(MAX_UNCONFIRMED_BYTES);

    // A confirmation naming no chunk in flight changes nothing.
    sender.received("message-9", 0);
    sender.received(first[0]!.id, first[0]!.count - 1);
    expect(frames).toHaveLength(first.length);

    // Confirming the first lets as much go as it took.
    sender.received(first[0]!.id, 0);
    expect(frames.length).toBe(first.length + 1);
    expect(bytes(1)).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);

    // A confirmation covers every chunk sent before it: all are confirmed by the latest one's.
    const latest = chunks().at(-1)!;
    const sent = frames.length;
    sender.received(latest.id, latest.index);
    expect(bytes(sent)).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);
    expect(frames.length).toBeGreaterThan(sent + 1);

    expect(confirmAll(sender, frames, 0)).toEqual([text]);
    expect(chunks().map((chunk) => chunk.index)).toEqual(Array.from({ length: first[0]!.count }, (_, index) => index));
  });

  it("keeps a write and an answer in flight together within the limit, each whole and in the order given", () => {
    const { sender, frames, chunks } = connection();
    const write = message("write", 1.5 * DECAID_INBOUND_LIMIT);
    const answer = message("answer", 1.25 * DECAID_INBOUND_LIMIT);
    sender.send(write);
    sender.send(answer);
    // A small message goes ahead of both, at once.
    const small = message("answer", 100);
    sender.send(small);
    expect(frames.at(-1)).toBe(small);

    // The plugin confirms one chunk at a time: what is unconfirmed never passes the limit, whichever message it is of.
    const reassembly = new Reassembly();
    const whole: string[] = [];
    let confirmed = 0;
    let unconfirmedFrom = 0;
    for (let at = 0; at < frames.length; at++) {
      const frame = JSON.parse(frames[at]!) as Chunk;
      if (frame.type !== "chunk") continue;
      const inFlight = frames.slice(unconfirmedFrom).filter((text) => text !== small);
      expect(inFlight.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);
      const added = reassembly.add(frame, CHUNK_LIMITS);
      if (added.status === "complete") whole.push(added.text);
      sender.received(frame.id, frame.index);
      confirmed++;
      unconfirmedFrom = at + 1;
    }
    expect(whole).toEqual([write, answer]);
    expect(confirmed).toBe(chunks().length);
    // Each message's chunks went together: the write's all before the answer's.
    const names = chunks().map((chunk) => chunk.id);
    expect(new Set(names).size).toBe(2);
    expect(names.lastIndexOf(names[0]!)).toBeLessThan(names.indexOf(names.at(-1)!));
  });

  it("names each chunked message apart, whatever ids the messages carry", () => {
    const { sender, chunks } = connection();
    const text = message("answer", MAX_WHOLE_BYTES + 1);
    sender.send(text);
    sender.send(text);
    const [first, second] = chunks();
    expect(first!.id).not.toBe(second!.id);
  });
});
