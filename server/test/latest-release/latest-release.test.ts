import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "../support/admin-api.js";
import { latestReleaseTag } from "../support/latest-release.mjs";
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
  });
  afterAll(async () => {
    await change?.stop();
  });

  it("captures a Shot from a tablet running the latest release's plugin on the change's server", async () => {
    const machine = await api.createMachine("Uptown");
    const tablet = syncingTablet(machine, change, { latestRelease: true, api: derivedDe1Pro({ serial: "13001" }) });
    await tablet.waitForLog(/^Connected to /);
    expect(tablet.sent[0]).toMatchObject({ type: "hello", pluginVersion: latestReleaseTag().slice(1) });

    tablet.pullShot(derivedShot("latest-release-plugin-shot", { timestamp: "2026-11-01T12:00:00Z" }));
    await expect.poll(async () => (await api.call("GET", "/shots/latest-release-plugin-shot")).status).toBe(200);
  });

  it("welcomes the change's plugin on the latest release's server", async () => {
    const machine = await releaseApi.createMachine("Belmont");
    const tablet = syncingTablet(machine, release, { api: derivedDe1Pro({ serial: "13002" }) });
    await releaseApi.waitForMachine("Belmont", (viewed) => viewed.online);
    expect(tablet.received[0]).toMatchObject({ type: "welcome" });
    expect(tablet.sent[0]).toMatchObject({ type: "hello", pluginVersion: readBuiltPlugin().manifest.version });
  });
});
