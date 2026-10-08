// Messages too large for one frame. Either end sends such a message as
// ordered chunks, each a frame of its own, and the other puts it back
// together before handling it like any other message: the plugin its
// deliveries, and the server a Library item it writes to the tablet.
//
// Decaid's transport holds at most 1 MiB of a plugin's frames awaiting the
// network, one frame or all those queued together (`_reserveOutbound` in
// decaid:lib/src/plugins/plugin_transport_service.dart), and refuses an
// inbound frame that would take what it holds for the plugin past 1 MiB
// (`_enqueue`), so frames stay well below that. Sizes are UTF-8 bytes of a
// whole frame, as Decaid counts them, with its envelope and JSON escaping.

/**
 * The largest frame either end sends, in UTF-8 bytes. A message whose
 * encoding is larger goes as chunks, each a frame of at most this size.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

/**
 * The most UTF-16 code units held for chunked messages still incomplete,
 * their ids included, and so about the longest message put back together
 * from chunks. Decaid's fetch returns at most 10 MiB, so no message the
 * plugin builds from what it reads comes near it.
 */
export const MAX_CHUNKED_LENGTH = 16 * 1024 * 1024;

/**
 * The most chunks the messages still incomplete may have between them,
 * counting those yet to arrive, and so the most in one message. A message of
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

/** A run of ASCII, matched from where the count has got to. */
const ASCII_RUN = /[\x00-\x7f]*/y;

/**
 * How many ASCII code units in a row the count steps through, one at a time,
 * before matching the rest of their run in one go.
 */
const ASCII_STEPS = 32;

/**
 * A string's size in UTF-8, as Decaid measures a frame. A surrogate pair is
 * four bytes, and a lone surrogate, which is sent as U+FFFD, three. Decaid
 * gives plugins no TextEncoder. In QuickJS, the engine it runs them in on
 * Android, a regular expression passes over a long run far faster than a
 * loop, but each match costs as much as dozens of steps of one. So only long
 * runs of ASCII, the bulk of most messages, are matched; everything else is
 * stepped through, and text that keeps switching between ASCII and other
 * characters costs little more than the loop alone.
 */
export function utf8Length(text: string): number {
  const length = text.length;
  let bytes = length;
  for (let at = 0; at < length; ) {
    ASCII_RUN.lastIndex = at;
    ASCII_RUN.test(text);
    at = ASCII_RUN.lastIndex;
    for (let ascii = 0; at < length && ascii < ASCII_STEPS; at++) {
      // Compared inline, since QuickJS calls functions slowly.
      const unit = text.charCodeAt(at);
      if (unit < 0x80) ascii++;
      else {
        ascii = 0;
        if (unit < 0x800) bytes += 1;
        else {
          // Three bytes, or four with the low half of a surrogate pair.
          bytes += 2;
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(at + 1);
            if (next >= 0xdc00 && next <= 0xdfff) at++;
          }
        }
      }
    }
  }
  return bytes;
}

/**
 * The frames that carry a message's encoding, in order: the encoding itself
 * if it fits in `maxFrameBytes`, otherwise chunks of it, each a frame that
 * does. `id` names the chunks' message on its connection. A chunk never ends
 * between the halves of a surrogate pair, so its data is well-formed text.
 * Each chunk's size is counted from its data as escaped for the frame.
 */
export function frames(text: string, id: string, maxFrameBytes = MAX_FRAME_BYTES): Frame[] {
  // Every code unit takes at least a byte, so a longer encoding cannot fit, and is not counted whole.
  if (text.length <= maxFrameBytes) {
    const bytes = utf8Length(text);
    if (bytes <= maxFrameBytes) return [{ text, bytes }];
  }

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
      const bytes = utf8Length(piece);
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
  /** The most code units held at once: the messages' ids and their chunks' data. */
  maxLength: number;
  /** The most chunks the messages may have between them, counting those yet to arrive, and so the most in one message. */
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
  /** Code units held for it: its id and its chunks' data. */
  length: number;
}

/**
 * Puts one connection's chunked messages back together. A message's chunks
 * may arrive in any order, between other frames and more than once; it is
 * complete once every chunk has arrived, and none of it is held after that.
 * A chunk that contradicts an earlier one of its message (other data at the
 * same index, or another count), or that would hold more than the limits
 * allow, shows the connection's chunks cannot be trusted: everything held is
 * dropped, and no message completes from then on. Everything a message holds
 * counts against the limits from its first chunk: its id, its chunks' data,
 * and a place for each chunk it says it has.
 */
export class Reassembly {
  private readonly messages = new Map<string, Incomplete>();
  /** Code units held: the messages' ids and their chunks' data. */
  private heldLength = 0;
  /** Chunks the messages have between them, counting those yet to arrive. */
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
      message = { count: chunk.count, parts: new Array<string | undefined>(chunk.count), received: 0, length: chunk.id.length };
      this.messages.set(chunk.id, message);
      this.heldLength += chunk.id.length;
      this.heldChunks += chunk.count;
    }
    message.parts[chunk.index] = chunk.data;
    message.received++;
    message.length += chunk.data.length;
    this.heldLength += chunk.data.length;
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
    // A message's first chunk brings its id and the places for all its chunks.
    const length = data.length + (message ? 0 : chunk.id.length);
    const chunks = message ? 0 : count;
    if (this.heldLength + length > limits.maxLength || this.heldChunks + chunks > limits.maxChunks) {
      return `Chunked messages still incomplete may hold at most ${limits.maxLength} characters, ids included, and ${limits.maxChunks} chunks between them`;
    }
    return undefined;
  }
}
