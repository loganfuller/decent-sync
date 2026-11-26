import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COLLECTION_NAMES,
  DECENT_SYNC_PLUGIN_ID,
  OWN_CHANGEABLE_SETTING,
  DECENT_SYNC_REPO,
  SOFTWARE_ACTION_KINDS,
  type SoftwareActed,
  type SoftwareAction,
  WIRE_REVISION,
  commitArchiveUrl,
  decodePluginMessage,
  decodeServerMessage,
  isPluginRepo,
  isSecretState,
  isSkinUrl,
  isSkinViewKind,
  isSourceChangeKind,
  namesCommit,
  pluginSourceSeen,
  pluginSettingKey,
  pluginSettingOf,
  releaseAssetOf,
  sameSourceSeen,
  settingsHistoryChanges,
  settingsHistoryFields,
  skinSourceSeen,
  softwareActionMs,
} from "../src/index.js";

// Software Actions on the wire (ADR-0034, #660): the message that asks the
// plugin for one and its answer, the read-back that names it, and the
// plugins' settings as a Settings History compares them.

const frame = (message: unknown) => JSON.stringify(message);
const id = "0199c5a4-6b7e-7c3d-9a1b-2c3d4e5f6a7b";
const CAFE_ASSET = "https://github.com/loganfuller/streamline-cafe-js/releases/download/v0.2.31-cafe.2/streamline-cafe.js-v0.2.31-cafe.2.zip";
/** A plugin following a branch and a Skin Pinned at a release's tag, each as a change of how it updates carries what the Admin saw. */
const seenPlugin = { version: "0.1.42", kind: "github_branch", repo: "decentespresso/dye2", branch: "dist", commit: "3a4083728302b3d30e108718cc690d34a13debb0", releaseTag: null };
const seenSkin = { version: "0.2.31-cafe.2", sourceUrl: CAFE_ASSET, etag: '"0x8DF4822E30A23B6"' };

describe("a Software Action on the wire", () => {
  it("names the plugin's own id and the one setting of its own it changes as its manifest does", () => {
    expect(SOFTWARE_ACTION_KINDS.filter(isSourceChangeKind)).toEqual(["changePluginSource", "changeSkinSource"]);
    expect(isPluginRepo(DECENT_SYNC_REPO)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(new URL("../../plugin/manifest.json", import.meta.url), "utf8")) as { id: string; settings: Record<string, unknown>; permissions: string[] };
    expect(DECENT_SYNC_PLUGIN_ID).toBe(manifest.id);
    expect(Object.keys(manifest.settings)).toContain(OWN_CHANGEABLE_SETTING);
    expect(manifest.permissions).toContain("manage.extensions");
  });

  it("has two minutes for an install, an update check, an approval, a change of how an item updates or the start of Decaid's update, and one for the rest", () => {
    const times = Object.fromEntries(SOFTWARE_ACTION_KINDS.map((kind) => [kind, softwareActionMs(kind)]));
    expect(times).toEqual({
      installPlugin: 120_000,
      enablePlugin: 60_000,
      disablePlugin: 60_000,
      changePluginSettings: 60_000,
      checkPluginUpdates: 120_000,
      approvePluginUpdate: 120_000,
      removePlugin: 60_000,
      changePluginSource: 120_000,
      installSkin: 120_000,
      chooseDefaultSkin: 60_000,
      checkSkinUpdates: 120_000,
      removeSkin: 60_000,
      changeSkinSource: 120_000,
      reloadSkin: 60_000,
      restartSkinView: 60_000,
      checkDecaidUpdate: 120_000,
      startDecaidUpdate: 120_000,
    });
    expect(softwareActionMs("a kind of a later release")).toBe(60_000);
  });

  it("is decoded for each kind with what it names, and refused without it, naming the field and never its value", () => {
    const actions: SoftwareAction[] = [
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "installPlugin", repo: "decentespresso/dye2" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "installPlugin", repo: "decentespresso/dye2", branch: "717fa95" },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "enablePlugin", pluginId: "dye2.reaplugin" },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "disablePlugin", pluginId: "dye2.reaplugin" },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "removePlugin", pluginId: "dye2.reaplugin" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "approvePluginUpdate", pluginId: "dye2.reaplugin", version: "0.1.43", addedPermissions: ["notifications"] },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "changePluginSettings", pluginId: "visualizer.reaplugin", values: { Password: "a secret", Username: null }, expected: { Password: { isSet: false }, Username: "sam" } },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "checkPluginUpdates" },
      { type: "softwareAction", id, timeLeftMs: 0, kind: "checkDecaidUpdate" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "installSkin", repo: "loganfuller/streamline-cafe-js" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "installSkin", repo: "decentespresso/streamline-js", branch: "dist" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "installSkin", url: "https://github.com/loganfuller/streamline-cafe-js/archive/d7729dc9532ae31d606447ee0648e20284268b2c.zip" },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "chooseDefaultSkin", skinId: "streamline-cafe.js" },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "removeSkin", skinId: "streamline-cafe.js-dist" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "checkSkinUpdates" },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "reloadSkin" },
      { type: "softwareAction", id, timeLeftMs: 59_000, kind: "restartSkinView" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "startDecaidUpdate" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "changePluginSource", pluginId: "dye2.reaplugin", expected: seenPlugin, repo: "decentespresso/dye2" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "changePluginSource", pluginId: "dye2.reaplugin", expected: seenPlugin, repo: "decentespresso/dye2", branch: "3a4083728302b3d30e108718cc690d34a13debb0" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "changeSkinSource", skinId: "streamline-cafe.js", expected: seenSkin, repo: "loganfuller/streamline-cafe-js" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "changeSkinSource", skinId: "streamline-cafe.js", expected: seenSkin, repo: "loganfuller/streamline-cafe-js", branch: "dist" },
      { type: "softwareAction", id, timeLeftMs: 119_000, kind: "changeSkinSource", skinId: "streamline-cafe.js", expected: seenSkin, url: CAFE_ASSET },
    ];
    for (const action of actions) expect(decodeServerMessage(frame(action)), action.kind).toEqual({ ok: true, message: action });
    expect(decodeServerMessage(frame({ ...actions[0], repo: "not a repository" }))).toMatchObject({ ok: false, problem: "softwareAction.repo must be a GitHub repository, as owner/name" });
    expect(decodeServerMessage(frame({ ...actions[2], pluginId: "" }))).toMatchObject({ ok: false, problem: "softwareAction.pluginId must not be empty" });
    expect(decodeServerMessage(frame({ ...actions[6], values: "a secret" }))).toMatchObject({ ok: false, problem: "softwareAction.values must be an object" });
    expect(decodeServerMessage(frame({ ...actions[7], kind: "rebootTablet" }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareAction.kind must be one of installPlugin") });
    expect(decodeServerMessage(frame({ ...actions[7], id: "action-1" }))).toMatchObject({ ok: false, problem: "softwareAction.id must be a UUID" });
    expect(decodeServerMessage(frame({ ...actions[7], timeLeftMs: -1 }))).toMatchObject({ ok: false, problem: "softwareAction.timeLeftMs must not be negative" });
    // A Skin is installed from a repository or a URL, never both.
    expect(decodeServerMessage(frame({ ...actions[11], repo: "loganfuller/streamline-cafe-js" }))).toMatchObject({ ok: false, problem: "softwareAction.repo must be absent" });
    expect(decodeServerMessage(frame({ ...actions[11], url: "file:///sdcard/skin.zip" }))).toMatchObject({ ok: false, problem: "softwareAction.url must be an http or https URL" });
    expect(decodeServerMessage(frame({ ...actions[12], skinId: "" }))).toMatchObject({ ok: false, problem: "softwareAction.skinId must not be empty" });
    // A change of how an item updates names the item, the source it was seen at and the source it goes to.
    expect(decodeServerMessage(frame({ ...actions[18], expected: undefined }))).toMatchObject({ ok: false, problem: "softwareAction.expected must be an object" });
    expect(decodeServerMessage(frame({ ...actions[18], repo: undefined }))).toMatchObject({ ok: false, problem: "softwareAction.repo must be a GitHub repository, as owner/name" });
    expect(decodeServerMessage(frame({ ...actions[18], pluginId: undefined }))).toMatchObject({ ok: false, problem: "softwareAction.pluginId must be a string" });
    expect(decodeServerMessage(frame({ ...actions[22], repo: "loganfuller/streamline-cafe-js" }))).toMatchObject({ ok: false, problem: "softwareAction.repo must be absent" });
    expect(decodeServerMessage(frame({ ...actions[20], skinId: undefined }))).toMatchObject({ ok: false, problem: "softwareAction.skinId must be a string" });
  });

  it("reads the source and build an item is at from its entry in Decaid's list, and compares two whole", () => {
    const dye2 = { id: "dye2.reaplugin", version: "0.1.42", source: { kind: "github_branch", repo: "decentespresso/dye2", branch: "dist", commit: "3a4083728302b3d30e108718cc690d34a13debb0", releaseTag: null, installedAt: "2026-11-23T20:00:27.292167", lastChecked: "2026-11-23T20:00:27.292167" } };
    expect(pluginSourceSeen(dye2)).toEqual(seenPlugin);
    // When Decaid installed or last checked it is no part of it, so an update check that finds it current leaves it the same.
    expect(sameSourceSeen(pluginSourceSeen({ ...dye2, source: { ...dye2.source, lastChecked: "2026-11-25T08:00:00.000000" } }), seenPlugin)).toBe(true);
    expect(sameSourceSeen(pluginSourceSeen({ ...dye2, source: { ...dye2.source, commit: "717fa95000000000000000000000000000000000" } }), seenPlugin)).toBe(false);
    expect(sameSourceSeen(pluginSourceSeen({ ...dye2, version: "0.1.43" }), seenPlugin)).toBe(false);
    // One with no recorded source, as a plugin Decaid bundles.
    expect(pluginSourceSeen({ id: "settings.reaplugin", version: "1.0.0", source: null })).toEqual({ version: "1.0.0", kind: null, repo: null, branch: null, commit: null, releaseTag: null });
    expect(pluginSourceSeen("not an entry")).toEqual({ version: null, kind: null, repo: null, branch: null, commit: null, releaseTag: null });
    const cafe = { id: "streamline-cafe.js", version: "0.2.31-cafe.2", reaMetadata: { sourceUrl: CAFE_ASSET, etag: '"0x8DF4822E30A23B6"', lastChecked: "2026-11-24T14:10:42.781047" } };
    expect(skinSourceSeen(cafe)).toEqual(seenSkin);
    expect(sameSourceSeen(skinSourceSeen({ ...cafe, reaMetadata: { ...cafe.reaMetadata, etag: '"another"' } }), seenSkin)).toBe(false);
    expect(sameSourceSeen(skinSourceSeen({ ...cafe, reaMetadata: { ...cafe.reaMetadata, lastChecked: "2026-11-25T08:00:00.000000" } }), seenSkin)).toBe(true);
    // A field one side lacks counts as none, so a later release may read more of an entry.
    expect(sameSourceSeen({ version: "1.0.0", sourceUrl: null }, { version: "1.0.0" })).toBe(true);
    expect(skinSourceSeen({ id: "insight", isBundled: true })).toEqual({ version: null, sourceUrl: null, etag: null });
    expect(commitArchiveUrl("loganfuller/streamline-cafe-js", "d7729dc9532ae31d606447ee0648e20284268b2c")).toBe("https://github.com/loganfuller/streamline-cafe-js/archive/d7729dc9532ae31d606447ee0648e20284268b2c.zip");
  });

  it("opens Reload and the restart, and only those, to Staff and assistants, and knows a URL a Skin installs from", () => {
    expect(SOFTWARE_ACTION_KINDS.filter(isSkinViewKind)).toEqual(["reloadSkin", "restartSkinView"]);
    for (const url of ["https://github.com/a/b/archive/main.zip", "http://192.168.1.20:8000/skin.zip?x=1"]) expect(isSkinUrl(url), url).toBe(true);
    for (const url of ["github.com/a/b.zip", "ftp://x/y.zip", "https://", "https://a b/c.zip", 3]) expect(isSkinUrl(url), String(url)).toBe(false);
  });

  it("is answered as done, with what came of it, or refused, with why", () => {
    const answers: SoftwareActed[] = [
      { type: "softwareActed", id, outcome: "done", result: { pluginId: "dye2.reaplugin", version: "0.1.43", loaded: true } },
      { type: "softwareActed", id, outcome: "done", result: { results: [{ item: "dye2.reaplugin", status: "updated", version: "0.1.43" }, { item: "x.reaplugin", status: "failed", error: "Try again." }] } },
      { type: "softwareActed", id, outcome: "done", result: { decaid: { phase: "available", latestVersion: "0.9.4" } } },
      { type: "softwareActed", id, outcome: "done" },
      { type: "softwareActed", id, outcome: "refused", reason: "machineBusy", state: "espresso" },
      { type: "softwareActed", id, outcome: "refused", reason: "changedSince", message: "Changed on the Tablet since the form was shown: Username" },
      { type: "softwareActed", id, outcome: "refused", reason: "expired" },
      { type: "softwareActed", id, outcome: "refused", reason: "notAllowed", message: "The Decent Sync plugin does not disable itself" },
      { type: "softwareActed", id, outcome: "refused", reason: "decaid", status: 500, message: "Couldn't install the plugin." },
      { type: "softwareActed", id, outcome: "refused", reason: "decaid", status: null, message: "Decaid did not answer" },
      { type: "softwareActed", id, outcome: "done", result: { skinId: "streamline-cafe.js", name: "Streamline Cafe", version: "0.2.31-cafe.1" } },
      { type: "softwareActed", id, outcome: "done", result: { skinId: "streamline.js", version: "0.2.32", page: { skinId: "streamline.js", version: "0.2.32", loadedAt: "2026-11-24T14:00:00.000Z" } } },
      { type: "softwareActed", id, outcome: "notConfirmed", message: "The Skin was asked to reload, but no fresh page reported in within 15 s" },
      { type: "softwareActed", id, outcome: "refused", reason: "installNotPermitted", message: "Installation requires approval on the Android device" },
      { type: "softwareActed", id, outcome: "refused", reason: "noSkinServed", message: "Decaid's Skin server did not start again" },
      { type: "softwareActed", id, outcome: "refused", reason: "differentItem", message: "That source holds another Skin, Nova, not NSX" },
      { type: "softwareActed", id, outcome: "done", result: { skinId: "streamline-cafe.js", name: "Streamline Cafe", version: "0.2.32-cafe.1", previousVersion: "0.2.31-cafe.2" } },
      { type: "softwareActed", id, outcome: "done", result: { pluginId: "dye2.reaplugin", version: "0.1.43", previousVersion: "0.1.42", loaded: true, addedPermissions: ["notifications"] } },
    ];
    for (const answer of answers) expect(decodePluginMessage(frame(answer)), JSON.stringify(answer)).toEqual({ ok: true, message: answer });
    expect(decodePluginMessage(frame({ ...answers[0], outcome: "installed" }))).toMatchObject({ ok: false, problem: "softwareActed.outcome must be one of done, refused, notConfirmed" });
    expect(decodePluginMessage(frame({ ...answers[11], reason: "decaid" }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.reason must be absent") });
    expect(decodePluginMessage(frame({ ...answers[11], result: { page: { skinId: "streamline.js", loadedAt: "yesterday" } } }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.result.page.loadedAt") });
    expect(decodePluginMessage(frame({ ...answers[0], reason: "decaid" }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.reason must be absent") });
    expect(decodePluginMessage(frame({ ...answers[4], state: "" }))).toMatchObject({ ok: false, problem: "softwareActed.state must not be empty" });
    expect(decodePluginMessage(frame({ type: "softwareActed", id, outcome: "refused", reason: "decaid", status: 500 }))).toMatchObject({ ok: false, problem: "softwareActed.message must be a string" });
    expect(decodePluginMessage(frame({ ...answers[1], result: { results: [{ item: 3, status: "updated" }] } }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.result.results") });
    expect(decodePluginMessage(frame({ ...answers[17], result: { pluginId: "dye2.reaplugin", addedPermissions: [3] } }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.result.addedPermissions") });
    expect(decodePluginMessage(frame({ ...answers[16], result: { skinId: "streamline-cafe.js", previousVersion: 2 } }))).toMatchObject({ ok: false, problem: "softwareActed.result.previousVersion must be a string" });
  });

  it("names its read-back, of the plugin list, the plugins' settings or Decaid's update state, never beside a Settings Edit", () => {
    expect(COLLECTION_NAMES).toEqual(expect.arrayContaining(["plugins", "pluginSettings", "decaidUpdate"]));
    const readBack = { type: "collection", id: "delivery-1", name: "plugins", available: true, value: [], softwareActionId: id };
    expect(decodePluginMessage(frame(readBack))).toEqual({ ok: true, message: readBack });
    expect(decodePluginMessage(frame({ ...readBack, softwareActionId: "action-1" }))).toMatchObject({ ok: false, problem: "collection.softwareActionId must be a UUID" });
    expect(decodePluginMessage(frame({ ...readBack, settingsEditId: id }))).toMatchObject({ ok: false, problem: "collection.settingsEditId must be absent" });
  });

  it("knows one GitHub release's download by its URL, with its repository and tag, and no other URL as one", () => {
    const cafe = "https://github.com/loganfuller/streamline-cafe-js/releases/download/v0.2.31-cafe.2/streamline-cafe.js-v0.2.31-cafe.2.zip";
    expect(releaseAssetOf(cafe)).toEqual({ repo: "loganfuller/streamline-cafe-js", tag: "v0.2.31-cafe.2" });
    expect(releaseAssetOf("https://github.com/decentespresso/streamline-js/releases/download/v0.2.31/streamline.zip")).toEqual({ repo: "decentespresso/streamline-js", tag: "v0.2.31" });
    // The host in any case or with www, a query after the file, and a tag written encoded.
    expect(releaseAssetOf("HTTPS://WWW.GitHub.com/example/skin/releases/download/2026.11/skin.zip?download=1")).toEqual({ repo: "example/skin", tag: "2026.11" });
    expect(releaseAssetOf("https://github.com/example/skin/releases/download/v1.0.0%2Bbuild.5/skin.zip")).toEqual({ repo: "example/skin", tag: "v1.0.0+build.5" });
    expect(releaseAssetOf("https://github.com/example/skin/releases/download/100%/skin.zip")).toEqual({ repo: "example/skin", tag: "100%" });
    // A tag with a slash, written encoded, is one path segment; written as a slash it is not, below.
    expect(releaseAssetOf("https://github.com/example/skin/releases/download/release%2F1.0/skin.zip")).toEqual({ repo: "example/skin", tag: "release/1.0" });
    for (const other of [
      // Another host, however alike its path or name.
      "https://gitlab.com/example/skin/releases/download/v1.0.0/skin.zip",
      "https://skins.example/example/skin/releases/download/v1.0.0/skin.zip",
      "https://github.com.skins.example/example/skin/releases/download/v1.0.0/skin.zip",
      "https://notgithub.com/example/skin/releases/download/v1.0.0/skin.zip",
      "https://objects.githubusercontent.com/example/skin/releases/download/v1.0.0/skin.zip",
      // The latest release's download moves with each release.
      "https://github.com/example/skin/releases/latest/download/skin.zip",
      // A tag with a slash written as one, a commit's or a branch's archive, a release's page, and a download with no file.
      "https://github.com/example/skin/releases/download/release/1.0/skin.zip",
      "https://github.com/example/skin/archive/97da8f8a1b2c3d4e5f60718293a4b5c6d7e8f901.zip",
      "https://github.com/example/skin/archive/refs/heads/main.zip",
      "https://github.com/example/skin/releases/tag/v1.0.0",
      "https://github.com/example/skin/releases/download/v1.0.0/",
      "https://github.com/example/skin/releases/download/v1.0.0",
      "github_release:example/skin@v1.0.0",
      "",
      null,
      3,
    ])
      expect(releaseAssetOf(other), String(other)).toBeNull();
  });

  it("knows a repository, a commit and a secret's state", () => {
    for (const repo of ["decentespresso/dye2", "loganfuller/decent-sync", "a/b.c_d-e"]) expect(isPluginRepo(repo), repo).toBe(true);
    for (const repo of ["dye2", "https://github.com/decentespresso/dye2", "a/b/c", "a b/c", "", 3, "-a/b"]) expect(isPluginRepo(repo), String(repo)).toBe(false);
    expect(namesCommit("717fa95")).toBe(true);
    expect(namesCommit("3a4083728302b3d30e108718cc690d34a13debb0")).toBe(true);
    for (const branch of ["dist", "main", "717fa9", "feature-717fa95"]) expect(namesCommit(branch), branch).toBe(false);
    expect(isSecretState({ isSet: true })).toBe(true);
    for (const value of [{ isSet: "yes" }, { hidden: true }, null, "set", [{ isSet: true }]]) expect(isSecretState(value)).toBe(false);
  });
});

describe("the plugins' settings in a Settings History", () => {
  const own = { declared: ["ServerUrl", "Token", "PollSeconds"], values: { ServerUrl: "https://sync.example", PollSeconds: 30, Token: { isSet: true } } };
  const declared = ["Username", "Password", "LengthThreshold"];
  const before = { "visualizer.reaplugin": { declared, values: { Username: "sam", Password: { isSet: false } } }, "decent-sync.reaplugin": own };
  const after = { "visualizer.reaplugin": { declared, values: { Username: "alex", Password: { isSet: true }, LengthThreshold: 7 } }, "decent-sync.reaplugin": own };

  it("are a field for each setting, keyed by its plugin and its name", () => {
    expect(settingsHistoryFields("pluginSettings", before)).toEqual({
      "visualizer.reaplugin/Username": "sam",
      "visualizer.reaplugin/Password": { isSet: false },
      "decent-sync.reaplugin/ServerUrl": "https://sync.example",
      "decent-sync.reaplugin/PollSeconds": 30,
      "decent-sync.reaplugin/Token": { isSet: true },
    });
    expect(pluginSettingOf(pluginSettingKey("visualizer.reaplugin", "a/b"))).toEqual({ pluginId: "visualizer.reaplugin", setting: "a/b" });
    expect(pluginSettingOf("no slash")).toBeNull();
    // The names a plugin declares, and their order, are no setting's change.
    expect(settingsHistoryFields("pluginSettings", { ...before, "visualizer.reaplugin": { ...before["visualizer.reaplugin"], declared: [...declared].reverse() } })).toEqual(settingsHistoryFields("pluginSettings", before));
    // A value in no such shape is one field, as any other collection's.
    expect(settingsHistoryFields("pluginSettings", ["not", "settings"])).toEqual({ "": ["not", "settings"] });
  });

  it("change as one change of the Software Action whose read-back held them, which is never brief", () => {
    const values = [
      { value: before, receivedAt: 0, settingsEditId: null, editedFields: [] },
      { value: after, receivedAt: 30_000, settingsEditId: null, softwareActionId: id, editedFields: ["visualizer.reaplugin/Username", "visualizer.reaplugin/Password", "visualizer.reaplugin/LengthThreshold"] },
      // Put back from the Tablet within the time a brief change takes: its own change, the action's not folded.
      { value: before, receivedAt: 60_000, settingsEditId: null, editedFields: [] },
    ];
    const changes = settingsHistoryChanges("pluginSettings", values);
    expect(changes).toMatchObject([
      { index: 1, settingsEditId: null, softwareActionId: id, fields: [{ field: "visualizer.reaplugin/Username", before: "sam", after: "alex", backAt: null }, { field: "visualizer.reaplugin/Password" }, { field: "visualizer.reaplugin/LengthThreshold", change: "added" }] },
      { index: 2, settingsEditId: null, softwareActionId: null, fields: [{ field: "visualizer.reaplugin/Username", backAt: null }, { field: "visualizer.reaplugin/Password" }, { field: "visualizer.reaplugin/LengthThreshold", change: "removed" }] },
    ]);
  });
});
