import type { ShotEdit } from "@decent-sync/protocol";

/**
 * How long the plugin has to answer an edit. It makes one request of Decaid
 * for each, which Decaid's fetch gives up on after 30 s, and carries them
 * out one at a time, each sent once the one before it is answered.
 */
const ANSWER_TIMEOUT_MS = 60_000;

/** What became of an edit sent: written, refused by Decaid, unanswered in time, or abandoned as the connection closed. */
type Outcome = "written" | "refused" | "timedOut" | "stopped";

/**
 * Writes the edits of Shots made through the server (ADR-0031, ticket #512)
 * to the tablet of one connection this instance holds: those not yet
 * written of the Shots that tablet holds, a Shot at a time, the one whose
 * edit has waited longest first, each write carrying the latest value of
 * each field that Shot's unwritten edits set, and sent once the plugin has
 * answered the one before it and that answer is recorded.
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
 * edits due, and its Shot is sent nothing more meanwhile, so a write the
 * plugin may still be carrying out is never overtaken by a later one; the
 * other Shots' go on. It is tried again after `retryMs`, with whatever was
 * made since, as Decaid may have refused it for a moment, as when it is
 * busy, while a tablet may stay connected for days, and on the tablet's
 * next connection. So is a look that failed, as when the database could
 * not be reached.
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
  /** The edits sent on this connection that the plugin has not answered, each with its Shot: the one awaited, and those whose time ran out. */
  private readonly unanswered = new Map<string, string>();
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
    /** How long a Shot whose edit was refused, or not answered in time, waits before it is tried again. */
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
   * The plugin answered an edit this connection awaits (`awaits`), and a
   * `written` answer is recorded. One that comes after its time was up
   * lets its Shot's later edits go on, if it was written.
   */
  answered(id: string, written: boolean): void {
    const shotId = this.unanswered.get(id);
    if (shotId === undefined) return;
    this.unanswered.delete(id);
    if (this.waiting?.id === id) return this.waiting.settle(written ? "written" : "refused");
    if (written && this.skipped.delete(shotId)) this.wake();
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
      const edit = await this.due([...this.skipped]);
      if (this.stopped) return;
      if (edit === null) {
        if (this.again) continue;
        return;
      }
      const outcome = await this.ask(edit);
      if (outcome === "stopped") return;
      if (outcome === "written") continue;
      if (outcome === "timedOut") this.log.warn(`A tablet did not answer edit ${edit.id} of a Shot in ${ANSWER_TIMEOUT_MS / 1000} s`);
      this.skip(edit.shotId);
    }
  }

  /** Sends the Shot nothing more until the Shots skipped are tried again, `retryMs` after the first of them was. */
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
      this.unanswered.set(edit.id, edit.shotId);
      this.send(edit);
    });
  }
}
