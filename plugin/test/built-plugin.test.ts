import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { SimulatedTablet, loadPlugin, readBuiltPlugin } from "../../server/test/support/simulated-tablet.js";

describe("the built plugin", () => {
  const { source, manifest } = readBuiltPlugin();

  it("is an ES2020 script with no module syntax", () => {
    expect(() => parse(source, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
  });

  it("declares the server URL, the token (secure) and the poll interval as its only settings", () => {
    const settings = manifest.settings as Record<string, { type: string; secure?: boolean }>;
    expect(Object.keys(settings)).toEqual(["ServerUrl", "Token", "PollSeconds"]);
    expect(settings.ServerUrl).toMatchObject({ type: "string" });
    expect(settings.Token).toMatchObject({ type: "string", secure: true });
    expect(settings.PollSeconds).toMatchObject({ type: "number", default: 30 });
  });

  it("returns from onLoad at once, leaving reading Decaid's API and connecting to timers", () => {
    const calls: string[] = [];
    const plugin = loadPlugin(source, String(manifest.id), {
      host: {
        log: () => {},
        transport: { open: () => calls.push("transport.open"), onEvent: () => {}, send: () => {}, close: () => {} },
      },
      fetch: () => {
        calls.push("fetch");
        return Promise.reject(new Error("No network"));
      },
      setTimeout: () => calls.push("setTimeout"),
      clearTimeout: () => {},
    });

    plugin.onLoad({ ServerUrl: "http://127.0.0.1:9", Token: "x" });
    expect(calls).toContain("setTimeout");
    expect(calls).not.toContain("fetch");
    expect(calls).not.toContain("transport.open");
  });

  it("loads in a simulated tablet, and tries to connect from its timer", async () => {
    const tablet = SimulatedTablet.load({ settings: { ServerUrl: "http://127.0.0.1:9", Token: "x" } });

    expect(tablet.plugin.version).toBe(manifest.version);
    expect(tablet.logs).toEqual([`Decent Sync ${manifest.version} loaded (protocol 1)`]);
    // Nothing listens on port 9, so the timer's connection attempt fails and backs off.
    await tablet.waitForLog(/^Disconnected: could not connect to ws:\/\/127\.0\.0\.1:9\/sync: .*Reconnecting in 1 s\.$/);
    await tablet.unload();
  });
});
