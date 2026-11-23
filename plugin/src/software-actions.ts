import {
  MAX_REFUSAL_LENGTH,
  OWN_CHANGEABLE_SETTING,
  SETTINGS_EDIT_STATES,
  SOFTWARE_ACTION_START_MARGIN_MS,
  type SoftwareActed,
  type SoftwareAction,
  type SoftwareActionResult,
  type UpdateResult,
  sameValue,
} from "@decent-sync/protocol";
import { type Answer, manage, request } from "./decaid.js";
import type { Transports } from "./host.js";
import { machineMissing } from "./loaded-recipes.js";
import type { Outbox } from "./outbox.js";
import type { SettingsAccess } from "./settings-edits.js";
import type { PluginStorage } from "./storage.js";

// Software Actions (ADR-0034): what the server asks the plugin to do to the
// Tablet's plugins and to Decaid, one at a time, through the routes Decaid's
// own pages use, called with `host.localApi`. Decaid stays the source of
// truth: nothing is put back later, and the lists are whatever it reports.

/** Decaid's socket for its own update, which takes the command to check for one (`update_handler.dart`). */
const UPDATE_SOCKET = "ws://localhost:8080/ws/v1/update";

/** How long Decaid's check for its own update is waited for, once asked. */
const UPDATE_CHECK_MS = 45_000;

/** Where an action that may have Decaid load this plugin again is kept meanwhile, in Decaid's plugin storage. */
const PENDING_KEY = "softwareAction";

/** How long an action kept across a load is still answered: longer than any action has, with room for a slow install. */
const PENDING_MS = 10 * 60_000;

/** How Software Actions read the lists and report them, within `SettingsAccess.run` (`CollectionCapture.readSoftware`). */
export interface SoftwareReports {
  readSoftware(what: "plugins" | "decaid", readBackOf?: string): Promise<unknown[] | undefined>;
}

/** An action as it is kept while Decaid may load the plugin again under it: never a setting's value. */
interface Pending {
  id: string;
  kind: SoftwareAction["kind"];
  /** When it was started, by the tablet's clock. */
  startedAt: number;
  pluginId?: string;
  repo?: string;
  branch?: string;
  /** For a change of the plugin's own poll interval, the value asked for. */
  pollSeconds?: unknown;
  /** Each plugin's version before the action, by its id. */
  versions: Record<string, string>;
}

/**
 * Carries out the server's Software Actions one at a time, in the order
 * they arrive, in the queue the Settings Edits and the reads of the settings
 * share, and answers each through the outbox. An action is never queued for
 * later (ADR-0034): one whose connection has closed, or with less than
 * SOFTWARE_ACTION_START_MARGIN_MS of its time left, is refused as `expired`,
 * and one still waiting its turn as the plugin unloads is dropped,
 * unanswered.
 *
 * The plugin protects its own connection, whatever it is sent: it never
 * disables or removes itself, and of its own settings changes only the poll
 * interval. For each action it then reads the machine's state, going ahead
 * only while the machine runs nothing or none is connected, but for a check
 * for Decaid's own update; reads the lists; asks Decaid; and, whether Decaid
 * took it or not, reads the lists again and queues them as reports naming
 * the action before its answer, so the server ties what changed to it.
 *
 * Decaid loads the plugin again to install its update or save its settings,
 * dropping the call that asked. So an action that may do that is kept in
 * Decaid's plugin storage first, and answered by the next load, from what
 * it finds installed (`resume`).
 */
export class SoftwareActions {
  private stopped = false;

  constructor(
    private readonly access: SettingsAccess,
    private readonly outbox: Outbox,
    private readonly reports: SoftwareReports,
    private readonly storage: PluginStorage,
    private readonly transports: Transports & { send(handle: string, data: string): Promise<void> },
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Carries out an action once the reads, edits and actions before it are
   * done, and queues its answer. `connected` says whether the connection it
   * arrived on is still open. It never rejects.
   */
  apply(action: SoftwareAction, connected: () => boolean): Promise<void> {
    // Counted down as a Settings Edit's time is: by a host timer and by the tablet's clock.
    const startBy = action.timeLeftMs - SOFTWARE_ACTION_START_MARGIN_MS;
    const startByTime = Date.now() + startBy;
    let outOfTime = startBy < 0;
    const timer = setTimeout(() => (outOfTime = true), Math.max(0, startBy));
    const tooLate = () => outOfTime || !connected() || Date.now() > startByTime;
    return this.access.run(async () => {
      try {
        if (this.stopped) return;
        let answer: SoftwareActed | undefined;
        try {
          answer = await this.carryOut(action, tooLate);
        } catch (error) {
          answer = refusedByDecaid(action.id, null, `Decaid did not answer: ${describe(error)}`);
        }
        if (answer === undefined || this.stopped) return;
        if (answer.outcome === "refused") this.log(`Did not carry out Software Action ${action.id}: ${describeRefusal(answer)}`);
        this.outbox.enqueue(answer);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** Drops the actions still waiting their turn, and starts none after this, as the plugin unloads. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Answers the action an earlier load kept, if Decaid loaded the plugin
   * again under it, from what is installed now: within the queue, so no
   * action sent to this load runs first. One it can't tell the outcome of
   * is left unanswered, and so not confirmed. It never rejects.
   */
  resume(): Promise<void> {
    return this.access.run(async () => {
      try {
        const kept = parsed(String((await this.storage.read(PENDING_KEY, "the Software Action an earlier load kept")) ?? ""));
        if (!isPending(kept) || this.stopped) return;
        await this.forget();
        if (Date.now() - kept.startedAt > PENDING_MS || Date.now() < kept.startedAt) return;
        const plugins = await this.reports.readSoftware("plugins", kept.id);
        const answer = plugins === undefined ? undefined : afterReload(kept, plugins);
        if (answer === undefined || this.stopped) return;
        this.outbox.enqueue(answer);
      } catch (error) {
        this.log(`Could not answer the Software Action an earlier load kept: ${describe(error)}`);
      }
    });
  }

  /** The action's answer, or undefined where the plugin unloaded before or under it. */
  private async carryOut(action: SoftwareAction, tooLate: () => boolean): Promise<SoftwareActed | undefined> {
    if (tooLate()) return expired(action.id);
    const forbidden = forbiddenToItself(action);
    if (forbidden !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "notAllowed", message: forbidden };

    if (action.kind === "checkDecaidUpdate") return this.checkDecaidUpdate(action, tooLate);

    const state = await request("GET", "/machine/state");
    if (state.ok) {
      const machineState = stateOf(state.text);
      if (machineState === null) return refusedByDecaid(action.id, state.status, "Decaid's answer names no machine state");
      if (!(SETTINGS_EDIT_STATES as readonly string[]).includes(machineState)) {
        return { type: "softwareActed", id: action.id, outcome: "refused", reason: "machineBusy", state: machineState };
      }
    } else if (!machineMissing(state)) {
      return refusedByDecaid(action.id, state.status, decaidMessage(state));
    }

    const before = await this.reports.readSoftware("plugins");
    if (before === undefined) return refusedByDecaid(action.id, null, "Decaid did not answer with its plugins");
    const changed = await changedSince(action, before);
    if (changed !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "changedSince", message: changed };

    // Nothing is asked of Decaid once the plugin unloads, or too late to finish in time.
    if (this.stopped) return undefined;
    if (tooLate()) return expired(action.id);
    const reloads = mayReloadItself(action);
    if (reloads) await this.keep(action, before);
    let answer: Answer | undefined;
    let failure = "";
    try {
      answer = await ask(action);
    } catch (error) {
      failure = describe(error);
      // Decaid unloaded this load under the call: the next load answers, from what it finds installed.
      if (reloads && /unloaded|generation changed/i.test(failure)) return undefined;
    }
    if (this.stopped) return undefined;
    if (reloads) await this.forget();
    // Read back whether or not Decaid took it.
    const after = await this.reports.readSoftware("plugins", action.id).catch(() => undefined);
    if (answer === undefined) return refusedByDecaid(action.id, null, `Decaid did not answer: ${failure}`);
    if (!answer.ok) return refusedByDecaid(action.id, answer.status, decaidMessage(answer));
    return { type: "softwareActed", id: action.id, outcome: "done", result: resultOf(action, answer, before, after) };
  }

  /**
   * Has Decaid check for a newer release of itself, over its update socket,
   * which is the one way it takes the command: done once Decaid's state
   * leaves `checking`, with that state, in any Machine State, as the check
   * touches neither the Machine nor the Skin.
   */
  private async checkDecaidUpdate(action: SoftwareAction, tooLate: () => boolean): Promise<SoftwareActed | undefined> {
    await this.reports.readSoftware("decaid");
    if (this.stopped) return undefined;
    if (tooLate()) return expired(action.id);
    let refusal: string | null;
    try {
      refusal = await this.checkOverSocket();
    } catch (error) {
      refusal = `Decaid did not answer: ${describe(error)}`;
    }
    if (this.stopped) return undefined;
    await this.reports.readSoftware("decaid", action.id).catch(() => undefined);
    if (refusal !== null) return refusedByDecaid(action.id, null, refusal);
    const state = await request("GET", "/update");
    const decaid = state.ok ? parsed(state.text) : undefined;
    if (!isObject(decaid)) return refusedByDecaid(action.id, state.status, decaidMessage(state));
    // A check that failed leaves Decaid's state saying so, in its own words.
    if (decaid.phase === "error") return refusedByDecaid(action.id, null, typeof decaid.error === "string" && decaid.error !== "" ? decaid.error : "Decaid could not check for its update");
    return { type: "softwareActed", id: action.id, outcome: "done", result: { decaid: updateState(decaid) } };
  }

  /** Sends Decaid's update socket the command to check, and resolves once its state has left `checking`: with null, or with why Decaid would not check. */
  private async checkOverSocket(): Promise<string | null> {
    const handle = await this.transports.open(UPDATE_SOCKET);
    try {
      return await new Promise<string | null>((resolve, reject) => {
        let checking = false;
        const timer = setTimeout(() => reject(new Error("its check for an update did not finish in time")), UPDATE_CHECK_MS);
        const settle = (settled: () => void) => {
          clearTimeout(timer);
          settled();
        };
        this.transports.onEvent(handle, (event) => {
          if (event.type !== "data") return settle(() => reject(new Error("its update socket closed")));
          const frame = parsed(event.data);
          if (!isObject(frame)) return;
          // Its answer to a command it can't carry out, as on a platform it does not update itself on.
          if (typeof frame.error === "string" && frame.phase === undefined) return settle(() => resolve(frame.error as string));
          if (frame.phase === "checking") checking = true;
          else if (checking) settle(() => resolve(null));
        });
        this.transports.send(handle, JSON.stringify({ command: "check" })).catch((error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
      });
    } finally {
      this.transports.close(handle);
    }
  }

  private async keep(action: SoftwareAction, plugins: unknown[]): Promise<void> {
    const pending: Pending = {
      id: action.id,
      kind: action.kind,
      startedAt: Date.now(),
      versions: versionsOf(plugins),
      ...("pluginId" in action ? { pluginId: action.pluginId } : {}),
      ...(action.kind === "installPlugin" ? { repo: action.repo, ...(action.branch === undefined ? {} : { branch: action.branch }) } : {}),
      ...(action.kind === "changePluginSettings" ? { pollSeconds: action.values[OWN_CHANGEABLE_SETTING] } : {}),
    };
    await this.storage.write(PENDING_KEY, JSON.stringify(pending), "a Software Action that may load the plugin again");
  }

  private async forget(): Promise<void> {
    await this.storage.write(PENDING_KEY, "", "that a Software Action is done").catch((error: unknown) => this.log(`Could not clear the Software Action kept: ${describe(error)}`));
  }
}

/** Why the plugin's own protections forbid an action, or null where they allow it. */
function forbiddenToItself(action: SoftwareAction): string | null {
  if (!("pluginId" in action) || action.pluginId !== __PLUGIN_ID__) return null;
  if (action.kind === "disablePlugin") return "The Decent Sync plugin does not disable itself: that would cut the Tablet off from the server";
  if (action.kind === "removePlugin") return "The Decent Sync plugin does not remove itself: that would cut the Tablet off from the server";
  if (action.kind === "changePluginSettings" && Object.keys(action.values).some((setting) => setting !== OWN_CHANGEABLE_SETTING)) {
    return "The Decent Sync plugin changes none of its own settings but its poll interval: its server address and Token are set on the Tablet";
  }
  return null;
}

/** Whether carrying an action out may have Decaid load this plugin again: any install or update check may bring its own update. */
function mayReloadItself(action: SoftwareAction): boolean {
  if (action.kind === "installPlugin" || action.kind === "checkPluginUpdates") return true;
  return (action.kind === "approvePluginUpdate" || action.kind === "changePluginSettings") && action.pluginId === __PLUGIN_ID__;
}

/**
 * What no longer holds on the Tablet of what an action was made over, in
 * words, or null: the plugin it names is gone, the update that waited is
 * another or none, or a setting it changes holds another value than the
 * form showed, a secret compared by whether it is set.
 */
async function changedSince(action: SoftwareAction, plugins: unknown[]): Promise<string | null> {
  if (!("pluginId" in action)) return null;
  const plugin = plugins.find((entry) => isObject(entry) && entry.id === action.pluginId) as Record<string, unknown> | undefined;
  if (!plugin) return `The Tablet has no plugin ${action.pluginId} any more`;
  if (action.kind === "approvePluginUpdate") {
    const waiting = isObject(plugin.pendingUpdate) ? plugin.pendingUpdate : null;
    if (waiting === null) return "No update of the plugin waits for approval any more";
    const added = Array.isArray(waiting.addedPermissions) ? [...waiting.addedPermissions].sort() : [];
    if (waiting.version !== action.version || !sameValue(added, [...action.addedPermissions].sort())) return "Another update of the plugin waits now than the one shown";
  }
  if (action.kind === "changePluginSettings") {
    const read = await request("GET", `/plugins/${encodeURIComponent(action.pluginId)}/settings`);
    const held = read.ok ? parsed(read.text) : undefined;
    if (!isObject(held)) return "Decaid did not answer with the plugin's settings";
    const differs = Object.keys(action.values).filter((setting) => !sameValue(held[setting] ?? null, action.expected[setting] ?? null));
    if (differs.length > 0) return `Changed on the Tablet since the form was shown: ${differs.join(", ")}`;
  }
  return null;
}

/** Decaid's request for an action, through `host.localApi`. */
function ask(action: SoftwareAction): Promise<Answer> {
  switch (action.kind) {
    case "installPlugin":
      return action.branch === undefined
        ? manage("POST", "/plugins/install/github-release", { repo: action.repo })
        : manage("POST", "/plugins/install/github-branch", { repo: action.repo, branch: action.branch });
    case "enablePlugin":
      return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/enable`);
    case "disablePlugin":
      return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/disable`);
    case "changePluginSettings":
      return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/settings`, action.values);
    case "checkPluginUpdates":
      return manage("POST", "/plugins/update");
    case "approvePluginUpdate":
      return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/update/approve`);
    case "removePlugin":
      return manage("DELETE", `/plugins/${encodeURIComponent(action.pluginId)}`);
    default:
      return Promise.reject(new Error(`this plugin carries out no ${(action as { kind: string }).kind}`));
  }
}

/** What came of an action Decaid took: the plugin it names in its answer or the action, as the list holds it afterwards. */
function resultOf(action: SoftwareAction, answer: Answer, before: unknown[], after: unknown[] | undefined): SoftwareActionResult {
  const said = parsed(answer.text);
  if (action.kind === "checkPluginUpdates") {
    const results = isObject(said) && Array.isArray(said.results) ? said.results : [];
    const versions = versionsOf(after ?? []);
    return {
      results: results.filter(isObject).flatMap((result): UpdateResult[] => {
        if (typeof result.item !== "string" || typeof result.status !== "string") return [];
        return [{ item: result.item, status: result.status, ...(typeof result.error === "string" ? { error: result.error.slice(0, MAX_REFUSAL_LENGTH) } : {}), ...(versions[result.item] === undefined ? {} : { version: versions[result.item]! }) }];
      }),
    };
  }
  const pluginId = "pluginId" in action ? action.pluginId : isObject(said) && typeof said.id === "string" ? said.id : undefined;
  if (pluginId === undefined) return {};
  const plugin = (after ?? before).find((entry) => isObject(entry) && entry.id === pluginId) as Record<string, unknown> | undefined;
  // Removed, it is in neither: its id alone.
  if (action.kind === "removePlugin" || !plugin) return { pluginId };
  return { pluginId, ...(typeof plugin.version === "string" ? { version: plugin.version } : {}), ...(typeof plugin.loaded === "boolean" ? { loaded: plugin.loaded } : {}) };
}

/**
 * The answer to an action kept across a load of the plugin, from the plugin
 * list as it is now, or undefined where that does not show what came of it:
 *
 * - an approval of its own update is done once no update waits and its
 *   version changed;
 * - an install is done where the plugin itself now comes from the
 *   repository, and branch, asked for;
 * - an update check is done where the plugin's own version changed, which
 *   is what loaded it again, with each plugin's result told from the list:
 *   updated where its version changed, waiting where an update waits,
 *   failed where its source holds an error, and current otherwise;
 * - a change of its poll interval is done: Decaid saves a plugin's settings
 *   before it loads it again.
 */
function afterReload(kept: Pending, plugins: unknown[]): SoftwareActed | undefined {
  const own = plugins.find((entry) => isObject(entry) && entry.id === __PLUGIN_ID__) as Record<string, unknown> | undefined;
  if (!own) return undefined;
  const version = typeof own.version === "string" ? own.version : undefined;
  const result: SoftwareActionResult = { pluginId: __PLUGIN_ID__, ...(version === undefined ? {} : { version }), loaded: true };
  const done = (given: SoftwareActionResult): SoftwareActed => ({ type: "softwareActed", id: kept.id, outcome: "done", result: given });
  const updated = version !== undefined && kept.versions[__PLUGIN_ID__] !== version;
  switch (kept.kind) {
    case "approvePluginUpdate":
      return kept.pluginId === __PLUGIN_ID__ && !isObject(own.pendingUpdate) && updated ? done(result) : undefined;
    case "installPlugin": {
      const source = isObject(own.source) ? own.source : {};
      const sameRepo = typeof source.repo === "string" && typeof kept.repo === "string" && source.repo.toLowerCase() === kept.repo.toLowerCase();
      const sameBranch = kept.branch === undefined ? source.kind === "github_release" : source.kind === "github_branch" && source.branch === kept.branch;
      return sameRepo && sameBranch ? done(result) : undefined;
    }
    case "checkPluginUpdates": {
      if (!updated) return undefined;
      const results = plugins.filter(isObject).flatMap((plugin): UpdateResult[] => {
        const source = isObject(plugin.source) ? plugin.source : null;
        if (typeof plugin.id !== "string" || (source?.kind !== "github_release" && source?.kind !== "github_branch")) return [];
        const now = typeof plugin.version === "string" ? plugin.version : undefined;
        const status = isObject(plugin.pendingUpdate)
          ? "pendingApproval"
          : now !== undefined && kept.versions[plugin.id] !== undefined && kept.versions[plugin.id] !== now
            ? "updated"
            : typeof source.lastError === "string" && source.lastError !== ""
              ? "failed"
              : "alreadyCurrent";
        return [{ item: plugin.id, status, ...(status === "failed" ? { error: String(source.lastError).slice(0, MAX_REFUSAL_LENGTH) } : {}), ...(now === undefined ? {} : { version: now }) }];
      });
      return done({ results });
    }
    case "changePluginSettings":
      return kept.pluginId === __PLUGIN_ID__ ? done(result) : undefined;
    default:
      return undefined;
  }
}

/** Each plugin's version in a plugin list, by its id. */
function versionsOf(plugins: unknown[]): Record<string, string> {
  return Object.fromEntries(plugins.filter(isObject).flatMap((plugin) => (typeof plugin.id === "string" && typeof plugin.version === "string" ? [[plugin.id, plugin.version]] : [])));
}

/** Decaid's update state as an answer carries it: what the page shows of it, its release notes left out. */
function updateState(state: Record<string, unknown>): Record<string, unknown> {
  const { releaseNotes: _notes, ...rest } = state;
  return rest;
}

function isPending(value: unknown): value is Pending {
  return isObject(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.startedAt === "number" && isObject(value.versions);
}

function expired(id: string): SoftwareActed {
  return { type: "softwareActed", id, outcome: "refused", reason: "expired" };
}

function refusedByDecaid(id: string, status: number | null, message: string): SoftwareActed {
  return { type: "softwareActed", id, outcome: "refused", reason: "decaid", status, message: message.slice(0, MAX_REFUSAL_LENGTH) };
}

/** The machine's state in Decaid's answer to `GET /machine/state`, or null if it names none. */
function stateOf(text: string): string | null {
  const snapshot = parsed(text);
  const state = isObject(snapshot) && isObject(snapshot.state) ? snapshot.state.state : undefined;
  return typeof state === "string" && state !== "" ? state : null;
}

/** What Decaid said in refusing: its `error`, its `message` or both, or its body as text, such as shelf's `Internal Server Error`. */
function decaidMessage(answer: Answer): string {
  const body = parsed(answer.text);
  const said = isObject(body) ? [body.error, body.message].filter((part): part is string => typeof part === "string" && part !== "") : [];
  if (said.length > 0) return said.join(": ");
  return answer.text === "" ? `Decaid answered ${answer.status}` : answer.text;
}

function describeRefusal(answer: SoftwareActed): string {
  switch (answer.reason) {
    case "machineBusy":
      return `the machine is ${answer.state}`;
    case "changedSince":
      return answer.message ?? "the Tablet's software changed since it was made";
    case "expired":
      return "it came too late to start in time, or its connection closed";
    case "notAllowed":
      return answer.message ?? "the plugin does not do that to itself";
    case "decaid":
      return `${answer.status === null || answer.status === undefined ? "" : `Decaid answered ${answer.status}: `}${answer.message}`;
    default:
      return String(answer.reason);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
