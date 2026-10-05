import type { PluginMessage, ShotDelivery, ShotIndex } from "@decent-sync/protocol";
import { readShot, readShotPage } from "./decaid.js";

const PAGE_SIZE = 100;
const SHORT_OUTBOX = 4;
type Delivery = ShotDelivery | ShotIndex;

/** One runtime's at-least-once outbox. Reloads recover its lost contents through reconciliation. */
export class ShotCapture {
  private readonly outbox = new Map<string, Delivery>();
  private readonly requested = new Set<string>();
  private readonly ids = new Set<string>();
  private readonly runtimeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  private sendFrame?: (message: PluginMessage) => Promise<void>;
  private generation = 0;
  private sent?: string;
  private working = false;
  private scanning = false;
  private scanned = false;
  private welcomed = false;
  private stopped = false;
  private timer?: number;
  private retryTimer?: number;
  private events: Promise<void> = Promise.resolve();

  constructor(private readonly log: (message: string) => void) {}

  welcome(send: (message: PluginMessage) => Promise<void>): void {
    this.sendFrame = send;
    this.generation++;
    this.sent = undefined;
    if (this.welcomed) void this.indexKnownIds();
    this.welcomed = true;
    if (!this.scanned && !this.scanning && this.timer === undefined) void this.scan();
    this.pump();
  }

  disconnected(): void {
    this.sendFrame = undefined;
    this.generation++;
    this.sent = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.disconnected();
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
  }

  acknowledge(id: string): void {
    this.outbox.delete(id);
    if (this.sent === id) this.sent = undefined;
    this.pump();
  }

  request(ids: string[]): void {
    for (const id of ids) this.requested.add(id);
    this.pump();
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
        this.requested.add(id);
        this.retry();
        return;
      }
      // Absent means the Shot was deleted since it was stored.
      if (shot && !this.stopped) this.capture(type, id, shot);
    }).catch(() => this.log("Could not capture a Shot event; reconciliation will recover it."));
  }

  private capture(type: "shot" | "shotUpdated", id: string, shot: Record<string, unknown>): void {
    this.ids.add(id);
    this.enqueue({ type, id: this.nextId(), shotId: id, shot });
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
          const summary = object(item);
          // Decaid v0.8.7 and later give every Shot an edit time; a record without one is ignored.
          if (typeof summary?.id !== "string" || summary.id === "" || isLegacyImport(summary.id) || typeof summary.updatedAt !== "string") return [];
          this.ids.add(summary.id);
          return [{ id: summary.id, updatedAt: summary.updatedAt }];
        });
        this.enqueue({ type: "shotIndex", id: this.nextId(), shots });
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
    const generation = this.generation;
    const ids = [...this.ids];
    for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
      await this.waitForRoom();
      if (this.stopped || generation !== this.generation) return;
      this.enqueue({ type: "shotIndex", id: this.nextId(), shots: ids.slice(offset, offset + PAGE_SIZE).map((id) => ({ id })) });
    }
  }

  private async waitForRoom(): Promise<void> {
    while (!this.stopped && this.outbox.size >= SHORT_OUTBOX) await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  private enqueue(message: Delivery): void {
    this.outbox.set(message.id, message);
    this.pump();
  }

  /** One logical message awaits ack at a time, leaving Decaid's pending transport room for heartbeats. */
  private pump(): void {
    if (this.retryTimer !== undefined || this.working || this.stopped || !this.sendFrame || this.sent !== undefined || (this.outbox.size === 0 && this.requested.size === 0)) return;
    this.working = true;
    void this.work().catch(() => {
      // SyncConnection drops a transport whose send failed; the outbox stays for its replacement.
      this.log("Shot delivery interrupted; unacknowledged data remains queued.");
      this.retry();
    }).finally(() => {
      this.working = false;
      if (!this.stopped && this.sendFrame && this.sent === undefined) this.pump();
    });
  }

  private async work(): Promise<void> {
    const generation = this.generation;
    if (this.outbox.size === 0 && this.requested.size > 0) {
      const id = this.requested.values().next().value!;
      let shot: Record<string, unknown> | null;
      try { shot = await readShot(id); }
      catch (error) {
        // Retry it after the others, so one unreadable Shot cannot hold up the rest.
        this.requested.delete(id);
        this.requested.add(id);
        throw error;
      }
      if (this.stopped) return;
      this.requested.delete(id);
      if (shot) { const envelopeId = this.nextId(); this.outbox.set(envelopeId, { type: "shot", id: envelopeId, shotId: id, shot }); }
      // A record deleted on the tablet is absent; nothing deletes its server copy.
    }
    if (generation !== this.generation || !this.sendFrame) return;
    const next = this.outbox.entries().next().value;
    if (!next) return;
    const [id, message] = next;
    this.sent = id;
    await this.sendFrame(message);
  }

  private retry(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump(); }, 5_000);
  }

  private nextId(): string { return `${this.runtimeId}-${++this.sequence}`; }
}

/** Decaid's imports from the legacy de1app; Decent Sync does not capture them. */
function isLegacyImport(id: string): boolean {
  return id.startsWith("de1app-");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
