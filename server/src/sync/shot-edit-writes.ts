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
 * written of the Shots that tablet holds, in the order they were made, one
 * at a time, each once the plugin has answered the one before it and that
 * answer is recorded.
 *
 * What is due is read from the database each time (`due`), so it reflects
 * edits made through any instance: the instance is woken to look when the
 * connection is welcomed, so a tablet that was off is written what was made
 * meanwhile, when an edit for its tablet is notified, when its
 * notifications may have been missed, and when the connection reports a
 * Shot or lists its Shots, which may make its tablet the one holding a
 * Shot. Only the connection holding its Machine is written to.
 *
 * An edit Decaid refuses, or the plugin does not answer in time, stays due,
 * and no later edit of its Shot is sent on this connection, so a Shot's
 * edits reach its tablet in the order they were made; the other Shots' go
 * on. It is tried again on the tablet's next connection.
 */
export class ShotEditWrites {
  private running = false;
  /** Woken while looking: look again once done. */
  private again = false;
  private stopped = false;
  /** The edit awaiting its answer. */
  private waiting: { id: string; settle: (outcome: Outcome) => void } | undefined;
  /** The Shots whose edit was refused, or not answered in time, on this connection. */
  private readonly skipped = new Set<string>();

  constructor(
    /** The edit the tablet is due next, leaving out the Shots skipped; null where none is, or the connection no longer holds its Machine. */
    private readonly due: (skipped: readonly string[]) => Promise<ShotEdit | null>,
    /** Sends an edit on the connection, in chunks if it is too large for one frame. */
    private readonly send: (edit: ShotEdit) => void,
    private readonly log: { warn(message: string): void; error(message: string): void },
    /** Keeps database work in the instance's work in flight, which shutdown waits for. */
    private readonly track: (work: Promise<void>) => Promise<void>,
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
        .catch((error: unknown) => this.log.error(`Could not write a tablet the edits of its Shots: ${String(error)}`))
        .finally(() => {
          this.running = false;
          // Woken as the look ended: nothing else would look for what that wake was for.
          if (this.again) this.wake();
        }),
    );
  }

  /** The plugin answered an edit, and a `written` answer is recorded. An answer to an edit not awaited, such as a late one, is ignored. */
  answered(id: string, written: boolean): void {
    if (this.waiting?.id === id) this.waiting.settle(written ? "written" : "refused");
  }

  /** The connection closed: nothing more is sent on it. */
  stop(): void {
    this.stopped = true;
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
      if (outcome === "timedOut") {
        this.log.warn(`A tablet did not answer edit ${edit.id} of a Shot in ${ANSWER_TIMEOUT_MS / 1000} s; it is tried again once the tablet reconnects`);
      }
      if (outcome !== "written") this.skipped.add(edit.shotId);
    }
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
      this.send(edit);
    });
  }
}
