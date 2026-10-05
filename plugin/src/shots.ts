import type { ShotDelivery } from "@decent-sync/protocol";
import { readShot, readShotPage } from "./decaid.js";
import type { Outbox } from "./outbox.js";

const PAGE_SIZE = 100;

/**
 * Shots, through the outbox: captured from Decaid's events as they are
 * stored or edited, and reconciled once per load by paging through every
 * Shot summary with its edit time, so the server requests the Shots it lacks
 * or holds an older version of. A reconnect in the same runtime sends the
 * known ids only, since the outbox still holds unacknowledged edits.
 */
export class ShotCapture {
  private readonly ids = new Set<string>();
  private scanning = false;
  private scanned = false;
  private welcomed = false;
  private stopped = false;
  private timer?: number;
  private events: Promise<void> = Promise.resolve();

  constructor(
    private readonly outbox: Outbox,
    private readonly log: (message: string) => void,
  ) {}

  welcome(): void {
    if (this.welcomed) void this.indexKnownIds();
    this.welcomed = true;
    if (!this.scanned && !this.scanning && this.timer === undefined) void this.scan();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  event(type: "shot" | "shotUpdated", payload: unknown): void {
    const event = object(payload);
    if (typeof event?.id !== "string" || event.id === "" || isLegacyImport(event.id)) return;
    const id = event.id;
    // Keep tablet event order even if its API takes different times to answer.
    this.events = this.events.then(async () => {
      if (type === "shotUpdated") {
        // Decaid's edit event carries the Shot's complete metadata, without curves.
        const shot = object(event.shot);
        if (shot && !this.stopped) this.capture(type, id, shot);
        return;
      }
      let shot: Record<string, unknown> | null;
      try { shot = await readShot(id); }
      catch {
        this.outbox.retryLater("shot", id);
        return;
      }
      // Absent means the Shot was deleted since it was stored.
      if (shot && !this.stopped) this.capture(type, id, shot);
    }).catch(() => this.log("Could not capture a Shot event; reconciliation will recover it."));
  }

  /** A Shot the server requested, as a delivery, or null if the tablet no longer has it. */
  async read(id: string, deliveryId: string): Promise<ShotDelivery | null> {
    const shot = await readShot(id);
    return shot && { type: "shot", id: deliveryId, shotId: id, shot };
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
        await this.outbox.waitForRoom();
        if (this.stopped) return;
        const page = await readShotPage(PAGE_SIZE, offset);
        if (!page) throw new Error("Shot summaries unavailable");
        const shots = page.items.flatMap((item) => {
          const summary = object(item);
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
    const generation = this.outbox.generation;
    const ids = [...this.ids];
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      await this.outbox.waitForRoom();
      if (this.stopped || generation !== this.outbox.generation) return;
      this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots: ids.slice(offset, offset + PAGE_SIZE).map((id) => ({ id })) });
    }
  }
}

/** Decaid's imports from the legacy de1app; Decent Sync does not capture them. */
function isLegacyImport(id: string): boolean {
  return id.startsWith("de1app-");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
