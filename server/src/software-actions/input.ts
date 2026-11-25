import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  MAX_PLUGIN_SETTINGS,
  MAX_PLUGIN_SETTING_LENGTH,
  MAX_SOFTWARE_NAME_LENGTH,
  SOFTWARE_ACTION_KINDS,
  type SoftwareActionKind,
  commitArchiveUrl,
  isPluginRepo,
  isSecretState,
  isSkinUrl,
  isSoftwareActionKind,
  namesCommit,
} from "@decent-sync/protocol";

// Request bodies for the Software Actions endpoints, checked by hand like the
// other endpoints: each problem gets a message the management interface can
// show, and none repeats a value, as a setting's may be a secret. What an
// action names is checked against what the Tablet reported by the service.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Software Action as asked for. */
export type NewSoftwareAction =
  | { kind: "installPlugin"; repo: string; branch: string | null }
  | { kind: "enablePlugin" | "disablePlugin" | "removePlugin"; pluginId: string }
  /** To a repository's latest release, a branch or a commit, over the plugin as the page showed it. */
  | { kind: "changePluginSource"; pluginId: string; seen: SeenItem; repo: string; branch: string | null }
  /** To a repository's latest release or a branch, or to a URL, over the Skin as the page showed it. */
  | { kind: "changeSkinSource"; skinId: string; seen: SeenItem; repo: string; branch: string | null }
  | { kind: "changeSkinSource"; skinId: string; seen: SeenItem; url: string }
  /** The update that waits, as the page showed it. */
  | { kind: "approvePluginUpdate"; pluginId: string; version: string; addedPermissions: string[] }
  /** Each setting's new value, and what the page showed for it: a value, null for one not set, or `{ isSet }` for a secret. */
  | { kind: "changePluginSettings"; pluginId: string; values: Record<string, unknown>; expected: Record<string, unknown> }
  /** From a repository's latest release or a branch, or from a URL. */
  | { kind: "installSkin"; repo: string; branch: string | null }
  | { kind: "installSkin"; url: string }
  | { kind: "chooseDefaultSkin" | "removeSkin"; skinId: string }
  | { kind: "reloadSkin" }
  | { kind: "checkPluginUpdates" | "checkSkinUpdates" | "restartSkinView" | "checkDecaidUpdate" | "startDecaidUpdate" };

/** A plugin or Skin as the page showed it when a change of how it updates was asked for: its version, and how it updates (`UpdatesView`). */
export interface SeenItem {
  version: string | null;
  updates: Record<string, unknown>;
}

function readSeen(value: unknown): SeenItem {
  const seen = isObject(value) ? value : {};
  const version = seen.version === undefined ? null : seen.version;
  if ((version !== null && (typeof version !== "string" || version.length > MAX_SOFTWARE_NAME_LENGTH)) || !isObject(seen.updates) || typeof seen.updates.how !== "string") {
    throw new BadRequestException(["Give the version and how it updates as shown, as seen"]);
  }
  return { version, updates: seen.updates };
}

/** The repository, and branch or commit, a plugin is installed from, with what is wrong with them. */
function readPluginSource(fields: Record<string, unknown>): { repo: string; branch: string | null; problems: string[] } {
  const repo = typeof fields.repo === "string" ? fields.repo.trim() : "";
  const branch = fields.branch === undefined || fields.branch === null ? null : typeof fields.branch === "string" ? fields.branch.trim() : "";
  const problems = [
    ...(isPluginRepo(repo) ? [] : ["Give the GitHub repository as owner/name, such as decentespresso/dye2"]),
    ...(branch === null || (branch !== "" && branch.length <= MAX_SOFTWARE_NAME_LENGTH && !/\s/.test(branch)) ? [] : ["Give a branch or commit, or leave it out for the latest release"]),
  ];
  return { repo, branch, problems };
}

/** The URL, or the repository and branch, a Skin is installed from: a URL and no repository, or a repository. Throws with what is wrong with them. */
function readSkinSource(fields: Record<string, unknown>): { repo: string; branch: string | null } | { url: string } {
  if (fields.url !== undefined && fields.url !== null) {
    const url = typeof fields.url === "string" ? fields.url.trim() : "";
    if (!isSkinUrl(url) || fields.repo !== undefined || fields.branch !== undefined) {
      throw new BadRequestException(["Give the URL of a zip to install the Skin from, such as https://github.com/owner/name/archive/<commit>.zip, and no repository"]);
    }
    return { url };
  }
  const repo = typeof fields.repo === "string" ? fields.repo.trim() : "";
  const branch = fields.branch === undefined || fields.branch === null ? null : typeof fields.branch === "string" ? fields.branch.trim() : "";
  const problems = [
    ...(isPluginRepo(repo) ? [] : ["Give the GitHub repository as owner/name, such as decentespresso/streamline-js, or a URL"]),
    ...(branch === null || (branch !== "" && branch.length <= MAX_SOFTWARE_NAME_LENGTH && !/\s/.test(branch)) ? [] : ["Give a branch, or leave it out for the latest release"]),
    // Decaid fails to install a Skin from a commit named as its branch (#659): its archive's URL pins it.
    ...(branch !== null && namesCommit(branch) && isPluginRepo(repo) ? [`Decaid installs a Skin from a commit only by its archive's URL: ${commitArchiveUrl(repo, branch)}`] : []),
  ];
  if (problems.length > 0) throw new BadRequestException(problems);
  return { repo, branch };
}

export function readSoftwareAction(body: unknown): NewSoftwareAction {
  const fields = isObject(body) ? body : {};
  const kind = fields.kind;
  if (!isSoftwareActionKind(kind)) throw new BadRequestException([`Say what to do: one of ${SOFTWARE_ACTION_KINDS.join(", ")}`]);
  switch (kind) {
    case "installPlugin": {
      const { repo, branch, problems } = readPluginSource(fields);
      if (problems.length > 0) throw new BadRequestException(problems);
      return { kind, repo, branch };
    }
    case "changePluginSource": {
      const pluginId = readPluginId(fields.pluginId);
      const seen = readSeen(fields.seen);
      const { repo, branch, problems } = readPluginSource(fields);
      if (problems.length > 0) throw new BadRequestException(problems);
      return { kind, pluginId, seen, repo, branch };
    }
    case "changeSkinSource":
      return { kind, skinId: readSkinId(fields.skinId), seen: readSeen(fields.seen), ...readSkinSource(fields) };
    case "enablePlugin":
    case "disablePlugin":
    case "removePlugin":
      return { kind, pluginId: readPluginId(fields.pluginId) };
    case "approvePluginUpdate": {
      const pluginId = readPluginId(fields.pluginId);
      const permissions = fields.addedPermissions;
      const named = Array.isArray(permissions) && permissions.length <= MAX_PLUGIN_SETTINGS && permissions.every((permission) => typeof permission === "string" && permission.length <= MAX_SOFTWARE_NAME_LENGTH);
      if (typeof fields.version !== "string" || fields.version.length > MAX_SOFTWARE_NAME_LENGTH || !named) {
        throw new BadRequestException(["Give the version of the update shown, and the permissions it adds"]);
      }
      return { kind, pluginId, version: fields.version, addedPermissions: permissions as string[] };
    }
    case "changePluginSettings": {
      const pluginId = readPluginId(fields.pluginId);
      if (!isObject(fields.values) || !isObject(fields.expected)) throw new BadRequestException(["Give the settings' new values, and each one's value as shown, as objects"]);
      const values = fields.values;
      const expected = fields.expected;
      const names = Object.keys(values);
      const problems: string[] = [];
      if (names.length === 0) problems.push("Change at least one setting");
      if (names.length > MAX_PLUGIN_SETTINGS) problems.push(`Change at most ${MAX_PLUGIN_SETTINGS} settings at once`);
      const missing = names.filter((name) => !Object.hasOwn(expected, name));
      const extra = Object.keys(expected).filter((name) => !Object.hasOwn(values, name));
      if (missing.length > 0) problems.push(`Give the value shown of ${missing.join(", ")}`);
      if (extra.length > 0) problems.push(`Give the value shown only of the settings changed, not of ${extra.join(", ")}`);
      const shapeless = (value: unknown) => !(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= MAX_PLUGIN_SETTING_LENGTH));
      const badValues = names.filter((name) => shapeless(values[name]));
      const badExpected = Object.keys(expected).filter((name) => shapeless(expected[name]) && !isSecretState(expected[name]));
      if (badValues.length > 0) problems.push(`Give text, a number, on or off, or nothing for ${badValues.join(", ")}`);
      if (badExpected.length > 0) problems.push(`Give the value shown of ${badExpected.join(", ")} as the Tablet reported it`);
      if (problems.length > 0) throw new BadRequestException(problems);
      return { kind, pluginId, values, expected };
    }
    case "installSkin":
      return { kind, ...readSkinSource(fields) };
    case "chooseDefaultSkin":
    case "removeSkin":
      return { kind, skinId: readSkinId(fields.skinId) };
    case "reloadSkin":
      return { kind };
    default:
      return { kind: kind as Extract<SoftwareActionKind, "checkPluginUpdates" | "checkSkinUpdates" | "restartSkinView" | "checkDecaidUpdate" | "startDecaidUpdate"> };
  }
}

/** Which item a read of where it can be pinned names: a plugin or a Skin, by its id, and never both. */
export function readPinnedItem(pluginId: unknown, skinId: unknown): { pluginId: string } | { skinId: string } {
  if ((pluginId === undefined) === (skinId === undefined)) throw new BadRequestException(["Name a plugin by pluginId, or a Skin by skinId"]);
  return pluginId === undefined ? { skinId: readSkinId(skinId) } : { pluginId: readPluginId(pluginId) };
}

function readSkinId(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > MAX_SOFTWARE_NAME_LENGTH) throw new BadRequestException(["Name the Skin by its id"]);
  return value;
}

function readPluginId(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.length > MAX_SOFTWARE_NAME_LENGTH) throw new BadRequestException(["Name the plugin by its id"]);
  return value;
}

export function readSoftwareActionId(value: string): string {
  if (!UUID.test(value)) throw softwareActionNotFound();
  return value.toLowerCase();
}

export function softwareActionNotFound(): NotFoundException {
  return new NotFoundException("No such Software Action");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
