import { type Frame, chunks, utf8Length } from "@decent-sync/protocol";

/**
 * How many bytes of chunks may await the plugin's confirmation at once.
 * Decaid closes a transport once the frames it holds for a plugin would pass
 * 1 MiB (`_enqueue` in decaid:lib/src/plugins/plugin_transport_service.dart),
 * and only the plugin's confirmations show what it holds no longer. Half the
 * limit: with MAX_UNCONFIRMED_WHOLE_BYTES, a quarter is left for the
 * connection's other messages, which are not counted. Every chunk is at most
 * MAX_FRAME_BYTES, so one always fits once the rest are confirmed.
 */
export const MAX_UNCONFIRMED_BYTES = 512 * 1024;

/**
 * The largest message sent whole, in UTF-8 bytes of its frame, at once and
 * ahead of anything waiting.
 */
export const MAX_WHOLE_BYTES = 16 * 1024;

/**
 * How many bytes of messages sent whole may be unconfirmed at once. Nothing
 * confirms a frame that is no chunk, so one counts until the plugin confirms
 * a chunk sent after it; past this, a small message goes as a chunk too.
 */
export const MAX_UNCONFIRMED_WHOLE_BYTES = 256 * 1024;

/** Frames handed to the connection that the plugin has not confirmed yet: a chunk, or the messages sent whole between two chunks. */
interface Unconfirmed {
  /** A chunk's name and index. Absent for messages sent whole, which only a later chunk's confirmation covers. */
  chunk?: { id: string; index: number };
  bytes: number;
}

interface Waiting {
  id: string;
  index: number;
  bytes: number;
  text: string;
}

/**
 * Sends one connection's writes and answers to a plugin that confirms the
 * chunks it receives (CONFIRMED_CHUNKS_WIRE_REVISION), so that what it has
 * not confirmed stays within MAX_UNCONFIRMED_BYTES of chunks and
 * MAX_UNCONFIRMED_WHOLE_BYTES of messages sent whole, three quarters of
 * Decaid's limit, whatever is in flight together (protocol/src/chunking.ts).
 *
 * A message larger than MAX_WHOLE_BYTES goes as chunks, even where it would
 * fit in one frame, each counted from when it is handed to the connection
 * until the plugin confirms it with `chunkReceived`, and waiting while
 * sending it would take the count past the limit. Decaid hands a
 * transport's frames to the plugin in order, so a confirmation also covers
 * every frame sent before it. Larger messages go in the order given, each
 * one's chunks in order, with nothing of another larger message between
 * them.
 *
 * A message of at most MAX_WHOLE_BYTES goes whole, at once, ahead of anything
 * waiting. Nothing confirms it, so it counts, against
 * MAX_UNCONFIRMED_WHOLE_BYTES of its own, until the plugin confirms a chunk
 * sent after it. While that count is full, as after many small messages
 * with no chunk among them, a small message goes as a single chunk, ahead
 * of the chunks of larger messages still waiting, and its confirmation
 * covers the whole ones before it. Small messages go in the order given,
 * so one goes whole only once none waits as a chunk.
 *
 * It belongs to its connection: what it holds goes with it, and nothing is
 * sent again from it. The connection's other messages, such as its
 * heartbeats and acknowledgments, never pass through it, so a large message
 * holds none of them up.
 */
export class Sender {
  /** The chunks of larger messages still to send. */
  private readonly waiting: Waiting[] = [];
  /** Small messages still to send, each a single chunk, which go first. */
  private readonly waitingSmall: Waiting[] = [];
  /** In the order sent. */
  private readonly unconfirmed: Unconfirmed[] = [];
  /** The bytes of the chunks unconfirmed. */
  private unconfirmedBytes = 0;
  /** The bytes of the messages sent whole that no confirmation covers yet. */
  private unconfirmedWholeBytes = 0;
  /** Names each chunked message on its connection. */
  private named = 0;

  /** `sendFrame` hands a frame to the connection, and does nothing once it is closing. */
  constructor(private readonly sendFrame: (text: string) => void) {}

  /** Sends a message, `text` its encoding. */
  send(text: string): void {
    // Every code unit takes at least a byte, so a longer encoding is not measured.
    const bytes = text.length <= MAX_WHOLE_BYTES ? utf8Length(text) : Infinity;
    const small = bytes <= MAX_WHOLE_BYTES;
    if (small && this.waitingSmall.length === 0 && this.unconfirmedWholeBytes + bytes <= MAX_UNCONFIRMED_WHOLE_BYTES) {
      // Those sent since the latest chunk are confirmed together, so they are counted together.
      const latest = this.unconfirmed.at(-1);
      if (latest && !latest.chunk) latest.bytes += bytes;
      else this.unconfirmed.push({ bytes });
      this.unconfirmedWholeBytes += bytes;
      return this.sendFrame(text);
    }
    // Named by the connection's own count, not by the message's id: a request's id is its plugin's to choose, and
    // two messages put back together at once must not share a name.
    const id = `message-${++this.named}`;
    const queue = small ? this.waitingSmall : this.waiting;
    chunks(text, id).forEach((frame: Frame, index) => queue.push({ id, index, bytes: frame.bytes, text: frame.text }));
    this.pump();
  }

  /** The plugin received a chunk, and so every frame sent before it. One naming no chunk in flight changes nothing. */
  received(id: string, index: number): void {
    const at = this.unconfirmed.findIndex(({ chunk }) => chunk?.id === id && chunk.index === index);
    if (at < 0) return;
    for (const { chunk, bytes } of this.unconfirmed.splice(0, at + 1)) {
      if (chunk) this.unconfirmedBytes -= bytes;
      else this.unconfirmedWholeBytes -= bytes;
    }
    this.pump();
  }

  private pump(): void {
    for (;;) {
      // A small message's chunk is whole by itself, so it may go between two chunks of a larger message.
      const queue = this.waitingSmall.length > 0 ? this.waitingSmall : this.waiting;
      if (queue.length === 0 || this.unconfirmedBytes + queue[0]!.bytes > MAX_UNCONFIRMED_BYTES) return;
      const { id, index, bytes, text } = queue.shift()!;
      this.unconfirmed.push({ chunk: { id, index }, bytes });
      this.unconfirmedBytes += bytes;
      this.sendFrame(text);
    }
  }
}
