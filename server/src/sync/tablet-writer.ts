import { randomUUID } from "node:crypto";
import type { LibraryKind, LibraryWrite } from "@decent-sync/protocol";
import { writeKey } from "../library/holdings.js";
import { type WrittenTablet, tabletDue } from "../library/tablet-due.js";
import type { PrismaService } from "../prisma.service.js";

/**
 * How long the plugin has to answer a write. It makes up to three requests
 * of Decaid for one, each of which Decaid's fetch gives up on after 30 s,
 * once a read of one of the Library's lists it may be waiting for (another
 * 30 s) is done, and its answer then waits in the outbox behind whatever
 * was queued before it.
 */
const ANSWER_TIMEOUT_MS = 300_000;

/** What a write's answer said. */
export type WriteOutcome = "written" | "refused";

/** The Library lists whose reports are taken in before anything is written: what the tablet holds. */
export type TakenInList = "beans" | "beanBatches" | "profiles";

const TAKEN_IN: readonly TakenInList[] = ["beans", "beanBatches", "profiles"];

/** What each kind of Library item is called in the server's log. */
export const KIND_NAMES: Readonly<Record<LibraryKind, string>> = { bean: "Bean", beanBatch: "Bean Batch", profile: "Profile" };

/**
 * Writes the Library to the tablet of one connection this instance holds:
 * one write at a time, each once the plugin has answered the one before it
 * and its answer is recorded, until the tablet holds what its Machine's
 * Location offers (`tabletDue`): its Beans and Bean Batches, with their
 * global ids and the Location's remaining weights, and its Profiles,
 * visible, and nothing else unarchived or visible. What is due is read from
 * the database each time, so it reflects changes made through any instance;
 * the instance is woken to look again when one is notified, when the
 * connection's report of the tablet's beans, bean batches or profiles is
 * taken in, and when its notifications may have been missed.
 *
 * Nothing is written until the connection's reports of the tablet's beans,
 * bean batches and profiles are taken in, which the plugin sends on every
 * welcome, nor between a report of its beans and the report of its batches
 * the plugin sends after it, and only while the Machine is at the Location
 * the latest reports were all taken in at. A bean the tablet already holds,
 * entered there or before it joined, is then linked to the Library's Bean
 * rather than written to it again. When it finds the Machine at another Location
 * than that, as once it has moved, it asks the plugin for its collections
 * afresh (`requestCollections`), once for each Location it finds, and writes
 * once those reports are taken in there. A move is notified to every instance,
 * which wakes the writers of the Machine's connections, and every writer
 * looks again after its instance listens anew, so a move missed meanwhile is
 * found too.
 *
 * Only the connection holding its Machine writes, and only a write its
 * connection awaits is answered, so a tablet is written one item at a
 * time. A write Decaid refuses, or the plugin does not answer in time, is
 * skipped for the rest of the connection, and tried again when the tablet
 * reconnects; the other writes go on. So is one due again, with the same
 * fields, right after it was written, which writing again would not change;
 * an item due again with other fields, as when a second request of its
 * write failed or the Location changed it meanwhile, is written again.
 */
export class TabletWriter {
  private running = false;
  /** Woken while running: look again once the current write is done. */
  private again = false;
  private stopped = false;
  /** The write awaiting its answer. */
  private waiting: { write: LibraryWrite; settle: (outcome: WriteOutcome | "stopped" | "timedOut") => void } | undefined;
  /** Items whose write was refused, or not answered, on this connection, or that writing did not change, by `writeKey`. */
  private readonly skipped = new Set<string>();
  /**
   * The Location the connection's latest report of each list was taken in
   * at: null while the Machine was at none, and absent until one is.
   */
  private readonly reportedAt = new Map<TakenInList, string | null>();
  /**
   * Set from when a report of the tablet's beans begins to be stored until
   * the report of its bean batches the plugin sends after it arrives: nothing
   * is written between them, so a change the tablet made to both, such as
   * deleting a bean with its batches, is taken in whole before the tablet is
   * written anything on its account. It is set before the report commits, as
   * the notification its intake sends may wake the writer before the report
   * is acknowledged.
   */
  private awaitingBatches = false;
  /**
   * The Location the plugin was last asked to report the tablet's collections
   * afresh for, until the writer finds the Machine at the Location of its
   * latest report. A report taken in just before a move, after the request,
   * does not clear it, so the plugin is not asked twice. The cost: should the
   * Machine move back, have the reply taken in there, and move to that
   * Location again before the writer next looks, it is not asked again, and
   * the tablet is written there only after its next report, when its beans
   * change or it reconnects. Nothing is written twice meanwhile.
   */
  private requestedFor: string | undefined;

  constructor(
    private readonly tablet: WrittenTablet,
    private readonly prisma: PrismaService,
    /** Sends a write on the connection, in chunks if it is too large for one frame. */
    private readonly send: (write: LibraryWrite) => void,
    /** Asks the plugin for every collection afresh, as on a welcome. */
    private readonly requestCollections: () => void,
    private readonly log: { warn(message: string): void; error(message: string): void },
    /** Keeps database work in the instance's work in flight, which shutdown waits for. */
    private readonly track: (work: Promise<void>) => Promise<void>,
  ) {}

  /** Looks for writes due, now or, if it is writing, once the current write is done. */
  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.track(
      this.run()
        .catch((error: unknown) => this.log.error(`Could not write the Library to tablet ${this.tablet.tabletId}: ${String(error)}`))
        .finally(() => {
          this.running = false;
        }),
    );
  }

  /** A report of the tablet's beans is about to be stored, which the plugin follows with one of its bean batches. */
  awaitBatches(): void {
    this.awaitingBatches = true;
  }

  /**
   * A report of the tablet's beans, bean batches or profiles from this
   * connection was stored, and taken in with its Machine at that Location,
   * or at none; or, undefined, not taken in, as when it was unavailable or
   * set aside. One of its bean batches ends the wait a report of its beans
   * began.
   */
  reported(list: TakenInList, locationId: string | null | undefined): void {
    if (locationId !== undefined) this.reportedAt.set(list, locationId);
    if (list === "beanBatches") this.awaitingBatches = false;
    this.wake();
  }

  /** The write with this id, if it awaits its answer. */
  awaited(id: string): LibraryWrite | undefined {
    return this.waiting?.write.id === id ? this.waiting.write : undefined;
  }

  /** The plugin answered a write, and its answer is recorded. Answers to other writes, such as late ones, are ignored. */
  answered(id: string, outcome: WriteOutcome): void {
    if (this.waiting?.write.id === id) this.waiting.settle(outcome);
  }

  /** The connection closed: nothing more is written on it. */
  stop(): void {
    this.stopped = true;
    this.waiting?.settle("stopped");
  }

  private async run(): Promise<void> {
    /** The item written last, by `writeKey`, with the fields written, if its answer said it was written. */
    let written: { key: string; fields: string } | undefined;
    for (;;) {
      this.again = false;
      // Until the connection's first reports are taken in, which its welcome brings, nothing is due.
      const reports = TAKEN_IN.map((list) => this.reportedAt.get(list));
      /** Where all were taken in, or undefined while they were not, or were at different Locations, as across a move. */
      const reportedAt = reports.every((at) => at === reports[0]) ? reports[0] : undefined;
      const found =
        reports.includes(undefined) || this.awaitingBatches ? null : await tabletDue(this.prisma, this.tablet, reportedAt ?? null, this.skipped);
      if (this.stopped) return;
      if (found && found.locationId === reportedAt) this.requestedFor = undefined;
      else if (found && found.locationId !== null && found.locationId !== this.requestedFor) {
        this.requestedFor = found.locationId;
        this.requestCollections();
      }
      // A report of the tablet's beans may have been taken in while this was read: what is due waits for its batches.
      const due = this.awaitingBatches ? undefined : found?.write;
      if (!due) {
        if (this.again) continue;
        return;
      }
      const key = writeKey(due.kind, due.globalId);
      const item = `${KIND_NAMES[due.kind]} ${due.globalId}`;
      const fields = JSON.stringify(due.fields);
      if (written?.key === key && written.fields === fields) {
        this.log.warn(`Tablet ${this.tablet.tabletId} is still due ${item} once written; it is tried again once the tablet reconnects`);
        this.skipped.add(key);
        continue;
      }
      const write: LibraryWrite = { type: "write", id: randomUUID(), kind: due.kind, globalId: due.globalId, localId: due.localId, fields: due.fields };
      const outcome = await this.ask(write);
      if (outcome === "stopped") return;
      if (outcome === "timedOut") {
        this.log.warn(`Tablet ${this.tablet.tabletId} did not answer the write of ${item} in ${ANSWER_TIMEOUT_MS / 1000} s; it is tried again once the tablet reconnects`);
      }
      written = outcome === "written" ? { key, fields } : undefined;
      if (outcome !== "written") this.skipped.add(key);
    }
  }

  /** Sends a write and resolves with what became of it. */
  private ask(write: LibraryWrite): Promise<WriteOutcome | "stopped" | "timedOut"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle("timedOut"), ANSWER_TIMEOUT_MS);
      const settle = (outcome: WriteOutcome | "stopped" | "timedOut") => {
        clearTimeout(timer);
        if (this.waiting?.write.id === write.id) this.waiting = undefined;
        resolve(outcome);
      };
      this.waiting = { write, settle };
      this.send(write);
    });
  }
}
