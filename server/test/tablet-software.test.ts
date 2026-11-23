import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginSources, pluginUpdates, pluginView, skinUpdates, skinViews, tabletSoftwareView } from "../src/software-actions/tablet-software.js";
import { bundledPlugins, decaidUpdateState, recordedPlugin, skinsOn093 } from "./support/decaid-plugins.js";
import { pluginsAndSkinsAt } from "./support/simulated-tablet.js";

// How a plugin or Skin updates (#657's table, ADR-0034), worked out from
// what Decaid reports with no list of its ids: from the plugin lists and
// Skins Decaid's Linux releases answered, recorded in
// fixtures/decaid/tablet-software-v0.9.3/ and plugins-and-skins-v0.9.0/. A
// Skin installed from a URL was not recorded, so its two rows are checked on
// a recorded Skin with a made-up `sourceUrl`, said where it is.

const at = new Date("2026-11-23T20:00:00.000Z");
const report = (value: unknown) => ({ available: true, reportedAt: at, value, receivedAt: at });

describe("how a plugin updates", () => {
  it("follows releases where Decaid installed it from a GitHub release", () => {
    expect(pluginUpdates(recordedPlugin("decent-sync.reaplugin", "releaseInstalled").source)).toEqual({ how: "followsReleases", repo: "loganfuller/decent-sync" });
  });

  it("follows a branch where it came from one, and is Pinned where the branch's name is a commit", () => {
    expect(pluginUpdates(recordedPlugin("dye2.reaplugin", "branchInstalled").source)).toEqual({ how: "followsBranch", repo: "decentespresso/dye2", branch: "dist" });
    const pinned = recordedPlugin("dye2.reaplugin", "commitInstalled").source as { commit: string; branch: string };
    // Decaid records the commit asked for as the branch, and the same commit as what it installed.
    expect(pinned.branch).toBe(pinned.commit);
    expect(pluginUpdates(pinned)).toEqual({ how: "pinned", repo: "decentespresso/dye2", commit: pinned.commit, url: null });
    // An abbreviated commit pins too, shown by the commit Decaid resolved it to.
    expect(pluginUpdates({ ...pinned, branch: pinned.commit.slice(0, 7) })).toEqual({ how: "pinned", repo: "decentespresso/dye2", commit: pinned.commit, url: null });
    // A branch whose name only looks like one, with another commit at its head, is a branch.
    expect(pluginUpdates({ ...pinned, branch: "deadbeef" })).toEqual({ how: "followsBranch", repo: "decentespresso/dye2", branch: "deadbeef" });
  });

  it("is not updated with no recorded source, as the plugins Decaid bundles until it first checks them, or from a zip or folder", () => {
    for (const plugin of bundledPlugins()) expect(pluginUpdates(plugin.source), plugin.id).toEqual({ how: "notUpdated" });
    expect(pluginUpdates({ kind: "local_zip" })).toEqual({ how: "notUpdated" });
    expect(pluginUpdates({ kind: "local_folder" })).toEqual({ how: "notUpdated" });
    // Decaid gives a plugin it bundles its repository at its first update check, and follows its releases from then.
    expect(pluginUpdates(recordedPlugin("shot-upload.reaplugin", "checked").source)).toEqual({ how: "followsReleases", repo: "decentespresso/shot-upload" });
  });
});

describe("how a Skin updates", () => {
  const skins093 = (skinsOn093()["/webui/skins"] as Record<string, unknown>[]).map((skin) => [skin.id, skin] as const);
  const skins090 = pluginsAndSkinsAt("streamlineMain")["/webui/skins"]!.body as Record<string, unknown>[];

  it("comes with Decaid where Decaid flags it as built in, whatever release it was last put back from", () => {
    expect(skins093.length).toBeGreaterThan(3);
    for (const [id, skin] of skins093) expect(skinUpdates(skin), String(id)).toMatchObject({ how: "comesWithDecaid", repo: expect.stringMatching(/^[^/]+\/[^/]+$/) });
  });

  it("follows releases or a branch where it was installed from one and is not built in", () => {
    const dist = skins090.find((skin) => skin.id === "streamline.js-dist")!;
    expect(dist.isBundled).not.toBe(true);
    expect(skinUpdates(dist)).toEqual({ how: "followsBranch", repo: "decentespresso/streamline-js", branch: "dist" });
    const release = skins090.find((skin) => skin.id === "streamline.js")!;
    expect(skinUpdates({ ...release, isBundled: false })).toEqual({ how: "followsReleases", repo: "decentespresso/streamline-js" });
  });

  it("is Pinned from a URL naming a commit's archive, follows any other URL, and is not updated with no recorded source", () => {
    // Derived: a recorded Skin with a made-up `sourceUrl`, as no URL install was recorded.
    const [, recorded] = skins093[0]!;
    const from = (sourceUrl: string | null) => ({ ...recorded, isBundled: false, reaMetadata: sourceUrl === null ? null : { ...(recorded.reaMetadata as Record<string, unknown>), sourceUrl } });
    const commit = "97da8f8a1b2c3d4e5f60718293a4b5c6d7e8f901";
    expect(skinUpdates(from(`https://github.com/decentespresso/streamline-js/archive/${commit}.zip`))).toEqual({ how: "pinned", repo: null, commit, url: `https://github.com/decentespresso/streamline-js/archive/${commit}.zip` });
    expect(skinUpdates(from("https://skins.example/streamline-latest.zip"))).toEqual({ how: "followsUrl", url: "https://skins.example/streamline-latest.zip" });
    expect(skinUpdates(from(null))).toEqual({ how: "notUpdated" });
  });

  it("marks the default Skin and the one Decaid's Skin server serves", () => {
    const served = skinsOn093();
    const views = skinViews({ skins: served["/webui/skins"], default: served["/webui/skins/default"], server: served["/webui/server/status"] })!;
    expect(views.filter((skin) => skin.default).map((skin) => skin.id)).toEqual(["streamline.js"]);
    expect(views.filter((skin) => skin.served).map((skin) => skin.id)).toEqual(["streamline.js"]);
    expect(skinViews({ skins: served["/webui/skins"], default: null, server: { serving: false, path: null } })!.some((skin) => skin.default || skin.served)).toBe(false);
    expect(skinViews(undefined)).toBeNull();
  });
});

describe("a Machine's Tablet Software", () => {
  const pending = recordedPlugin("decent-sync.reaplugin", "checked", "pending");

  it("shows a plugin's waiting update with the permissions it adds, as Decaid recorded one", () => {
    expect(pluginView(pending, undefined, true)).toMatchObject({
      id: "decent-sync.reaplugin",
      version: "0.3.0",
      state: "disabled",
      own: true,
      updates: { how: "followsReleases", repo: "loganfuller/decent-sync" },
      pendingUpdate: { version: "1.12.2", addedPermissions: ["emit"] },
    });
  });

  it("gives a plugin's settings as its manifest declares them, with what the Tablet holds to an Admin alone, a secret only as set or not", () => {
    const visualizer = recordedPlugin("visualizer.reaplugin");
    const held = { Username: "sam", LengthThreshold: 7, Password: { isSet: true } };
    const forAdmin = pluginView(visualizer, held, true)!;
    expect(forAdmin.settings.map((setting) => [setting.name, setting.kind, setting.secret, setting.value])).toEqual([
      ["Username", "text", false, "sam"],
      ["Password", "text", true, { isSet: true }],
      ["AutoUpload", "switch", false, null],
      ["LengthThreshold", "number", false, 7],
      ["BackSync", "switch", false, null],
      ["BackSyncIntervalSeconds", "number", false, null],
    ]);
    expect(forAdmin.settings.find((setting) => setting.name === "AutoUpload")).toMatchObject({ label: "Upload shots automatically", default: true, changeable: true });
    const forStaff = pluginView(visualizer, held, false)!;
    expect(forStaff.settings.map((setting) => setting.name)).toEqual(forAdmin.settings.map((setting) => setting.name));
    expect(forStaff.settings.some((setting) => "value" in setting)).toBe(false);
    // Of its own plugin's, only the poll interval is changed from here.
    expect(pluginView(pending, {}, true)!.settings.map((setting) => [setting.name, setting.changeable])).toEqual([["ServerUrl", false], ["Token", false], ["PollSeconds", true]]);
  });

  it("reads Decaid's version and build, its update state and its automatic update checks, each absent until reported", () => {
    const view = tabletSoftwareView(
      { plugins: report(bundledPlugins()), pluginSettings: null, skins: null, decaidUpdate: report(decaidUpdateState()), appSettings: report({ automaticUpdateCheck: false }) },
      { decaidVersion: "0.9.3+3265", pluginMustUpdate: false },
      true,
    );
    expect(view.decaid).toEqual({ version: "0.9.3", build: "3265", update: { phase: "idle", latestVersion: null, installable: false, error: null, reportedAt: at.toISOString() }, automaticUpdateCheck: false });
    expect(view.skins).toBeNull();
    expect(view.plugins!.map((plugin) => plugin.id)).toEqual(bundledPlugins().map((plugin) => plugin.id));
    const nothing = tabletSoftwareView({ plugins: null, pluginSettings: null, skins: null, decaidUpdate: null, appSettings: null }, { decaidVersion: null, pluginMustUpdate: true }, false);
    expect(nothing).toEqual({ decaid: { version: null, build: null, update: null, automaticUpdateCheck: null }, plugins: null, skins: null, pluginMustUpdate: true });
  });

  it("suggests each distinct source once, with how many Machines use it and the highest version there", () => {
    const release = recordedPlugin("decent-sync.reaplugin", "releaseInstalled");
    const pinned = recordedPlugin("dye2.reaplugin", "commitInstalled");
    const commit = (pinned.source as { commit: string }).commit;
    const sources = pluginSources([[release, pinned], [{ ...release, version: "1.13.0" }, recordedPlugin("dye2.reaplugin", "branchInstalled")], [...bundledPlugins()], "not a list"]);
    expect(sources).toEqual([
      { pluginId: "decent-sync.reaplugin", name: release.name, version: "1.13.0", repo: "loganfuller/decent-sync", branch: null, updates: { how: "followsReleases", repo: "loganfuller/decent-sync" }, machines: 2 },
      // Used by as many Machines, in the order they were found.
      { pluginId: "dye2.reaplugin", name: pinned.name, version: pinned.version, repo: "decentespresso/dye2", branch: commit, updates: { how: "pinned", repo: "decentespresso/dye2", commit, url: null }, machines: 1 },
      { pluginId: "dye2.reaplugin", name: pinned.name, version: pinned.version, repo: "decentespresso/dye2", branch: "dist", updates: { how: "followsBranch", repo: "decentespresso/dye2", branch: "dist" }, machines: 1 },
    ]);
  });
});

describe("the recordings", () => {
  it("hold no token, and name the release they were recorded from", () => {
    const dir = new URL("./fixtures/decaid/tablet-software-v0.9.3/", import.meta.url);
    for (const file of ["plugin-management.json", "pending-update.json", "protected.json"]) {
      const text = fs.readFileSync(new URL(file, dir), "utf8");
      expect(text, file).not.toMatch(/Bearer [A-Za-z0-9]/);
    }
    expect(JSON.parse(fs.readFileSync(new URL("info.json", dir), "utf8"))).toMatchObject({ version: "0.9.3", fullVersion: "0.9.3+3265" });
  });
});
