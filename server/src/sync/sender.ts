import { type Frame, chunks, utf8Length } from "@decent-sync/protocol";

/**
 * How many bytes of chunks may await the plugin's confirmation at once.
 * Decaid closes a transport once the frames it holds for a plugin would pass
 * 1 MiB (`_enqueue` in decaid:lib/src/plugins/plugin_transport_service.dart),
 * and only the plugin's confirmations show what it holds no longer. Half the
 * limit leaves the rest for the frames that are not counted. Every chunk is
 * at most MAX_FRAME_BYTES, so one always fits once the rest are confirmed.
 */
export const MAX_UNCONFIRMED_BYTES = 512 * 1024;

/**
 * The largest message sent whole, in UTF-8 bytes of its frame: at once and
 * not counted, as nothing confirms a frame that is no chunk. Small enough
 * that the half of Decaid's limit the chunks leave holds 32 of them, where
 * the server sends a tablet one write at a time and an answer for each
 * request its plugin has made.
 */
export const MAX_WHOLE_BYTES = 16 * 1024;

/** A chunk handed to the connection that the plugin has not confirmed yet. */
interface Unconfirmed {
  id: string;
  index: number;
  bytes: number;
}

interface Waiting extends Unconfirmed {
  text: string;
}

/**
 * Sends one connection's writes and answers to a plugin that confirms the
 * chunks it receives (CONFIRMED_CHUNKS_WIRE_REVISION), so that what it has
 * not confirmed stays within MAX_UNCONFIRMED_BYTES, whatever is in flight
 * together (protocol/src/chunking.ts).
 *
 * A message of at most MAX_WHOLE_BYTES goes whole, at once, ahead of anything
 * waiting, and is not counted. A larger one goes as chunks, even where it
 * would fit in one frame, each counted from when it is handed to the
 * connection until the plugin confirms it with `chunkReceived`, and waiting
 * while sending it would take the count past the limit. Decaid hands a
 * transport's frames to the plugin in order, so a confirmation also covers
 * every chunk sent before it. Messages go in the order given, each one's
 * chunks together and in order.
 *
 * It belongs to its connection: what it holds goes with it, and nothing is
 * sent again from it. The connection's other messages, such as its
 * heartbeats and acknowledgments, never pass through it, so a large message
 * holds none of them up.
 */
export class Sender {
  private readonly waiting: Waiting[] = [];
  private readonly unconfirmed: Unconfirmed[] = [];
  private unconfirmedBytes = 0;
  /** Names each chunked message on its connection. */
  private named = 0;

  /** `sendFrame` hands a frame to the connection, and does nothing once it is closing. */
  constructor(private readonly sendFrame: (text: string) => void) {}

  /** Sends a message, `text` its encoding. */
  send(text: string): void {
    // Every code unit takes at least a byte, so a longer encoding is not counted whole.
    if (text.length <= MAX_WHOLE_BYTES && utf8Length(text) <= MAX_WHOLE_BYTES) return this.sendFrame(text);
    // Named by the connection's own count, not by the message's id: a request's id is its plugin's to choose, and
    // two messages put back together at once must not share a name.
    const id = `message-${++this.named}`;
    chunks(text, id).forEach((frame: Frame, index) => this.waiting.push({ id, index, bytes: frame.bytes, text: frame.text }));
    this.pump();
  }

  /** The plugin received a chunk. One naming no chunk in flight changes nothing. */
  received(id: string, index: number): void {
    const at = this.unconfirmed.findIndex((chunk) => chunk.id === id && chunk.index === index);
    if (at < 0) return;
    for (const chunk of this.unconfirmed.splice(0, at + 1)) this.unconfirmedBytes -= chunk.bytes;
    this.pump();
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.unconfirmedBytes + this.waiting[0]!.bytes <= MAX_UNCONFIRMED_BYTES) {
      const { text, ...chunk } = this.waiting.shift()!;
      this.unconfirmed.push(chunk);
      this.unconfirmedBytes += chunk.bytes;
      this.sendFrame(text);
    }
  }
}
