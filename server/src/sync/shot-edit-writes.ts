import type { ShotEdit, ShotEditedOutcome } from "@decent-sync/protocol";

/**
 * How long the plugin has to answer an edit. It makes one request of Decaid
 * for each, which Decaid's fetch gives up on after 30 s, and carries them
 * out one at a time, each sent once the one before it is answered.
 */
const ANSWER_TIMEOUT_MS = 60_000;

/** What became of an edit sent: as the plugin answered it, unanswered in time, or abandoned as the connection closed. */
type Outcome = ShotEditedOutcome | "timedOut" | "stopped";

/**
 * Writes the edits of Shots made through the server (ADR-0031, ticket #512)
 * to the tablet of one connection this instance holds: those not yet
 * still awaiting it of the Shots that tablet holds, a Shot at a time, the
 * one whose edit has waited longest first, each write carrying the latest
 * value of each field that Shot's awaiting edits set, and sent once the
 * plugin has answered the one before it and that answer is recorded.
 *
 * What is due is read from the database each time (`due`), so it reflects
 * edits made through any instance: the instance is woken to look when the
 * connection is welcomed, so a tablet that was off is written what was made
 * meanwhile, when an edit for its tablet is notified, when its
 * notifications may have been missed, and when the connection reports a
 * Shot or lists its Shots, which may make its tablet the one holding a
 * Shot. Only the connection holding its Machine is written to.
 *
 * A write Decaid refuses, or the plugin does not answer in time, leaves its
 * edits due, and its Shot is sent nothing more for a while, rather than
 * asked again at once; the other Shots' go on. It is tried again within
 * `retryMs`, on one timer for every Shot so held, with whatever was made
 * since, as Decaid may have refused it for a moment, as when it is busy,
 * while a tablet may stay connected for days, and on the tablet's next
 * connection. So is a look that failed, as when the database could not be
 * reached. The plugin carries out the writes it is sent one at a time, in
 * the order they arrive, so one tried again while an earlier one is still
 * under way lands after it.
 *
 * A write is sent for the version of the Shot the server holds, and the
 * plugin writes nothing where the tablet's is later (`changed`, ticket
 * #513): the tablet changed the Shot, and its report of that is on its way.
 * The Shot is sent nothing more until this connection reports it
 * (`reported`), when its edits have been decided against that version and
 * what still stands is due for it; or, had it reported it since the look
 * for that write began, at once. A report that never comes leaves the Shot for the same
 * timer. A tablet that no longer holds the Shot (`notHeld`) has its edits
 * marked, so they are due no more, and the next Shot goes on.
 *
 * Only an edit sent on this connection and not yet answered is answered
 * (`awaits`): the one awaited, or one whose answer comes after its time
 * was up, which the Shot on the tablet holds all the same.
 */
export class ShotEditWrites {
  private running = false;
  /** Woken while looking: look again once done. */
  private again = false;
  private stopped = false;
  /** The edit awaiting its answer. */
  private waiting: { id: string; settle: (outcome: Outcome) => void } | undefined;
  /** The edits sent on this connection that the plugin has not answered, by their ids: the one awaited, and those whose time ran out. */
  private readonly unanswered = new Map<string, ShotEdit>();
  /** The Shots this connection has reported since the last look for what is due began, which read them as they then stood. */
  private readonly reportedSince = new Set<string>();
  /** The Shots whose edit was refused, or not answered in time, on this connection, until they are tried again. */
  private readonly skipped = new Set<string>();
  /** Set while the Shots skipped wait to be tried again. */
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** The edit the tablet is due next, leaving out the Shots skipped; null where none is, or the connection no longer holds its Machine. */
    private readonly due: (skipped: readonly string[]) => Promise<ShotEdit | null>,
    /** Sends an edit on the connection, in chunks if it is too large for one frame. */
    private readonly send: (edit: ShotEdit) => void,
    private readonly log: { warn(message: string): void; error(message: string): void },
    /** Keeps database work in the instance's work in flight, which shutdown waits for. */
    private readonly track: (work: Promise<void>) => Promise<void>,
    /** The longest a Shot whose write was refused, or not answered in time, waits before it is tried again. */
    private readonly retryMs: number,
  ) {}

  /** Looks for edits due, now or, if it is writing, once that is done. */
  wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.track(
      this.run()
        .catch((error: unknown) => {
          this.log.error(`Could not write a tablet the edits of its Shots: ${String(error)}`);
          // Nothing else may wake a connection that stays open: it looks again as it tries the Shots skipped again.
          this.retryLater();
        })
        .finally(() => {
          this.running = false;
          // Woken as the look ended: nothing else would look for what that wake was for.
          if (this.again) this.wake();
        }),
    );
  }

  /** Whether the edit was sent on this connection and its answer has not been taken. */
  awaits(id: string): boolean {
    return this.unanswered.has(id);
  }

  /**
   * The plugin answered an edit this connection awaits (`awaits`), and what
   * it answered is recorded. An answer that comes after its time was up
   * lets its Shot's later edits go on, unless it was refused, or the Shot
   * changed and its report is still to come.
   */
  answered(id: string, outcome: ShotEditedOutcome): void {
    const edit = this.unanswered.get(id);
    if (edit === undefined) return;
    this.unanswered.delete(id);
    if (this.waiting?.id === id) return this.waiting.settle(outcome);
    if (this.goesOn(edit.shotId, outcome) && this.skipped.delete(edit.shotId)) this.wake();
  }

  /**
   * What this connection has written to the Shot on its tablet and has had
   * no answer to: a version of the Shot it then reports may be Decaid's
   * report of one of them, not a change made on the tablet.
   */
  sent(shotId: string): ShotEdit[] {
    return [...this.unanswered.values()].filter((edit) => edit.shotId === shotId);
  }

  /**
   * The connection reported the Shot, and the report was stored: its
   * tablet holds it from now on, and what its edits are due is as that
   * version left them. A Shot held back is looked at again.
   */
  reported(shotId: string): void {
    this.reportedSince.add(shotId);
    this.skipped.delete(shotId);
    this.wake();
  }

  /** The connection closed: nothing more is sent on it. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.waiting?.settle("stopped");
  }

  private async run(): Promise<void> {
    for (;;) {
      this.again = false;
      // What was reported before now, this look reads; what is reported from now on, a write it sends may be too early for.
      this.reportedSince.clear();
      const edit = await this.due([...this.skipped]);
      if (this.stopped) return;
      if (edit === null) {
        if (this.again) continue;
        return;
      }
      const outcome = await this.ask(edit);
      if (outcome === "stopped") return;
      if (outcome === "timedOut") this.log.warn(`A tablet did not answer edit ${edit.id} of a Shot in ${ANSWER_TIMEOUT_MS / 1000} s`);
      else if (this.goesOn(edit.shotId, outcome)) continue;
      this.skip(edit.shotId);
    }
  }

  /**
   * Whether the Shot's edits go on after an answer: once written, or marked
   * as having no tablet to reach, there is no more of that write to send;
   * and where the Shot had changed on the tablet, once this connection has
   * reported it since the look that sent the write began, as what is due
   * is then for the version it reported.
   */
  private goesOn(shotId: string, outcome: ShotEditedOutcome): boolean {
    return outcome === "written" || outcome === "notHeld" || (outcome === "changed" && this.reportedSince.has(shotId));
  }

  /** Sends the Shot nothing more until the Shots skipped are tried again, within `retryMs`. */
  private skip(shotId: string): void {
    this.skipped.add(shotId);
    this.retryLater();
  }

  /** Looks again in `retryMs`, with no Shot skipped, unless it is already set to. */
  private retryLater(): void {
    if (this.stopped) return;
    this.retry ??= setTimeout(() => {
      this.retry = undefined;
      this.skipped.clear();
      this.wake();
    }, this.retryMs);
  }

  /** Sends an edit and resolves with what became of it. */
  private ask(edit: ShotEdit): Promise<Outcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle("timedOut"), ANSWER_TIMEOUT_MS);
      const settle = (outcome: Outcome) => {
        clearTimeout(timer);
        if (this.waiting?.id === edit.id) this.waiting = undefined;
        resolve(outcome);
      };
      this.waiting = { id: edit.id, settle };
      this.unanswered.set(edit.id, edit);
      this.send(edit);
    });
  }
}
