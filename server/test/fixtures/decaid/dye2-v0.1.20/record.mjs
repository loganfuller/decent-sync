// Records how DYE2 v0.1.20 keeps its selected recipe and records into it,
// and how Streamline v0.2.14 applies, selects and clears, as README.md
// describes: drives their pages in headless Chromium and sends requests from
// Node, as the plugin would, keeping each exchange with Decaid's answer, the
// pushes heard on DYE2's `changed` socket and the Workflows Decaid sent
// plugins (heard through workflow-recorder/, beside this script). Run it
// once, against a Decaid whose data is new, with DYE2 v0.1.20 and the
// recorder installed and enabled and Streamline's release files served at
// SKIN:
//
//   node server/test/fixtures/decaid/dye2-v0.1.20/record.mjs <output dir>
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
/** DYE2's wait before it records, and a margin. */
const RECORDED_MS = 2500;
/** The routes whose requests a page sends that are kept: DYE2's selection and keys, Streamline's remembered values, the Workflow; of the reads, only DYE2's selection. */
const KEPT = [/^\/plugins\/dye2\.reaplugin\/selection$/, /^\/store\/dye2\.reaplugin\/(recipes|selection)$/, /^\/store\/streamline-app\/[^/]+$/, /^\/workflow$/];
const log = (message) => console.log(new Date().toISOString(), message);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const out = process.argv[2];
if (!out) throw new Error("Usage: record.mjs <output dir>");
fs.mkdirSync(out, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + "\n");

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
/** The pushes heard on DYE2's `changed` socket since the mark. */
const pushesSince = (mark) => changed.heard.slice(mark).map(({ payload }) => payload);

/**
 * A page whose kept requests are recorded, in the order sent. Each is fetched
 * by Playwright and its answer handed to the page unchanged, so an answer is
 * recorded even when a page navigates away before reading it.
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
    // Of the reads, only those of DYE2's selection are kept.
    if (request.method() === "GET" && routePath !== SELECTION) return route.continue();
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

/**
 * A step: the exchanges `act` gives, then, as `after` asks, DYE2's selection,
 * its stored selection and its recipes read once DYE2 would have recorded,
 * and the pushes heard on `changed` meanwhile.
 */
async function step(act, { after = ["selection", "recipes"], settleMs = RECORDED_MS } = {}) {
  const mark = changed.heard.length;
  const exchanges = await act();
  await wait(settleMs);
  const reads = [];
  if (after.includes("selection")) reads.push(await api("GET", SELECTION));
  if (after.includes("stored")) reads.push(await api("GET", STORED_SELECTION));
  if (after.includes("recipes")) reads.push(await api("GET", "/store/dye2.reaplugin/recipes"));
  if (after.includes("workflow")) reads.push(await api("GET", "/workflow"));
  return { exchanges, after: reads, pushes: pushesSince(mark) };
}

const workflow = async () => (await api("GET", "/workflow")).response.body;
const profileTitled = async (title) => (await api("GET", "/profiles?includeHidden=true")).response.body.find((record) => record.profile.title === title);

// ---- The library, baskets and recipes DYE2's pages pick from, made up for the recording.

async function seedLibrary() {
  const ethiopia = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  const brazil = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Brazil", country: "Brazil", processing: "Natural" })).response.body;
  await api("POST", `/beans/${ethiopia.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 });
  await api("POST", `/beans/${brazil.id}/batches`, { roastDate: "2026-10-03T00:00:00.000", weight: 1000 });
  await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
}

async function makeBaskets(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  await page.goto(DYE2("baskets"));
  await r.take(2000);
  for (const fields of [
    { name: "Fixture 18g Precision", diameterMm: "58.5" },
    { name: "Fixture 20g High-flow", diameterMm: "58" },
  ]) {
    await page.locator(".dye-card-add").click();
    const form = page.locator("#dye-basket-form");
    await form.locator("input[name=name]").fill(fields.name);
    await form.locator("select[name=size]").selectOption("double");
    await form.locator("input[name=diameterMm]").fill(fields.diameterMm);
    await page.locator("#dye-modal-save").click();
    await page.locator("#dye-modal-backdrop").waitFor({ state: "hidden" });
    await r.take();
  }
  await r.context.close();
}

/** Saves slot 1 (Adaptive v3, hot water by temperature, steam by time) and slot 2 (Classic Italian espresso read from the Workflow, hot water by volume, steam by flow) in DYE2's recipe editor. */
async function makeRecipes(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  const open = async (tab) => {
    await page.goto(DYE2("recipe-edit"));
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
  const chip = (list, name) => page.locator(`#${list}`).getByText(name, { exact: true }).click();
  const save = async () => {
    await page.locator("#re-save-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    await r.take(2000);
  };
  log("slot 1");
  await open(0);
  await page.locator("#re-name-input").fill("Fixture Ethiopia Espresso");
  await chip("re-bean-chips", "Fixture Ethiopia");
  await chip("re-profile-chips", "Adaptive v3");
  await chip("re-grinder-chips", "Fixture Grinder 64");
  await chip("re-basket-chips", "Fixture 18g Precision");
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
  await save();
  log("slot 2");
  await api("PUT", "/workflow", { profile: (await profileTitled("Classic Italian espresso")).profile });
  await open(1);
  await page.locator("#re-read-from-btn").click();
  await page.locator("#re-read-from-workflow").click();
  await r.take();
  await page.locator("#re-name-input").fill("Fixture Brazil Espresso");
  await chip("re-bean-chips", "Fixture Brazil");
  await chip("re-grinder-chips", "Fixture Grinder 64");
  await chip("re-basket-chips", "Fixture 20g High-flow");
  await stepper("re-dose", 19);
  await stepper("re-drink", 36);
  await page.locator('.re-steam-mode[data-mode="flow"]').click();
  await stepper("re-steam", 1.2);
  await stepper("re-flush", 4);
  await page.locator('.re-hotwater-mode[data-mode="vol"]').click();
  await stepper("re-hotwater", 150);
  await stepper("re-grind", 3);
  await stepper("re-rpm", 1100);
  await save();
  await r.context.close();
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

/**
 * Restarts Decaid, keeping its data, with the command RESTART_DECAID names,
 * and opens the sockets again: its simulated machine stored only the first
 * Shot pulled after it started. Resolves once DYE2 has loaded and restored
 * its selection.
 */
async function restartDecaid() {
  if (!process.env.RESTART_DECAID) return;
  log("restarting Decaid");
  execFileSync(process.env.RESTART_DECAID, { stdio: "inherit" });
  for (let waited = 0; !(await plugins().catch(() => [])).some((plugin) => plugin.loaded); waited++) {
    if (waited > 60) throw new Error("DYE2 did not load");
    await wait(1000);
  }
  await wait(3000);
  changed = listen("dye2.reaplugin", "changed");
  recorder = listen("workflow-recorder.reaplugin", "workflow");
  if ((await changed.opened) !== 101 || (await recorder.opened) !== 101) throw new Error("A socket did not open");
  await wait(2000);
}

/** Pulls a Shot on Decaid's simulated machine, and resolves once it is stored and the machine idle. */
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

// ---- What is recorded.

const plugins = async () => (await api("GET", "/plugins")).response.body.filter((plugin) => plugin.id === "dye2.reaplugin");

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

/** DYE2's dashboard: a recipe applied, the Workflow changed from elsewhere, a dial tap and Done; a recent and a saved favourite applied; a clear. */
async function recordDashboard(browser, favouriteId) {
  log("dashboard");
  const r = await recordedPage(browser);
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
    { after: ["selection", "stored", "recipes"] },
  );
  await noteFingerprint("dashboardSlot1");
  // As the plugin's load write would, after the page read the Workflow: another batch and its coffee, a Basket and a hot water volume.
  const beans = (await api("GET", "/beans")).response.body;
  const brazil = beans.find((bean) => bean.name === "Fixture Brazil");
  const batch = (await api("GET", "/bean-batches")).response.body.find((candidate) => candidate.beanId === brazil.id);
  const basket = (await api("GET", "/store/dye2.reaplugin/baskets")).response.body.find((candidate) => candidate.name === "Fixture 18g Precision");
  steps.writtenElsewhere = await step(
    async () => [
      await api("PUT", "/workflow", {
        context: { beanBatchId: batch.id, coffeeName: brazil.name, coffeeRoaster: brazil.roaster, extras: { basketId: basket.id, basketName: basket.name } },
        hotWaterData: { volume: 90 },
      }),
    ],
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
  steps.clear = await step(async () => [await api("POST", SELECTION, {})], { after: ["selection", "stored"] });
  await r.context.close();
  return steps;
}

/** What DYE2 records into the selected recipe, slot 1, from Workflow changes sent from Node, and what clears the selection. */
async function recordRecording(browser) {
  log("recording");
  const r = await recordedPage(browser);
  const { page } = r;
  const steps = {};
  const select = async () => {
    await page.goto(DYE2("dashboard"));
    await r.take(3000);
    await page.locator('#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)[title="Fixture Ethiopia Espresso"]').click();
    const exchanges = await r.take(1500);
    // Past DYE2's 3 s echo window.
    await wait(3500);
    return exchanges;
  };
  steps.select = await step(select, { after: ["selection", "recipes", "workflow"], settleMs: 0 });
  const put = async (body) => [await api("PUT", "/workflow", body)];
  steps.grind = await step(() => put({ context: { grinderSetting: "2.4" } }));
  steps.dose = await step(() => put({ context: { targetDoseWeight: 18.5 } }));
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
  steps.profileChange = await step(async () => put({ profile: (await profileTitled("Classic Italian espresso")).profile }), { after: ["selection", "stored", "recipes"] });
  await select();
  steps.targetWeightOnly = await step(async () => {
    const current = (await workflow()).profile;
    return put({ profile: { ...current, target_weight: 40 } });
  }, { after: ["selection", "stored", "recipes"] });
  // Decaid's simulated machine stores no Shot pulled on Adaptive v3, so the Shot is pulled on Classic Italian espresso.
  await api("PUT", "/workflow", { profile: (await profileTitled("Classic Italian espresso")).profile });
  await restartDecaid();
  steps.shot = await step(
    async () => {
      await pullShot();
      return [];
    },
    { after: ["selection"], settleMs: 4000 },
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
  steps.storedAfterClear = await api("GET", STORED_SELECTION);
  const cleared = await api("POST", STORED_SELECTION, {});
  steps.restoreEmpty = { written: cleared, ...(await reload()) };
  const stored = { kind: "recipe", id: "2", profileFingerprint: null, armedBrewC: null };
  steps.restoreRecipe = { written: await api("POST", STORED_SELECTION, stored), ...(await reload()) };
  const drifted = { kind: "recipe", id: "2", profileFingerprint: '{"title":"Not the Workflow\'s profile"}', armedBrewC: 90 };
  steps.restoreDrifted = { written: await api("POST", STORED_SELECTION, drifted), ...(await reload()) };
  steps.driftedClearedOnChange = await step(async () => [await api("PUT", "/workflow", { context: { baristaName: "Fixture Barista 2" } })], { after: ["selection", "stored"] });
  return steps;
}

/** Streamline's DYE strip applying slot 2, its Drink tile, its clear after a Shot, its wake re-send and its strip switched off. */
async function recordStreamline(browser) {
  log("Streamline");
  const r = await recordedPage(browser, { width: 1920, height: 1200 });
  const { page } = r;
  page.on("console", (message) => {
    if (message.text().includes("dyeStrip")) log(`Streamline: ${message.text().slice(0, 160)}`);
  });
  await r.context.addInitScript(() => {
    localStorage.setItem("streamline.dye2Enabled", "true");
    localStorage.setItem("streamline.dyeStripMode", "R");
    localStorage.setItem("streamlineHelpHidden", "1");
  });
  await page.goto(`${SKIN}/`);
  await r.take(8000);
  const steps = {};
  steps.applySlot2 = await step(
    async () => {
      await page.locator("#dye-strip button", { hasText: "Fixture Brazil Espresso" }).click();
      return r.take(3000);
    },
    { after: ["selection", "stored", "recipes"] },
  );
  await noteFingerprint("streamlineSlot2");
  steps.drinkTile = await step(
    async () => {
      await page.locator("#drink-out-plus").click();
      return r.take(3000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  steps.applySlot2Again = await step(
    async () => {
      await page.locator("#dye-strip button", { hasText: "Fixture Brazil Espresso" }).click();
      return r.take(3000);
    },
    { after: ["selection"] },
  );
  // As the plugin's load write would: a batch, coffee and Basket, so Streamline has them to clear.
  const beans = (await api("GET", "/beans")).response.body;
  const brazil = beans.find((bean) => bean.name === "Fixture Brazil");
  const batch = (await api("GET", "/bean-batches")).response.body.find((candidate) => candidate.beanId === brazil.id);
  const basket = (await api("GET", "/store/dye2.reaplugin/baskets")).response.body.find((candidate) => candidate.name === "Fixture 20g High-flow");
  await restartDecaid();
  await page.goto(`${SKIN}/`);
  await r.take(8000);
  steps.writtenBeforeShot = await step(
    async () => [await api("PUT", "/workflow", { context: { beanBatchId: batch.id, coffeeName: brazil.name, coffeeRoaster: brazil.roaster, extras: { basketId: basket.id, basketName: basket.name } } })],
    { after: ["selection", "workflow"] },
  );
  steps.shotCleared = await step(
    async () => {
      await pullShot();
      return r.take(4000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  // The profile the Drink tile saved a yield for, sent as a wake sends it.
  steps.wake = await step(
    async () => {
      const id = (await profileTitled("Classic Italian espresso")).id;
      await page.evaluate(async (profileId) => (await import("/src/modules/profileManager.js")).loadProfileForWake(profileId), id);
      return r.take(2000);
    },
    { after: ["selection", "recipes", "workflow"] },
  );
  steps.applySlot2BeforeOff = await step(
    async () => {
      await page.locator("#dye-strip button", { hasText: "Fixture Brazil Espresso" }).click();
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
    { after: ["selection", "stored"] },
  );
  await r.context.close();
  return steps;
}

changed = listen("dye2.reaplugin", "changed");
recorder = listen("workflow-recorder.reaplugin", "workflow");
if ((await changed.opened) !== 101 || (await recorder.opened) !== 101) throw new Error("A socket did not open");
await seedLibrary();
const browser = await chromium.launch();
try {
  await makeBaskets(browser);
  await makeRecipes(browser);
  const favouriteId = await makeFavourite(browser);
  // A Shot pulled with a batch, so DYE2 has a recent favourite.
  const ethiopia = (await api("GET", "/beans")).response.body.find((bean) => bean.name === "Fixture Ethiopia");
  const batch = (await api("GET", "/bean-batches")).response.body.find((candidate) => candidate.beanId === ethiopia.id);
  await api("PUT", "/workflow", { context: { beanBatchId: batch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } });
  await pullShot();
  await api("PUT", "/workflow", { profile: (await profileTitled("Classic Italian espresso")).profile });
  await wait(2000);
  write("library.json", {
    beans: (await api("GET", "/beans")).response.body,
    beanBatches: (await api("GET", "/bean-batches")).response.body,
    grinders: (await api("GET", "/grinders")).response.body,
    profiles: (await api("GET", "/profiles")).response.body.filter((record) => ["Adaptive v3", "Classic Italian espresso"].includes(record.profile.title)),
    workflow: await workflow(),
    recipes: (await api("GET", "/store/dye2.reaplugin/recipes")).response.body,
    baskets: (await api("GET", "/store/dye2.reaplugin/baskets")).response.body,
    favourite: favouriteId,
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
