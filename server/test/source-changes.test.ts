import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECENT_SYNC_PLUGIN_ID, DECENT_SYNC_REPO, WIRE_REVISION, pluginSourceSeen, skinSourceSeen } from "@decent-sync/protocol";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { type ListedPlugin, SimulatedPlugins, bundledPlugins, comparePluginVersions, recordedPlugin } from "./support/decaid-plugins.js";
import { SimulatedSkins, recordedSkin } from "./support/decaid-skins.js";
import { type FakeGitHub, githubEnv, startFakeGitHub } from "./support/fake-github.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { RawConnection, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #678 (ADR-0035): changing how an installed plugin or
// Skin updates, made through the REST API, sent to the built plugin in a
// simulated tablet whose Decaid installs as Decaid v0.9.3 does
// (decaid-plugins.ts, decaid-skins.ts), and answered, against a real server;
// and where an item can be pinned to hold it at the build installed, found
// through a stand-in for GitHub (fake-github.ts). Repositories, ids and
// serials are made up.

interface ActionView {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  outcome: "done" | "refused" | "notConfirmed" | null;
  note: string | null;
  refusal: { reason: string; status?: number | null; message?: string | null } | null;
  result: Record<string, unknown> | null;
}
interface ItemView {
  id: string;
  name: string | null;
  version: string | null;
  updates: Record<string, unknown>;
  build: Record<string, string | null>;
}
interface SoftwareView {
  plugins: (ItemView & { state: string; permissions: string[]; settings: { name: string; value?: unknown }[] })[] | null;
  skins: (ItemView & { default: boolean; served: boolean })[] | null;
  pluginMustUpdate: boolean;
  takesSourceChanges: boolean;
}
interface Pinned {
  source: { repo: string; branch: string } | { url: string } | null;
  tag: string | null;
  commit: string | null;
  unavailable: string | null;
  build: Record<string, string | null>;
}

const FLIGHT = "tasting-flight.js";
const FLIGHT_REPO = "example/tasting-flight";
const FLIGHT_ASSET = `https://github.com/${FLIGHT_REPO}/releases/download/v0.2.31-flight.2/tasting-flight.js-v0.2.31-flight.2.zip`;
const RECIPES = "recipes.reaplugin";
const COMMIT = "717fa95a2b3c4d5e6f708192a3b4c5d6e7f80910";
const OTHER_COMMIT = "8a9b0c1d2e3f405162738495a6b7c8d9e0f1a2b3";

/** A Skin's entry as Decaid lists one, a recorded one's with another id, name, version and source. */
function exampleSkin(base: Record<string, unknown>, skin: { id: string; name: string; version: string; sourceUrl: string; etag?: string }): Record<string, unknown> {
  const metadata = base.reaMetadata as Record<string, unknown>;
  return {
    ...base,
    id: skin.id,
    name: skin.name,
    version: skin.version,
    path: `/root/.local/share/decaid/web-ui/${skin.id}`,
    reaMetadata: { ...metadata, skinId: skin.id, sourceUrl: skin.sourceUrl, ...(skin.etag === undefined ? {} : { etag: skin.etag }) },
  };
}

/** A plugin's entry as Decaid lists one, a recorded one's with another id, name, version and source. */
function examplePlugin(step: "releaseInstalled" | "branchInstalled", plugin: { id: string; name: string; version: string; source: Record<string, unknown> }): ListedPlugin {
  const from = recordedPlugin("dye2.reaplugin", step);
  return { ...from, id: plugin.id, name: plugin.name, version: plugin.version, source: { ...(from.source as Record<string, unknown>), ...plugin.source } };
}

const flightPinned = () => exampleSkin(recordedSkin("streamline-cafe.js-dist"), { id: FLIGHT, name: "Tasting Flight", version: "0.2.31-flight.2", sourceUrl: FLIGHT_ASSET });
const flightReleased = (version = "0.2.32-flight.1") =>
  exampleSkin(recordedSkin("streamline-cafe.js", "releaseInstalled"), { id: FLIGHT, name: "Tasting Flight", version, sourceUrl: `github_release:${FLIGHT_REPO}@v${version}` });
const recipesReleased = () => examplePlugin("releaseInstalled", { id: RECIPES, name: "Recipes", version: "0.1.42", source: { repo: "example/recipes", releaseTag: "v0.1.42" } });

describe("Changing how an installed plugin or Skin updates", () => {
  let server: TestServer;
  let github: FakeGitHub;
  let api: AdminApi;
  let cafe: LocationView;
  let serial = 78_000;

  beforeAll(async () => {
    github = await startFakeGitHub();
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1", ...githubEnv(github) } });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Sources cafe", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
    await github?.close();
  });

  async function connected(name: string, options: { skins?: SimulatedSkins; plugins?: SimulatedPlugins } = {}): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; skins: SimulatedSkins; plugins: SimulatedPlugins }> {
    const machine = await api.createMachine(name, cafe.id);
    const skins = options.skins ?? new SimulatedSkins();
    const plugins = options.plugins ?? new SimulatedPlugins({ plugins: bundledPlugins() });
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++), plugins, skins });
    await api.waitForOnline(machine);
    await expect.poll(async () => ((await software(machine)).skins?.length ?? 0) > 0 && ((await software(machine)).plugins?.length ?? 0) > 0, { timeout: 15_000 }).toBe(true);
    return { machine, tablet, skins, plugins };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/software-actions`;
  const make = async (machine: CreatedMachine, body: unknown, as = api) => (await as.send<{ softwareAction: ActionView }>("POST", path(machine), body, 201)).softwareAction;
  async function refused(machine: CreatedMachine, body: unknown, status: number, as = api): Promise<string> {
    const response = await as.call("POST", path(machine), body);
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return text;
  }
  const read = async (machine: CreatedMachine, id: string) => (await api.get<{ softwareAction: ActionView }>(`${path(machine)}/${id}`)).softwareAction;
  async function answered(machine: CreatedMachine, id: string): Promise<ActionView> {
    await expect.poll(async () => (await read(machine, id)).outcome, { timeout: 20_000 }).not.toBeNull();
    return read(machine, id);
  }
  const done = async (machine: CreatedMachine, body: unknown) => answered(machine, (await make(machine, body)).id);
  const software = async (machine: CreatedMachine, as = api) => (await as.get<{ tabletSoftware: SoftwareView }>(`/machines/${machine.machine.id}/tablet-software`)).tabletSoftware;
  const skin = async (machine: CreatedMachine, id: string) => (await software(machine)).skins!.find((entry) => entry.id === id)!;
  const plugin = async (machine: CreatedMachine, id: string) => (await software(machine)).plugins!.find((entry) => entry.id === id)!;
  /** An item as the page shows it, which a change of how it updates is made over: its build. */
  const seen = (item: ItemView) => item.build;
  const pinnedAnswer = async (machine: CreatedMachine, query: string, as = api) => (await as.get<{ pinnedSource: Pinned }>(`/machines/${machine.machine.id}/pinned-source?${query}`)).pinnedSource;
  /** Where an item can be pinned, without the build that was worked out from. */
  const pinned = async (machine: CreatedMachine, query: string, as = api) => {
    const { build: _build, ...where } = await pinnedAnswer(machine, query, as);
    return where;
  };

  /** Puts an action in the database for the connection holding the Machine, without the server's checks, and announces it: what the plugin is sent whatever the server would refuse. */
  async function stored(machine: CreatedMachine, kind: string, params: unknown): Promise<string> {
    const id = randomUUID();
    const database = await server.connectDatabase();
    try {
      await database.query(
        `INSERT INTO software_actions (id, machine_id, session_id, tablet_id, kind, params, time_ms)
         SELECT $1::uuid, id, connected_session_id, connected_tablet_id, $3, $4::jsonb, 120000 FROM machines WHERE id = $2::uuid`,
        [id, machine.machine.id, kind, JSON.stringify(params)],
      );
      await database.query("SELECT pg_notify('software_actions', $1)", [machine.machine.id]);
    } finally {
      await database.end();
    }
    return id;
  }

  it("has a Skin Pinned at a release's download follow its repository's releases: the latest is installed over it, it stays the default, and the result gives its version before and after", async () => {
    const skins = new SimulatedSkins();
    skins.install(flightPinned());
    skins.makeDefault(FLIGHT, true);
    skins.offer({ repo: FLIGHT_REPO }, flightReleased());
    const { machine, tablet } = await connected("Sources Skin released", { skins });
    const before = await skin(machine, FLIGHT);
    expect(before).toMatchObject({ version: "0.2.31-flight.2", default: true, served: true, updates: { how: "pinned", repo: FLIGHT_REPO, tag: "v0.2.31-flight.2" } });
    expect((await software(machine)).takesSourceChanges).toBe(true);

    const changed = await done(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(before), repo: FLIGHT_REPO });
    expect(changed).toMatchObject({
      kind: "changeSkinSource",
      params: { skin: { id: FLIGHT, name: "Tasting Flight" }, repo: FLIGHT_REPO, branch: null, expected: skinSourceSeen(flightPinned()) },
      outcome: "done",
      refusal: null,
      result: { skinId: FLIGHT, name: "Tasting Flight", version: "0.2.32-flight.1", previousVersion: "0.2.31-flight.2" },
    });
    expect(skins.managed).toEqual(["POST /webui/skins/install/github-release"]);
    expect(await skin(machine, FLIGHT)).toMatchObject({ version: "0.2.32-flight.1", default: true, served: true, updates: { how: "followsReleases", repo: FLIGHT_REPO } });
    expect(skins.defaultSkinId()).toBe(FLIGHT);
    // The Skins read back after it were sent before its answer, naming it.
    const sent = tablet.sent as { type: string; id?: string; name?: string; softwareActionId?: string }[];
    const answer = sent.findIndex((frame) => frame.type === "softwareActed" && frame.id === changed.id);
    expect(sent.slice(0, answer).filter((frame) => frame.type === "collection" && frame.name === "skins").at(-1)?.softwareActionId).toBe(changed.id);
  });

  it("changes a Skin to a branch or a URL too, and no Skin that comes with Decaid, nor one the page showed otherwise", async () => {
    const skins = new SimulatedSkins();
    skins.install(flightReleased("0.2.31-flight.2"));
    const dev = exampleSkin(recordedSkin("streamline.js-dist", "branchInstalled"), { id: FLIGHT, name: "Tasting Flight", version: "0.2.33-dev.4", sourceUrl: `github_branch:${FLIGHT_REPO}@dist` });
    skins.offer({ repo: FLIGHT_REPO, branch: "dist" }, dev);
    skins.offer({ url: FLIGHT_ASSET }, flightPinned());
    const { machine } = await connected("Sources Skin moved", { skins });
    const released = await skin(machine, FLIGHT);

    // Over what the page showed only: another version, or another source, is refused at once, with nothing kept.
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: { ...seen(released), version: "0.2.30" }, repo: FLIGHT_REPO, branch: "dist" }, 409)).toMatch(/Tasting Flight is at another version or source now than the page showed/);
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: { ...seen(released), sourceUrl: "https://skins.example/flight.zip" }, repo: FLIGHT_REPO }, 409)).toMatch(/load the page again/);
    // Its build too: a branch's or a URL's next build may keep the version.
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: { ...seen(released), etag: '"0123abcd"' }, repo: FLIGHT_REPO }, 409)).toMatch(/load the page again/);
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: { version: released.version, updates: released.updates }, repo: FLIGHT_REPO }, 400)).toContain("Give the item's build as shown, as seen");
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, repo: FLIGHT_REPO }, 400)).toMatch(/as shown, as seen/);
    expect(await refused(machine, { kind: "changeSkinSource", skinId: "no-such.js", seen: seen(released), repo: FLIGHT_REPO }, 409)).toMatch(/reports no such Skin/);
    // As an install: no commit as a branch, and a URL or a repository, never both.
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(released), repo: FLIGHT_REPO, branch: COMMIT }, 400)).toContain(`https://github.com/${FLIGHT_REPO}/archive/${COMMIT}.zip`);
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(released), repo: FLIGHT_REPO, url: FLIGHT_ASSET }, 400)).toMatch(/and no repository/);
    const bundled = await skin(machine, "streamline.js");
    expect(bundled.updates).toMatchObject({ how: "comesWithDecaid" });
    expect(await refused(machine, { kind: "changeSkinSource", skinId: "streamline.js", seen: seen(bundled), repo: FLIGHT_REPO }, 400)).toMatch(/comes with Decaid, which restores it from its own repository each time it starts/);
    expect((await api.get<{ total: number }>(path(machine))).total).toBe(0);

    expect(await done(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(released), repo: FLIGHT_REPO, branch: "dist" })).toMatchObject({ outcome: "done", result: { version: "0.2.33-dev.4", previousVersion: "0.2.31-flight.2" } });
    const following = await skin(machine, FLIGHT);
    expect(following.updates).toEqual({ how: "followsBranch", repo: FLIGHT_REPO, branch: "dist" });
    // To the branch it follows, from which Decaid installs nothing while the build is the same: said at once.
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(following), repo: FLIGHT_REPO, branch: "dist" }, 400)).toContain(
      "Tasting Flight already updates from there: choose another source, or check the Skins for updates to install its newest build",
    );
    expect(await done(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(following), url: FLIGHT_ASSET })).toMatchObject({ outcome: "done", params: { url: FLIGHT_ASSET }, result: { version: "0.2.31-flight.2", previousVersion: "0.2.33-dev.4" } });
    expect((await skin(machine, FLIGHT)).updates).toMatchObject({ how: "pinned", tag: "v0.2.31-flight.2" });

    // The plugin changes none that comes with Decaid, whatever it is sent.
    const sent = await answered(machine, await stored(machine, "changeSkinSource", { skin: { id: "streamline.js", name: "Streamline" }, repo: FLIGHT_REPO, expected: skinSourceSeen(skins.listed().find((entry) => entry.id === "streamline.js")) }));
    expect(sent).toMatchObject({ outcome: "refused", refusal: { reason: "notAllowed", message: expect.stringContaining("Decaid restores a Skin it comes with") } });
  });

  it("changes a plugin's source keeping its settings and whether it is enabled, and lists the permissions its new build adds", async () => {
    const recipes = { ...recipesReleased(), settings: { Station: { type: "string", label: "Station" } }, permissions: ["log", "api"] };
    const plugins = new SimulatedPlugins({ plugins: [recipes, ...bundledPlugins()] });
    plugins.offer("example/recipes", { branch: "dist", commit: COMMIT, manifest: { ...recipes, version: "0.1.43", permissions: ["log", "api", "notifications", "manage.extensions"] } });
    const { machine } = await connected("Sources plugin moved", { plugins });
    expect(await done(machine, { kind: "changePluginSettings", pluginId: RECIPES, values: { Station: "bar" }, expected: { Station: null } })).toMatchObject({ outcome: "done" });
    const before = await plugin(machine, RECIPES);
    expect(before).toMatchObject({ version: "0.1.42", state: "enabled", updates: { how: "followsReleases", repo: "example/recipes" } });

    const changed = await done(machine, { kind: "changePluginSource", pluginId: RECIPES, seen: seen(before), repo: "example/recipes", branch: "dist" });
    expect(changed).toMatchObject({
      kind: "changePluginSource",
      params: { plugin: { id: RECIPES, name: "Recipes" }, repo: "example/recipes", branch: "dist", expected: pluginSourceSeen(recipes) },
      outcome: "done",
      result: { pluginId: RECIPES, name: "Recipes", version: "0.1.43", previousVersion: "0.1.42", loaded: true, addedPermissions: ["notifications", "manage.extensions"] },
    });
    expect(plugins.managed.at(-1)).toEqual({ request: "POST /plugins/install/github-branch", via: "localApi", status: 200 });
    const after = await plugin(machine, RECIPES);
    expect(after).toMatchObject({ version: "0.1.43", state: "enabled", updates: { how: "followsBranch", repo: "example/recipes", branch: "dist" } });
    expect(after.settings.find((setting) => setting.name === "Station")?.value).toBe("bar");

    // Pinned to that commit, a build of the same version: nothing added, so no permissions are listed.
    plugins.offer("example/recipes", { branch: COMMIT, commit: COMMIT, manifest: { ...recipes, version: "0.1.43", permissions: ["log", "api", "notifications", "manage.extensions"] } });
    const pinnedThere = await done(machine, { kind: "changePluginSource", pluginId: RECIPES, seen: seen(after), repo: "example/recipes", branch: COMMIT });
    expect(pinnedThere.result).toEqual({ pluginId: RECIPES, name: "Recipes", version: "0.1.43", previousVersion: "0.1.43", loaded: true });
    expect((await plugin(machine, RECIPES)).updates).toMatchObject({ how: "pinned", commit: COMMIT });
  });

  it("pins where the page showed it or not at all: refused once a check moved it to another build of the same version", async () => {
    const recipes = recipesReleased();
    const plugins = new SimulatedPlugins({ plugins: [recipes, ...bundledPlugins()] });
    plugins.offer("example/recipes", { branch: "dist", commit: COMMIT, manifest: { ...recipes, version: "0.1.43" } });
    const { machine } = await connected("Sources pin moved", { plugins });
    await done(machine, { kind: "changePluginSource", pluginId: RECIPES, seen: seen(await plugin(machine, RECIPES)), repo: "example/recipes", branch: "dist" });

    // The page as it loads: the row, and where it can be pinned, worked out from the same build.
    const shown = await plugin(machine, RECIPES);
    expect(shown).toMatchObject({ version: "0.1.43", updates: { how: "followsBranch", branch: "dist" }, build: { commit: COMMIT } });
    const pin = await pinnedAnswer(machine, `pluginId=${RECIPES}`);
    expect(pin).toMatchObject({ source: { repo: "example/recipes", branch: COMMIT }, build: shown.build });

    // Meanwhile the branch's next build, of the same version, is installed by a check.
    plugins.offer("example/recipes", { branch: "dist", commit: OTHER_COMMIT, manifest: { ...recipes, version: "0.1.43" } });
    await done(machine, { kind: "checkPluginUpdates" });
    await expect.poll(async () => (await plugin(machine, RECIPES)).build.commit).toBe(OTHER_COMMIT);
    const installs = plugins.managed.length;

    // Pinning it where the page showed it would roll it back: refused, with nothing kept or sent.
    expect(await refused(machine, { kind: "changePluginSource", pluginId: RECIPES, seen: shown.build, ...(pin.source as { repo: string; branch: string }) }, 409)).toMatch(/Recipes is at another version or source now than the page showed: load the page again/);
    expect(plugins.managed).toHaveLength(installs);
    // Loaded again, it pins the build installed now.
    const now = await plugin(machine, RECIPES);
    expect(await pinnedAnswer(machine, `pluginId=${RECIPES}`)).toMatchObject({ source: { branch: OTHER_COMMIT }, build: now.build });
  });

  it("is refused where the Tablet reports another source by the time it runs, and for a build older than the one installed, in Decaid's words", async () => {
    const recipes = recipesReleased();
    const plugins = new SimulatedPlugins({ plugins: [recipes, ...bundledPlugins()] });
    plugins.offer("example/recipes", { branch: "old", commit: COMMIT, manifest: { ...recipes, version: "0.1.41" } });
    const skins = new SimulatedSkins();
    skins.install(flightPinned());
    skins.offer({ repo: FLIGHT_REPO }, flightReleased());
    const { machine } = await connected("Sources refused", { plugins, skins });
    const before = await plugin(machine, RECIPES);

    // Made over a source or build the Tablet no longer reports, which the server's own check of the page would have caught only later.
    const stale = await answered(machine, await stored(machine, "changePluginSource", { plugin: { id: RECIPES, name: "Recipes" }, repo: "example/recipes", branch: "old", expected: { ...pluginSourceSeen(recipes), releaseTag: "v0.1.40" } }));
    expect(stale).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", message: "The Tablet reports another source or build of it than the page showed: load the page again" } });
    const staleSkin = await answered(machine, await stored(machine, "changeSkinSource", { skin: { id: FLIGHT, name: "Tasting Flight" }, repo: FLIGHT_REPO, expected: { ...skinSourceSeen(flightPinned()), version: "0.2.30" } }));
    expect(staleSkin).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince" } });
    const gone = await answered(machine, await stored(machine, "changeSkinSource", { skin: { id: "gone.js", name: "Gone" }, repo: FLIGHT_REPO, expected: {} }));
    expect(gone).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", message: "The Tablet has no Skin gone.js any more" } });
    expect(plugins.managed).toEqual([]);
    expect(skins.managed).toEqual([]);

    // Decaid installs no build older than the one installed, and removing the plugin first would lose its settings: refused, as Decaid says it.
    const older = await done(machine, { kind: "changePluginSource", pluginId: RECIPES, seen: seen(before), repo: "example/recipes", branch: "old" });
    expect(older).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", status: 409, message: `Plugin ${RECIPES} 0.1.42 is installed; remove it before installing 0.1.41` }, result: null });
    expect(await plugin(machine, RECIPES)).toMatchObject({ version: "0.1.42", updates: { how: "followsReleases" } });
    expect(comparePluginVersions("0.1.41", "0.1.42")).toBe(-1);
    expect(comparePluginVersions("1.13.0", "1.13.0-rc.2")).toBe(1);
    expect(comparePluginVersions("1.13.0-rc.10", "1.13.0-rc.2")).toBe(1);
    expect(comparePluginVersions("1.13", "1.13.0+build.5")).toBe(0);
  });

  it("changes nothing where the source holds another plugin or Skin, removing again the one Decaid installed beside it, unless the Tablet held it before", async () => {
    const recipes = recipesReleased();
    const other = examplePlugin("branchInstalled", { id: "timers.reaplugin", name: "Timers", version: "2.0.0", source: { repo: "example/timers", branch: "main", commit: "1".repeat(40) } });
    const plugins = new SimulatedPlugins({ plugins: [recipes, ...bundledPlugins()] });
    plugins.offer("example/timers", { tag: "v2.0.0", manifest: other });
    const skins = new SimulatedSkins();
    skins.install(flightPinned());
    const nova = exampleSkin(recordedSkin("streamline-cafe.js", "releaseInstalled"), { id: "nova.js", name: "Nova", version: "1.0.0", sourceUrl: "github_release:example/nsx@v1.0.0" });
    skins.offer({ repo: "example/nsx" }, nova);
    const { machine } = await connected("Sources another item", { plugins, skins });

    const strayPlugin = await done(machine, { kind: "changePluginSource", pluginId: RECIPES, seen: seen(await plugin(machine, RECIPES)), repo: "example/timers" });
    expect(strayPlugin).toMatchObject({
      outcome: "refused",
      refusal: { reason: "differentItem", message: "That source holds another plugin, Timers, not Recipes. Decaid installed it beside it, and the plugin removed it again. Recipes is unchanged" },
      result: null,
    });
    expect(plugins.managed.map((entry) => entry.request)).toEqual(["POST /plugins/install/github-release", "DELETE /plugins/timers.reaplugin"]);
    expect(plugins.listed().some((entry) => entry.id === "timers.reaplugin")).toBe(false);
    expect((await software(machine)).plugins!.some((entry) => entry.id === "timers.reaplugin")).toBe(false);
    expect(await plugin(machine, RECIPES)).toMatchObject({ version: "0.1.42", updates: { how: "followsReleases", repo: "example/recipes" } });

    const straySkin = await done(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(await skin(machine, FLIGHT)), repo: "example/nsx" });
    expect(straySkin).toMatchObject({
      outcome: "refused",
      refusal: { reason: "differentItem", message: "That source holds another Skin, Nova, not Tasting Flight. Decaid installed it beside it, and the plugin removed it again. Tasting Flight is unchanged" },
    });
    expect(skins.managed).toEqual(["POST /webui/skins/install/github-release", "DELETE /webui/skins/nova.js"]);
    expect((await software(machine)).skins!.some((entry) => entry.id === "nova.js")).toBe(false);
    expect((await skin(machine, FLIGHT)).updates).toMatchObject({ how: "pinned", tag: "v0.2.31-flight.2" });

    // One the Tablet held before is installed over, and stays: the refusal says so.
    skins.install({ ...nova, version: "0.9.0" });
    await expect.poll(async () => (await software(machine)).skins!.some((entry) => entry.id === "nova.js"), { timeout: 15_000 }).toBe(true);
    const held = await done(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(await skin(machine, FLIGHT)), repo: "example/nsx" });
    expect(held.refusal).toEqual({ reason: "differentItem", message: "That source holds another Skin, Nova, not Tasting Flight. Nova was on the Tablet before, and is now installed from that source. Tasting Flight is unchanged" });
    expect(skins.managed.filter((request) => request.startsWith("DELETE"))).toEqual(["DELETE /webui/skins/nova.js"]);
    expect(await skin(machine, "nova.js")).toMatchObject({ version: "1.0.0" });
  });

  it("lets Decent Sync's own plugin follow only its own repository's releases or be pinned to one of its commits", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    const { machine } = await connected("Sources own plugin", { plugins });
    const own = await plugin(machine, DECENT_SYNC_PLUGIN_ID);
    for (const to of [{ repo: "example/decent-sync-fork" }, { repo: DECENT_SYNC_REPO, branch: "main" }]) {
      expect(await refused(machine, { kind: "changePluginSource", pluginId: DECENT_SYNC_PLUGIN_ID, seen: seen(own), ...to }, 400)).toMatch(/Decent Sync's own plugin follows the releases of loganfuller\/decent-sync or is pinned to one of its commits/);
    }
    expect((await api.get<{ total: number }>(path(machine))).total).toBe(0);
    // The plugin refuses it itself, whatever it is sent.
    const expected = pluginSourceSeen({ version: own.version, source: null });
    for (const to of [{ repo: "example/decent-sync-fork" }, { repo: DECENT_SYNC_REPO, branch: "main" }]) {
      const sent = await answered(machine, await stored(machine, "changePluginSource", { plugin: { id: DECENT_SYNC_PLUGIN_ID, name: "Decent Sync" }, expected, ...to }));
      expect(sent).toMatchObject({ outcome: "refused", refusal: { reason: "notAllowed", message: expect.stringContaining("installs itself only from the latest release of loganfuller/decent-sync or one of its commits") } });
    }
    expect(plugins.managed).toEqual([]);
  });

  it("is an Admin's alone, and a plugin of the previous release is sent one as this release's is", async () => {
    const skins = new SimulatedSkins();
    skins.install(flightPinned());
    const { machine } = await connected("Sources access", { skins });
    const flight = await skin(machine, FLIGHT);
    const staff = await api.staffAt("sources-staff@example.com", cafe);
    expect(await refused(machine, { kind: "changeSkinSource", skinId: FLIGHT, seen: seen(flight), repo: FLIGHT_REPO }, 403, staff)).toContain("Only an Admin can do this");
    expect(await refused(machine, { kind: "changePluginSource", pluginId: DECENT_SYNC_PLUGIN_ID, seen: { version: null }, repo: DECENT_SYNC_REPO }, 403, staff)).toContain("Only an Admin can do this");
    expect((await staff.call("GET", `/machines/${machine.machine.id}/pinned-source?skinId=${FLIGHT}`)).status).toBe(403);
    expect((await software(machine, staff)).takesSourceChanges).toBe(true);

    // The previous release's plugin, at the wire revision before this one, carries out a change as this release's does: it is sent one.
    const old = await api.createMachine("Sources old plugin", cafe.id);
    const raw = await RawConnection.welcomed(server.url, helloWith(old.token, { machine: { model: "DE1Pro", serial: String(serial++) }, wireRevision: WIRE_REVISION - 1 }));
    await api.waitForOnline(old);
    expect(await software(old)).toMatchObject({ pluginMustUpdate: false, takesSourceChanges: true });
    const change = await stored(old, "changeSkinSource", { skin: { id: FLIGHT, name: "Tasting Flight" }, repo: FLIGHT_REPO, expected: {} });
    await expect.poll(() => (raw.messages as { type: string; kind?: string; id?: string }[]).filter((message) => message.type === "softwareAction").map((message) => [message.kind, message.id])).toEqual([["changeSkinSource", change]]);
    await raw.close();
  });

  it("finds through GitHub where an item can be pinned to hold it at the build installed, and offers none where nothing matches", async () => {
    const tagCommit = "a".repeat(40);
    const head = "b".repeat(40);
    const installed = "c".repeat(40);
    const recipes = recipesReleased();
    const timers = examplePlugin("branchInstalled", { id: "timers.reaplugin", name: "Timers", version: "2.0.0", source: { repo: "example/timers", branch: "main", commit: "1".repeat(40) } });
    const held = examplePlugin("branchInstalled", { id: "held.reaplugin", name: "Held", version: "1.0.0", source: { repo: "example/held", branch: COMMIT, commit: COMMIT } });
    const skins = new SimulatedSkins();
    skins.install(flightReleased("0.2.31-flight.2"));
    skins.install(exampleSkin(recordedSkin("streamline.js-dist", "branchInstalled"), { id: "night-shift.js", name: "Night Shift", version: "0.3.0-dev.12", sourceUrl: "github_branch:example/night-shift@dev", etag: 'W/"etag-of-the-installed-commit"' }));
    skins.install(flightPinnedAs("pinned-flight.js"));
    skins.install(exampleSkin(recordedSkin("streamline-cafe.js-dist"), { id: "elsewhere.js", name: "Elsewhere", version: "1.0.0", sourceUrl: "https://skins.example/elsewhere.zip" }));
    const { machine } = await connected("Sources pinned", { plugins: new SimulatedPlugins({ plugins: [recipes, timers, held, ...bundledPlugins()] }), skins });
    github.tag("example/recipes", "v0.1.42", tagCommit);
    github.root("example/recipes", tagCommit, { "manifest.json": JSON.stringify({ id: RECIPES, name: "Recipes", version: "0.1.42" }), "plugin.js": "export default {};" }, ["docs"]);
    github.release(FLIGHT_REPO, "v0.2.31-flight.2", ["notes.txt", "tasting-flight.js-v0.2.31-flight.2.zip", "another.zip"]);
    github.branch("example/night-shift", "dev", [
      { commit: head, etag: "etag-of-a-later-commit" },
      { commit: installed, etag: "etag-of-the-installed-commit" },
    ]);
    const nowhere = { source: null, tag: null, commit: null, unavailable: null };

    // A plugin following releases: its installed tag's commit, given as the branch. One following a branch: the commit Decaid says it is at, with GitHub not asked.
    expect(await pinned(machine, `pluginId=${RECIPES}`)).toEqual({ source: { repo: "example/recipes", branch: tagCommit }, tag: "v0.1.42", commit: tagCommit, unavailable: null });
    const asked = github.requests.length;
    expect(await pinned(machine, "pluginId=timers.reaplugin")).toEqual({ source: { repo: "example/timers", branch: "1".repeat(40) }, tag: null, commit: "1".repeat(40), unavailable: null });
    // One already pinned, and one with no recorded source: nowhere.
    expect(await pinned(machine, "pluginId=held.reaplugin")).toEqual(nowhere);
    expect(await pinned(machine, `pluginId=${DECENT_SYNC_PLUGIN_ID}`)).toEqual(nowhere);
    expect(github.requests.length).toBe(asked);

    // A Skin following releases: its installed tag's download, the first zip, as Decaid's install picks it. One following a branch: the commit whose archive has the ETag Decaid recorded.
    expect(await pinned(machine, `skinId=${FLIGHT}`)).toEqual({ source: { url: FLIGHT_ASSET }, tag: "v0.2.31-flight.2", commit: null, unavailable: null });
    expect(await pinned(machine, "skinId=night-shift.js")).toEqual({ source: { url: `https://github.com/example/night-shift/archive/${installed}.zip` }, tag: null, commit: installed, unavailable: null });
    // Each worked out from the build its row shows, which the page offers the pin over only while they match.
    expect((await pinnedAnswer(machine, "skinId=night-shift.js")).build).toEqual((await skin(machine, "night-shift.js")).build);
    expect((await pinnedAnswer(machine, `pluginId=${RECIPES}`)).build).toEqual((await plugin(machine, RECIPES)).build);
    expect(await pinned(machine, "skinId=pinned-flight.js")).toEqual(nowhere);
    expect(await pinned(machine, "skinId=elsewhere.js")).toEqual(nowhere);
    expect(await pinned(machine, "skinId=streamline.js")).toEqual(nowhere);

    // Nothing matches: a tag GitHub no longer has, a release with no zip, and a branch whose latest commits are all later builds.
    github.release(FLIGHT_REPO, "v0.2.31-flight.2", ["notes.txt"]);
    github.branch("example/night-shift", "dev", [{ commit: head, etag: "etag-of-a-later-commit" }]);
    expect(await pinned(machine, `skinId=${FLIGHT}`)).toEqual(nowhere);
    expect(await pinned(machine, "skinId=night-shift.js")).toEqual(nowhere);
    // A tag whose commit's root is no package of this plugin at this version, which Decaid would refuse to install from its archive: its source in folders below, as Decent Sync's and DYE2's are; another version; another plugin.
    github.root("example/recipes", tagCommit, { "package.json": "{}", "README.md": "" }, ["recipes.reaplugin", "plugin"]);
    expect(await pinned(machine, `pluginId=${RECIPES}`)).toEqual(nowhere);
    github.root("example/recipes", tagCommit, { "manifest.json": JSON.stringify({ id: RECIPES, version: "0.1.42-dev" }), "plugin.js": "" });
    expect(await pinned(machine, `pluginId=${RECIPES}`)).toEqual(nowhere);
    github.root("example/recipes", tagCommit, { "manifest.json": JSON.stringify({ id: "timers.reaplugin", version: "0.1.42" }), "plugin.js": "" });
    expect(await pinned(machine, `pluginId=${RECIPES}`)).toEqual(nowhere);
    github.root("example/recipes", tagCommit, { "manifest.json": JSON.stringify({ id: RECIPES, version: "0.1.42" }) });
    expect(await pinned(machine, `pluginId=${RECIPES}`)).toEqual(nowhere);
    const untagged = await connected("Sources untagged", { plugins: new SimulatedPlugins({ plugins: [{ ...recipes, source: { ...(recipes.source as Record<string, unknown>), releaseTag: "v0.1.41" } }] }) });
    expect(await pinned(untagged.machine, `pluginId=${RECIPES}`)).toEqual(nowhere);

    // GitHub taking no more requests is said, with no pin offered.
    github.answerAll(403);
    expect(await pinned(machine, `pluginId=${RECIPES}`)).toEqual({ ...nowhere, unavailable: "GitHub is taking no more requests from this server for now" });
    github.answerAll(null);

    expect((await api.call("GET", `/machines/${machine.machine.id}/pinned-source?pluginId=no-such.reaplugin`)).status).toBe(409);
    expect((await api.call("GET", `/machines/${machine.machine.id}/pinned-source`)).status).toBe(400);
    expect((await api.call("GET", `/machines/${machine.machine.id}/pinned-source?pluginId=a&skinId=b`)).status).toBe(400);
  });
});

function flightPinnedAs(id: string): Record<string, unknown> {
  return exampleSkin(recordedSkin("streamline-cafe.js-dist"), { id, name: "Pinned Flight", version: "0.2.31-flight.2", sourceUrl: FLIGHT_ASSET });
}
