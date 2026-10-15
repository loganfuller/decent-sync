import { DYE2_NAMESPACE, LOADED_RECIPE_KEY, RECIPE_FIELD, dye2Records, loadedRecipeOf } from "@decent-sync/protocol";
import { type Answer, request } from "./decaid.js";
import { Dye2Selection, dye2Fingerprint } from "./dye2-selection.js";
import type { WorkflowChanges } from "./machine-events.js";
import {
  type ChangedSetUp,
  type Dial,
  type HeldRecipe,
  type LoadContext,
  type Pending,
  type RecipeDial,
  changedParts,
  decideChange,
  loadWrite,
  loadable,
  matches,
  profileIds,
  profileKey,
  recipeDials,
  resolveDial,
  sameRecipeDial,
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
// unloads it, and the plugin clears the id. Each change Decaid reports is
// decided on in turn, as though at once (`decideChange`), so the outcome is
// the same however long the plugin's reads take, and a change made while a
// load is still to be written is the barista's, after it. The Workflow's
// changes are held back meanwhile (`WorkflowChanges`), so the server reads
// only the Workflow after the plugin's write, and never the plugin's own
// write as a change.

const RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;

/** The most dials kept of those each recipe held before, the oldest dropped first. */
const MAX_EARLIER_DIALS = 20;

/** The most recipes whose earlier dials are kept, those seen least recently dropped first. */
const MAX_KEPT_RECIPES = 200;

/** How long after a decision Decaid failed the plugin tries it again, doubling up to MAX_RETRY_MS. */
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

/**
 * How long the plugin waits for Decaid to report the Workflow it found
 * changed, or the echo of its write, before it decides on the Workflow it
 * read, or takes its write's answer for the echo. Decaid reports each change
 * as it sets it, ahead of answering a write.
 */
const REPORT_WAIT_MS = 2_000;

export class LoadedRecipes {
  /** The latest Workflow Decaid reported. */
  private latest: Record<string, unknown> | undefined;
  /** The Workflows reported, in order, still to be decided on. */
  private readonly queue: Record<string, unknown>[] = [];
  /** The latest Workflow decided on, which the next change is judged from. */
  private decided: Record<string, unknown> | undefined;
  /** What the changes decided on so far leave to write into the Workflow. */
  private pending: Pending = { kind: "none" };
  /**
   * The plugin's latest write Decaid took, until its echo is decided on: the
   * Workflow Decaid answered with, and what was pending as it was written.
   */
  private written: { workflow: Record<string, unknown>; pending: Pending } | undefined;
  /** Told of the next change Decaid reports, while the plugin waits for one (`waitForChange`). */
  private reported: (() => void) | undefined;
  private running = false;
  /** Whether the Workflow's changes are held back while it decides (`observe`). */
  private holding = false;
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
  /** The Recipe Slot each recipe the tablet held as last read is in, by global id. */
  private readonly slots = new Map<string, number>();

  constructor(
    /** Holds back the Workflow's changes the plugin sends while it decides and writes. */
    private readonly changes: WorkflowChanges,
    private readonly log: (message: string) => void,
    /** DYE2's selected recipe, kept in step with the Loaded Recipe the Workflow names once decided on. */
    private readonly selection: Dye2Selection = new Dye2Selection(log),
  ) {}

  /**
   * Decaid's `workflowUpdated`, before the Workflow is queued. A change of
   * its dial or Bean Batch is decided on (`run`), as is any change of what a
   * load writes while one is under way. The change is held back until it is
   * decided on and written, so the server never reads a Workflow as a stale
   * copy applied it, if it names a Loaded Recipe, which the change may
   * unload or replace, or matches a recipe as the tablet held it when last
   * read, or a write is still to be made. Any other is sent at once, as it
   * is kept in Decaid's plugin storage as it is queued, so an unload of the
   * plugin meanwhile loses none: it names no Recipe the server could take it
   * for, and a load the plugin then finds, of a recipe saved since it last
   * read them, is sent after it.
   */
  observe(workflow: Record<string, unknown>): void {
    if (this.stopped) return;
    this.latest = workflow;
    this.enqueue(workflow);
    this.reported?.();
    if (this.queue.length === 0 && this.pending.kind === "none") {
      this.followSelection();
      return;
    }
    if (!this.holding && (loadedRecipeOf(workflow) !== null || this.pending.kind !== "none" || this.mayLoad(workflowDial(workflow)))) {
      this.holding = true;
      this.changes.hold();
    }
    if (!this.running) {
      this.running = true;
      void this.run();
    }
  }

  /**
   * Queues a Workflow to be decided on: one that changes what a load writes
   * from the last queued or decided on, while a decision is under way or a
   * write still to be made, and otherwise only one that changes its dial or
   * Bean Batch, which alone can load or unload a recipe.
   */
  private enqueue(workflow: Record<string, unknown>): void {
    const last = this.queue[this.queue.length - 1] ?? this.decided;
    if (!last) {
      this.queue.push(workflow);
      return;
    }
    const changed = changedParts(last, workflow);
    const busy = this.running || this.pending.kind !== "none";
    const setUp = ["dose", "yield", "grind", "grinder", "profile", "batch"].some((part) => changed.has(part as never));
    if (busy ? changed.size > 0 : setUp) this.queue.push(workflow);
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
    this.slots.clear();
    for (const { globalId, slot } of loadable(records)) this.slots.set(globalId, slot);
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
    // The Loaded Recipe may have moved to another slot.
    this.followSelection();
  }

  /**
   * Keeps DYE2's selected recipe in step with the Loaded Recipe the latest
   * Workflow names, once nothing is left to decide or write
   * (`Dye2Selection`), so DYE2 records a barista's changes into the Loaded
   * Recipe, and into no other.
   */
  private followSelection(): void {
    if (!this.latest || this.running || this.stopped) return;
    this.followWorkflow(this.latest);
  }

  /** Has DYE2's selection follow the Loaded Recipe a Workflow names (`Dye2Selection`). */
  private followWorkflow(workflow: Record<string, unknown>): void {
    const globalId = loadedRecipeOf(workflow);
    this.selection.follow({ globalId, slot: globalId === null ? null : (this.slots.get(globalId) ?? null), profile: dye2Fingerprint(workflow.profile) });
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.reported?.();
  }

  /**
   * Decides on each Workflow queued, in turn, then writes what they leave
   * to write (`pending`), until none is queued and nothing is left, then
   * sends the latest if it held any. A write finds the Workflow as Decaid
   * holds it first, and where that is not the one last decided on, which
   * Decaid then reports, it is decided on as the next change instead, and
   * the write made after. Where Decaid fails what a decision or a write
   * needs, the Workflows still to be decided on and the write still to be
   * made wait, and are tried again later, as no change may come to try them:
   * the Workflow is sent meanwhile, as it is.
   */
  private async run(): Promise<void> {
    // Decided from the next turn on, once `observe` has decided whether to hold the change back.
    await Promise.resolve();
    try {
      while (!this.stopped && (this.queue.length > 0 || this.pending.kind !== "none")) {
        if (this.queue.length > 0) await this.decideQueued();
        if (this.pending.kind === "none" || this.stopped) continue;
        const unloading = this.pending.kind === "unload" ? loadedRecipeOf(this.decided!) : null;
        const written = await this.write(this.pending, this.decided!);
        if (written.kind === "nothing") {
          this.pending = { kind: "none" };
          continue;
        }
        // Written: its echo, the Workflow Decaid answered with, is no change, and makes the write done (`decideQueued`).
        if (written.kind === "written") {
          this.written = { workflow: written.workflow, pending: this.pending };
          // DYE2 is told at once, inside its debounce of the write, so it records the write into no recipe it had selected before.
          if (this.pending.kind === "load") this.followWorkflow(written.workflow);
          // An unload the plugin decided is cleared from DYE2's selection at once, which DYE2 keeps through a change of grinder or Bean.
          else if (unloading !== null) this.selection.unloaded(unloading);
        }
        // Decaid reports each change in order, so the plugin waits for its report, deciding on the Workflow it read only
        // where none comes.
        if (this.queue.length > 0 || (await this.waitForChange(REPORT_WAIT_MS)) || this.stopped) continue;
        if (this.written) {
          if (this.pending === this.written.pending) this.pending = { kind: "none" };
          this.decided = this.written.workflow;
          this.written = undefined;
        } else this.enqueue(written.workflow);
      }
      this.retryMs = FIRST_RETRY_MS;
    } catch (error) {
      this.log(`Could not work out the Loaded Recipe, trying again in ${this.retryMs / 1000} s: ${error instanceof Error ? error.message : String(error)}`);
      this.retryLater();
    } finally {
      this.running = false;
      if (this.holding) {
        this.holding = false;
        this.changes.release();
      }
      this.followSelection();
    }
  }

  /** Resolves with true once Decaid reports a change, or false after `ms`. */
  private waitForChange(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.reported = undefined;
        resolve(false);
      }, ms);
      this.reported = () => {
        clearTimeout(timer);
        this.reported = undefined;
        resolve(true);
      };
    });
  }

  /** Tries what is still to be decided on or written again once the wait is over, unless a change tries it first. */
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
   * Decides on each Workflow queued, in turn, from the one before it, with
   * the tablet's recipes read now (`decideChange`), as though at once. Each
   * becomes the Workflow decided on once decided. The echo of the plugin's
   * write (`written`) is no change: those before it were made before Decaid
   * took the write, with what it writes still pending, and those after it
   * after. Throws if Decaid fails what it needs, leaving the rest queued.
   */
  private async decideQueued(): Promise<void> {
    const held = await this.held(await this.readRecipes());
    while (this.queue.length > 0 && !this.stopped) {
      const workflow = this.queue[0]!;
      // The echo of the plugin's write, Decaid's Workflow just after it took it: the changes before it were made before
      // the write took, and are decided on as such. Once it is decided on, the write is done, unless they changed what
      // is pending, which is then written to it in turn.
      if (this.written && changedParts(this.written.workflow, workflow).size === 0) {
        if (this.pending === this.written.pending) this.pending = { kind: "none" };
        this.written = undefined;
        this.decided = workflow;
        this.queue.shift();
        continue;
      }
      const before = this.decided;
      // A batch's Bean is read only as the batch changes, which alone changes the Bean.
      const picked = before !== undefined && workflowBatch(before) !== workflowBatch(workflow);
      const setUp = async (of: Record<string, unknown>): Promise<ChangedSetUp> => {
        const batch = workflowBatch(of);
        return { dial: workflowDial(of), batch, bean: picked && batch !== null ? await this.beanOf(batch) : null, named: loadedRecipeOf(of) };
      };
      const changed = before ? changedParts(before, workflow) : new Set<never>();
      this.pending = decideChange(this.pending, before && (await setUp(before)), await setUp(workflow), changed, held);
      this.decided = workflow;
      this.queue.shift();
    }
  }

  /**
   * Writes what is pending into the Workflow, as Decaid holds it now, while
   * that is the one last decided on (`decided`): resolves with the Workflow
   * Decaid answered the write with, or that nothing was left to write, or
   * otherwise with the Workflow Decaid holds, to be decided on first. A load writes the recipe's current
   * values and global id (`loadWrite`) but the parts changed since it was
   * loaded, and, for the recipe the Workflow names already, every part it
   * holds a value for (`alone`); Decaid refuses to change the hot water settings while no machine
   * is connected, so the rest is then written without them, the Workflow
   * read and checked again. An unload clears the global id the Workflow
   * names. Decaid has no conditional write, so a change made between the
   * plugin's read and its write is written over where the write sets the
   * same part. Throws if Decaid fails it.
   */
  private async write(pending: Pending, decided: Record<string, unknown>): Promise<Outcome> {
    if (pending.kind === "unload") {
      // Decaid merges the Workflow's `extras` key by key, so the key is cleared by setting it to null.
      const done = await this.writeIfDecided(decided, (workflow) => (loadedRecipeOf(workflow) === null ? null : { context: { extras: { [LOADED_RECIPE_KEY]: null } } }));
      if (done.kind === "written" && !done.answer.ok) throw new Error(`Decaid answered ${done.answer.status} recording the Loaded Recipe as unloaded: ${done.answer.text.slice(0, 200)}`);
      return outcome(done);
    }
    if (pending.kind !== "load") return { kind: "nothing" };
    const records = await this.readRecipes();
    const recipe = loadable(records).find((candidate) => candidate.globalId === pending.globalId);
    // Gone from the tablet's slots since it was decided on: nothing is written, and the server unloads it.
    if (!recipe) return { kind: "nothing" };
    // Everything else is read first, so each write follows the Workflow's last read at once.
    const context: LoadContext = pending.kept.has("batch") ? { ...(await this.loadContext(recipe.record)), batch: null } : await this.loadContext(recipe.record);
    let hotWater = false;
    const build = (withHotWater: boolean) => (workflow: Record<string, unknown>) => {
      const all = loadWrite(workflow, recipe.record, recipe.globalId, context, pending.kept, pending.alone);
      if (all === null || withHotWater) {
        hotWater = all !== null && "hotWaterData" in all;
        return all;
      }
      const { hotWaterData: _, ...rest } = all;
      return Object.keys(rest).length > 0 ? rest : null;
    };
    let done = await this.writeIfDecided(decided, build(true));
    if (done.kind === "written" && !done.answer.ok && hotWater && machineMissing(done.answer)) done = await this.writeIfDecided(decided, build(false));
    if (done.kind === "written" && !done.answer.ok) {
      throw new Error(`Decaid answered ${done.answer.status} recording the recipe in slot ${recipe.slot} as loaded: ${done.answer.text.slice(0, 200)}`);
    }
    return outcome(done);
  }

  /**
   * Writes into the Workflow what `build` makes of it, read again just
   * before, while it holds all a load writes as the Workflow decided on
   * does (`changedParts`): Decaid's answer, nothing where there was nothing
   * to write, or the Workflow Decaid holds where it differs.
   */
  private async writeIfDecided(decided: Record<string, unknown>, build: (workflow: Record<string, unknown>) => Record<string, unknown> | null): Promise<Written> {
    const workflow = await this.workflowNow();
    if (changedParts(decided, workflow).size > 0) return { kind: "changed", workflow };
    const write = build(workflow);
    // Unloaded meanwhile, as when its settings changed: the plugin loaded next decides afresh.
    if (write === null || this.stopped) return { kind: "nothing" };
    return { kind: "written", answer: await request("PUT", "/workflow", write) };
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
        now: await this.resolved(recipeDials(record)),
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

  /** The Workflow as Decaid holds it now. Throws if Decaid does not answer with one. */
  private async workflowNow(): Promise<Record<string, unknown>> {
    const answer = await request("GET", "/workflow");
    const workflow = answer.ok ? parsed(answer.text) : undefined;
    if (!isObject(workflow)) throw new Error(`Decaid answered ${answer.status} reading the Workflow`);
    return workflow;
  }
}

/** What became of a write into the Workflow: Decaid's answer, nothing to write, or the Workflow changed from the one decided on. */
type Written = { kind: "written"; answer: Answer } | { kind: "nothing" } | { kind: "changed"; workflow: Record<string, unknown> };

/** What became of writing what is pending: the Workflow Decaid answered with, nothing written, or the Workflow changed from the one decided on. */
type Outcome = { kind: "written"; workflow: Record<string, unknown> } | { kind: "nothing" } | { kind: "changed"; workflow: Record<string, unknown> };

/** A write Decaid took, as the Workflow it answered with, where it answered with one; otherwise nothing written for the run to judge it by, its echo then decided on as a change. */
function outcome(done: Written): Outcome {
  if (done.kind !== "written") return done;
  const workflow = parsed(done.answer.text);
  return isObject(workflow) ? { kind: "written", workflow } : { kind: "nothing" };
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
