import net from "node:net";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { SimulatedTablet, readBuiltPlugin } from "../../server/test/support/simulated-tablet.js";

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

  it("loads in a simulated tablet and returns from onLoad quickly, leaving the connection to a timer", async () => {
    const started = performance.now();
    const tablet = SimulatedTablet.load({ settings: { ServerUrl: "http://127.0.0.1:9", Token: "x" } });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(50);
    expect(tablet.plugin.version).toBe(manifest.version);
    expect(tablet.logs).toEqual([`Decent Sync ${manifest.version} loaded (protocol 1)`]);
    // Nothing listens on port 9, so the timer's connection attempt fails and backs off.
    await tablet.waitForLog(/^Disconnected: could not connect to ws:\/\/127\.0\.0\.1:9\/sync: .*Reconnecting in 1 s\.$/);
    await tablet.unload();
  });

  it("abandons and retries a connection whose server never answers the WebSocket upgrade", async () => {
    // Accepts TCP connections and then says nothing; Decaid's open() has no timeout of its own.
    const sockets: net.Socket[] = [];
    const stalled = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const { port } = stalled.address() as net.AddressInfo;
    // 100 times faster: the 15 s deadline passes in 150 ms and the 1 s backoff in 10 ms.
    const tablet = SimulatedTablet.load({ settings: { ServerUrl: `http://127.0.0.1:${port}`, Token: "x" }, timeScale: 100 });
    try {
      await tablet.waitForLog(/^Disconnected: the server did not answer within 15 s\. Reconnecting in 1 s\.$/, 5_000);
      const deadline = Date.now() + 5_000;
      while (sockets.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      // Later attempts may have started too; each one times out the same way.
      expect(sockets.length).toBeGreaterThanOrEqual(2);
    } finally {
      await tablet.unload();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => stalled.close(resolve));
    }
  });
});
