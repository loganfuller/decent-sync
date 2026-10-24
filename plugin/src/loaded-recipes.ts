import { DYE2_NAMESPACE, MACHINE_SETTING_PARTS, RECIPE_SETTINGS, RECIPE_SETTING_NAMES, dye2Fingerprint, dye2RecipeIdOf, dye2Records, sameValue } from "@decent-sync/protocol";
import { type Answer, request } from "./decaid.js";
import { Dye2Pushes, type Dye2State, type Transports, readDye2State, recordIntoRecipe } from "./dye2.js";
import type { LibraryAccess } from "./library-writes.js";
import type { WorkflowChanges } from "./machine-events.js";
import { type LoadContext, changesProfile, clearRecipe, loadWrite, loadable, vacatedIds, withRecipe } from "./loaded-recipe-rules.js";
import type { Skins } from "./skins.js";
import { keepStreamlineSteamTemperature } from "./streamline.js";

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
// which DYE2 clears the recipe on a moment later. A write of the plugin's
// that changes the profile is made as two, so DYE2 keeps the recipe
// (`putNamingRecipe`, interim, until decentespresso/dye2#38). The server
// unloads one by having the plugin clear the field. On a Capture-only
// Machine, or while DYE2 is not there, nothing is written or saved.

const RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;

/** What the plugin's writes of the Workflow and of DYE2's recipes need of the Loaded Recipe (`LibraryWrites`). */
export interface LoadedRecipeWrites {
  /**
   * Runs a write of the plugin's into the Workflow (`work`), the changes
   * Decaid reports meanwhile held back until it is done, and taken as its
   * echo rather than saved into the Loaded Recipe. `work` tells
   * `answered` of each Workflow Decaid answers it with. A change reported
   * after the write's own, as a barista's in the moment around it, is
   * decided on once the write is done.
   */
  ownWrite<T>(work: (answered: (workflow: Record<string, unknown>) => void) => Promise<T>): Promise<T>;
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
  /** When DYE2 was first seen not loaded, since it was last loaded. */
  private notLoadedSince: number | null = null;
  private captureOnly = false;
  /** How many writes of the plugin's into the Workflow are under way (`ownWrite`). */
  private writing = 0;
  /** Whether Decaid reported a change of the Workflow during the writes under way, and the latest Workflow it answered them with. */
  private duringWrite: { reported: boolean; answered: Record<string, unknown> | undefined } = { reported: false, answered: undefined };
  /** Whether a save into the Loaded Recipe is waiting its turn: one more change needs none of its own, as DYE2 saves the Workflow as it is then. */
  private saveQueued = false;
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
    this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
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

  async ownWrite<T>(work: (answered: (workflow: Record<string, unknown>) => void) => Promise<T>): Promise<T> {
    if (this.writing === 0) this.duringWrite = { reported: false, answered: undefined };
    this.writing++;
    this.changes.hold();
    try {
      return await work((workflow) => {
        this.duringWrite.answered = workflow;
      });
    } finally {
      this.writing--;
      if (this.writing === 0) {
        const { reported, answered } = this.duringWrite;
        // Decaid reports a write's change ahead of answering it: one reported since, the Workflow holding other than the
        // write left, is another's, as a barista's.
        const another = reported && answered !== undefined && this.latest !== undefined && !sameValue(this.latest, answered);
        if (!reported && answered !== undefined) this.latest = answered;
        this.decide(answered ?? this.latest, another);
      }
      this.changes.release();
    }
  }

  async beforePost(before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): Promise<void> {
    const vacated = new Set(vacatedIds(before, after));
    if (vacated.size === 0) return;
    await this.ownWrite(async (answered) => {
      const workflow = await workflowNow();
      const named = dye2RecipeIdOf(workflow);
      if (named === null || !vacated.has(named)) return;
      const answer = await request("PUT", "/workflow", clearRecipe());
      const updated = answer.ok ? parsed(answer.text) : undefined;
      if (!isObject(updated)) throw new Error(`Decaid answered ${answer.status} clearing the Workflow's recipe before its record is replaced: ${answer.text.slice(0, 200)}`);
      answered(updated);
      this.workflowWritten(workflow, updated);
    });
  }

  posted(records: readonly Record<string, unknown>[]): void {
    this.sawRecipes(records);
  }

  /**
   * Decides on the latest Workflow, once the recipes are read: one naming a
   * Recipe the plugin has not loaded loads it (`loadRecipe`), but on the
   * plugin's first decision, which takes it as loaded; a change of it
   * (`changed`) naming the Loaded Recipe is saved into it (`saveSoon`), but
   * for one changing the profile from `previous`, as DYE2 fingerprints one,
   * which DYE2 clears the recipe on. A read of the recipes (`changed` false)
   * saves nothing.
   */
  private decide(previous: Record<string, unknown> | undefined, changed: boolean): void {
    const workflow = this.latest;
    if (workflow === undefined || this.records === null || this.stopped) return;
    const recordId = dye2RecipeIdOf(workflow);
    const globalId = (recordId === null ? undefined : this.records.get(recordId))?.globalId ?? null;
    if (globalId !== this.loaded) {
      const first = this.loaded === undefined;
      this.loaded = globalId;
      if (globalId !== null && !first && this.sharing()) {
        void this.library.run(() => this.loadRecipe(globalId)).catch((error: unknown) => this.failed(error));
      }
      return;
    }
    if (!changed || globalId === null || !this.sharing()) return;
    if (previous !== undefined && dye2Fingerprint(previous.profile) !== dye2Fingerprint(workflow.profile)) return;
    this.saveSoon();
  }

  /** Whether the Machine shares and DYE2 is there, so the plugin writes into the Workflow and saves into its recipes. */
  private sharing(): boolean {
    return !this.captureOnly && !this.unavailable();
  }

  /**
   * Saves the latest Workflow into the Loaded Recipe, in `library`'s turn,
   * holding the Workflow's changes back until DYE2 has, and its recipes are
   * reported where it wrote. One save waiting its turn covers the changes
   * after it. A save that fails is tried again at the next change.
   */
  private saveSoon(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.changes.hold();
    void this.library
      .run(async () => {
        this.saveQueued = false;
        if (this.stopped || this.loaded === null || !this.sharing()) return;
        if ((await recordIntoRecipe()) === "saved") await this.reportRecipes();
        this.failing = false;
      })
      .catch((error: unknown) => this.failed(error))
      .finally(() => this.changes.release());
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
      this.notLoadedSince = null;
      this.pushes.keepOpen();
    } else this.notLoadedSince ??= Date.now();
    this.changes.dye2Absent(this.unavailable());
    this.sawRecipes(await this.readRecipes());
  }

  /** Whether DYE2 is not there: absent, disabled, or not loaded for longer than twice the poll interval. */
  private unavailable(): boolean {
    if (this.dye2 === "absent" || this.dye2 === "disabled") return true;
    return this.dye2 === "notLoaded" && this.notLoadedSince !== null && Date.now() - this.notLoadedSince > 2 * this.pollMs;
  }

  /**
   * Loads the Recipe the Workflow names, while it still names it: writes
   * into the Workflow what applying a DYE2 recipe leaves out, or a stale
   * copy got wrong (`loadWrite`), as one write, or two where it changes the
   * profile (`putNamingRecipe`). Decaid refuses to change the steam, hot
   * water and flush settings while no machine is connected, so the rest is
   * then written without them. A write Decaid takes is told of
   * (`workflowWritten`). A steam temperature the recipe holds is kept as the
   * one Streamline turns steam back on at (`keepStreamlineSteamTemperature`),
   * written into the Workflow or not, as one into a Workflow whose steam is
   * off is not (interim, until decentespresso/streamline-js#156).
   */
  private async loadRecipe(globalId: string): Promise<void> {
    if (this.stopped || !this.sharing()) return;
    const record = await this.ownWrite(async (answered) => {
      const workflow = await workflowNow();
      const recordId = dye2RecipeIdOf(workflow);
      const recipe = recordId === null ? undefined : this.records?.get(recordId);
      // Another applied since, which its own change decides on.
      if (recordId === null || recipe === undefined || recipe.globalId !== globalId) return null;
      const context = await this.loadContext(recipe.record);
      let write = loadWrite(workflow, recipe.record, context);
      if (write === null) return recipe.record;
      let answer: Answer | undefined = await putNamingRecipe(workflow, write, recordId, answered);
      if (!answer.ok && MACHINE_SETTING_PARTS.some((part) => part in write!) && machineMissing(answer)) {
        write = loadWrite(workflow, recipe.record, context, new Set(RECIPE_SETTING_NAMES));
        answer = write === null ? undefined : await putNamingRecipe(workflow, write, recordId, answered);
      }
      if (answer && !answer.ok) throw new Error(`Decaid answered ${answer.status} loading the recipe ${recordId}: ${answer.text.slice(0, 200)}`);
      const after = answer ? parsed(answer.text) : undefined;
      if (isObject(after)) this.workflowWritten(workflow, after);
      return recipe.record;
    });
    if (record === null) return;
    const variables = isObject(record.dashboardVariables) ? record.dashboardVariables : {};
    await keepStreamlineSteamTemperature(variables[RECIPE_SETTINGS.steamTemperature.dye2], this.log);
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
 * Writes into the Workflow (`write`, the body of a `PUT /workflow`) that
 * names the recipe `recordId` there (DYE2_RECIPE_FIELD), keeping it named: a
 * write changing the profile as DYE2 fingerprints one (`changesProfile`) is
 * made as two, the recipe cleared, then the write with the recipe named
 * again, which DYE2 takes as a new apply of it on the new profile (interim,
 * until decentespresso/dye2#38); where Decaid refuses the second, the
 * recipe is named again alone. Each Workflow Decaid answers with is told of
 * (`answered`). Resolves with Decaid's answer to the write. Throws if Decaid
 * does not answer.
 */
export async function putNamingRecipe(
  workflow: Record<string, unknown>,
  write: Record<string, unknown>,
  recordId: string,
  answered: (workflow: Record<string, unknown>) => void,
): Promise<Answer> {
  const put = async (body: Record<string, unknown>) => {
    const answer = await request("PUT", "/workflow", body);
    const updated = answer.ok ? parsed(answer.text) : undefined;
    if (isObject(updated)) answered(updated);
    return answer;
  };
  if (!changesProfile(workflow, write)) return put(write);
  const cleared = await put(clearRecipe());
  if (!cleared.ok) return cleared;
  const answer = await put(withRecipe(write, recordId));
  if (!answer.ok) await put(withRecipe({}, recordId));
  return answer;
}

/** The Workflow as Decaid holds it now. Throws if Decaid does not answer with one. */
async function workflowNow(): Promise<Record<string, unknown>> {
  const answer = await request("GET", "/workflow");
  const workflow = answer.ok ? parsed(answer.text) : undefined;
  if (!isObject(workflow)) throw new Error(`Decaid answered ${answer.status} reading the Workflow`);
  return workflow;
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
