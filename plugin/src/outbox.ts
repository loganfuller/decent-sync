import type {
  CollectionDelivery,
  ItemDeleted,
  ItemLeftOut,
  ItemWritten,
  MachineStateDelivery,
  PluginMessage,
  ShotDelivery,
  ShotIndex,
  SteamDelivery,
  SteamIndex,
  WorkflowDelivery,
  WriteRefused,
} from "@decent-sync/protocol";

/**
 * A logical delivery, acknowledged once the server has stored it: a record,
 * a page of an index, a Workflow or machine state event, a collection, or
 * the answer to one of the server's Library writes.
 */
export type Delivery =
  | ShotDelivery
  | ShotIndex
  | SteamDelivery
  | SteamIndex
  | WorkflowDelivery
  | MachineStateDelivery
  | CollectionDelivery
  | ItemWritten
  | ItemDeleted
  | ItemLeftOut
  | WriteRefused;

/** The kinds of record the server can request by their ids. */
export type RecordKind = "shot" | "steam";

const RECORD_NAMES: Readonly<Record<RecordKind, string>> = { shot: "Shot", steam: "Steam Record" };

/**
 * Reads a requested record from Decaid's API as a delivery with the given id:
 * null if the tablet no longer has it, or it is not a record Decent Sync
 * sends. Throws if it cannot be read now, so it is tried again later.
 */
export type RecordReader = (id: string, deliveryId: string) => Promise<Delivery | null>;

/** Index pages wait while this many deliveries are queued. */
const SHORT_OUTBOX = 4;

/**
 * The plugin's one at-least-once outbox, for Shots, Steam Records and their
 * indices, Workflow and machine state events, collections, and the answers
 * to the server's Library writes, in memory for one runtime:
 * a reload loses what it holds, and the indices sent after the reload
 * recover the records. A delivery stays until the server acknowledges it.
 * One logical delivery awaits acknowledgment at a time; the connection's
 * Sender keeps it, chunked or not, within Decaid's pending limit. Requested
 * records, those new on the tablet first, are read from Decaid's API one at
 * a time, when a connection is sending and nothing else is queued, so while
 * the server is unreachable only their ids are held.
 */
export class Outbox {
  private readonly queued = new Map<string, Delivery>();
  private readonly watchers: ((delivery: Delivery) => void)[] = [];
  private readonly requested = new Map<string, { kind: RecordKind; id: string }>();
  private readonly runtimeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  private sendMessage?: (message: PluginMessage) => Promise<void>;
  /** Bumped by every welcome and disconnect, so a send prepared for one connection is not made on the next. */
  private connections = 0;
  /** The delivery awaiting acknowledgment. */
  private sent?: string;
  /** Deliveries handed to a connection at least once and not yet acknowledged. */
  private readonly handed = new Set<string>();
  private working = false;
  private stopped = false;
  private retryTimer?: number;

  constructor(
    private readonly log: (message: string) => void,
    private readonly readers: Readonly<Record<RecordKind, RecordReader>>,
  ) {}

  /** Whether a welcomed connection is sending. */
  get connected(): boolean { return this.sendMessage !== undefined; }

  welcome(send: (message: PluginMessage) => Promise<void>): void {
    this.sendMessage = send;
    this.connections++;
    this.sent = undefined;
    this.pump();
  }

  disconnected(): void {
    this.sendMessage = undefined;
    this.connections++;
    this.sent = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.disconnected();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
  }

  enqueue(delivery: Delivery): void {
    this.queued.set(delivery.id, delivery);
    for (const watcher of this.watchers) watcher(delivery);
    this.pump();
  }

  acknowledge(id: string): void {
    this.queued.delete(id);
    this.handed.delete(id);
    if (this.sent === id) this.sent = undefined;
    this.pump();
  }

  /** The ids of the records of that kind still to be read and sent. */
  requestedIds(kind: RecordKind): string[] {
    return [...this.requested.values()].filter((record) => record.kind === kind).map((record) => record.id);
  }

  /** Calls `watcher` with every delivery queued from now on, those read for the server's requests included. */
  watch(watcher: (delivery: Delivery) => void): void {
    this.watchers.push(watcher);
  }

  /** Drops a queued delivery that a newer one makes unnecessary; one being sent now stays, to be acknowledged. */
  discard(id: string): void {
    if (this.sent === id) return;
    this.queued.delete(id);
    this.handed.delete(id);
  }

  /**
   * Drops a queued delivery that a newer one makes unnecessary, unless it
   * was ever handed to a connection. One sent before a reconnect may still
   * be being stored by the server instance that received it; sent again,
   * ahead of the newer one, it is found already handled, or waited for, so
   * it can never be stored after the newer one.
   */
  supersede(id: string): void {
    if (!this.handed.has(id)) this.queued.delete(id);
  }

  /**
   * Records to read and send: requested by the server, after those already
   * requested, where a record requested again keeps its place, or, with
   * `first`, ahead of them all, as for records new on the tablet.
   */
  request(kind: RecordKind, ids: string[], options: { first?: boolean } = {}): void {
    const records = ids.map((id) => [`${kind}:${id}`, { kind, id }] as const);
    if (options.first) {
      const keys = new Set<string>(records.map(([key]) => key));
      const others = [...this.requested].filter(([key]) => !keys.has(key));
      this.requested.clear();
      for (const [key, record] of [...records, ...others]) this.requested.set(key, record);
    } else {
      for (const [key, record] of records) this.requested.set(key, record);
    }
    this.pump();
  }

  /** Resolves once few enough deliveries are queued for an index to add a page. */
  async waitForRoom(): Promise<void> {
    while (!this.stopped && this.queued.size >= SHORT_OUTBOX) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  nextId(): string { return `${this.runtimeId}-${++this.sequence}`; }

  private pump(): void {
    if (this.retryTimer !== undefined || this.working || this.stopped || !this.sendMessage || this.sent !== undefined || (this.queued.size === 0 && this.requested.size === 0)) return;
    this.working = true;
    void this.work().catch(() => {
      // Only a send fails here: SyncConnection drops a transport whose send failed; the outbox stays for its replacement.
      this.log("Delivery interrupted; unacknowledged data remains queued.");
      this.retry();
    }).finally(() => {
      this.working = false;
      if (!this.stopped && this.sendMessage && this.sent === undefined) this.pump();
    });
  }

  private async work(): Promise<void> {
    const generation = this.connections;
    if (this.queued.size === 0 && this.requested.size > 0) {
      const [key, record] = this.requested.entries().next().value!;
      let delivery: Delivery | null;
      try { delivery = await this.readers[record.kind](record.id, this.nextId()); }
      catch {
        // Retry it after the others, so one unreadable record cannot hold up the rest.
        this.requested.delete(key);
        this.requested.set(key, record);
        this.log(`Could not read ${RECORD_NAMES[record.kind]} ${record.id} from Decaid; retrying it after the other requested records.`);
        this.retry();
        return;
      }
      if (this.stopped) return;
      this.requested.delete(key);
      // A record deleted on the tablet is absent; nothing deletes its server copy.
      if (delivery) {
        this.queued.set(delivery.id, delivery);
        for (const watcher of this.watchers) watcher(delivery);
      }
    }
    if (generation !== this.connections || !this.sendMessage) return;
    const next = this.queued.entries().next().value;
    if (!next) return;
    const [id, message] = next;
    this.sent = id;
    this.handed.add(id);
    await this.sendMessage(message);
  }

  private retry(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 5_000);
  }
}
