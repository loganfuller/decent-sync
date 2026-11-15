import { randomUUID } from "node:crypto";
import { MAX_REFERENCE_COPY_BYTES, type ReferenceCopy } from "@decent-sync/protocol";
import type { DueCopy } from "../shots/location-references.js";

/**
 * How many bytes may wait to be sent on a connection before a look for
 * copies due is put off: one copy's worth. A copy may be a megabyte, each
 * edit of a Reference Shot's rating or note sends every tablet at its
 * Recipes' Locations another, and what a tablet has not taken waits in this
 * instance's memory. A look sends only what differs from what the tablet
 * holds, so the looks put off while a slow tablet catches up send it each
 * slot's latest copy once, and what waits for it stays within this and one
 * look's copies.
 */
export const MAX_WAITING_FOR_COPIES_BYTES = MAX_REFERENCE_COPY_BYTES;

/** How long a look put off waits before it is tried again. */
const LOOK_AGAIN_MS = 1_000;

/**
 * Keeps the Reference Shot copies on the tablet of one connection this
 * instance holds current (ticket #510, ADR-0030): for each Recipe in a slot
 * at the Location its Machine is served at, a copy of its Reference Shot,
 * whole, which its plugin keeps in its storage, so a Skin still draws the
 * reference while the server can't be reached.
 *
 * What the tablet holds is what its plugin says on each connection
 * (`referencesHeld`), the version of its copy for each slot, and what this
 * connection has sent it since: it belongs to the connection alone, so it
 * is kept in this instance's memory, and nothing is sent before the plugin
 * has said it. What it is due is read from the database each time
 * (`due`), so it reflects changes made through any instance, and only the
 * copies that differ are sent: the instance is woken to look again when a
 * change to the Library, or a move of the Machine, is notified, and when
 * its notifications may have been missed. So a tablet that was off catches
 * up when it reconnects, on any instance.
 *
 * The plugin answers no copy. One it could not keep is missing from what it
 * says on its next connection, and is sent again then.
 *
 * While more than MAX_WAITING_FOR_COPIES_BYTES wait to be sent on the
 * connection, it sends nothing more, and looks again a little later.
 */
export class ReferenceCopies {
  /** The version of the copy the tablet holds for each slot; undefined until its plugin has said. */
  private held: Map<number, string> | undefined;
  private running = false;
  /** Woken while looking: look again once done. */
  private again = false;
  private stopped = false;
  /** Set while a look put off waits to be tried again. */
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** The copies due to the tablet, given what it holds; null where the connection no longer holds its Machine. */
    private readonly due: (held: ReadonlyMap<number, string>) => Promise<DueCopy[] | null>,
    /** Sends a copy on the connection, in chunks if it is too large for one frame. */
    private readonly send: (copy: ReferenceCopy) => void,
    private readonly log: { error(message: string): void },
    /** Keeps database work in the instance's work in flight, which shutdown waits for. */
    private readonly track: (work: Promise<void>) => Promise<void>,
    /** How many bytes wait to be sent on the connection now. */
    private readonly waiting: () => number = () => 0,
  ) {}

  /** The plugin said what it holds: the version of its copy for each slot, by the slot's number. */
  stated(held: Readonly<Record<string, string>>): void {
    this.held = new Map(Object.entries(held).map(([slot, version]) => [Number(slot), version]));
    this.wake();
  }

  /** Looks for copies due, now or, if it is looking, once that is done. */
  wake(): void {
    if (this.stopped || this.held === undefined) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.track(
      this.run()
        .catch((error: unknown) => this.log.error(`Could not send a tablet its Reference Shot copies: ${String(error)}`))
        .finally(() => {
          this.running = false;
        }),
    );
  }

  /** The connection closed: nothing more is sent on it. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
  }

  private async run(): Promise<void> {
    do {
      this.again = false;
      if (this.waiting() > MAX_WAITING_FOR_COPIES_BYTES) {
        this.retry ??= setTimeout(() => {
          this.retry = undefined;
          this.wake();
        }, LOOK_AGAIN_MS);
        return;
      }
      const held = this.held!;
      const due = await this.due(held);
      if (this.stopped || due === null) return;
      for (const { slot, copy } of due) {
        this.send({ type: "referenceCopy", id: randomUUID(), slot, copy });
        if (copy === null) held.delete(slot);
        else held.set(slot, copy.version);
      }
    } while (this.again);
  }
}
