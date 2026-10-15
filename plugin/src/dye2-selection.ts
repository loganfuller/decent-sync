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

/** The Loaded Recipe as DYE2's selection follows it: its global id, its Recipe Slot, and the Workflow's profile as DYE2 tells it apart. */
export interface Followed {
  globalId: string | null;
  slot: number | null;
  /** The Workflow's profile, as DYE2 fingerprints it (`dye2Fingerprint`): DYE2 clears its selection as that changes, so it is selected again. */
  profile: string | null;
}

/**
 * A profile as DYE2 fingerprints one to tell a change of profile, which
 * clears its selection (`profileFingerprint` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at v0.1.20): its title,
 * target weight and volume, tank temperature and steps, but each step's
 * temperature. Null for none.
 */
export function dye2Fingerprint(profile: unknown): string | null {
  if (!isObject(profile)) return null;
  const steps = Array.isArray(profile.steps)
    ? profile.steps.map((step: unknown) => {
        if (!isObject(step)) return step;
        const { temperature: _, ...rest } = step;
        return rest;
      })
    : profile.steps;
  return JSON.stringify({
    title: profile.title,
    target_weight: profile.target_weight,
    target_volume: profile.target_volume,
    tank_temperature: profile.tank_temperature,
    steps,
  });
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
   * selection while DYE2 still has it selected, in the slot it was last told
   * of, though the tablet holds it in none by then. A recipe the tablet holds
   * in no slot is never selected, as another may be in the slot it left. The
   * first Workflow the plugin sees, as on every load of it, clears nothing:
   * DYE2 may hold a selection a barista made since. DYE2 names a recipe by
   * its slot alone, so a selection the barista made since of another recipe
   * put in the slot the unloaded one left is cleared with it.
   */
  follow(followed: Followed): void {
    const told = this.told;
    // A Loaded Recipe gone from the tablet's slots, as before the server clears it, keeps the slot DYE2 was told of, so
    // it is cleared from there, but is never selected there again.
    const slot = followed.slot ?? (told?.globalId === followed.globalId ? told.slot : null);
    const next = { ...followed, slot };
    if (told && told.globalId === next.globalId && told.slot === next.slot && (next.globalId === null || told.profile === next.profile)) return;
    this.told = next;
    if (followed.globalId !== null && followed.slot !== null) {
      this.send(() => this.select(followed.slot!));
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
