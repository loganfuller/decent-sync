import type { SteamDelivery } from "@decent-sync/protocol";
import { readLatestSteamId, readSteam, readSteamIds } from "./decaid.js";
import { utcTime } from "./local-time.js";
import type { Outbox } from "./outbox.js";

const PAGE_SIZE = 100;
/** Poll intervals from one read of every id to the next, once the index has been read. */
const FULL_READ_INTERVALS = 10;
/** The most poll intervals a failed read of every id waits before it is tried again. */
const MAX_RETRY_INTERVALS = 64;

/**
 * Steam Records, through the outbox. Decaid has no event for them, so every
 * poll interval, while a connection is welcomed, the plugin reads the newest
 * one's id, whose cost does not grow with history, and requests it from the
 * outbox, ahead of backfill, if it had not seen it; the outbox reads
 * requested records one at a time. Once per load it reads every id and sends
 * them as `steamIndex` pages, so the server requests those it lacks: the
 * tablet's history, and whatever was recorded while the plugin was unloaded.
 * A disconnect pauses the index and the next welcome resumes it; nothing
 * sends it again. After that it reads every id at most once every
 * FULL_READ_INTERVALS, requesting those it had not seen: several recorded in
 * one interval, one whose time is not the newest, and those recorded while
 * disconnected. A failed read of every id, as past Decaid's fetch limit, is
 * logged once per load and tried again after more and more intervals, while
 * the newest go on being sent. The two reads run apart, so a slow read of
 * every id holds up no read of the newest; at a load's first welcome the
 * newest may be requested before the index is read, and sent though the
 * server has it. Decaid offers no way to detect an edit to a Steam Record, so
 * edits are not sent.
 */
export class SteamCapture {
  /** Every id this load has seen, in reads of every id and of the newest. */
  private readonly known = new Set<string>();
  /** Whether every id has been read for the index. */
  private indexed = false;
  /** Whole poll intervals since the last read of every id began, or failed; one begun or failed between intervals counts from the next. */
  private intervalsSinceFullRead = 0;
  /** Intervals that must begin after a read of every id before the next; none before the first. */
  private fullReadWait = 0;
  /** Reads of every id that have failed in a row. */
  private failures = 0;
  private failureLogged = false;
  private readingAll = false;
  private readingLatest = false;
  private stopped = false;
  private pollTimer?: number;

  constructor(
    private readonly outbox: Outbox,
    private readonly pollMs: number,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
  }

  /**
   * Polls at once, between intervals, which go on as they were: the poll
   * finds what was recorded while disconnected, and starts the load's index.
   */
  welcome(): void {
    this.poll(false);
  }

  /** A Steam Record, as a delivery placed in time, or null if the tablet no longer has it or its time cannot be read. */
  async read(id: string, deliveryId: string): Promise<SteamDelivery | null> {
    const steam = await readSteam(id);
    if (!steam) return null;
    const steamedAt = utcTime(steam.timestamp);
    if (steamedAt === null) {
      this.log(`Not sending Steam Record ${id}: its time is not one Decaid writes.`);
      return null;
    }
    return { type: "steam", id: deliveryId, steamId: id, steamedAt, steam };
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.intervalsSinceFullRead++;
      // While disconnected an interval passes with nothing read; the polls from the next welcome find what was recorded meanwhile.
      this.poll(true);
      if (!this.stopped) this.schedulePoll();
    }, this.pollMs);
  }

  /**
   * Requests the Steam Records new since the last poll, ahead of those the
   * server requested: the newest, and, when they are due, any that every id
   * shows. Each read is skipped while its last one still runs.
   */
  private poll(atInterval: boolean): void {
    if (this.stopped || !this.outbox.connected) return;
    if (!this.readingAll && this.intervalsSinceFullRead >= this.fullReadWait) void this.readAll(atInterval);
    if (!this.readingLatest) void this.readLatest();
  }

  private async readLatest(): Promise<void> {
    this.readingLatest = true;
    try {
      const latest = await readLatestSteamId();
      if (latest !== null && !this.stopped) this.request([latest]);
    } catch {
      // The next poll reads it again.
    } finally {
      this.readingLatest = false;
    }
  }

  /** Reads every id: the first time, to send them as the index; after that, to request those not seen. */
  private async readAll(atInterval: boolean): Promise<void> {
    this.readingAll = true;
    this.intervalsSinceFullRead = atInterval ? 0 : -1;
    let ids: string[];
    try {
      ids = await readSteamIds();
    } catch (error) {
      // Once the index has been read, a retry waits at least as long as the next read would have. It waits from
      // the failure, so a read slow to fail, as one Decaid times out after 30 s, does not use up the wait.
      this.intervalsSinceFullRead = -1;
      this.fullReadWait = Math.min((this.indexed ? FULL_READ_INTERVALS : 1) * 2 ** this.failures, MAX_RETRY_INTERVALS);
      this.failures++;
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.log(
          `Could not read the Steam Record ids: ${error instanceof Error ? error.message : String(error)}. ` +
            "New Steam Records are still sent; reading every id is tried again less and less often until it succeeds.",
        );
      }
      return;
    } finally {
      this.readingAll = false;
    }
    this.fullReadWait = FULL_READ_INTERVALS;
    this.failures = 0;
    if (this.stopped) return;
    if (this.indexed) {
      this.request(ids);
      return;
    }
    this.indexed = true;
    for (const id of ids) this.known.add(id);
    void this.sendIndex(ids);
  }

  /** Requests the Steam Records among these not seen before, ahead of those the server requested. */
  private request(ids: string[]): void {
    const fresh = ids.filter((id) => !this.known.has(id));
    for (const id of fresh) this.known.add(id);
    if (fresh.length > 0) this.outbox.request("steam", fresh, { first: true });
  }

  /**
   * Queues the index in pages, each once few deliveries are queued. While
   * disconnected the outbox sends nothing, so the pages wait, and the next
   * welcome sends those left, after any it had sent and not had acknowledged.
   */
  private async sendIndex(ids: string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      await this.outbox.waitForRoom();
      if (this.stopped) return;
      this.outbox.enqueue({ type: "steamIndex", id: this.outbox.nextId(), steams: ids.slice(offset, offset + PAGE_SIZE).map((id) => ({ id })) });
    }
  }
}
