import type { MachineStateDelivery, PluginMessage, ShotDelivery, ShotIndex, WorkflowDelivery } from "@decent-sync/protocol";

/** Every message the server acknowledges once it has stored it. */
export type Delivery = ShotDelivery | ShotIndex | WorkflowDelivery | MachineStateDelivery;

/** How long to wait before trying again when a delivery could not be produced or sent. */
const RETRY_MS = 5_000;

/**
 * Deliveries produced only when the outbox has nothing queued, as backfill
 * fetches each Shot the server requested only when its turn comes.
 */
export interface Backlog {
  /** Whether it has anything left to produce. */
  hasMore(): boolean;
  /** The next delivery, or null if what it had is gone. Throws if it cannot be produced now; the outbox tries again later. */
  next(): Promise<Delivery | null>;
}

/**
 * The plugin's one outbox, at least once: every delivery waits in order until
 * the server acknowledges it, and is sent again on the next connection if it
 * was not. One awaits acknowledgment at a time; the connection's Sender keeps
 * it, chunked or not, within Decaid's pending limit. It lives in memory for
 * one runtime, so an unload loses what it holds; Shots and edits are
 * recovered by the next load's reconciliation.
 */
export class Outbox {
  private readonly queued = new Map<string, Delivery>();
  private readonly runtimeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  private sendMessage?: (message: PluginMessage) => Promise<void>;
  private generation = 0;
  private sent?: string;
  private working = false;
  private stopped = false;
  private retryTimer?: number;
  private backlog?: Backlog;

  constructor(private readonly log: (message: string) => void) {}

  /** An id for a new delivery, unique to this runtime. */
  nextId(): string { return `${this.runtimeId}-${++this.sequence}`; }

  /** How many deliveries await acknowledgment. */
  get size(): number { return this.queued.size; }

  /** Whether the delivery awaits acknowledgment. */
  has(id: string): boolean { return this.queued.has(id); }

  /** Draws on the backlog whenever nothing is queued. */
  drawOn(backlog: Backlog): void { this.backlog = backlog; }

  enqueue(message: Delivery): void {
    this.queued.set(message.id, message);
    this.pump();
  }

  /** A connection was welcomed: sends through it, starting with what the last one left unacknowledged. */
  welcome(send: (message: PluginMessage) => Promise<void>): void {
    this.sendMessage = send;
    this.generation++;
    this.sent = undefined;
    this.pump();
  }

  disconnected(): void {
    this.sendMessage = undefined;
    this.generation++;
    this.sent = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.disconnected();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
  }

  acknowledge(id: string): void {
    this.queued.delete(id);
    if (this.sent === id) this.sent = undefined;
    this.pump();
  }

  /** One logical message awaits acknowledgment at a time. */
  pump(): void {
    if (this.retryTimer !== undefined || this.working || this.stopped || !this.sendMessage || this.sent !== undefined) return;
    if (this.queued.size === 0 && !this.backlog?.hasMore()) return;
    this.working = true;
    void this.work().catch(() => {
      // SyncConnection drops a transport whose send failed; the outbox stays for its replacement.
      this.log("Delivery interrupted; unacknowledged data remains queued.");
      this.retry();
    }).finally(() => {
      this.working = false;
      if (!this.stopped && this.sendMessage && this.sent === undefined) this.pump();
    });
  }

  /** Tries again after a while, as after a failure that may pass. */
  retry(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, RETRY_MS);
  }

  private async work(): Promise<void> {
    const generation = this.generation;
    if (this.queued.size === 0 && this.backlog?.hasMore()) {
      const produced = await this.backlog.next();
      if (this.stopped) return;
      if (produced) this.queued.set(produced.id, produced);
    }
    if (generation !== this.generation || !this.sendMessage) return;
    const next = this.queued.entries().next().value;
    if (!next) return;
    const [id, message] = next;
    this.sent = id;
    await this.sendMessage(message);
  }
}
