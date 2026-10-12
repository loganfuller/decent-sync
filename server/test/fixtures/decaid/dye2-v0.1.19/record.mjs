// Records what DYE2 v0.1.19 and Streamline v0.2.13 write to Decaid, as
// README.md describes: drives their pages in headless Chromium and keeps each
// request they send to Decaid's store keys, the Workflow and Shots, with
// Decaid's answer. Run it once, against a Decaid whose data is new, with DYE2
// v0.1.19 installed and Streamline's release files served at SKIN:
//
//   node server/test/fixtures/decaid/dye2-v0.1.19/record.mjs <output dir>
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const SKIN = process.env.SKIN ?? "http://localhost:13999";
const DYE2 = (page) => `${DECAID}/api/v1/plugins/dye2.reaplugin/${page}`;
/** The routes whose requests are kept: DYE2's keys, Streamline's remembered values, the Workflow and single Shots. */
const KEPT = [/^\/store\/dye2\.reaplugin\/(recipes|baskets|equipment)$/, /^\/store\/streamline-app\/[^/]+$/, /^\/workflow$/, /^\/shots\/[^/?]+$/];
const log = (message) => console.log(new Date().toISOString(), message);

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
 * A page whose kept requests are recorded, in the order sent. Each is fetched
 * by Playwright and its answer handed to the page unchanged, so an answer is
 * recorded even when the page navigates away before reading it.
 */
async function recordedPage(browser, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  const recorded = [];
  await context.route(/\/api\/v1\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const routePath = url.pathname.slice("/api/v1".length);
    if (request.method() === "OPTIONS" || !KEPT.some((pattern) => pattern.test(routePath))) return route.continue();
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

// The library DYE2's pages pick from, made up for the recording.
async function seedLibrary() {
  const ethiopia = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  const brazil = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Brazil", country: "Brazil", processing: "Natural" })).response.body;
  await api("POST", `/beans/${ethiopia.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 });
  await api("POST", `/beans/${brazil.id}/batches`, { roastDate: "2026-10-03T00:00:00.000", weight: 1000 });
  await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
}

/** Decaid's store answering a key never written, a POST, a read, a DELETE and a DELETE of a key it no longer holds. */
async function recordStore() {
  const key = "/store/dye2.reaplugin/recipes";
  return [await api("GET", key), await api("POST", key, []), await api("GET", key), await api("DELETE", key), await api("GET", key), await api("DELETE", key)];
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
  const profiles = (await api("GET", "/profiles")).response.body;
  await api("PUT", "/workflow", { profile: profiles.find((record) => record.profile.title === "Classic Italian espresso").profile });
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

/** DYE2's dashboard applying each recipe, then a basket picked for the next Shot. */
async function recordDashboard(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  const open = async () => {
    await page.goto(DYE2("dashboard"));
    await r.take(3000);
  };
  const apply = async (title) => {
    await open();
    await page.locator(`#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)[title="${title}"]`).click();
    return r.take(2000);
  };
  const steps = {};
  log("DYE2 applies");
  steps.applySlot1 = await apply("Fixture Ethiopia Espresso");
  steps.applySlot2 = await apply("Fixture Brazil Espresso");
  steps.applyBlankSlot3 = await apply("Fixture Blank Recipe");
  steps.applySlot1Again = await apply("Fixture Ethiopia Espresso");
  log("basket picked for the next Shot");
  await open();
  await page.locator("#dye-basket-field").click();
  await page.waitForURL(/basket-picker/);
  await page.waitForTimeout(1500);
  await page.locator(".dye-card:not(.dye-card-add)", { has: page.locator(".dye-card-name", { hasText: "Fixture 20g High-flow" }) }).click();
  await page.locator("#dye-confirm-btn").click();
  await page.waitForURL(/dashboard/, { waitUntil: "commit" });
  steps.pickBasket = await r.take(2000);
  await r.context.close();
  return steps;
}

/** Pulls a Shot on Decaid's simulated machine, and gives its id once it is stored and the machine idle. */
async function pullShot() {
  const listed = async () => (await api("GET", "/shots?limit=1")).response.body.items[0]?.id;
  const before = await listed();
  log("pulling a Shot");
  await api("PUT", "/machine/state/espresso");
  for (let waited = 0; waited < 180; waited++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const latest = await listed();
    const state = (await api("GET", "/machine/state")).response.body.state.state;
    if (latest && latest !== before && state !== "espresso") return latest;
  }
  throw new Error("No Shot was stored");
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

/** Streamline as the tablet's skin: its DYE strip applying DYE2's recipes, and its auto-save into the one applied. */
async function recordStreamline(browser) {
  const r = await recordedPage(browser, { width: 1920, height: 1200 });
  const { page } = r;
  page.on("console", (message) => {
    if (message.text().includes("dyeStrip")) log(`Streamline: ${message.text().slice(0, 160)}`);
  });
  // Its DYE strip turned on, showing recipes, and its help button hidden, as its settings do.
  await r.context.addInitScript(() => {
    localStorage.setItem("streamline.dye2Enabled", "true");
    localStorage.setItem("streamline.dyeStripMode", "R");
    localStorage.setItem("streamlineHelpHidden", "1");
  });
  await page.goto(`${SKIN}/`);
  // What Streamline reads as it starts is not kept.
  await r.take(8000);
  const steps = {};
  const tap = async (title) => {
    await page.locator("#dye-strip button", { hasText: title }).click();
    return r.take(5000);
  };
  // Streamline writes a change after 1 s, and saves it into the recipe 1.5 s after that.
  const change = async (control) => {
    await page.locator(control).click();
    return r.take(5000);
  };
  log("Streamline");
  steps.applySlot2 = await tap("Fixture Brazil Espresso");
  steps.autoSaveDose = await change("#dose-in-plus");
  steps.autoSaveGrind = await change("#grind-plus");
  steps.autoSaveHotWater = await change("#hot-water-vol-plus");
  steps.autoSaveSteam = await change("#steam-plus");
  steps.applySlot1 = await tap("Fixture Ethiopia Espresso");
  steps.noAutoSaveAfterLibraryProfile = await change("#grind-plus");
  await r.context.close();
  return steps;
}

const keys = async () => Object.fromEntries(await Promise.all(["recipes", "baskets", "equipment"].map(async (key) => [key, (await api("GET", `/store/dye2.reaplugin/${key}`)).response.body])));

await seedLibrary();
write("library.json", {
  beans: (await api("GET", "/beans")).response.body,
  beanBatches: (await api("GET", "/bean-batches")).response.body,
  grinders: (await api("GET", "/grinders")).response.body,
  // The bundled profiles the recipes use: slot 1's, picked from the library, and the one slot 2 reads from the Workflow.
  profiles: (await api("GET", "/profiles")).response.body.filter((record) => ["Adaptive v3", "Classic Italian espresso"].includes(record.profile.title)),
  workflow: (await api("GET", "/workflow")).response.body,
});
write("store.json", await recordStore());
const browser = await chromium.launch();
try {
  write("tools.json", await recordTools(browser));
  write("baskets.json", await recordBaskets(browser));
  write("recipes.json", await recordRecipes(browser));
  write("dye2-applies.json", await recordDashboard(browser));
  const shotId = await pullShot();
  const pulled = await api("GET", `/shots/${shotId}`);
  const edited = await recordEditShot(browser, shotId);
  write("shot.json", { pulled, ...edited, edited: await api("GET", `/shots/${shotId}`) });
  await api("PUT", "/machine/state/idle");
  write("streamline.json", await recordStreamline(browser));
  write("keys.json", await keys());
} finally {
  await browser.close();
}
log("done");
