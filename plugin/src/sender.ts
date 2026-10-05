import { type Frame, type PluginMessage, encode, frames } from "@decent-sync/protocol";

/**
 * How many bytes of counted frames may await the server's confirmation at
 * once. Decaid refuses a send that would take a transport's pending outbound
 * bytes past 1 MiB (`_reserveOutbound` in plugin_transport_service.dart), and
 * its `send` resolves once a frame is queued, not once it is written, so only
 * the server's replies show what has left the tablet. Half the limit leaves
 * the rest for a hello and heartbeats, which are not counted. Every frame is
 * at most MAX_FRAME_BYTES, so one always fits once the rest are confirmed.
 */
const MAX_UNCONFIRMED_BYTES = 512 * 1024;

interface Queued {
  /** The id the server confirms its frames by: its own, or its chunks'. */
  id: string;
  frames: Frame[];
  /** How many of its frames have been handed to Decaid. */
  sent: number;
  resolve(): void;
  reject(error: Error): void;
}

/** A frame handed to Decaid that the server has not confirmed yet. */
interface Unconfirmed {
  id: string;
  /** A chunk's index; absent for a whole delivery, which its ack confirms. */
  index?: number;
  bytes: number;
}

/**
 * Sends messages on one transport, each in a frame of its own or, if too
 * large for one, in chunks (protocol/src/chunking.ts), in the order given.
 *
 * Deliveries (messages with an id, which the server acknowledges once stored)
 * and chunks are counted from when they are handed to Decaid until the
 * server confirms them, by the delivery's `ack` or the chunk's
 * `chunkReceived`, and wait while sending them would take the count past
 * MAX_UNCONFIRMED_BYTES. Decaid writes a transport's frames in order, so a
 * confirmation also covers every frame sent before it. A message without an
 * id that fits in one frame, a `hello` or `heartbeat`, is sent at once, ahead
 * of anything waiting, and not counted, so a large delivery never holds up
 * the heartbeats that keep the connection open.
 */
export class Sender {
  private readonly queue: Queued[] = [];
  private readonly unconfirmed: Unconfirmed[] = [];
  private unconfirmedBytes = 0;
  private sending = false;
  /** Set once the transport closed or refused a frame; nothing more is sent. */
  private failure: Error | undefined;
  /** Names chunked messages that have no id of their own. */
  private unnamed = 0;

  constructor(private readonly sendFrame: (frame: string) => Promise<void>) {}

  /** Resolves once every frame of the message has been handed to Decaid; rejects if the transport fails first. */
  async send(message: PluginMessage): Promise<void> {
    if (this.failure) throw this.failure;
    const id = "id" in message ? message.id : undefined;
    const name = id ?? `message-${++this.unnamed}`;
    const encoded = frames(encode(message), name);
    if (encoded.length === 1 && id === undefined) return this.sendFrame(encoded[0]!.text);
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ id: name, frames: encoded, sent: 0, resolve, reject });
      void this.pump();
    });
  }

  /** The server received a chunk. */
  received(id: string, index: number): void {
    this.confirm(id, index);
  }

  /** The server stored a delivery. */
  acknowledged(id: string): void {
    this.confirm(id, undefined);
  }

  /** Fails every message not yet handed to Decaid in full, as the transport has closed. */
  close(error = new Error("The connection closed")): void {
    if (this.failure) return;
    this.failure = error;
    for (const queued of this.queue.splice(0)) queued.reject(error);
    this.unconfirmed.length = 0;
    this.unconfirmedBytes = 0;
  }

  private confirm(id: string, index: number | undefined): void {
    const at = this.unconfirmed.findIndex((frame) => frame.id === id && frame.index === index);
    if (at < 0) return;
    for (const frame of this.unconfirmed.splice(0, at + 1)) this.unconfirmedBytes -= frame.bytes;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (!this.failure && this.queue.length > 0) {
        const next = this.queue[0]!;
        const frame = next.frames[next.sent]!;
        // A confirmation pumps again.
        if (this.unconfirmedBytes + frame.bytes > MAX_UNCONFIRMED_BYTES) return;
        this.unconfirmed.push({ id: next.id, index: next.frames.length > 1 ? next.sent : undefined, bytes: frame.bytes });
        this.unconfirmedBytes += frame.bytes;
        next.sent++;
        await this.sendFrame(frame.text);
        if (this.failure) return;
        if (next.sent === next.frames.length) {
          this.queue.shift();
          next.resolve();
        }
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.sending = false;
    }
  }
}
