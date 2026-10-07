import { randomUUID } from "node:crypto";
import type { LibraryWrite } from "@decent-sync/protocol";
import { type WrittenTablet, nextBeanWrite } from "../library/beans.js";
import type { PrismaService } from "../prisma.service.js";

/**
 * How long the plugin has to answer a write. It makes up to three requests
 * of Decaid for one, each of which Decaid's fetch gives up on after 30 s.
 */
const ANSWER_TIMEOUT_MS = 120_000;

/** What a write's answer said. */
export type WriteOutcome = "written" | "refused";

/**
 * Writes the Library to the tablet of one connection this instance holds:
 * one write at a time, each once the plugin has answered the one before it
 * and its answer is recorded, until the tablet holds every Bean its
 * Machine's Location offers, with its global id. What is due is read from
 * the database each time, so it reflects changes made through any instance;
 * the instance is woken to look again when one is notified, when the
 * connection's report of the tablet's beans is taken in, and when its
 * notifications may have been missed.
 *
 * Nothing is written until the connection's first report of the tablet's
 * beans is taken in, which the plugin sends on every welcome, so a bean the
 * tablet already holds is linked to the Library's Bean rather than written
 * to it again. A Machine moved, or given a Location, while connected is
 * written its new Location's Beans at once: its Location History change is
 * notified, and the plugin makes a bean it holds with the same roaster and
 * name the Bean rather than creating another (`library-writes.ts`).
 *
 * Only the connection holding its Machine writes, and the plugin answers
 * only on the connection that asked, so a tablet is written one item at a
 * time. A write Decaid refuses, or the plugin does not answer in time, is
 * skipped for the rest of the connection, and tried again when the tablet
 * reconnects; the other writes go on. So is one still due right after it
 * was written, which writing again would not change.
 */
export class TabletWriter {
  private running = false;
  /** Woken while running: look again once the current write is done. */
  private again = false;
  private stopped = false;
  /** The write awaiting its answer. */
  private waiting: { id: string; settle: (outcome: WriteOutcome | "stopped" | "timedOut") => void } | undefined;
  /** Beans whose write was refused, or not answered, on this connection, or that writing did not change. */
  private readonly skipped = new Set<string>();
  /** Whether a report of the tablet's beans from this connection has been taken in. */
  private hasReported = false;

  constructor(
    private readonly tablet: WrittenTablet,
    private readonly prisma: PrismaService,
    /** Sends a write on the connection, in chunks if it is too large for one frame. */
    private readonly send: (write: LibraryWrite) => void,
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

  /** A report of the tablet's beans from this connection was taken in, at its Machine's Location if it had one. */
  reported(): void {
    this.hasReported = true;
    this.wake();
  }

  /** Whether the write with this id awaits its answer. */
  awaits(id: string): boolean {
    return this.waiting?.id === id;
  }

  /** The plugin answered a write, and its answer is recorded. Answers to other writes, such as late ones, are ignored. */
  answered(id: string, outcome: WriteOutcome): void {
    if (this.waiting?.id === id) this.waiting.settle(outcome);
  }

  /** The connection closed: nothing more is written on it. */
  stop(): void {
    this.stopped = true;
    this.waiting?.settle("stopped");
  }

  private async run(): Promise<void> {
    /** The Bean written last, if its write changed what the tablet was due. */
    let written: string | undefined;
    for (;;) {
      this.again = false;
      const due = this.hasReported ? await nextBeanWrite(this.prisma, this.tablet, [...this.skipped]) : null;
      if (this.stopped) return;
      if (!due) {
        if (this.again) continue;
        return;
      }
      if (due.beanId === written) {
        this.log.warn(`Tablet ${this.tablet.tabletId} is still due Bean ${due.beanId} once written; it is tried again once the tablet reconnects`);
        this.skipped.add(due.beanId);
        continue;
      }
      const write: LibraryWrite = { type: "write", id: randomUUID(), kind: "bean", globalId: due.beanId, localId: due.localId, fields: due.fields };
      const outcome = await this.ask(write);
      if (outcome === "stopped") return;
      if (outcome === "timedOut") {
        this.log.warn(`Tablet ${this.tablet.tabletId} did not answer the write of Bean ${due.beanId} in ${ANSWER_TIMEOUT_MS / 1000} s; it is tried again once the tablet reconnects`);
      }
      written = outcome === "written" ? due.beanId : undefined;
      if (outcome !== "written") this.skipped.add(due.beanId);
    }
  }

  /** Sends a write and resolves with what became of it. */
  private ask(write: LibraryWrite): Promise<WriteOutcome | "stopped" | "timedOut"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle("timedOut"), ANSWER_TIMEOUT_MS);
      const settle = (outcome: WriteOutcome | "stopped" | "timedOut") => {
        clearTimeout(timer);
        if (this.waiting?.id === write.id) this.waiting = undefined;
        resolve(outcome);
      };
      this.waiting = { id: write.id, settle };
      this.send(write);
    });
  }
}
