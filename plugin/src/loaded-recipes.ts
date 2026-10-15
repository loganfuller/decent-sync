import { DYE2_NAMESPACE, LOADED_RECIPE_KEY, RECIPE_FIELD, dye2Records, loadedRecipeOf } from "@decent-sync/protocol";
import { type Answer, request } from "./decaid.js";
import type { WorkflowChanges } from "./library-writes.js";
import {
  type Dial,
  type HeldRecipe,
  type LoadContext,
  type RecipeDial,
  type WorkflowSetUp,
  chooseLoad,
  loadWrite,
  loadable,
  matches,
  profileIds,
  profileKey,
  recipeDials,
  resolveDial,
  sameDial,
  sameRecipeDial,
  unloads,
  workflowBatch,
  workflowDial,
} from "./recipe-matching.js";

// Each Machine's Loaded Recipe (ADR-0022), worked out on the tablet from its
// Workflow and recorded in it, so a load made while the tablet is offline is
// recorded too, and every Shot pulled with it names it. Decaid copies the
// Workflow's context onto each Shot, and the server reads the Loaded Recipe
// from the Workflow deliveries.
//
// On each change of the Workflow's dial or Bean Batch, the plugin reads
// DYE2's recipes and decides (recipe-matching.ts): a Workflow that now
// matches one of them, as it is or as the tablet held it before, has loaded
// it, and the plugin writes the recipe's current values into the Workflow,
// with what applying a DYE2 recipe leaves out, and its global id; a change of
// the profile, grinder or Bean to one the Loaded Recipe does not name
// unloads it, and the plugin clears the id. The Workflow's changes are held
// back meanwhile (`WorkflowChanges`), so the server reads only the Workflow
// after the plugin's write, and never the plugin's own write as a change.

const RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;

/** The most dials kept of those each recipe held before, the oldest dropped first. */
export const MAX_EARLIER_DIALS = 20;

/** The most recipes whose earlier dials are kept, those seen least recently dropped first. */
const MAX_KEPT_RECIPES = 200;

/** How long after a decision Decaid failed the plugin tries it again, doubling up to MAX_RETRY_MS. */
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

export class LoadedRecipes {
  /** The latest Workflow Decaid reported. */
  private latest: Record<string, unknown> | undefined;
  /** The dial and Bean Batch of the latest Workflow decided on, which a change is judged against. */
  private decided: Decided | undefined;
  private running = false;
  /** Whether the Workflow's changes are held back while it decides (`observe`). */
  private holding = false;
  private again = false;
  private stopped = false;
  /** Set while a decision Decaid failed waits to be tried again, with how long the next failure waits. */
  private retryTimer: number | undefined;
  private retryMs = FIRST_RETRY_MS;
  /** The dials each recipe the tablet held holds, by global id, as last read, in the order last seen. */
  private readonly seen = new Map<string, RecipeDial[]>();
  /** The dials each recipe the tablet held before, by global id, oldest first: what a stale DYE2 page or Streamline strip applies. */
  private readonly earlier = new Map<string, RecipeDial[]>();
  /** The tablet's profiles read, by id: Decaid derives a profile's id from what it holds, so one id always holds the same. */
  private readonly profiles = new Map<string, Record<string, unknown>>();
  /** The Bean of each of the tablet's Bean Batches read, by their ids there, null for one it does not hold: a batch's Bean never changes. */
  private readonly beans = new Map<string, string | null>();

  constructor(
    /** Holds back the Workflow's changes the plugin sends while it decides and writes. */
    private readonly changes: WorkflowChanges,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Decaid's `workflowUpdated`, before the Workflow is queued: on a change of
   * its dial or Bean Batch, the plugin decides whether it loads or unloads a
   * recipe and writes what that needs, as it does for any change Decaid
   * reports meanwhile. The change is held back until then, so the server
   * never reads a Workflow as a stale copy applied it, if it names a Loaded
   * Recipe, which the change may unload or replace, or matches a recipe as
   * the tablet held it when last read. Any other is sent at once, as it is
   * kept in Decaid's plugin storage as it is queued, so an unload of the
   * plugin meanwhile loses none: it names no Recipe the server could take it
   * for, and a load the plugin then finds, of a recipe saved since it last
   * read them, is sent after it.
   */
  observe(workflow: Record<string, unknown>): void {
    if (this.stopped) return;
    this.latest = workflow;
    if (this.running) {
      this.again = true;
    } else {
      if (this.decided && sameSetUp(this.decided, workflow)) return;
      this.running = true;
      void this.run();
    }
    if (!this.holding && (loadedRecipeOf(workflow) !== null || this.mayLoad(workflowDial(workflow)))) {
      this.holding = true;
      this.changes.hold();
    }
  }

  /**
   * Whether a dial matches any dial of a recipe the tablet held as last
   * read, now or before, a profile not looked up yet matching any.
   */
  private mayLoad(dial: Dial): boolean {
    return [...this.seen.values(), ...this.earlier.values()].some((dials) =>
      dials.some((recipeDial) => matches(resolveDial(recipeDial, (id) => profileKey(this.profiles.get(id))), dial)),
    );
  }

  /**
   * DYE2's recipes as a read of them found them, whoever read them: each
   * recipe's dials it held before are kept, so a stale copy applied later
   * is still taken for it. A list in a shape not recognised changes nothing.
   */
  sawRecipes(value: unknown): void {
    const records = value === null ? [] : dye2Records(value, "recipes");
    if (records === null) return;
    for (const { globalId, record } of loadable(records)) {
      const dials = recipeDials(record);
      const before = this.seen.get(globalId);
      this.seen.delete(globalId);
      this.seen.set(globalId, dials);
      if (!before) continue;
      const earlier = (this.earlier.get(globalId) ?? []).filter((kept) => !dials.some((dial) => sameRecipeDial(dial, kept)));
      for (const dial of before) {
        if (dials.some((now) => sameRecipeDial(now, dial))) continue;
        const at = earlier.findIndex((kept) => sameRecipeDial(kept, dial));
        if (at !== -1) earlier.splice(at, 1);
        earlier.push(dial);
      }
      this.earlier.delete(globalId);
      if (earlier.length > 0) this.earlier.set(globalId, earlier.slice(-MAX_EARLIER_DIALS));
    }
    for (const map of [this.seen, this.earlier] as const) {
      for (const globalId of [...map.keys()].slice(0, Math.max(0, map.size - MAX_KEPT_RECIPES))) map.delete(globalId);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
  }

  /**
   * Decides on the latest Workflow, again while Decaid reports changes
   * meanwhile, then sends the latest if it held any. A decision Decaid fails
   * is judged against the Workflow decided on before it, and tried again
   * later, as no change may come to try it: the Workflow is sent meanwhile,
   * still naming the Loaded Recipe it named.
   */
  private async run(): Promise<void> {
    // Decided from the next turn on, once `observe` has decided whether to hold the change back.
    await Promise.resolve();
    try {
      do {
        this.again = false;
        const workflow = this.latest!;
        try {
          await this.decide(workflow);
          this.retryMs = FIRST_RETRY_MS;
        } catch (error) {
          this.log(`Could not work out the Loaded Recipe, trying again in ${this.retryMs / 1000} s: ${error instanceof Error ? error.message : String(error)}`);
          this.retryLater();
        }
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
      if (this.holding) {
        this.holding = false;
        this.changes.release();
      }
    }
  }

  /** Tries the latest Workflow again once the wait is over, unless a change tries it first. */
  private retryLater(): void {
    if (this.retryTimer !== undefined || this.stopped) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.latest) this.observe(this.latest);
    }, wait);
  }

  /**
   * Whether the Workflow's change from the one decided on loads one of the
   * tablet's recipes or unloads its Loaded Recipe, and records that in it;
   * it then becomes the Workflow decided on. A change of its dial may load
   * one; a change of its Bean Batch alone loads none, and only another Bean
   * unloads it. A batch picked in the same change, which no app applying a
   * recipe does, stays, and a recipe of another Bean is none it loads. Where
   * the Workflow changed again before the write, nothing is written, and the
   * Workflow decided on stays as it was, so the latest is judged as one
   * change from it, as the changes between were. Throws if Decaid fails what
   * it needs, leaving the Workflow decided on as it was.
   */
  private async decide(workflow: Record<string, unknown>): Promise<void> {
    const before = this.decided;
    const dial = workflowDial(workflow);
    const batch = workflowBatch(workflow);
    if (before && sameDial(before.dial, dial) && before.batch === batch) return;
    const records = await this.readRecipes();
    const held = await this.held(records);
    const named = loadedRecipeOf(workflow);
    const picked = before !== undefined && batch !== before.batch;
    const pickedBean = picked && batch !== null ? await this.beanOf(batch) : null;
    const chosen = before && sameDial(before.dial, dial) ? null : chooseLoad(dial, named, held, pickedBean);
    const after = { dial, batch };
    let stillHeld = true;
    if (chosen) stillHeld = await this.load(chosen, after, picked);
    else if (named !== null && before) stillHeld = await this.unloadIfChanged(before, after, held, named);
    if (stillHeld) this.decided = after;
  }

  /**
   * Unloads the Workflow's Loaded Recipe if its change from `before` to
   * `after` does (`unloads`). The Workflow the plugin first heard of, as on
   * every load, unloads nothing: it is no change. Resolves with whether the
   * Workflow still held `after` when it was to be written.
   */
  private async unloadIfChanged(before: Decided, after: Decided, held: readonly HeldRecipe[], named: string): Promise<boolean> {
    const { batch, dial } = after;
    const loaded = held.find((recipe) => recipe.globalId === named);
    // A Loaded Recipe the tablet no longer holds in a slot stays: the server unloads it.
    if (!loaded) return true;
    const current = await this.resolved(recipeDials(loaded.record));
    // A batch's Bean is read only as the batch changes, which alone changes the Bean.
    const changed = batch !== before.batch;
    const bean = async (batchId: string | null) => (changed && batchId !== null ? this.beanOf(batchId) : null);
    const setUps: [WorkflowSetUp, WorkflowSetUp] = [
      { dial: before.dial, bean: await bean(before.batch) },
      { dial, bean: await bean(batch) },
    ];
    return unloads(...setUps, current, beanOfRecord(loaded.record)) ? this.unload(named, after) : true;
  }

  /**
   * The tablet's recipes, read now: none from a key never written, or a list
   * in a shape not recognised (`dye2Records`), which loads nothing. Throws if
   * Decaid does not answer with them.
   */
  private async readRecipes(): Promise<Record<string, unknown>[]> {
    const answer = await request("GET", RECIPES);
    const value = answer.ok ? parsed(answer.text) : undefined;
    if (value === undefined) throw new Error(`Decaid answered ${answer.status} reading DYE2's recipes`);
    this.sawRecipes(value);
    return value === null ? [] : (dye2Records(value, "recipes") ?? []);
  }

  /** The recipes a Workflow can load, each with every dial it holds and held before, their profiles looked up. */
  private async held(records: readonly Record<string, unknown>[]): Promise<HeldRecipe[]> {
    return Promise.all(
      loadable(records).map(async ({ globalId, slot, record }) => ({
        globalId,
        slot,
        record,
        dials: await this.resolved([...recipeDials(record), ...(this.earlier.get(globalId) ?? [])]),
      })),
    );
  }

  /** Recipe dials with each profile named by its id looked up among the tablet's profiles. */
  private async resolved(dials: readonly RecipeDial[]): Promise<Dial[]> {
    for (const id of new Set(profileIds(dials))) await this.profileOf(id);
    return dials.map((dial) => resolveDial(dial, (id) => profileKey(this.profiles.get(id))));
  }

  /** The tablet's profile with that id, hidden ones included, or null if it holds none. Throws if Decaid does not answer with it. */
  private async profileOf(id: string): Promise<Record<string, unknown> | null> {
    const known = this.profiles.get(id);
    if (known) return known;
    const record = await this.readRecord(`/profiles/${encodeURIComponent(id)}`);
    const profile = isObject(record) && isObject(record.profile) ? record.profile : null;
    if (profile) this.profiles.set(id, profile);
    return profile;
  }

  /** The Bean of the tablet's Bean Batch with that id, or null if it holds none. Throws if Decaid does not answer with it. */
  private async beanOf(batchId: string): Promise<string | null> {
    if (this.beans.has(batchId)) return this.beans.get(batchId)!;
    const record = await this.readRecord(`/bean-batches/${encodeURIComponent(batchId)}`);
    const bean = isObject(record) && typeof record.beanId === "string" ? record.beanId : null;
    this.beans.set(batchId, bean);
    return bean;
  }

  /** The record at that path of Decaid's API, or null if it holds none (404). Throws if Decaid answers otherwise. */
  private async readRecord(path: string): Promise<unknown> {
    const answer = await request("GET", path);
    if (answer.status === 404) return null;
    const record = answer.ok ? parsed(answer.text) : undefined;
    if (record === undefined) throw new Error(`Decaid answered ${answer.status} reading ${path}`);
    return record;
  }

  /**
   * Records a load: writes the recipe's current values and global id into
   * the Workflow (`loadWrite`, `writeIfDecided`), but its Bean Batch where a
   * batch was picked in the same change (`picked`). Decaid refuses to change
   * the hot water settings while no machine is connected, so the rest is
   * then written without them, the Workflow read and checked again.
   * Resolves with whether the Workflow still held `decided` when written.
   */
  private async load(recipe: HeldRecipe, decided: Decided, picked: boolean): Promise<boolean> {
    // Everything else is read first, so each write follows the Workflow's last read at once.
    const read = await this.loadContext(recipe.record);
    const context = picked ? { ...read, batch: null } : read;
    let hotWater = false;
    const write = (withHotWater: boolean) => (workflow: Record<string, unknown>) => {
      const all = loadWrite(workflow, recipe.record, recipe.globalId, context);
      if (all === null || withHotWater) {
        hotWater = all !== null && "hotWaterData" in all;
        return all;
      }
      const { hotWaterData: _, ...rest } = all;
      return Object.keys(rest).length > 0 ? rest : null;
    };
    let answer = await this.writeIfDecided(decided, write(true));
    if (answer !== "changed" && answer && !answer.ok && hotWater && machineMissing(answer)) answer = await this.writeIfDecided(decided, write(false));
    if (answer === "changed") return false;
    if (answer && !answer.ok) throw new Error(`Decaid answered ${answer.status} recording the recipe in slot ${recipe.slot} as loaded: ${answer.text.slice(0, 200)}`);
    return true;
  }

  /**
   * Writes into the Workflow what `build` makes of it, read again just
   * before, unless its dial or Bean Batch is no longer the one decided on,
   * as when a barista picked another batch or set the grinder back
   * meanwhile, which is then decided on in turn. Resolves with Decaid's
   * answer, null where there was nothing to write, or `changed` where the
   * Workflow no longer held what was decided on. Decaid has no conditional
   * write, so a change made between that read and the write is written over
   * where the write sets the same field.
   */
  private async writeIfDecided(decided: Decided, build: (workflow: Record<string, unknown>) => Record<string, unknown> | null): Promise<Answer | "changed" | null> {
    const workflow = await this.workflowNow();
    if (!sameSetUp(decided, workflow)) return "changed";
    const write = build(workflow);
    return write === null ? null : request("PUT", "/workflow", write);
  }

  /** What a load of the recipe writes besides its record: its full Profile, as applying it loads one, and its Bean Batch as the tablet holds it. */
  private async loadContext(record: Record<string, unknown>): Promise<LoadContext> {
    const snapshot = record.profileSnapshot;
    const profile = isObject(snapshot) && Array.isArray(snapshot.steps) ? snapshot : typeof record.profileId === "string" ? await this.profileOf(record.profileId) : null;
    const kept = isObject(record[RECIPE_FIELD]) ? record[RECIPE_FIELD] : {};
    const batchId = typeof kept.beanBatchId === "string" ? kept.beanBatchId : null;
    if (batchId === null) return { profile, batch: null };
    const beanId = await this.beanOf(batchId);
    if (beanId === null) return { profile, batch: null };
    const bean = await this.readRecord(`/beans/${encodeURIComponent(beanId)}`);
    const text = (field: string) => (isObject(bean) && typeof bean[field] === "string" ? (bean[field] as string) : null);
    return { profile, batch: { id: batchId, coffeeName: text("name"), coffeeRoaster: text("roaster") } };
  }

  /**
   * Records an unload: clears the recipe's global id from the Workflow
   * (`writeIfDecided`), while it still names that recipe and holds the
   * change decided to unload it (`decided`). Resolves with whether it still
   * held that change.
   */
  private async unload(globalId: string, decided: Decided): Promise<boolean> {
    // Decaid merges the Workflow's `extras` key by key, so the key is cleared by setting it to null.
    const answer = await this.writeIfDecided(decided, (workflow) => (loadedRecipeOf(workflow) === globalId ? { context: { extras: { [LOADED_RECIPE_KEY]: null } } } : null));
    if (answer === "changed") return false;
    if (answer && !answer.ok) throw new Error(`Decaid answered ${answer.status} recording the Loaded Recipe as unloaded: ${answer.text.slice(0, 200)}`);
    return true;
  }

  /** The Workflow as Decaid holds it now. Throws if Decaid does not answer with one. */
  private async workflowNow(): Promise<Record<string, unknown>> {
    const answer = await request("GET", "/workflow");
    const workflow = answer.ok ? parsed(answer.text) : undefined;
    if (!isObject(workflow)) throw new Error(`Decaid answered ${answer.status} reading the Workflow`);
    return workflow;
  }
}

/** A Workflow's dial and Bean Batch, as decided on. */
interface Decided {
  dial: Dial;
  batch: string | null;
}

/** Whether a Workflow holds the dial and Bean Batch decided on: if so, it neither loads nor unloads anything. */
function sameSetUp(decided: Decided, workflow: Record<string, unknown>): boolean {
  return sameDial(decided.dial, workflowDial(workflow)) && decided.batch === workflowBatch(workflow);
}

/** The Bean a recipe record names, by the tablet's id for it, or null. */
function beanOfRecord(record: Record<string, unknown>): string | null {
  return typeof record.beanId === "string" && record.beanId !== "" ? record.beanId : null;
}

/** Whether Decaid refused a Workflow change as no machine is connected, which it needs to change the hot water settings. */
function machineMissing(answer: Answer): boolean {
  return answer.status === 500 && answer.text.includes("DeviceNotConnectedException");
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
