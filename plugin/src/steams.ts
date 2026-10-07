import type { SteamDelivery } from "@decent-sync/protocol";
import { readLatestSteamId, readSteam, readSteamIds } from "./decaid.js";
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
 * the newest go on being sent. Decaid offers no way to detect an edit to a
 * Steam Record, so edits are not sent.
 */
export class SteamCapture {
  /** Every id this load has seen, in reads of every id and of the newest. */
  private readonly known = new Set<string>();
  /** Whether every id has been read for the index. */
  private indexed = false;
  /** Poll intervals before every id is read again; 0 once it is due. */
  private untilFullRead = 0;
  /** Reads of every id that have failed in a row. */
  private failures = 0;
  private failureLogged = false;
  private polling = false;
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
   * Polls at once, reading every id if due, as for the load's index, and
   * starts the poll intervals again from now. A welcome is not an interval,
   * so reads of every id stay at least the intervals they wait apart.
   */
  welcome(): void {
    if (this.stopped) return;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    void this.poll();
    this.schedulePoll();
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
      if (this.untilFullRead > 0) this.untilFullRead--;
      // While disconnected an interval passes with nothing read; the polls from the next welcome find what was recorded meanwhile.
      void this.poll();
      if (!this.stopped) this.schedulePoll();
    }, this.pollMs);
  }

  /**
   * Requests the Steam Records new since the last poll, ahead of those the
   * server requested: any that every id shows, when they are due to be read,
   * then the newest. A poll still running when the next is due skips it.
   */
  private async poll(): Promise<void> {
    if (this.polling || this.stopped || !this.outbox.connected) return;
    this.polling = true;
    try {
      if (this.untilFullRead === 0) await this.readAll();
      if (this.stopped || !this.outbox.connected) return;
      let latest: string | null;
      // The next poll reads it again.
      try { latest = await readLatestSteamId(); } catch { return; }
      if (latest !== null && !this.stopped) this.request([latest]);
    } finally {
      this.polling = false;
    }
  }

  /** Reads every id: the first time, to send them as the index; after that, to request those not seen. */
  private async readAll(): Promise<void> {
    let ids: string[];
    try {
      ids = await readSteamIds();
    } catch (error) {
      // Once the index has been read, a retry waits at least as long as the next read would have.
      this.untilFullRead = Math.min((this.indexed ? FULL_READ_INTERVALS : 1) * 2 ** this.failures, MAX_RETRY_INTERVALS);
      this.failures++;
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.log(
          `Could not read the Steam Record ids: ${error instanceof Error ? error.message : String(error)}. ` +
            "New Steam Records are still sent; reading every id is tried again less and less often until it succeeds.",
        );
      }
      return;
    }
    this.untilFullRead = FULL_READ_INTERVALS;
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

const ISO_TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;

/**
 * A Steam Record's `timestamp` in UTC, or null if it is not a time that
 * exists. Decaid writes it as the tablet's local time without an offset, to
 * the microsecond (`DateTime.now()`, by `toIso8601String`, in
 * SteamSequencer._openRecord), and records nothing that places it in UTC.
 * The plugin runs in the tablet's time zone, so the time is built from its
 * parts, which JavaScript reads as local time, daylight saving included,
 * rather than parsed: engines differ in how they parse a time without an
 * offset, and in how many fractional digits they read. A local time that
 * occurs twice, as the clocks go back, is read as the first. A time written
 * with an offset, as a later Decaid may write it, is placed by its offset.
 * Date rolls over parts that do not exist, such as the 30th of February or a
 * local time the clocks skip, so a time whose parts read back differently is
 * refused.
 */
function utcTime(timestamp: unknown): string | null {
  const match = typeof timestamp === "string" ? ISO_TIME.exec(timestamp) : null;
  if (!match) return null;
  const parts = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const [year, month, day, hour, minute, second] = parts;
  const ms = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offset = match[8];
  if (offset === undefined) {
    const local = new Date(year, month - 1, day, hour, minute, second, ms);
    const readBack = [local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds()];
    return readBack.every((part, index) => part === parts[index]) ? local.toISOString() : null;
  }
  const minutes = offsetMinutes(offset);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  const readBack = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds()];
  if (minutes === null || !readBack.every((part, index) => part === parts[index])) return null;
  return new Date(utc.getTime() - minutes * 60_000).toISOString();
}

/** An ISO 8601 offset, Z or ±hh:mm, in minutes east of UTC, or null if its hours or minutes are out of range. */
function offsetMinutes(offset: string): number | null {
  if (offset === "Z") return 0;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (hours > 23 || minutes > 59) return null;
  return (offset.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
}
