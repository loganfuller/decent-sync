import type { SteamDelivery } from "@decent-sync/protocol";
import { readSteam, readSteamIds } from "./decaid.js";
import type { Outbox } from "./outbox.js";

const PAGE_SIZE = 100;
/** A failed read of the ids for an index is retried after this long, while its connection lasts. */
const RETRY_MS = 5_000;

/**
 * Steam Records, through the outbox. Decaid has no event for them, so every
 * poll interval the plugin reads their ids and sends the new ones, reading
 * them one at a time. On every welcome it sends all the ids as `steamIndex`
 * pages, so the server requests those it lacks: the tablet's history, and
 * whatever was recorded while the plugin was unloaded or disconnected.
 * Decaid offers no way to detect an edit to a Steam Record, so edits are not
 * sent.
 */
export class SteamCapture {
  /** The ids the latest read found, or null before the first, which finds none new. */
  private known: Set<string> | null = null;
  private stopped = false;
  private pollTimer?: number;
  private indexTimer?: number;

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
    if (this.indexTimer !== undefined) clearTimeout(this.indexTimer);
  }

  welcome(): void {
    if (this.indexTimer !== undefined) clearTimeout(this.indexTimer);
    this.indexTimer = undefined;
    void this.index(this.outbox.generation);
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

  private async index(generation: number): Promise<void> {
    if (this.stopped || generation !== this.outbox.generation) return;
    const ids = await this.readIds();
    if (this.stopped || generation !== this.outbox.generation) return;
    if (!ids) {
      this.log("Could not read the Steam Record ids; retrying.");
      this.indexTimer = setTimeout(() => { this.indexTimer = undefined; void this.index(generation); }, RETRY_MS);
      return;
    }
    for (let offset = 0; offset < ids.all.length; offset += PAGE_SIZE) {
      await this.outbox.waitForRoom();
      if (this.stopped || generation !== this.outbox.generation) return;
      this.outbox.enqueue({ type: "steamIndex", id: this.outbox.nextId(), steams: ids.all.slice(offset, offset + PAGE_SIZE).map((id) => ({ id })) });
    }
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll().finally(() => {
        if (!this.stopped) this.schedulePoll();
      });
    }, this.pollMs);
  }

  /** Sends the Steam Records recorded since the last read, one at a time, ahead of those the server requested. */
  private async poll(): Promise<void> {
    const ids = await this.readIds();
    for (const id of ids?.fresh ?? []) {
      await this.outbox.waitForRoom();
      if (this.stopped) return;
      let delivery: SteamDelivery | null;
      try { delivery = await this.read(id, this.outbox.nextId()); }
      catch {
        this.outbox.retryLater("steam", id);
        continue;
      }
      if (delivery && !this.stopped) this.outbox.enqueue(delivery);
    }
  }

  /** Every Steam Record id, and those new since the last read; null if they cannot be read now. */
  private async readIds(): Promise<{ all: string[]; fresh: string[] } | null> {
    const all = await readSteamIds();
    if (!all) return null;
    const known = this.known;
    this.known = new Set(all);
    return { all, fresh: known ? all.filter((id) => !known.has(id)) : [] };
  }
}

const ISO_TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;

/**
 * A Steam Record's `timestamp` in UTC, or null if it is not an ISO 8601
 * time. Decaid writes it as the tablet's local time without an offset, to
 * the microsecond (`DateTime.now()`, by `toIso8601String`, in
 * SteamSequencer._openRecord), and records nothing that places it in UTC.
 * The plugin runs in the tablet's time zone, so the time is built from its
 * parts, which JavaScript reads as local time, daylight saving included,
 * rather than parsed: engines differ in how they parse a time without an
 * offset, and in how many fractional digits they read. A local time that
 * occurs twice, as the clocks go back, is read as the first. A time written
 * with an offset, as a later Decaid may write it, is placed by its offset.
 */
function utcTime(timestamp: unknown): string | null {
  const match = typeof timestamp === "string" ? ISO_TIME.exec(timestamp) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offset = match[8];
  const time = offset === undefined
    ? new Date(year, month - 1, day, hour, minute, second, ms).getTime()
    : Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes(offset) * 60_000;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** An ISO 8601 offset, Z or ±hh:mm, in minutes east of UTC. */
function offsetMinutes(offset: string): number {
  if (offset === "Z") return 0;
  const minutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6));
  return offset.startsWith("-") ? -minutes : minutes;
}
