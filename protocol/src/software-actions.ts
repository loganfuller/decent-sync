// Software Actions (ADR-0034, #657): what an Admin asks a Tablet to do to its
// plugins and to Decaid through the management interface, one at a time, as
// a Settings Edit is made (ADR-0023): only while the Tablet is connected,
// never queued, and kept with who asked and what came of it. The wire
// messages, shared by the plugin, which carries each out through Decaid's
// own routes, and the server, which makes, sends and records them.

/**
 * The wire revision Software Actions arrived in: the server sends a
 * `softwareAction` only to a plugin at it, and a plugin sends a
 * `softwareActed` only to a server at it, as the previous release's server
 * closes the connection on a message it does not know.
 */
export const SOFTWARE_ACTIONS_WIRE_REVISION = 5;

/** The plugin's own id in Decaid's plugin list, as its manifest declares it. */
export const DECENT_SYNC_PLUGIN_ID = "decent-sync.reaplugin";

/** The one setting of its own the plugin lets a Software Action change: the others are its connection to the server. */
export const OWN_CHANGEABLE_SETTING = "PollSeconds";

/**
 * What a Software Action does:
 *
 * - `installPlugin`: installs a plugin from a GitHub repository, its latest
 *   release, or the head of a branch, or a commit, which never moves. A
 *   plugin newly installed is not enabled;
 * - `enablePlugin`, `disablePlugin`: loads a plugin and has Decaid load it as
 *   it starts, or neither;
 * - `changePluginSettings`: saves some of a plugin's settings, which makes
 *   Decaid load the plugin again;
 * - `checkPluginUpdates`: has Decaid check every plugin it updates for a
 *   newer build now, installing each it finds unless that asks for a
 *   permission the plugin does not hold, which waits for approval;
 * - `approvePluginUpdate`: installs a plugin's update that waits;
 * - `removePlugin`: removes a plugin with its settings;
 * - `checkDecaidUpdate`: has Decaid check for a newer release of itself.
 */
export const SOFTWARE_ACTION_KINDS = [
  "installPlugin",
  "enablePlugin",
  "disablePlugin",
  "changePluginSettings",
  "checkPluginUpdates",
  "approvePluginUpdate",
  "removePlugin",
  "checkDecaidUpdate",
] as const;

export type SoftwareActionKind = (typeof SOFTWARE_ACTION_KINDS)[number];

export function isSoftwareActionKind(kind: unknown): kind is SoftwareActionKind {
  return typeof kind === "string" && (SOFTWARE_ACTION_KINDS as readonly string[]).includes(kind);
}

/**
 * The kinds that have Decaid download something, which get the longer time
 * (`softwareActionMs`): an install, an update check, and the approval of an
 * update that waits, which installs it.
 */
const DOWNLOADING_KINDS: readonly string[] = ["installPlugin", "checkPluginUpdates", "approvePluginUpdate", "checkDecaidUpdate"];

/**
 * How long a Software Action of the kind has to be answered from when it was
 * made, by PostgreSQL's clock: two minutes for one that downloads, a minute
 * for the rest, and for a kind not known. One unanswered by then is not
 * confirmed, and one no connection claimed is never sent later.
 */
export function softwareActionMs(kind: unknown): number {
  return typeof kind === "string" && DOWNLOADING_KINDS.includes(kind) ? 120_000 : 60_000;
}

/** The longest any Software Action has. */
export const MAX_SOFTWARE_ACTION_MS = 120_000;

/**
 * The least time a Software Action must have left for the plugin to start
 * it: with less, it refuses the action as `expired`. One started in time
 * may still finish later, as Decaid answers an install only once it is done.
 */
export const SOFTWARE_ACTION_START_MARGIN_MS = 15_000;

/** The most characters of a plugin's id, a version, a branch, a permission or an update's status. */
export const MAX_SOFTWARE_NAME_LENGTH = 200;

/** The most settings one change sets, and the most permissions an update adds. */
export const MAX_PLUGIN_SETTINGS = 200;

/** The most plugins an update check answers for. */
export const MAX_UPDATE_RESULTS = 200;

/** The most characters of a text setting's value. */
export const MAX_PLUGIN_SETTING_LENGTH = 10_000;

/** A GitHub repository as Decaid's install routes take one: `owner/name`. */
export function isPluginRepo(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SOFTWARE_NAME_LENGTH && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(value);
}

/** Whether a branch names a commit: 7 to 40 hexadecimal digits, as Git abbreviates and writes one. */
export function namesCommit(branch: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(branch);
}

/**
 * How Decaid reports a secret setting, in place of its value: whether one
 * is set. A changed secret is sent as its new text, and its `expected` as
 * this.
 */
export interface SecretState {
  isSet: boolean;
}

export function isSecretState(value: unknown): value is SecretState {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { isSet?: unknown }).isSet === "boolean";
}

/**
 * Asks the plugin to carry out a Software Action (ADR-0034), sent only on
 * the connection that held the Machine as it was made, and only to a plugin
 * at SOFTWARE_ACTIONS_WIRE_REVISION. The plugin carries them out one at a
 * time, in the order they arrive, in the queue its Settings Edits share.
 * For each, it refuses it as `expired` once the connection that sent it has
 * closed, or with less than SOFTWARE_ACTION_START_MARGIN_MS of `timeLeftMs`
 * left; refuses what its own protections forbid as `notAllowed`: disabling
 * or removing itself, and changing any of its own settings but the poll
 * interval; reads the machine's state, but for `checkDecaidUpdate`, and
 * goes ahead only while the machine is running nothing
 * (SETTINGS_EDIT_STATES) or none is connected to the tablet; reads the
 * lists and reports them; makes Decaid's request through `host.localApi`;
 * and then, whether Decaid took it or not, reads the lists again and sends
 * each as a `collection` delivery naming the action (`softwareActionId`)
 * before its answer, `softwareActed`.
 *
 * An action that has Decaid load the plugin itself again, such as approving
 * its own update, is answered by the plugin once it has loaded, from what
 * it then finds installed.
 */
export type SoftwareAction = {
  type: "softwareAction";
  /** The action's id, a UUID, which its answer repeats. */
  id: string;
  /** How long it has left, in ms, of `softwareActionMs(kind)` since it was made, as the server sent it. */
  timeLeftMs: number;
} & (
  | {
      kind: "installPlugin";
      /** The GitHub repository, `owner/name`. */
      repo: string;
      /** The branch whose head to install, or a commit; absent for the repository's latest release. */
      branch?: string;
    }
  | { kind: "enablePlugin" | "disablePlugin" | "removePlugin"; pluginId: string }
  | {
      kind: "approvePluginUpdate";
      pluginId: string;
      /** The waiting update the person saw: its version and the permissions it adds. The plugin approves only while the Tablet holds that one. */
      version: string;
      addedPermissions: string[];
    }
  | {
      kind: "changePluginSettings";
      pluginId: string;
      /** Each setting it sets, by its name in the plugin's manifest, with its new value: null clears one. */
      values: Record<string, unknown>;
      /**
       * What each of `values` held where the form was shown, as the plugin
       * reported it: a value, null for one not set, or `{ isSet }` for a
       * secret. The plugin saves only while the Tablet still holds each.
       */
      expected: Record<string, unknown>;
    }
  | { kind: "checkPluginUpdates" | "checkDecaidUpdate" }
);

/**
 * Why the plugin did not carry out a Software Action, or Decaid refused it:
 *
 * - `machineBusy`: the machine was running something, named by its state;
 * - `changedSince`: what the action was made over no longer holds on the
 *   Tablet: a setting's value, or the update that waited;
 * - `expired`: the plugin got it too late to start it. Nothing was asked of
 *   Decaid. Answered after the action was marked not confirmed, it leaves
 *   that mark;
 * - `notAllowed`: the plugin's own protections forbid it;
 * - `decaid`: Decaid refused it, or did not answer, or was not asked, as for
 *   a kind this plugin does not carry out.
 */
export const SOFTWARE_ACTED_REFUSALS = ["machineBusy", "changedSince", "expired", "notAllowed", "decaid"] as const;

export type SoftwareActedRefusal = (typeof SOFTWARE_ACTED_REFUSALS)[number];

/** One plugin's result of an update check, as Decaid answers it: `updated`, `alreadyCurrent`, `pendingApproval` or `failed`, a failure with Decaid's words. */
export interface UpdateResult {
  /** The plugin's id. */
  item: string;
  status: string;
  error?: string;
  /** The version installed after the check, where the plugin list held the plugin. */
  version?: string;
}

/** What came of a Software Action that was done. */
export interface SoftwareActionResult {
  /** The plugin installed, enabled, disabled, configured, updated or removed. */
  pluginId?: string;
  /** Its version as installed afterwards. */
  version?: string;
  /** Whether it was loaded afterwards. */
  loaded?: boolean;
  /** An update check's result for each plugin Decaid checked. */
  results?: UpdateResult[];
  /** Decaid's update state after a check for its own update, as `GET /update` answers. */
  decaid?: Record<string, unknown>;
}

/**
 * The plugin's answer to a `softwareAction`, sent through its outbox behind
 * the reports of the lists read after it, so the server takes in the
 * read-back first. Acknowledged with `ack` once recorded, by whichever
 * server instance it reaches, on this connection or a later one. Sent only
 * to a server at SOFTWARE_ACTIONS_WIRE_REVISION: one that would go to an
 * earlier server is dropped, and its action stays not confirmed.
 */
export interface SoftwareActed {
  type: "softwareActed";
  /** The action's id. */
  id: string;
  /** `done`: Decaid took it; `refused`: the plugin did not ask it to, or Decaid refused (`reason`). */
  outcome: "done" | "refused";
  /** Why it was refused; absent once done. */
  reason?: SoftwareActedRefusal;
  /** For `machineBusy`: the machine's state, as Decaid names it. */
  state?: string;
  /** For `decaid`: Decaid's HTTP status, or null if Decaid did not answer or was not asked. */
  status?: number | null;
  /**
   * For `decaid`: what Decaid answered (its `error`), or why it did not
   * answer or was not asked. For `changedSince` and `notAllowed`: what no
   * longer held, or what the plugin would not do, in words. Cut to
   * MAX_REFUSAL_LENGTH, and never a setting's value.
   */
  message?: string;
  /** What came of it, once done. */
  result?: SoftwareActionResult;
}
