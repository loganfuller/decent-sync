import { DYE2_NAMESPACE } from "@decent-sync/protocol";
import { request } from "./decaid.js";

// DYE2's selected recipe kept in step with the Machine's Loaded Recipe
// (ADR-0022). From DYE2 v0.1.20, DYE2 keeps one selected recipe or favourite,
// which its dashboard selects as it applies one and Streamline's strip
// selects through DYE2's `selection` endpoint, and records into it each
// change of the Workflow's dial it sees, whichever app made it, the
// plugin's writes included, but for its own applies (`workflow-record.ts` in
// dye2:dye2-plugin/src/utils at v0.1.20). Left to itself, it records into a
// recipe that is not the Loaded Recipe: one still selected after the plugin
// unloaded it on a change of grinder or Bean, which DYE2 does not clear on,
// or one selected before the barista dialled in another by hand. Each such
// change would be taken in as an edit of that Recipe, and reach every
// Machine that has it loaded. So the plugin selects the Loaded Recipe through
// that endpoint, as Streamline does, and clears its selection of a recipe
// it unloaded, following DYE2's own model rather than working around it.
// A tablet without DYE2, or with a release before v0.1.20, answers 404,
// which changes nothing.

const SELECTION = `/plugins/${DYE2_NAMESPACE}/selection`;

/** The Loaded Recipe as DYE2's selection follows it: its global id, its Recipe Slot, the slot's id in DYE2, and its profile's key. */
export interface Followed {
  globalId: string | null;
  slot: number | null;
  /** The Workflow's profile, as `profileKey` reads it: DYE2 clears its selection as the profile changes, so it is selected again. */
  profile: string | null;
}

export class Dye2Selection {
  /** What DYE2 was last told, or undefined before the first Workflow the plugin saw. */
  private told: Followed | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** Whether a failure was logged since the last success, so a Decaid failing every request logs once. */
  private failing = false;

  constructor(private readonly log: (message: string) => void) {}

  /**
   * The Loaded Recipe the Workflow names once the plugin has decided on it:
   * DYE2 selects it where it is in a slot the tablet holds, again as it
   * moves to another slot, or as its profile changes, which clears DYE2's
   * selection; and a recipe it no longer names is cleared from DYE2's
   * selection while DYE2 still has it selected. The first Workflow the
   * plugin sees, as on every load of it, clears nothing: DYE2 may hold a
   * selection a barista made since.
   */
  follow(next: Followed): void {
    const told = this.told;
    if (told && told.globalId === next.globalId && told.slot === next.slot && (next.globalId === null || told.profile === next.profile)) return;
    this.told = next;
    if (next.globalId !== null && next.slot !== null) {
      this.send(() => this.select(next.slot!));
    } else if (told?.globalId && told.slot !== null && next.globalId === null) {
      const slot = told.slot;
      this.send(() => this.clear(slot));
    }
  }

  /** Has DYE2 select the recipe in that slot, as its dashboard does as it applies one. */
  private async select(slot: number): Promise<void> {
    await this.post({ kind: "recipe", id: String(slot) });
  }

  /** Clears DYE2's selection while it is still the recipe in that slot, leaving another the barista selected since. */
  private async clear(slot: number): Promise<void> {
    const answer = await request("GET", SELECTION);
    if (answer.status === 404) return;
    if (!answer.ok) throw new Error(`Decaid answered ${answer.status} reading DYE2's selection`);
    const selected = parsed(answer.text);
    if (!isObject(selected) || selected.kind !== "recipe" || String(selected.id) !== String(slot)) return;
    await this.post({});
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    const answer = await request("POST", SELECTION, body);
    if (!answer.ok && answer.status !== 404) throw new Error(`Decaid answered ${answer.status} setting DYE2's selection`);
  }

  /** Runs each request in turn, logging a failure once until one succeeds. */
  private send(work: () => Promise<void>): void {
    this.queue = this.queue
      .then(work)
      .then(() => {
        this.failing = false;
      })
      .catch((error: unknown) => {
        if (!this.failing) this.log(`Could not keep DYE2's selected recipe in step with the Loaded Recipe: ${error instanceof Error ? error.message : String(error)}`);
        this.failing = true;
      });
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
