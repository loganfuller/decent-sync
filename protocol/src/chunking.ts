// Messages too large for one frame. The plugin sends such a message as
// ordered chunks, each a frame of its own, and the server puts it back
// together before handling it like any other message.
//
// Decaid's transport holds at most 1 MiB of a plugin's frames awaiting the
// network, one frame or all those queued together (`_reserveOutbound` in
// decaid:lib/src/plugins/plugin_transport_service.dart), so frames stay well
// below that. Sizes are UTF-8 bytes of a whole frame, as Decaid counts them,
// with its envelope and JSON escaping.

/**
 * The largest frame the plugin sends, in UTF-8 bytes. A message whose
 * encoding is larger goes as chunks, each a frame of at most this size.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

/**
 * The longest message, in UTF-16 code units of its encoding, put back
 * together from chunks. Decaid's fetch returns at most 10 MiB, so no message
 * the plugin builds from what it reads comes near it.
 */
export const MAX_CHUNKED_LENGTH = 16 * 1024 * 1024;

/**
 * The most chunks held at once, and so in one message. A message of
 * MAX_CHUNKED_LENGTH in frames of MAX_FRAME_BYTES needs fewer than 400, even
 * if every code unit had to be escaped.
 */
export const MAX_CHUNKS = 1024;

/** One piece of a message too large for a frame of its own. */
export interface Chunk {
  type: "chunk";
  /** Names the message on its connection: a delivery's own id, where it has one. */
  id: string;
  /** Its place in the message, from 0. */
  index: number;
  /** How many chunks the message has. */
  count: number;
  /** Its piece of the message's encoding; in order, the pieces make up the message's JSON. */
  data: string;
}

/** A frame ready to send, with its size as Decaid counts it. */
export interface Frame {
  text: string;
  /** Its size in UTF-8. */
  bytes: number;
}

/**
 * Whether JSON.stringify escapes a lone surrogate as six ASCII characters, as
 * ES2019 requires, rather than leaving it to be sent as U+FFFD.
 */
const ESCAPES_LONE_SURROGATES = JSON.stringify("\ud800").length > 3;

/**
 * Runs of code units of one UTF-8 width, with the bytes each code unit in a
 * run takes: ASCII, below U+0800, the rest of the Basic Multilingual Plane,
 * and surrogate pairs (four bytes a pair). Sticky, so each matches from where
 * the scan has got to. A lone surrogate is in none of them.
 */
const RUNS: readonly (readonly [RegExp, number])[] = [
  [/[\x00-\x7f]*/y, 1],
  [/[\u0080-\u07ff]*/y, 2],
  [/[\u0800-\ud7ff\ue000-\uffff]*/y, 3],
  [/(?:[\ud800-\udbff][\udc00-\udfff])*/y, 2],
];

/**
 * Where a text's code units take more than one byte of UTF-8, found in one
 * scan, so the size of any slice of it is known without reading it again.
 * Decaid gives plugins no TextEncoder. In QuickJS, the engine it runs them
 * in on Android, matching whole runs is several times faster than matching
 * characters one at a time or looping over them.
 */
class Widths {
  /** The text's UTF-8 bytes beyond one a code unit; a lone surrogate is sent as U+FFFD, three bytes. */
  readonly extra: number;
  /** Stretches of code units that take more than one byte each, in order. */
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  /** The bytes beyond one each code unit of a stretch takes once escaped as JSON. */
  private readonly escapedExtra: number[] = [];
  /** Those bytes, summed over the stretches before each. */
  private readonly escapedBefore: number[] = [];

  constructor(text: string) {
    let extra = 0;
    let escaped = 0;
    const stretch = (start: number, end: number, perUnit: number, escapedPerUnit: number) => {
      this.starts.push(start);
      this.ends.push(end);
      this.escapedExtra.push(escapedPerUnit);
      this.escapedBefore.push(escaped);
      extra += (end - start) * perUnit;
      escaped += (end - start) * escapedPerUnit;
    };
    for (let at = 0; at < text.length; ) {
      const from = at;
      for (const [run, bytes] of RUNS) {
        run.lastIndex = at;
        run.exec(text);
        if (run.lastIndex > at && bytes > 1) stretch(at, run.lastIndex, bytes - 1, bytes - 1);
        at = run.lastIndex;
      }
      if (at === from) {
        // A lone surrogate: three bytes as sent, but six ASCII characters once escaped.
        stretch(at, at + 1, 2, ESCAPES_LONE_SURROGATES ? 0 : 2);
        at++;
      }
    }
    this.extra = extra;
  }

  /** The bytes beyond one a code unit that the code units from `start` to `end` take once escaped as JSON. */
  escapedBetween(start: number, end: number): number {
    return this.escapedUpTo(end) - this.escapedUpTo(start);
  }

  private escapedUpTo(position: number): number {
    // The last stretch that starts before the position.
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.starts[middle]! < position) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return 0;
    const last = low - 1;
    return this.escapedBefore[last]! + (Math.min(position, this.ends[last]!) - this.starts[last]!) * this.escapedExtra[last]!;
  }
}

/**
 * A string's size in UTF-8, as Decaid measures a frame. A surrogate pair is
 * four bytes, and a lone surrogate, which is sent as U+FFFD, three.
 */
export function utf8Length(text: string): number {
  return text.length + new Widths(text).extra;
}

/**
 * The frames that carry a message's encoding, in order: the encoding itself
 * if it fits in `maxFrameBytes`, otherwise chunks of it, each a frame that
 * does. `id` names the chunks' message on its connection. A chunk never ends
 * between the halves of a surrogate pair, so its data is well-formed text.
 * The encoding is scanned once; each chunk's size then comes from its
 * escaped length and that scan.
 */
export function frames(text: string, id: string, maxFrameBytes = MAX_FRAME_BYTES): Frame[] {
  const widths = new Widths(text);
  const bytes = text.length + widths.extra;
  if (bytes <= maxFrameBytes) return [{ text, bytes }];

  // The room left for a chunk's data, encoded as a JSON string, beside an
  // envelope whose index and count have as many digits as they can have.
  const room = maxFrameBytes - utf8Length(chunkFrame(id, text.length, text.length, ""));
  // Enough for any one character, so every chunk holds at least one.
  if (room < 8) throw new Error("The frame size leaves no room for a chunk's data");

  const pieces: Frame[] = [];
  // Pieces are sized a little short of the room, so few need escaping twice.
  const aim = room * 0.99;
  // Bytes per code unit in the latest piece, to size the next one.
  let ratio = 1;
  for (let start = 0; start < text.length; ) {
    let length = Math.min(text.length - start, Math.max(1, Math.floor(aim / ratio)));
    for (;;) {
      length = withoutSplitPair(text, start, length);
      const piece = JSON.stringify(text.slice(start, start + length));
      // Escaping keeps every character outside ASCII as it is, but for a lone surrogate.
      const bytes = piece.length + widths.escapedBetween(start, start + length);
      if (bytes <= room) {
        pieces.push({ text: piece, bytes });
        ratio = bytes / length;
        start += length;
        break;
      }
      // Too long. Each code unit left out takes at least a byte with it, so
      // this many fewer fits; if that leaves little, shorten in proportion.
      length = Math.max(1, length - (bytes - room), Math.floor((length * aim) / bytes));
    }
  }
  return pieces.map((piece, index) => {
    const envelope = chunkFrame(id, index, pieces.length, "");
    return { text: chunkFrame(id, index, pieces.length, piece.text), bytes: utf8Length(envelope) + piece.bytes };
  });
}

/**
 * A chunk's frame, from its data already encoded as a JSON string: the same
 * text as encoding the Chunk whole, without escaping its data twice.
 */
function chunkFrame(id: string, index: number, count: number, encodedData: string): string {
  return `{"type":"chunk","id":${JSON.stringify(id)},"index":${index},"count":${count},"data":${encodedData}}`;
}

/** A length for a slice from `start` that does not end between the halves of a surrogate pair. */
function withoutSplitPair(text: string, start: number, length: number): number {
  const end = start + length;
  const splitsPair = end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end));
  if (!splitsPair) return length;
  return length > 1 ? length - 1 : 2;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** How much a Reassembly may hold for messages still incomplete. */
export interface ReassemblyLimits {
  /** The most code units of chunk data held at once. */
  maxLength: number;
  /** The most chunks held at once, and so in one message. */
  maxChunks: number;
}

/** The limits on chunked messages from a connection whose hello was accepted. */
export const CHUNK_LIMITS: Readonly<ReassemblyLimits> = { maxLength: MAX_CHUNKED_LENGTH, maxChunks: MAX_CHUNKS };

/**
 * What a chunk did: completed its message, whose encoding is `text`, left it
 * waiting for more chunks, or showed that the chunks cannot be trusted.
 */
export type Reassembled =
  | { status: "complete"; text: string }
  | { status: "incomplete" }
  | { status: "invalid"; problem: string };

interface Incomplete {
  count: number;
  parts: (string | undefined)[];
  received: number;
  /** Code units of data held. */
  length: number;
}

/**
 * Puts one connection's chunked messages back together. A message's chunks
 * may arrive in any order, between other frames and more than once; it is
 * complete once every chunk has arrived, and none of it is held after that.
 * A chunk that contradicts an earlier one of its message (other data at the
 * same index, or another count), or that would hold more than the limits
 * allow, shows the connection's chunks cannot be trusted: everything held is
 * dropped, and no message completes from then on.
 */
export class Reassembly {
  private readonly messages = new Map<string, Incomplete>();
  private heldLength = 0;
  private heldChunks = 0;
  private problem: string | undefined;

  add(chunk: Chunk, limits: ReassemblyLimits): Reassembled {
    if (this.problem === undefined) this.problem = this.problemWith(chunk, limits);
    if (this.problem !== undefined) {
      this.messages.clear();
      this.heldLength = 0;
      this.heldChunks = 0;
      return { status: "invalid", problem: this.problem };
    }

    let message = this.messages.get(chunk.id);
    // A repeat of a chunk still held changes nothing.
    if (message?.parts[chunk.index] !== undefined) return { status: "incomplete" };
    if (!message) {
      message = { count: chunk.count, parts: new Array<string | undefined>(chunk.count), received: 0, length: 0 };
      this.messages.set(chunk.id, message);
    }
    message.parts[chunk.index] = chunk.data;
    message.received++;
    message.length += chunk.data.length;
    this.heldLength += chunk.data.length;
    this.heldChunks++;
    if (message.received < message.count) return { status: "incomplete" };

    this.messages.delete(chunk.id);
    this.heldLength -= message.length;
    this.heldChunks -= message.count;
    return { status: "complete", text: message.parts.join("") };
  }

  /** Why the chunk cannot be added, by field and never by value, or undefined if it can. */
  private problemWith(chunk: Chunk, limits: ReassemblyLimits): string | undefined {
    const { index, count, data } = chunk;
    if (!Number.isInteger(count) || count < 1 || count > limits.maxChunks) {
      return `chunk.count must be a whole number from 1 to ${limits.maxChunks}`;
    }
    if (!Number.isInteger(index) || index < 0 || index >= count) return "chunk.index must be a whole number below chunk.count";
    const message = this.messages.get(chunk.id);
    if (message && message.count !== count) return "chunk.count differs from an earlier chunk of the same message";
    const held = message?.parts[index];
    if (held !== undefined) return held === data ? undefined : "chunk.data differs from an earlier copy of the same chunk";
    if (this.heldLength + data.length > limits.maxLength || this.heldChunks + 1 > limits.maxChunks) {
      return `Chunked messages may hold at most ${limits.maxLength} characters in ${limits.maxChunks} chunks at once`;
    }
    return undefined;
  }
}
