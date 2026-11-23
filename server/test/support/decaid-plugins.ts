import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// How Decaid v0.9.3 manages its plugins, for the simulated tablet: its
// install, enable, disable, settings, update, approve and remove routes
// (`PluginsHandler` in decaid:lib/src/services/webserver/plugins_handler.dart),
// what `host.localApi` reaches and how it refuses the rest
// (`PluginLocalApiBridge`), and its own update state and socket
// (`update_handler.dart`). Every answer, error and entry here is shaped by
// what Decaid's Linux release answered, recorded in
// fixtures/decaid/tablet-software-v0.9.3/ (its README): an id or a version
// is put in the place the recording holds one, and nothing else is written
// by hand. What a test offers for install (`offer`) stands for a GitHub
// repository, which the simulated tablet has no network for.

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid/tablet-software-v0.9.3");

type Json = Record<string, unknown>;
interface Exchange {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; body: unknown };
}
interface Read {
  status: number;
  body?: unknown;
  unchanged?: true;
}
interface Step {
  exchanges?: Exchange[];
  reads: Record<string, Read>;
  localApi?: unknown;
  opened?: Json[];
  frames?: Json[];
}

function recording(file: string): Record<string, Step> {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8"));
}

const MANAGEMENT = recording("plugin-management.json");
const PENDING = recording("pending-update.json");
const PROTECTED = recording("protected.json");

/** Decaid's answer to the nth request of a recorded step. */
function recorded(step: Step | undefined, index: number): { status: number; body: unknown } {
  const exchange = step?.exchanges?.[index];
  if (!exchange) throw new Error("The recording holds no such exchange");
  return exchange.response;
}

/** A recorded read of a route as it stood after a step: the last one at or before it that was not kept as unchanged. */
function readAt(recordingOf: Record<string, Step>, step: string, route: string): unknown {
  let body: unknown;
  for (const [name, { reads }] of Object.entries(recordingOf)) {
    const read = reads[route];
    if (read && !read.unchanged) body = read.body;
    if (name === step) return structuredClone(body);
  }
  throw new Error(`No step ${step} was recorded`);
}

/** Decaid's own update state as a new v0.9.3 answers `GET /update`: idle, offering nothing. */
export function decaidUpdateState(): Json {
  return readAt(MANAGEMENT, "started", "/update") as Json;
}

/** `GET /info` as Decaid v0.9.3's release answers it. */
export function decaidInfo093(): Json {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, "info.json"), "utf8"));
}

/** The Skins routes as a new Decaid v0.9.3 answered them, once it had installed the Skins it comes with: every one flagged built in, Streamline the default and served. */
export function skinsOn093(): Record<string, unknown> {
  return Object.fromEntries(["/webui/skins", "/webui/skins/default", "/webui/server/status"].map((route) => [route, readAt(MANAGEMENT, "started", route)]));
}

/** A plugin as Decaid's list holds it: its manifest, with whether it is loaded, where it came from and any update that waits. */
export type ListedPlugin = Json & { id: string; version: string; permissions: string[]; settings: Json; loaded: boolean; autoLoad: boolean; source: Json | null; pendingUpdate: Json | null };

/**
 * The plugins a new Decaid v0.9.3 lists, as recorded, but DYE2, which the
 * simulated tablet lists from its simulated DYE2 where one is attached:
 * the Visualizer upload among them, which declares a secret setting, and
 * the others it bundles.
 */
export function bundledPlugins(): ListedPlugin[] {
  return (readAt(MANAGEMENT, "started", "/plugins") as ListedPlugin[]).filter((plugin) => plugin.id !== "dye2.reaplugin");
}

/** A plugin's entry as recorded after a step of `plugin-management.json` or `pending-update.json`, for a test to offer or start from. */
export function recordedPlugin(id: string, step = "started", file: "management" | "pending" = "management"): ListedPlugin {
  const plugin = (readAt(file === "pending" ? PENDING : MANAGEMENT, step, "/plugins") as ListedPlugin[]).find((entry) => entry.id === id);
  if (!plugin) throw new Error(`No plugin ${id} was recorded at ${step}`);
  return plugin;
}

/** What a repository holds for an install: its latest release, and the heads of its branches and its commits, each a manifest. */
interface Offered {
  release?: { tag: string; manifest: Json };
  branches: Map<string, { commit: string; manifest: Json }>;
}

/** The plugin the simulated tablet runs, as its Decaid holds it. */
export interface OwnPlugin {
  id: string;
  /** Its manifest as loaded now. */
  manifest(): Json;
  loaded(): boolean;
  /** Its settings as Decaid holds them, the secret ones with their values. */
  settings(): Json;
  /** Decaid saved its settings and loads it again with them. */
  saved(settings: Json): void;
  /** Decaid installed another build of it and loads it again: its listed version from now on. */
  installed(version: string): void;
  /** Decaid disabled or removed it. */
  unloaded(): void;
}

export interface PluginAnswer {
  status: number;
  /** The body as JSON, or as text for shelf's plain errors. */
  body: unknown;
  text?: string;
}

/**
 * The plugins on a simulated tablet's Decaid, and what manages them. Kept
 * across loads of the tablet's own plugin, as Decaid's are.
 */
export class SimulatedPlugins {
  /** The plugins besides the tablet's own and DYE2, in the order Decaid lists them. */
  private plugins: ListedPlugin[];
  /** Each plugin's settings as saved, by its id, secrets with their values: never served. */
  private readonly saved = new Map<string, Json>();
  private readonly offers = new Map<string, Offered>();
  /** What an update check fails a plugin with, by its id. */
  private readonly updateFailures = new Map<string, string>();
  /** The tablet's own plugin's `source` and `pendingUpdate`, as Decaid lists them. */
  ownSource: Json | null = null;
  ownPendingUpdate: Json | null = null;
  /** Its listed version, where Decaid installed another build than the one loaded first. */
  ownVersion: string | undefined;
  /**
   * Whether the Tablet's "Require authorization for extension management"
   * setting is on: Decaid then refuses each managing request made without a
   * token, as the plugin's `fetch` makes it, and takes it through
   * `host.localApi`. Off on a new v0.9.3, and after an update from v0.9.2.
   */
  requireAuthorization: boolean;
  /** Every managing request Decaid took or refused, as `METHOD route`, with how it came. */
  readonly managed: { request: string; via: "fetch" | "localApi"; status: number }[] = [];
  /**
   * Whether an update check reaches the tablet's own plugin before the
   * others, as Decaid checks plugins in the order it loaded them: one
   * installed after the plugin comes after it. Last otherwise.
   */
  ownCheckedFirst = false;
  /** How long an update check takes over each plugin, as a release's fetch takes: none by default. */
  checkStepMs = 0;
  /** How long an install, or an approved update's, takes before Decaid has it: none by default. */
  installMs = 0;
  /**
   * How long after it loads the tablet's own plugin again, having installed
   * another build of it, Decaid writes where it came from and clears its
   * waiting update, as it does once the plugin's notification permission is
   * settled (`PluginSourceService._install`): at once by default.
   */
  ownSourceAfterLoadMs = 0;
  /** How long `host.localApi` waits on Decaid before rejecting a call, which goes on all the same (`PluginManager.localApiTimeout`). */
  localApiTimeoutMs = 60_000;
  /** The update check under way, which a request for one while it runs is answered with, as Decaid's `checkForPluginUpdates` is. */
  private checking: Promise<PluginAnswer> | undefined;
  /** Decaid's own update state (`GET /update`), and what a check finds. */
  update: Json = decaidUpdateState();
  private found: Json | undefined;
  private noCheck: Json | undefined;

  constructor(options: { plugins?: ListedPlugin[]; requireAuthorization?: boolean } = {}) {
    this.plugins = structuredClone(options.plugins ?? []);
    this.requireAuthorization = options.requireAuthorization ?? false;
  }

  /** The plugins besides the tablet's own and DYE2, as `GET /plugins` lists them. */
  listed(): ListedPlugin[] {
    return structuredClone(this.plugins);
  }

  /** Has a repository hold a plugin for install, as its latest release (`tag`), a branch's head or a commit (`branch`, with its `commit`). */
  offer(repo: string, build: { manifest: Json; tag?: string; branch?: string; commit?: string }): void {
    const offered: Offered = this.offers.get(repo.toLowerCase()) ?? { branches: new Map() };
    if (build.branch !== undefined) offered.branches.set(build.branch, { commit: build.commit ?? "0".repeat(40), manifest: build.manifest });
    else offered.release = { tag: build.tag ?? `v${String(build.manifest.version)}`, manifest: build.manifest };
    this.offers.set(repo.toLowerCase(), offered);
  }

  /** Has the next update checks fail for a plugin with Decaid's words, or no longer (`null`). */
  failUpdatesOf(id: string, error: string | null): void {
    if (error === null) this.updateFailures.delete(id);
    else this.updateFailures.set(id, error);
  }

  /**
   * What a check for Decaid's own update finds from now on: a newer release
   * (`latestVersion`), or with null, none. The state it then answers is the
   * recorded one with its phase `available` and that version, which no
   * recording holds, as no release newer than v0.9.3 existed: derived.
   */
  offerDecaid(latestVersion: string | null): void {
    this.found = latestVersion === null ? undefined : { ...decaidUpdateState(), phase: "available", latestVersion, installable: true };
  }

  /** Has Decaid answer the command to check as it does where it can't check, with the frame recorded for a command it would not carry out. */
  refuseDecaidCheck(refuse: boolean): void {
    this.noCheck = refuse ? structuredClone(MANAGEMENT.updateInstall!.frames![0]!) : undefined;
  }

  /** The frames Decaid's update socket sends as it opens: its state now. */
  socketOpened(): Json[] {
    return [structuredClone(this.update)];
  }

  /** The frames it sends for a command, as recorded for `check`: `checking`, then what it found; one frame saying why for a command it can't carry out. */
  socketCommand(text: string): Json[] {
    let command: unknown;
    try {
      command = (JSON.parse(text) as Json).command;
    } catch {
      return [];
    }
    if (command !== "check" || this.noCheck) return [structuredClone(this.noCheck ?? MANAGEMENT.updateInstall!.frames![0]!)];
    const [checking] = MANAGEMENT.updateChecked!.frames!;
    this.update = structuredClone(this.found ?? decaidUpdateState());
    return [{ ...structuredClone(this.update), phase: checking!.phase, latestVersion: null, installable: false }, structuredClone(this.update)];
  }

  /**
   * Whether `host.localApi` reaches a request, by Decaid's allowlist
   * (`extension_management_auth.dart`): null where it does, or the message
   * it rejects with, as recorded.
   */
  localApiRefusal(method: string, fullPath: string, body: unknown): string | null {
    const out = MANAGEMENT.outOfReach!.localApi as { call: { path: string; options?: { method?: string; body?: unknown } }; rejected: { message: string } }[];
    const messageFor = (matches: (call: { path: string; options?: { method?: string; body?: unknown } }) => boolean) => out.find((entry) => matches(entry.call))!.rejected.message;
    if (!fullPath.startsWith("/api/v1/")) return messageFor((call) => call.path === "/plugins");
    if (!["GET", "POST", "PUT", "DELETE"].includes(method)) return messageFor((call) => call.options?.method === "PATCH").replace("PATCH", method);
    const route = fullPath.slice("/api/v1".length).split("?")[0]!;
    if (method === "POST" && route === "/settings") {
      const keys = isObject(body) ? Object.keys(body) : null;
      if (keys === null || keys.length === 0 || keys.some((key) => key !== "defaultSkinId" && key !== "automaticUpdateCheck")) return messageFor((call) => call.path === "/api/v1/settings" && call.options?.method === "POST");
      return null;
    }
    const reaches =
      (method === "GET" && (route === "/plugins" || /^\/plugins\/[^/]+\/settings$/.test(route) || route === "/webui/skins" || route === "/webui/server/status" || /^\/webui\/skins\/[^/]+$/.test(route))) ||
      this.manages(method, route) ||
      (method !== "GET" && route.startsWith("/webui/"));
    return reaches ? null : messageFor((call) => call.path === "/api/v1/machine/state").replace("GET /api/v1/machine/state", `${method} ${fullPath.split("?")[0]}`);
  }

  /** The headers `host.localApi` resolves with, as recorded, for a body. */
  localApiHeaders(body: string): Record<string, string> {
    const [read] = MANAGEMENT.reads!.localApi as { resolved: { headers: Record<string, string> } }[];
    return { ...read!.resolved.headers, "content-length": String(Buffer.byteLength(body)) };
  }

  /** What `host.localApi` rejects with for a plugin without `manage.extensions`, as recorded for a plugin of that id. */
  permissionError(pluginId: string): Error {
    const [refused] = MANAGEMENT.withoutPermission!.localApi as { rejected: { name: string; message: string } }[];
    const error = new Error(refused!.rejected.message.replace("localapi-probe.reaplugin", pluginId));
    error.name = refused!.rejected.name;
    return error;
  }

  /** Whether a request is one of the plugin routes that manage: those Decaid asks a token for while its setting is on. */
  manages(method: string, route: string): boolean {
    if (method === "POST" && ["/plugins/install/github-release", "/plugins/install/github-branch", "/plugins/update"].includes(route)) return true;
    if (method === "POST" && /^\/plugins\/[^/]+\/(enable|disable|settings|update\/approve)$/.test(route)) return true;
    return method === "DELETE" && /^\/plugins\/[^/]+$/.test(route);
  }

  /**
   * Decaid's answer to a request to its plugin routes, or undefined for any
   * other: the settings reads, and each managing request, refused without a
   * token while the Tablet asks one of a plain request.
   */
  answer(method: string, route: string, body: unknown, via: "fetch" | "localApi", own: OwnPlugin, others: ListedPlugin[] = []): PluginAnswer | Promise<PluginAnswer> | undefined {
    const settings = /^\/plugins\/([^/]+)\/settings$/.exec(route);
    if (method === "GET" && settings) return { status: 200, body: this.settingsOf(decodeURIComponent(settings[1]!), own) };
    if (!this.manages(method, route)) return undefined;
    const record = (taken: PluginAnswer): PluginAnswer => {
      this.managed.push({ request: `${method} ${route}`, via, status: taken.status });
      return taken;
    };
    if (this.requireAuthorization && via === "fetch") return record(this.unauthorized());
    if (route === "/plugins/update") return this.checkUpdates(own).then(record);
    const installs = route.startsWith("/plugins/install/") || route.endsWith("/update/approve");
    if (installs && this.installMs > 0) return new Promise<void>((resolve) => setTimeout(resolve, this.installMs)).then(() => record(this.manage(method, route, body, own, others)));
    return record(this.manage(method, route, body, own, others));
  }

  /** Decaid's 401 for a managing request without a token, as recorded with its setting on. */
  unauthorized(): PluginAnswer {
    return structuredClone(recorded(PROTECTED.withoutToken, 2));
  }

  private manage(method: string, route: string, body: unknown, own: OwnPlugin, others: ListedPlugin[]): PluginAnswer {
    if (route === "/plugins/install/github-release" || route === "/plugins/install/github-branch") return this.install(route.endsWith("branch"), body, own);
    const [, , encoded, action, approve] = route.split("/");
    const id = decodeURIComponent(encoded!);
    const isOwn = id === own.id;
    const plugin = this.plugins.find((entry) => entry.id === id);
    const elsewhere = others.some((entry) => entry.id === id);
    // A plugin's settings saved for a plugin Decaid does not know fail in its handler, uncaught: shelf's plain 500.
    if (action === "settings" && !plugin && !isOwn) return { ...recorded(MANAGEMENT.settingsRefused, 3), text: String(recorded(MANAGEMENT.settingsRefused, 3).body) };
    if (!plugin && !isOwn) {
      if (elsewhere) throw new Error(`The simulated tablet manages no ${id}: it is simulated apart`);
      return named(recorded(MANAGEMENT.unknownRefused, 0), "no-such.reaplugin", id);
    }
    if (method === "DELETE") {
      if (isOwn) own.unloaded();
      this.plugins = this.plugins.filter((entry) => entry.id !== id);
      this.saved.delete(id);
      return named(recorded(MANAGEMENT.removed, 0), "dcamp.reaplugin", id);
    }
    switch (action) {
      case "enable":
        if (plugin) Object.assign(plugin, { loaded: true, autoLoad: true });
        return named(recorded(MANAGEMENT.enabled, 0), "decent-sync.reaplugin", id);
      case "disable":
        if (plugin) Object.assign(plugin, { loaded: false, autoLoad: false });
        else own.unloaded();
        return named(recorded(MANAGEMENT.disabled, 0), "decent-sync.reaplugin", id);
      case "settings":
        return this.saveSettings(id, isOwn ? own.manifest() : plugin!, body, own);
      default: {
        if (approve !== "approve") throw new Error(`The simulated tablet's API carries out no ${method} ${route}`);
        const waiting = isOwn ? this.ownPendingUpdate : plugin!.pendingUpdate;
        if (waiting === null) return named(recorded(MANAGEMENT.unknownRefused, 4), "dye2.reaplugin", id);
        const source = (isOwn ? this.ownSource : plugin!.source) as Json;
        const offered = this.offered(source);
        if (!offered) throw new Error(`Nothing is offered for ${id} to install its waiting update from`);
        const version = String(offered.manifest.version);
        if (plugin) Object.assign(plugin, withManifest(plugin, offered.manifest), { pendingUpdate: null, source: { ...source, ...(offered.tag === undefined ? {} : { releaseTag: offered.tag }) } });
        const answer = structuredClone(recorded(PENDING.approved, 0));
        Object.assign(answer.body as Json, { id, version, loaded: isOwn ? own.loaded() : plugin!.loaded });
        if (isOwn) this.ownInstalled(own, version, { ...source, ...(offered.tag === undefined ? {} : { releaseTag: offered.tag }) });
        return answer;
      }
    }
  }

  /** Decaid installed another build of the tablet's own plugin and loads it again, writing where it came from at once or after `ownSourceAfterLoadMs`. */
  private ownInstalled(own: OwnPlugin, version: string, source: Json): void {
    const written = (): void => {
      this.ownSource = source;
      this.ownPendingUpdate = null;
    };
    if (this.ownSourceAfterLoadMs > 0) setTimeout(written, this.ownSourceAfterLoadMs);
    else written();
    own.installed(version);
  }

  /** What a source's repository offers now: its latest release, or its branch's head. */
  private offered(source: Json | null): { manifest: Json; tag?: string; commit?: string } | undefined {
    const repo = typeof source?.repo === "string" ? this.offers.get(source.repo.toLowerCase()) : undefined;
    if (!repo) return undefined;
    if (source!.kind === "github_release") return repo.release && { manifest: repo.release.manifest, tag: repo.release.tag };
    const branch = repo.branches.get(String(source!.branch));
    return branch && { manifest: branch.manifest, commit: branch.commit };
  }

  private install(branchInstall: boolean, body: unknown, own: OwnPlugin): PluginAnswer {
    const given = parsedBody(body);
    const repo = isObject(given) && typeof given.repo === "string" ? given.repo : "";
    if (repo === "") return structuredClone(recorded(MANAGEMENT.installsRefused, 0));
    const offered = this.offers.get(repo.toLowerCase());
    const branch = isObject(given) && typeof given.branch === "string" ? given.branch : "main";
    const build = branchInstall ? offered?.branches.get(branch) : offered?.release;
    // No such repository or release, and no such branch, each as recorded.
    if (!build) return structuredClone(recorded(MANAGEMENT.installsRefused, branchInstall && offered ? 2 : 1));
    const id = String(build.manifest.id);
    const version = String(build.manifest.version);
    const installed = recordedPlugin("decent-sync.reaplugin", branchInstall ? "releaseInstalled" : "releaseInstalled").source as Json;
    const now = new Date().toISOString().replace("Z", "");
    const source: Json = branchInstall
      ? { ...(recordedPlugin("dye2.reaplugin", "branchInstalled").source as Json), repo, branch, commit: (build as { commit: string }).commit, installedAt: now, lastChecked: now }
      : { ...installed, repo, releaseTag: (build as { tag: string }).tag, installedAt: now, lastChecked: now };
    const answer = structuredClone(recorded(MANAGEMENT.releaseInstalled, 0));
    if (id === own.id) {
      Object.assign(answer.body as Json, { id, version, loaded: own.loaded() });
      this.ownInstalled(own, version, source);
      return answer;
    }
    const existing = this.plugins.find((entry) => entry.id === id);
    // A plugin newly installed is not enabled; one installed over keeps whether it was.
    const entry = { ...withManifest(existing ?? ({ loaded: false, autoLoad: false } as ListedPlugin), build.manifest), source, pendingUpdate: null } as ListedPlugin;
    if (existing) Object.assign(existing, entry);
    else this.plugins.push(entry);
    Object.assign(answer.body as Json, { id, version, loaded: entry.loaded });
    return answer;
  }

  /** Decaid's answer to a request for an update check: the results of the one under way, or of a new one. */
  private checkUpdates(own: OwnPlugin): Promise<PluginAnswer> {
    this.checking ??= this.runUpdateCheck(own).finally(() => (this.checking = undefined));
    return this.checking.then((answer) => structuredClone(answer));
  }

  /**
   * Decaid's check of every plugin it updates, those from a release or a
   * branch, one at a time: each installed where newer, unless it adds a
   * permission, which waits. Installing the tablet's own has Decaid load it
   * again there and then, and the check goes on to the rest.
   */
  private async runUpdateCheck(own: OwnPlugin): Promise<PluginAnswer> {
    const answer = structuredClone(recorded(MANAGEMENT.checked, 0));
    const results: Json[] = [];
    const now = new Date().toISOString().replace("Z", "");
    const check = (id: string, entry: { version: string; permissions: string[]; source: Json | null; pendingUpdate: Json | null }, apply: (manifest: Json, source: Json) => void, wait: (pending: Json) => void): void => {
      const source = entry.source;
      if (source?.kind !== "github_release" && source?.kind !== "github_branch") return;
      const failure = this.updateFailures.get(id);
      if (failure !== undefined) {
        Object.assign(source, { lastChecked: now, lastError: failure });
        results.push({ item: id, status: "failed", error: failure });
        return;
      }
      Object.assign(source, { lastChecked: now, lastError: null });
      const offered = this.offered(source);
      const current = !offered || (source.kind === "github_release" ? offered.tag === source.releaseTag : offered.commit === source.commit);
      if (current) {
        // An update that waits is answered so at every check, as recorded.
        results.push({ item: id, status: entry.pendingUpdate ? "pendingApproval" : "alreadyCurrent" });
        return;
      }
      const added = (offered.manifest.permissions as string[]).filter((permission) => !entry.permissions.includes(permission)).sort();
      if (added.length > 0) {
        const recordedPending = recordedPlugin("decent-sync.reaplugin", "checked", "pending").pendingUpdate as Json;
        wait({ ...recordedPending, version: String(offered.manifest.version), releaseTag: offered.tag ?? null, commit: offered.commit ?? null, addedPermissions: added, detectedAt: now });
        results.push({ item: id, status: "pendingApproval" });
        return;
      }
      apply(offered.manifest, { ...source, ...(offered.tag === undefined ? {} : { releaseTag: offered.tag }), ...(offered.commit === undefined ? {} : { commit: offered.commit }) });
      results.push({ item: id, status: "updated" });
    };
    const others = this.plugins.map((plugin) => () =>
      check(
        plugin.id,
        plugin,
        (manifest, source) => Object.assign(plugin, withManifest(plugin, manifest), { source, pendingUpdate: null }),
        (pending) => (plugin.pendingUpdate = pending),
      ),
    );
    const itself = (): void => {
      const ownManifest = own.manifest();
      check(
        own.id,
        { version: this.ownVersion ?? String(ownManifest.version), permissions: ownManifest.permissions as string[], source: this.ownSource, pendingUpdate: this.ownPendingUpdate },
        (manifest, source) => this.ownInstalled(own, String(manifest.version), source),
        (pending) => (this.ownPendingUpdate = pending),
      );
    };
    for (const step of this.ownCheckedFirst ? [itself, ...others] : [...others, itself]) {
      if (this.checkStepMs > 0) await new Promise((resolve) => setTimeout(resolve, this.checkStepMs));
      step();
    }
    (answer.body as Json).results = results;
    return answer;
  }

  /** A plugin's settings as `GET /plugins/{id}/settings` answers: those saved, a secret one only as whether it is set; `{}` for a plugin Decaid does not know. */
  private settingsOf(id: string, own: OwnPlugin): Json {
    const manifest = id === own.id ? own.manifest() : this.plugins.find((entry) => entry.id === id);
    if (!manifest) return {};
    const saved = id === own.id ? own.settings() : (this.saved.get(id) ?? {});
    const declared = isObject(manifest.settings) ? manifest.settings : {};
    const shown: Json = {};
    for (const [name, value] of Object.entries(saved)) if (!isSecure(declared[name])) shown[name] = value;
    for (const [name, setting] of Object.entries(declared)) if (isSecure(setting)) shown[name] = { isSet: typeof saved[name] === "string" && saved[name] !== "" };
    return shown;
  }

  /**
   * Saves some of a plugin's settings as Decaid does: a name its manifest
   * does not declare refuses the whole body, 400; null clears one; a value
   * given as a secret's state is skipped; a number given as anything else is
   * put back to its default, as recorded. Answers the settings as a read
   * does, and has the plugin loaded again where it is loaded.
   */
  private saveSettings(id: string, manifest: Json, body: unknown, own: OwnPlugin): PluginAnswer {
    const given = parsedBody(body);
    if (!isObject(given)) throw new Error("The simulated tablet was sent settings that are no JSON object, which no recording answers");
    const declared = isObject(manifest.settings) ? manifest.settings : {};
    const unknown = Object.keys(given).find((name) => !(name in declared));
    if (unknown !== undefined) return named(recorded(MANAGEMENT.settingsRefused, 0), "NoSuchSetting", unknown);
    const saved: Json = { ...(id === own.id ? own.settings() : (this.saved.get(id) ?? {})) };
    for (const [name, value] of Object.entries(given)) {
      const setting = declared[name] as Json;
      if (isObject(value) && typeof value.isSet === "boolean") continue;
      if (value === null) delete saved[name];
      else if (setting.type === "number" && typeof value !== "number") {
        if ("default" in setting) saved[name] = setting.default;
        else delete saved[name];
      } else saved[name] = value;
    }
    if (id === own.id) own.saved(saved);
    else this.saved.set(id, saved);
    return { status: 200, body: id === own.id ? this.settingsOfSaved(manifest, saved) : this.settingsOf(id, own) };
  }

  private settingsOfSaved(manifest: Json, saved: Json): Json {
    const declared = isObject(manifest.settings) ? manifest.settings : {};
    const shown: Json = {};
    for (const [name, value] of Object.entries(saved)) if (!isSecure(declared[name])) shown[name] = value;
    for (const [name, setting] of Object.entries(declared)) if (isSecure(setting)) shown[name] = { isSet: typeof saved[name] === "string" && saved[name] !== "" };
    return shown;
  }
}

/** A recorded answer with the id, or name, it was recorded for replaced by the one asked for. */
function named(answer: { status: number; body: unknown }, was: string, now: string): PluginAnswer {
  return { status: answer.status, body: JSON.parse(JSON.stringify(answer.body).replaceAll(JSON.stringify(was).slice(1, -1), JSON.stringify(now).slice(1, -1))) };
}

/** A list entry holding another build's manifest: its fields in place of the entry's, the entry's state kept. */
function withManifest(entry: ListedPlugin, manifest: Json): ListedPlugin {
  const { loaded, autoLoad, source, pendingUpdate } = entry;
  const { api: _api, description: _description, ...declared } = manifest;
  return { ...(declared as ListedPlugin), loaded, autoLoad, source: source ?? null, pendingUpdate: pendingUpdate ?? null };
}

function isSecure(setting: unknown): boolean {
  return isObject(setting) && setting.secure === true;
}

function parsedBody(body: unknown): unknown {
  if (typeof body !== "string") return body ?? null;
  try {
    return body === "" ? null : JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
