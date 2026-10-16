import { DYE2_NAMESPACE, LOADED_RECIPE_KEY, dye2Records, loadedRecipeOf } from "@decent-sync/protocol";
import { type Answer, request } from "./decaid.js";
import { Dye2Pushes, type Dye2State, type SelectionAnswer, type Transports, postSelection, readDye2State, readSelection } from "./dye2-selection.js";
import type { WorkflowChanges } from "./machine-events.js";
import { type LoadContext, clearsSelection, loadWrite, loadable, selectedOn, vacatedSlots } from "./loaded-recipe-rules.js";

// Each Machine's Loaded Recipe (ADR-0022): the recipe DYE2 has selected on
// the tablet, where it is in a Recipe Slot carrying a Recipe's global id and
// was selected on the Workflow as it holds it now (dye2-selection.ts). The
// plugin records it in the Workflow (LOADED_RECIPE_KEY), so a load made
// while the tablet is offline is recorded too, Decaid copies it onto every
// Shot pulled with it, and the server reads it from the Workflow deliveries.
//
// The plugin reads DYE2's selection on each push from DYE2's `changed`
// socket; about 2 s after each change of the Workflow, past DYE2's 1.5 s
// wait before it records, which decides on the changes held back meanwhile;
// and on its poll, when it also reads whether DYE2 is loaded at all. A
// selection of a recipe the Workflow does not name, made on the profile,
// Bean Batch and grinder it holds (`selectedOn`), loads it: the plugin
// writes into the Workflow what applying a DYE2 recipe leaves out, or a
// stale copy got wrong (`loadWrite`), and tells the server what that write
// replaced (`WorkflowDelivery.loadBefore`). A selection cleared, as DYE2
// clears it on a change of profile, batch or grinder (dye2#18, #19), or of
// anything else, unloads it. While a Recipe is loaded, or the
// Workflow names one the plugin does not take as loaded, each change of the
// Workflow is held back (`WorkflowChanges`) until a read of the selection
// after it decides on it, so the server never reads a recipe applied from
// DYE2's dashboard, which names the Recipe loaded before, as a change of
// that one.
//
// Besides following DYE2, the plugin selects the slot again after a write
// of its own that changes the profile, batch or grinder, which DYE2 clears
// its selection on as it would a barista's (`clearsSelection`), and clears
// the selection of a slot whose recipe leaves it. On a Capture-only Machine
// it selects nothing, and makes only the clears already due.

const RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;

/** How long after a change of the Workflow the plugin reads DYE2's selection: past DYE2's 1.5 s wait before it records. */
const READ_AFTER_CHANGE_MS = 2_000;

/** The longest the plugin holds a change of the Workflow back while changes keep coming before it can decide. */
const MAX_HOLD_MS = 10_000;

/** The decision on a Workflow change held back meanwhile, with the parts of the server's write of a Loaded Recipe it needs. */
export interface LoadedRecipeWrites {
  /**
   * Before a write of the server's into the Workflow for its Loaded Recipe:
   * whether DYE2 still has its slot selected, or answers 404, or the plugin
   * is selecting it again, so the write rarely lands in a recipe a barista
   * selected in the moment between. Throws if Decaid does not answer.
   */
  mayWrite(globalId: string): Promise<boolean>;
  /**
   * Just before a write of it that changes the profile, as DYE2 fingerprints
   * one, the Bean Batch or the grinder (`clearsSelection`): DYE2 clears its
   * selection as Decaid reports it, so the slot is to be selected again from
   * then, and no read meanwhile takes that clear for the barista's.
   */
  selectionClearing(globalId: string): void;
  /** After that write, where Decaid refused it: the Workflow stayed, so nothing is to be selected again for it. */
  selectionKept(globalId: string): void;
  /** After it, with the Workflow Decaid answered: one that changed what DYE2 clears its selection on (`clears`) has the slot selected again. */
  written(globalId: string, after: Record<string, unknown>, clears: boolean): void;
  /** After the server's clearing of a Loaded Recipe: its slot is cleared from DYE2's selection. */
  cleared(globalId: string): void;
  /**
   * Before a post of DYE2's recipes: the selection of a slot the Loaded
   * Recipe moves out of is cleared, and so is that of a slot whose recipe the
   * post removes or replaces with another (`vacatedSlots`).
   */
  moving(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): Promise<void>;
  /** After a post of DYE2's recipes Decaid took: the Loaded Recipe moved is selected in its new slot. */
  posted(records: readonly Record<string, unknown>[]): void;
  /** After a post of DYE2's recipes Decaid refused, with the list as it still is: a move is undone, its old slot selected again. */
  notPosted(records: readonly Record<string, unknown>[]): void;
  /** After a post of DYE2's recipes Decaid did not answer: whether a move landed is told by the next read of the list. */
  postUnsettled(): void;
}

/** What DYE2's selection last answered, as the plugin takes it. */
type LastAnswer =
  /** Nothing read since the plugin loaded. */
  | "unread"
  /** 404: DYE2 not loaded. */
  | "unavailable"
  /** No selection, first after the plugin loaded or DYE2 answered 404, which DYE2 may yet restore one over. */
  | "noneUnconfirmed"
  | "none"
  | "recipe"
  | "favourite";

export class LoadedRecipes implements LoadedRecipeWrites {
  /** The latest Workflow Decaid reported. */
  private latest: Record<string, unknown> | undefined;
  /** The Loaded Recipe, by its global id, as the plugin keeps it in the Workflow; from the first Workflow until it decides. */
  private loaded: string | null = null;
  private initialised = false;
  /** The tablet's recipes that can be loaded, by slot, as last read. */
  private recipes = new Map<number, { globalId: string; record: Record<string, unknown> }>();
  /** The slot each Recipe was last seen in, by global id, kept after the list loses it, so its selection can still be cleared. */
  private readonly lastSlots = new Map<string, number>();
  private answer: LastAnswer = "unread";
  /** The selection to be made again that a server write DYE2 clears its selection on set (`selectionClearing`), until it is answered. */
  private clearingWrite: { slot: number; globalId: string } | null = null;
  /** A selection of the plugin's still to be made: tried again until DYE2 answers, unless a barista selects something else first. */
  private pendingSelect: { slot: number; globalId: string } | null = null;
  /** Slots whose clearing from DYE2's selection is still to be made. */
  private readonly pendingClears = new Set<number>();
  /**
   * The Loaded Recipe while it moves to another slot, with the slots it left
   * and whether the post of the list moving it was taken: reads decide
   * nothing meanwhile, and it is selected in a slot it did not leave only
   * once that post was taken, as a read of the list before it finds it still
   * in the old one.
   */
  private relocating: { globalId: string; left: ReadonlySet<number>; posted: boolean | "unknown" } | null = null;
  /** Whether Decaid reported a change of the Workflow during a write of the plugin's (`ownWrite`). */
  private reportedDuringWrite = false;
  private dye2: Dye2State | "unknown" = "unknown";
  /** When DYE2 was first seen not loaded, since it was last loaded. */
  private notLoadedSince: number | null = null;
  private captureOnly = false;
  private chain: Promise<void> = Promise.resolve();
  /** Whether a change of the Workflow is held back until a read decides on it, since when, and how many changes came by then. */
  private holding: { since: number; observed: number } | null = null;
  private observed = 0;
  /** How many writes of the plugin's into the Workflow are under way: a change Decaid reports meanwhile is their echo. */
  private writing = 0;
  private readTimer: number | undefined;
  private pollTimer: number | undefined;
  private stopped = false;
  private failing = false;
  private readonly pushes: Dye2Pushes;

  constructor(
    /** Holds back the Workflow's changes the plugin sends while it decides and writes. */
    private readonly changes: WorkflowChanges,
    private readonly log: (message: string) => void,
    transports: Transports,
    /** How often the plugin reads whether DYE2 is loaded, and its selection, whatever else happens. */
    private readonly pollMs: number,
  ) {
    this.pushes = new Dye2Pushes(transports, () => this.enqueue(() => this.check()));
  }

  start(): void {
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.readTimer !== undefined) clearTimeout(this.readTimer);
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pushes.stop();
    this.releaseHold();
  }

  /**
   * Whether the server says the Machine is capture-only: nothing is loaded
   * into its Workflow nor any workaround run there while it is; once it is
   * not, the selection is read again, and may load its Recipe.
   */
  setCaptureOnly(captureOnly: boolean): void {
    if (this.captureOnly === captureOnly) return;
    this.captureOnly = captureOnly;
    if (captureOnly) {
      // Nothing is selected there for the plugin: but clears already due, as of the Recipe the server clears, still are.
      this.pendingSelect = null;
      this.relocating = null;
      this.releaseHold();
    } else this.enqueue(() => this.check());
  }

  /**
   * Decaid's `workflowUpdated`, before the Workflow is queued. The first
   * names the Loaded Recipe the plugin takes until it decides. While a
   * Recipe is loaded, or the Workflow names another, the change is held back
   * until a read of DYE2's selection after it decides on it (`check`). A
   * change during a write of the plugin's is that write's echo, which its
   * write holds.
   */
  observe(workflow: Record<string, unknown>): void {
    if (this.stopped) return;
    this.latest = workflow;
    if (!this.initialised) {
      this.initialised = true;
      this.loaded = loadedRecipeOf(workflow);
    }
    if (this.captureOnly) return;
    // Its write's echo, or a barista's change made meanwhile, which the write decides on once done (`ownWrite`).
    if (this.writing > 0) {
      this.reportedDuringWrite = true;
      return;
    }
    this.observed++;
    this.holdUntilRead(workflow);
    this.readSoon();
  }

  /**
   * Holds the Workflow's changes back until a read of DYE2's selection after
   * them decides on them, while a Recipe is loaded, or the Workflow names one
   * the plugin does not take as loaded, and DYE2 did not answer 404 last.
   */
  private holdUntilRead(workflow: Record<string, unknown>): void {
    if (!this.holding && (this.loaded !== null || loadedRecipeOf(workflow) !== this.loaded) && this.answer !== "unavailable") {
      this.holding = { since: Date.now(), observed: this.observed };
      this.changes.hold();
    } else if (this.holding) this.holding.observed = this.observed;
  }

  /**
   * DYE2's recipes as a read of them found them, whoever read them: the
   * slots each Recipe is in. A Loaded Recipe moving to another slot is
   * selected there once it is in one. A list in a shape not recognised
   * changes nothing.
   */
  sawRecipes(value: unknown): void {
    const records = value === null ? [] : dye2Records(value, "recipes");
    if (records === null) return;
    this.recipes = new Map(loadable(records).map(({ globalId, slot, record }) => [slot, { globalId, record }]));
    for (const [slot, { globalId }] of this.recipes) this.lastSlots.set(globalId, slot);
    const moving = this.relocating;
    if (moving?.posted === "unknown") {
      const slot = this.slotOf(moving.globalId);
      if (slot === null || moving.left.has(slot)) {
        // The post did not land: the Recipe is selected again where it still is, or left to the server, gone from its slots.
        this.relocating = null;
        if (slot !== null && this.loaded === moving.globalId) {
          this.pendingSelect = { slot, globalId: moving.globalId };
          this.enqueue(() => this.check());
        }
        return;
      }
      moving.posted = true;
    }
    if (moving !== null && moving.posted === true && this.pendingSelect === null) {
      const slot = this.slotOf(moving.globalId);
      if (slot !== null && !moving.left.has(slot)) {
        this.pendingSelect = { slot, globalId: moving.globalId };
        this.enqueue(() => this.check());
      }
    }
  }

  // The server's writes of its Loaded Recipe (`LoadedRecipeWrites`), made by `LibraryWrites`.

  async mayWrite(globalId: string): Promise<boolean> {
    const answer = await readSelection();
    if (answer.kind === "unavailable") return true;
    if (answer.kind === "recipe" && answer.slot !== null && this.recipes.get(answer.slot)?.globalId === globalId) return true;
    // Still to be selected again by the plugin, as after its write changed the profile, batch or grinder: while DYE2 has
    // nothing selected.
    return answer.kind === "none" && this.pendingSelect?.globalId === globalId;
  }

  selectionClearing(globalId: string): void {
    const slot = this.slotOf(globalId);
    if (this.captureOnly || slot === null || this.loaded !== globalId) return;
    this.pendingSelect = { slot, globalId };
    this.clearingWrite = this.pendingSelect;
  }

  selectionKept(globalId: string): void {
    // A clear DYE2 makes from now on is the barista's, which a selection still to be made would undo.
    if (this.clearingWrite?.globalId === globalId && this.pendingSelect === this.clearingWrite) this.pendingSelect = null;
    this.clearingWrite = null;
  }

  written(globalId: string, after: Record<string, unknown>, clears: boolean): void {
    this.latest = after;
    if (this.captureOnly || !clears) return;
    const slot = this.slotOf(globalId);
    if (slot === null || this.loaded !== globalId) return;
    this.pendingSelect = { slot, globalId };
    this.enqueue(() => this.check());
  }

  cleared(globalId: string): void {
    if (this.loaded === globalId) this.loaded = null;
    if (this.pendingSelect?.globalId === globalId) this.pendingSelect = null;
    if (this.relocating?.globalId === globalId) this.relocating = null;
    const slot = this.lastSlots.get(globalId);
    // A slot holding another Recipe's record now was cleared before that was posted: what DYE2 has selected there since
    // is the barista's.
    const now = slot === undefined ? undefined : this.recipes.get(slot)?.globalId;
    if (slot !== undefined && (now === undefined || now === globalId)) this.enqueue(() => this.clearSlot(slot));
  }

  async moving(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): Promise<void> {
    if (this.captureOnly) return;
    const left = await this.relocate(before, after);
    // Any other slot whose recipe the post removes or replaces, as a joining Machine's own or another Location's, is cleared
    // from DYE2's selection first, so DYE2 neither records into the Recipe put there nor has it loaded.
    const vacated = vacatedSlots(before, after).filter((slot) => !left.has(slot));
    try {
      for (const slot of vacated) await this.clearSlot(slot);
    } catch (error) {
      // The list is not posted, and its recipes stay where they were: nothing of them is left to clear.
      for (const slot of vacated) this.pendingClears.delete(slot);
      if (left.size > 0) this.unmoved(left);
      throw error;
    }
  }

  /**
   * Before a post of DYE2's recipes moving the Loaded Recipe out of a slot:
   * the selection of each slot it leaves is cleared, so DYE2 never records
   * into a recipe put there, and its new slot is selected once posted.
   * Resolves with the slots it leaves.
   */
  private async relocate(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): Promise<ReadonlySet<number>> {
    const globalId = this.loaded;
    if (globalId === null) return new Set();
    const slots = (records: readonly Record<string, unknown>[]) => new Set(loadable(records).flatMap((recipe) => (recipe.globalId === globalId ? [recipe.slot] : [])));
    const [was, is] = [slots(before), slots(after)];
    if (was.size === is.size && [...was].every((slot) => is.has(slot))) return new Set();
    const left = new Set([...was].filter((slot) => !is.has(slot)));
    // A selection of its old slot still to be made would select it there: its new slot is selected once posted.
    if (this.pendingSelect?.globalId === globalId) this.pendingSelect = null;
    this.relocating = { globalId, left: new Set([...(this.relocating?.globalId === globalId ? this.relocating.left : []), ...left]), posted: false };
    try {
      for (const slot of left) await this.clearSlot(slot);
    } catch (error) {
      this.unmoved(left);
      throw error;
    }
    return left;
  }

  /**
   * A post that was to move the Loaded Recipe out of the slots it left is
   * not made: the Recipe stays where it was, with nothing of it left to
   * clear, and any of them cleared already is selected again, where DYE2
   * then has nothing selected.
   */
  private unmoved(left: ReadonlySet<number>): void {
    const globalId = this.relocating?.globalId;
    this.relocating = null;
    for (const slot of left) this.pendingClears.delete(slot);
    const slot = globalId === undefined ? null : this.slotOf(globalId);
    if (globalId !== undefined && slot !== null && this.loaded === globalId) this.pendingSelect = { slot, globalId };
  }

  posted(records: readonly Record<string, unknown>[]): void {
    if (this.relocating) this.relocating.posted = true;
    this.sawRecipes(records);
  }

  postUnsettled(): void {
    // Decaid did not answer: the next read of the list tells whether it took the post (`sawRecipes`).
    if (this.relocating && this.relocating.posted === false) this.relocating.posted = "unknown";
  }

  notPosted(records: readonly Record<string, unknown>[]): void {
    const moving = this.relocating;
    if (!moving || moving.posted) return;
    // The list as it was: the Recipe is selected again in the slot it was to leave, where it still is.
    this.relocating = null;
    this.sawRecipes(records);
    const slot = this.slotOf(moving.globalId);
    if (slot !== null && this.loaded === moving.globalId) {
      this.pendingSelect = { slot, globalId: moving.globalId };
      this.enqueue(() => this.check());
    }
  }

  /** Runs each piece of work in turn, logging a failure once until one succeeds. */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.stopped ? undefined : work()))
      .then(() => {
        this.failing = false;
      })
      .catch((error: unknown) => {
        if (!this.failing) this.log(`DYE2's selection could not be followed: ${error instanceof Error ? error.message : String(error)}`);
        this.failing = true;
      });
  }

  /** Reads DYE2's selection about 2 s after the latest change of the Workflow. */
  private readSoon(): void {
    if (this.readTimer !== undefined) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      this.enqueue(() => this.check());
    }, READ_AFTER_CHANGE_MS);
  }

  /** On its poll, reads whether DYE2 is loaded, then its selection. */
  private poll(): void {
    if (this.stopped) return;
    this.enqueue(() => this.check(true));
    this.pollTimer = setTimeout(() => this.poll(), this.pollMs);
  }

  /** Releases the change held back, once every change since is decided on, or it has waited too long. */
  private releaseHold(seen?: number): void {
    const holding = this.holding;
    if (!holding) return;
    if (seen !== undefined && Date.now() - holding.since < MAX_HOLD_MS) {
      if (seen < holding.observed) return;
      // The Workflow still names a Recipe the plugin has not loaded, as after its write of that failed: held until the
      // next read writes it, so the server never reads a change made since as that Recipe's.
      if (!this.captureOnly && this.latest && loadedRecipeOf(this.latest) !== this.loaded) {
        this.readSoon();
        return;
      }
    }
    this.holding = null;
    this.changes.release();
  }

  /**
   * Reads DYE2's selection, with whether DYE2 is loaded on the poll, and
   * decides: a selection of a recipe in a slot carrying a global id, made on
   * the Workflow as it holds it now (`selectedOn`), loads that Recipe; any
   * other unloads the
   * Loaded Recipe. A 404 tells nothing, nor does a first answer of none
   * after the plugin loads or DYE2 answers 404, as DYE2 restores its stored
   * selection after its load: a later read confirms it. While a selection or
   * clear of the plugin's is still to be made, it is tried first; while a
   * selection of its own is still to land, or the Loaded Recipe moves to
   * another slot, a read decides nothing.
   */
  private async check(polled = false): Promise<void> {
    const seen = this.observed;
    try {
      // Kept up to date while capture-only too, so a Machine sharing again decides on DYE2 as it is.
      if (polled) {
        this.dye2 = await readDye2State();
        if (this.dye2 === "loaded") {
          this.notLoadedSince = null;
          this.pushes.keepOpen();
        } else this.notLoadedSince ??= Date.now();
      }
      if (this.captureOnly) {
        // Only the clears already due are tried again, each while DYE2 still has the slot selected.
        if (this.pendingClears.size > 0) await this.tryPending(await readSelection());
        return;
      }
      if (this.unavailable()) {
        this.pendingSelect = null;
        await this.unload();
        return;
      }
      this.sawRecipes(await this.readRecipes());
      let answer = await readSelection();
      answer = await this.tryPending(answer);
      if (answer.kind === "unavailable") {
        this.answer = "unavailable";
        return;
      }
      if (this.pendingSelect !== null || this.relocating !== null) return;
      await this.decide(answer);
      await this.keepNamed();
    } finally {
      this.releaseHold(seen);
    }
  }

  /** Whether DYE2 is not there to select anything: absent, disabled, or not loaded for longer than twice the poll interval. */
  private unavailable(): boolean {
    if (this.dye2 === "absent" || this.dye2 === "disabled") return true;
    return this.dye2 === "notLoaded" && this.notLoadedSince !== null && Date.now() - this.notLoadedSince > 2 * this.pollMs;
  }

  /**
   * Tries the plugin's clears and selection still to be made, in the light
   * of what DYE2 answered: a clear is made while DYE2 still has that slot
   * selected, and dropped once it has another, or none; a selection is made
   * where DYE2 has none, or that slot made on another Workflow than it holds
   * now (`selectedOn`), and dropped once a barista selected something else; a
   * 404 leaves both to try again. Resolves with DYE2's selection after them.
   */
  private async tryPending(answer: SelectionAnswer): Promise<SelectionAnswer> {
    for (const slot of [...this.pendingClears]) {
      if (answer.kind === "unavailable") break;
      this.pendingClears.delete(slot);
      if (answer.kind === "recipe" && answer.slot === slot) {
        await this.clearSlot(slot);
        answer = await readSelection();
      }
    }
    const pending = this.pendingSelect;
    if (pending === null || answer.kind === "unavailable") return answer;
    if (answer.kind === "recipe" && answer.slot === pending.slot && selectedOn(answer, this.latest)) {
      this.landed(pending);
      return answer;
    }
    if (answer.kind !== "none" && !(answer.kind === "recipe" && answer.slot === pending.slot)) {
      // A barista selected something else since: that stands.
      this.pendingSelect = null;
      if (this.relocating?.globalId === pending.globalId) this.relocating = null;
      return answer;
    }
    if ((await postSelection(pending.slot)) === "unavailable") return { kind: "unavailable" };
    this.landed(pending);
    return readSelection();
  }

  /** The plugin's selection of a slot was made. */
  private landed(pending: { slot: number; globalId: string }): void {
    if (this.pendingSelect === pending) this.pendingSelect = null;
    if (this.relocating?.globalId === pending.globalId) this.relocating = null;
  }

  /** Decides on DYE2's selection, as `check` reads it. */
  private async decide(answer: Exclude<SelectionAnswer, { kind: "unavailable" }>): Promise<void> {
    const previous = this.answer;
    if (answer.kind === "none") {
      // DYE2 restores a stored selection only after it loads: a later read confirms none.
      if (previous === "unread" || previous === "unavailable") {
        this.answer = "noneUnconfirmed";
        return;
      }
      this.answer = "none";
      await this.unload();
      return;
    }
    if (answer.kind === "favourite") {
      this.answer = "favourite";
      await this.unload();
      return;
    }
    this.answer = "recipe";
    const recipe = answer.slot === null ? undefined : this.recipes.get(answer.slot);
    // A selection made on another profile, batch or grinder, as one DYE2 restored over a switch made while it was away,
    // loads nothing, and its batch is not written back: DYE2 clears it at the Workflow's next change.
    if (!recipe || !selectedOn(answer, this.latest)) {
      await this.unload();
      return;
    }
    if (recipe.globalId !== this.loaded) await this.loadRecipe(recipe.globalId, answer.slot!);
  }

  /**
   * Loads the Recipe in that slot: once DYE2 is found to have the slot still
   * selected, or answers 404, writes into the Workflow what applying a DYE2
   * recipe leaves out, or a stale copy got wrong (`loadWrite`), and tells the
   * server what it replaced, on the next Workflow delivery. Decaid refuses
   * to change the hot water settings while no machine is connected, so the
   * rest is then written without them. A write that changed the profile,
   * batch or grinder, which DYE2 clears its selection on, has the slot
   * selected again.
   */
  private async loadRecipe(globalId: string, slot: number): Promise<void> {
    const now = await readSelection();
    if (now.kind !== "unavailable" && !(now.kind === "recipe" && now.slot === slot)) return;
    const recipe = this.recipes.get(slot);
    if (!recipe || recipe.globalId !== globalId) return;
    await this.ownWrite(async () => {
      const workflow = await this.workflowNow();
      const context = await this.loadContext(recipe.record);
      let planned = loadWrite(workflow, recipe.record, globalId, context);
      let answer: Answer | undefined;
      if (planned !== null) {
        answer = await request("PUT", "/workflow", planned.write);
        if (!answer.ok && "hotWaterData" in planned.write && machineMissing(answer)) {
          planned = loadWrite(workflow, recipe.record, globalId, context, new Set(["targetTemperature", "duration", "volume", "flow"]));
          answer = planned === null ? undefined : await request("PUT", "/workflow", planned.write);
        }
        if (answer && !answer.ok) throw new Error(`Decaid answered ${answer.status} loading the recipe in slot ${slot}: ${answer.text.slice(0, 200)}`);
      }
      const after = answer ? parsed(answer.text) : workflow;
      if (planned && Object.keys(planned.before).length > 0) this.changes.attach({ loadBefore: planned.before });
      this.loaded = globalId;
      if (planned !== null && answer?.ok && clearsSelection(workflow, planned.write)) this.pendingSelect = { slot, globalId };
      return isObject(after) ? after : undefined;
    });
    if (this.pendingSelect?.globalId === globalId) await this.tryPending(await readSelection());
  }

  /** Unloads the Loaded Recipe: the Workflow names none. */
  private async unload(): Promise<void> {
    const globalId = this.loaded;
    if (globalId === null) return;
    this.loaded = null;
    if (this.pendingSelect?.globalId === globalId) this.pendingSelect = null;
    await this.keepNamed();
  }

  /** Keeps the Workflow naming the Loaded Recipe, or none, as Decaid holds it now. */
  private async keepNamed(): Promise<void> {
    const latest = this.latest;
    if (!latest || loadedRecipeOf(latest) === this.loaded) return;
    await this.ownWrite(async () => {
      const workflow = await this.workflowNow();
      if (loadedRecipeOf(workflow) === this.loaded) return workflow;
      // Decaid merges the Workflow's `extras` key by key, so the key is cleared by setting it to null.
      const answer = await request("PUT", "/workflow", { context: { extras: { [LOADED_RECIPE_KEY]: this.loaded } } });
      if (!answer.ok) throw new Error(`Decaid answered ${answer.status} recording the Loaded Recipe: ${answer.text.slice(0, 200)}`);
      const after = parsed(answer.text);
      return isObject(after) ? after : undefined;
    });
  }

  /**
   * Clears DYE2's selection while it still has that slot selected, leaving
   * a favourite or another slot the barista selected since. DYE2 stores the
   * clear itself (decentespresso/dye2#22). One Decaid fails, or DYE2 answers
   * 404 to, is tried again at the next read.
   */
  private async clearSlot(slot: number): Promise<void> {
    try {
      const answer = await readSelection();
      if (answer.kind === "unavailable") {
        this.pendingClears.add(slot);
        return;
      }
      if (answer.kind !== "recipe" || answer.slot !== slot) return;
      if ((await postSelection(null)) === "unavailable") {
        this.pendingClears.add(slot);
        return;
      }
      this.answer = "none";
    } catch (error) {
      this.pendingClears.add(slot);
      throw error;
    }
  }

  /**
   * Runs a write of the plugin's into the Workflow, its changes held back
   * until it is done. Decaid reports each change as it sets it, ahead of
   * answering, so the changes it reports meanwhile are the write's echo, or
   * a barista's change made in the moment around it, which Decaid's merge of
   * the write keeps where the write did not set the same field. So where
   * any was reported, the Workflow as last reported is held back in turn
   * until a read of DYE2's selection decides on it. Where none was, the
   * Workflow is as Decaid answered it (`work`'s answer).
   */
  private async ownWrite(work: () => Promise<Record<string, unknown> | undefined>): Promise<void> {
    this.writing++;
    this.reportedDuringWrite = false;
    this.changes.hold();
    let answered: Record<string, unknown> | undefined;
    try {
      answered = await work();
    } catch (error) {
      this.writing--;
      this.changes.release();
      throw error;
    }
    this.writing--;
    const reported = this.reportedDuringWrite;
    this.reportedDuringWrite = false;
    if (!reported && answered) this.latest = answered;
    if (reported && this.latest) {
      this.observed++;
      this.holdUntilRead(this.latest);
      this.readSoon();
    }
    this.changes.release();
  }

  /** The slot a Recipe is in on the tablet now, or null. */
  private slotOf(globalId: string): number | null {
    for (const [slot, recipe] of this.recipes) if (recipe.globalId === globalId) return slot;
    return null;
  }

  /**
   * The tablet's recipes, read now: none from a key never written, or a list
   * in a shape not recognised (`dye2Records`). Throws if Decaid does not
   * answer with them.
   */
  private async readRecipes(): Promise<unknown> {
    const answer = await request("GET", RECIPES);
    const value = answer.ok ? parsed(answer.text) : undefined;
    if (value === undefined) throw new Error(`Decaid answered ${answer.status} reading DYE2's recipes`);
    return value;
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
   * What a load of the recipe writes besides its record: its full Profile at
   * its brew temperature, as the Workflow DYE2 embeds in the record holds it
   * (decentespresso/dye2#26), or else as its snapshot or the tablet's record
   * of that Profile does.
   */
  private async loadContext(record: Record<string, unknown>): Promise<LoadContext> {
    const steps = (profile: unknown) => (isObject(profile) && Array.isArray(profile.steps) ? profile : null);
    const embedded = steps(isObject(record.workflow) ? record.workflow.profile : null) ?? steps(record.profileSnapshot);
    if (embedded !== null) return { profile: embedded };
    const stored = typeof record.profileId === "string" && record.profileId !== "" ? await this.readRecord(`/profiles/${encodeURIComponent(record.profileId)}`) : null;
    return { profile: isObject(stored) ? steps(stored.profile) : null };
  }

  /** The Workflow as Decaid holds it now. Throws if Decaid does not answer with one. */
  private async workflowNow(): Promise<Record<string, unknown>> {
    const answer = await request("GET", "/workflow");
    const workflow = answer.ok ? parsed(answer.text) : undefined;
    if (!isObject(workflow)) throw new Error(`Decaid answered ${answer.status} reading the Workflow`);
    return workflow;
  }
}

/** Whether Decaid refused a Workflow change as no machine is connected, which it needs to change the hot water settings. */
export function machineMissing(answer: Answer): boolean {
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
