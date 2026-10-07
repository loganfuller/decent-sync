import { describe, expect, it } from "vitest";
import {
  CHUNK_LIMITS,
  type Chunk,
  type Frame,
  type Hello,
  MAX_CHUNKS,
  MAX_FRAME_BYTES,
  MAX_ID_LENGTH,
  PROTOCOL_VERSION,
  type PluginMessage,
  Reassembly,
  type ReassemblyLimits,
  type ShotDelivery,
  type ShotIndex,
  decodePluginFrame,
  decodePluginMessage,
  decodeServerMessage,
  encode,
  frames,
  utf8Length,
} from "@decent-sync/protocol";

/** UTF-8 bytes as Node counts them, which is how Decaid's Dart counts them too. */
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** A surrogate half without its other half. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const hello: Hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  token: "8cTqXr0b2m6Yw1zH4kLpQeNvSa7uJdFg9oIiBhC3E5s",
  pluginVersion: "0.1.0",
  decaidVersion: "0.8.7+2847",
};

/** A Shot delivery whose encoding is exactly `size` bytes, padded with a field Decaid would not send. */
function deliveryOfSize(size: number, padding = "x"): ShotDelivery {
  const message = (pad: string): ShotDelivery => ({ type: "shot", id: "delivery-1", shotId: "shot-1", shot: { pad } });
  const room = size - bytes(encode(message("")));
  // What each repeat of the padding adds to the encoding, escaped.
  const unit = bytes(JSON.stringify(padding)) - 2;
  const pad = padding.repeat(Math.floor(room / unit)) + "x".repeat(room % unit);
  const sized = message(pad);
  expect(bytes(encode(sized))).toBe(size);
  return sized;
}

/** Decodes frames as the server does and returns the whole messages they carry, in the order they complete. */
function receive(sent: string[], reassembly = new Reassembly(), limits: ReassemblyLimits = CHUNK_LIMITS): string[] {
  const whole: string[] = [];
  for (const frame of sent) {
    const decoded = decodePluginFrame(frame);
    if (!decoded.ok) throw new Error(decoded.problem);
    if (decoded.message.type !== "chunk") {
      whole.push(frame);
      continue;
    }
    const added = reassembly.add(decoded.message, limits);
    if (added.status === "invalid") throw new Error(added.problem);
    if (added.status === "complete") whole.push(added.text);
  }
  return whole;
}

function chunksOf(text: string, id: string, maxFrameBytes?: number): Chunk[] {
  return frames(text, id, maxFrameBytes).map((frame) => JSON.parse(frame.text) as Chunk);
}

/** Frames are measured as Decaid measures them, are canonical JSON, and are no larger than allowed. */
function expectWellFormed(sent: Frame[], maxFrameBytes: number): void {
  for (const frame of sent) {
    expect(frame.bytes).toBe(bytes(frame.text));
    expect(frame.bytes).toBeLessThanOrEqual(maxFrameBytes);
    expect(JSON.stringify(JSON.parse(frame.text))).toBe(frame.text);
  }
}

/** A small deterministic generator, so a failing case can be repeated. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("utf8Length", () => {
  it("counts bytes as UTF-8 does, including surrogate pairs and lone surrogates", () => {
    for (const text of ["", "plain ASCII", "café", "ü€", "日本語", "\u{1f600}", "a\u{1f600}b", "\u007f\u0080\u07ff\u0800\uffff", "\ud83d", "\ude00", "\ude00\ud83d", "x\ud83dy"]) {
      expect(utf8Length(text)).toBe(bytes(text));
    }
  });

  it("matches UTF-8 on random text", () => {
    const next = random(7);
    const alphabet = ["a", '"', "\\", "\n", "\u0001", "é", "€", "日", "\u{1f600}", "\ud83d", "\ude00"];
    for (let n = 0; n < 200; n++) {
      const text = Array.from({ length: Math.floor(next() * 50) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      expect(utf8Length(text)).toBe(bytes(text));
    }
  });

  it("counts text that switches between ASCII and other characters after ASCII runs of any length", () => {
    // Long runs of ASCII are matched and short ones stepped through; this covers both, and the switch between them.
    for (const other of ["é", "日", "\u{1f600}", "\ud83d", "\ude00"]) {
      for (let run = 0; run <= 80; run++) {
        const text = `${other}${"x".repeat(run)}`.repeat(4) + other;
        expect(utf8Length(text)).toBe(bytes(text));
      }
    }
  });
});

describe("frames", () => {
  it("sends a message at or below the threshold in one frame, and a larger one in chunks", () => {
    for (const size of [1_000, MAX_FRAME_BYTES - 1, MAX_FRAME_BYTES]) {
      const message = deliveryOfSize(size);
      expect(frames(encode(message), message.id)).toEqual([{ text: encode(message), bytes: size }]);
    }
    for (const size of [MAX_FRAME_BYTES + 1, 3 * 1024 * 1024]) {
      const message = deliveryOfSize(size);
      const sent = frames(encode(message), message.id);
      expect(sent.length).toBeGreaterThan(1);
      expectWellFormed(sent, MAX_FRAME_BYTES);
      expect(sent.map((frame) => JSON.parse(frame.text) as Chunk)).toEqual(
        sent.map((_, index) => ({ type: "chunk", id: message.id, index, count: sent.length, data: expect.any(String) })),
      );
    }
  });

  it("counts multibyte text by its bytes, not its characters", () => {
    // Three bytes a character: measured in characters, this would fit three times over.
    const message = deliveryOfSize(MAX_FRAME_BYTES + 3, "日");
    expect(encode(message).length).toBeLessThan(MAX_FRAME_BYTES / 2);
    const sent = frames(encode(message), message.id);
    expect(sent.length).toBe(2);
    expectWellFormed(sent, MAX_FRAME_BYTES);
  });

  it("leaves room for the envelope and the escaping of quotes, backslashes and control characters", () => {
    // Every character of this padding is escaped as two, or six, bytes in a chunk's data.
    const message = deliveryOfSize(MAX_FRAME_BYTES * 2, '"\\\u0001');
    const sent = frames(encode(message), message.id);
    expectWellFormed(sent, MAX_FRAME_BYTES);
    expect(receive(sent.map((frame) => frame.text))).toEqual([encode(message)]);
  });

  it("never ends a chunk between the halves of a surrogate pair", () => {
    for (const maxFrameBytes of [80, 81, 82, 83, 97, 128]) {
      const text = encode({ ...hello, note: "\u{1f600}".repeat(300) } as Hello);
      const chunks = chunksOf(text, "pairs", maxFrameBytes);
      expect(chunks.length).toBeGreaterThan(10);
      for (const chunk of chunks) expect(chunk.data).not.toMatch(LONE_SURROGATE);
      expect(chunks.map((chunk) => chunk.data).join("")).toBe(text);
    }
  });

  it("refuses a frame size with no room for any data beside the envelope", () => {
    expect(() => frames("x".repeat(100), "a long chunk id", 60)).toThrow("no room");
  });
});

describe("chunking and reassembly round trip", () => {
  it("returns the original message for sizes below, at and above the threshold", () => {
    for (const size of [MAX_FRAME_BYTES - 1, MAX_FRAME_BYTES, MAX_FRAME_BYTES + 1, MAX_FRAME_BYTES * 2 + 17, 5 * 1024 * 1024]) {
      const message = deliveryOfSize(size);
      const whole = receive(frames(encode(message), message.id).map((frame) => frame.text));
      expect(whole).toEqual([encode(message)]);
      expect(decodePluginMessage(whole[0]!)).toEqual({ ok: true, message });
    }
  });

  it("returns multibyte JSON intact: accents, symbols, pairs, escapes and control characters", () => {
    const shot = { notes: "Café crème, 抽出 ½ \u{2615} \u{1f600}\u{1f9cb} \"quoted\" back\\slash\nline\ttab\u0000\u001f", bean: "Ethiopia Guji \u{1f1ea}\u{1f1f9}" };
    const message: ShotDelivery = { type: "shot", id: "multibyte", shotId: "shot-multibyte", shot: { ...shot, repeated: Array.from({ length: 300 }, () => shot) } };
    for (const maxFrameBytes of [8_192, 1_000, 200]) {
      const sent = frames(encode(message), message.id, maxFrameBytes);
      expect(sent.length).toBeGreaterThan(1);
      expectWellFormed(sent, maxFrameBytes);
      expect(decodePluginMessage(receive(sent.map((frame) => frame.text))[0]!)).toEqual({ ok: true, message });
    }
  });

  it("returns text that already holds lone surrogates, as an engine without well-formed JSON.stringify would send", () => {
    const text = `{"type":"heartbeat","odd":"${"\ud83d \ude00 \ude00\ud83d ".repeat(20)}"}`;
    const chunks = chunksOf(text, "lone", 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(receive(chunks.map((chunk) => JSON.stringify(chunk)))).toEqual([text]);
  });

  it("returns large non-record messages: a hello and a Shot index", () => {
    const largeHello = { ...hello, futureField: "ü€\u{1f600}".repeat(40_000) };
    const index: ShotIndex = {
      type: "shotIndex",
      id: "index-1",
      shots: Array.from({ length: 100 }, (_, n) => ({ id: `${n}-${"i".repeat(4_000)}`, updatedAt: "2026-10-04T18:14:42.666246Z" })),
    };
    for (const message of [largeHello, index] as PluginMessage[]) {
      const sent = frames(encode(message), "id" in message ? message.id : "hello");
      expect(sent.length).toBeGreaterThan(1);
      expect(decodePluginMessage(receive(sent.map((frame) => frame.text))[0]!)).toEqual({ ok: true, message });
    }
  });

  it("round-trips random messages at random frame sizes", () => {
    const next = random(42);
    const alphabet = ["a", "Z", "0", " ", '"', "\\", "/", "\n", "\u0007", "é", "€", "日", "\u{1f600}", "\ud83d", "\ude00", "{", "}"];
    for (let n = 0; n < 60; n++) {
      const length = Math.floor(next() * 5_000);
      const note = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      const message: ShotDelivery = { type: "shotUpdated", id: `random-${n}`, shotId: "s", shot: { note } };
      const maxFrameBytes = 100 + Math.floor(next() * 3_000);
      const sent = frames(encode(message), message.id, maxFrameBytes);
      expectWellFormed(sent, maxFrameBytes);
      expect(decodePluginMessage(receive(sent.map((frame) => frame.text))[0]!)).toEqual({ ok: true, message });
    }
  });
});

describe("Reassembly", () => {
  const text = encode(deliveryOfSize(4_000, "é"));
  const chunks = chunksOf(text, "message-a", 300);
  const other = encode({ type: "heartbeat", note: "b".repeat(2_000) } as PluginMessage);
  const otherChunks = chunksOf(other, "message-b", 300);

  it("completes a message once from chunks in any order, repeated, and interleaved with another message's", () => {
    expect(chunks.length).toBeGreaterThan(5);
    const reassembly = new Reassembly();
    const order = [...chunks].reverse().flatMap((chunk, n) => [chunk, ...(n % 2 === 0 ? [chunk] : []), ...(otherChunks[n] ? [otherChunks[n]] : [])]);
    const completed = order.map((chunk) => reassembly.add(chunk, CHUNK_LIMITS)).filter((added) => added.status === "complete");
    expect(completed).toEqual(
      expect.arrayContaining([{ status: "complete", text }, { status: "complete", text: other }]),
    );
    expect(completed).toHaveLength(2);
  });

  it("never completes a message with a chunk missing", () => {
    const reassembly = new Reassembly();
    for (const chunk of chunks.slice(1)) expect(reassembly.add(chunk, CHUNK_LIMITS)).toEqual({ status: "incomplete" });
    expect(reassembly.add(chunks[1]!, CHUNK_LIMITS)).toEqual({ status: "incomplete" });
  });

  it("holds nothing of a completed message: a repeat after completion starts over", () => {
    const reassembly = new Reassembly();
    // Room for one message at a time, id included, so the first must have been let go.
    const limits = { maxLength: text.length + "message-a".length, maxChunks: chunks.length };
    for (let round = 0; round < 3; round++) {
      const results = chunks.map((chunk) => reassembly.add(chunk, limits));
      expect(results.at(-1)).toEqual({ status: "complete", text });
      expect(results.slice(0, -1).every((added) => added.status === "incomplete")).toBe(true);
    }
  });

  it("finds chunks that contradict each other untrustworthy, and completes nothing after", () => {
    const contradictions: Chunk[] = [
      { ...chunks[0]!, data: `${chunks[0]!.data}!` },
      { ...chunks[0]!, count: chunks.length + 1 },
      { ...chunks[1]!, index: 0, data: chunks[1]!.data },
    ];
    for (const contradiction of contradictions) {
      const reassembly = new Reassembly();
      expect(reassembly.add(chunks[0]!, CHUNK_LIMITS)).toEqual({ status: "incomplete" });
      expect(reassembly.add(contradiction, CHUNK_LIMITS)).toMatchObject({ status: "invalid", problem: expect.stringContaining("chunk.") });
      for (const chunk of [...chunks, ...otherChunks]) expect(reassembly.add(chunk, CHUNK_LIMITS).status).toBe("invalid");
    }
  });

  it("refuses chunks out of range and messages past its limits, by field and never by value", () => {
    const refused = (added: ReturnType<Reassembly["add"]>) => {
      expect(added.status).toBe("invalid");
      expect(JSON.stringify(added)).not.toContain(chunks[0]!.data);
    };
    refused(new Reassembly().add({ ...chunks[0]!, index: chunks.length }, CHUNK_LIMITS));
    refused(new Reassembly().add({ ...chunks[0]!, index: -1 }, CHUNK_LIMITS));
    refused(new Reassembly().add({ ...chunks[0]!, index: 0.5 }, CHUNK_LIMITS));
    refused(new Reassembly().add({ ...chunks[0]!, count: 0 }, CHUNK_LIMITS));
    refused(new Reassembly().add({ ...chunks[0]!, count: MAX_CHUNKS + 1 }, CHUNK_LIMITS));

    // Limits count what is held across messages: either message fits alone, but not both at once.
    const oneMessage = { maxLength: text.length + "message-a".length, maxChunks: MAX_CHUNKS };
    const reassembly = new Reassembly();
    expect(reassembly.add(otherChunks[0]!, oneMessage).status).toBe("incomplete");
    const statuses = chunks.map((chunk) => reassembly.add(chunk, oneMessage).status);
    expect(statuses).toContain("invalid");
    expect(statuses).not.toContain("complete");
    // A message's first chunk holds a place for every chunk it says it has.
    const fourChunks = { maxLength: Infinity, maxChunks: 4 };
    const counted = new Reassembly();
    for (const id of ["p", "q"]) expect(counted.add({ type: "chunk", id, index: 0, count: 2, data: id }, fourChunks).status).toBe("incomplete");
    refused(counted.add({ type: "chunk", id: "r", index: 0, count: 2, data: "r" }, fourChunks));
    refused(new Reassembly().add({ type: "chunk", id: "s", index: 0, count: 5, data: "s" }, fourChunks));
  });

  it("counts the ids of messages still incomplete against its limits, so empty chunks cannot hold more", () => {
    const limits = { maxLength: 1_000, maxChunks: MAX_CHUNKS };
    const reassembly = new Reassembly();
    // Chunks that carry no data, each starting a message with a long id.
    const empty = (n: number): Chunk => ({ type: "chunk", id: `${n}`.padEnd(300, "x"), index: 0, count: 2, data: "" });
    for (const n of [1, 2, 3]) expect(reassembly.add(empty(n), limits)).toEqual({ status: "incomplete" });
    expect(reassembly.add(empty(4), limits)).toMatchObject({ status: "invalid", problem: expect.stringContaining("ids included") });
    // A repeat of a chunk already held adds nothing, and so is still within the limits.
    const repeated = new Reassembly();
    expect(repeated.add(empty(1), limits)).toEqual({ status: "incomplete" });
    for (let n = 0; n < 5; n++) expect(repeated.add(empty(1), limits)).toEqual({ status: "incomplete" });
    expect(new Reassembly().add({ ...empty(5), id: "y".repeat(1_001) }, limits).status).toBe("invalid");
  });

  it("puts back together only what decodes as a whole message, never a chunk inside a chunk", () => {
    const truncated = text.slice(0, -10);
    const [whole] = receive(chunksOf(truncated, "truncated", 300).map((chunk) => JSON.stringify(chunk)));
    expect(decodePluginMessage(whole!)).toMatchObject({ ok: false, error: "protocol_error", problem: "The frame is not JSON" });
    const nested = JSON.stringify(chunks[0]);
    expect(decodePluginMessage(receive(chunksOf(nested, "nested", 150).map((chunk) => JSON.stringify(chunk)))[0]!)).toEqual({
      ok: false,
      error: "protocol_error",
      problem: "A chunked message must not be a chunk itself",
    });
  });
});

describe("chunk envelopes", () => {
  it("reads a chunk, accepting fields it does not know", () => {
    const chunk = { type: "chunk", id: "delivery-1", index: 0, count: 2, data: '{"type":', future: true };
    expect(decodePluginFrame(JSON.stringify(chunk))).toEqual({ ok: true, message: chunk });
    // A whole message reads the same either way.
    expect(decodePluginFrame(encode(hello))).toEqual(decodePluginMessage(encode(hello)));
  });

  it("refuses a chunk with missing or mistyped fields, naming each one", () => {
    expect(decodePluginFrame(JSON.stringify({ type: "chunk", id: "", index: -1, count: 0, data: 7 }))).toEqual({
      ok: false,
      error: "protocol_error",
      problem: "chunk.id must not be empty; chunk.index must not be negative; chunk.count must be positive; chunk.data must be a string",
    });
    for (const fields of [{ index: 1.5 }, { count: "2" }, { id: 3 }, { data: null }]) {
      expect(decodePluginFrame(JSON.stringify({ type: "chunk", id: "a", index: 0, count: 2, data: "", ...fields })).ok).toBe(false);
    }
  });

  it("refuses a chunk whose id is longer than a delivery's may be, without repeating it", () => {
    const chunk = { type: "chunk", id: "a".repeat(MAX_ID_LENGTH), index: 0, count: 2, data: "{" };
    expect(decodePluginFrame(JSON.stringify(chunk))).toEqual({ ok: true, message: chunk });
    expect(decodePluginFrame(JSON.stringify({ ...chunk, id: "b".repeat(MAX_ID_LENGTH + 1) }))).toEqual({
      ok: false,
      error: "protocol_error",
      problem: `chunk.id must be at most ${MAX_ID_LENGTH} characters`,
    });
  });

  it("reads the server's receipt for a chunk", () => {
    const receipt = { type: "chunkReceived", id: "delivery-1", index: 3 };
    expect(decodeServerMessage(JSON.stringify(receipt))).toEqual({ ok: true, message: receipt });
    for (const index of [undefined, -1, 0.5, "3"]) {
      expect(decodeServerMessage(JSON.stringify({ ...receipt, index })).ok).toBe(false);
    }
    expect(decodeServerMessage(JSON.stringify({ ...receipt, id: "" })).ok).toBe(false);
  });
});
