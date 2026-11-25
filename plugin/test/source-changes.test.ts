import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DECENT_SYNC_PLUGIN_ID, DECENT_SYNC_REPO, type SoftwareActed, type SoftwareAction, pluginSourceSeen, skinSourceSeen } from "@decent-sync/protocol";
import { useLocalApi } from "../src/decaid.js";
import type { Outbox } from "../src/outbox.js";
import { SettingsAccess } from "../src/settings-edits.js";
import { SoftwareActions } from "../src/software-actions.js";
import type { PluginStorage } from "../src/storage.js";

// How the plugin carries out a change of how a plugin or Skin updates
// (ADR-0035, #678), outcome by outcome, against a stubbed Decaid: one that
// keeps a plugin list and a Skins list and answers the routes the plugin
// calls as Decaid v0.9.3's handlers do (`PluginsHandler._install`,
// `WebUIHandler`), with what each repository or URL holds given by the test.
// Seam 1 covers the same through the built plugin and the server
// (server/test/source-changes.test.ts).

declare global {
  // The plugin's id, which its build puts in its code (plugin/build.mjs): given here as the build gives it.
  var __PLUGIN_ID__: string;
}

type Json = Record<string, unknown>;

const id = "0199c5a4-6b7e-7c3d-9a1b-2c3d4e5f6a7b";
const RECIPES = "recipes.reaplugin";
const FLIGHT = "tasting-flight.js";
const FLIGHT_ASSET = "https://github.com/example/tasting-flight/releases/download/v0.2.31-flight.2/tasting-flight.js-v0.2.31-flight.2.zip";
const COMMIT = "717fa95a2b3c4d5e6f708192a3b4c5d6e7f80910";

const recipes = (): Json => ({
  id: RECIPES,
  name: "Recipes",
  version: "0.1.42",
  permissions: ["log", "api"],
  loaded: true,
  autoLoad: true,
  source: { kind: "github_release", repo: "example/recipes", branch: null, commit: null, releaseTag: "v0.1.42", installedAt: "2026-11-23T20:00:16.097049" },
});
const own = (): Json => ({
  id: DECENT_SYNC_PLUGIN_ID,
  name: "Decent Sync",
  version: "1.13.0",
  permissions: ["manage.extensions"],
  loaded: true,
  autoLoad: true,
  source: { kind: "github_release", repo: DECENT_SYNC_REPO, branch: null, commit: null, releaseTag: "v1.13.0", installedAt: "2026-11-23T20:00:19.814631" },
});
const flight = (): Json => ({
  id: FLIGHT,
  name: "Tasting Flight",
  version: "0.2.31-flight.2",
  path: `/web-ui/${FLIGHT}`,
  isBundled: false,
  reaMetadata: { skinId: FLIGHT, sourceUrl: FLIGHT_ASSET, etag: '"0x8DF4822E30A23B6"', installedAt: "2026-11-24T14:10:42.781046" },
});
const streamline = (): Json => ({ id: "streamline.js", name: "Streamline.js", version: "0.2.32", path: "/web-ui/streamline.js", isBundled: true, reaMetadata: { sourceUrl: "github_release:decentespresso/streamline-js@v0.2.32", installedAt: "2026-11-24T14:00:00.000000" } });

/** A Decaid that holds plugins and Skins, and installs and removes them as its routes do. */
class StubDecaid {
  plugins: Json[] = [recipes(), own()];
  skins: Json[] = [streamline(), flight()];
  defaultSkinId = FLIGHT;
  machineState = "idle";
  /** Every managing request it took, as `METHOD path`. */
  readonly managed: string[] = [];
  /** What each repository's latest release (`owner/name`) or branch (`owner/name@branch`) holds: a plugin's manifest. */
  readonly pluginSources = new Map<string, Json>();
  /** What each repository, branch or URL holds for a Skin: its entry. */
  readonly skinSources = new Map<string, Json>();
  /** What `host.localApi` does in place of answering, for a route, once: reject, having carried the request out or not. */
  failing: { route: RegExp; error: string; carriedOut: boolean } | undefined;
  /** What removing an item answers in place of removing it. */
  removalRefused: { status: number; error: string } | undefined;
  private installs = 0;

  localApi = async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? "GET";
    const route = path.replace(/^\/api\/v1/, "");
    this.managed.push(`${method} ${route}`);
    const failing = this.failing?.route.test(route) ? this.failing : undefined;
    if (failing) this.failing = undefined;
    if (failing && !failing.carriedOut) throw new Error(failing.error);
    const answer = this.answer(method, route, (options?.body ?? {}) as Json);
    if (failing) throw new Error(failing.error);
    return { status: answer.status, headers: {}, body: JSON.stringify(answer.body) };
  };

  private answer(method: string, route: string, body: Json): { status: number; body: unknown } {
    const now = `2026-11-25T10:00:0${++this.installs}.000000`;
    if (method === "POST" && route.startsWith("/plugins/install/github-")) {
      const branch = route.endsWith("branch") ? String(body.branch ?? "main") : undefined;
      const manifest = this.pluginSources.get(branch === undefined ? String(body.repo) : `${String(body.repo)}@${branch}`);
      if (!manifest) return { status: 500, body: { error: "Couldn't install the plugin. The repository, release, or download was not found. Check the address and try again." } };
      const held = this.plugins.find((plugin) => plugin.id === manifest.id);
      // `PluginLoaderService._ensureNotDowngrade`, answered 409.
      if (held && String(manifest.version) < String(held.version)) return { status: 409, body: { error: `Plugin ${String(manifest.id)} ${String(held.version)} is installed; remove it before installing ${String(manifest.version)}` } };
      const source = branch === undefined ? { kind: "github_release", repo: body.repo, branch: null, commit: null, releaseTag: `v${String(manifest.version)}`, installedAt: now } : { kind: "github_branch", repo: body.repo, branch, commit: manifest.commit ?? COMMIT, releaseTag: null, installedAt: now };
      const { commit: _commit, ...declared } = manifest;
      const entry = { ...declared, loaded: held ? held.loaded : false, autoLoad: held ? held.autoLoad : false, source };
      this.plugins = held ? this.plugins.map((plugin) => (plugin === held ? entry : plugin)) : [...this.plugins, entry];
      return { status: 200, body: { message: "Plugin installed", id: manifest.id, version: manifest.version, loaded: entry.loaded } };
    }
    const plugin = /^\/plugins\/([^/]+)$/.exec(route);
    if (method === "DELETE" && plugin) {
      if (this.removalRefused) return { status: this.removalRefused.status, body: { error: this.removalRefused.error } };
      this.plugins = this.plugins.filter((entry) => entry.id !== decodeURIComponent(plugin[1]!));
      return { status: 200, body: { message: "Plugin removed" } };
    }
    if (method === "POST" && route.startsWith("/webui/skins/install/")) {
      const key = route.endsWith("/url") ? String(body.url) : route.endsWith("branch") ? `${String(body.repo)}@${String(body.branch)}` : String(body.repo);
      const skin = this.skinSources.get(key);
      if (!skin) return { status: 500, body: { error: "Couldn't install the skin. The repository, release, or download was not found. Check the address and try again." } };
      this.skins = [...this.skins.filter((entry) => entry.id !== skin.id), { ...skin, reaMetadata: { ...(skin.reaMetadata as Json), installedAt: now } }];
      return { status: 200, body: { success: true, message: "Skin installed successfully" } };
    }
    const skin = /^\/webui\/skins\/([^/]+)$/.exec(route);
    if (method === "DELETE" && skin) {
      if (this.removalRefused) return { status: this.removalRefused.status, body: { error: this.removalRefused.error } };
      this.skins = this.skins.filter((entry) => entry.id !== decodeURIComponent(skin[1]!));
      return { status: 200, body: { success: true } };
    }
    return { status: 404, body: { error: `No route ${method} ${route}` } };
  }

  skinsReport(): Json {
    const served = this.skins.find((skin) => skin.id === this.defaultSkinId);
    return structuredClone({ skins: this.skins, default: served ?? null, server: served ? { serving: true, path: served.path } : { serving: false } });
  }
}

/** The plugin's Software Actions over a stubbed Decaid, with what they answered and what they kept across a load. */
function loaded(decaid: StubDecaid, kept: { value: unknown } = { value: "" }) {
  const answers: SoftwareActed[] = [];
  /** The ids of the actions each read of a list was reported as the read-back of. */
  const readBacks: (string | undefined)[] = [];
  useLocalApi({ localApi: decaid.localApi });
  const actions = new SoftwareActions(
    new SettingsAccess(),
    { enqueue: (message: SoftwareActed) => void answers.push(message) } as unknown as Outbox,
    {
      readSoftware: async (what, readBackOf) => {
        readBacks.push(readBackOf);
        return what === "plugins" ? structuredClone(decaid.plugins) : [];
      },
      readSoftwareSkins: async (readBackOf) => {
        readBacks.push(readBackOf);
        return decaid.skinsReport();
      },
    },
    { read: async () => kept.value, write: async (_key: string, value: unknown) => void (kept.value = value) } as unknown as PluginStorage,
    { open: async () => "socket", close: () => {}, onEvent: () => {}, send: async () => {} } as never,
    () => {},
  );
  return { actions, answers, readBacks, kept };
}

const pluginChange = (decaid: StubDecaid, to: { repo: string; branch?: string }, pluginId = RECIPES): SoftwareAction => ({
  type: "softwareAction",
  id,
  timeLeftMs: 119_000,
  kind: "changePluginSource",
  pluginId,
  expected: pluginSourceSeen(decaid.plugins.find((plugin) => plugin.id === pluginId)),
  ...to,
});
const skinChange = (decaid: StubDecaid, to: { repo: string; branch?: string } | { url: string }, skinId = FLIGHT): SoftwareAction => ({
  type: "softwareAction",
  id,
  timeLeftMs: 119_000,
  kind: "changeSkinSource",
  skinId,
  expected: skinSourceSeen(decaid.skins.find((skin) => skin.id === skinId)),
  ...to,
});

describe("A change of how a plugin or Skin updates, carried out by the plugin", () => {
  let decaid: StubDecaid;

  beforeEach(() => {
    decaid = new StubDecaid();
    globalThis.__PLUGIN_ID__ = DECENT_SYNC_PLUGIN_ID;
    // The plugin reads the machine's state with its own fetch, and manages through `host.localApi`.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ state: { state: decaid.machineState } }), { status: 200 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("installs a plugin again from its new source and answers done, with its version before and after and the permissions its new build adds", async () => {
    decaid.pluginSources.set("example/recipes@dist", { id: RECIPES, name: "Recipes", version: "0.1.43", permissions: ["log", "api", "notifications"], commit: COMMIT });
    const { actions, answers, readBacks } = loaded(decaid);
    await actions.apply(pluginChange(decaid, { repo: "example/recipes", branch: "dist" }), () => true);
    expect(answers).toEqual([{ type: "softwareActed", id, outcome: "done", result: { pluginId: RECIPES, name: "Recipes", version: "0.1.43", previousVersion: "0.1.42", loaded: true, addedPermissions: ["notifications"] } }]);
    expect(decaid.managed).toEqual(["POST /plugins/install/github-branch"]);
    expect(decaid.plugins.find((plugin) => plugin.id === RECIPES)).toMatchObject({ loaded: true, autoLoad: true, source: { kind: "github_branch", branch: "dist", commit: COMMIT } });
    // The list is read before, and read back afterwards as the action's.
    expect(readBacks).toEqual([undefined, id]);

    // To the latest release, a build that adds nothing: no permissions are listed.
    decaid.pluginSources.set("example/recipes", { id: RECIPES, name: "Recipes", version: "0.1.44", permissions: ["log", "api", "notifications"] });
    await actions.apply(pluginChange(decaid, { repo: "example/recipes" }), () => true);
    expect(answers[1]).toEqual({ type: "softwareActed", id, outcome: "done", result: { pluginId: RECIPES, name: "Recipes", version: "0.1.44", previousVersion: "0.1.43", loaded: true } });
    expect(decaid.managed.at(-1)).toBe("POST /plugins/install/github-release");
  });

  it("installs a Skin again from a repository's release, a branch or a URL and answers done, with its version before and after, leaving the default as it was", async () => {
    const released = { ...flight(), version: "0.2.32-flight.1", reaMetadata: { skinId: FLIGHT, sourceUrl: "github_release:example/tasting-flight@v0.2.32-flight.1", etag: '"newer"' } };
    decaid.skinSources.set("example/tasting-flight", released);
    decaid.skinSources.set("example/tasting-flight@dist", { ...released, version: "0.2.33-dev.4", reaMetadata: { skinId: FLIGHT, sourceUrl: "github_branch:example/tasting-flight@dist", etag: 'W/"dev"' } });
    decaid.skinSources.set(FLIGHT_ASSET, flight());
    const { actions, answers, readBacks } = loaded(decaid);
    await actions.apply(skinChange(decaid, { repo: "example/tasting-flight" }), () => true);
    expect(answers).toEqual([{ type: "softwareActed", id, outcome: "done", result: { skinId: FLIGHT, name: "Tasting Flight", version: "0.2.32-flight.1", previousVersion: "0.2.31-flight.2" } }]);
    expect(readBacks).toEqual([undefined, id]);
    await actions.apply(skinChange(decaid, { repo: "example/tasting-flight", branch: "dist" }), () => true);
    await actions.apply(skinChange(decaid, { url: FLIGHT_ASSET }), () => true);
    expect(answers.slice(1).map((answer) => answer.result)).toEqual([
      { skinId: FLIGHT, name: "Tasting Flight", version: "0.2.33-dev.4", previousVersion: "0.2.32-flight.1" },
      { skinId: FLIGHT, name: "Tasting Flight", version: "0.2.31-flight.2", previousVersion: "0.2.33-dev.4" },
    ]);
    expect(decaid.managed).toEqual(["POST /webui/skins/install/github-release", "POST /webui/skins/install/github-branch", "POST /webui/skins/install/url"]);
    expect(decaid.defaultSkinId).toBe(FLIGHT);
  });

  it("refuses as changedSince, asking nothing of Decaid, where the Tablet reports another source or build than the Admin saw, or the item is gone", async () => {
    const { actions, answers } = loaded(decaid);
    const moved = "The Tablet reports another source or build of it than the page showed: load the page again";
    await actions.apply({ ...pluginChange(decaid, { repo: "example/recipes", branch: "dist" }), expected: { ...pluginSourceSeen(recipes()), releaseTag: "v0.1.41" } } as SoftwareAction, () => true);
    await actions.apply({ ...pluginChange(decaid, { repo: "example/recipes" }), expected: { ...pluginSourceSeen(recipes()), version: "0.1.41" } } as SoftwareAction, () => true);
    await actions.apply({ ...skinChange(decaid, { repo: "example/tasting-flight" }), expected: { ...skinSourceSeen(flight()), etag: '"another"' } } as SoftwareAction, () => true);
    await actions.apply({ ...pluginChange(decaid, { repo: "example/recipes" }), pluginId: "gone.reaplugin" } as SoftwareAction, () => true);
    await actions.apply({ ...skinChange(decaid, { repo: "example/tasting-flight" }), skinId: "gone.js" } as SoftwareAction, () => true);
    expect(answers.map((answer) => [answer.outcome, answer.reason, answer.message])).toEqual([
      ["refused", "changedSince", moved],
      ["refused", "changedSince", moved],
      ["refused", "changedSince", moved],
      ["refused", "changedSince", "The Tablet has no plugin gone.reaplugin any more"],
      ["refused", "changedSince", "The Tablet has no Skin gone.js any more"],
    ]);
    expect(decaid.managed).toEqual([]);
  });

  it("refuses as differentItem where the source holds another plugin, removing it again unless the Tablet held it before, and leaves the plugin it named as it was", async () => {
    decaid.pluginSources.set("example/timers", { id: "timers.reaplugin", name: "Timers", version: "2.0.0", permissions: [] });
    const { actions, answers, readBacks } = loaded(decaid);
    await actions.apply(pluginChange(decaid, { repo: "example/timers" }), () => true);
    expect(answers).toEqual([
      { type: "softwareActed", id, outcome: "refused", reason: "differentItem", message: "That source holds another plugin, Timers, not Recipes. Decaid installed it beside it, and the plugin removed it again. Recipes is unchanged" },
    ]);
    expect(decaid.managed).toEqual(["POST /plugins/install/github-release", "DELETE /plugins/timers.reaplugin"]);
    expect(decaid.plugins).toEqual([recipes(), own()]);
    // The list is read back once more after the removal, as the action's.
    expect(readBacks).toEqual([undefined, id, id]);

    // One the Tablet held before is installed over by Decaid, and stays.
    decaid.plugins.push({ id: "timers.reaplugin", name: "Timers", version: "1.9.0", permissions: [], loaded: true, autoLoad: true, source: null });
    await actions.apply(pluginChange(decaid, { repo: "example/timers" }), () => true);
    expect(answers[1]).toMatchObject({ reason: "differentItem", message: "That source holds another plugin, Timers, not Recipes. Timers was on the Tablet before, and is now installed from that source. Recipes is unchanged" });
    expect(decaid.managed.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);
    expect(decaid.plugins.find((plugin) => plugin.id === "timers.reaplugin")).toMatchObject({ version: "2.0.0" });

    // One Decaid would not remove again is named for the Admin to remove.
    decaid.plugins = [recipes(), own()];
    decaid.removalRefused = { status: 500, error: "Couldn't remove the plugin." };
    await actions.apply(pluginChange(decaid, { repo: "example/timers" }), () => true);
    expect(answers[2]).toMatchObject({ reason: "differentItem", message: "That source holds another plugin, Timers, not Recipes. Decaid installed it beside it, and it could not be removed again (Couldn't remove the plugin.): remove it from its row. Recipes is unchanged" });
  });

  it("refuses as differentItem where the source holds another Skin, removing it again unless the Tablet held it before", async () => {
    const nova = { id: "nova.js", name: "Nova", version: "1.0.0", path: "/web-ui/nova.js", isBundled: false, reaMetadata: { sourceUrl: "github_release:example/nsx@v1.0.0" } };
    decaid.skinSources.set("example/nsx", nova);
    const { actions, answers } = loaded(decaid);
    await actions.apply(skinChange(decaid, { repo: "example/nsx" }), () => true);
    expect(answers).toEqual([
      { type: "softwareActed", id, outcome: "refused", reason: "differentItem", message: "That source holds another Skin, Nova, not Tasting Flight. Decaid installed it beside it, and the plugin removed it again. Tasting Flight is unchanged" },
    ]);
    expect(decaid.managed).toEqual(["POST /webui/skins/install/github-release", "DELETE /webui/skins/nova.js"]);
    expect(decaid.skins).toEqual([streamline(), flight()]);

    decaid.skins.push({ ...nova, version: "0.9.0", reaMetadata: { sourceUrl: "github_release:example/nova@v0.9.0", installedAt: "2026-11-20T09:00:00.000000" } });
    await actions.apply(skinChange(decaid, { repo: "example/nsx" }), () => true);
    expect(answers[1]).toMatchObject({ reason: "differentItem", message: "That source holds another Skin, Nova, not Tasting Flight. Nova was on the Tablet before, and is now installed from that source. Tasting Flight is unchanged" });
    expect(decaid.managed.filter((request) => request.startsWith("DELETE"))).toHaveLength(1);
  });

  it("refuses a plugin build older than the one installed with Decaid's reason, and any other refusal of Decaid's with its words", async () => {
    decaid.pluginSources.set("example/recipes@old", { id: RECIPES, name: "Recipes", version: "0.1.41", permissions: ["log", "api"] });
    const { actions, answers } = loaded(decaid);
    await actions.apply(pluginChange(decaid, { repo: "example/recipes", branch: "old" }), () => true);
    await actions.apply(pluginChange(decaid, { repo: "example/no-such-repository" }), () => true);
    await actions.apply(skinChange(decaid, { url: "https://skins.example/gone.zip" }), () => true);
    expect(answers).toEqual([
      { type: "softwareActed", id, outcome: "refused", reason: "decaid", status: 409, message: `Plugin ${RECIPES} 0.1.42 is installed; remove it before installing 0.1.41` },
      { type: "softwareActed", id, outcome: "refused", reason: "decaid", status: 500, message: "Couldn't install the plugin. The repository, release, or download was not found. Check the address and try again." },
      { type: "softwareActed", id, outcome: "refused", reason: "decaid", status: 500, message: "Couldn't install the skin. The repository, release, or download was not found. Check the address and try again." },
    ]);
    // Nothing is removed to make room: the plugin and its settings stay.
    expect(decaid.managed.filter((request) => request.startsWith("DELETE"))).toEqual([]);
    expect(decaid.plugins).toEqual([recipes(), own()]);
  });

  it("refuses as notAllowed its own plugin's move to any source but its own repository's releases or commits, and a change of a Skin that comes with Decaid", async () => {
    const { actions, answers } = loaded(decaid);
    await actions.apply(pluginChange(decaid, { repo: "example/decent-sync-fork" }, DECENT_SYNC_PLUGIN_ID), () => true);
    await actions.apply(pluginChange(decaid, { repo: DECENT_SYNC_REPO, branch: "main" }, DECENT_SYNC_PLUGIN_ID), () => true);
    await actions.apply(skinChange(decaid, { repo: "example/tasting-flight" }, "streamline.js"), () => true);
    expect(answers.map((answer) => [answer.reason, answer.message])).toEqual([
      ["notAllowed", "The Decent Sync plugin installs itself only from the latest release of loganfuller/decent-sync or one of its commits: a build from anywhere else could cut the Tablet off from the server"],
      ["notAllowed", "The Decent Sync plugin installs itself only from the latest release of loganfuller/decent-sync or one of its commits: a build from anywhere else could cut the Tablet off from the server"],
      ["notAllowed", "Decaid restores a Skin it comes with from its own repository each time it starts, so how it updates can't be changed"],
    ]);
    expect(decaid.managed).toEqual([]);
  });

  it("pins its own plugin to one of its commits, answered by the load Decaid starts under the install", async () => {
    decaid.pluginSources.set(`${DECENT_SYNC_REPO}@${COMMIT}`, { id: DECENT_SYNC_PLUGIN_ID, name: "Decent Sync", version: "1.13.0", permissions: ["manage.extensions"], commit: COMMIT });
    // Decaid installs it, then unloads the load that asked, dropping its call.
    decaid.failing = { route: /^\/plugins\/install\//, error: "Plugin unloaded: generation changed", carriedOut: true };
    const first = loaded(decaid);
    await first.actions.apply(pluginChange(decaid, { repo: DECENT_SYNC_REPO, branch: COMMIT }, DECENT_SYNC_PLUGIN_ID), () => true);
    expect(first.answers).toEqual([]);
    expect(first.kept.value).not.toBe("");
    first.actions.stop();

    const next = loaded(decaid, first.kept);
    await next.actions.resume();
    expect(next.answers).toEqual([{ type: "softwareActed", id, outcome: "done", result: { pluginId: DECENT_SYNC_PLUGIN_ID, name: "Decent Sync", version: "1.13.0", previousVersion: "1.13.0", loaded: true } }]);
    expect(next.kept.value).toBe("");
    expect(decaid.plugins.find((plugin) => plugin.id === DECENT_SYNC_PLUGIN_ID)).toMatchObject({ source: { kind: "github_branch", branch: COMMIT, commit: COMMIT } });
  });

  it("refuses while the machine runs something, and once its time is short or its connection closed, asking nothing of Decaid", async () => {
    decaid.pluginSources.set("example/recipes@dist", { id: RECIPES, name: "Recipes", version: "0.1.43", permissions: [] });
    const { actions, answers } = loaded(decaid);
    decaid.machineState = "espresso";
    await actions.apply(pluginChange(decaid, { repo: "example/recipes", branch: "dist" }), () => true);
    decaid.machineState = "idle";
    await actions.apply({ ...pluginChange(decaid, { repo: "example/recipes", branch: "dist" }), timeLeftMs: 10_000 }, () => true);
    await actions.apply(skinChange(decaid, { repo: "example/tasting-flight" }), () => false);
    expect(answers).toEqual([
      { type: "softwareActed", id, outcome: "refused", reason: "machineBusy", state: "espresso" },
      { type: "softwareActed", id, outcome: "refused", reason: "expired" },
      { type: "softwareActed", id, outcome: "refused", reason: "expired" },
    ]);
    expect(decaid.managed).toEqual([]);
  });

  it("answers that Decaid did not answer, having read the lists back, and not confirmed where an install Decaid took shows no Skin installed", async () => {
    decaid.pluginSources.set("example/recipes@dist", { id: RECIPES, name: "Recipes", version: "0.1.43", permissions: [] });
    decaid.failing = { route: /^\/plugins\/install\//, error: "Connection refused", carriedOut: false };
    const { actions, answers, readBacks } = loaded(decaid);
    await actions.apply(pluginChange(decaid, { repo: "example/recipes", branch: "dist" }), () => true);
    expect(answers).toEqual([{ type: "softwareActed", id, outcome: "refused", reason: "decaid", status: null, message: "Decaid did not answer: Connection refused" }]);
    expect(readBacks).toEqual([undefined, id]);

    // Decaid answers that it installed, but its list shows nothing installed since: what came of it never showed.
    decaid.skinSources.set("example/tasting-flight", flight());
    const installed = decaid.localApi;
    decaid.localApi = async (path, options) => (path.includes("/install/") ? { status: 200, headers: {}, body: JSON.stringify({ success: true }) } : installed(path, options));
    const again = loaded(decaid);
    await again.actions.apply(skinChange(decaid, { repo: "example/tasting-flight" }), () => true);
    expect(again.answers).toEqual([{ type: "softwareActed", id, outcome: "notConfirmed", message: "Decaid took the install, but its Skins list shows no Skin installed since" }]);
  });

  it("watches for what came of an install whose call Decaid stopped waiting on, and answers once the list shows it", async () => {
    vi.useFakeTimers();
    decaid.pluginSources.set("example/recipes@dist", { id: RECIPES, name: "Recipes", version: "0.1.43", permissions: ["log", "api"], commit: COMMIT });
    decaid.pluginSources.set("example/timers", { id: "timers.reaplugin", name: "Timers", version: "2.0.0", permissions: [] });
    decaid.skinSources.set("example/nsx", { id: "nova.js", name: "Nova", version: "1.0.0", path: "/web-ui/nova.js", isBundled: false, reaMetadata: { sourceUrl: "github_release:example/nsx@v1.0.0" } });
    const { actions, answers } = loaded(decaid);
    const timedOut = { route: /\/install\//, error: "localApi call timed out after 60s", carriedOut: true };

    decaid.failing = { ...timedOut };
    await actions.apply(pluginChange(decaid, { repo: "example/recipes", branch: "dist" }), () => true);
    expect(answers[0]).toMatchObject({ outcome: "done", result: { pluginId: RECIPES, version: "0.1.43", previousVersion: "0.1.42" } });

    // The same where the source held another item: it is removed again, and the action refused.
    decaid.failing = { ...timedOut };
    await actions.apply(pluginChange(decaid, { repo: "example/timers" }), () => true);
    expect(answers[1]).toMatchObject({ outcome: "refused", reason: "differentItem" });
    expect(decaid.plugins.some((plugin) => plugin.id === "timers.reaplugin")).toBe(false);
    decaid.failing = { ...timedOut };
    await actions.apply(skinChange(decaid, { repo: "example/nsx" }), () => true);
    expect(answers[2]).toMatchObject({ outcome: "refused", reason: "differentItem" });
    expect(decaid.skins.some((skin) => skin.id === "nova.js")).toBe(false);
  });
});
