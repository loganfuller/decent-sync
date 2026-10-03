import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { createStandInHost, loadPlugin, readBuiltPlugin } from "./stand-in-host.js";

describe("the built plugin", () => {
  const { source, manifest } = readBuiltPlugin();

  it("is an ES2020 script with no module syntax", () => {
    expect(() => parse(source, { ecmaVersion: 2020, sourceType: "script" })).not.toThrow();
  });

  it("loads in a stand-in host and returns from onLoad quickly", () => {
    const { host, logs } = createStandInHost();
    const plugin = loadPlugin(source, String(manifest.id), host);

    const started = performance.now();
    const result = plugin.onLoad({});
    const elapsed = performance.now() - started;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(50);
    expect(plugin.version).toBe(manifest.version);
    expect(logs).toEqual([`Decent Sync ${manifest.version} loaded (protocol 1)`]);
    expect(() => plugin.onUnload()).not.toThrow();
  });
});
