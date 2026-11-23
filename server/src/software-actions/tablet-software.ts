// A Machine's Tablet Software (ADR-0034, #657): Decaid, every plugin and
// every Skin on its Tablet, each with its version and how it updates, from
// the collections its Tablet reports. Decaid's payloads are opaque, so every
// field is optional here, and one of another type is left out. How an item
// updates is worked out from where Decaid says it was installed from, with
// no list of Decaid's ids.

import { DECENT_SYNC_PLUGIN_ID, isSecretState, namesCommit } from "@decent-sync/protocol";
import type { Report } from "../collections/paired-devices.js";

/**
 * How a plugin or Skin updates, which is shown and never switched: Decaid
 * has one setting for update checks, tablet-wide, and nothing per item.
 *
 * - `followsReleases`: from a GitHub repository's latest release, so the
 *   next check installs a newer one;
 * - `followsBranch`: from a branch, so the next check installs its head;
 * - `pinned`: from a commit, or a URL naming a commit's archive, which
 *   never moves;
 * - `followsUrl`: a Skin from any other URL, installed again once what the
 *   URL serves changes;
 * - `comesWithDecaid`: a Skin Decaid flags as built in, whose latest
 *   release Decaid may put back as it starts;
 * - `notUpdated`: no recorded source, or a zip or folder.
 */
export type UpdatesView =
  | { how: "followsReleases"; repo: string | null }
  | { how: "followsBranch"; repo: string | null; branch: string }
  | { how: "pinned"; repo: string | null; commit: string | null; url: string | null }
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
  /**
   * Whether the Tablet's plugin is from before Software Actions, so that
   * none is sent to it until it updates (ADR-0025).
   */
  pluginMustUpdate: boolean;
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
  const commit = source.match(COMMIT_IN_URL)?.[1] ?? null;
  return commit === null ? { how: "followsUrl", url: source } : { how: "pinned", repo: null, commit, url: source };
}

/** A plugin's entry in the list, with its settings as declared and, to Admins, as held. */
export function pluginView(plugin: Record_, held: unknown, admin: boolean): PluginView | null {
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
    lastError: text(source?.lastError),
    pendingUpdate: pending && { version: text(pending.version), addedPermissions: strings(pending.addedPermissions) },
    permissions: strings(plugin.permissions),
    own,
    settings: settingViews(plugin.settings, own, admin && isRecord(held) ? held : undefined),
  };
}

/** The settings a plugin's manifest declares, in its order, each with what the Tablet holds where that is given. */
export function settingViews(declared: unknown, own: boolean, held?: Record_): PluginSettingView[] {
  if (!isRecord(declared)) return [];
  return Object.entries(declared).flatMap(([name, value]): PluginSettingView[] => {
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
  reports: { plugins: Report | null; pluginSettings: Report | null; skins: Report | null; decaidUpdate: Report | null; appSettings: Report | null },
  machine: { decaidVersion: string | null; pluginMustUpdate: boolean },
  admin: boolean,
): TabletSoftwareView {
  const plugins = latestValue(reports.plugins);
  const held = latestValue(reports.pluginSettings);
  const skins = latestValue(reports.skins);
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
    skins: skinViews(skins),
    pluginMustUpdate: machine.pluginMustUpdate,
  };
}

/** The Skins as last reported: the default by its id, the served one by the path Decaid's Skin server serves. */
export function skinViews(skins: unknown): SkinView[] | null {
  if (!isRecord(skins) || !Array.isArray(skins.skins)) return null;
  const defaultId = isRecord(skins.default) ? text(skins.default.id) : null;
  const server = isRecord(skins.server) ? skins.server : null;
  const servedPath = server?.serving === true ? text(server.path) : null;
  return skins.skins.filter(isRecord).flatMap((skin): SkinView[] => {
    const id = text(skin.id);
    if (id === null) return [];
    return [{ id, name: text(skin.name), version: text(skin.version), default: id === defaultId, served: servedPath !== null && skin.path === servedPath, updates: skinUpdates(skin) }];
  });
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
