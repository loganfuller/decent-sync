// Records what DYE2 v0.1.42's Basket picker writes to Decaid v0.9.2's store
// (`/store/dye2.reaplugin/baskets`) as a barista archives, edits an archived
// Basket, unarchives, deletes one and empties a field of one, as README.md
// describes: drives the
// picker in headless Chromium, keeping each request the page sent to the
// baskets route, and every other request but a read, with Decaid's answer.
// Made from ./record.mjs and ../dye2-2cf631c/record.mjs, whose helpers it
// keeps. Run it once, from the repository root, against a Decaid started
// with a token whose data is new, still holding its bundled DYE2:
//
//   DECAID_EXTENSIONS_TOKEN=<token> node server/test/fixtures/decaid/dye2-v0.1.42/record-baskets.mjs <output dir>
//
// It reads DECAID from the environment for another address, and
// DECAID_EXTENSIONS_TOKEN for the token Decaid was started with, which it
// sends with DYE2's install and never writes to a file: a request that
// carried it holds `"token": "launch"`. It installs DYE2's latest release,
// which must be v0.1.42, and seeds the baskets list as Decent Sync's plugin
// writes it: each row with the fields, its id, its creation time and a
// made-up global id (`decentSyncId`).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const TOKEN = process.env.DECAID_EXTENSIONS_TOKEN;
const DYE2 = (page) => `${DECAID}/api/v1/plugins/dye2.reaplugin/${page}`;
const BASKETS = "/store/dye2.reaplugin/baskets";
const DYE2_VERSION = "0.1.42";
const log = (message) => console.log(new Date().toISOString(), message);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const out = process.argv[2];
if (!out) throw new Error("Usage: DECAID_EXTENSIONS_TOKEN=<token> record-baskets.mjs <output dir>");
if (!TOKEN) throw new Error("DECAID_EXTENSIONS_TOKEN is not set");
fs.mkdirSync(out, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + "\n");

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Sends a request to Decaid's API, with Decaid's token where `token` is "launch", kept in the recording by that name only, and gives the exchange. */
async function api(method, route, body, token) {
  const response = await fetch(`${DECAID}/api/v1${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token === "launch" ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { request: { method, path: route, ...(body === undefined ? {} : { body }), ...(token === undefined ? {} : { token }) }, response: { status: response.status, body: text === "" ? null : parse(text) } };
}

/** The list read once a step is done, marked as no request of the page's. */
const after = async () => ({ after: true, ...(await api("GET", BASKETS)) });

/**
 * A page whose kept requests are recorded, in the order sent: every request
 * but a read (and a CORS preflight), whatever its route, and every read of
 * the baskets route. Each is fetched by Playwright and its answer handed to
 * the page unchanged.
 */
async function recordedPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  const recorded = [];
  await context.route(/\/api\/v1\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routePath = url.pathname.slice("/api/v1".length);
    if (request.method() === "OPTIONS") return route.continue();
    if (request.method() === "GET" && routePath !== BASKETS) return route.continue();
    const exchange = { request: { method: request.method(), path: routePath + url.search }, response: undefined };
    const body = request.postData();
    if (body !== null) exchange.request.body = parse(body);
    recorded.push(exchange);
    const response = await route.fetch();
    const text = await response.text();
    exchange.response = { status: response.status(), body: text === "" ? null : parse(text) };
    await route.fulfill({ response, body: text }).catch(() => {});
  });
  return {
    page,
    context,
    /** Waits for the page to settle, and takes the exchanges recorded since the last call. */
    async take(settleMs = 1000) {
      await page.waitForTimeout(settleMs);
      for (let waited = 0; recorded.some((exchange) => !exchange.response); waited += 100) {
        if (waited > 10_000) throw new Error("A request was never answered");
        await page.waitForTimeout(100);
      }
      return recorded.splice(0);
    },
  };
}

/** The rows as Decent Sync's plugin adds them to DYE2's list: the write's fields, an id and creation time as DYE2 gives them, and the global id. */
const SEED = [
  { name: "Fixture 18g Precision", size: "double", diameterMm: 58.5, notes: "Fixture notes", id: randomUUID(), createdAt: "2026-11-22T09:00:00.000Z", decentSyncId: randomUUID() },
  { name: "Fixture 20g Ridgeless", size: "double", diameterMm: 58, notes: "Fixture ridgeless notes", id: randomUUID(), createdAt: "2026-11-22T09:01:00.000Z", decentSyncId: randomUUID() },
];
const EDITED_NAME = "Fixture 18g Precision II";

/** The picker's steps, on one page opened once, as a barista would use it. */
async function recordPicker(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  const card = (name) => page.locator(".dye-card:not(.dye-card-add)").filter({ has: page.locator(".dye-card-name", { hasText: new RegExp(`^${name}$`) }) });
  const editor = page.locator("#dye-modal-backdrop");
  /** The barista's hold on a Basket's card, which opens its editor (`attachCardLongPress`, 500 ms); an archived Basket's opens on a tap. */
  const openEditor = async (name, { archived = false } = {}) => {
    const target = card(name);
    if (archived) await target.click();
    else {
      const box = await target.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(800);
      await page.mouse.up();
    }
    await editor.locator(".dye-modal").waitFor({ state: "visible" });
  };
  /** The `dyeConfirm` box's confirming button. */
  const confirm = (text) => page.locator(".dye-modal-backdrop.open:not(#dye-modal-backdrop)").getByRole("button", { name: text, exact: true }).click();
  const closed = () => editor.waitFor({ state: "hidden" });
  /** What the picker lists, in its order: each Basket's name, whether it is dimmed as archived, and its lines. */
  const shown = () =>
    page.locator(".dye-card:not(.dye-card-add)").evaluateAll((cards) =>
      cards.map((c) => ({
        name: c.querySelector(".dye-card-name")?.textContent ?? null,
        archived: c.classList.contains("dye-card-archived"),
        sub: c.querySelector(".dye-card-sub")?.textContent ?? null,
        meta: c.querySelector(".dye-card-date")?.textContent ?? null,
      })),
    );

  const steps = {};
  log("opened");
  await page.goto(DYE2("basket-picker"));
  await card(SEED[0].name).waitFor();
  steps.opened = [...(await r.take(1500)), { shown: await shown() }, await after()];

  log("archive18gBasket");
  await openEditor(SEED[0].name);
  await page.locator("#dye-modal-archive").click();
  await confirm("ARCHIVE");
  await closed();
  steps.archive18gBasket = [...(await r.take()), await after()];
  steps.pickerListed = [{ shown: await shown() }];

  log("editArchived18gBasket");
  await openEditor(SEED[0].name, { archived: true });
  const form = page.locator("#dye-basket-form");
  await form.locator("input[name=name]").fill(EDITED_NAME);
  await form.locator("textarea[name=notes]").fill("Fixture notes, edited while archived");
  await page.locator("#dye-modal-save").click();
  await closed();
  steps.editArchived18gBasket = [...(await r.take()), { shown: await shown() }, await after()];

  log("unarchive18gBasket");
  await openEditor(EDITED_NAME, { archived: true });
  await page.locator("#dye-modal-archive", { hasText: "UNARCHIVE" }).click();
  await closed();
  steps.unarchive18gBasket = [...(await r.take()), { shown: await shown() }, await after()];

  log("archive20gBasket");
  await openEditor(SEED[1].name);
  await page.locator("#dye-modal-archive").click();
  await confirm("ARCHIVE");
  await closed();
  steps.archive20gBasket = [...(await r.take()), await after()];

  log("delete20gBasket");
  await openEditor(SEED[1].name, { archived: true });
  await page.locator("#dye-modal-delete").click();
  await confirm("DELETE");
  await closed();
  steps.delete20gBasket = [...(await r.take()), { shown: await shown() }, await after()];

  // Whether an edit that empties a field on the form clears it from the row.
  log("clearNotes18gBasket");
  await openEditor(EDITED_NAME);
  await form.locator("textarea[name=notes]").fill("");
  await page.locator("#dye-modal-save").click();
  await closed();
  steps.clearNotes18gBasket = [...(await r.take()), { shown: await shown() }, await after()];

  await r.context.close();
  return steps;
}

// ---- One run, on a Decaid whose data is new.

log(`installing DYE2 v${DYE2_VERSION}`);
const install = await api("POST", "/plugins/install/github-release", { repo: "decentespresso/dye2" }, "launch");
await wait(4000);
const listed = (await api("GET", "/plugins")).response.body.filter((plugin) => plugin.id === "dye2.reaplugin");
if (!listed.some((plugin) => plugin.version === DYE2_VERSION && plugin.loaded)) throw new Error(`DYE2 v${DYE2_VERSION} is not loaded: ${JSON.stringify(listed)}`);

log("seeded");
const seeded = [await api("POST", BASKETS, SEED), await after()];

const browser = await chromium.launch();
try {
  write("baskets.json", { seeded, ...(await recordPicker(browser)) });
  log(`install: ${JSON.stringify(install)}`);
  log(`info: ${JSON.stringify((await api("GET", "/info")).response.body)}`);
} finally {
  await browser.close();
}
log("done");
