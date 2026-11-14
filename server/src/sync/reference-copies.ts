import { randomUUID } from "node:crypto";
import type { ReferenceCopy } from "@decent-sync/protocol";
import type { DueCopy } from "../shots/location-references.js";

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
 */
export class ReferenceCopies {
  /** The version of the copy the tablet holds for each slot; undefined until its plugin has said. */
  private held: Map<number, string> | undefined;
  private running = false;
  /** Woken while looking: look again once done. */
  private again = false;
  private stopped = false;

  constructor(
    /** The copies due to the tablet, given what it holds; null where the connection no longer holds its Machine. */
    private readonly due: (held: ReadonlyMap<number, string>) => Promise<DueCopy[] | null>,
    /** Sends a copy on the connection, in chunks if it is too large for one frame. */
    private readonly send: (copy: ReferenceCopy) => void,
    private readonly log: { error(message: string): void },
    /** Keeps database work in the instance's work in flight, which shutdown waits for. */
    private readonly track: (work: Promise<void>) => Promise<void>,
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
  }

  private async run(): Promise<void> {
    do {
      this.again = false;
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
