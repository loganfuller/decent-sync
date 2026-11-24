import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COLLECTION_NAMES,
  DECENT_SYNC_PLUGIN_ID,
  OWN_CHANGEABLE_SETTING,
  SOFTWARE_ACTIONS_WIRE_REVISION,
  SOFTWARE_ACTION_KINDS,
  type SoftwareActed,
  type SoftwareAction,
  WIRE_REVISION,
  decodePluginMessage,
  decodeServerMessage,
  isPluginRepo,
  isSecretState,
  isSkinUrl,
  isSkinViewKind,
  namesCommit,
  pluginSettingKey,
  pluginSettingOf,
  settingsHistoryChanges,
  settingsHistoryFields,
  softwareActionMs,
} from "../src/index.js";

// Software Actions on the wire (ADR-0034, #660): the message that asks the
// plugin for one and its answer, the read-back that names it, and the
// plugins' settings as a Settings History compares them.

const frame = (message: unknown) => JSON.stringify(message);
const id = "0199c5a4-6b7e-7c3d-9a1b-2c3d4e5f6a7b";

describe("a Software Action on the wire", () => {
  it("came in the wire revision after the latest release's, and names the plugin's own id and the one setting of its own it changes as its manifest does", () => {
    expect(SOFTWARE_ACTIONS_WIRE_REVISION).toBe(WIRE_REVISION);
    const manifest = JSON.parse(fs.readFileSync(new URL("../../plugin/manifest.json", import.meta.url), "utf8")) as { id: string; settings: Record<string, unknown>; permissions: string[] };
    expect(DECENT_SYNC_PLUGIN_ID).toBe(manifest.id);
    expect(Object.keys(manifest.settings)).toContain(OWN_CHANGEABLE_SETTING);
    expect(manifest.permissions).toContain("manage.extensions");
  });

  it("has two minutes for an install, an update check, an approval or the start of Decaid's update, and one for the rest", () => {
    const times = Object.fromEntries(SOFTWARE_ACTION_KINDS.map((kind) => [kind, softwareActionMs(kind)]));
    expect(times).toEqual({
      installPlugin: 120_000,
      enablePlugin: 60_000,
      disablePlugin: 60_000,
      changePluginSettings: 60_000,
      checkPluginUpdates: 120_000,
      approvePluginUpdate: 120_000,
      removePlugin: 60_000,
      installSkin: 120_000,
      chooseDefaultSkin: 60_000,
      checkSkinUpdates: 120_000,
      removeSkin: 60_000,
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
    ];
    for (const answer of answers) expect(decodePluginMessage(frame(answer)), JSON.stringify(answer)).toEqual({ ok: true, message: answer });
    expect(decodePluginMessage(frame({ ...answers[0], outcome: "installed" }))).toMatchObject({ ok: false, problem: "softwareActed.outcome must be one of done, refused, notConfirmed" });
    expect(decodePluginMessage(frame({ ...answers[11], reason: "decaid" }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.reason must be absent") });
    expect(decodePluginMessage(frame({ ...answers[11], result: { page: { skinId: "streamline.js", loadedAt: "yesterday" } } }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.result.page.loadedAt") });
    expect(decodePluginMessage(frame({ ...answers[0], reason: "decaid" }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.reason must be absent") });
    expect(decodePluginMessage(frame({ ...answers[4], state: "" }))).toMatchObject({ ok: false, problem: "softwareActed.state must not be empty" });
    expect(decodePluginMessage(frame({ type: "softwareActed", id, outcome: "refused", reason: "decaid", status: 500 }))).toMatchObject({ ok: false, problem: "softwareActed.message must be a string" });
    expect(decodePluginMessage(frame({ ...answers[1], result: { results: [{ item: 3, status: "updated" }] } }))).toMatchObject({ ok: false, problem: expect.stringContaining("softwareActed.result.results") });
  });

  it("names its read-back, of the plugin list, the plugins' settings or Decaid's update state, never beside a Settings Edit", () => {
    expect(COLLECTION_NAMES).toEqual(expect.arrayContaining(["plugins", "pluginSettings", "decaidUpdate"]));
    const readBack = { type: "collection", id: "delivery-1", name: "plugins", available: true, value: [], softwareActionId: id };
    expect(decodePluginMessage(frame(readBack))).toEqual({ ok: true, message: readBack });
    expect(decodePluginMessage(frame({ ...readBack, softwareActionId: "action-1" }))).toMatchObject({ ok: false, problem: "collection.softwareActionId must be a UUID" });
    expect(decodePluginMessage(frame({ ...readBack, settingsEditId: id }))).toMatchObject({ ok: false, problem: "collection.settingsEditId must be absent" });
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
