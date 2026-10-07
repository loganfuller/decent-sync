import { isTabletId } from "@decent-sync/protocol";
import { keepStorageInBackups } from "./decaid.js";
import type { PluginHost, StorageCommand } from "./host.js";

// This tablet's id (ADR-0006). Decaid gives plugins no installation id, so the
// plugin makes one, a random UUID, when its key in Decaid's plugin storage was
// never written, and keeps it there, where it survives plugin updates.
// Resetting the tablet's Decaid data loses it, and the next load makes a new
// one: the server then sees a new tablet, which can miss a delete but never
// invent one. Decaid answers storage commands with events and leaves a failed
// one unanswered, so each waits at most STORAGE_TIMEOUT_MS. A read that fails
// is retried by the caller, and never taken for a key never written. Decaid's
// backups hold the id only once its store API has read the plugin's storage
// since Decaid started, so the plugin has it read there on every load, asking
// again until it answers.

/** The id's key in this plugin's storage. */
const KEY = "tabletId";
/** How long Decaid may take to answer a storage command before it counts as failed. */
const STORAGE_TIMEOUT_MS = 10_000;
/** How long to wait before asking Decaid's store API again to read the plugin's storage, after it failed to. */
const BACKUP_RETRY_MS = 30_000;

/** A storage command awaiting Decaid's answer. */
interface Waiting {
  /** The event that answers it. */
  event: "storageRead" | "storageWrite";
  /** Whether that event's payload answers it. */
  answers(payload: unknown): boolean;
  resolve(payload: unknown): void;
  reject(error: Error): void;
  timer: number;
}

export class TabletId {
  /** Known once read or made, for as long as this load lasts. */
  private id: string | undefined;
  /** The read of the id under way, shared by callers meanwhile. */
  private reading: Promise<string> | undefined;
  /** Commands go one at a time. */
  private waiting: Waiting | undefined;
  /** The next attempt to have Decaid's backups include the id, while one is due. */
  private backupRetry: number | undefined;
  private stopped = false;

  constructor(
    private readonly host: PluginHost,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * The tablet's id: the one in plugin storage, or, if that key was never
   * written, a new one, once Decaid has written it there. Rejects, saying
   * why, if Decaid refuses or does not answer in time; reading again later
   * retries.
   */
  read(): Promise<string> {
    if (this.id !== undefined) return Promise.resolve(this.id);
    this.reading ??= this.readOrMake().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  /** A Decaid event, which may answer the storage command awaiting one. */
  answered(name: string, payload: unknown): void {
    const waiting = this.waiting;
    if (!waiting || name !== waiting.event || !waiting.answers(payload)) return;
    this.settle();
    waiting.resolve(payload);
  }

  stop(): void {
    this.stopped = true;
    if (this.backupRetry !== undefined) clearTimeout(this.backupRetry);
    this.settle()?.reject(new Error("the plugin is unloading"));
  }

  private async readOrMake(): Promise<string> {
    const read = await this.command("a read of this tablet's id", { type: "read", key: KEY }, "storageRead", (payload) => {
      return typeof payload === "object" && payload !== null && (payload as { key?: unknown }).key === KEY;
    });
    const stored = (read as { value?: unknown }).value ?? null;
    if (isTabletId(stored)) return this.known(stored);

    const made = newTabletId();
    await this.command("the write of this tablet's new id", { type: "write", key: KEY, data: made }, "storageWrite", (payload) => payload === made);
    this.log(
      stored === null
        ? `This tablet had no id in Decaid's plugin storage, so it was given one: ${made}.`
        : `This tablet's id in Decaid's plugin storage was not a UUID, so it was given a new one: ${made}.`,
    );
    return this.known(made);
  }

  /** Keeps the id, once read or written, for this load, and has Decaid's backups include it. */
  private known(id: string): string {
    this.id = id;
    void this.keepInBackups();
    return id;
  }

  /** Has Decaid's store API read the plugin's storage, so backups hold the id, asking again until it answers. */
  private async keepInBackups(): Promise<void> {
    if ((await keepStorageInBackups()) || this.stopped) return;
    this.backupRetry = setTimeout(() => {
      this.backupRetry = undefined;
      void this.keepInBackups();
    }, BACKUP_RETRY_MS);
  }

  /**
   * Sends a storage command, `what` for the log, and resolves with the
   * payload of the `event` that `answers` it.
   */
  private command(what: string, command: StorageCommand, event: Waiting["event"], answers: Waiting["answers"]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle();
        reject(new Error(`Decaid's plugin storage did not answer ${what} within ${STORAGE_TIMEOUT_MS / 1000} s`));
      }, STORAGE_TIMEOUT_MS);
      this.waiting = { event, answers, resolve, reject, timer };
      try {
        this.host.storage(command);
      } catch (error) {
        // Such as Decaid refusing a plugin whose manifest lacks the permission.
        this.settle();
        reject(new Error(`Decaid refused ${what}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /** Stops waiting for the answer to the command, returning what waited. */
  private settle(): Waiting | undefined {
    const waiting = this.waiting;
    if (waiting) clearTimeout(waiting.timer);
    this.waiting = undefined;
    return waiting;
  }
}

/**
 * A random version 4 UUID. Math.random is the only randomness Decaid's
 * runtime offers, and enough: a tablet id need only differ from other
 * tablets', since the token, not the id, is what a tablet connects with.
 */
function newTabletId(): string {
  const hex = (digits: number) => {
    let text = "";
    for (let digit = 0; digit < digits; digit++) text += Math.floor(Math.random() * 16).toString(16);
    return text;
  };
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}
