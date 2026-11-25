// A Machine's Tablet Software (ADR-0034, #657): Decaid, every plugin and
// every Skin on its Tablet, each with its version and how it updates, from
// the collections its Tablet reports. Decaid's payloads are opaque, so every
// field is optional here, and one of another type is left out. How an item
// updates is worked out from where Decaid says it was installed from, with
// no list of Decaid's ids.

import { DECENT_SYNC_PLUGIN_ID, type SourceSeen, isSecretState, namesCommit, pluginSourceSeen, releaseAssetOf, skinSourceSeen } from "@decent-sync/protocol";
import type { Report } from "../collections/paired-devices.js";

/**
 * How a plugin or Skin updates, worked out from where Decaid says it was
 * installed from: Decaid has one setting for update checks, tablet-wide, and
 * nothing per item, so an item's is changed by installing it again from
 * another source (`changePluginSource`, `changeSkinSource`, ADR-0035).
 *
 * - `followsReleases`: from a GitHub repository's latest release, so the
 *   next check installs a newer one;
 * - `followsBranch`: from a branch, so the next check installs its head;
 * - `pinned`: from a commit, or a URL naming a commit's archive or one
 *   GitHub release's download, which never moves; the last carries the
 *   release's `tag` and its repository in place of a commit;
 * - `followsUrl`: a Skin from any other URL, installed again once what the
 *   URL serves changes;
 * - `comesWithDecaid`: a Skin Decaid flags as built in, which Decaid
 *   restores from its own repository's latest release each time it starts
 *   and at each update check, so that its source can't be changed;
 * - `notUpdated`: no recorded source, or a zip or folder.
 */
export type UpdatesView =
  | { how: "followsReleases"; repo: string | null }
  | { how: "followsBranch"; repo: string | null; branch: string }
  | { how: "pinned"; repo: string | null; commit: string | null; tag?: string; url: string | null }
  | { how: "followsUrl"; url: string }
  | { how: "comesWithDecaid"; repo: string | null }
  | { how: "notUpdated" };

/** A setting a plugin declares in its manifest, with what the Tablet holds for it. */
export interface PluginSettingView {
  name: string;
  /** How its value is entered: `text`, `number`, `switch` or `choice`; a type Decaid adds later is entered as text. */
  kind: "text" | "number" | "switch" | "choice";
  label: string;
  description: string | null;
  /** A secret: its value is never reported, only whether one is set. */
  secret: boolean;
  /** For a `choice`. */
  choices: string[];
  /** Its default, where the manifest declares one. */
  default: unknown;
  /**
   * What the Tablet holds, to Admins only: a value, null for one not set,
   * or for a secret `{ isSet }`. Absent to anyone else, and until the
   * Tablet has reported its plugins' settings.
   */
  value?: unknown;
  /** Whether a Software Action may change it: none of the plugin's own but its poll interval. */
  changeable: boolean;
}

export interface PluginView {
  id: string;
  name: string | null;
  version: string | null;
  /** `enabled`: loaded, and loaded as Decaid starts; `disabled`: neither; `notLoaded`: to load as Decaid starts, but not loaded now, as while it updates or where it failed to load. */
  state: "enabled" | "disabled" | "notLoaded";
  updates: UpdatesView;
  /** Where Decaid says it came from and the build it is at (`pluginSourceSeen`): what a change of how it updates is made over, as `seen`. */
  build: SourceSeen;
  /** What the latest update check said went wrong, in Decaid's words, if it failed. */
  lastError: string | null;
  /** An update that waits for someone to approve the permissions it adds. */
  pendingUpdate: { version: string | null; addedPermissions: string[] } | null;
  permissions: string[];
  /** Decent Sync's own plugin, which is never disabled or removed from here. */
  own: boolean;
  settings: PluginSettingView[];
}

export interface SkinView {
  id: string;
  name: string | null;
  version: string | null;
  /** The Skin Decaid shows as it starts, and after its Skin view restarts. */
  default: boolean;
  /** Whether Decaid's Skin server is serving this Skin now. */
  served: boolean;
  updates: UpdatesView;
  /** Where Decaid says it came from and the build it is at (`skinSourceSeen`): what a change of how it updates is made over, as `seen`. */
  build: SourceSeen;
  /** Whether it may be removed: it is neither the default, nor the one served, nor one that comes with Decaid. */
  removable: boolean;
  /** Whether it is served now and has reported the page it shows, so that it can be asked to reload. */
  pageReported: boolean;
}

/**
 * What the Tablet shows (#661): the Skin served now, the page it reported
 * showing where it reports one, and the default Skin where a restart of
 * the Skin view would show another.
 */
export interface ShowingView {
  /** The Skin Decaid's Skin server serves now, with the version installed; null while it serves none. */
  skin: { id: string; name: string | null; version: string | null } | null;
  /** The page that Skin last reported, by the tablet's clock; null where it reported none. */
  page: { version: string | null; loadedAt: string; reportedAt: string } | null;
  /** Whether the version installed is another than the one its page reported, so that a reload is due. */
  newerInstalled: boolean;
  /** The default Skin where it is not the one served: it shows once the Skin view restarts. */
  nextDefault: { id: string; name: string | null } | null;
}

/** Decaid's own update state, as its `GET /update` answered. */
export interface DecaidUpdateView {
  /** `idle`, `checking`, `available`, `downloading`, `installing` or `error`, as Decaid names it. */
  phase: string | null;
  /** The newer release Decaid found, if any. */
  latestVersion: string | null;
  /** Whether Decaid can install it by itself, with someone at the Tablet confirming. */
  installable: boolean;
  error: string | null;
  /** When the Tablet reported this state. */
  reportedAt: string;
}

export interface TabletSoftwareView {
  decaid: {
    /** Its release, such as 0.9.3, and its build number, as its Tablet's `hello` gave them. */
    version: string | null;
    build: string | null;
    update: DecaidUpdateView | null;
    /** The Tablet's "Automatic update checks" setting; null until reported. */
    automaticUpdateCheck: boolean | null;
  };
  /** Null until the Tablet reports its plugins. */
  plugins: PluginView[] | null;
  /** Null until the Tablet reports its Skins. */
  skins: SkinView[] | null;
  /** Null until the Tablet reports its Skins. */
  showing: ShowingView | null;
  /**
   * Always false: every plugin the server accepts takes Software Actions.
   * Kept for the previous release's pages, which offer none while it is
   * true (ADR-0025).
   */
  pluginMustUpdate: boolean;
  /**
   * Whether the Tablet's plugin carries out a change of how a plugin or
   * Skin updates: false for one from before it (ADR-0035), which must
   * update first, and for a Machine whose plugin has not connected since
   * its revision was kept.
   */
  takesSourceChanges: boolean;
}

/**
 * Where an item is now, for pinning it there (ADR-0035): what an install
 * names to hold it at the build installed, found through GitHub.
 *
 * - a plugin following releases: its repository, with the commit its
 *   installed release's tag points at as the branch;
 * - a plugin following a branch: its repository, with the commit Decaid
 *   says it is at as the branch;
 * - a Skin following releases: the URL of its installed release's download,
 *   the one Decaid's install picks, which shows as Pinned at that tag: a
 *   release may be a built bundle, which its commit's archive is not;
 * - a Skin following a branch: the URL of the archive of the commit whose
 *   archive GitHub serves with the ETag Decaid recorded as it installed.
 *
 * `source` is null where nothing matches, as for an item already pinned,
 * one with no source on GitHub, or a build GitHub no longer has; and where
 * GitHub could not be asked, which `unavailable` then says.
 */
export interface PinnedSourceView {
  source: { repo: string; branch: string } | { url: string } | null;
  /** The release tag it would be pinned at, for one following releases. */
  tag: string | null;
  /** The commit it would be pinned at, where one is known. */
  commit: string | null;
  /** Why GitHub could not be asked, in words; null where it answered or was not needed. */
  unavailable: string | null;
  /** The item's source and build this was worked out from, as its view's `build` gives them: the page offers the pin only over the build it shows. */
  build: SourceSeen;
}

type Record_ = Record<string, unknown>;

/** How a plugin updates, from the `source` Decaid's plugin list holds for it. */
export function pluginUpdates(source: unknown): UpdatesView {
  if (!isRecord(source)) return { how: "notUpdated" };
  const repo = text(source.repo);
  if (source.kind === "github_release") return { how: "followsReleases", repo };
  if (source.kind === "github_branch") {
    const branch = text(source.branch);
    const commit = text(source.commit);
    // A branch whose name is a commit, in full or abbreviated, as an install of one records it.
    if (branch !== null && namesCommit(branch) && (commit === null || commit.toLowerCase().startsWith(branch.toLowerCase()))) return { how: "pinned", repo, commit: commit ?? branch, url: null };
    return { how: "followsBranch", repo, branch: branch ?? "main" };
  }
  return { how: "notUpdated" };
}

/** A commit in a URL's path: a segment of 40 hexadecimal digits, with or without an archive's extension. */
const COMMIT_IN_URL = /\/([0-9a-f]{40})(?:\.zip|\.tar\.gz)?(?:[/?#]|$)/i;

/** How a Skin updates, from its entry in Decaid's Skins list: `isBundled`, and its `reaMetadata.sourceUrl`. */
export function skinUpdates(skin: unknown): UpdatesView {
  if (!isRecord(skin)) return { how: "notUpdated" };
  const source = isRecord(skin.reaMetadata) ? text(skin.reaMetadata.sourceUrl) : null;
  const github = source?.match(/^github_(release|branch):([^@]+)@(.+)$/);
  if (skin.isBundled === true) return { how: "comesWithDecaid", repo: github?.[2] ?? null };
  if (source === null) return { how: "notUpdated" };
  if (github) return github[1] === "release" ? { how: "followsReleases", repo: github[2]! } : { how: "followsBranch", repo: github[2]!, branch: github[3]! };
  if (!/^https?:\/\//i.test(source)) return { how: "notUpdated" };
  // One release's download (#677): Decaid's check of the URL's ETag or Last-Modified never moves it.
  const asset = releaseAssetOf(source);
  if (asset) return { how: "pinned", repo: asset.repo, commit: null, tag: asset.tag, url: source };
  const commit = source.match(COMMIT_IN_URL)?.[1] ?? null;
  return commit === null ? { how: "followsUrl", url: source } : { how: "pinned", repo: null, commit, url: source };
}

/** A plugin's entry in the list, with its settings as declared and, to Admins, as held: `reported` is its entry in the `pluginSettings` collection, `{ declared, values }`. */
export function pluginView(plugin: Record_, reported: unknown, admin: boolean): PluginView | null {
  const id = text(plugin.id);
  if (id === null) return null;
  const source = isRecord(plugin.source) ? plugin.source : null;
  const pending = isRecord(plugin.pendingUpdate) ? plugin.pendingUpdate : null;
  const own = id === DECENT_SYNC_PLUGIN_ID;
  return {
    id,
    name: text(plugin.name),
    version: text(plugin.version),
    state: plugin.loaded === true ? "enabled" : plugin.autoLoad === false ? "disabled" : "notLoaded",
    updates: pluginUpdates(source),
    build: pluginSourceSeen(plugin),
    lastError: text(source?.lastError),
    pendingUpdate: pending && { version: text(pending.version), addedPermissions: strings(pending.addedPermissions) },
    permissions: strings(plugin.permissions),
    own,
    settings: settingViews(plugin.settings, own, admin && isRecord(reported) && isRecord(reported.values) ? reported.values : undefined, isRecord(reported) ? strings(reported.declared) : []),
  };
}

/**
 * The settings a plugin's manifest declares, each with what the Tablet
 * holds where that is given, in the manifest's order where the plugin
 * reported it (`order`): the plugin list is kept as JSON, whose keys
 * PostgreSQL does not keep in order.
 */
export function settingViews(declared: unknown, own: boolean, held?: Record_, order: readonly string[] = []): PluginSettingView[] {
  if (!isRecord(declared)) return [];
  const place = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  const entries = Object.entries(declared);
  // A stable sort: a setting the order does not name keeps its place after those it does.
  return entries.sort(([a], [b]) => place(a) - place(b)).flatMap(([name, value]): PluginSettingView[] => {
    if (!isRecord(value)) return [];
    const secret = value.secure === true;
    const choices = strings(value.values);
    const kind = value.type === "number" ? "number" : value.type === "boolean" ? "switch" : value.type === "enum" && choices.length > 0 ? "choice" : "text";
    const now = held === undefined ? undefined : secret ? (isSecretState(held[name]) ? held[name] : { isSet: false }) : (held[name] ?? null);
    return [
      {
        name,
        kind,
        label: text(value.label) ?? name,
        description: text(value.description),
        secret,
        choices,
        default: value.default ?? null,
        ...(now === undefined ? {} : { value: now }),
        // The plugin refuses any other of its own, whatever it is sent: its server address and Token.
        changeable: !own || name === "PollSeconds",
      },
    ];
  });
}

/** A Machine's Tablet Software from its Tablet's latest reports; `admin` says whether the plugins' settings are given with their values. */
export function tabletSoftwareView(
  reports: { plugins: Report | null; pluginSettings: Report | null; skins: Report | null; skinPage: Report | null; decaidUpdate: Report | null; appSettings: Report | null },
  machine: { decaidVersion: string | null; takesSourceChanges: boolean },
  admin: boolean,
): TabletSoftwareView {
  const plugins = latestValue(reports.plugins);
  const held = latestValue(reports.pluginSettings);
  const skins = latestValue(reports.skins);
  const page = latestValue(reports.skinPage);
  const skinList = skinViews(skins, page);
  const update = latestValue(reports.decaidUpdate);
  const settings = latestValue(reports.appSettings);
  const [version, build] = (machine.decaidVersion ?? "").split("+");
  return {
    decaid: {
      version: version || null,
      build: build || null,
      update:
        isRecord(update) && reports.decaidUpdate?.receivedAt
          ? {
              phase: text(update.phase),
              latestVersion: text(update.latestVersion),
              installable: update.installable === true,
              error: text(update.error),
              reportedAt: reports.decaidUpdate.receivedAt.toISOString(),
            }
          : null,
      automaticUpdateCheck: isRecord(settings) && typeof settings.automaticUpdateCheck === "boolean" ? settings.automaticUpdateCheck : null,
    },
    plugins: Array.isArray(plugins) ? plugins.filter(isRecord).flatMap((plugin) => pluginView(plugin, isRecord(held) ? held[String(plugin.id)] : undefined, admin) ?? []) : null,
    skins: skinList,
    showing: skinList === null ? null : showingView(skinList, page),
    pluginMustUpdate: false,
    takesSourceChanges: machine.takesSourceChanges,
  };
}

/**
 * The Skins as last reported: the default by its id, the served one by the
 * path Decaid's Skin server serves, and whether that one reported its page,
 * by the `skinPage` collection's value (`page`).
 */
export function skinViews(skins: unknown, page?: unknown): SkinView[] | null {
  if (!isRecord(skins) || !Array.isArray(skins.skins)) return null;
  const defaultId = isRecord(skins.default) ? text(skins.default.id) : null;
  const server = isRecord(skins.server) ? skins.server : null;
  const servedPath = server?.serving === true ? text(server.path) : null;
  const pageOf = isRecord(page) ? text(page.skinId) : null;
  return skins.skins.filter(isRecord).flatMap((skin): SkinView[] => {
    const id = text(skin.id);
    if (id === null) return [];
    const updates = skinUpdates(skin);
    const isDefault = id === defaultId;
    const served = servedPath !== null && skin.path === servedPath;
    return [{ id, name: text(skin.name), version: text(skin.version), default: isDefault, served, updates, build: skinSourceSeen(skin), removable: !isDefault && !served && updates.how !== "comesWithDecaid", pageReported: served && pageOf === id }];
  });
}

/** What the Tablet shows, from its Skins and the page last reported (`skinPage`). */
export function showingView(skins: readonly SkinView[], page: unknown): ShowingView {
  const served = skins.find((skin) => skin.served) ?? null;
  const shown = served?.pageReported && isRecord(page) ? page : null;
  const loadedAt = shown === null ? null : text(shown.loadedAt);
  const reportedAt = shown === null ? null : text(shown.reportedAt);
  const pageView = shown !== null && loadedAt !== null && reportedAt !== null ? { version: text(shown.version), loadedAt, reportedAt } : null;
  const nextDefault = skins.find((skin) => skin.default && !skin.served) ?? null;
  return {
    skin: served && { id: served.id, name: served.name, version: served.version },
    page: pageView,
    newerInstalled: pageView !== null && served !== null && pageView.version !== null && served.version !== null && pageView.version !== served.version,
    nextDefault: nextDefault && { id: nextDefault.id, name: nextDefault.name },
  };
}

/**
 * A source a Skin is installed from on other Machines, which the Skin
 * install form offers: a repository, with its branch for one that follows
 * one, or a URL, with the Skin's name and version there and how many
 * Machines use it. Skins that come with Decaid and ones with no recorded
 * source are left out.
 */
export interface SkinSourceView {
  skinId: string;
  name: string | null;
  /** The version installed from it, the highest reported where Machines differ. */
  version: string | null;
  /** The repository an install names, with its branch, null for the latest release; or the URL, with no repository. */
  repo: string | null;
  branch: string | null;
  url: string | null;
  updates: UpdatesView;
  machines: number;
}

/** The distinct sources of the Skins in several Machines' Skin reports, most used first. */
export function skinSources(reports: readonly unknown[]): SkinSourceView[] {
  const found = new Map<string, SkinSourceView>();
  for (const report of reports) {
    if (!isRecord(report) || !Array.isArray(report.skins)) continue;
    const seen = new Set<string>();
    for (const skin of report.skins.filter(isRecord)) {
      const id = text(skin.id);
      const updates = skinUpdates(skin);
      let source: { repo: string | null; branch: string | null; url: string | null } | null = null;
      if (updates.how === "followsReleases" && updates.repo !== null) source = { repo: updates.repo, branch: null, url: null };
      else if (updates.how === "followsBranch" && updates.repo !== null) source = { repo: updates.repo, branch: updates.branch, url: null };
      else if ((updates.how === "pinned" || updates.how === "followsUrl") && updates.url !== null) source = { repo: null, branch: null, url: updates.url };
      if (id === null || source === null) continue;
      const key = JSON.stringify([id, source.repo?.toLowerCase() ?? null, source.branch, source.url]);
      if (seen.has(key)) continue;
      seen.add(key);
      const version = text(skin.version);
      const earlier = found.get(key);
      if (earlier) {
        earlier.machines += 1;
        if (version !== null && (earlier.version === null || version.localeCompare(earlier.version, undefined, { numeric: true }) > 0)) earlier.version = version;
      } else found.set(key, { skinId: id, name: text(skin.name), version, ...source, updates, machines: 1 });
    }
  }
  return [...found.values()].sort((a, b) => b.machines - a.machines || (a.name ?? a.skinId).localeCompare(b.name ?? b.skinId));
}

/**
 * A source a plugin is installed from on other Machines, which the install
 * form offers: its repository, and its branch or commit for one not
 * following releases, with the plugin's name and version there and how many
 * Machines use it.
 */
export interface PluginSourceView {
  pluginId: string;
  name: string | null;
  /** The version installed from it, the highest reported where Machines differ. */
  version: string | null;
  repo: string;
  /** The branch or commit an install names; null for the latest release. */
  branch: string | null;
  updates: UpdatesView;
  machines: number;
}

/** The distinct sources of the plugins in several Machines' lists, most used first. */
export function pluginSources(lists: readonly unknown[]): PluginSourceView[] {
  const found = new Map<string, PluginSourceView>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    for (const plugin of list.filter(isRecord)) {
      const id = text(plugin.id);
      const updates = pluginUpdates(plugin.source);
      if (id === null || updates.how === "notUpdated" || updates.how === "followsUrl" || updates.how === "comesWithDecaid" || updates.repo === null) continue;
      const branch = updates.how === "followsBranch" ? updates.branch : updates.how === "pinned" ? updates.commit : null;
      const key = JSON.stringify([id, updates.repo.toLowerCase(), updates.how, branch]);
      if (seen.has(key)) continue;
      seen.add(key);
      const version = text(plugin.version);
      const earlier = found.get(key);
      if (earlier) {
        earlier.machines += 1;
        if (version !== null && (earlier.version === null || version.localeCompare(earlier.version, undefined, { numeric: true }) > 0)) earlier.version = version;
      } else found.set(key, { pluginId: id, name: text(plugin.name), version, repo: updates.repo, branch, updates, machines: 1 });
    }
  }
  return [...found.values()].sort((a, b) => b.machines - a.machines || (a.name ?? a.pluginId).localeCompare(b.name ?? b.pluginId));
}

/** The latest value its Tablet reported, kept while a later read was unavailable; undefined if it never reported one. */
function latestValue(report: Report | null): unknown {
  return report !== null && report.receivedAt !== null ? report.value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
