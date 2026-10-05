import { asObject, readShot, readShotPage } from "./decaid.js";
import type { Backlog, Delivery, Outbox } from "./outbox.js";

const PAGE_SIZE = 100;
const SHORT_OUTBOX = 4;

/**
 * Shots through the outbox: captured from Decaid's events, indexed from the
 * tablet's history once per load, and fetched one at a time when the server
 * requests them. Reloads recover what an unload lost through reconciliation.
 */
export class ShotCapture implements Backlog {
  private readonly requested = new Set<string>();
  private readonly ids = new Set<string>();
  /** Bumped by every welcome and disconnection, so an index of a past connection stops. */
  private connection = 0;
  private scanning = false;
  private scanned = false;
  private welcomed = false;
  private stopped = false;
  private timer?: number;
  private events: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: (message: string) => void,
    private readonly outbox: Outbox,
  ) {
    // Requested Shots are fetched only when nothing else is queued.
    outbox.drawOn(this);
  }

  /** The first welcome scans the tablet's history; later ones index the Shots already known. */
  welcome(): void {
    this.connection++;
    if (this.welcomed) void this.indexKnownIds();
    this.welcomed = true;
    if (!this.scanned && !this.scanning && this.timer === undefined) void this.scan();
  }

  disconnected(): void {
    this.connection++;
  }

  stop(): void {
    this.stopped = true;
    this.connection++;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  request(ids: string[]): void {
    for (const id of ids) this.requested.add(id);
    this.outbox.pump();
  }

  event(type: "shot" | "shotUpdated", payload: unknown): void {
    const event = asObject(payload);
    if (typeof event?.id !== "string" || event.id === "" || isLegacyImport(event.id)) return;
    const id = event.id;
    // Keep tablet event order even if its API takes different times to answer.
    this.events = this.events.then(async () => {
      if (type === "shotUpdated") {
        // Decaid's edit event carries the Shot's complete metadata, without curves.
        const shot = asObject(event.shot);
        if (shot && !this.stopped) this.capture(type, id, shot);
        return;
      }
      let shot: Record<string, unknown> | null;
      try { shot = await readShot(id); }
      catch {
        this.requested.add(id);
        this.outbox.retry();
        return;
      }
      // Absent means the Shot was deleted since it was stored.
      if (shot && !this.stopped) this.capture(type, id, shot);
    }).catch(() => this.log("Could not capture a Shot event; reconciliation will recover it."));
  }

  hasMore(): boolean {
    return this.requested.size > 0;
  }

  /** The next requested Shot, fetched in full. */
  async next(): Promise<Delivery | null> {
    const id = this.requested.values().next().value;
    if (id === undefined) return null;
    let shot: Record<string, unknown> | null;
    try { shot = await readShot(id); }
    catch (error) {
      // Retry it after the others, so one unreadable Shot cannot hold up the rest.
      this.requested.delete(id);
      this.requested.add(id);
      throw error;
    }
    if (this.stopped) return null;
    this.requested.delete(id);
    // A record deleted on the tablet is absent; nothing deletes its server copy.
    return shot ? { type: "shot", id: this.outbox.nextId(), shotId: id, shot } : null;
  }

  private capture(type: "shot" | "shotUpdated", id: string, shot: Record<string, unknown>): void {
    this.ids.add(id);
    this.outbox.enqueue({ type, id: this.outbox.nextId(), shotId: id, shot });
  }

  /** Read bounded summaries once per load; never use the unbounded ids endpoint. */
  private async scan(): Promise<void> {
    this.scanning = true;
    try {
      for (let offset = 0; !this.stopped; offset += PAGE_SIZE) {
        await this.waitForRoom();
        if (this.stopped) return;
        const page = await readShotPage(PAGE_SIZE, offset);
        if (!page) throw new Error("Shot summaries unavailable");
        const shots = page.items.flatMap((item) => {
          const summary = asObject(item);
          // Decaid v0.8.7 and later give every Shot an edit time; a record without one is ignored.
          if (typeof summary?.id !== "string" || summary.id === "" || isLegacyImport(summary.id) || typeof summary.updatedAt !== "string") return [];
          this.ids.add(summary.id);
          return [{ id: summary.id, updatedAt: summary.updatedAt }];
        });
        this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots });
        if (page.items.length < PAGE_SIZE) break;
      }
      this.scanned = !this.stopped;
    } catch {
      this.log("Could not reconcile Shot history; retrying the summary scan.");
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.scan(); }, 5_000);
    } finally {
      this.scanning = false;
    }
  }

  private async indexKnownIds(): Promise<void> {
    const connection = this.connection;
    const ids = [...this.ids];
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      await this.waitForRoom();
      if (this.stopped || connection !== this.connection) return;
      this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots: ids.slice(offset, offset + PAGE_SIZE).map((id) => ({ id })) });
    }
  }

  private async waitForRoom(): Promise<void> {
    while (!this.stopped && this.outbox.size >= SHORT_OUTBOX) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** Decaid's imports from the legacy de1app; Decent Sync does not capture them. */
function isLegacyImport(id: string): boolean {
  return id.startsWith("de1app-");
}
