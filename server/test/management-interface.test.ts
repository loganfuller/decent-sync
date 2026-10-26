import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Ticket #293: the server sends the management interface's index.html for any
// path outside the API that matches no file of its build, so deep links such
// as /machines open the page, even when the build sits under a directory whose
// name starts with a dot, as a T3 worktree under ~/.t3/ does. CI's checkout has
// no such segment, so the test writes a small build of its own under one.

const INDEX = "<!doctype html><title>Decent Sync</title>";
const APP = "console.log('app');";

describe("The management interface", () => {
  const dir = path.join(os.tmpdir(), `.decent-sync-web-${randomBytes(6).toString("hex")}`);
  let server: TestServer;

  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), INDEX);
    fs.writeFileSync(path.join(dir, "assets/app.js"), APP);
    server = await startTestServer({ env: { WEB_DIST_DIR: dir } });
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
