// Records what DYE2 `main` at 2cf631c and Streamline `main` at c006dac write
// to Decaid v0.9.0, as README.md describes: drives their pages in headless
// Chromium and sends requests from Node, as the plugin would, keeping each
// exchange with Decaid's answer, the pushes heard on DYE2's `changed` socket
// and the Workflows Decaid sent plugins (heard through workflow-recorder/,
// beside this script). Run it once, from the repository root, against a
// Decaid whose data is new, with DYE2 at 2cf631c and the recorder installed
// and enabled and Streamline's files at c006dac served at SKIN:
//
//   RESTART_DECAID=<command> node server/test/fixtures/decaid/dye2-2cf631c/record.mjs <output dir>
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const SKIN = process.env.SKIN ?? "http://localhost:13999";
const SOCKETS = DECAID.replace(/^http/, "ws");
const DYE2 = (page) => `${DECAID}/api/v1/plugins/dye2.reaplugin/${page}`;
const SELECTION = "/plugins/dye2.reaplugin/selection";
const STORED_SELECTION = "/store/dye2.reaplugin/selection";
const RECIPES = "/store/dye2.reaplugin/recipes";
/** DYE2's wait before it records, and a margin. */
const RECORDED_MS = 2500;
/** The routes whose requests a page sends that are kept: DYE2's selection and keys, Streamline's remembered values, the Workflow and single Shots. */
const KEPT = [/^\/plugins\/dye2\.reaplugin\/selection$/, /^\/store\/dye2\.reaplugin\/(recipes|baskets|equipment|selection)$/, /^\/store\/streamline-app\/[^/]+$/, /^\/workflow$/, /^\/shots\/[^/?]+$/];
const log = (message) => console.log(new Date().toISOString(), message);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const out = process.argv[2];
if (!out) throw new Error("Usage: record.mjs <output dir>");
fs.mkdirSync(out, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(trimmed(value), null, 2) + "\n");

/**
 * The value with every Shot's measurements trimmed to its first, last,
 * peak-pressure and peak-flow samples, in their order, as the de1pro-v0.8.7
 * Shot is.
 */
function trimmed(value) {
  if (Array.isArray(value)) return value.map(trimmed);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, field]) => [key, trimmed(field)]));
  const samples = value.measurements;
  if (Array.isArray(samples) && samples.length > 4) {
    const peak = (field) => samples.reduce((best, sample, index) => (sample.machine[field] > samples[best].machine[field] ? index : best), 0);
    const kept = new Set([0, samples.length - 1, peak("pressure"), peak("flow")]);
    result.measurements = samples.filter((_, index) => kept.has(index));
  }
  return result;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Sends a request to Decaid's API, and gives the exchange. */
async function api(method, route, body) {
  const response = await fetch(`${DECAID}/api/v1${route}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { request: { method, path: route, ...(body === undefined ? {} : { body }) }, response: { status: response.status, body: text === "" ? null : parse(text) } };
}

/**
 * A socket on a plugin's WebSocket endpoint, kept open, hearing each push
 * with the time it came. `opened` resolves with the status Decaid answered
 * the upgrade with (101 for an open socket).
 */
function listen(pluginId, endpoint) {
  const socket = new WebSocket(`${SOCKETS}/ws/v1/plugins/${pluginId}/${endpoint}`);
  const heard = [];
  const state = { closed: false, heard, socket };
  state.opened = new Promise((resolve) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: parse(body) }));
    });
    socket.once("error", () => resolve("error"));
  });
  socket.on("message", (data) => heard.push({ at: Date.now(), payload: parse(data.toString()) }));
  socket.on("close", (code) => {
    state.closed = true;
    state.closeCode = code;
  });
  return state;
}

let changed;
let recorder;

/**
 * A page whose kept requests are recorded, in the order sent. Each is fetched
 * by Playwright and its answer handed to the page unchanged, so an answer is
 * recorded even when a page navigates away before reading it. Of the reads,
 * only those `keepRead` accepts are kept. `fail` may answer a request in
 * Decaid's stead, which the exchange then records.
 */
async function recordedPage(browser, { viewport = { width: 1280, height: 800 }, keepRead = () => true } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  const recorded = [];
  const state = { fail: undefined };
  await context.route(/\/api\/v1\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routePath = url.pathname.slice("/api/v1".length);
    if (request.method() === "OPTIONS" || !KEPT.some((pattern) => pattern.test(routePath))) return route.continue();
    if (request.method() === "GET" && !keepRead(routePath)) return route.continue();
    const exchange = { request: { method: request.method(), path: routePath + url.search }, response: undefined };
    const body = request.postData();
    if (body !== null) exchange.request.body = parse(body);
    recorded.push(exchange);
    const failed = state.fail?.(exchange.request);
    if (failed) {
      exchange.response = { ...failed, injected: true };
      await route.fulfill({ status: failed.status, contentType: "application/json", body: JSON.stringify(failed.body) }).catch(() => {});
      return;
    }
    const response = await route.fetch();
    const text = await response.text();
    exchange.response = { status: response.status(), body: text === "" ? null : parse(text) };
    await route.fulfill({ response, body: text }).catch(() => {});
  });
  return {
    page,
    context,
    state,
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

/**
 * A step: the exchanges `act` gives, then, as `after` asks, DYE2's selection,
 * its stored selection, its recipes and the Workflow read once DYE2 would
 * have recorded, the pushes heard on `changed` meanwhile, and the context of
 * each Workflow Decaid sent plugins in a `workflowUpdated` (`events`).
 */
async function step(act, { after = ["selection", "recipes"], settleMs = RECORDED_MS } = {}) {
  const mark = changed.heard.length;
  const eventMark = recorder.heard.length;
  const exchanges = await act();
  await wait(settleMs);
  const reads = [];
  if (after.includes("selection")) reads.push(await api("GET", SELECTION));
  if (after.includes("stored")) reads.push(await api("GET", STORED_SELECTION));
  if (after.includes("recipes")) reads.push(await api("GET", RECIPES));
  if (after.includes("workflow")) reads.push(await api("GET", "/workflow"));
  return {
    exchanges,
    after: reads,
    pushes: changed.heard.slice(mark).map(({ payload }) => payload),
    events: recorder.heard.slice(eventMark).map(({ payload }) => payload.workflow?.context ?? null),
  };
}

const workflow = async () => (await api("GET", "/workflow")).response.body;
const profileTitled = async (title) => (await api("GET", "/profiles?includeHidden=true")).response.body.find((record) => record.profile.title === title);
const plugins = async () => (await api("GET", "/plugins")).response.body.filter((plugin) => plugin.id === "dye2.reaplugin");
const beanNamed = async (name) => (await api("GET", "/beans")).response.body.find((bean) => bean.name === name);
const batchOf = async (bean) => (await api("GET", "/bean-batches")).response.body.find((candidate) => candidate.beanId === bean.id);
const basketNamed = async (name) => (await api("GET", "/store/dye2.reaplugin/baskets")).response.body.find((candidate) => candidate.name === name);
const put = async (body) => [await api("PUT", "/workflow", body)];

/**
 * Restarts Decaid, keeping its data, with the command RESTART_DECAID names,
 * and opens the sockets again: the earlier recordings found its simulated
 * machine storing only the first Shot pulled after it started (on v0.8.7). Resolves once DYE2 has loaded and
 * restored its selection.
 */
async function restartDecaid() {
  if (!process.env.RESTART_DECAID) return;
  log("restarting Decaid");
  changed?.socket.close();
  recorder?.socket.close();
  execFileSync(process.env.RESTART_DECAID, { stdio: "inherit" });
  for (let waited = 0; !(await plugins().catch(() => [])).some((plugin) => plugin.loaded); waited++) {
    if (waited > 90) throw new Error("DYE2 did not load");
    await wait(1000);
  }
  await wait(3000);
  changed = listen("dye2.reaplugin", "changed");
  recorder = listen("workflow-recorder.reaplugin", "workflow");
  if ((await changed.opened) !== 101 || (await recorder.opened) !== 101) throw new Error("A socket did not open");
  await wait(2000);
}

/** Pulls a Shot on Decaid's simulated machine, and gives its id once it is stored and the machine idle. */
async function pullShot() {
  const listed = async () => (await api("GET", "/shots?limit=1")).response.body.items[0]?.id;
  const before = await listed();
  log("pulling a Shot");
  await api("PUT", "/machine/state/espresso");
  for (let waited = 0; waited < 180; waited++) {
    await wait(1000);
    const latest = await listed();
    const state = (await api("GET", "/machine/state")).response.body.state.state;
    if (latest && latest !== before && state !== "espresso") {
      await api("PUT", "/machine/state/idle");
      return latest;
    }
  }
  throw new Error("No Shot was stored");
}

// ---- The library DYE2's pages pick from, made up for the recording.

async function seedLibrary() {
  const ethiopia = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  const brazil = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Brazil", country: "Brazil", processing: "Natural" })).response.body;
  await api("POST", `/beans/${ethiopia.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 });
  await api("POST", `/beans/${brazil.id}/batches`, { roastDate: "2026-10-03T00:00:00.000", weight: 1000 });
  await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
  // A second grinder, for a switch of grinder while a recipe is selected.
  await api("POST", "/grinders", { model: "Fixture Grinder 83", burrs: "Fixture 83mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
}

// ---- DYE2's lists, written through its pages.

/** Decaid's store answering a key never written, a POST, a read, a DELETE and a DELETE of a key it no longer holds. */
async function recordStore() {
  return [await api("GET", RECIPES), await api("POST", RECIPES, []), await api("GET", RECIPES), await api("DELETE", RECIPES), await api("GET", RECIPES), await api("DELETE", RECIPES)];
}

async function recordTools(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  await page.goto(DYE2("equipment"));
  await r.take(2000);
  const save = async (name, fields, existing) => {
    if (existing) await page.locator(".dye-card .dye-card-name", { hasText: existing }).click();
    else await page.locator(".dye-card-add").click();
    await page.locator("#dye-equipment-form input[name=name]").fill(name);
    for (const [key, value] of fields) {
      const rows = page.locator("#dye-custom-fields .dye-field-row");
      const row = rows.filter({ has: page.locator(`.dye-field-key[value="${key}"]`) });
      if (await row.count()) await row.locator(".dye-field-value").fill(value);
      else {
        await page.locator("#dye-add-field-btn").click();
        await rows.last().locator(".dye-field-key").fill(key);
        await rows.last().locator(".dye-field-value").fill(value);
      }
    }
    await page.locator("#dye-modal-save").click();
    await page.locator("#dye-modal-backdrop").waitFor({ state: "hidden" });
    return r.take();
  };
  const steps = {};
  log("tools");
  steps.createWdtTool = await save("Fixture WDT Tool", [["Needles", "8"], ["Needle size", "0.3 mm"]]);
  steps.createPuckScreen = await save("Fixture Puck Screen", [["Thickness", "1.7 mm"]]);
  steps.createSpareTamper = await save("Fixture Spare Tamper", []);
  steps.editWdtTool = await save("Fixture WDT Tool", [["Needles", "10"]], "Fixture WDT Tool");
  await page.locator(".dye-card .dye-card-name", { hasText: "Fixture Spare Tamper" }).click();
  await page.locator("#dye-modal-delete").click();
  steps.deleteSpareTamper = await r.take();
  await r.context.close();
  return steps;
}

async function recordBaskets(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  await page.goto(DYE2("baskets"));
  await r.take(2000);
  const save = async (fields, existing) => {
    if (existing) await page.locator(".dye-card .dye-card-name", { hasText: existing }).click();
    else await page.locator(".dye-card-add").click();
    const form = page.locator("#dye-basket-form");
    if (fields.name !== undefined) await form.locator("input[name=name]").fill(fields.name);
    if (fields.size !== undefined) await form.locator("select[name=size]").selectOption(fields.size);
    if (fields.diameterMm !== undefined) await form.locator("input[name=diameterMm]").fill(fields.diameterMm);
    if (fields.notes !== undefined) await form.locator("textarea[name=notes]").fill(fields.notes);
    await page.locator("#dye-modal-save").click();
    await page.locator("#dye-modal-backdrop").waitFor({ state: "hidden" });
    return r.take();
  };
  log("baskets");
  const steps = {};
  steps.create18gBasket = await save({ name: "Fixture 18g Precision", size: "double", diameterMm: "58.5", notes: "Fixture notes" });
  steps.create20gBasket = await save({ name: "Fixture 20g High-flow", size: "double", diameterMm: "58" });
  steps.edit18gBasket = await save({ notes: "Fixture notes, edited", diameterMm: "58.4" }, "Fixture 18g Precision");
  await r.context.close();
  return steps;
}

async function recordRecipes(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  const open = async (tab) => {
    await page.goto(DYE2("recipe-edit"));
    // initRecipeEdit picks its slot once it has read the recipes; the tab is tapped after that.
    await page.waitForTimeout(2000);
    await page.locator(`.re-tab[data-recipe="${tab}"]`).click();
    await page.locator(`.re-tab.active[data-recipe="${tab}"]`).waitFor();
    await r.take();
  };
  const stepper = async (prefix, value) => {
    await page.locator(`#${prefix}-value`).click();
    const input = page.locator(`#${prefix}-value input`);
    await input.fill(String(value));
    await input.press("Enter");
  };
  const combo = async (field, value) => {
    await page.locator(`#${field}-input`).click();
    // "＋ New…", which answers mousedown rather than click.
    await page.locator(`#${field}-drop .re-combo-opt`).first().dispatchEvent("mousedown");
    await page.locator(`#${field}-input`).fill(value);
    await page.locator(`#${field}-input`).press("Enter");
    await page.waitForTimeout(250);
  };
  const tools = async (names, values = {}) => {
    for (const name of names) {
      await page.locator("#re-equipment-expand").click();
      const row = page.locator(".dye-name-dropdown .read-from-item", { hasText: name });
      if (!(await row.textContent()).includes("✓")) await row.click();
      if (values[name]) {
        await row.locator(".equip-edit-icon").click();
        for (const [key, value] of Object.entries(values[name])) await page.locator(`#eq-values-fields input[data-key="${key}"]`).fill(value);
        await page.locator("#eq-values-save").click();
      }
      await page.locator("body").click({ position: { x: 5, y: 5 } });
    }
  };
  const chip = (list, name) => page.locator(`#${list}`).getByText(name, { exact: true }).click();
  const save = async () => {
    await page.locator("#re-save-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(2000);
  };
  const steps = {};

  log("slot 1: every field, a Profile from the library");
  await open(0);
  await page.locator("#re-name-input").fill("Fixture Ethiopia Espresso");
  await combo("re-beverage", "Fixture Flat White");
  await combo("re-barista", "Fixture Barista");
  await combo("re-drinker", "Fixture Drinker");
  await chip("re-bean-chips", "Fixture Ethiopia");
  await chip("re-profile-chips", "Adaptive v3");
  await chip("re-grinder-chips", "Fixture Grinder 64");
  await chip("re-basket-chips", "Fixture 18g Precision");
  await tools(["Fixture WDT Tool", "Fixture Puck Screen"], { "Fixture WDT Tool": { Needles: "12" } });
  await stepper("re-dose", 18);
  await stepper("re-drink", 36);
  await stepper("re-brew-c", 92);
  await page.locator('.re-steam-mode[data-mode="time"]').click();
  await stepper("re-steam", 30);
  await stepper("re-flush", 5);
  await page.locator('.re-hotwater-mode[data-mode="temp"]').click();
  await stepper("re-hotwater", 85);
  await stepper("re-grind", 2.5);
  await stepper("re-rpm", 900);
  steps.saveSlot1 = await save();

  log("slot 2: the Profile and other values read from the Workflow");
  // The Workflow's profile set to a bundled one, as a skin does, so that slot 2 reads it.
  await api("PUT", "/workflow", { profile: (await profileTitled("Classic Italian espresso")).profile });
  await open(1);
  await page.locator("#re-read-from-btn").click();
  await page.locator("#re-read-from-workflow").click();
  await r.take();
  await page.locator("#re-name-input").fill("Fixture Brazil Espresso");
  await chip("re-bean-chips", "Fixture Brazil");
  await chip("re-grinder-chips", "Fixture Grinder 64");
  await chip("re-basket-chips", "Fixture 20g High-flow");
  await tools(["Fixture Puck Screen"]);
  await stepper("re-dose", 19);
  await stepper("re-drink", 36);
  await page.locator('.re-steam-mode[data-mode="flow"]').click();
  await stepper("re-steam", 1.2);
  await stepper("re-flush", 4);
  await page.locator('.re-hotwater-mode[data-mode="vol"]').click();
  await stepper("re-hotwater", 150);
  await stepper("re-grind", 3);
  await stepper("re-rpm", 1100);
  steps.saveSlot2 = await save();

  log("slot 1 edited");
  await open(0);
  await stepper("re-dose", 18.5);
  await stepper("re-grind", 2.7);
  await stepper("re-hotwater", 88);
  steps.editSlot1 = await save();

  log("slot 3: only its name typed");
  await open(2);
  await page.locator("#re-name-input").fill("Fixture Blank Recipe");
  steps.saveBlankSlot3 = await save();
  await r.context.close();
  return steps;
}

/** DYE2's dashboard applying each recipe, which selects it, then a basket picked for the next Shot. */
async function recordDye2Applies(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  const open = async () => {
    await page.goto(DYE2("dashboard"));
    await r.take(3000);
  };
  const apply = async (title) => {
    await open();
    return step(
      async () => {
        await page.locator(`#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)[title="${title}"]`).click();
        return r.take(2000);
      },
      { after: ["selection", "workflow"] },
    );
  };
  const steps = {};
  log("DYE2 applies");
  steps.applySlot1 = await apply("Fixture Ethiopia Espresso");
  steps.applySlot2 = await apply("Fixture Brazil Espresso");
  steps.applyBlankSlot3 = await apply("Fixture Blank Recipe");
  steps.applySlot1Again = await apply("Fixture Ethiopia Espresso");
  log("basket picked for the next Shot");
  await open();
  steps.pickBasket = await step(
    async () => {
      await page.locator("#dye-basket-field").click();
      await page.waitForURL(/basket-picker/);
      await page.waitForTimeout(1500);
      await page.locator(".dye-card:not(.dye-card-add)", { has: page.locator(".dye-card-name", { hasText: "Fixture 20g High-flow" }) }).click();
      await page.locator("#dye-confirm-btn").click();
      await page.waitForURL(/dashboard/, { waitUntil: "commit" });
      return r.take(2000);
    },
    { after: ["selection", "workflow"] },
  );
  await r.context.close();
  return steps;
}

/** DYE2's Edit Shot page giving that Shot a basket and tools. */
async function recordEditShot(browser, shotId) {
  const r = await recordedPage(browser);
  const { page } = r;
  await page.goto(DYE2("dashboard"));
  await page.evaluate((id) => {
    sessionStorage.clear();
    sessionStorage.setItem("dye_editShotId", id);
  }, shotId);
  await page.goto(DYE2("edit-shot"));
  const steps = { openEditShot: await r.take(3000) };
  log("Edit Shot");
  await page.locator("#es-basket-expand").click();
  await page.waitForURL(/basket-picker/);
  await page.waitForTimeout(1500);
  await page.locator(".dye-card:not(.dye-card-add)", { has: page.locator(".dye-card-name", { hasText: "Fixture 18g Precision" }) }).click();
  await page.locator("#dye-confirm-btn").click();
  await page.waitForURL(/edit-shot/);
  steps.pickShotBasket = await r.take(3000);
  for (const name of ["Fixture WDT Tool", "Fixture Puck Screen"]) {
    await page.locator("#es-equipment-expand").click();
    const row = page.locator(".dye-name-dropdown .read-from-item", { hasText: name });
    if (!(await row.textContent()).includes("✓")) await row.click();
    if (name === "Fixture WDT Tool") {
      await row.locator(".equip-edit-icon").click();
      await page.locator('#es-equip-values-fields input[data-key="Needles"]').fill("14");
      await page.locator("#es-equip-values-save").click();
    }
    await page.locator("body").click({ position: { x: 5, y: 5 } });
  }
  await page.locator("#es-save-btn").click();
  await page.waitForURL(/dashboard/, { waitUntil: "commit" });
  steps.saveShot = await r.take(2000);
  await r.context.close();
  return steps;
}

/** Saves a favourite on DYE2's Auto Favourites page with only its title typed, and gives its id. */
async function makeFavourite(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  await page.goto(DYE2("auto-favs"));
  await page.waitForTimeout(2000);
  await page.locator(".dye-card-add").click();
  await page.waitForURL(/auto-fav-edit/);
  await page.waitForTimeout(1500);
  await page.locator("#afe-title-input").fill("Fixture Favourite");
  await page.locator("#afe-save-btn").click();
  await page.waitForTimeout(2000);
  await r.context.close();
  const favourites = (await api("GET", "/store/dye2.reaplugin/autoFavourites")).response.body ?? [];
  const saved = favourites.find((favourite) => favourite && !favourite.auto && favourite.title === "Fixture Favourite");
  if (!saved) throw new Error("The favourite was not saved");
  return saved.id;
}

// ---- DYE2's selection, its recording into it and Streamline's strip.

/** DYE2 listed while loaded, disabled and enabled again; its selection and socket answered while not loaded; and the socket open across a reload. */
async function recordPlugins() {
  log("plugins");
  const steps = {};
  steps.loaded = { listed: await plugins(), selection: await api("GET", SELECTION) };
  const before = changed;
  const disabled = await api("POST", "/plugins/dye2.reaplugin/disable");
  await wait(1000);
  const refused = listen("dye2.reaplugin", "changed");
  steps.disabled = {
    exchanges: [disabled],
    listed: await plugins(),
    selection: await api("GET", SELECTION),
    store: await api("GET", STORED_SELECTION),
    socketOpened: await refused.opened,
    socketOpenBeforeClosed: before.closed,
  };
  const mark = before.heard.length;
  const enabled = await api("POST", "/plugins/dye2.reaplugin/enable");
  await wait(3000);
  steps.enabled = {
    exchanges: [enabled],
    listed: await plugins(),
    selection: await api("GET", SELECTION),
    socketOpenBeforeClosed: before.closed,
    socketOpenBeforeHeard: before.heard.slice(mark).map(({ payload }) => payload),
  };
  if (before.closed) {
    changed = listen("dye2.reaplugin", "changed");
    await changed.opened;
  }
  return steps;
}

/** The profile of each Workflow: as the last `workflowUpdated` before now carried it, as `GET /workflow` answers, and the fingerprint DYE2 stored as it selected. */
const fingerprints = [];
async function noteFingerprint(name) {
  await wait(300);
  const event = recorder.heard.at(-1)?.payload.workflow;
  const selection = (await api("GET", SELECTION)).response.body;
  fingerprints.push({ name, workflowUpdated: event?.profile ?? null, workflow: (await workflow()).profile, profileFingerprint: selection?.profileFingerprint ?? null });
}

/** Reads kept on DYE2's dashboard: its selection, and the recipes it reads again before an apply. */
const dashboardReads = (route) => route === SELECTION || route === RECIPES;

/** DYE2's dashboard: a recipe applied, the Workflow changed from elsewhere, a dial tap and Done; a recent and a saved favourite applied; a clear. */
async function recordDashboard(browser, favouriteId) {
  log("dashboard");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { page } = r;
  const steps = {};
  const open = async () => {
    await page.goto(DYE2("dashboard"));
    await r.take(3000);
  };
  const pill = (selector) => page.locator(`#dye-recipe-pills ${selector}`).first().click();
  await open();
  steps.applySlot1 = await step(
    async () => {
      await pill('.dye-recipe-pill:not(.dye-pill-recent)[title="Fixture Ethiopia Espresso"]');
      return r.take(1500);
    },
    { after: ["selection", "stored", "recipes", "workflow"] },
  );
  await noteFingerprint("dashboardSlot1");
  // As the plugin's load write would, after the page read the Workflow: another batch and its coffee, a Basket and a hot water volume.
  const brazil = await beanNamed("Fixture Brazil");
  const batch = await batchOf(brazil);
  const basket = await basketNamed("Fixture 18g Precision");
  steps.writtenElsewhere = await step(
    () =>
      put({
        context: { beanBatchId: batch.id, coffeeName: brazil.name, coffeeRoaster: brazil.roaster, extras: { basketId: basket.id, basketName: basket.name } },
        hotWaterData: { volume: 90 },
      }),
    { after: ["selection", "recipes", "workflow"] },
  );
  steps.dialTap = await step(
    async () => {
      await page.locator("#dye-grind-plus").click();
      return r.take(1500);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  steps.done = await step(
    async () => {
      await page.locator("#dye-done-btn").click();
      return r.take(1500);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  await open();
  steps.applyRecent = await step(
    async () => {
      await pill(".dye-recipe-pill.dye-pill-recent");
      return r.take(1500);
    },
    { after: ["selection", "stored", "recipes"] },
  );
  await open();
  await pill('.dye-recipe-pill:not(.dye-pill-recent)[title="Fixture Brazil Espresso"]');
  await r.take(1500);
  await noteFingerprint("dashboardSlot2");
  await page.evaluate((id) => sessionStorage.setItem("dye_selectedAutoFavId", id), favouriteId);
  steps.applySavedFavourite = await step(
    async () => {
      await page.goto(DYE2("dashboard"));
      return r.take(3000);
    },
    { after: ["selection", "stored"] },
  );
  steps.clear = await step(async () => [await api("POST", SELECTION, {})], { after: ["selection", "stored", "workflow"] });
  await r.context.close();
  return steps;
}

/** What DYE2 records into the selected recipe, slot 1, from Workflow changes sent from Node, and what clears the selection. */
async function recordRecording(browser) {
  log("recording");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { page } = r;
  const steps = {};
  const select = async (title = "Fixture Ethiopia Espresso") => {
    await page.goto(DYE2("dashboard"));
    await r.take(3000);
    await page.locator(`#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)[title="${title}"]`).click();
    const exchanges = await r.take(1500);
    // Past DYE2's 3 s echo window.
    await wait(3500);
    return exchanges;
  };
  /** Slot 1 selected from Node, as the plugin selects, on the Workflow as it is, then DYE2's echo window waited out. */
  const selectFromNode = async () => {
    const selected = await api("POST", SELECTION, { kind: "recipe", id: "1" });
    await wait(3500);
    return selected;
  };
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const ethiopiaBatch = await batchOf(ethiopia);
  const brazil = await beanNamed("Fixture Brazil");
  const brazilBatch = await batchOf(brazil);
  const grinder83 = (await api("GET", "/grinders")).response.body.find((grinder) => grinder.model === "Fixture Grinder 83");
  const highFlow = await basketNamed("Fixture 20g High-flow");

  steps.select = await step(select, { after: ["selection", "recipes", "workflow"], settleMs: 0 });
  steps.grind = await step(() => put({ context: { grinderSetting: "2.4" } }));
  steps.dose = await step(() => put({ context: { targetDoseWeight: 19 } }));
  steps.yieldInContext = await step(() => put({ context: { targetYield: 38 } }));
  const raised = (await workflow()).profile;
  steps.brewTemperature = await step(() => put({ profile: { ...raised, steps: raised.steps.map((s) => ({ ...s, temperature: s.temperature + 1 })) } }));
  steps.hotWaterActiveMode = await step(() => put({ hotWaterData: { targetTemperature: 87 } }));
  steps.hotWaterOtherMode = await step(() => put({ hotWaterData: { volume: 120 } }));
  steps.steamActiveMode = await step(() => put({ steamSettings: { duration: 32 } }));
  steps.steamOtherMode = await step(() => put({ steamSettings: { flow: 1.4 } }));
  steps.flush = await step(() => put({ rinseData: { duration: 6 } }));
  steps.debounced = await step(async () => {
    const first = await put({ context: { grinderSetting: "2.7" } });
    await wait(300);
    return [...first, ...(await put({ context: { grinderSetting: "2.8" } }))];
  });
  // Selected with the Workflow's grind off the recipe's: the next change within 3 s with the same values is DYE2's echo, one after it is recorded.
  steps.echo = await step(async () => {
    const off = await put({ context: { grinderSetting: "3.3" } });
    const selected = await api("POST", SELECTION, { kind: "recipe", id: "1" });
    await wait(500);
    const within = await put({ context: { baristaName: "Fixture Barista" } });
    return [...off, selected, ...within];
  });
  steps.afterEcho = await step(async () => {
    await wait(1000);
    return put({ context: { drinkerName: "Fixture Drinker" } });
  });
  steps.profileChange = await step(async () => put({ profile: (await profileTitled("Classic Italian espresso")).profile }), { after: ["selection", "stored", "recipes", "workflow"] });
  await select();
  steps.targetWeightOnly = await step(
    async () => {
      const current = (await workflow()).profile;
      return put({ profile: { ...current, target_weight: 40 } });
    },
    { after: ["selection", "stored", "recipes"] },
  );
  // Main's recording of the RPM, the Basket and a machine setting the recipe does not hold, slot 1 still selected.
  steps.rpm = await step(() => put({ context: { extras: { rpm: 950 } } }));
  steps.basket = await step(() => put({ context: { extras: { basketId: highFlow.id, basketName: highFlow.name } } }));
  steps.machineSettingAdopted = await step(() => put({ steamSettings: { targetTemperature: 155 } }), { after: ["selection", "recipes", "workflow"] });
  // The dashboard's apply cleared the batch (slot 1 names a Bean but no batch): a batch set now is kept, and taken as the one armed.
  steps.batchFromEmpty = await step(() => put({ context: { beanBatchId: ethiopiaBatch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } }), {
    after: ["selection", "stored", "recipes", "workflow"],
  });
  steps.batchSwitch = await step(() => put({ context: { beanBatchId: brazilBatch.id, coffeeName: brazil.name, coffeeRoaster: brazil.roaster } }), {
    after: ["selection", "stored", "recipes", "workflow"],
  });
  await select();
  steps.grinderSwitch = await step(() => put({ context: { grinderId: grinder83.id, grinderModel: grinder83.model } }), { after: ["selection", "stored", "recipes", "workflow"] });
  // Selected from Node on a Workflow holding a batch, as the plugin selects after its load write.
  await api("PUT", "/workflow", { context: { beanBatchId: ethiopiaBatch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster, grinderId: null, grinderModel: null } });
  steps.selectWithBatch = await step(async () => [await selectFromNode()], { after: ["selection", "stored", "workflow"], settleMs: 0 });
  steps.batchCleared = await step(() => put({ context: { beanBatchId: null, coffeeName: null, coffeeRoaster: null } }), { after: ["selection", "stored", "recipes", "workflow"] });
  // The Shot is pulled with slot 2 selected, on Classic Italian espresso.
  await restartDecaid();
  await select("Fixture Brazil Espresso");
  steps.shot = await step(
    async () => {
      await pullShot();
      return [];
    },
    { after: ["selection", "workflow"], settleMs: 4000 },
  );
  await r.context.close();
  return steps;
}

/** DYE2's stored selection restored as it loads: `{}`, and a recipe. */
async function recordRestore() {
  log("restore");
  const steps = {};
  const reload = async () => {
    const exchanges = [await api("POST", "/plugins/dye2.reaplugin/disable"), await api("POST", "/plugins/dye2.reaplugin/enable")];
    // Read at once, then until DYE2 has read its storage.
    const answers = [];
    for (let read = 0; read < 10; read++) answers.push(await api("GET", SELECTION));
    await wait(1500);
    answers.push(await api("GET", SELECTION));
    return { exchanges, answers };
  };
  // Cleared, as stored after the shot step's selection.
  steps.clearBeforeRestore = await step(async () => [await api("POST", SELECTION, {})], { after: ["selection", "stored", "workflow"] });
  steps.storedAfterClear = await api("GET", STORED_SELECTION);
  const cleared = await api("POST", STORED_SELECTION, {});
  steps.restoreEmpty = { written: cleared, ...(await reload()) };
  const stored = { kind: "recipe", id: "2", profileFingerprint: null, armedBrewC: null };
  steps.restoreRecipe = { written: await api("POST", STORED_SELECTION, stored), ...(await reload()) };
  const drifted = { kind: "recipe", id: "2", profileFingerprint: '{"title":"Not the Workflow\'s profile"}', armedBrewC: 90 };
  steps.restoreDrifted = { written: await api("POST", STORED_SELECTION, drifted), ...(await reload()) };
  steps.driftedClearedOnChange = await step(async () => [await api("PUT", "/workflow", { context: { baristaName: "Fixture Barista 2" } })], { after: ["selection", "stored", "workflow"] });
  return steps;
}

/** Reads kept from Streamline: DYE2's selection, and its stored selection, which Streamline reads before its post-shot clear and its wake. */
const streamlineReads = (route) => route === SELECTION || route === STORED_SELECTION;

/** Streamline's DYE strip applying slot 2, its Drink and Dose tiles, its clear after a Shot, its wake and its strip switched off. */
async function recordStreamline(browser) {
  log("Streamline");
  const r = await recordedPage(browser, { viewport: { width: 1920, height: 1200 }, keepRead: streamlineReads });
  const { page } = r;
  page.on("console", (message) => {
    if (message.text().includes("dyeStrip")) log(`Streamline: ${message.text().slice(0, 160)}`);
  });
  await r.context.addInitScript(() => {
    localStorage.setItem("streamline.dye2Enabled", "true");
    localStorage.setItem("streamline.dyeStripMode", "R");
    localStorage.setItem("streamlineHelpHidden", "1");
  });
  const strip = (title) => page.locator("#dye-strip button", { hasText: title }).click();
  const steps = {};
  // What Streamline writes as it starts, nothing selected in DYE2.
  steps.started = await step(
    async () => {
      await page.goto(`${SKIN}/`);
      return r.take(8000);
    },
    { after: ["selection", "workflow"] },
  );
  steps.applySlot2 = await step(
    async () => {
      await strip("Fixture Brazil Espresso");
      return r.take(3000);
    },
    { after: ["selection", "stored", "recipes", "workflow"] },
  );
  await noteFingerprint("streamlineSlot2");
  steps.drinkTile = await step(
    async () => {
      await page.locator("#drink-out-plus").click();
      return r.take(3000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  steps.doseTile = await step(
    async () => {
      await page.locator("#dose-in-plus").click();
      return r.take(3000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  steps.applySlot2Again = await step(
    async () => {
      await strip("Fixture Brazil Espresso");
      return r.take(3000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  // As the plugin's load write would: a batch, coffee and Basket, so Streamline has them to clear, and a barista and drinker.
  const brazil = await beanNamed("Fixture Brazil");
  const batch = await batchOf(brazil);
  const basket = await basketNamed("Fixture 20g High-flow");
  const loadWrite = { context: { beanBatchId: batch.id, coffeeName: brazil.name, coffeeRoaster: brazil.roaster, baristaName: "Fixture Barista", drinkerName: "Fixture Drinker", extras: { basketId: basket.id, basketName: basket.name, note: "Fixture note" } } };
  await restartDecaid();
  steps.restarted = await step(
    async () => {
      await page.goto(`${SKIN}/`);
      return r.take(8000);
    },
    { after: ["selection", "workflow"] },
  );
  steps.writtenBeforeShot = await step(() => put(loadWrite), { after: ["selection", "workflow"] });
  steps.shotCleared = await step(
    async () => {
      await pullShot();
      return r.take(4000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  // The wake onto the profile of the recipe selected, then onto another.
  steps.wake = await step(
    async () => {
      const id = (await profileTitled("Classic Italian espresso")).id;
      await page.evaluate(async (profileId) => (await import("/src/modules/profileManager.js")).loadProfileForWake(profileId), id);
      return r.take(2000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  steps.wakeOtherProfile = await step(
    async () => {
      const id = (await profileTitled("Adaptive v3")).id;
      await page.evaluate(async (profileId) => (await import("/src/modules/profileManager.js")).loadProfileForWake(profileId), id);
      return r.take(2000);
    },
    { after: ["selection", "stored", "recipes", "workflow"] },
  );
  // Nothing selected: the clear after a Shot, DYE2 loaded and the strip on.
  await restartDecaid();
  await page.goto(`${SKIN}/`);
  await r.take(8000);
  steps.writtenBeforeShotNoSelection = await step(() => put(loadWrite), { after: ["selection", "stored", "workflow"] });
  steps.shotClearedNoSelection = await step(
    async () => {
      await pullShot();
      return r.take(4000);
    },
    { after: ["selection", "workflow"] },
  );
  // Slot 1 selected on DYE2's dashboard, then slot 2 applied on the strip with its first selection failing (injected): Streamline's retry.
  const dashboard = await recordedPage(browser, { keepRead: dashboardReads });
  await dashboard.page.goto(DYE2("dashboard"));
  await dashboard.take(3000);
  await dashboard.page.locator('#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)[title="Fixture Ethiopia Espresso"]').click();
  steps.selectedOnDashboard = { exchanges: await dashboard.take(1500) };
  await dashboard.context.close();
  await wait(3500);
  let failures = 2;
  r.state.fail = (request) => (request.method === "POST" && request.path === SELECTION && failures-- > 0 ? { status: 503, body: { error: "Injected for the recording" } } : undefined);
  steps.applyRetried = await step(
    async () => {
      await strip("Fixture Brazil Espresso");
      return r.take(6000);
    },
    { after: ["selection", "stored", "recipes", "workflow"] },
  );
  r.state.fail = undefined;
  steps.applySlot2BeforeOff = await step(
    async () => {
      await strip("Fixture Brazil Espresso");
      return r.take(3000);
    },
    { after: ["selection"] },
  );
  steps.stripOff = await step(
    async () => {
      await page.evaluate(() => {
        localStorage.setItem("streamline.dye2Enabled", "false");
        window.applyDye2Enabled(false);
      });
      return r.take(2000);
    },
    { after: ["selection", "stored", "workflow"] },
  );
  await r.context.close();
  return steps;
}

const keys = async () => Object.fromEntries(await Promise.all(["recipes", "baskets", "equipment"].map(async (key) => [key, (await api("GET", `/store/dye2.reaplugin/${key}`)).response.body])));

changed = listen("dye2.reaplugin", "changed");
recorder = listen("workflow-recorder.reaplugin", "workflow");
if ((await changed.opened) !== 101 || (await recorder.opened) !== 101) throw new Error("A socket did not open");
await seedLibrary();
const library = {
  beans: (await api("GET", "/beans")).response.body,
  beanBatches: (await api("GET", "/bean-batches")).response.body,
  grinders: (await api("GET", "/grinders")).response.body,
  // The bundled profiles the recipes use: slot 1's, picked from the library, and the one slot 2 reads from the Workflow.
  profiles: (await api("GET", "/profiles")).response.body.filter((record) => ["Adaptive v3", "Classic Italian espresso"].includes(record.profile.title)),
  workflow: await workflow(),
  machineSettings: (await api("GET", "/machine/settings")).response.body,
};
write("store.json", await recordStore());
const browser = await chromium.launch();
try {
  write("tools.json", await recordTools(browser));
  write("baskets.json", await recordBaskets(browser));
  write("recipes.json", await recordRecipes(browser));
  write("dye2-applies.json", await recordDye2Applies(browser));
  const shotId = await pullShot();
  const pulled = await api("GET", `/shots/${shotId}`);
  const edited = await recordEditShot(browser, shotId);
  write("shot.json", { pulled, ...edited, edited: await api("GET", `/shots/${shotId}`) });
  write("keys.json", await keys());

  // A favourite, and a Shot pulled with a batch so DYE2 has a recent favourite; then nothing selected, on Classic Italian espresso.
  const favouriteId = await makeFavourite(browser);
  const ethiopia = await beanNamed("Fixture Ethiopia");
  await api("PUT", "/workflow", { context: { beanBatchId: (await batchOf(ethiopia)).id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } });
  await restartDecaid();
  await pullShot();
  await api("PUT", "/workflow", { profile: (await profileTitled("Classic Italian espresso")).profile });
  await api("POST", SELECTION, {});
  await wait(2000);
  write("library.json", {
    ...library,
    recipes: (await api("GET", RECIPES)).response.body,
    baskets: (await api("GET", "/store/dye2.reaplugin/baskets")).response.body,
    favourite: favouriteId,
    selectionWorkflow: await workflow(),
    storedSelection: (await api("GET", STORED_SELECTION)).response.body,
  });
  write("plugins.json", await recordPlugins());
  write("dashboard.json", await recordDashboard(browser, favouriteId));
  write("recording.json", await recordRecording(browser));
  write("restore.json", await recordRestore());
  write("streamline.json", await recordStreamline(browser));
  write("fingerprints.json", fingerprints);
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
log("done");
