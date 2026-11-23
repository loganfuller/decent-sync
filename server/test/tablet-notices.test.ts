import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { NotificationCenter } from "./support/decaid-notices.js";
import { SimulatedTablet, type SimulatedTabletOptions, derivedDe1Pro, readBuiltPlugin, settingsFor } from "./support/simulated-tablet.js";
import { StandInServer } from "./support/stand-in-server.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #540: the built plugin on a simulated tablet, against a real server or a stand-in, puts up one notice in
// Decaid's notification center while it has stopped syncing, and withdraws it once that ends. The center is the
// simulated tablet's (support/decaid-notices.ts), which follows what Decaid v0.9.3 was recorded doing
// (fixtures/decaid/notices-v0.9.3) and refuses what Decaid refuses, a message past 600 characters among it.
// Assertions read what the center holds, as the tablet shows it. Serials are made up, from 18001.

const PLUGIN = String(readBuiltPlugin().manifest.id);
const SAVED = "Shots still save on this tablet and will upload later.";
const MANAGER = "Someone who manages Decent Sync";
/** What the tablet shows, as docs/PLUGIN.md lists it. */
const NOTICES = {
  decaidTooOld: `${SAVED} Decent Sync stopped syncing because this tablet's Decaid is older than the Decent Sync server supports. ${MANAGER} can update Decaid on this tablet.`,
  pluginTooOld: `${SAVED} Decent Sync stopped syncing because this tablet's Decent Sync plugin is older than the server supports. ${MANAGER} can update the plugin.`,
  tokenRefused: `${SAVED} Decent Sync stopped syncing because the server refused the token in this plugin's settings. ${MANAGER} can enter this machine's current token there.`,
  hardwareDismissed: `${SAVED} Decent Sync stopped syncing because an Admin dismissed the espresso machine connected to this tablet for the token in this plugin's settings. ${MANAGER} can give this machine a token of its own.`,
  anotherTablet: `${SAVED} Decent Sync stopped syncing because another tablet is connected with this machine's token, and it starts again once that tablet disconnects. ${MANAGER} can check which tablet should use the token.`,
  unreachable: `${SAVED} Decent Sync has not reached its server for 10 minutes. Whoever looks after this tablet's network can check that it is online and can reach the server.`,
};
const TEN_MINUTES = 10 * 60_000;

/** What the tablet's notification center shows of the plugin's notices: their messages. */
const shown = (tablet: SimulatedTablet) => tablet.notices.shown(PLUGIN).map((notice) => notice.message);
/** The notices the plugin asked Decaid for, each the one id it keeps. */
const asked = (tablet: SimulatedTablet) =>
  tablet.notices.calls.flatMap((call) => (call.op === "notify" && call.pluginId === PLUGIN ? [call] : []));

async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves once the tablet shows this notice and only it, or none for null. */
async function showing(tablet: SimulatedTablet, message: string | null, timeoutMs?: number): Promise<void> {
  const expected = message === null ? [] : [message];
  await until(() => JSON.stringify(shown(tablet)) === JSON.stringify(expected), message === null ? "no notice" : `the notice "${message}"`, timeoutMs);
}

/** Resolves once the tablet's clock has passed `at`. */
const untilTabletTime = (tablet: SimulatedTablet, at: number, timeoutMs = 30_000) => until(() => tablet.readClock() >= at, `the tablet's clock to reach ${at}`, timeoutMs);

/** Every notice asked for was the plugin's one, accepted, and none is held beside it. */
function expectOneNotice(tablet: SimulatedTablet): void {
  expect(asked(tablet).every((call) => (call.notice as { id?: unknown }).id === "sync")).toBe(true);
  expect(tablet.notices.shown(PLUGIN).length).toBeLessThanOrEqual(1);
}

describe("Notices on the tablet", () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    // Heartbeats rare enough that a tablet whose timers run 120 times faster still hears one within its wait.
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: "30" } });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const load = (options: SimulatedTabletOptions) => SimulatedTablet.load(options);

  it("fits each notice in Decaid's limit, and the plugin guide lists each as the tablet shows it", () => {
    const guide = readFileSync(new URL("../../docs/PLUGIN.md", import.meta.url), "utf8");
    for (const message of Object.values(NOTICES)) {
      expect(message.length).toBeLessThanOrEqual(600);
      expect(guide).toContain(message);
    }
  });

  it("shows nothing for a plugin never given a server address and token, and withdraws what an earlier load put up", async () => {
    const fresh = load({ settings: {} });
    await fresh.waitForLog(/^Not connecting: Server URL is not set; Token is not set\./);
    expect(shown(fresh)).toEqual([]);
    expect(asked(fresh)).toEqual([]);

    // A notice an earlier load put up, before the settings were cleared.
    const notices = new NotificationCenter();
    notices.publish(PLUGIN, "Decent Sync", { id: "sync", message: NOTICES.tokenRefused });
    const cleared = load({ settings: { ServerUrl: server.url }, notices });
    await cleared.waitForLog(/^Not connecting: Token is not set\./);
    expect(shown(cleared)).toEqual([]);
  });

  it("says the token was refused, says it again after a reload, and withdraws it once a token the server takes is entered", async () => {
    const refused = load({ settings: { ServerUrl: server.url, Token: "not-a-token-this-server-issued" } });
    await refused.waitForLog(/^The server refused the token\./);
    await showing(refused, NOTICES.tokenRefused);
    expect(asked(refused)).toEqual([{ op: "notify", pluginId: PLUGIN, notice: { id: "sync", message: NOTICES.tokenRefused }, result: { id: "sync", status: "accepted" } }]);
    const [before] = refused.notices.shown(PLUGIN);

    // Decaid keeps the notice across the reload; the new load finds the token still refused and says the same,
    // which Decaid keeps as it was, unread or read.
    const reloaded = await refused.reload();
    await reloaded.waitForLog(/^The server refused the token\./);
    await until(() => asked(reloaded).length === 2, "the reloaded plugin's notice");
    expect(reloaded.notices.shown(PLUGIN)).toEqual([before]);

    const created = await api.createMachine("Token entered");
    const entered = await reloaded.reload({ settings: settingsFor(created) });
    await entered.waitForLog(/^Connected to /);
    await showing(entered, null);
    expectOneNotice(entered);
    await entered.unload();
  });

  it("says Decaid is older than the server supports", async () => {
    const created = await api.createMachine("Old Decaid");
    const tablet = load({ settings: settingsFor(created), api: derivedDe1Pro({ decaidVersion: "0.9.2+3191" }) });
    await tablet.waitForLog(/^The server needs a newer version of Decaid\./);
    await showing(tablet, NOTICES.decaidTooOld);
    expectOneNotice(tablet);
  });

  it("says the plugin is older than the server supports", async () => {
    const refusing = await StandInServer.start({
      refuse: { code: "plugin_too_old", message: "This plugin speaks wire revision 1, but this server needs 4 or newer: update the plugin" },
    });
    try {
      const tablet = load({ settings: { ServerUrl: refusing.url, Token: "any" } });
      await tablet.waitForLog(/^The server needs a newer version of this plugin\./);
      await showing(tablet, NOTICES.pluginTooOld);
      expectOneNotice(tablet);
    } finally {
      await refusing.stop();
    }
  });

  it("says an Admin dismissed this hardware, and withdraws it within one poll of the machine reporting other hardware", async () => {
    const cafe = await api.createMachine("Dismissed");
    // 25 times faster: the 5 s poll runs every 200 ms.
    const tablet = load({ settings: { ...settingsFor(cafe), PollSeconds: 5 }, api: derivedDe1Pro({ serial: "18001" }), timeScale: 25 });
    await api.waitForMachine("Dismissed", (machine) => machine.online && machine.identification === "identified");
    tablet.serve(derivedDe1Pro({ serial: "18002" }));
    await api.waitForMachine("Dismissed", (machine) => machine.online && machine.identification === "mismatch");
    const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "18002")!;
    expect((await api.call("POST", `/pending-machines/${pending.id}/dismiss`)).status).toBe(200);
    await tablet.waitForLog(/^The server refused this machine's hardware for this Machine's token\./);
    await showing(tablet, NOTICES.hardwareDismissed);

    // Polls keep finding the dismissed hardware, and the notice is asked for once.
    const polled = tablet.readClock() + 3 * 5_000;
    await untilTabletTime(tablet, polled);
    expect(asked(tablet)).toHaveLength(1);

    const served = tablet.readClock();
    tablet.serve(derivedDe1Pro({ serial: "18001" }));
    await showing(tablet, null);
    // Within the poll interval, and a little for the check itself.
    expect(tablet.readClock() - served).toBeLessThan(5_000 + 1_000);
    await api.waitForMachine("Dismissed", (machine) => machine.online && machine.identification === "identified");
    expectOneNotice(tablet);
  });

  describe("while another tablet holds the Machine", () => {
    /** The plugin's 5-minute wait before each `yielding` hello takes 3 s at this pace. */
    const TIME_SCALE = 100;

    it("says so, once however many of its hellos are refused, and withdraws it once that tablet goes", async () => {
      const created = await api.createMachine("Held");
      const first = load({ settings: settingsFor(created), timeScale: TIME_SCALE, api: derivedDe1Pro({ serial: "18101", connectionId: "00:00:5E:00:53:C1" }) });
      await first.waitForLog(/^Connected to /);
      const second = load({ settings: settingsFor(created), machineConnected: false, api: derivedDe1Pro({ serial: "18101", connectionId: "00:00:5E:00:53:C2" }) });
      await second.waitForLog(/^Connected to /);

      await showing(first, NOTICES.anotherTablet);
      await first.waitForLogs(/^Another tablet is still connected with this Machine's token\./, 2, 20_000);
      expect(asked(first)).toHaveLength(1);
      // The tablet that took over shows nothing.
      expect(shown(second)).toEqual([]);

      await second.unload();
      await first.waitForLogs(/^Connected to /, 2, 20_000);
      await showing(first, null);
      expectOneNotice(first);
    });

    it("logs a notice Decaid refuses, and does not ask for it again while the same holds", async () => {
      const created = await api.createMachine("Held, notice refused");
      const first = load({ settings: settingsFor(created), timeScale: TIME_SCALE, api: derivedDe1Pro({ serial: "18111" }) });
      await first.waitForLog(/^Connected to /);
      first.notices.failNextSaves(1);
      const second = load({ settings: settingsFor(created), machineConnected: false });
      await second.waitForLog(/^Connected to /);

      await first.waitForLog(/^Decaid did not keep the notice on the tablet that another tablet holds the Machine \(storage\)\./);
      await first.waitForLogs(/^Another tablet is still connected with this Machine's token\./, 2, 20_000);
      expect(asked(first).map((call) => call.result)).toEqual([{ id: "sync", status: "rejected", reason: "storage" }]);
      expect(shown(first)).toEqual([]);
    });
  });

  describe("while the server is out of reach", () => {
    /** Ten minutes of the tablet's take 5 s. */
    const TIME_SCALE = 120;

    it("says nothing for a drop shorter than 10 minutes, counts them anew from a reconnect, and says so after 10 without a break until it reconnects", async () => {
      const created = await api.createMachine("Out of reach");
      const tablet = load({ settings: { ...settingsFor(created), PollSeconds: 30 }, timeScale: TIME_SCALE });
      await tablet.waitForLog(/^Connected to /);

      // Eight minutes out of reach, then back.
      const firstLost = tablet.readClock();
      tablet.loseNetwork();
      await untilTabletTime(tablet, firstLost + 8 * 60_000);
      expect(shown(tablet)).toEqual([]);
      tablet.restoreNetwork();
      await tablet.waitForLogs(/^Connected to /, 2, 20_000);

      // Eight more, sixteen in all but with a reconnect between: still nothing.
      const lost = tablet.readClock();
      tablet.loseNetwork();
      await untilTabletTime(tablet, lost + 8 * 60_000);
      expect(shown(tablet)).toEqual([]);
      expect(asked(tablet)).toEqual([]);

      await showing(tablet, NOTICES.unreachable, 20_000);
      expect(tablet.readClock() - lost).toBeGreaterThanOrEqual(TEN_MINUTES);
      // One backoff interval (at most 60 s) at most past the ten minutes, and a little for the check.
      expect(tablet.readClock() - lost).toBeLessThan(TEN_MINUTES + 60_000 + 30_000);

      // Its attempts keep failing, and the notice is asked for once.
      await untilTabletTime(tablet, tablet.readClock() + 3 * 60_000);
      expect(asked(tablet)).toHaveLength(1);

      tablet.restoreNetwork();
      await tablet.waitForLogs(/^Connected to /, 3, 20_000);
      await showing(tablet, null);
      expectOneNotice(tablet);
    });

    it("counts the 10 minutes from a load whose first attempts fail, withdrawing what an earlier load left up", async () => {
      const created = await api.createMachine("Out of reach at load");
      const notices = new NotificationCenter();
      notices.publish(PLUGIN, "Decent Sync", { id: "sync", message: NOTICES.unreachable });
      const tablet = load({ settings: { ...settingsFor(created), PollSeconds: 30 }, timeScale: TIME_SCALE, notices });
      const loaded = tablet.readClock();
      tablet.loseNetwork();
      await tablet.waitForLog(/^Disconnected: /);
      await showing(tablet, null);
      await showing(tablet, NOTICES.unreachable, 20_000);
      expect(tablet.readClock() - loaded).toBeGreaterThanOrEqual(TEN_MINUTES);
      expectOneNotice(tablet);
    });
  });
});
