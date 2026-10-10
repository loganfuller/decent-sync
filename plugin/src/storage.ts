import type { PluginHost, StorageCommand } from "./host.js";

// Decaid's plugin storage (`pluginStorage`), shared by everything the plugin
// keeps there: the tablet's id (tablet-id.ts) and the deliveries its outbox
// keeps across unloads (kept-deliveries.ts). Decaid answers a read with a
// `storageRead` event of `{ key, value }` and a write with a `storageWrite`
// event of only the data written, and leaves a command that fails
// unanswered, so commands go one at a time, each answered by the event that
// matches it or given up on after STORAGE_TIMEOUT_MS. A write waiting its
// turn takes the data of a later write to the same key, which then waits
// with it, so however slow Decaid is, no more writes wait than there are
// keys. Decaid stores a value only if it is not null, so nothing is ever
// deleted: a key once written stays until written again. A write sent as the
// plugin unloads still lands, as Decaid finishes a retiring generation's
// writes before the next one loads, so `stop` sends the writes still waiting
// their turn.

/** How long Decaid may take to answer a storage command before it counts as failed. */
export const STORAGE_TIMEOUT_MS = 10_000;

interface Command {
  command: StorageCommand;
  /** What the command does, for messages. */
  what: string;
  /** The event that answers it. */
  event: "storageRead" | "storageWrite";
  /** Whether that event's payload answers it. */
  answers(payload: unknown): boolean;
  /** Those waiting for it: more than one for a write that took the data of later ones. */
  waiting: { resolve(payload: unknown): void; reject(error: Error): void }[];
}

export class PluginStorage {
  /** Commands waiting their turn, in order. */
  private readonly queue: Command[] = [];
  /** The command sent and awaiting Decaid's answer. */
  private waiting: { command: Command; timer: number } | undefined;
  private stopped = false;

  constructor(private readonly host: PluginHost) {}

  /** The value at `key`, null if it was never written. Rejects, saying why, if Decaid refuses or does not answer in time. */
  async read(key: string, what: string): Promise<unknown> {
    const answer = await this.run({ type: "read", key }, what, "storageRead", (payload) => {
      return typeof payload === "object" && payload !== null && (payload as { key?: unknown }).key === key;
    });
    return (answer as { value?: unknown }).value ?? null;
  }

  /**
   * Writes `data` at `key`, or a later write's data to the same key, made
   * while this one waited its turn. Rejects, saying why, if Decaid refuses or
   * does not answer in time; it may still have written it.
   */
  async write(key: string, data: string, what: string): Promise<void> {
    // A read of the key queued between the two would read the later data. Nothing reads a key it is writing.
    const queued = this.queue.find((command) => command.command.type === "write" && command.command.key === key);
    if (!queued || this.stopped) {
      await this.run({ type: "write", key, data }, what, "storageWrite", (payload) => payload === data);
      return;
    }
    queued.command = { type: "write", key, data };
    queued.what = what;
    queued.answers = (payload) => payload === data;
    await new Promise((resolve, reject) => queued.waiting.push({ resolve, reject }));
  }

  /** A Decaid event, which may answer the command awaiting one. */
  answered(name: string, payload: unknown): void {
    const waiting = this.waiting;
    if (!waiting || name !== waiting.command.event || !waiting.command.answers(payload)) return;
    this.settle();
    for (const waiter of waiting.command.waiting) waiter.resolve(payload);
    this.next();
  }

  /**
   * Sends the writes still waiting their turn, without waiting for Decaid's
   * answers, which it no longer sends once the plugin has unloaded, and
   * gives up on the reads.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const unloading = new Error("the plugin is unloading");
    const sent = this.settle();
    if (sent) fail(sent.command, unloading);
    for (const command of this.queue.splice(0)) {
      if (command.command.type === "write") {
        try {
          this.host.storage(command.command);
        } catch {
          // Refused as it would have been in its turn.
        }
      }
      fail(command, unloading);
    }
  }

  private run(command: StorageCommand, what: string, event: Command["event"], answers: Command["answers"]): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("the plugin is unloading"));
    return new Promise((resolve, reject) => {
      this.queue.push({ command, what, event, answers, waiting: [{ resolve, reject }] });
      if (!this.waiting) this.next();
    });
  }

  /** Sends the next command waiting its turn, if any. */
  private next(): void {
    const command = this.queue.shift();
    if (!command) return;
    const timer = setTimeout(() => {
      this.settle();
      fail(command, new Error(`Decaid's plugin storage did not answer ${command.what} within ${STORAGE_TIMEOUT_MS / 1000} s`));
      this.next();
    }, STORAGE_TIMEOUT_MS);
    this.waiting = { command, timer };
    try {
      this.host.storage(command.command);
    } catch (error) {
      // Such as Decaid refusing a plugin whose manifest lacks the permission.
      this.settle();
      fail(command, new Error(`Decaid refused ${command.what}: ${error instanceof Error ? error.message : String(error)}`));
      this.next();
    }
  }

  /** Stops waiting for the answer to the command sent, returning what waited. */
  private settle(): { command: Command; timer: number } | undefined {
    const waiting = this.waiting;
    if (waiting) clearTimeout(waiting.timer);
    this.waiting = undefined;
    return waiting;
  }
}

function fail(command: Command, error: Error): void {
  for (const waiter of command.waiting) waiter.reject(error);
}
