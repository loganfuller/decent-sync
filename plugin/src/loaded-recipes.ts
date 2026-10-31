import {
  DYE2_NAMESPACE,
  LOADED_RECIPE_PARTS,
  MACHINE_SETTING_PARTS,
  RECIPE_SETTING_NAMES,
  dye2Fingerprint,
  dye2RecipeIdOf,
  dye2Records,
  sameValue,
  steamOff,
  workflowValueAt,
} from "@decent-sync/protocol";
import { type Answer, request } from "./decaid.js";
import { Dye2Pushes, type Dye2State, readDye2State, recordIntoRecipe } from "./dye2.js";
import type { Transports } from "./host.js";
import type { LibraryAccess } from "./library-writes.js";
import type { WorkflowChanges } from "./machine-events.js";
import type { ShotGate } from "./shot-gate.js";
import type { PluginStorage } from "./storage.js";
import { type LoadContext, clearRecipe, loadWrite, loadable, steamBackOnWrite, steamOnAt, vacatedIds } from "./loaded-recipe-rules.js";
import type { Skins } from "./skins.js";

// Each Machine's Loaded Recipe (ADR-0022): the recipe its Workflow names
// (DYE2_RECIPE_FIELD), by the id of the tablet's record of it, which DYE2's
// dashboard, its Select Recipe page and Streamline's DYE strip set as they
// apply one, and DYE2 clears as the Workflow's profile changes, where that
// record carries a Recipe's global id. Decaid copies the field onto every
// Shot pulled with it, and the server reads the Loaded Recipe from it in the
// Workflow deliveries. Where DYE2 is not there, every Workflow delivery says
// so (`dye2Absent`).
//
// A Workflow change naming a Recipe the plugin has not loaded loads it: the
// plugin writes into the Workflow what applying a DYE2 recipe leaves out, or
// a stale copy got wrong (`loadWrite`). Any other change of the Workflow
// while a Recipe is loaded is saved into it: the plugin holds the change
// back, has DYE2 write it into the recipe (`recordIntoRecipe`, the call
// Streamline's Save changes makes), and reports the recipes DYE2 saved
// before it delivers the change, so the server takes in the edit first; but
// not for its own writes, nor a change of profile, as DYE2 fingerprints one,
// which DYE2 clears the recipe on a moment later. A change turning steam
// back on takes the Recipe's steam temperature: the plugin writes it into
// the Workflow before it has DYE2 save the change, so DYE2 never saves the
// temperature steam came back at (`steamBackOnFirst`), as turning steam off
// is no edit. A write of the plugin's that changes the profile writes the
// profile the tablet's record of the recipe holds, which DYE2 keeps the
// recipe named through, as one write (`putWorkflow`). The server unloads one
// by having the plugin clear the field. On a Capture-only Machine, or while
// DYE2 is not there, nothing is written or saved.
//
// A load decided on while the Machine pulls a Shot is held until the Shot
// ends (`ShotGate`), as every write of the plugin's into the Workflow is,
// and only the latest is made then, once the Workflow still names its
// Recipe. It is kept in Decaid's plugin storage meanwhile (HELD_LOAD_KEY),
// so a load the plugin holds as it stops is made after it starts again,
// where the Workflow names that Recipe still. Saves are not held, but for
// those after steam turned back on during the Shot, held with its write
// until the Shot ends, which is not kept across the plugin's loads.

const RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;

/** The key of the plugin's storage keeping the load held for a Shot: `{ globalId }`, the Recipe's, or `{}` for none, as Decaid stores no null. */
const HELD_LOAD_KEY = "heldLoad";

/** What the plugin's writes of the Workflow and of DYE2's recipes need of the Loaded Recipe (`LibraryWrites`). */
export interface LoadedRecipeWrites {
  /**
   * Runs a write of the plugin's into the Workflow (`work`), the changes
   * Decaid reports meanwhile held back until it is done, and taken as its
   * echo rather than saved into the Loaded Recipe. `work` tells `answered`
   * of each Workflow Decaid answers it with, and the body of the `PUT
   * /workflow` it answered. A change made around the write that it did not
   * make, as a barista's, which Decaid's answer may hold already, is decided
   * on once the write is done.
   */
  ownWrite<T>(work: (answered: Answered) => Promise<T>): Promise<T>;
  /**
   * Before a post of DYE2's recipes from `before` to `after`: where the
   * Workflow names a record the post removes, or gives to another Recipe's
   * (`vacatedIds`), the field is cleared first, so the Workflow never names
   * another Recipe than the one it applied. Throws if Decaid does not clear
   * it, and the list is not posted.
   */
  beforePost(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): Promise<void>;
  /** After a post of DYE2's recipes Decaid took, with the list posted. */
  posted(records: readonly Record<string, unknown>[]): void;
}

export class LoadedRecipes implements LoadedRecipeWrites {
  /** The latest Workflow Decaid reported, or answered a write of the plugin's with. */
  private latest: Record<string, unknown> | undefined;
  /**
   * The Loaded Recipe, by its global id, as the plugin last decided on the
   * Workflow, null for none; undefined until it first decides, which takes
   * the Recipe the Workflow names as the one the server has loaded already,
   * writing nothing for it.
   */
  private loaded: string | null | undefined;
  /** The tablet's records that can be a Loaded Recipe, by their ids there, as last read; null until first read. */
  private records: Map<string, { globalId: string; record: Record<string, unknown> }> | null = null;
  private dye2: Dye2State | "unknown" = "unknown";
  /**
   * Armed for twice the poll interval as DYE2 is first seen not loaded,
   * since it was last loaded, by the host's timers, as SHOT_STORED_WITHIN_MS
   * is, which a correction of the tablet's clock does not move.
   */
  private awayTimer: number | undefined;
  /** Whether `awayTimer` has fired since DYE2 was last seen loaded. */
  private notLoadedLong = false;
  private captureOnly = false;
  /** How many writes of the plugin's into the Workflow are under way (`ownWrite`). */
  private writing = 0;
  /**
   * During the writes under way: whether Decaid reported a change of the
   * Workflow, the latest Workflow it answered them with, the Workflow the
   * plugin last knew before them, and the fields they set.
   */
  private duringWrite: { reported: boolean; answered: Record<string, unknown> | undefined; before: Record<string, unknown> | undefined; written: Set<string> } = {
    reported: false,
    answered: undefined,
    before: undefined,
    written: new Set(),
  };
  /** How many loads the plugin has decided on, so a save asked for before one is not made after it. */
  private loads = 0;
  /**
   * The save into the Loaded Recipe waiting its turn, with the Recipe, load
   * and profile of the change that asked for it: one more change of the same
   * needs none of its own, as DYE2 saves the Workflow as it is then.
   */
  private queuedSave: SaveFor | null = null;
  /** The Recipe, by its global id, whose load is held until the Shot being pulled ends, or null for none. */
  private heldLoad: string | null = null;
  /**
   * The load held as the plugin last stopped, by its Recipe's global id, or
   * null for none, once read from its storage, until the plugin's first
   * decision takes it, or its read does where that decision came first;
   * undefined until read.
   */
  private restoredLoad: string | null | undefined;
  /** How many loads the plugin had decided on as it first decided, or undefined before. */
  private firstLoads: number | undefined;
  /** Whether the plugin's storage may keep a load held for a Shot. */
  private loadKept = false;
  /**
   * Steam turned back on with a Recipe loaded, its write of the Recipe's
   * steam temperature still to make, which the next save of that Recipe and
   * load makes first (`steamBackOnFirst`); null for none.
   */
  private steamBackOn: SteamBackOn | null = null;
  /**
   * Whether the Workflow had steam off at the plugin's last decision, or in
   * any Workflow Decaid has reported or answered its writes with since: so
   * steam turned off and back on while the plugin's writes were under way,
   * whose changes are decided on together once they are done, is seen as
   * turned back on.
   */
  private steamWasOff = false;
  private chain: Promise<void> = Promise.resolve();
  private pollTimer: number | undefined;
  private stopped = false;
  private failing = false;
  private readonly pushes: Dye2Pushes;

  constructor(
    /** Holds back the Workflow's changes the plugin sends while it writes into the Workflow and saves into the Loaded Recipe. */
    private readonly changes: WorkflowChanges,
    /** The reads and writes of the tablet's lists, one at a time, which a save into the Loaded Recipe, rewriting DYE2's recipes, takes its turn among. */
    private readonly library: LibraryAccess,
    private readonly log: (message: string) => void,
    transports: Transports,
    /** How often the plugin reads whether DYE2 is loaded, and its recipes, whatever else happens. */
    private readonly pollMs: number,
    /** Whether the Machine is pulling a Shot, which a load waits out. */
    private readonly shot: ShotGate,
    /** Decaid's plugin storage, which keeps the load held for a Shot across the plugin's loads. */
    private readonly storage: Pick<PluginStorage, "read" | "write">,
    /** Told of each push from DYE2, so its recipes reach the server then (`CollectionCapture.readRecipes`). */
    private readonly pushed: () => void = () => {},
    /** Reports DYE2's recipes now, from within `library`'s turn, resolving once queued (`CollectionCapture.recipesNow`). */
    private readonly reportRecipes: () => Promise<void> = async () => {},
    /** Told of each write into the Workflow Decaid took, with the Workflow read before it and the one Decaid answered (`Skins.workflowWritten`). */
    private readonly workflowWritten: Skins["workflowWritten"] = () => {},
  ) {
    this.pushes = new Dye2Pushes(transports, () => pushed());
  }

  start(): void {
    this.shot.onEnd(() => this.releaseLoad());
    this.shot.onEnd(() => this.resumeSteamBackOn());
    // From a timer, as Decaid's onLoad must return at once.
    setTimeout(() => void this.restoreLoad(), 0);
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.awayTimer !== undefined) clearTimeout(this.awayTimer);
    this.pushes.stop();
  }

  /** Whether the server says the Machine is capture-only: nothing is written into its Workflow, nor saved into its recipes, while it is. */
  setCaptureOnly(captureOnly: boolean): void {
    this.captureOnly = captureOnly;
  }

  /**
   * Decaid's `workflowUpdated`, before the Workflow is queued, so it may be
   * held back. A change during a write of the plugin's is that write's echo,
   * which the write decides on once done (`ownWrite`).
   */
  observe(workflow: Record<string, unknown>): void {
    if (this.stopped) return;
    const previous = this.latest;
    this.latest = workflow;
    if (steamOff(workflow)) this.steamWasOff = true;
    if (this.writing > 0) {
      this.duringWrite.reported = true;
      return;
    }
    this.decide(previous, true);
  }

  /** DYE2's recipes as a read of them found them, whoever read them. A list in a shape not recognised changes nothing. */
  sawRecipes(value: unknown): void {
    const records = value === null ? [] : dye2Records(value);
    if (records === null) return;
    this.records = loadable(records);
    if (this.writing === 0) this.decide(this.latest, false);
  }

  async ownWrite<T>(work: (answered: Answered) => Promise<T>): Promise<T> {
    if (this.writing === 0) this.duringWrite = { reported: false, answered: undefined, before: this.latest, written: new Set() };
    this.writing++;
    this.changes.hold();
    try {
      return await work((workflow, body) => {
        this.duringWrite.answered = workflow;
        for (const path of fieldPaths(body)) this.duringWrite.written.add(path);
      });
    } finally {
      this.writing--;
      if (this.writing === 0) this.wrote();
      this.changes.release();
    }
  }

  /**
   * Once the plugin's writes into the Workflow are done: a change made
   * around them that they did not make is decided on as any other, so a
   * barista's is saved into the Loaded Recipe. Decaid reports a write's
   * change ahead of answering it, so one reported after the answer, the
   * Workflow holding other than it, is another's; and Decaid merges each
   * write into the Workflow as it holds it then, so a part of the Recipe's
   * the writes did not set that differs from the Workflow the plugin knew
   * before them was changed meanwhile. A change of profile is judged from
   * that Workflow too, but where the writes set the profile themselves.
   */
  private wrote(): void {
    const { reported, answered, before, written } = this.duringWrite;
    if (!reported && answered !== undefined) this.latest = answered;
    const latest = this.latest;
    if (answered !== undefined && steamOff(answered)) this.steamWasOff = true;
    const after = latest !== undefined && answered !== undefined && !sameValue(latest, answered);
    const around = latest !== undefined && before !== undefined && changedBesides(before, latest, written);
    this.decide(written.has("profile") ? (answered ?? before) : before, (reported && after) || around);
  }

  async beforePost(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): Promise<void> {
    const vacated = new Set(vacatedIds(before, after));
    if (vacated.size === 0) return;
    await this.ownWrite(async (answered) => {
      const workflow = await workflowNow();
      const named = dye2RecipeIdOf(workflow);
      if (named === null || !vacated.has(named)) return;
      const body = clearRecipe();
      const answer = await request("PUT", "/workflow", body);
      const updated = answer.ok ? parsed(answer.text) : undefined;
      if (!isObject(updated)) throw new Error(`Decaid answered ${answer.status} clearing the Workflow's recipe before its record is replaced: ${answer.text.slice(0, 200)}`);
      answered(updated, body);
      this.workflowWritten(workflow, updated);
    });
  }

  posted(records: readonly Record<string, unknown>[]): void {
    this.sawRecipes(records);
  }

  /**
   * Decides on the latest Workflow, once the recipes are read: one naming a
   * Recipe the plugin has not loaded loads it (`load`), but on the
   * plugin's first decision, which takes it as loaded, unless its load was
   * held for a Shot as the plugin last stopped; a change of it
   * (`changed`) naming the Loaded Recipe is saved into it (`saveSoon`), but
   * for one changing the profile from `previous`, as DYE2 fingerprints one,
   * which DYE2 clears the recipe on. One leaving steam on where it was off
   * since the last decision (`steamWasOff`, `steamOnAt`), turned back on,
   * has the save write the Recipe's steam temperature first. A read of the
   * recipes (`changed` false) saves nothing.
   */
  private decide(previous: Record<string, unknown> | undefined, changed: boolean): void {
    const workflow = this.latest;
    if (workflow === undefined || this.records === null || this.stopped) return;
    const turnedOnAt = this.steamWasOff ? steamOnAt(workflow) : null;
    this.steamWasOff = steamOff(workflow);
    const recordId = dye2RecipeIdOf(workflow);
    const globalId = (recordId === null ? undefined : this.records.get(recordId))?.globalId ?? null;
    if (globalId !== this.loaded) {
      const first = this.loaded === undefined;
      // But for a load held for a Shot as the plugin last stopped, of the Recipe the Workflow still names.
      const restored = first && globalId !== null && globalId === this.restoredLoad;
      this.loaded = globalId;
      this.loads++;
      if (first) this.firstLoads = this.loads;
      if (globalId !== null && (!first || restored) && this.sharing()) this.load(globalId);
      else if (first && this.restoredLoad !== undefined) void this.keepHeldLoad(null);
      if (first && this.restoredLoad !== undefined) this.restoredLoad = null;
      this.steamBackOn = null;
      return;
    }
    if (!changed || globalId === null || !this.sharing()) return;
    if (previous !== undefined && dye2Fingerprint(previous.profile) !== dye2Fingerprint(workflow.profile)) return;
    if (turnedOnAt !== null) this.steamBackOn = { globalId, load: this.loads, temperature: turnedOnAt };
    this.saveSoon({ globalId, load: this.loads, fingerprint: dye2Fingerprint(workflow.profile) });
  }

  /** Whether the Machine shares and DYE2 is there, so the plugin writes into the Workflow and saves into its recipes. */
  private sharing(): boolean {
    return !this.captureOnly && !this.unavailable();
  }

  /**
   * Saves the Workflow into the Loaded Recipe the change asking for it was
   * made on (`save`), in `library`'s turn, holding the Workflow's changes
   * back until DYE2 has, and its recipes are reported where it wrote. One
   * save waiting its turn covers the changes of the same Recipe, load and
   * profile after it. As DYE2 saves into the recipe the live Workflow names,
   * the save is made only while that Workflow, read just before, still
   * names that Recipe on that profile, and no load was decided on since,
   * judged again once Decaid answered that read: a recipe applied
   * meanwhile, whose load write is still to come, or a change of profile,
   * which DYE2 clears the recipe on, is not saved into it. Where steam was
   * turned back on, the Recipe's steam temperature is written first, or the
   * save held with that write for a Shot (`steamBackOnFirst`). A save that
   * fails is tried again at the next change.
   */
  private saveSoon(save: SaveFor): void {
    const queued = this.queuedSave;
    if (queued !== null && queued.globalId === save.globalId && queued.load === save.load && queued.fingerprint === save.fingerprint) return;
    this.queuedSave = save;
    this.changes.hold();
    void this.library
      .run(async () => {
        if (this.queuedSave === save) this.queuedSave = null;
        const current = () => !this.stopped && this.loaded === save.globalId && this.loads === save.load && this.sharing();
        if (!current()) return;
        const workflow = await workflowNow();
        const recordId = dye2RecipeIdOf(workflow);
        const named = recordId === null ? undefined : this.records?.get(recordId)?.globalId;
        // Judged again once Decaid answered, as a recipe applied while its answer was on its way is decided on meanwhile.
        if (recordId === null || named !== save.globalId || dye2Fingerprint(workflow.profile) !== save.fingerprint || !current()) return;
        if (!(await this.steamBackOnFirst(workflow, recordId, save)) || !current()) return;
        if ((await recordIntoRecipe()) === "saved") await this.reportRecipes();
        this.failing = false;
      })
      .catch((error: unknown) => this.failed(error))
      .finally(() => this.changes.release());
  }

  /** Loads the Recipe in `library`'s turn (`loadRecipe`), or, while a Shot is being pulled, holds its load until the Shot ends. */
  private load(globalId: string): void {
    if (this.shot.running()) {
      this.holdLoad(globalId);
      return;
    }
    void this.library
      .run(() => this.loadRecipe(globalId))
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        if (this.heldLoad === null && !this.stopped) void this.keepHeldLoad(null);
      });
  }

  /** Holds the Recipe's load until the Shot ends, in place of any held before, and keeps it in the plugin's storage. */
  private holdLoad(globalId: string): void {
    this.heldLoad = globalId;
    void this.keepHeldLoad(globalId);
  }

  /** Once the Shot ends, makes the load held for it. */
  private releaseLoad(): void {
    const globalId = this.heldLoad;
    if (globalId === null || this.stopped) return;
    this.heldLoad = null;
    this.load(globalId);
  }

  /**
   * Reads the load held for a Shot as the plugin last stopped, which the
   * plugin's first decision makes where the Workflow names its Recipe; one it
   * cannot read is none. Read after that decision, it is made while the
   * Recipe it took as loaded is that one and no other load was decided on
   * since, and otherwise cleared.
   */
  private async restoreLoad(): Promise<void> {
    if (this.stopped) return;
    let stored: unknown = null;
    try {
      stored = await this.storage.read(HELD_LOAD_KEY, "a read of the load held for a Shot");
    } catch (error) {
      this.log(`The load held for a Shot could not be read from Decaid's plugin storage: ${error instanceof Error ? error.message : String(error)}`);
    }
    const restored = heldGlobalId(stored);
    // A load held while the read was under way is kept already.
    this.loadKept ||= restored !== null;
    if (this.stopped) return;
    if (this.firstLoads === undefined) {
      this.restoredLoad = restored;
      return;
    }
    this.restoredLoad = null;
    if (restored !== null && restored === this.loaded && this.loads === this.firstLoads && this.sharing()) this.load(restored);
    else if (this.heldLoad === null) void this.keepHeldLoad(null);
  }

  /** Keeps the load held for a Shot in the plugin's storage, or none, where it keeps one. */
  private async keepHeldLoad(globalId: string | null): Promise<void> {
    if (globalId === null && !this.loadKept) return;
    this.loadKept = globalId !== null;
    try {
      await this.storage.write(HELD_LOAD_KEY, JSON.stringify(globalId === null ? {} : { globalId }), "the write of the load held for a Shot");
    } catch (error) {
      this.log(`The load held for a Shot could not be kept in Decaid's plugin storage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Before a save into the Loaded Recipe, where steam was turned back on
   * with that Recipe and load (`steamBackOn`): writes the Recipe's steam
   * temperature, as the tablet's record of it holds it, into the Workflow
   * (`steamBackOnWrite`), where it still holds the temperature steam came
   * back at, so DYE2's save, which saves every value of the Workflow the
   * record holds otherwise, saves none of it. While the Machine pulls a
   * Shot, the write, and the save with it, are held until the Shot ends
   * (`resumeSteamBackOn`). Resolves with whether the save goes on. Throws
   * if Decaid refuses the write, as with no machine connected: the next
   * change tries again.
   */
  private async steamBackOnFirst(workflow: Record<string, unknown>, recordId: string, save: SaveFor): Promise<boolean> {
    const pending = this.steamBackOn;
    if (pending === null || pending.globalId !== save.globalId || pending.load !== save.load) return true;
    const record = this.records?.get(recordId)?.record;
    const write = record === undefined ? null : steamBackOnWrite(workflow, record, pending.temperature);
    if (write !== null && this.shot.running()) return false;
    if (write !== null) {
      await this.ownWrite(async (answered) => {
        const answer = await request("PUT", "/workflow", write);
        const updated = answer.ok ? parsed(answer.text) : undefined;
        if (!isObject(updated)) throw new Error(`Decaid answered ${answer.status} turning steam back on at the Loaded Recipe's steam temperature: ${answer.text.slice(0, 200)}`);
        answered(updated, write);
        this.workflowWritten(workflow, updated);
      });
    }
    if (this.steamBackOn === pending) this.steamBackOn = null;
    return true;
  }

  /** Once a Shot ends: saves where steam turned back on during it is still to be written, which writes it first. */
  private resumeSteamBackOn(): void {
    const pending = this.steamBackOn;
    const workflow = this.latest;
    if (pending === null || workflow === undefined || this.stopped || pending.globalId !== this.loaded || pending.load !== this.loads) return;
    if (!this.sharing() || this.shot.running()) return;
    this.saveSoon({ globalId: pending.globalId, load: pending.load, fingerprint: dye2Fingerprint(workflow.profile) });
  }

  /** Logs a failure once until a later step succeeds. */
  private failed(error: unknown): void {
    if (!this.failing) this.log(`The Loaded Recipe could not be followed: ${error instanceof Error ? error.message : String(error)}`);
    this.failing = true;
  }

  /** Runs each check in turn. */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.stopped ? undefined : work()))
      .then(() => {
        this.failing = false;
      })
      .catch((error: unknown) => this.failed(error));
  }

  /** On its poll, reads whether DYE2 is loaded, then its recipes. */
  private poll(): void {
    if (this.stopped) return;
    this.enqueue(() => this.check());
    this.pollTimer = setTimeout(() => this.poll(), this.pollMs);
  }

  private async check(): Promise<void> {
    this.dye2 = await readDye2State();
    if (this.dye2 === "loaded") {
      if (this.awayTimer !== undefined) clearTimeout(this.awayTimer);
      this.awayTimer = undefined;
      this.notLoadedLong = false;
      this.pushes.keepOpen();
    } else if (this.awayTimer === undefined && !this.notLoadedLong && !this.stopped) {
      // Only marks the time passed: the next check reports DYE2 away.
      this.awayTimer = setTimeout(() => {
        this.awayTimer = undefined;
        this.notLoadedLong = true;
      }, 2 * this.pollMs);
    }
    this.changes.dye2Absent(this.unavailable());
    this.sawRecipes(await this.readRecipes());
  }

  /**
   * Whether DYE2 is not there: absent, disabled, or not loaded for longer
   * than twice the poll interval, as the host's timers count it
   * (`awayTimer`). Unlike a Settings Edit's deadline, this needs no check by
   * the tablet's clock for time it spent asleep, as it measures an absence
   * seen across polls, and polls stop while the tablet sleeps too.
   */
  private unavailable(): boolean {
    if (this.dye2 === "absent" || this.dye2 === "disabled") return true;
    return this.dye2 === "notLoaded" && this.notLoadedLong;
  }

  /**
   * Loads the Recipe the Workflow names, while it still names it: writes
   * into the Workflow what applying a DYE2 recipe leaves out, or a stale
   * copy got wrong (`loadWrite`), as one write (`putWorkflow`), its profile,
   * where it writes one, the record's own. Decaid refuses to change the
   * steam, hot water and flush settings while no machine is connected, so
   * the rest is then written without them. A write Decaid takes is told of
   * (`workflowWritten`).
   */
  private async loadRecipe(globalId: string): Promise<void> {
    if (this.stopped || !this.sharing()) return;
    // A Shot begun while the load waited its turn: held, unless another was decided on since.
    if (this.shot.running()) {
      if (this.loaded === globalId && this.heldLoad === null) this.holdLoad(globalId);
      return;
    }
    await this.ownWrite(async (answered) => {
      const workflow = await workflowNow();
      const recordId = dye2RecipeIdOf(workflow);
      const recipe = recordId === null ? undefined : this.records?.get(recordId);
      // Another applied since, which its own change decides on.
      if (recordId === null || recipe === undefined || recipe.globalId !== globalId) return;
      const context = await this.loadContext(recipe.record);
      let write = loadWrite(workflow, recipe.record, context);
      if (write === null) return;
      let answer: Answer | undefined = await putWorkflow(write, answered);
      if (!answer.ok && MACHINE_SETTING_PARTS.some((part) => part in write!) && machineMissing(answer)) {
        write = loadWrite(workflow, recipe.record, context, new Set(RECIPE_SETTING_NAMES));
        answer = write === null ? undefined : await putWorkflow(write, answered);
      }
      if (answer && !answer.ok) throw new Error(`Decaid answered ${answer.status} loading the recipe ${recordId}: ${answer.text.slice(0, 200)}`);
      const after = answer ? parsed(answer.text) : undefined;
      if (isObject(after)) this.workflowWritten(workflow, after);
    });
  }

  /** The tablet's recipes, read now. Throws if Decaid does not answer with them. */
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
}

/**
 * Writes into the Workflow, which names the Loaded Recipe as the plugin has
 * just read it (DYE2_RECIPE_FIELD), as one `PUT /workflow` (`body`), which
 * Decaid merges into it, so the Workflow goes on naming the recipe. DYE2
 * keeps it named through a change of profile onto the one the tablet's
 * record of it holds (`recipeProfileChanged` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts), which is the profile a
 * load or the server's Loaded Recipe write writes (ADR-0022). The write names
 * no recipe itself: where a barista applied another in the moment since the
 * read, one naming it would name it again over that apply, and the plugin
 * would then save that recipe's values into it. Decaid's answer, where it
 * holds a Workflow, is told of with the body (`answered`). Resolves with
 * Decaid's answer. Throws if Decaid does not answer.
 */
export async function putWorkflow(body: Record<string, unknown>, answered: Answered): Promise<Answer> {
  const answer = await request("PUT", "/workflow", body);
  const updated = answer.ok ? parsed(answer.text) : undefined;
  if (isObject(updated)) answered(updated, body);
  return answer;
}

/** Told of each Workflow Decaid answers a write of the plugin's with, and the body of the `PUT /workflow` it answered. */
export type Answered = (workflow: Record<string, unknown>, body: Record<string, unknown>) => void;

/** Steam turned back on with a Recipe loaded: the Recipe, by its global id, and its load, and the temperature steam came back at (`steamOnAt`). */
interface SteamBackOn {
  globalId: string;
  load: number;
  temperature: number;
}

/** A save into the Loaded Recipe, for the Recipe, the load and the profile, by DYE2's fingerprint, of the change asking for it. */
interface SaveFor {
  globalId: string;
  load: number;
  fingerprint: string | null;
}

/** The fields a body of `PUT /workflow` sets, by their paths: a profile whole, as Decaid takes one. */
function fieldPaths(body: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(body).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return isObject(value) && path !== "profile" ? fieldPaths(value, path) : [path];
  });
}

/** The fields of a Workflow that follow its Loaded Recipe (LOADED_RECIPE_PARTS), by their paths. */
const PART_FIELDS: readonly string[] = Object.values(LOADED_RECIPE_PARTS).flat();

/**
 * Whether a field of a Workflow that follows its Loaded Recipe holds
 * otherwise in `after` than in `before`, of those the plugin's writes
 * between them did not set (`written`, by their paths): the brew
 * temperature but where they set the profile.
 */
function changedBesides(before: Record<string, unknown>, after: Record<string, unknown>, written: ReadonlySet<string>): boolean {
  const set = (field: string) => [...written].some((path) => field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`));
  return PART_FIELDS.some((field) => field !== "profile" && !set(field) && !sameValue(workflowValueAt(before, field), workflowValueAt(after, field)));
}

/** The Workflow as Decaid holds it now. Throws if Decaid does not answer with one. */
async function workflowNow(): Promise<Record<string, unknown>> {
  const answer = await request("GET", "/workflow");
  const workflow = answer.ok ? parsed(answer.text) : undefined;
  if (!isObject(workflow)) throw new Error(`Decaid answered ${answer.status} reading the Workflow`);
  return workflow;
}

/** The Recipe's global id the plugin's storage keeps as the load held for a Shot (HELD_LOAD_KEY), or null for none. */
function heldGlobalId(stored: unknown): string | null {
  const held = typeof stored === "string" ? parsed(stored) : undefined;
  return isObject(held) && typeof held.globalId === "string" ? held.globalId : null;
}

/** Whether Decaid refused a Workflow change as no machine is connected, which it needs to change the steam, hot water and flush settings. */
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
