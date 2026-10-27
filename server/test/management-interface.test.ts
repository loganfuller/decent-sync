import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Ticket #293: the server sends the management interface's index.html for any
// path outside the API that matches no file of its build, so deep links such
// as /machines open the page, even when the build sits under a directory whose
// name starts with a dot, as a T3 worktree under ~/.t3/ does. CI's checkout has
// no such segment, so the test writes a small build of its own under one. A
// preload fails reads of its `vanishing-*` file, as a rebuild removing it would.
// Ticket #283: every response names the build in its Decent-Sync-Build header,
// as the build's index.html names it, so a page can follow it (ADR-0025).

const BUILD = "0f1e2d3c4b5a6978";
const INDEX = `<!doctype html><title>Decent Sync</title><meta name="decent-sync-build" content="${BUILD}">`;
const APP = "console.log('app');";
const vanishingFiles = path.join(path.dirname(fileURLToPath(import.meta.url)), "support/vanishing-files.mjs");

describe("The management interface", () => {
  const dir = path.join(os.tmpdir(), `.decent-sync-web-${randomBytes(6).toString("hex")}`);
  let server: TestServer;

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), INDEX);
    fs.writeFileSync(path.join(dir, "assets/app.js"), APP);
    fs.writeFileSync(path.join(dir, "assets/vanishing-5678.js"), APP);
    server = await startTestServer({ env: { WEB_DIST_DIR: dir, NODE_OPTIONS: `--import=${pathToFileURL(vanishingFiles).href}` } });
  });
  afterAll(async () => {
    await server?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (urlPath: string, method = "GET") => fetch(`${server.url}${urlPath}`, { method });

  async function expectIndex(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toBe(INDEX);
  }

  async function expectNotFound(response: Response, message: string) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message, error: "Not Found", statusCode: 404 });
  }

  it("answers a deep link with index.html, for GET and HEAD", async () => {
    await expectIndex(await get("/machines"));
    await expectIndex(await get("/machines/0f6c2a4e/settings"));

    const head = await get("/machines", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toMatch(/^text\/html/);
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(INDEX)));
  });

  it("serves / and the build's files", async () => {
    await expectIndex(await get("/"));

    const app = await get("/assets/app.js");
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toMatch(/javascript/);
    expect(await app.text()).toBe(APP);
  });

  it("answers a missing asset with index.html, so a page can reload on a chunk it no longer finds", async () => {
    await expectIndex(await get("/assets/gone-1234.js"));
  });

  it("answers a file that goes before it is read as an unknown route, naming no path on the server", async () => {
    await expectNotFound(await get("/assets/vanishing-5678.js"), "Cannot GET /assets/vanishing-5678.js");
  });

  it("leaves /api and the paths under it to the API, matching them without regard to case", async () => {
    const health = await get("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    await expectNotFound(await get("/api/no-such-route"), "Cannot GET /api/no-such-route");
    await expectNotFound(await get("/api"), "Cannot GET /api");
    await expectNotFound(await get("/API/no-such-route"), "Cannot GET /API/no-such-route");
    await expectIndex(await get("/apix"));
  });

  it("sends only the default caching headers", async () => {
    for (const urlPath of ["/", "/machines"]) {
      const response = await get(urlPath);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=0");
      expect(response.headers.get("etag")).toBeTruthy();
      expect(response.headers.get("last-modified")).toBeTruthy();
    }
  });

  it("names its build in every response: the API's, its refusals and unknown routes, index.html and the build's files", async () => {
    for (const [urlPath, status] of [
      ["/api/health", 200],
      ["/api/session", 401],
      ["/api/machines", 401],
      ["/api/no-such-route", 404],
      ["/machines", 200],
      ["/assets/app.js", 200],
      ["/assets/gone-1234.js", 200],
    ] as const) {
      const response = await get(urlPath);
      expect(response.status, urlPath).toBe(status);
      expect(response.headers.get("decent-sync-build"), urlPath).toBe(BUILD);
    }
    const signIn = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "not a password" }),
    });
    expect(signIn.status).toBe(401);
    expect(signIn.headers.get("decent-sync-build")).toBe(BUILD);
  });

  it("names the same build on every instance serving it, and none without a build that names one", async () => {
    const unnamed = path.join(dir, "unnamed");
    fs.mkdirSync(unnamed);
    fs.writeFileSync(path.join(unnamed, "index.html"), "<!doctype html><title>Decent Sync</title>");
    const instances = await Promise.all([
      startTestServer({ sharing: server, env: { WEB_DIST_DIR: dir } }),
      startTestServer({ sharing: server, env: { WEB_DIST_DIR: unnamed } }),
      startTestServer({ sharing: server, env: { WEB_DIST_DIR: path.join(dir, "no-such-build") } }),
    ]);
    const [same, withoutName, withoutBuild] = await Promise.all(instances.map((instance) => fetch(`${instance.url}/api/health`)));
    expect(same!.headers.get("decent-sync-build")).toBe(BUILD);
    expect(withoutName!.headers.has("decent-sync-build")).toBe(false);
    expect(withoutBuild!.headers.has("decent-sync-build")).toBe(false);
    await Promise.all(instances.map((instance) => instance.stop()));
  });

  it("answers a deep link as an unknown route while the build has no index.html", async () => {
    const index = path.join(dir, "index.html");
    fs.renameSync(index, path.join(dir, "index.html.away"));
    try {
      await expectNotFound(await get("/machines"), "Cannot GET /machines");
    } finally {
      fs.renameSync(path.join(dir, "index.html.away"), index);
    }
  });
});
