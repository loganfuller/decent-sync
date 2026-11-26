// Software Actions (ADR-0034, #657): what an Admin asks a Tablet to do to its
// plugins, its Skins and Decaid through the management interface, and what
// Staff at the Machine's Location may ask of its Skin view, one at a time, as
// a Settings Edit is made (ADR-0023): only while the Tablet is connected,
// never queued, and kept with who asked and what came of it. The wire
// messages, shared by the plugin, which carries each out through Decaid's
// own routes, and the server, which makes, sends and records them.

/** The plugin's own id in Decaid's plugin list, as its manifest declares it. */
export const DECENT_SYNC_PLUGIN_ID = "decent-sync.reaplugin";

/** The repository Decent Sync's own plugin is released from, which alone a change of how it updates may name. */
export const DECENT_SYNC_REPO = "loganfuller/decent-sync";

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
 * - `changePluginSource`: changes how an installed plugin updates, by
 *   installing it again from another source, a repository's latest release,
 *   the head of a branch, or a commit: Decaid records where an install came
 *   from and has no other way to change it. The plugin keeps its settings
 *   and whether it is enabled. The action names the plugin's id and the
 *   source the Admin saw, and changes nothing where the new source holds
 *   another plugin (`differentItem`);
 * - `installSkin`: installs a Skin from a GitHub repository, its latest
 *   release or the head of a branch, or from a URL serving a zip, such as a
 *   commit's archive, which never moves. Decaid installs no Skin from a
 *   commit given as a branch;
 * - `chooseDefaultSkin`: makes a Skin the one Decaid serves as it starts and
 *   after its Skin view restarts, which is the next time it shows;
 * - `checkSkinUpdates`: has Decaid check every Skin it updates for a newer
 *   build now, installing each it finds;
 * - `removeSkin`: removes a Skin that is neither the default, nor the one
 *   served, nor one that comes with Decaid;
 * - `changeSkinSource`: changes how an installed Skin updates, as
 *   `changePluginSource` does a plugin's, from a repository's latest
 *   release, the head of a branch, or a URL. The Skin stays the default
 *   where it was. No Skin that comes with Decaid is changed, as Decaid
 *   restores it from its own repository each time it starts;
 * - `reloadSkin`: asks the Skin on screen to load its page again, which a
 *   Skin that reports its page does (`SkinPage`);
 * - `restartSkinView`: stops and starts Decaid's Skin server, which has
 *   Decaid build its Skin view again on the default Skin;
 * - `checkDecaidUpdate`: has Decaid check for a newer release of itself;
 * - `startDecaidUpdate`: has Decaid download its update and open Android's
 *   installer, which someone at the Tablet confirms.
 */
export const SOFTWARE_ACTION_KINDS = [
  "installPlugin",
  "enablePlugin",
  "disablePlugin",
  "changePluginSettings",
  "checkPluginUpdates",
  "approvePluginUpdate",
  "removePlugin",
  "changePluginSource",
  "installSkin",
  "chooseDefaultSkin",
  "checkSkinUpdates",
  "removeSkin",
  "changeSkinSource",
  "reloadSkin",
  "restartSkinView",
  "checkDecaidUpdate",
  "startDecaidUpdate",
] as const;

export type SoftwareActionKind = (typeof SOFTWARE_ACTION_KINDS)[number];

export function isSoftwareActionKind(kind: unknown): kind is SoftwareActionKind {
  return typeof kind === "string" && (SOFTWARE_ACTION_KINDS as readonly string[]).includes(kind);
}

/**
 * The kinds that have Decaid download something, which get the longer time
 * (`softwareActionMs`): an install, an update check, the approval of an
 * update that waits, which installs it, a change of how a plugin or Skin
 * updates, which installs it again, and the start of Decaid's own update,
 * which downloads it.
 */
const DOWNLOADING_KINDS: readonly string[] = [
  "installPlugin",
  "checkPluginUpdates",
  "approvePluginUpdate",
  "changePluginSource",
  "installSkin",
  "checkSkinUpdates",
  "changeSkinSource",
  "checkDecaidUpdate",
  "startDecaidUpdate",
];

/** The kinds that change how an installed plugin or Skin updates (ADR-0035). */
export const SOURCE_CHANGE_KINDS = ["changePluginSource", "changeSkinSource"] as const satisfies readonly SoftwareActionKind[];

export function isSourceChangeKind(kind: unknown): kind is (typeof SOURCE_CHANGE_KINDS)[number] {
  return typeof kind === "string" && (SOURCE_CHANGE_KINDS as readonly string[]).includes(kind);
}

/**
 * The kinds Staff at the Machine's Location may make besides Admins, and
 * the only ones an assistant may (ADR-0034): reloading the Skin and
 * restarting the Skin view, which put no code on the Tablet. Every other
 * kind is an Admin's alone.
 */
export const SKIN_VIEW_KINDS = ["reloadSkin", "restartSkinView"] as const satisfies readonly SoftwareActionKind[];

export function isSkinViewKind(kind: unknown): kind is (typeof SKIN_VIEW_KINDS)[number] {
  return typeof kind === "string" && (SKIN_VIEW_KINDS as readonly string[]).includes(kind);
}

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

/** The most characters of the URL a Skin is installed from. */
export const MAX_SKIN_URL_LENGTH = 2000;

/** A URL a Skin is installed from: http or https, with no spaces, as Decaid's `install/url` downloads a zip from it. */
export function isSkinUrl(value: unknown): value is string {
  // The protocol runs where no URL class is assumed: a scheme, then a host, then anything but spaces.
  return typeof value === "string" && value.length <= MAX_SKIN_URL_LENGTH && /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#]\S*)?$/i.test(value);
}

/** One release's download on GitHub, as a URL names it: the repository, as owner/name, and the release's tag. */
export interface ReleaseAsset {
  repo: string;
  tag: string;
}

/**
 * The release a URL downloads a file of, where it is a GitHub release
 * asset's: `https://github.com/<owner>/<name>/releases/download/<tag>/<file>`.
 * What such a URL serves never changes, so a Skin installed from one stays
 * at that tag. Null for any other URL: another host's, or a repository's
 * `releases/latest/download/<file>`, which moves with each release.
 */
export function releaseAssetOf(url: unknown): ReleaseAsset | null {
  if (!isSkinUrl(url)) return null;
  // No URL class is assumed here either: GitHub's host, a repository, then the tag as one path segment and the file as the last.
  const found = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\/releases\/download\/([^/?#]+)\/[^/?#]+(?:[?#].*)?$/i.exec(url);
  if (!found) return null;
  let tag = found[2]!;
  try {
    tag = decodeURIComponent(tag);
  } catch {
    // A tag that is no valid encoding is shown as written.
  }
  return { repo: found[1]!, tag };
}

/** How long Reload waits for the Skin's fresh page to report in before it is not confirmed. */
export const SKIN_RELOAD_MS = 15_000;

/** A GitHub repository as Decaid's install routes take one: `owner/name`. */
export function isPluginRepo(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SOFTWARE_NAME_LENGTH && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(value);
}

/** Whether a branch names a commit: 7 to 40 hexadecimal digits, as Git abbreviates and writes one. */
export function namesCommit(branch: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(branch);
}

/** The URL of a commit's archive on GitHub, which a Skin is pinned to that commit by: Decaid installs no Skin from a commit given as its branch. */
export function commitArchiveUrl(repo: string, commit: string): string {
  return `https://github.com/${repo}/archive/${commit}.zip`;
}

/**
 * Where Decaid says a plugin or a Skin was installed from and the build it
 * is at, as a change of how it updates carries what the Admin saw
 * (`expected`): compared whole with what the Tablet reports as the action
 * runs, so that one made over an item that has since moved, to another
 * source or another build, changes nothing. Each is a string as Decaid
 * gives it, or null where it gives none.
 */
export type SourceSeen = Record<string, string | null>;

const seen = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * A plugin's source and build as its entry in Decaid's plugin list gives
 * them: its version, and of its `source` the kind, repository, branch,
 * commit and release tag.
 */
export function pluginSourceSeen(plugin: unknown): SourceSeen {
  const entry = isRecord(plugin) ? plugin : {};
  const source = isRecord(entry.source) ? entry.source : {};
  return {
    version: seen(entry.version),
    kind: seen(source.kind),
    repo: seen(source.repo),
    branch: seen(source.branch),
    commit: seen(source.commit),
    releaseTag: seen(source.releaseTag),
  };
}

/**
 * A Skin's source and build as its entry in Decaid's Skins list gives them:
 * its version, and of its `reaMetadata` where it was installed from
 * (`sourceUrl`) and the ETag of what that served, which moves with each
 * build a branch or a URL serves.
 */
export function skinSourceSeen(skin: unknown): SourceSeen {
  const entry = isRecord(skin) ? skin : {};
  const metadata = isRecord(entry.reaMetadata) ? entry.reaMetadata : {};
  return { version: seen(entry.version), sourceUrl: seen(metadata.sourceUrl), etag: seen(metadata.etag) };
}

/** Whether two sources seen are the same, field by field. */
export function sameSourceSeen(a: SourceSeen, b: SourceSeen): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? null) === (b[key] ?? null));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * the connection that held the Machine as it was made. The plugin carries
 * them out one at a
 * time, in the order they arrive, in the queue its Settings Edits share.
 * For each, it refuses it as `expired` once the connection that sent it has
 * closed, or with less than SOFTWARE_ACTION_START_MARGIN_MS of `timeLeftMs`
 * left; refuses what its own protections forbid as `notAllowed`: disabling
 * or removing itself, changing any of its own settings but the poll
 * interval, installing itself again from anywhere but its own repository's
 * latest release or one of its commits, and removing the default Skin or
 * the one on screen; reads the machine's state, but for `checkDecaidUpdate`, and
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
      kind: "changePluginSource";
      pluginId: string;
      /** The plugin's source and build as the Admin saw them (`pluginSourceSeen`). The plugin installs only while the Tablet still reports them. */
      expected: SourceSeen;
      /** The GitHub repository to install it again from, `owner/name`. */
      repo: string;
      /** The branch whose head to install, or a commit, which pins it; absent for the repository's latest release. */
      branch?: string;
    }
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
  | {
      kind: "installSkin";
      /** The GitHub repository, `owner/name`; absent for an install from a URL. */
      repo?: string;
      /** The branch whose head to install; absent for the repository's latest release. */
      branch?: string;
      /** The URL of a zip to install, in place of a repository. */
      url?: string;
    }
  | {
      kind: "chooseDefaultSkin" | "removeSkin";
      skinId: string;
    }
  | {
      kind: "changeSkinSource";
      skinId: string;
      /** The Skin's source and build as the Admin saw them (`skinSourceSeen`). The plugin installs only while the Tablet still reports them. */
      expected: SourceSeen;
      /** The GitHub repository to install it again from, `owner/name`; absent for an install from a URL. */
      repo?: string;
      /** The branch whose head to install; absent for the repository's latest release. */
      branch?: string;
      /** The URL of a zip to install, in place of a repository: a commit's archive or one release's download pins it. */
      url?: string;
    }
  | { kind: "checkSkinUpdates" | "reloadSkin" | "restartSkinView" }
  | { kind: "checkPluginUpdates" | "checkDecaidUpdate" | "startDecaidUpdate" }
);

/**
 * Why the plugin did not carry out a Software Action, or Decaid refused it:
 *
 * - `machineBusy`: the machine was running something, named by its state;
 * - `changedSince`: what the action was made over no longer holds on the
 *   Tablet: a setting's value, the update that waited, or the source or
 *   build of an item whose source it changes;
 * - `expired`: the plugin got it too late to start it. Nothing was asked of
 *   Decaid. Answered after the action was marked not confirmed, it leaves
 *   that mark;
 * - `notAllowed`: the plugin's own protections forbid it: disabling or
 *   removing itself, changing its own server address or Token, installing
 *   itself again from anywhere but its own repository's latest release or
 *   one of its commits, changing the source of a Skin that comes with
 *   Decaid, or removing the default Skin or the one on screen;
 * - `differentItem`: the source a change of how an item updates named held
 *   another plugin or Skin than the one it was to change, by its id, which
 *   Decaid installed beside it. The plugin removed that one again, unless
 *   the Tablet held it before, and the item it was to change is as it was;
 * - `installNotPermitted`: Decaid may not install its own update, as
 *   Android's permission for it to install apps has not been granted at the
 *   Tablet;
 * - `noSkinServed`: the Skin view was stopped and did not start again, so
 *   the Tablet shows no Skin;
 * - `decaid`: Decaid refused it, or did not answer, or was not asked, as for
 *   a kind this plugin does not carry out.
 */
export const SOFTWARE_ACTED_REFUSALS = ["machineBusy", "changedSince", "expired", "notAllowed", "differentItem", "installNotPermitted", "noSkinServed", "decaid"] as const;

export type SoftwareActedRefusal = (typeof SOFTWARE_ACTED_REFUSALS)[number];

/** One plugin's or Skin's result of an update check, as Decaid answers it: `updated`, `alreadyCurrent`, `pendingApproval` or `failed`, a failure with Decaid's words. */
export interface UpdateResult {
  /** The plugin's or Skin's id. */
  item: string;
  status: string;
  error?: string;
  /** The version installed after the check, where the list held it. */
  version?: string;
}

/**
 * The page a Skin reported it shows (`SkinPage`) as an action's result
 * carries it: the Skin's id and version as it gave them, and when its page
 * loaded.
 */
export interface ShownPage {
  skinId: string;
  version?: string;
  loadedAt: string;
}

/** What came of a Software Action that was done. */
export interface SoftwareActionResult {
  /** The plugin installed, enabled, disabled, configured, updated or removed. */
  pluginId?: string;
  /** The Skin installed, made the default or removed, or the one served once the Skin view restarted. */
  skinId?: string;
  /** Its name, as the list held it afterwards, or before where it was removed: what an install's log names it by. */
  name?: string;
  /** Its version as installed afterwards. */
  version?: string;
  /** For a change of how it updates: its version before, where the list held one. */
  previousVersion?: string;
  /** For a change of how a plugin updates: the permissions its new build declares that the one before did not, which Decaid's install takes with no approval asked. */
  addedPermissions?: string[];
  /** Whether it was loaded afterwards. */
  loaded?: boolean;
  /** An update check's result for each plugin or Skin Decaid checked. */
  results?: UpdateResult[];
  /** The fresh page a Skin reported once asked to reload. */
  page?: ShownPage;
  /** Decaid's update state after a check for its own update, or once its update started, as `GET /update` answers. */
  decaid?: Record<string, unknown>;
}

/**
 * The page a Skin on the Tablet reported it shows, kept by the plugin and
 * reported as the `skinPage` collection: what a Skin's author has it send
 * the plugin's `page` endpoint each time its page loads and each time its
 * connection to the plugin opens (site/src/content/docs/technical/skin-authors.md), with when the plugin
 * heard it. Unavailable until a Skin reports one in this load of the
 * plugin, so the server keeps the page an earlier load heard of.
 */
export interface SkinPage {
  /** The Skin's id, as Decaid's Skin list names it. */
  skinId: string;
  /** Its version, as its manifest gives it; absent where it gave none. */
  version?: string;
  /** When the page loaded, by the tablet's clock, as the Skin gave it. */
  loadedAt: string;
  /** When the plugin last heard from that page, by the tablet's clock. */
  reportedAt: string;
}

/**
 * The plugin's answer to a `softwareAction`, sent through its outbox behind
 * the reports of the lists read after it, so the server takes in the
 * read-back first. Acknowledged with `ack` once recorded, by whichever
 * server instance it reaches, on this connection or a later one.
 */
export interface SoftwareActed {
  type: "softwareActed";
  /** The action's id. */
  id: string;
  /**
   * `done`: Decaid took it; `refused`: the plugin did not ask it to, or
   * Decaid refused (`reason`); `notConfirmed`: asked, but what came of it
   * never showed, as a Skin asked to reload whose fresh page did not report
   * in within SKIN_RELOAD_MS, said in `message`.
   */
  outcome: "done" | "refused" | "notConfirmed";
  /** Why it was refused; absent once done. */
  reason?: SoftwareActedRefusal;
  /** For `machineBusy`: the machine's state, as Decaid names it. */
  state?: string;
  /** For `decaid`: Decaid's HTTP status, or null if Decaid did not answer or was not asked. */
  status?: number | null;
  /**
   * For `decaid`: what Decaid answered (its `error`), or why it did not
   * answer or was not asked. For the other refusals, and for `notConfirmed`:
   * what no longer held, what the plugin would not do, or what did not
   * show, in words. Cut to MAX_REFUSAL_LENGTH, and never a setting's value.
   */
  message?: string;
  /** What came of it, once done. */
  result?: SoftwareActionResult;
}
