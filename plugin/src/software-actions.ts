import {
  DECENT_SYNC_REPO,
  MAX_PLUGIN_SETTINGS,
  MAX_REFUSAL_LENGTH,
  MAX_SOFTWARE_NAME_LENGTH,
  OWN_CHANGEABLE_SETTING,
  SETTINGS_EDIT_STATES,
  SKIN_RELOAD_MS,
  SOFTWARE_ACTION_START_MARGIN_MS,
  type SkinPage,
  type SoftwareActed,
  type SoftwareAction,
  type SoftwareActionResult,
  type UpdateResult,
  namesCommit,
  pluginSourceSeen,
  sameSourceSeen,
  sameValue,
  skinSourceSeen,
} from "@decent-sync/protocol";
import { type Answer, manage, request } from "./decaid.js";
import type { Transports } from "./host.js";
import { machineMissing } from "./loaded-recipes.js";
import type { Outbox } from "./outbox.js";
import type { SettingsAccess } from "./settings-edits.js";
import type { SkinPages } from "./skin-page.js";
import type { PluginStorage } from "./storage.js";

// Software Actions (ADR-0034): what the server asks the plugin to do to the
// Tablet's plugins, its Skins and Decaid, one at a time, through the routes Decaid's
// own pages use, called with `host.localApi`. Decaid stays the source of
// truth: nothing is put back later, and the lists are whatever it reports.

/** Decaid's socket for its own update, which takes the command to check for one (`update_handler.dart`). */
const UPDATE_SOCKET = "ws://localhost:8080/ws/v1/update";

/** How long Decaid's check for its own update is waited for, once asked. */
const UPDATE_CHECK_MS = 45_000;

/**
 * How long the start of Decaid's own update is waited for, once asked: its
 * download, then the opening of Android's installer, within the two minutes
 * the action has.
 */
const UPDATE_START_MS = 95_000;

/** How long the Skin server is watched for serving again once started, and how often its status is read meanwhile. */
const SERVING_WATCH_MS = 5_000;
const SERVING_STEP_MS = 500;

/** Where an action that may have Decaid load this plugin again is kept meanwhile, in Decaid's plugin storage. */
const PENDING_KEY = "softwareAction";

/** How long an action kept across a load is still answered: longer than any action has, with room for a slow install. */
const PENDING_MS = 10 * 60_000;

/** How often the lists are read again while what came of an action does not show in them yet. */
const WATCH_STEP_MS = 3_000;

/**
 * How long the next load watches for what came of an action kept across a
 * load: Decaid writes where a plugin came from, and clears an update that
 * waited, only once the plugin it installed is loaded and its notification
 * permission settled (`PluginSourceService._install`).
 */
const RESUME_WATCH_MS = 30_000;

/** How Software Actions read the lists and report them, within their own `SettingsAccess.run` (`CollectionCapture.readSoftware`). */
export interface SoftwareReports {
  readSoftware(what: "plugins" | "decaid", readBackOf?: string): Promise<unknown[] | undefined>;
  readSoftwareSkins(readBackOf?: string): Promise<Record<string, unknown> | undefined>;
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
  /** Each plugin's build before the action, by its id: its version with its release or commit (`buildsOf`). */
  builds: Record<string, string>;
  /** When Decaid last installed each plugin, as its source says, by its id. */
  installed: Record<string, string>;
  /** For a change of how a plugin updates: the permissions it declared before. */
  permissions?: string[];
}

/**
 * Carries out the server's Software Actions one at a time, in the order
 * they arrive, in a queue of their own that the reads of what they change
 * share, apart from the Settings Edits', as one may wait minutes on Decaid,
 * and answers each through the outbox. An action is never queued for
 * later (ADR-0034): one whose connection has closed, or with less than
 * SOFTWARE_ACTION_START_MARGIN_MS of its time left, is refused as `expired`,
 * and one still waiting its turn as the plugin unloads is dropped,
 * unanswered.
 *
 * The plugin protects its own connection, whatever it is sent: it never
 * disables or removes itself, of its own settings changes only the poll
 * interval, and installs itself again only from its own repository's latest
 * release or one of its commits. For each action it then reads the machine's state, going ahead
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
    /** The page a Skin reports it shows, which Reload asks it to load again (`SkinPages`). */
    private readonly pages?: SkinPages,
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
    const endTime = Date.now() + action.timeLeftMs;
    let outOfTime = startBy < 0;
    const timer = setTimeout(() => (outOfTime = true), Math.max(0, startBy));
    const tooLate = () => outOfTime || !connected() || Date.now() > startByTime;
    return this.access.run(async () => {
      try {
        if (this.stopped) return;
        let answer: SoftwareActed | undefined;
        try {
          answer = await this.carryOut(action, tooLate, endTime);
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
   * again under it, from what is installed now, watched for a while as
   * Decaid finishes the install (`RESUME_WATCH_MS`): within the queue, so no
   * action sent to this load runs first. One it can't tell the outcome of
   * by then is left unanswered, and so not confirmed; one this load unloads
   * under stays kept for the next. It never rejects.
   */
  resume(): Promise<void> {
    return this.access.run(async () => {
      try {
        const kept = parsed(String((await this.storage.read(PENDING_KEY, "the Software Action an earlier load kept")) ?? ""));
        if (!isPending(kept) || this.stopped) return;
        if (Date.now() - kept.startedAt > PENDING_MS || Date.now() < kept.startedAt) return void (await this.forget());
        const answer = await this.watch(kept, true, Math.min(kept.startedAt + PENDING_MS, Date.now() + RESUME_WATCH_MS));
        if (this.stopped) return;
        await this.forget();
        if (answer !== undefined) this.outbox.enqueue(answer);
      } catch (error) {
        this.log(`Could not answer the Software Action an earlier load kept: ${describe(error)}`);
      }
    });
  }

  /**
   * What came of a kept action once the plugin list shows it (`settled`),
   * read again every WATCH_STEP_MS until `until`, each read reported as a
   * read-back of the action; undefined where it never shows by then, or the
   * plugin unloads. An update check's results are asked of Decaid again
   * (`joinUpdateCheck`): after a load of the plugin, only once its own build
   * shows changed, which is what loaded it again.
   */
  private async watch(kept: Pending, reloaded: boolean, until: number): Promise<SoftwareActed | undefined> {
    for (;;) {
      if (this.stopped) return undefined;
      let plugins = await this.reports.readSoftware("plugins", kept.id);
      let report: unknown[] | undefined;
      if (plugins !== undefined && kept.kind === "checkPluginUpdates" && (!reloaded || ownBuildChanged(kept, plugins))) {
        report = await this.joinUpdateCheck().catch(() => undefined);
        if (report !== undefined && !this.stopped) plugins = (await this.reports.readSoftware("plugins", kept.id)) ?? plugins;
      }
      // A change of its own poll interval shows in the settings it was loaded again with.
      const ownSettings = reloaded && kept.kind === "changePluginSettings" ? await readOwnSettings() : undefined;
      if (this.stopped) return undefined;
      // A change of how a plugin updates is done once Decaid installed from its new source: whichever plugin that held.
      const installed = plugins !== undefined && kept.kind === "changePluginSource" ? installedSince(kept, plugins) : undefined;
      if (installed !== undefined && plugins !== undefined) return this.pluginSourceChanged(kept, String(installed.id), plugins);
      const answer = plugins === undefined ? undefined : settled(kept, plugins, report, reloaded, ownSettings);
      if (answer !== undefined) return answer;
      if (Date.now() + WATCH_STEP_MS > until) return undefined;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), WATCH_STEP_MS));
    }
  }

  /** The action's answer, or undefined where the plugin unloaded before or under it. */
  private async carryOut(action: SoftwareAction, tooLate: () => boolean, endTime: number): Promise<SoftwareActed | undefined> {
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

    if (isSkinAction(action)) return this.carryOutOnSkins(action, tooLate, endTime);
    if (action.kind === "startDecaidUpdate") return this.startDecaidUpdate(action, tooLate, endTime);

    const before = await this.reports.readSoftware("plugins");
    if (before === undefined) return refusedByDecaid(action.id, null, "Decaid did not answer with its plugins");
    const changed = await changedSince(action, before);
    if (changed !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "changedSince", message: changed };

    // Nothing is asked of Decaid once the plugin unloads, or too late to finish in time.
    if (this.stopped) return undefined;
    if (tooLate()) return expired(action.id);
    const reloads = mayReloadItself(action);
    const pending = pendingOf(action, before);
    if (reloads) await this.keep(pending);
    let answer: Answer | undefined;
    let failure = "";
    try {
      answer = await ask(action);
    } catch (error) {
      failure = describe(error);
      // Decaid unloaded this load under the call: the next load answers, from what it finds installed.
      if (reloads && /unloaded|generation changed/i.test(failure)) return undefined;
      // Decaid stops waiting on a call after a minute (`localApiTimeout`), and goes on with it: what came of it is watched for
      // until the action's time is up, kept for the next load meanwhile, and left unanswered where it never shows.
      if (/timed out/i.test(failure)) {
        const watched = await this.watch(pending, false, endTime);
        if (this.stopped) return undefined;
        if (reloads && watched !== undefined) await this.forget();
        return watched;
      }
    }
    if (this.stopped) return undefined;
    if (reloads) await this.forget();
    // Read back whether or not Decaid took it.
    const after = await this.reports.readSoftware("plugins", action.id).catch(() => undefined);
    if (answer === undefined) return refusedByDecaid(action.id, null, `Decaid did not answer: ${failure}`);
    if (!answer.ok) return refusedByDecaid(action.id, answer.status, decaidMessage(answer));
    if (action.kind === "changePluginSource") {
      // Decaid's answer names the plugin it installed; where it names none, the one the list shows installed since.
      const said = parsed(answer.text);
      const installed = isObject(said) && typeof said.id === "string" ? said.id : after === undefined ? undefined : installedSince(pending, after)?.id;
      return this.pluginSourceChanged(pending, typeof installed === "string" ? installed : action.pluginId, after ?? before);
    }
    return { type: "softwareActed", id: action.id, outcome: "done", result: resultOf(action, answer, before, after) };
  }

  /**
   * What a change of how a plugin updates came to, once Decaid installed
   * the plugin `installedId` from the new source, over the plugin list as it
   * is now. Done where that is the plugin the action named, with its version
   * before and after and the permissions its new build adds. Where the
   * source held another plugin, Decaid installed that one beside it: the
   * plugin removes it again, unless the Tablet held it before the action or
   * it is this plugin itself, reads the list back, and refuses the action as
   * `differentItem`, the plugin it named being as it was.
   */
  private async pluginSourceChanged(kept: Pending, installedId: string, plugins: unknown[]): Promise<SoftwareActed | undefined> {
    const listed = (id: string) => plugins.find((entry): entry is Record<string, unknown> => isObject(entry) && entry.id === id);
    const wanted = kept.pluginId ?? "";
    if (installedId === wanted) {
      const plugin = listed(wanted);
      const before = new Set(kept.permissions ?? []);
      const added = plugin && Array.isArray(plugin.permissions) ? plugin.permissions.filter((permission): permission is string => typeof permission === "string" && !before.has(permission)) : [];
      return {
        type: "softwareActed",
        id: kept.id,
        outcome: "done",
        result: {
          pluginId: wanted,
          ...(typeof plugin?.name === "string" && plugin.name !== "" ? { name: plugin.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {}),
          ...(typeof plugin?.version === "string" ? { version: plugin.version } : {}),
          ...(kept.versions[wanted] === undefined ? {} : { previousVersion: kept.versions[wanted] }),
          ...(typeof plugin?.loaded === "boolean" ? { loaded: plugin.loaded } : {}),
          ...(added.length > 0 ? { addedPermissions: added.slice(0, MAX_PLUGIN_SETTINGS).map((permission) => permission.slice(0, MAX_SOFTWARE_NAME_LENGTH)) } : {}),
        },
      };
    }
    const stray = listed(installedId);
    const named = String(stray?.name ?? installedId).slice(0, MAX_SOFTWARE_NAME_LENGTH);
    const heldBefore = kept.versions[installedId] !== undefined || installedId === __PLUGIN_ID__;
    let left = `${named} was on the Tablet before, and is now installed from that source`;
    if (!heldBefore) {
      const removed = await manage("DELETE", `/plugins/${encodeURIComponent(installedId)}`).catch((error: unknown): Answer => ({ status: 0, ok: false, text: describe(error) }));
      if (this.stopped) return undefined;
      await this.reports.readSoftware("plugins", kept.id).catch(() => undefined);
      left = removed.ok ? "Decaid installed it beside it, and the plugin removed it again" : `Decaid installed it beside it, and it could not be removed again (${removed.status === 0 ? removed.text : decaidMessage(removed)}): remove it from its row`;
    }
    const wantedName = String(listed(wanted)?.name ?? wanted).slice(0, MAX_SOFTWARE_NAME_LENGTH);
    return differentItem(kept.id, `That source holds another plugin, ${named}, not ${wantedName}. ${left}. ${wantedName} is unchanged`);
  }

  /**
   * Carries out an action on the Tablet's Skins, the machine idle: reads the
   * Skins, refuses what no longer holds and what the plugin's protections
   * forbid (removing the default Skin or the one served, whatever it is sent), asks Decaid,
   * and reads the Skins back, whether or not Decaid took it.
   */
  private async carryOutOnSkins(action: SkinAction, tooLate: () => boolean, endTime: number): Promise<SoftwareActed | undefined> {
    const before = await this.reports.readSoftwareSkins();
    if (this.stopped) return undefined;
    if (before === undefined) return refusedByDecaid(action.id, null, "Decaid did not answer with its Skins");
    const forbidden = forbiddenOnSkins(action, before);
    if (forbidden !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "notAllowed", message: forbidden };
    const changed = skinsChangedSince(action, before, this.pages?.latest() ?? null);
    if (changed !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "changedSince", message: changed };
    if (tooLate()) return expired(action.id);

    if (action.kind === "reloadSkin") return this.reloadSkin(action, String(servedSkin(before)?.id));
    if (action.kind === "restartSkinView") return this.restartSkinView(action);

    let answer: Answer | undefined;
    let failure = "";
    try {
      answer = await askOnSkins(action);
    } catch (error) {
      failure = describe(error);
    }
    if (this.stopped) return undefined;
    // Decaid stops waiting on a call after a minute and goes on with it: an install is watched for until the action's time is up.
    if (answer === undefined && action.kind === "installSkin" && /timed out/i.test(failure)) return this.watchSkinInstall(action, before, endTime);
    if (answer === undefined && action.kind === "changeSkinSource" && /timed out/i.test(failure)) {
      const watched = await this.watchSkinInstall(action, before, endTime, true);
      return watched === undefined || this.stopped ? undefined : this.skinSourceChanged(action, before, watched);
    }
    // An update check is asked for again, which joins the one still running and answers with its results (`checkForSkinUpdates`),
    // holding the actions after it meanwhile; not confirmed where that times out too, or the action's time is up.
    if (answer === undefined && action.kind === "checkSkinUpdates" && /timed out/i.test(failure)) {
      if (Date.now() >= endTime) return undefined;
      try {
        answer = await askOnSkins(action);
      } catch (error) {
        failure = describe(error);
        if (this.stopped || /timed out/i.test(failure)) return undefined;
      }
      if (this.stopped) return undefined;
    }
    const after = await this.reports.readSoftwareSkins(action.id).catch(() => undefined);
    if (answer === undefined) return refusedByDecaid(action.id, null, `Decaid did not answer: ${failure}`);
    if (!answer.ok) return refusedByDecaid(action.id, answer.status, decaidMessage(answer));
    if (action.kind === "changeSkinSource") return this.skinSourceChanged(action, before, after === undefined ? undefined : installedSkin(before, after, action.skinId));
    return { type: "softwareActed", id: action.id, outcome: "done", result: skinResultOf(action, answer, before, after) };
  }

  /**
   * Reads the Skins every WATCH_STEP_MS until `until` for the Skin an install
   * whose call timed out put there; undefined, and so not confirmed, where
   * none shows. Answers done with that Skin, or, for a change of how a Skin
   * updates (`found`), gives the Skin itself.
   */
  private async watchSkinInstall(action: SkinAction, before: Record<string, unknown>, until: number): Promise<SoftwareActed | undefined>;
  private async watchSkinInstall(action: SkinAction, before: Record<string, unknown>, until: number, found: true): Promise<Record<string, unknown> | undefined>;
  private async watchSkinInstall(action: SkinAction, before: Record<string, unknown>, until: number, found?: true): Promise<SoftwareActed | Record<string, unknown> | undefined> {
    for (;;) {
      if (this.stopped) return undefined;
      const after = await this.reports.readSoftwareSkins(action.id).catch(() => undefined);
      const installed = after === undefined ? undefined : installedSkin(before, after, action.kind === "changeSkinSource" ? action.skinId : undefined);
      if (installed !== undefined) return found ? installed : { type: "softwareActed", id: action.id, outcome: "done", result: skinNamed(installed) };
      if (Date.now() + WATCH_STEP_MS > until) return undefined;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), WATCH_STEP_MS));
    }
  }

  /**
   * What a change of how a Skin updates came to, once Decaid took the
   * install: `installed` is the Skin the list shows installed since. Done
   * where that is the Skin the action named, with its version before and
   * after. Where the source held another Skin, Decaid installed that one:
   * the plugin removes it again, unless the Tablet held it before, reads the
   * Skins back, and refuses the action as `differentItem`, the Skin it named
   * being as it was. Not confirmed where the list shows no Skin installed.
   */
  private async skinSourceChanged(action: Extract<SkinAction, { kind: "changeSkinSource" }>, before: Record<string, unknown>, installed: Record<string, unknown> | undefined): Promise<SoftwareActed | undefined> {
    if (installed === undefined) return { type: "softwareActed", id: action.id, outcome: "notConfirmed", message: "Decaid took the install, but its Skins list shows no Skin installed since" };
    const earlier = skinsIn(before).find((skin) => skin.id === action.skinId);
    if (installed.id === action.skinId) {
      const previous = typeof earlier?.version === "string" && earlier.version !== "" ? { previousVersion: earlier.version.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {};
      return { type: "softwareActed", id: action.id, outcome: "done", result: { ...skinNamed(installed), ...previous } };
    }
    const installedId = String(installed.id);
    const named = String(installed.name ?? installedId).slice(0, MAX_SOFTWARE_NAME_LENGTH);
    const wanted = String(earlier?.name ?? action.skinId).slice(0, MAX_SOFTWARE_NAME_LENGTH);
    let left = `${named} was on the Tablet before, and is now installed from that source`;
    if (!skinsIn(before).some((skin) => skin.id === installedId)) {
      const removed = await manage("DELETE", `/webui/skins/${encodeURIComponent(installedId)}`).catch((error: unknown): Answer => ({ status: 0, ok: false, text: describe(error) }));
      if (this.stopped) return undefined;
      await this.reports.readSoftwareSkins(action.id).catch(() => undefined);
      left = removed.ok ? "Decaid installed it beside it, and the plugin removed it again" : `Decaid installed it beside it, and it could not be removed again (${removed.status === 0 ? removed.text : decaidMessage(removed)}): remove it from its row`;
    }
    return differentItem(action.id, `That source holds another Skin, ${named}, not ${wanted}. ${left}. ${wanted} is unchanged`);
  }

  /**
   * Asks the Skin on screen, `skinId`, to load its page again, by a push on
   * `changes`, and waits up to SKIN_RELOAD_MS for its fresh page to report
   * in: done with that page, or not confirmed. Fresh is a page of that Skin
   * that loaded after the one last reported, both timed by the Skin view's
   * clock (`performance.timeOrigin`); or, where none has reported in this
   * load of the plugin, the first of that Skin to report after the push, as
   * Decaid keeps a Skin's socket open across the plugin's loads, so the Skin
   * reports again only once its page loads. Its `loadedAt` is not compared
   * with the plugin's own clock then: the Skin view's runs behind it once the
   * Tablet has slept.
   */
  private async reloadSkin(action: SkinAction, skinId: string): Promise<SoftwareActed | undefined> {
    if (!this.pages) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "changedSince", message: "This load of the plugin takes no page reports" };
    const pages = this.pages;
    const shown = pages.latest();
    const after = shown === null ? null : Date.parse(shown.loadedAt);
    let stopWaiting = () => {};
    const fresh = new Promise<SkinPage | undefined>((resolve) => {
      const timer = setTimeout(() => settle(undefined), SKIN_RELOAD_MS);
      const unsubscribe = pages.onReport((page) => {
        // Only the Skin asked counts: a page of another says nothing of it.
        if (page.skinId === skinId && (after === null || Date.parse(page.loadedAt) > after)) settle(page);
      });
      const settle = (page: SkinPage | undefined) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(page);
      };
      stopWaiting = () => settle(undefined);
    });
    try {
      pages.askReload();
    } catch (error) {
      stopWaiting();
      return refusedByDecaid(action.id, null, `Decaid did not take the push asking the Skin to reload: ${describe(error)}`);
    }
    const page = await fresh;
    if (this.stopped) return undefined;
    await this.reports.readSoftwareSkins(action.id).catch(() => undefined);
    if (page === undefined) {
      return {
        type: "softwareActed",
        id: action.id,
        outcome: "notConfirmed",
        message: `The Skin was asked to reload, but no fresh page reported in within ${SKIN_RELOAD_MS / 1000} s`,
      };
    }
    const reported = { skinId: page.skinId, ...(page.version === undefined ? {} : { version: page.version }), loadedAt: page.loadedAt };
    return { type: "softwareActed", id: action.id, outcome: "done", result: { skinId: page.skinId, ...(page.version === undefined ? {} : { version: page.version }), page: reported } };
  }

  /**
   * Stops Decaid's Skin server and starts it again, which has Decaid build
   * its Skin view again on the default Skin, then watches its status until
   * it serves, starting it once more if it does not: done with the Skin
   * served, or refused as `noSkinServed` where the Tablet is left with none.
   */
  private async restartSkinView(action: SkinAction): Promise<SoftwareActed | undefined> {
    const stopped = await manage("POST", "/webui/server/stop");
    if (this.stopped) return undefined;
    if (!stopped.ok) {
      await this.reports.readSoftwareSkins(action.id).catch(() => undefined);
      return refusedByDecaid(action.id, stopped.status, decaidMessage(stopped));
    }
    let said = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = await manage("POST", "/webui/server/start").catch((error: unknown) => ({ status: 0, ok: false, text: describe(error) }));
      if (this.stopped) return undefined;
      if (!started.ok) said = started.status === 0 ? started.text : decaidMessage(started);
      if (await this.servingSoon()) {
        const after = await this.reports.readSoftwareSkins(action.id).catch(() => undefined);
        const served = after === undefined ? undefined : servedSkin(after);
        return { type: "softwareActed", id: action.id, outcome: "done", result: served === undefined ? {} : skinNamed(served) };
      }
      if (this.stopped) return undefined;
    }
    await this.reports.readSoftwareSkins(action.id).catch(() => undefined);
    return {
      type: "softwareActed",
      id: action.id,
      outcome: "refused",
      reason: "noSkinServed",
      message: `Decaid's Skin server did not start again${said === "" ? "" : `: ${said}`}`.slice(0, MAX_REFUSAL_LENGTH),
    };
  }

  /** Whether Decaid's Skin server says it serves within SERVING_WATCH_MS. */
  private async servingSoon(): Promise<boolean> {
    const until = Date.now() + SERVING_WATCH_MS;
    for (;;) {
      if (this.stopped) return false;
      const status = await request("GET", "/webui/server/status").catch(() => undefined);
      const read = status?.ok ? parsed(status.text) : undefined;
      if (isObject(read) && read.serving === true) return true;
      if (Date.now() + SERVING_STEP_MS > until) return false;
      await new Promise<void>((resolve) => setTimeout(() => resolve(), SERVING_STEP_MS));
    }
  }

  /**
   * Has Decaid start its own update, over its update socket, the machine
   * idle: Decaid checks for it where it holds none, downloads it and opens
   * Android's installer, which someone at the Tablet confirms. Done once
   * Decaid says the installer opened (`installOverSocket`); refused where
   * Android's permission for Decaid to install apps was not granted at the
   * Tablet (`installNotPermitted`), where Decaid is checking, downloading
   * or installing already, found no update or did not open the installer,
   * or where it failed, in its words.
   */
  private async startDecaidUpdate(action: SoftwareAction, tooLate: () => boolean, endTime: number): Promise<SoftwareActed | undefined> {
    await this.reports.readSoftware("decaid");
    if (this.stopped) return undefined;
    if (tooLate()) return expired(action.id);
    let outcome: Started;
    try {
      outcome = await this.installOverSocket(Math.max(0, Math.min(UPDATE_START_MS, endTime - Date.now())));
    } catch (error) {
      outcome = { refused: "decaid", message: `Decaid did not answer: ${describe(error)}` };
    }
    if (this.stopped) return undefined;
    await this.reports.readSoftware("decaid", action.id).catch(() => undefined);
    if ("refused" in outcome) {
      return outcome.refused === "installNotPermitted"
        ? { type: "softwareActed", id: action.id, outcome: "refused", reason: "installNotPermitted", message: outcome.message.slice(0, MAX_REFUSAL_LENGTH) }
        : refusedByDecaid(action.id, null, outcome.message);
    }
    if ("notConfirmed" in outcome) return { type: "softwareActed", id: action.id, outcome: "notConfirmed", message: outcome.notConfirmed };
    const state = await request("GET", "/update").catch(() => undefined);
    const decaid = state?.ok ? parsed(state.text) : undefined;
    return { type: "softwareActed", id: action.id, outcome: "done", result: isObject(decaid) ? { decaid: updateState(decaid) } : {} };
  }

  /**
   * Sends Decaid's update socket the command to install, once it has sent
   * the state it opens with, and resolves with what came of it, judged from
   * the states it sends: started at its second `installing`, which Decaid
   * sends once Android's installer opens (`_installAttempt` sends a first
   * before it checks the download and launches the installer); Decaid's
   * refusal, as where Android's permission to install apps is not granted
   * (`local_approval_required`); a check that found nothing, an installer
   * that did not open, or a download or install that failed. Not confirmed
   * where none of these shows within `limitMs`: UPDATE_START_MS, or less
   * where the action's time is up sooner.
   */
  private async installOverSocket(limitMs: number): Promise<Started> {
    const handle = await this.transports.open(UPDATE_SOCKET);
    try {
      return await new Promise<Started>((resolve, reject) => {
        let opened = false;
        let underWay = false;
        let installing = false;
        let over = false;
        // What Decaid was last seen doing, for the note where the time is up: a download of its 120 MB or so goes on after.
        let lastSeen: Record<string, unknown> = {};
        const notConfirmed = () => {
          const seconds = Math.round(limitMs / 1000);
          if (lastSeen.phase === "downloading") {
            const progress = typeof lastSeen.progress === "number" && Number.isFinite(lastSeen.progress) ? ` (${Math.round(Math.min(1, Math.max(0, lastSeen.progress)) * 100)}%)` : "";
            return `Decaid was still downloading its update${progress} after ${seconds} s: Android's installer opens at the Tablet once it finishes`;
          }
          if (lastSeen.phase === "checking") return `Decaid was still checking for its update after ${seconds} s`;
          return `Decaid's update did not reach Android's installer within ${seconds} s`;
        };
        const timer = setTimeout(() => settle({ notConfirmed: notConfirmed() }), limitMs);
        const settle = (outcome: Started) => {
          over = true;
          clearTimeout(timer);
          resolve(outcome);
        };
        const fail = (error: unknown) => {
          over = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        this.transports.onEvent(handle, (event) => {
          if (over) return;
          if (event.type !== "data") return fail(new Error("its update socket closed"));
          const frame = parsed(event.data);
          if (!isObject(frame)) return;
          if (typeof frame.error === "string" && frame.phase === undefined) {
            return settle(frame.reason === "local_approval_required" ? { refused: "installNotPermitted", message: frame.error } : { refused: "decaid", message: frame.error });
          }
          const phase = frame.phase;
          if (opened) lastSeen = frame;
          if (!opened) {
            opened = true;
            // The state it opens with, from before the command, as an error an earlier check left. Decaid ignores the command,
            // saying nothing, while it checks, downloads or installs (`downloadAndInstall`), so it is sent only once this is known.
            if (phase === "checking") return settle({ refused: "decaid", message: "Decaid is checking for its update now: start the update once the check ends" });
            if (phase === "downloading" || phase === "installing") return settle({ refused: "decaid", message: `Decaid is ${String(phase)} its update already` });
            this.transports.send(handle, JSON.stringify({ command: "install" })).catch(fail);
            return;
          }
          if (phase === "installing") {
            if (installing) return settle({ started: true });
            installing = true;
            return;
          }
          if (phase === "error") return settle({ refused: "decaid", message: typeof frame.error === "string" && frame.error !== "" ? frame.error : "Decaid could not update itself" });
          // After its first `installing`, `available` or `idle` is an installer that did not open (`permissionRequired`, `cancelled`).
          if (installing && (phase === "available" || phase === "idle")) return settle({ refused: "decaid", message: "Decaid did not open Android's installer" });
          if (phase === "checking" || phase === "downloading") underWay = true;
          else if (phase === "idle" && underWay) settle({ refused: "decaid", message: "Decaid found no update to install" });
        });
      });
    } finally {
      this.transports.close(handle);
    }
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

  /**
   * Sends Decaid's update socket the command to check, and resolves once its
   * state has left `checking`: with null, or with why Decaid would not check,
   * as where the state it opens with is downloading or installing its update,
   * when it takes no command to check (`requestCheck`).
   */
  private async checkOverSocket(): Promise<string | null> {
    const handle = await this.transports.open(UPDATE_SOCKET);
    try {
      return await new Promise<string | null>((resolve, reject) => {
        let checking = false;
        let opened = false;
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
          if (!opened) {
            opened = true;
            if (frame.phase === "downloading" || frame.phase === "installing") return settle(() => resolve(`Decaid is ${String(frame.phase)} its update, so it checks for none now`));
          }
          if (frame.phase === "checking") checking = true;
          else if (checking) settle(() => resolve(null));
        });
        this.transports.send(handle, JSON.stringify({ command: "check" })).catch((error: unknown) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
      });
    } finally {
      this.transports.close(handle);
    }
  }

  /**
   * The results of the update check that loaded this plugin again, once it
   * ends: Decaid answers a request for a check while one runs with that
   * check's results (`checkForPluginUpdates`), and one made after it ended
   * with a new check's, which finds what the first left. Undefined, and so
   * not confirmed, where the Machine is busy by now, as no new check is
   * started then, or Decaid answers with no results.
   */
  private async joinUpdateCheck(): Promise<unknown[] | undefined> {
    const state = await request("GET", "/machine/state");
    if (state.ok) {
      const machineState = stateOf(state.text);
      if (machineState === null || !(SETTINGS_EDIT_STATES as readonly string[]).includes(machineState)) return undefined;
    } else if (!machineMissing(state)) {
      return undefined;
    }
    const answer = await manage("POST", "/plugins/update");
    const said = answer.ok ? parsed(answer.text) : undefined;
    return isObject(said) && Array.isArray(said.results) ? said.results : undefined;
  }

  private async keep(pending: Pending): Promise<void> {
    await this.storage.write(PENDING_KEY, JSON.stringify(pending), "a Software Action that may load the plugin again");
  }

  private async forget(): Promise<void> {
    await this.storage.write(PENDING_KEY, "", "that a Software Action is done").catch((error: unknown) => this.log(`Could not clear the Software Action kept: ${describe(error)}`));
  }
}

/** An action as it is kept, over the plugin list as it was before it. */
function pendingOf(action: SoftwareAction, plugins: unknown[]): Pending {
  return {
    id: action.id,
    kind: action.kind,
    startedAt: Date.now(),
    versions: versionsOf(plugins),
    builds: buildsOf(plugins),
    installed: installedOf(plugins),
    ...("pluginId" in action ? { pluginId: action.pluginId } : {}),
    ...(action.kind === "installPlugin" || action.kind === "changePluginSource" ? { repo: action.repo, ...(action.branch === undefined ? {} : { branch: action.branch }) } : {}),
    ...(action.kind === "changePluginSource" ? { permissions: permissionsOf(plugins, action.pluginId) } : {}),
    ...(action.kind === "changePluginSettings" ? { pollSeconds: action.values[OWN_CHANGEABLE_SETTING] } : {}),
  };
}

/** Why the plugin's own protections forbid an action, or null where they allow it. */
function forbiddenToItself(action: SoftwareAction): string | null {
  if (!("pluginId" in action) || action.pluginId !== __PLUGIN_ID__) return null;
  if (action.kind === "disablePlugin") return "The Decent Sync plugin does not disable itself: that would cut the Tablet off from the server";
  if (action.kind === "removePlugin") return "The Decent Sync plugin does not remove itself: that would cut the Tablet off from the server";
  if (action.kind === "changePluginSettings" && Object.keys(action.values).some((setting) => setting !== OWN_CHANGEABLE_SETTING)) {
    return "The Decent Sync plugin changes none of its own settings but its poll interval: its server address and Token are set on the Tablet";
  }
  // A build from anywhere else, or a branch's moving head, could cut the Tablet off from the server with no way back from it.
  if (action.kind === "changePluginSource" && (action.repo.toLowerCase() !== DECENT_SYNC_REPO || (action.branch !== undefined && !namesCommit(action.branch)))) {
    return `The Decent Sync plugin installs itself only from the latest release of ${DECENT_SYNC_REPO} or one of its commits: a build from anywhere else could cut the Tablet off from the server`;
  }
  return null;
}

/** An action on the Tablet's Skins. */
type SkinAction = Extract<SoftwareAction, { kind: "installSkin" | "chooseDefaultSkin" | "checkSkinUpdates" | "removeSkin" | "changeSkinSource" | "reloadSkin" | "restartSkinView" }>;

const SKIN_KINDS: readonly string[] = ["installSkin", "chooseDefaultSkin", "checkSkinUpdates", "removeSkin", "changeSkinSource", "reloadSkin", "restartSkinView"];

function isSkinAction(action: SoftwareAction): action is SkinAction {
  return SKIN_KINDS.includes(action.kind);
}

/** What the start of Decaid's own update came to. */
type Started = { started: true } | { refused: "installNotPermitted" | "decaid"; message: string } | { notConfirmed: string };

/** The Skins in a report of them, `{ skins, default, server }`. */
function skinsIn(report: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(report.skins) ? report.skins.filter(isObject) : [];
}

/** The default Skin's id in a report of the Skins, or null where Decaid has none. */
function defaultSkinId(report: Record<string, unknown>): string | null {
  return isObject(report.default) && typeof report.default.id === "string" ? report.default.id : null;
}

/** The Skin Decaid's Skin server serves in a report of the Skins, by its path, or undefined where it serves none. */
function servedSkin(report: Record<string, unknown>): Record<string, unknown> | undefined {
  const server = isObject(report.server) ? report.server : {};
  if (server.serving !== true || typeof server.path !== "string") return undefined;
  return skinsIn(report).find((skin) => skin.path === server.path);
}

/**
 * Why the plugin's own protections forbid an action on the Skins, or null:
 * it never removes the default Skin, nor the one served, as Decaid would go
 * on serving a folder that is gone, which answers 404 once the page loads
 * again (`defaultRemoved`). And it changes the source of no Skin that comes
 * with Decaid, which restores it from its own repository each time it
 * starts and at each update check, whatever it was installed from since.
 */
function forbiddenOnSkins(action: SkinAction, before: Record<string, unknown>): string | null {
  if (action.kind === "changeSkinSource") {
    const skin = skinsIn(before).find((entry) => entry.id === action.skinId);
    return skin?.isBundled === true ? "Decaid restores a Skin it comes with from its own repository each time it starts, so how it updates can't be changed" : null;
  }
  if (action.kind !== "removeSkin") return null;
  if (action.skinId === defaultSkinId(before)) return "The plugin does not remove the default Skin: choose another default first";
  if (action.skinId === servedSkin(before)?.id) return "The plugin does not remove the Skin on screen: restart the Skin view onto the default first";
  return null;
}

/**
 * What no longer holds on the Tablet of what an action on the Skins was
 * made over, in words, or null: the Skin it names is gone, or, for Reload,
 * the Skin served now is not the one whose page last reported.
 */
function skinsChangedSince(action: SkinAction, before: Record<string, unknown>, page: SkinPage | null): string | null {
  if (action.kind === "chooseDefaultSkin" || action.kind === "removeSkin") {
    return skinsIn(before).some((skin) => skin.id === action.skinId) ? null : `The Tablet has no Skin ${action.skinId} any more`;
  }
  if (action.kind === "changeSkinSource") {
    const skin = skinsIn(before).find((entry) => entry.id === action.skinId);
    if (!skin) return `The Tablet has no Skin ${action.skinId} any more`;
    if (!sameSourceSeen(skinSourceSeen(skin), action.expected)) return SOURCE_MOVED;
  }
  if (action.kind === "reloadSkin") {
    const served = servedSkin(before);
    if (served === undefined) return "Decaid serves no Skin now: restart the Skin view";
    // None reported in this load of the plugin, it is asked all the same: the server judged from the page it kept.
    if (page !== null && page.skinId !== served.id) return `The Skin served now, ${String(served.name ?? served.id).slice(0, MAX_SOFTWARE_NAME_LENGTH)}, has not reported its page, so it can't be asked to reload`;
  }
  return null;
}

/** Decaid's request for an action on the Skins but Reload and the restart, through `host.localApi`. */
function askOnSkins(action: SkinAction): Promise<Answer> {
  switch (action.kind) {
    case "installSkin":
    case "changeSkinSource":
      if (action.url !== undefined) return manage("POST", "/webui/skins/install/url", { url: action.url });
      return action.branch === undefined
        ? manage("POST", "/webui/skins/install/github-release", { repo: action.repo })
        : manage("POST", "/webui/skins/install/github-branch", { repo: action.repo, branch: action.branch });
    case "chooseDefaultSkin":
      return manage("PUT", "/webui/skins/default", { skinId: action.skinId });
    case "checkSkinUpdates":
      return manage("POST", "/webui/skins/update");
    case "removeSkin":
      return manage("DELETE", `/webui/skins/${encodeURIComponent(action.skinId)}`);
    default:
      return Promise.reject(new Error(`this plugin carries out no ${action.kind} this way`));
  }
}

/** A Skin as a result names it: its id, and its name and version as the list holds them. */
function skinNamed(skin: Record<string, unknown>): SoftwareActionResult {
  return {
    ...(typeof skin.id === "string" ? { skinId: skin.id } : {}),
    ...(typeof skin.name === "string" && skin.name !== "" ? { name: skin.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {}),
    ...(typeof skin.version === "string" && skin.version !== "" ? { version: skin.version.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {}),
  };
}

/** The id of the Skin an update check's result names: by its id, or, for one Decaid comes with, by the repository it updates from (`github_release:<repo>@<tag>`). */
function skinIdFor(report: Record<string, unknown>, item: string): string | undefined {
  const skin = skinsIn(report).find((entry) => {
    if (entry.id === item) return true;
    const metadata = isObject(entry.reaMetadata) ? entry.reaMetadata : {};
    return typeof metadata.sourceUrl === "string" && metadata.sourceUrl.startsWith(`github_release:${item}@`);
  });
  return typeof skin?.id === "string" ? skin.id : undefined;
}

/** When Decaid installed each Skin in a report of them, by its id: its `reaMetadata.installedAt`, or its version and source where it records none. */
function skinInstalls(report: Record<string, unknown>): Map<string, string> {
  return new Map(
    skinsIn(report).flatMap((skin) => {
      if (typeof skin.id !== "string") return [];
      const metadata = isObject(skin.reaMetadata) ? skin.reaMetadata : {};
      return [[skin.id, typeof metadata.installedAt === "string" ? metadata.installedAt : `${String(skin.version)} ${String(metadata.sourceUrl)}`]];
    }),
  );
}

/**
 * The Skin an install put on the Tablet: one new since `before`, or
 * installed again since. The one an action named, where it is, then one new
 * since, so that another Decaid installed again meanwhile, as at its own
 * update check, is not taken for it.
 */
function installedSkin(before: Record<string, unknown>, after: Record<string, unknown>, named?: string): Record<string, unknown> | undefined {
  const earlier = skinInstalls(before);
  const changed = [...skinInstalls(after)].filter(([skinId, installed]) => earlier.get(skinId) !== installed).map(([skinId]) => skinId);
  const id = named !== undefined && changed.includes(named) ? named : (changed.find((skinId) => !earlier.has(skinId)) ?? changed[0]);
  return id === undefined ? undefined : skinsIn(after).find((skin) => skin.id === id);
}

/** What came of an action on the Skins Decaid took. */
function skinResultOf(action: SkinAction, answer: Answer, before: Record<string, unknown>, after: Record<string, unknown> | undefined): SoftwareActionResult {
  const listed = (report: Record<string, unknown> | undefined, id: string) => (report === undefined ? undefined : skinsIn(report).find((skin) => skin.id === id));
  switch (action.kind) {
    case "installSkin": {
      const installed = after === undefined ? undefined : installedSkin(before, after);
      return installed === undefined ? {} : skinNamed(installed);
    }
    case "chooseDefaultSkin": {
      const skin = listed(after, action.skinId) ?? listed(before, action.skinId);
      return skin === undefined ? { skinId: action.skinId } : skinNamed(skin);
    }
    case "removeSkin": {
      const skin = listed(before, action.skinId);
      return skin === undefined ? { skinId: action.skinId } : skinNamed(skin);
    }
    case "checkSkinUpdates": {
      const said = parsed(answer.text);
      const results = isObject(said) && Array.isArray(said.results) ? said.results : [];
      // Decaid moves a Skin's install time only when it installs a build: one moved since the Skins were read was updated,
      // whatever a check that joined Decaid's after the one that updated it says.
      const earlier = skinInstalls(before);
      const now = after === undefined ? earlier : skinInstalls(after);
      return {
        results: results.filter(isObject).flatMap((result): UpdateResult[] => {
          if (typeof result.item !== "string" || typeof result.status !== "string") return [];
          const skin = listed(after, result.item);
          const id = skinIdFor(after ?? before, result.item);
          const moved = id !== undefined && earlier.has(id) && now.has(id) && earlier.get(id) !== now.get(id);
          const status = moved && result.error === undefined ? "updated" : result.status;
          const version = typeof skin?.version === "string" && skin.version !== "" ? { version: skin.version.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {};
          return [{ item: result.item.slice(0, MAX_SOFTWARE_NAME_LENGTH), status: status.slice(0, MAX_SOFTWARE_NAME_LENGTH), ...(typeof result.error === "string" ? { error: result.error.slice(0, MAX_REFUSAL_LENGTH) } : {}), ...version }];
        }),
      };
    }
    default:
      return {};
  }
}

/** Whether carrying an action out may have Decaid load this plugin again: any install or update check may bring its own update. */
function mayReloadItself(action: SoftwareAction): boolean {
  if (action.kind === "installPlugin" || action.kind === "changePluginSource" || action.kind === "checkPluginUpdates") return true;
  return (action.kind === "approvePluginUpdate" || action.kind === "changePluginSettings") && action.pluginId === __PLUGIN_ID__;
}

/**
 * What no longer holds on the Tablet of what an action was made over, in
 * words, or null: the plugin it names is gone, the update that waited is
 * another or none, a setting it changes holds another value than the
 * form showed, a secret compared by whether it is set, or the plugin whose
 * source it changes is at another source or build than the page showed.
 */
async function changedSince(action: SoftwareAction, plugins: unknown[]): Promise<string | null> {
  if (!("pluginId" in action)) return null;
  const plugin = plugins.find((entry) => isObject(entry) && entry.id === action.pluginId) as Record<string, unknown> | undefined;
  if (!plugin) return `The Tablet has no plugin ${action.pluginId} any more`;
  if (action.kind === "changePluginSource" && !sameSourceSeen(pluginSourceSeen(plugin), action.expected)) return SOURCE_MOVED;
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
    case "changePluginSource":
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
  const named = (plugin: Record<string, unknown> | undefined) => (typeof plugin?.name === "string" && plugin.name !== "" ? { name: plugin.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {});
  const listed = (list: unknown[] | undefined) => list?.find((entry) => isObject(entry) && entry.id === pluginId) as Record<string, unknown> | undefined;
  // Removed, it is named as the list held it before.
  if (action.kind === "removePlugin") return { pluginId, ...named(listed(before)) };
  const plugin = listed(after) ?? listed(before);
  if (!plugin) return { pluginId };
  return { pluginId, ...named(plugin), ...(typeof plugin.version === "string" ? { version: plugin.version } : {}), ...(typeof plugin.loaded === "boolean" ? { loaded: plugin.loaded } : {}) };
}

/**
 * The answer to a kept action from the plugin list as it is now, or
 * undefined where that does not show what came of it yet. `reloaded` says
 * whether Decaid loaded this plugin again since, which is all a change of
 * its own poll interval shows.
 *
 * - an approval of an update is done once no update of the plugin waits
 *   and its build changed;
 * - an install is done where a plugin from the repository, and branch,
 *   asked for was installed since;
 * - an update check is done once Decaid gives its results (`report`), each
 *   plugin's as given, and updated where its build changed since the
 *   action: a check run again after the first ended finds those current;
 * - a change of its own poll interval is done once Decaid loaded it again
 *   with the value asked for (`ownSettings`): Decaid saves a plugin's
 *   settings before it loads it again.
 *
 * A build is a plugin's version with its release or commit, as a branch's
 * new commit may keep the version.
 */
function settled(kept: Pending, plugins: unknown[], report: unknown[] | undefined, reloaded: boolean, ownSettings?: unknown): SoftwareActed | undefined {
  const entries = plugins.filter(isObject);
  const builds = buildsOf(plugins);
  const done = (given: SoftwareActionResult): SoftwareActed => ({ type: "softwareActed", id: kept.id, outcome: "done", result: given });
  const resultFor = (plugin: Record<string, unknown>): SoftwareActionResult => ({
    pluginId: String(plugin.id),
    ...(typeof plugin.name === "string" && plugin.name !== "" ? { name: plugin.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {}),
    ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
    ...(typeof plugin.loaded === "boolean" ? { loaded: plugin.loaded } : {}),
  });
  switch (kept.kind) {
    case "approvePluginUpdate": {
      const plugin = entries.find((entry) => entry.id === kept.pluginId);
      const rebuilt = plugin !== undefined && builds[kept.pluginId!] !== undefined && builds[kept.pluginId!] !== kept.builds[kept.pluginId!];
      return plugin && rebuilt && !isObject(plugin.pendingUpdate) ? done(resultFor(plugin)) : undefined;
    }
    case "installPlugin": {
      const plugin = installedSince(kept, plugins);
      return plugin ? done(resultFor(plugin)) : undefined;
    }
    case "checkPluginUpdates": {
      if (report === undefined) return undefined;
      const versions = versionsOf(plugins);
      const results = report.filter(isObject).flatMap((given): UpdateResult[] => {
        const item = given.item;
        if (typeof item !== "string" || typeof given.status !== "string") return [];
        const rebuilt = kept.builds[item] !== undefined && builds[item] !== undefined && kept.builds[item] !== builds[item];
        const status = rebuilt ? "updated" : given.status;
        const error = !rebuilt && typeof given.error === "string" ? { error: given.error.slice(0, MAX_REFUSAL_LENGTH) } : {};
        return [{ item, status, ...error, ...(versions[item] === undefined ? {} : { version: versions[item]! }) }];
      });
      return done({ results });
    }
    case "changePluginSettings": {
      const own = entries.find((entry) => entry.id === __PLUGIN_ID__);
      const saved = kept.pollSeconds === undefined || kept.pollSeconds === null || (isObject(ownSettings) && sameValue(ownSettings[OWN_CHANGEABLE_SETTING], kept.pollSeconds));
      return reloaded && own && kept.pluginId === __PLUGIN_ID__ && saved ? done(resultFor(own)) : undefined;
    }
    default:
      return undefined;
  }
}

/** The plugin in a plugin list that Decaid installed since a kept action began, from the repository, and branch, the action named: undefined where none shows yet. */
function installedSince(kept: Pending, plugins: unknown[]): Record<string, unknown> | undefined {
  const installed = installedOf(plugins);
  return plugins.filter(isObject).find((entry) => {
    const source = isObject(entry.source) ? entry.source : {};
    const sameRepo = typeof source.repo === "string" && typeof kept.repo === "string" && source.repo.toLowerCase() === kept.repo.toLowerCase();
    const sameBranch = kept.branch === undefined ? source.kind === "github_release" : source.kind === "github_branch" && source.branch === kept.branch;
    const id = String(entry.id);
    return sameRepo && sameBranch && installed[id] !== undefined && installed[id] !== kept.installed[id];
  });
}

/** The permissions a plugin declares in a plugin list, by its id. */
function permissionsOf(plugins: unknown[], pluginId: string): string[] {
  const plugin = plugins.find((entry): entry is Record<string, unknown> => isObject(entry) && entry.id === pluginId);
  return Array.isArray(plugin?.permissions) ? plugin.permissions.filter((permission): permission is string => typeof permission === "string") : [];
}

/** What a change of how an item updates is refused with where the Tablet reports another source or build of it than the page showed. */
const SOURCE_MOVED = "The Tablet reports another source or build of it than the page showed: load the page again";

/** The refusal of a change of how an item updates whose source held another item. */
function differentItem(id: string, message: string): SoftwareActed {
  return { type: "softwareActed", id, outcome: "refused", reason: "differentItem", message: message.slice(0, MAX_REFUSAL_LENGTH) };
}

/** The plugin's own settings as Decaid holds them, or undefined where it does not answer with them. */
async function readOwnSettings(): Promise<unknown> {
  const read = await request("GET", `/plugins/${encodeURIComponent(__PLUGIN_ID__)}/settings`).catch(() => undefined);
  return read?.ok ? parsed(read.text) : undefined;
}

/** Whether the plugin's own build in a plugin list is another than before the action kept. */
function ownBuildChanged(kept: Pending, plugins: unknown[]): boolean {
  const now = buildsOf(plugins)[__PLUGIN_ID__];
  return now !== undefined && kept.builds[__PLUGIN_ID__] !== now;
}

/** Each plugin's build in a plugin list, by its id: its version, with the release or commit it was installed from. */
function buildsOf(plugins: unknown[]): Record<string, string> {
  return Object.fromEntries(
    plugins.filter(isObject).flatMap((plugin) => {
      if (typeof plugin.id !== "string" || typeof plugin.version !== "string") return [];
      const source = isObject(plugin.source) ? plugin.source : {};
      const from = typeof source.commit === "string" ? source.commit : typeof source.releaseTag === "string" ? source.releaseTag : "";
      return [[plugin.id, `${plugin.version} ${from}`]];
    }),
  );
}

/** When Decaid last installed each plugin in a plugin list, as its source says, by its id. */
function installedOf(plugins: unknown[]): Record<string, string> {
  return Object.fromEntries(
    plugins.filter(isObject).flatMap((plugin) => {
      const source = isObject(plugin.source) ? plugin.source : {};
      return typeof plugin.id === "string" && typeof source.installedAt === "string" ? [[plugin.id, source.installedAt]] : [];
    }),
  );
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
  return isObject(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.startedAt === "number" && isObject(value.versions) && isObject(value.builds) && isObject(value.installed);
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
    case "differentItem":
      return answer.message ?? "its source held another plugin or Skin";
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
