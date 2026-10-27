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

test("a chunk that fails to load reloads the page once, and not again when the reload brought the same build", async ({ page }) => {
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
