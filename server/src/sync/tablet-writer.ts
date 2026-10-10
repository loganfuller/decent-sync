import { randomUUID } from "node:crypto";
import type { LeaveOut, LibraryDelete, LibraryWrite, WrittenKind } from "@decent-sync/protocol";
import type { SeenDecision } from "../library/intake.js";
import { type TabletChange, changeKey, changeSignature, tabletChange } from "../library/sharing-status.js";
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

/**
 * A write awaiting its answer, with what the record it answers with has seen
 * once written, as it was planned (`PlannedWrite`): the Location's decision
 * its record holds, and that Location; and the latest edit of the item's
 * content, which its record holds. With the change it makes, as the
 * tablet's sharing status records it, and what was due as it was planned
 * (`changeSignature`), which a refusal is kept with.
 */
export interface AwaitedWrite {
  write: LibraryWrite | LibraryDelete | LeaveOut;
  seen: SeenDecision | null;
  contentSeen: Date | null;
  change: TabletChange & { signature: string };
}

/**
 * What a write's answer said: written, refused, or, for a delete the plugin
 * could not judge yet as Shots were still to be sent, deferred: asked again
 * on the same connection a little later.
 */
export type WriteOutcome = "written" | "refused" | "deferred";

/** The Library lists whose reports are taken in before anything is written: what the tablet holds. */
export type TakenInList = "beans" | "beanBatches" | "grinders" | "profiles";

const TAKEN_IN: readonly TakenInList[] = ["beans", "beanBatches", "grinders", "profiles"];

/** What each kind of Library item, and the shared settings, are called in the server's log. */
export const KIND_NAMES: Readonly<Record<WrittenKind, string>> = {
  bean: "Bean",
  beanBatch: "Bean Batch",
  grinder: "Grinder",
  profile: "Profile",
  settings: "Location settings",
  workflow: "Workflow",
};

/**
 * Writes the Library to the tablet of one connection this instance holds:
 * one write at a time, each once the plugin has answered the one before it
 * and its answer is recorded, until the tablet holds what its Machine's
 * Location offers (`tabletDue`): its Beans, Bean Batches and Grinders, with
 * their global ids and the Location's remaining weights, and its Profiles,
 * visible, and nothing else unarchived or visible. What is due is read from
 * the database each time, so it reflects changes made through any instance;
 * the instance is woken to look again when one is notified, when the
 * connection's report of the tablet's beans, bean batches, grinders or
 * profiles is taken in, and when its notifications may have been missed.
 *
 * Nothing is written until the connection's reports of the tablet's beans,
 * bean batches, grinders and profiles are taken in, which the plugin sends on every
 * welcome, nor between a report of its beans and the report of its batches
 * the plugin sends after it, and only while the Machine takes part where
 * the latest reports were all taken in: at their Location, with sharing on
 * since they were, and where its latest Workflow was taken in too, once it
 * sent one (`workflowAt`). A bean the tablet already holds, entered there or
 * before it joined, is then linked to the Library's Bean rather than written
 * to it again. Nothing is written while the Machine is capture-only. When it finds
 * the Machine taking part elsewhere, as once it has moved, or had sharing
 * turned off and on again, it asks the plugin for its collections afresh
 * (`requestCollections`), once for each place it finds, and writes once
 * those reports are taken in there. A move or a switch of sharing is
 * notified to every instance, which wakes the writers of the Machine's
 * connections, and every writer looks again after its instance listens
 * anew, so one missed meanwhile is found too.
 *
 * Only the connection holding its Machine writes, and only a write its
 * connection awaits is answered, so a tablet is written one item at a
 * time. A write Decaid refuses, or the plugin does not answer in time, is
 * skipped while the same is due to its item (`changeSignature`), and tried
 * again once that changes, as when the item is edited, or when the tablet
 * reconnects; the other writes go on. So is one due again with the same
 * fields it was last written, found due at every look since, which writing
 * again would not change; an item due again with other fields, as when a second
 * request of its write failed or the Location changed it meanwhile, is
 * written again.
 */
export class TabletWriter {
  private running = false;
  /** Woken while running: look again once the current write is done. */
  private again = false;
  private stopped = false;
  /**
   * The write awaiting its answer, with what its record has seen once
   * written (`AwaitedWrite`).
   */
  private waiting: (AwaitedWrite & { settle: (outcome: WriteOutcome | "stopped" | "timedOut") => void }) | undefined;
  /**
   * Items whose write, delete or leave-out was refused, or not answered, on
   * this connection, or that writing did not change, by `changeKey`, with
   * what was due to them then (`changeSignature`): each is skipped while the
   * same is due, and written again once that changes, or it is no longer due.
   */
  private readonly skipped = new Map<string, string>();
  /**
   * The fields last written to each item on this connection, by `writeKey`,
   * with the values the write expected the record to hold, kept while every
   * look since has found the item due, whatever was written between: due
   * again with those fields and expecting the same, writing it changed
   * nothing. One expecting other values finds the record changed, as when the
   * plugin left a field the tablet had changed meanwhile as it was, which its
   * answer brought in, and is written again. A look the writer skips while it
   * waits for a report of the batches cannot tell, so it keeps them.
   */
  private readonly lastWritten = new Map<string, string>();
  /**
   * Where the connection's latest report of each list was taken in
   * (`standing`): its Location, and when the Machine's sharing was last
   * turned back on; null while it was capture-only, and absent until one is.
   */
  private readonly reportedAt = new Map<TakenInList, string | null>();
  /**
   * Where the connection's latest Workflow was taken in (`standing`), null
   * while its Machine was capture-only, and undefined until one is, as on a
   * connection whose plugin sends none, or once one was set aside as it
   * cannot be stored, which waits for nothing more. Nothing is written while it is not
   * where the lists were taken in, as when the Machine moved between the
   * Workflow and the lists the plugin sends after it on a welcome: the
   * plugin is asked for them afresh, so a joining tablet's Workflow is judged
   * there (`takeInWorkflow`) before anything is written to it.
   */
  private workflowAt: string | null | undefined;
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
   * Where (`standing`) the plugin was last asked to report the tablet's
   * collections afresh for, until the writer finds the Machine taking part
   * where its latest report was taken in. A report taken in just before a move, after the request,
   * does not clear it, so the plugin is not asked twice. The cost: should the
   * Machine move back, have the reply taken in there, and move to that
   * Location again before the writer next looks, it is not asked again, and
   * the tablet is written there only after its next report, when its beans
   * change or it reconnects. Nothing is written twice meanwhile.
   */
  private requestedFor: string | undefined;
  /**
   * Deletes the plugin deferred, by `deleteKey`, with when they are planned
   * again, by this instance's clock: in its memory, as they belong to this
   * connection alone.
   */
  private readonly deferred = new Map<string, number>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tablet: WrittenTablet,
    private readonly prisma: PrismaService,
    /** Sends a write, delete or leave-out on the connection, in chunks if it is too large for one frame. */
    private readonly send: (write: LibraryWrite | LibraryDelete | LeaveOut) => void,
    /** Asks the plugin for every collection afresh, as on a welcome. */
    private readonly requestCollections: () => void,
    private readonly log: { warn(message: string): void; error(message: string): void },
    /** Keeps database work in the instance's work in flight, which shutdown waits for. */
    private readonly track: (work: Promise<void>) => Promise<void>,
    /** How long a deferred delete waits before it is planned again. */
    private readonly retryDeferredMs: number,
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
          this.armRetry();
        }),
    );
  }

  /** A report of the tablet's beans is about to be stored, which the plugin follows with one of its bean batches. */
  awaitBatches(): void {
    this.awaitingBatches = true;
  }

  /**
   * A report of the tablet's beans, bean batches, grinders or profiles from this
   * connection was stored, and taken in there (`standing`), or nowhere, as
   * its Machine was capture-only; or, undefined, not taken in, as when it was
   * unavailable or set aside. One of its bean batches ends the wait a report
   * of its beans began.
   */
  reported(list: TakenInList, takenInAt: string | null | undefined): void {
    if (takenInAt !== undefined) this.reportedAt.set(list, takenInAt);
    if (list === "beanBatches") this.awaitingBatches = false;
    this.wake();
  }

  /**
   * A Workflow from this connection was stored, and taken in there
   * (`standing`), or nowhere, as its Machine was capture-only; or,
   * undefined, set aside as it cannot be stored.
   */
  workflowReported(takenInAt: string | null | undefined): void {
    this.workflowAt = takenInAt;
    this.wake();
  }

  /** The write with this id, if it awaits its answer, and what its answer has seen. */
  awaited(id: string): AwaitedWrite | undefined {
    if (this.waiting?.write.id !== id) return undefined;
    const { write, seen, contentSeen, change } = this.waiting;
    return { write, seen, contentSeen, change };
  }

  /** The plugin answered a write, and its answer is recorded. Answers to other writes, such as late ones, are ignored. */
  answered(id: string, outcome: WriteOutcome): void {
    if (this.waiting?.write.id === id) this.waiting.settle(outcome);
  }

  /** The connection closed: nothing more is written on it. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.waiting?.settle("stopped");
  }

  private async run(): Promise<void> {
    for (;;) {
      this.again = false;
      // Until the connection's first reports are taken in, which its welcome brings, nothing is due.
      const reports = TAKEN_IN.map((list) => this.reportedAt.get(list));
      /** Where all were taken in, or undefined while they were not, or were in different places, as across a move. */
      const reportedAt = reports.every((at) => at === reports[0]) ? reports[0] : undefined;
      const now = Date.now();
      for (const [key, until] of this.deferred) if (until <= now) this.deferred.delete(key);
      const found =
        reports.includes(undefined) || this.awaitingBatches ? null : await tabletDue(this.prisma, this.tablet, reportedAt ?? null, new Set(this.deferred.keys()));
      if (this.stopped) return;
      /** Whether the connection's latest Workflow was taken in elsewhere than where the Machine takes part now. */
      const workflowBehind = found !== null && this.workflowAt !== undefined && this.workflowAt !== found.standing;
      if (found && found.standing === reportedAt && !workflowBehind) this.requestedFor = undefined;
      else if (found && found.standing !== null && found.standing !== this.requestedFor) {
        this.requestedFor = found.standing;
        this.requestCollections();
      }
      // A report of the tablet's beans may have been taken in while this was read: what is due waits for its batches.
      const planned = this.awaitingBatches || workflowBehind ? null : (found?.writes ?? null);
      if (planned) {
        // An item no longer due has not stayed due since it was written, nor is it still refused.
        const stillDue = new Set(planned.map(changeKey));
        for (const key of this.lastWritten.keys()) if (!stillDue.has(key)) this.lastWritten.delete(key);
        for (const key of this.skipped.keys()) if (!stillDue.has(key)) this.skipped.delete(key);
      }
      // The first not skipped, or due otherwise than when it was.
      const due = planned?.find((change) => {
        const skipped = this.skipped.get(changeKey(change));
        return skipped === undefined || skipped !== changeSignature(change);
      });
      if (!due) {
        if (this.again) continue;
        return;
      }
      const key = changeKey(due);
      const change = { ...tabletChange(due), signature: changeSignature(due) };
      const item = "leaveOut" in due ? `${KIND_NAMES[due.kind]} record ${due.localId}` : `${KIND_NAMES[due.kind]} ${due.globalId}`;
      const fields = "delete" in due ? "delete" : "leaveOut" in due ? "leaveOut" : JSON.stringify({ fields: due.fields, expected: due.expected ?? null });
      if (this.lastWritten.get(key) === fields) {
        this.log.warn(`Tablet ${this.tablet.tabletId} is still due ${item} once written; it is tried again once it changes or the tablet reconnects`);
        this.skipped.set(key, change.signature);
        continue;
      }
      if ("leaveOut" in due) {
        // Its answer removes it from what the tablet is due, so it is not due again once set aside.
        const outcome = await this.ask({ write: { type: "leaveOut", id: randomUUID(), kind: due.kind, localId: due.localId }, seen: null, contentSeen: null, change });
        if (outcome === "stopped") return;
        if (outcome === "timedOut") {
          this.log.warn(`Tablet ${this.tablet.tabletId} did not answer setting aside ${item} in ${ANSWER_TIMEOUT_MS / 1000} s; it is tried again once it changes or the tablet reconnects`);
        }
        if (outcome === "written") this.lastWritten.set(key, fields);
        else this.skipped.set(key, change.signature);
        continue;
      }
      if ("delete" in due) {
        // Its answer removes it from what the tablet is due, so it is not due again once deleted.
        const outcome = await this.ask({
          write: { type: "delete", id: randomUUID(), kind: due.kind, globalId: due.globalId, localId: due.localId },
          seen: null,
          contentSeen: null,
          change,
        });
        if (outcome === "stopped") return;
        if (outcome === "timedOut") {
          this.log.warn(`Tablet ${this.tablet.tabletId} did not answer the delete of ${item} in ${ANSWER_TIMEOUT_MS / 1000} s; it is tried again once it changes or the tablet reconnects`);
        }
        if (outcome === "written") this.lastWritten.set(key, fields);
        else if (outcome === "deferred") this.defer(key);
        else this.skipped.set(key, change.signature);
        continue;
      }
      const write: LibraryWrite = {
        type: "write",
        id: randomUUID(),
        kind: due.kind,
        globalId: due.globalId,
        localId: due.localId,
        fields: due.fields,
        ...(due.expected ? { expected: due.expected } : {}),
        ...(due.contentDecidedAt === null ? {} : { contentDecidedAt: due.contentDecidedAt.toISOString() }),
      };
      // What the write carries was decided at the Location it was planned for.
      const plannedFor = found?.locationId ?? null;
      const seen = due.decidedAt === null || plannedFor === null ? null : { at: due.decidedAt, locationId: plannedFor };
      const outcome = await this.ask({ write, seen, contentSeen: due.contentDecidedAt, change });
      if (outcome === "stopped") return;
      if (outcome === "timedOut") {
        this.log.warn(`Tablet ${this.tablet.tabletId} did not answer the write of ${item} in ${ANSWER_TIMEOUT_MS / 1000} s; it is tried again once it changes or the tablet reconnects`);
      }
      if (outcome === "written") this.lastWritten.set(key, fields);
      else this.skipped.set(key, change.signature);
    }
  }

  /** Leaves a delete out until `retryDeferredMs` has passed: the writer looks again then (`armRetry`). */
  private defer(key: string): void {
    this.deferred.set(key, Date.now() + this.retryDeferredMs);
  }

  /**
   * Once the writer has stopped looking, wakes it when the first delete still
   * deferred is due to be asked again. Armed after every look, so a delete
   * deferred after another, or a timer firing just before its time, is never
   * left without one.
   */
  private armRetry(): void {
    if (this.stopped || this.retryTimer !== undefined || this.deferred.size === 0) return;
    const next = Math.min(...this.deferred.values());
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        this.wake();
      },
      Math.max(0, next - Date.now()) + 1,
    );
  }

  /** Sends a write and resolves with what became of it. */
  private ask(awaited: AwaitedWrite): Promise<WriteOutcome | "stopped" | "timedOut"> {
    const { write } = awaited;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle("timedOut"), ANSWER_TIMEOUT_MS);
      const settle = (outcome: WriteOutcome | "stopped" | "timedOut") => {
        clearTimeout(timer);
        if (this.waiting?.write.id === write.id) this.waiting = undefined;
        resolve(outcome);
      };
      this.waiting = { ...awaited, settle };
      this.send(write);
    });
  }
}

