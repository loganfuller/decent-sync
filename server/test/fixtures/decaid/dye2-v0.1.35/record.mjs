// Records what DYE2 v0.1.35 changed from v0.1.33 in what it writes to
// Decaid v0.9.1, where it touches what Decent Sync writes and records, as
// README.md describes: drives DYE2's pages in headless Chromium and sends
// requests from Node, as the plugin would, keeping each exchange with
// Decaid's answer, the pushes heard on DYE2's `changed` socket and the
// Workflows Decaid sent plugins (heard through
// ../dye2-v0.1.26/workflow-recorder/). Run it once, from the repository root,
// against a Decaid whose data is new, still holding its bundled DYE2:
//
//   node server/test/fixtures/decaid/dye2-v0.1.35/record.mjs <output dir>
//
// It installs the recorder and, once it has seeded DYE2's keys as Decent
// Sync's server leaves them, DYE2's `dist` deploy of v0.1.35 from GitHub,
// as the owner's tablets are pinned to. Its helpers are
// ../dye2-v0.1.33/record.mjs's.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const SOCKETS = DECAID.replace(/^http/, "ws");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(HERE, "..", "dye2-v0.1.26", "workflow-recorder");
const DYE2 = (page) => `${DECAID}/api/v1/plugins/dye2.reaplugin/${page}`;
const SELECTION = "/plugins/dye2.reaplugin/selection";
const RECORD = "/plugins/dye2.reaplugin/record";
const STORE = "/store/dye2.reaplugin";
const STORED_SELECTION = `${STORE}/selection`;
const RECIPES = `${STORE}/recipes`;
const FAVOURITES = `${STORE}/autoFavourites`;
/** DYE2's `dist` deploy of the v0.1.35 tag, `c066d43`, as the owner's tablets are to run it. */
const DYE2_DIST = "3e3138657f8440c869b1714df469b8de7b2912b8";
/** Time for DYE2 to follow a Workflow change (its recipeId check, its mirror and push), and a margin. */
const SETTLE_MS = 2500;
/** The routes whose requests a page sends that are kept: DYE2's routes and keys, the Workflow, single Shots and the grinders. */
const KEPT = [
  /^\/plugins\/dye2\.reaplugin\/(selection|record|save-recipe)$/,
  /^\/store\/dye2\.reaplugin\/(recipes|baskets|equipment|selection|autoFavourites)$/,
  /^\/workflow$/,
  /^\/shots\/[^/?]+$/,
  /^\/grinders(\/[^/?]+)?$/,
];
/** DYE2's one-time migrations, by their store flags: v0.1.34 and v0.1.35 add none to v0.1.32's. */
const MIGRATION_FLAGS = ["selectionMigrated", "recipesMigrated", "favSlotsMigrated", "favProfilesMigrated", "recipeBeansMigrated", "favBeansMigrated"];
const log = (message) => console.log(new Date().toISOString(), message);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const out = process.argv[2];
if (!out) throw new Error("Usage: record.mjs <output dir> [--compact]");
fs.mkdirSync(out, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + "\n");

/** Files whose profiles stay whole. */
const WHOLE_PROFILES = new Set(["library.json"]);
const isProfile = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.title === "string" && Array.isArray(value.steps) && "tank_temperature" in value;

/**
 * The recordings made smaller, once every file is written, as
 * ../dye2-v0.1.33/record.mjs makes its own: in each file, in document order,
 * a read of DYE2's `recipes`, of `/workflow`, or of one of DYE2's keys in
 * `loading.json`'s snapshots, whose answer is the same as the last one read
 * or posted before it in that file, keeps its status and `unchanged: true`
 * in place of its body; and outside `WHOLE_PROFILES`, each whole profile is
 * `{"$profile": "<title>/<hash>"}`, one copy of each kept in
 * `library.json`'s `profileCopies`. A profile's hash is of its JSON, so the
 * same profile in another key order is another copy.
 */
function compactAll(dir) {
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  const copies = {};
  for (const file of files) {
    const last = {};
    const seen = (key, body) => {
      const text = JSON.stringify(body);
      if (last[key] === text) return true;
      last[key] = text;
      return false;
    };
    const keyOf = (route) => (route === RECIPES ? "recipes" : route === "/workflow" ? "workflow" : null);
    const walk = (value) => {
      if (Array.isArray(value)) return value.map(walk);
      if (value === null || typeof value !== "object") return value;
      if (value.request && value.response && typeof value.request.path === "string") {
        const key = keyOf(value.request.path.split("?")[0]);
        if (key && value.request.method === "POST" && key === "recipes") seen(key, value.request.body);
        if (key && value.request.method === "GET" && value.response.status === 200 && "body" in value.response && seen(key, value.response.body)) {
          return { request: value.request, response: { status: value.response.status, unchanged: true } };
        }
        return value;
      }
      if (value.values && value.keys && "workflow" in value) {
        // A snapshot of DYE2's keys (loading.json).
        const values = Object.fromEntries(Object.entries(value.values).map(([key, body]) => [key, seen(`key:${key}`, body) ? { unchanged: true } : body]));
        return { ...value, values, workflow: seen("workflow", value.workflow) ? { unchanged: true } : value.workflow };
      }
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, walk(field)]));
    };
    const byRef = (value) => {
      if (Array.isArray(value)) return value.map(byRef);
      if (value === null || typeof value !== "object") return value;
      if (isProfile(value)) {
        const text = JSON.stringify(value);
        const ref = `${value.title}/${createHash("sha256").update(text).digest("hex").slice(0, 10)}`;
        copies[ref] = value;
        return { $profile: ref };
      }
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, byRef(field)]));
    };
    const full = path.join(dir, file);
    let value = walk(JSON.parse(fs.readFileSync(full, "utf8")));
    if (!WHOLE_PROFILES.has(file)) value = byRef(value);
    fs.writeFileSync(full, JSON.stringify(value, null, 2) + "\n");
  }
  const libraryFile = path.join(dir, "library.json");
  const library = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
  library.profileCopies = Object.fromEntries(Object.keys(copies).sort().map((ref) => [ref, copies[ref]]));
  fs.writeFileSync(libraryFile, JSON.stringify(library, null, 2) + "\n");
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

/** DYE2's `profileAtBrewC`: the first step at `brewC`, every other step moved by as much. */
function profileAtBrewC(profile, brewC) {
  const shift = brewC - profile.steps[0].temperature;
  return { ...profile, steps: profile.steps.map((step) => ({ ...step, temperature: Math.round((step.temperature + shift) * 100) / 100 })) };
}

/** A value with every object's keys in PostgreSQL's `jsonb` order, shorter keys first, then bytewise, as Decent Sync's server reads a Profile back. */
function jsonbOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value).sort((a, b) => (a.length !== b.length ? a.length - b.length : Buffer.compare(Buffer.from(a), Buffer.from(b))));
  return Object.fromEntries(keys.map((key) => [key, jsonbOrder(value[key])]));
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

async function openChanged() {
  changed = listen("dye2.reaplugin", "changed");
  if ((await changed.opened) !== 101) throw new Error("DYE2's changed socket did not open");
}

/** Reads kept on most pages: all of the kept routes but DYE2's favourites, which hold whole Shots' Workflows. */
const mostReads = (route) => route !== FAVOURITES;

/**
 * A page whose kept requests are recorded, in the order sent. Each is fetched
 * by Playwright and its answer handed to the page unchanged, so an answer is
 * recorded even when a page navigates away before reading it. Of the reads,
 * only those `keepRead` accepts are kept.
 */
async function recordedPage(browser, { viewport = { width: 1280, height: 800 }, keepRead = mostReads } = {}) {
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
    if (request.method() === "GET" && !keepRead(routePath)) return route.continue();
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
 * A step: the exchanges `act` gives, then, as `after` asks, reads made once
 * DYE2 has followed (DYE2's derived selection, its stored mirror of it, its
 * recipes, the Workflow), the pushes heard on `changed` meanwhile, the
 * context of each Workflow Decaid sent plugins in a `workflowUpdated`
 * (`events`), and when each push and event came, in ms from the step's
 * start (`timing`).
 */
async function step(act, { after = ["selection", "recipes"], settleMs = SETTLE_MS } = {}) {
  const mark = changed.heard.length;
  const eventMark = recorder.heard.length;
  const started = Date.now();
  const exchanges = await act();
  await wait(settleMs);
  const reads = [];
  if (after.includes("selection")) reads.push(await api("GET", SELECTION));
  if (after.includes("stored")) reads.push(await api("GET", STORED_SELECTION));
  if (after.includes("recipes")) reads.push(await api("GET", RECIPES));
  if (after.includes("workflow")) reads.push(await api("GET", "/workflow"));
  if (after.includes("favourites")) reads.push(await api("GET", FAVOURITES));
  if (after.includes("grinders")) reads.push(await api("GET", "/grinders?includeArchived=true"));
  const pushes = changed.heard.slice(mark).filter(({ at }) => at >= started);
  const events = recorder.heard.slice(eventMark).filter(({ at }) => at >= started);
  return {
    exchanges,
    after: reads,
    pushes: pushes.map(({ payload }) => payload),
    events: events.map(({ payload }) => payload.workflow?.context ?? null),
    timing: { pushes: pushes.map(({ at }) => at - started), events: events.map(({ at }) => at - started) },
  };
}

const workflow = async () => (await api("GET", "/workflow")).response.body;
const profileTitled = async (title) => (await api("GET", "/profiles?includeHidden=true")).response.body.find((record) => record.profile.title === title);
const plugins = async () => (await api("GET", "/plugins")).response.body.filter((plugin) => plugin.id === "dye2.reaplugin");
const beanNamed = async (name) => (await api("GET", "/beans")).response.body.find((bean) => bean.name === name);
const batchOf = async (bean) => (await api("GET", "/bean-batches")).response.body.find((candidate) => candidate.beanId === bean.id);
const grinderNamed = async (model) => (await api("GET", "/grinders")).response.body.find((grinder) => grinder.model === model);
const recipes = async () => (await api("GET", RECIPES)).response.body ?? [];
const put = async (body) => [await api("PUT", "/workflow", body)];
const record = () => api("POST", RECORD);

// ---- The library, and DYE2's keys as Decent Sync's server leaves them.

async function seedLibrary() {
  const ethiopia = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  await api("POST", `/beans/${ethiopia.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 });
  await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
}

/** Where each of a recipe's steam settings lives in a Workflow (RECIPE_SETTINGS in protocol/src/index.ts). */
const RECIPE_SETTINGS = { steamTempC: "steamSettings.targetTemperature", steamTimeS: "steamSettings.duration", steamFlowMls: "steamSettings.flow", steamStopAtTempC: "steamSettings.stopAtTemperature" };

/** The settings a recipe holds, as partial `steamSettings`, as `recipeWorkflow` embeds them. */
function settingsWorkflow(settings) {
  const parts = {};
  for (const [field, at] of Object.entries(RECIPE_SETTINGS)) {
    if (settings[field] === undefined) continue;
    const [part, key] = at.split(".");
    parts[part] = { ...parts[part], [key]: settings[field] };
  }
  return parts;
}

/**
 * A recipe record as Decent Sync's server writes one (`recipeRecord` and
 * `recipeWorkflow` in server/src/library/recipe-intake.ts, with #395): its
 * fields at the paths it writes, its feed rate in `dashboardVariables` and
 * its embedded Workflow's `context.extras` where it holds one, its steam
 * mode and settings where it holds them, a blank barista and drinker, shown
 * exactly while in a slot, explicit nulls for a Bean it names none of, a
 * profile in `jsonb`'s key order; with the record id and a made-up global
 * id, as the plugin's write gives it.
 */
function serverRecord({ id, name, bean = null, batch = null, slot, profile, brewC, dose, drink, grind, grinder, feedRate = null, steamMode, settings = {}, capturedAt }) {
  const context = {
    targetDoseWeight: dose,
    targetYield: drink,
    grinderSetting: String(grind),
    ...(feedRate !== null ? { extras: { feedRate } } : {}),
    grinderId: grinder.id,
    grinderModel: grinder.model,
    coffeeName: bean ? bean.name : null,
    coffeeRoaster: bean ? bean.roaster : null,
    beanBatchId: bean && batch ? batch.id : null,
  };
  return jsonbOrder({
    name,
    beverage: "",
    barista: "",
    drinker: "",
    ...(bean ? { beanId: bean.id, beanName: bean.name, beanRoaster: bean.roaster, beanBatchId: batch ? batch.id : null } : {}),
    profileId: profile.id,
    profileTitle: profile.profile.title,
    profileSnapshot: profile.profile,
    showOnStreamlineDashboard: slot !== null,
    stripSlot: slot,
    dashboardVariables: {
      dose,
      drink,
      brewC,
      ...(steamMode ? { steamMode } : {}),
      hotWaterMode: "vol",
      ...settings,
      grind,
      ...(feedRate !== null ? { feedRate } : {}),
      grinderId: grinder.id,
      grinderModel: grinder.model,
      equipmentIds: [],
      equipmentNames: [],
      equipmentCustom: {},
    },
    title: name,
    subtitle: bean ? bean.name : "",
    workflow: { context, profile: profileAtBrewC(profile.profile, brewC), ...settingsWorkflow(settings) },
    id,
    capturedAt,
    decentSyncId: randomUUID(),
  });
}

/** Recipe `3`'s steam settings, by time. */
const STEAM = { steamTempC: 150, steamTimeS: 30, steamFlowMls: 1.5, steamStopAtTempC: 60 };
const NAMES = { 1: "Fixture Feed Rate Espresso", 2: "Fixture No Feed Rate", 3: "Fixture Steam Recipe" };
/** The global id the plugin has written into the grinder's `extras`, made up. */
const GRINDER_GLOBAL_ID = randomUUID();
let seededRecipes;

/**
 * DYE2's keys and the Workflow as Decent Sync's server leaves them, written
 * from Node, the bundled DYE2 having run its own migrations on the empty
 * store already: recipes `1` (the Ethiopia and its batch, `Adaptive v3`,
 * slot 1, a feed rate of `MF`), `2` (no Bean, `Classic Italian espresso`,
 * slot 2, no feed rate) and `3` (no Bean, `Classic Italian espresso`, slot
 * 3, steam by time, STEAM); and the Workflow on the Ethiopia's batch.
 */
async function seedServerStore() {
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const batch = await batchOf(ethiopia);
  const grinder = await grinderNamed("Fixture Grinder 64");
  const adaptive = await profileTitled("Adaptive v3");
  const classic = await profileTitled("Classic Italian espresso");
  const one = serverRecord({ id: "1", name: NAMES[1], bean: ethiopia, batch, slot: 1, profile: adaptive, brewC: 92, dose: 18, drink: 36, grind: 2.5, grinder, feedRate: "MF", capturedAt: "2026-11-06T10:00:01.000Z" });
  const two = serverRecord({ id: "2", name: NAMES[2], slot: 2, profile: classic, brewC: 93, dose: 19, drink: 38, grind: 3, grinder, capturedAt: "2026-11-06T10:00:02.000Z" });
  const three = serverRecord({ id: "3", name: NAMES[3], slot: 3, profile: classic, brewC: 94, dose: 20, drink: 40, grind: 3.5, grinder, steamMode: "time", settings: STEAM, capturedAt: "2026-11-06T10:00:03.000Z" });
  seededRecipes = [one, two, three];
  return [
    await api("POST", RECIPES, seededRecipes),
    await api("PUT", "/workflow", { context: { beanBatchId: batch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } }),
  ];
}

/** The seeded records written again from the script, as Decent Sync's server writes a Recipe's record back over a Tablet's change. */
const reseed = async () => [await api("POST", RECIPES, seededRecipes)];

/** DYE2's keys and the Workflow, read at once. */
async function snapshot() {
  const listed = await api("GET", STORE);
  const keys = Array.isArray(listed.response.body) ? listed.response.body : [];
  const values = {};
  for (const key of keys) values[key] = (await api("GET", `${STORE}/${key}`)).response.body;
  return { keys: listed, values, workflow: await workflow() };
}

/**
 * DYE2 v0.1.35 installed from its `dist` deploy over the bundled DYE2, its
 * first load, on the keys seeded: the install's exchange, then DYE2's keys
 * and the Workflow read as it installs, over 6 s, and the Workflows plugins
 * were sent meanwhile.
 */
async function recordInstall() {
  const eventMark = recorder.heard.length;
  const started = Date.now();
  let answeredAtMs;
  const installing = api("POST", "/plugins/install/github-branch", { repo: "decentespresso/dye2", branch: DYE2_DIST }).then((exchange) => {
    answeredAtMs = Date.now() - started;
    return exchange;
  });
  const reads = [];
  for (const at of [0, 500, 1000, 1500, 2000, 3000, 6000]) {
    await wait(Math.max(0, started + at - Date.now()));
    reads.push({ atMs: Date.now() - started, ...(await snapshot()) });
  }
  const install = await installing;
  const events = recorder.heard.slice(eventMark);
  return {
    exchanges: [install],
    answeredAtMs,
    listed: await plugins(),
    reads,
    events: events.map(({ payload }) => payload.workflow?.context ?? null),
    timing: { events: events.map(({ at }) => at - started) },
  };
}

// ---- DYE2's pages.

/** Reads kept on DYE2's dashboard and editor: its selection, and the recipes it reads again before an apply. */
const dashboardReads = (route) => route === SELECTION || route === RECIPES;

/** DYE2's dashboard on a recorded page: opened afresh, a recipe's pill tapped, and Clear then Done. */
function dashboard(r) {
  const open = async () => {
    await r.page.goto(DYE2("dashboard"));
    await r.take(3000);
  };
  const pill = async (title) => {
    await r.page.locator(`#dye-recipe-pills .dye-recipe-pill[title="${title}"]`).first().click();
    return r.take(1500);
  };
  /** Opens the dashboard and taps a pill, giving the tap's exchanges. */
  const apply = async (title) => {
    await open();
    return pill(title);
  };
  /** Opens the dashboard, taps Clear and then Done, which sends the cleared Workflow. */
  const clearAndDone = async () => {
    await open();
    await r.page.locator("#dye-clear-btn").click();
    await r.page.waitForTimeout(500);
    await r.page.locator("#dye-done-btn").click();
    return r.take(2500);
  };
  const pills = () => r.page.locator("#dye-recipe-pills .dye-recipe-pill").evaluateAll((all) => all.map((pill) => ({ title: pill.getAttribute("title"), recent: pill.classList.contains("dye-pill-recent") })));
  return { open, pill, apply, clearAndDone, pills };
}

/** DYE2's recipe editor on a recorded page: a recipe opened, its feed rate typed, a stepper typed into or pressed, a mode chosen and Save. */
function recipeEditor(r) {
  const { page } = r;
  const open = async (id) => {
    await page.goto(DYE2(`recipe-edit?id=${encodeURIComponent(id)}`));
    await page.waitForTimeout(2500);
    return r.take();
  };
  /** What a field shows: from v0.1.34 each stepper's value is an input. */
  const shown = (id) => page.evaluate((field) => document.getElementById(field)?.value ?? null, id);
  const mode = (cls, value) => page.locator(`.${cls}[data-mode="${value}"]`).click();
  const feedRate = (value) => page.locator("#re-feedrate-input").fill(value);
  const stepper = async (prefix, value) => {
    const input = page.locator(`#${prefix}-value`);
    await input.click();
    await input.fill(String(value));
    await input.press("Enter");
  };
  const machineSettings = async () => {
    const toggle = page.locator("#re-machine-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  };
  const press = async (id, times) => {
    for (let pressed = 0; pressed < times; pressed += 1) await page.locator(`#${id}`).click();
  };
  const save = async () => {
    const button = page.locator("#re-save-btn");
    await button.click();
    await page.waitForTimeout(300);
    if (/^REPLACE/.test((await button.textContent().catch(() => "")) ?? "")) await button.click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(2500);
  };
  return { open, shown, mode, feedRate, stepper, machineSettings, press, save };
}

/**
 * 1. The feed rate (`b144426`, `1358750`), on DYE2's dashboard and editor:
 * `applyHolding`, recipe `1`'s pill (it holds `MF`); `recordUnmoved`;
 * `changedOnMachine`, the Workflow's feed rate written `SF` from the
 * script, as an Edit Shot copy or another app writes one; `recordChanged`;
 * `applyNone`, recipe `2`'s pill (it holds none); `changedOnNone`, `FF`
 * written; `recordOnNone`; `editorSet`, recipe `2` opened in DYE2's editor,
 * its feed rate typed `1200` and saved, as the Workflow names it;
 * `editorCleared`, its feed rate emptied and saved; `cleared`, the
 * dashboard's Clear, then Done.
 */
async function recordFeedRate(browser) {
  log("feed rate");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply, clearAndDone, pills } = dashboard(r);
  const editor = recipeEditor(r);
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow"] };
  steps.applyHolding = await step(() => apply(NAMES[1]), reads);
  steps.pills = await pills();
  steps.recordUnmoved = await step(async () => [await record()], reads);
  steps.changedOnMachine = await step(() => put({ context: { extras: { feedRate: "SF" } } }), reads);
  steps.recordChanged = await step(async () => [await record()], reads);
  steps.applyNone = await step(() => apply(NAMES[2]), reads);
  steps.changedOnNone = await step(() => put({ context: { extras: { feedRate: "FF" } } }), reads);
  steps.recordOnNone = await step(async () => [await record()], reads);
  let shownBefore;
  steps.editorSet = await step(async () => {
    const opened = await editor.open("2");
    shownBefore = await editor.shown("re-feedrate-input");
    await editor.feedRate("1200");
    return [...opened, ...(await editor.save())];
  }, reads);
  steps.editorSet.shownBefore = shownBefore;
  steps.editorCleared = await step(async () => {
    const opened = await editor.open("2");
    shownBefore = await editor.shown("re-feedrate-input");
    await editor.feedRate("");
    return [...opened, ...(await editor.save())];
  }, reads);
  steps.editorCleared.shownBefore = shownBefore;
  steps.cleared = await step(() => clearAndDone(), reads);
  await r.context.close();
  return steps;
}

/**
 * 2. A grinder's feed rate note (`1358750`), on DYE2's grinders page:
 * `globalIdWritten`, the grinder's `extras` written from the script as the
 * plugin writes its global id, beside a key of another app's;
 * `noteSet`, the grinder opened as the dashboard's long-press opens it
 * (`grinders?edit=<id>`), its Feed Rate typed and saved; `otherEdited`, its
 * notes alone changed; `noteCleared`, its Feed Rate emptied; `topLevel`, a
 * top-level `feedRate` written from the script, as the previous release's
 * plugin writes a Grinder's note; `inExtras`, the note written in `extras`
 * from the script, the other keys kept, as this release's plugin writes it;
 * `created`, a new grinder saved with a Feed Rate.
 */
async function recordGrinders(browser) {
  log("grinders");
  const r = await recordedPage(browser, { keepRead: (route) => route.startsWith("/grinders") });
  const { page } = r;
  const grinder = await grinderNamed("Fixture Grinder 64");
  const steps = {};
  const reads = { after: ["grinders"] };
  const path = `/grinders/${grinder.id}`;
  const current = async () => (await api("GET", path)).response.body;
  const submit = async (fields) => {
    for (const [name, value] of Object.entries(fields)) await page.locator(`#dye-grinder-form [name="${name}"]`).fill(value);
    await page.locator("#dye-modal-save").click();
    return r.take(2000);
  };
  const edit = async (fields) => {
    await page.goto(DYE2(`grinders?edit=${encodeURIComponent(grinder.id)}`));
    await page.locator("#dye-modal-backdrop.open").waitFor();
    const opened = await r.take(1000);
    return [...opened, ...(await submit(fields))];
  };
  steps.globalIdWritten = await step(async () => [await api("PUT", path, { extras: { bcUuid: "fixture-bc-uuid", decentSyncId: GRINDER_GLOBAL_ID } })], reads);
  steps.noteSet = await step(() => edit({ feedRate: "manual FF/MF/SF" }), reads);
  steps.otherEdited = await step(() => edit({ notes: "Fixture notes" }), reads);
  steps.noteCleared = await step(() => edit({ feedRate: "" }), reads);
  steps.topLevel = await step(async () => [await api("PUT", path, { feedRate: "SF only", extras: (await current()).extras ?? {} })], reads);
  steps.inExtras = await step(async () => [await api("PUT", path, { extras: { ...((await current()).extras ?? {}), feedRate: "SF only" } })], reads);
  steps.created = await step(async () => {
    await page.goto(DYE2("grinders"));
    await page.waitForTimeout(2000);
    const opened = await r.take();
    await page.locator(".dye-card-add").click();
    await page.locator("#dye-modal-backdrop.open").waitFor();
    return [...opened, ...(await submit({ model: "Fixture Feeder Grinder", feedRate: "feeder RPM 200-1200" }))];
  }, reads);
  await r.context.close();
  return steps;
}

/** Reads kept on DYE2's dashboard and Auto Favourites pages: its selection, recipes, favourites and the Workflow. */
const favouriteReads = (route) => route === SELECTION || route === RECIPES || route === FAVOURITES || route === "/workflow";

/**
 * 3. Auto Favourites (`fac6106`, `bf781f9`): `applied`, recipe `1`'s pill;
 * `saved`, DYE2's Auto Favourites edit page opened afresh, as its add card
 * opens it, which takes the Workflow as its snapshot, slot 1 picked on
 * "Assign Fav Number" and SAVE; `picked`, the dashboard opened, then the
 * Auto Favourites page, the favourite's card tapped and confirmed, which
 * goes back to the dashboard, which applies it.
 */
async function recordFavourites(browser) {
  log("favourites");
  const r = await recordedPage(browser, { keepRead: favouriteReads });
  const { page } = r;
  const { apply, open, pills } = dashboard(r);
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow", "favourites"] };
  steps.reseeded = await step(reseed, { after: ["recipes"] });
  steps.applied = await step(() => apply(NAMES[1]), reads);
  steps.saved = await step(async () => {
    await page.goto(DYE2("auto-fav-edit"));
    await page.waitForTimeout(3000);
    const opened = await r.take();
    await page.locator("#afe-title-input").fill("Fixture Saved Favourite");
    await page.locator('.afe-fav-num[data-num="1"]').click();
    await page.locator("#afe-save-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return [...opened, ...(await r.take(3000))];
  }, reads);
  steps.pillsAfterSave = await pills();
  steps.picked = await step(async () => {
    await open();
    await page.goto(DYE2("auto-favs"));
    await page.waitForTimeout(2500);
    const opened = await r.take();
    await page.locator(".dye-card:not(.dye-card-add)", { hasText: "Fixture Saved Favourite" }).first().click();
    await page.locator("#dye-confirm-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return [...opened, ...(await r.take(4000))];
  }, reads);
  await r.context.close();
  return steps;
}

/**
 * 4. Steam (`5561549`, `3e063e7`, `996981b`, decentespresso/dye2#46):
 * `applySteam`, recipe `3`'s pill; `steamOff`, `{targetTemperature: 0,
 * duration: 0}` written from the script, as Streamline's heater switch
 * turns steam off; `recordOff`; `changedWhileOff`, the steam flow and milk
 * stop written; `recordChangedOff`; `steamOn`, `{targetTemperature: 150,
 * duration: 30}` written, as Streamline turns it back on with the recipe's;
 * `editorTimeOff`, recipe `3` opened in DYE2's editor, steam by time, 0
 * typed and saved; `reseededOff`, the records written back; `steamOnAgain`;
 * `editorTimeLong`, 300 typed and saved; `reseededLong`; `editorTempOff`,
 * the Machine Settings section opened, the steam temperature stepped down
 * to Off and saved.
 */
async function recordSteam(browser) {
  log("steam");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply } = dashboard(r);
  const editor = recipeEditor(r);
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow"] };
  const form = {};
  steps.reseeded = await step(reseed, { after: ["recipes"] });
  steps.applySteam = await step(() => apply(NAMES[3]), reads);
  steps.steamOff = await step(() => put({ steamSettings: { targetTemperature: 0, duration: 0 } }), reads);
  steps.recordOff = await step(async () => [await record()], reads);
  steps.changedWhileOff = await step(() => put({ steamSettings: { flow: 2.2, stopAtTemperature: 55 } }), reads);
  steps.recordChangedOff = await step(async () => [await record()], reads);
  steps.steamOn = await step(() => put({ steamSettings: { targetTemperature: 150, duration: 30 } }), reads);
  steps.editorTimeOff = await step(async () => {
    const opened = await editor.open("3");
    await editor.mode("re-steam-mode", "time");
    form.timeOffBefore = await editor.shown("re-steam-value");
    await editor.stepper("re-steam", 0);
    form.timeOffTyped = await editor.shown("re-steam-value");
    return [...opened, ...(await editor.save())];
  }, reads);
  steps.reseededOff = await step(reseed, reads);
  steps.steamOnAgain = await step(() => put({ steamSettings: { targetTemperature: 150, duration: 30 } }), reads);
  steps.editorTimeLong = await step(async () => {
    const opened = await editor.open("3");
    await editor.mode("re-steam-mode", "time");
    await editor.stepper("re-steam", 300);
    form.timeLongTyped = await editor.shown("re-steam-value");
    await editor.press("re-steam-plus", 1);
    form.timeLongPlus = await editor.shown("re-steam-value");
    return [...opened, ...(await editor.save())];
  }, reads);
  steps.reseededLong = await step(reseed, reads);
  steps.editorTempOff = await step(async () => {
    const opened = await editor.open("3");
    await editor.machineSettings();
    form.tempOffBefore = await editor.shown("re-steam-temp-value");
    await editor.press("re-steam-temp-minus", 4);
    form.tempOffPressed = await editor.shown("re-steam-temp-value");
    form.tempOffSteamShown = await editor.shown("re-steam-value");
    return [...opened, ...(await editor.save())];
  }, reads);
  steps.form = form;
  await r.context.close();
  return steps;
}

const keys = async () => Object.fromEntries(await Promise.all(["recipes", "autoFavourites", "selection", ...MIGRATION_FLAGS].map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body])));

// ---- One run, on a Decaid whose data is new.

if (process.argv[3] === "--compact") {
  compactAll(out);
  process.exit(0);
}

log("installing the recorder");
const recorderSource = {
  manifest: JSON.parse(fs.readFileSync(path.join(RECORDER, "manifest.json"), "utf8")),
  plugin: fs.readFileSync(path.join(RECORDER, "plugin.js"), "utf8"),
};
const installed = await api("PUT", "/plugins/workflow-recorder.reaplugin/source", recorderSource);
if (installed.response.status >= 300) throw new Error(`The recorder was not installed: ${JSON.stringify(installed.response)}`);
await api("POST", "/plugins/workflow-recorder.reaplugin/enable");
await wait(1000);
recorder = listen("workflow-recorder.reaplugin", "workflow");
if ((await recorder.opened) !== 101) throw new Error("The recorder's socket did not open");
await openChanged();

await seedLibrary();
const library = {
  beans: (await api("GET", "/beans")).response.body,
  beanBatches: (await api("GET", "/bean-batches")).response.body,
  grinders: (await api("GET", "/grinders")).response.body,
  profiles: (await api("GET", "/profiles")).response.body.filter((record) => ["Adaptive v3", "Classic Italian espresso"].includes(record.profile.title)),
  machineSettings: (await api("GET", "/machine/settings")).response.body,
  bundledDye2: await plugins(),
  bundledFlags: Object.fromEntries(await Promise.all(MIGRATION_FLAGS.map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body]))),
};

log("seeding DYE2's keys as Decent Sync's server leaves them");
const seeded = { exchanges: await seedServerStore() };
await wait(1000);
Object.assign(seeded, await snapshot());
log("installing DYE2 v0.1.35");
changed.socket.close();
const install = await recordInstall();
if (!install.listed.some((plugin) => plugin.version === "0.1.35" && plugin.loaded)) throw new Error(`DYE2 v0.1.35 is not loaded: ${JSON.stringify(install.listed)}`);
await openChanged();
write("loading.json", { seeded, install });
write("plugins.json", { installed: install.exchanges[0], listed: await plugins() });

const browser = await chromium.launch();
try {
  write("feed-rate.json", await recordFeedRate(browser));
  write("grinders.json", await recordGrinders(browser));
  write("favourites.json", await recordFavourites(browser));
  write("steam.json", await recordSteam(browser));
  write("library.json", { ...library, grindersAtEnd: (await api("GET", "/grinders?includeArchived=true")).response.body, recipes: await recipes() });
  write("keys.json", await keys());
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
