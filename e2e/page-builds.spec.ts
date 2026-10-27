import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Response, test } from "@playwright/test";
import { type TestServer, startTestServer } from "../server/test/support/test-server.js";
import { useFreshServer } from "./support/fresh-server.js";
import { CHECK_MS, afterDetailsPolls, afterStatusPolls } from "./support/polling.js";
import { signInAsAdmin } from "./support/seed.js";

// Ticket #283: a page follows the build of the management interface its
// server serves (ADR-0025). Its page talks to instances sharing the fresh
// server's database, each serving a copy of the built app, and one stopped
// and started again at the same address with another copy stands for a
// deploy. A copy differs from the build only in what its index.html names
// it, or in a chunk left out.
const server = useFreshServer();
test.beforeEach(({ page }) => signInAsAdmin(page));

const builtApp = fileURLToPath(new URL("../web/dist", import.meta.url));
const BUILD_NAME = /<meta name="decent-sync-build" content="([0-9a-f]+)">/;
/** The name `vite build` gave the built app. */
const built = BUILD_NAME.exec(fs.readFileSync(path.join(builtApp, "index.html"), "utf8"))?.[1];

const copies: string[] = [];
test.afterAll(() => {
  for (const dir of copies.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A copy of the built app in a directory of its own, changed by `change`. */
function copyOfBuild(change: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-web-"));
  copies.push(dir);
  fs.cpSync(builtApp, dir, { recursive: true });
  change(dir);
  return dir;
}

/** A copy of the built app that names itself `name`, or nothing. */
function namedBuild(name: string | null): string {
  return copyOfBuild((dir) => {
    const index = path.join(dir, "index.html");
    const html = fs.readFileSync(index, "utf8");
    fs.writeFileSync(index, html.replace(BUILD_NAME, name === null ? "" : `<meta name="decent-sync-build" content="${name}">`));
  });
}

/**
 * A copy of the built app naming itself `name`, whose lazily loaded chunk
 * starting `prefix` has moved to another file, as a deploy changing it does.
 */
function buildMovingChunk(name: string, prefix: string): string {
  return copyOfBuild((dir) => {
    const assets = path.join(dir, "assets");
    const chunks = fs.readdirSync(assets).filter((file) => file.startsWith(`${prefix}-`) && file.endsWith(".js"));
    expect(chunks).toHaveLength(1);
    const moved = `${prefix}-moved.js`;
    fs.renameSync(path.join(assets, chunks[0]!), path.join(assets, moved));
    for (const file of [...fs.readdirSync(assets).map((asset) => path.join(assets, asset)), path.join(dir, "index.html")]) {
      const text = fs.readFileSync(file, "latin1");
      if (text.includes(chunks[0]!)) fs.writeFileSync(file, text.replaceAll(chunks[0]!, moved), "latin1");
    }
    const index = path.join(dir, "index.html");
    fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace(BUILD_NAME, `<meta name="decent-sync-build" content="${name}">`));
  });
}

/** Another instance on the fresh server's database, serving the app in `webDistDir`, or the build's. */
async function instance(webDistDir?: string, port?: number): Promise<TestServer> {
  return startTestServer({ sharing: await server.server(), port, env: webDistDir ? { WEB_DIST_DIR: webDistDir } : {} });
}

/** Stops an instance and starts another at its address, serving the app in `webDistDir`, as a deploy does. */
async function restart(stopping: TestServer, webDistDir: string): Promise<TestServer> {
  await stopping.stop();
  return instance(webDistDir, Number(new URL(stopping.url).port));
}

/** The build the page runs, as the index.html it loaded names it, or null. */
function pageBuild(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector('meta[name="decent-sync-build"]')?.getAttribute("content") ?? null);
}

/** Marks the document the page shows, so `sameDocument` can tell whether it loaded another since. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as { marked?: boolean }).marked = true;
  });
}

function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as { marked?: boolean }).marked === true);
}

/**
 * Moves the page's clock on until one of its polls is answered naming the
 * build `name`, with `afterStatusPolls`, or `afterDetailsPolls` for a page
 * polling only that often. The page must have opened with its clock installed.
 */
async function afterPollNaming(page: Page, name: string, polls = afterStatusPolls): Promise<void> {
  let named = false;
  const watch = (response: Response) => {
    if (new URL(response.url()).pathname.startsWith("/api/") && response.headers()["decent-sync-build"] === name) named = true;
  };
  page.on("response", watch);
  try {
    await polls(page, () => expect.poll(() => named, { timeout: CHECK_MS }).toBe(true));
  } finally {
    page.off("response", watch);
  }
}

const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });

/** Moves to the Locations page through the main navigation, resolving once the page that shows it has loaded them. */
async function toLocations(page: Page): Promise<void> {
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/locations");
  await mainNav(page).getByRole("link", { name: "Locations" }).click();
  await loaded;
  await expect(heading(page, "Locations")).toBeVisible();
}

test("a page open while the server restarts with another build stays as it is until its next navigation, then loads the new build", async ({ page }) => {
  expect(built).toMatch(/^[0-9a-f]{16}$/);
  const another = randomBytes(8).toString("hex");
  const before = await instance();
  await page.clock.install();
  await page.goto(`${before.url}/library/baskets`);
  await expect(heading(page, "Baskets")).toBeVisible();
  expect(await pageBuild(page)).toBe(built);
  await markDocument(page);

  const after = await restart(before, namedBuild(another));
  await afterPollNaming(page, another, afterDetailsPolls);
  // A filter, kept in the address's query, changes it as it is typed without moving to another page.
  await page.getByRole("search", { name: "Filter Baskets" }).getByLabel("Search").fill("precision");
  await expect(page).toHaveURL(`${after.url}/library/baskets?q=precision`);
  await afterPollNaming(page, another, afterDetailsPolls);
  expect(await sameDocument(page)).toBe(true);
  expect(await pageBuild(page)).toBe(built);

  await mainNav(page).getByRole("link", { name: "Locations" }).click();
  await expect.poll(() => pageBuild(page)).toBe(another);
  expect(await sameDocument(page)).toBe(false);
  await expect(page).toHaveURL(`${after.url}/locations`);
  await expect(heading(page, "Locations")).toBeVisible();
});

test("a chunk that fails to load reloads the page once, and not again when it fails after the reload too", async ({ page }) => {
  const withoutShots = copyOfBuild((dir) => {
    const assets = path.join(dir, "assets");
    const chunks = fs.readdirSync(assets).filter((file) => /^ShotsPage-.*\.js$/.test(file));
    expect(chunks).toHaveLength(1);
    fs.rmSync(path.join(assets, chunks[0]!));
  });
  const serving = await instance(withoutShots);
  const loads: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads.push(new URL(request.url()).pathname);
  });
  const notAgain = page.waitForEvent("console", (message) => message.text().includes("so it does not reload again"));
  await page.goto(`${serving.url}/machines`);
  await expect(heading(page, "Machines")).toBeVisible();

  // The server answers the missing chunk with index.html, which fails to load as a module.
  await mainNav(page).getByRole("link", { name: "Shots" }).click();
  await notAgain;
  expect(loads).toEqual(["/machines", "/shots"]);
});

test("a chunk that fails after a deploy reloads the page into the new build, though the page reloaded for a chunk before", async ({ page }) => {
  const another = randomBytes(8).toString("hex");
  const before = await instance();
  // The Shots page's chunk fails to load once, as on a flaky network, so the page reloads and loads it.
  let failed = false;
  await page.route(/\/assets\/ShotsPage-[^/]*\.js$/, (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.abort();
  });
  await page.clock.install();
  await page.goto(`${before.url}/machines`);
  await expect(heading(page, "Machines")).toBeVisible();
  await mainNav(page).getByRole("link", { name: "Shots" }).click();
  await expect(heading(page, "Shots")).toBeVisible();
  expect(failed).toBe(true);

  // A deploy moves the Steam Records page's chunk. A navigation to that lazily loaded page waits for the chunk this
  // page knows, which is gone.
  const after = await restart(before, buildMovingChunk(another, "SteamRecordsPage"));
  await afterPollNaming(page, another);
  await mainNav(page).getByRole("link", { name: "Steam Records" }).click();
  await expect.poll(() => pageBuild(page)).toBe(another);
  await expect(page).toHaveURL(`${after.url}/steam-records`);
  await expect(heading(page, "Steam Records")).toBeVisible();
});

test("a chunk failing after its navigation was left reloads nothing until its page is opened", async ({ page }) => {
  const serving = await instance();
  // The Shots page's chunk is held until the test fails it, and loads from then on.
  let failChunk: (() => Promise<void>) | undefined;
  const held = new Promise<void>((resolve) => {
    void page.route(/\/assets\/ShotsPage-[^/]*\.js$/, (route) => {
      if (failChunk) return route.continue();
      failChunk = () => route.abort();
      resolve();
    });
  });
  await page.goto(`${serving.url}/machines`);
  await expect(heading(page, "Machines")).toBeVisible();
  await mainNav(page).getByRole("link", { name: "Shots" }).click();
  await held;

  // Someone moves on before it loads, and starts a form there.
  await mainNav(page).getByRole("link", { name: "Locations" }).click();
  await expect(heading(page, "Locations")).toBeVisible();
  const name = page.getByRole("form", { name: "New Location" }).getByLabel("Name", { exact: true });
  await name.fill("Unsaved cafe");
  await markDocument(page);
  const failed = page.waitForEvent("requestfailed", (request) => /\/assets\/ShotsPage-/.test(request.url()));
  await failChunk!();
  await failed;
  await expect(name).toHaveValue("Unsaved cafe");
  expect(await sameDocument(page)).toBe(true);

  // Opening the Shots page then reloads it, which loads its chunk.
  await mainNav(page).getByRole("link", { name: "Shots" }).click();
  await expect(heading(page, "Shots")).toBeVisible();
  expect(await sameDocument(page)).toBe(false);
});

test("a page without a build never reloads", async ({ page }) => {
  const another = randomBytes(8).toString("hex");
  const before = await instance(namedBuild(null));
  await page.clock.install();
  await page.goto(`${before.url}/machines`);
  await expect(heading(page, "Machines")).toBeVisible();
  expect(await pageBuild(page)).toBeNull();
  await markDocument(page);

  await restart(before, namedBuild(another));
  await afterPollNaming(page, another);
  await toLocations(page);
  expect(await sameDocument(page)).toBe(true);
});
