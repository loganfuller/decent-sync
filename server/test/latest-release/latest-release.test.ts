import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "../support/admin-api.js";
import { repoDir } from "../support/build-table.mjs";
import { latestReleaseDir, latestReleaseTag } from "../support/latest-release.mjs";
import { syncingTablet } from "../support/loaded-tablets.js";
import { derivedShot } from "../support/shot-fixtures.js";
import { derivedDe1Pro, readBuiltPlugin } from "../support/simulated-tablet.js";
import { type TestServer, startTestServer } from "../support/test-server.js";

// Seam 1 beside the latest release (ADR-0025): its server and its plugin,
// built from its tag by `npm run build:latest-release`, each with the
// change's, as during an upgrade. The two servers share one database, as an
// instance of each release does while a deploy moves traffic over. CI runs
// the tests in this directory in a job of their own, which builds the latest
// release first.

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/**
 * The checkout's plugin, or the latest release's as committed at its tag:
 * while main's version is still the latest release's, the plugin's version
 * can't tell them apart, so the tests check which directory each runs.
 */
const changePluginDir = path.join(repoDir, "decent-sync.reaplugin");
const releasePluginDir = () => path.join(latestReleaseDir(), "decent-sync.reaplugin");

describe("the latest release beside the change", () => {
  let change: TestServer;
  let release: TestServer;
  /** The Admin on the change's server, and on the latest release's. */
  let api: AdminApi;
  let releaseApi: AdminApi;

  beforeAll(async () => {
    change = await startTestServer({ env });
    release = await startTestServer({ env, sharing: change, latestRelease: true });
    api = await AdminApi.setUp(change.url);
    releaseApi = api.at(release.url);
    expect(change.buildDir).toBe(repoDir);
    expect(release.buildDir).toBe(latestReleaseDir());
  });
  afterAll(async () => {
    await change?.stop();
  });

  it("captures a Shot from a tablet running the latest release's plugin on the change's server", async () => {
    const machine = await api.createMachine("Uptown");
    const tablet = syncingTablet(machine, change, { latestRelease: true, api: derivedDe1Pro({ serial: "13001" }) });
    await tablet.waitForLog(/^Connected to /);
    expect(tablet.pluginDir).toBe(releasePluginDir());
    const committed = execFileSync("git", ["show", `${latestReleaseTag()}:decent-sync.reaplugin/plugin.js`], { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(fs.readFileSync(path.join(tablet.pluginDir, "plugin.js"), "utf8") === committed).toBe(true);
    expect(tablet.sent[0]).toMatchObject({ type: "hello", pluginVersion: latestReleaseTag().slice(1) });

    tablet.pullShot(derivedShot("latest-release-plugin-shot", { timestamp: "2026-11-01T12:00:00Z" }));
    await expect.poll(async () => (await api.call("GET", "/shots/latest-release-plugin-shot")).status).toBe(200);
  });

  it("welcomes the change's plugin on the latest release's server", async () => {
    const machine = await releaseApi.createMachine("Belmont");
    const tablet = syncingTablet(machine, release, { api: derivedDe1Pro({ serial: "13002" }) });
    expect(tablet.pluginDir).toBe(changePluginDir);
    await releaseApi.waitForMachine("Belmont", (viewed) => viewed.online);
    // Online once the server has accepted the hello, which it answers a query later, so the welcome may still be on its way.
    await expect.poll(() => tablet.received[0]).toMatchObject({ type: "welcome" });
    expect(tablet.sent[0]).toMatchObject({ type: "hello", pluginVersion: readBuiltPlugin().manifest.version });
  });
});
