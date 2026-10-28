import { describe, expect, it } from "vitest";
import type { Report } from "../src/collections/paired-devices.js";
import { dye2View, streamlineView, tabletVersionsView } from "../src/collections/tablet-versions.js";
import { type PluginsAndSkinsStep, pluginsAndSkinsAt } from "./support/simulated-tablet.js";

// Module tests for ticket #236: the DYE2 and Streamline rows of the Machine
// page's Versions card, from the plugin list and Skins as Decaid v0.9.0's
// Linux release answered them (plugins-and-skins-v0.9.0/), or derived from
// them by the changes named.

type Record_ = Record<string, unknown>;

const pluginsAt = (step: PluginsAndSkinsStep) => pluginsAndSkinsAt(step)["/plugins"]!.body as Record_[];
/** The Skins collection as the plugin reports it after that step: `{ skins, default, server }`. */
function skinsAt(step: PluginsAndSkinsStep): { skins: Record_[]; default: Record_ | null; server: Record_ } {
  const answers = pluginsAndSkinsAt(step);
  const defaultSkin = answers["/webui/skins/default"]!;
  return {
    skins: answers["/webui/skins"]!.body as Record_[],
    default: defaultSkin.status === 200 ? (defaultSkin.body as Record_) : null,
    server: answers["/webui/server/status"]!.body as Record_,
  };
}
const reported = (value: unknown, at = new Date()): Report => ({ available: true, reportedAt: at, value, receivedAt: at });

describe("The Streamline row", () => {
  it("is the release's version while Decaid serves the release", () => {
    const skins = skinsAt("streamlineRelease");
    expect(skins.server.path).toBe(skins.skins.find((skin) => skin.id === "streamline.js")!.path);
    expect(streamlineView(skins)).toEqual({ status: "active", version: "0.2.18", build: "release" });
  });

  it("is a main build's version while Decaid serves its build of main, even with the release installed", () => {
    const skins = skinsAt("servedMain");
    expect(skins.skins.map((skin) => skin.id)).toEqual(expect.arrayContaining(["streamline.js", "streamline.js-dist"]));
    expect(streamlineView(skins)).toEqual({ status: "active", version: "0.2.18", build: "main" });
  });

  it("follows the Skin served, not the default, which counts only while nothing installed is served", () => {
    // The default switched to the main build, while Decaid still served the release until it served another folder.
    const switched = skinsAt("defaultSwitched");
    expect(switched.default!.id).toBe("streamline.js-dist");
    expect(streamlineView(switched)).toEqual({ status: "active", version: "0.2.18", build: "release" });
    // Serving nothing, Decaid's status names no path.
    const stopped = skinsAt("serverStopped");
    expect(stopped.server).toMatchObject({ serving: false, path: null });
    expect(streamlineView(stopped)).toEqual({ status: "active", version: "0.2.18", build: "main" });
    // Derived: serving a folder no Skin holds, as Decaid's --skin-path can.
    expect(streamlineView({ ...switched, server: { ...switched.server, path: "/data/skins/mine" } })).toEqual({
      status: "active",
      version: "0.2.18",
      build: "main",
    });
  });

  it("names the active Skin while another is", () => {
    expect(streamlineView(skinsAt("servedOther"))).toEqual({ status: "notActive", activeSkin: { name: "Passione", version: "0.9.6" } });
    // Derived: the default is another Skin, and nothing is served.
    const stopped = skinsAt("serverStopped");
    const passione = stopped.skins.find((skin) => skin.id === "passione")!;
    expect(streamlineView({ ...stopped, default: passione })).toEqual({ status: "notActive", activeSkin: { name: "Passione", version: "0.9.6" } });
  });

  it("is not installed while no Skin is Streamline, whichever is active", () => {
    // Derived: the Skins of the release's recording without either Streamline.
    const skins = skinsAt("servedOther");
    const others = skins.skins.filter((skin) => !String(skin.id).startsWith("streamline.js"));
    expect(others.length).toBeGreaterThan(0);
    expect(streamlineView({ ...skins, skins: others, default: others[0] })).toEqual({ status: "notInstalled" });
    // With no Skin installed, Decaid has no default, and the plugin reports none.
    expect(streamlineView({ skins: [], default: null, server: { serving: false, path: null, port: null, ip: null } })).toEqual({ status: "notInstalled" });
  });

  it("is not reported until the Skins are, and keeps their last value while they cannot be read", () => {
    const skins = skinsAt("servedMain");
    expect(tabletVersionsView({ plugins: null, skins: null }).streamline).toEqual({ status: "notReported" });
    const at = new Date();
    expect(tabletVersionsView({ plugins: null, skins: { available: false, reportedAt: at, value: null, receivedAt: null } }).streamline).toEqual({
      status: "notReported",
    });
    const kept = { available: false, reportedAt: at, value: skins, receivedAt: new Date(at.getTime() - 60_000) };
    expect(tabletVersionsView({ plugins: null, skins: kept }).streamline).toEqual({ status: "active", version: "0.2.18", build: "main" });
    // A value of another shape, as another Decaid version might send, reports nothing.
    expect(streamlineView({ skins: "none" })).toEqual({ status: "notReported" });
  });
});

describe("The DYE2 row", () => {
  it("is the version of DYE2 loaded", () => {
    expect(dye2View(pluginsAt("dye2Release"))).toEqual({ status: "installed", version: "0.1.26", loaded: true, branch: null });
    // Decaid's bundled DYE2, before any install.
    expect(dye2View(pluginsAt("started"))).toEqual({ status: "installed", version: "0.1.4", loaded: true, branch: null });
  });

  it("says when DYE2 is installed but not loaded", () => {
    expect(pluginsAt("dye2Disabled").find((plugin) => plugin.id === "dye2.reaplugin")).toMatchObject({ loaded: false, autoLoad: false });
    expect(dye2View(pluginsAt("dye2Disabled"))).toEqual({ status: "installed", version: "0.1.26", loaded: false, branch: null });
  });

  it("names the branch of a branch install", () => {
    expect(pluginsAt("dye2Branch").find((plugin) => plugin.id === "dye2.reaplugin")!.source).toMatchObject({ kind: "github_branch", branch: "dist" });
    expect(dye2View(pluginsAt("dye2Branch"))).toEqual({ status: "installed", version: "0.1.26", loaded: true, branch: "dist" });
  });

  it("is not installed while the plugin list has no DYE2", () => {
    // Derived: the release's plugin list without DYE2.
    const others = pluginsAt("dye2Release").filter((plugin) => plugin.id !== "dye2.reaplugin");
    expect(others.length).toBeGreaterThan(0);
    expect(dye2View(others)).toEqual({ status: "notInstalled" });
  });

  it("is not reported until the plugin list is", () => {
    expect(tabletVersionsView({ plugins: null, skins: null }).dye2).toEqual({ status: "notReported" });
    expect(tabletVersionsView({ plugins: reported(pluginsAt("dye2Release")), skins: null }).dye2).toMatchObject({ status: "installed" });
    expect(dye2View({ plugins: [] })).toEqual({ status: "notReported" });
  });
});
