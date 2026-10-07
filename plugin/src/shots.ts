import { type ShotDelivery, isRecordId } from "@decent-sync/protocol";
import { readShot, readShotPage } from "./decaid.js";
import type { Outbox } from "./outbox.js";

const PAGE_SIZE = 100;
/** How many of the previous page's Shots each page of the summary scan repeats. */
const OVERLAP = 10;
/** Passes through the summaries a load makes before leaving Shots that keep changing to the next load. */
const MAX_PASSES = 3;

/**
 * Shots, through the outbox. A Shot Decaid reports stored is requested by
 * its id, ahead of backfill, and read only when the outbox is about to send
 * it, so while the server is unreachable the outbox holds its id, not its
 * record. An edit is sent as Decaid reports it, metadata without curves, so
 * it may reach the server before the Shot's full record. Once per load,
 * every Shot summary is paged through with its edit time, so the server
 * requests the Shots it lacks or holds an older version of. A reconnect in
 * the same runtime sends the known ids only, since the outbox still holds
 * unacknowledged edits and requested Shots.
 */
export class ShotCapture {
  private readonly ids = new Set<string>();
  private scanning = false;
  private scanned = false;
  private welcomed = false;
  private stopped = false;
  private timer?: number;
  /** The Shots Decaid reported stored or edited while a summary pass runs. */
  private reported?: Set<string>;

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
    if (this.stopped || !event || !isCaptured(event.id)) return;
    const id = event.id;
    this.reported?.add(id);
    if (type === "shot") {
      // Its measurements make a Shot tens of KB, so it is read only as it is about to be sent.
      this.ids.add(id);
      this.outbox.request("shot", [id], { first: true });
      return;
    }
    // Decaid's edit event carries the Shot's complete metadata, without curves.
    const shot = object(event.shot);
    if (!shot) return;
    this.ids.add(id);
    this.outbox.enqueue({ type, id: this.outbox.nextId(), shotId: id, shot });
  }

  /** A Shot new on the tablet or requested by the server, as a delivery, or null if the tablet no longer has it. */
  async read(id: string, deliveryId: string): Promise<ShotDelivery | null> {
    const shot = await readShot(id);
    return shot && { type: "shot", id: deliveryId, shotId: id, shot };
  }

  /** Read bounded summaries once per load; never use the unbounded ids endpoint. */
  private async scan(): Promise<void> {
    this.scanning = true;
    try {
      for (let pass = 1; !(await this.scanPass()); pass++) {
        if (pass === MAX_PASSES) {
          this.log("Shot history kept changing during reconciliation; the next load will reconcile the rest.");
          break;
        }
      }
      this.scanned = !this.stopped;
    } catch {
      this.log("Could not reconcile Shot history; retrying the summary scan.");
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.scan(); }, 5_000);
    } finally {
      this.scanning = false;
      this.reported = undefined;
    }
  }

  /**
   * Pages through every summary once, newest first. Offsets count positions
   * in the list as it is when each page is read, so a deletion moves later
   * Shots up and an addition moves them down. Each page after the first
   * therefore starts OVERLAP Shots before the previous page ended and
   * resumes after the last Shot this pass has read and that has the edit
   * time it was read with: every unedited Shot older than that one sorts
   * after it, so none that existed throughout the pass is missed. Every
   * Decaid edit gives a Shot a new edit time, and an edit to its time can
   * move it anywhere. One moved from the part of the list not yet read into
   * the part already read is missed; Decaid's edit API reports it in
   * `shotUpdated`, but an import that overwrites it reports nothing. So a
   * pass that reaches the end checks it has read or been told of as many
   * Shots as the tablet holds; one deleted while another was moved that way
   * goes unnoticed. Returns true once the pass reaches the end with that
   * count, or the capture stops, and false if the count falls short, if no
   * Shot read with its current edit time reappears, as when more than the
   * overlap were deleted between two pages, or if the list grows past what
   * the first page's total allows: the pass may have missed Shots, so it is
   * repeated.
   */
  private async scanPass(): Promise<boolean> {
    /** Each Shot this pass has read, with the edit time it was read with. */
    const read = new Map<string, unknown>();
    const reported = this.reported = new Set<string>();
    // The first page sets how many requests the pass may make.
    let remaining = 1;
    for (let offset = 0; remaining > 0; remaining--) {
      await this.outbox.waitForRoom();
      if (this.stopped) return true;
      const page = await readShotPage(PAGE_SIZE, offset);
      if (!page) throw new Error("Shot summaries unavailable");
      const items = page.items.map(object);
      let resume = 0;
      if (offset === 0) remaining = Math.ceil(page.total / (PAGE_SIZE - OVERLAP)) + 2;
      else {
        for (let index = items.length - 1; index >= 0 && resume === 0; index--) {
          const summary = items[index];
          if (typeof summary?.id === "string" && read.has(summary.id) && read.get(summary.id) === summary.updatedAt) resume = index + 1;
        }
        if (resume === 0) return false;
      }
      const shots = items.slice(resume).flatMap((summary) => {
        if (typeof summary?.id !== "string" || summary.id === "") return [];
        read.set(summary.id, summary.updatedAt);
        // Decaid v0.8.7 and later give every Shot an edit time; a record without one is ignored.
        if (!isCaptured(summary.id) || typeof summary.updatedAt !== "string") return [];
        this.ids.add(summary.id);
        return [{ id: summary.id, updatedAt: summary.updatedAt }];
      });
      if (shots.length > 0) this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots });
      if (page.items.length < PAGE_SIZE) {
        for (const id of read.keys()) reported.add(id);
        return reported.size >= page.total;
      }
      offset += page.items.length - OVERLAP;
    }
    return false;
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

/**
 * Whether a Shot id is one Decent Sync captures: not one of Decaid's imports
 * from the legacy de1app, and one the server stores (`isRecordId`).
 */
function isCaptured(id: unknown): id is string {
  return isRecordId(id) && !id.startsWith("de1app-");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
