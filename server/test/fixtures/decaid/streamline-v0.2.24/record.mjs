// Records what Streamline v0.2.24 and DYE2 v0.1.36 write to Decaid v0.9.1, as
// README.md describes: drives Streamline's and DYE2's pages in headless
// Chromium and sends requests from Node, as the plugin and Decent Sync's
// server would, keeping each exchange with Decaid's answer, the pushes heard
// on DYE2's `changed` socket and the Workflows Decaid sent plugins (heard
// through ../dye2-v0.1.26/workflow-recorder/). Run it once, from the
// repository root, against a Decaid whose data is new, still holding its
// bundled DYE2, with Streamline v0.2.24's files served at SKIN:
//
//   node server/test/fixtures/decaid/streamline-v0.2.24/record.mjs <output dir>
//
// It installs the recorder and DYE2 v0.1.36 (the `dist` deploy of the tag, by
// branch), then seeds DYE2's keys as Decent Sync's server leaves them. Its
// steam steps are those ../dye2-v0.1.33/record.mjs's helpers recorded of
// Streamline v0.2.23 for #394, made again on v0.2.24.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const SKIN = process.env.SKIN ?? "http://localhost:13999";
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
const STREAMLINE_STORE = "/store/streamline-app";
/** Streamline's remembered steam values (`STEAM_TEMP_LAST_VALUE_KEY` and its neighbours in streamline-js:src/modules/api.js). */
const STEAM_KEYS = ["last-steam-temp", "last-steam-duration", "last-steam-flow"];
/** DYE2's `dist` deploy of the v0.1.36 tag (`c5ae831`). */
const DYE2_DIST = "fbdde5a3b5829beaf6cddbb771dc8fb686203217";
/** Time for DYE2 and Streamline to follow a Workflow change, and a margin. */
const SETTLE_MS = 2500;
/** The routes whose reads a page sends that may be kept. Every request but a read is kept, whatever its route. */
const KEPT = [
  /^\/plugins\/dye2\.reaplugin\/(selection|record|save-recipe)$/,
  /^\/store\/dye2\.reaplugin\/(recipes|baskets|equipment|selection|autoFavourites)$/,
  /^\/store\/streamline-app\/[^/]+$/,
  /^\/workflow$/,
  /^\/machine\/settings(\/advanced)?$/,
];
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
 * a read of DYE2's `recipes` or of `/workflow` whose answer is the same as the
 * last one read or posted before it in that file keeps its status and
 * `unchanged: true` in place of its body; and outside `WHOLE_PROFILES`, each
 * whole profile is `{"$profile": "<title>/<hash>"}`, one copy of each kept in
 * `library.json`'s `profileCopies`.
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

/** A value with every object's keys in PostgreSQL's `jsonb` order, shorter keys first, then bytewise, as Decent Sync's server reads a record back. */
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

/**
 * A page whose kept requests are recorded, in the order sent: every request
 * but a read (and a CORS preflight), whatever its route, and of the reads,
 * only those of `KEPT`'s routes that `keepRead` accepts. Each is fetched by
 * Playwright and its answer handed to the page unchanged, so an answer is
 * recorded even when a page navigates away before reading it.
 */
async function recordedPage(browser, { viewport = { width: 1280, height: 800 }, keepRead = () => false, init } = {}) {
  const context = await browser.newContext({ viewport });
  if (init) await context.addInitScript(init.script, init.arg);
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
    if (request.method() === "GET" && !(KEPT.some((pattern) => pattern.test(routePath)) && keepRead(routePath))) return route.continue();
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

/** Streamline's remembered steam values in Decaid's store, read at once. */
async function steamKeys() {
  return Object.fromEntries(await Promise.all(STEAM_KEYS.map(async (key) => {
    const { response } = await api("GET", `${STREAMLINE_STORE}/${key}`);
    return [key, response.status === 200 ? response.body : { status: response.status, body: response.body }];
  })));
}

/** The pages open on Streamline, whose exchanges a step also takes and whose steam tile it reads after. */
const watching = new Set();

/**
 * A step: the exchanges `act` gives, then those each open Streamline page
 * sent meanwhile that `act` did not take (`alsoSent`, by page name), then, as `after`
 * asks, reads made once DYE2 and Streamline have followed (the Workflow,
 * DYE2's derived selection, its recipes, Streamline's remembered steam values
 * as `streamline`), what each open Streamline page's steam tile shows
 * (`tiles`), the pushes heard on `changed` meanwhile, the context of each
 * Workflow Decaid sent plugins (`events`), and when each push and event came,
 * in ms from the step's start (`timing`).
 */
async function step(act, { after = ["workflow", "selection", "recipes", "streamline"], settleMs = SETTLE_MS } = {}) {
  const mark = changed.heard.length;
  const eventMark = recorder.heard.length;
  const started = Date.now();
  const exchanges = await act();
  await wait(settleMs);
  const alsoSent = {};
  for (const page of watching) {
    const sent = await page.r.take(0);
    if (sent.length) alsoSent[page.name] = sent;
  }
  const reads = [];
  if (after.includes("workflow")) reads.push(await api("GET", "/workflow"));
  if (after.includes("selection")) reads.push(await api("GET", SELECTION));
  if (after.includes("recipes")) reads.push(await api("GET", RECIPES));
  const result = { exchanges };
  if (Object.keys(alsoSent).length) result.alsoSent = alsoSent;
  result.after = reads;
  if (after.includes("streamline")) result.streamline = await steamKeys();
  const tiles = {};
  for (const page of watching) tiles[page.name] = await page.tile();
  if (Object.keys(tiles).length) result.tiles = tiles;
  const pushes = changed.heard.slice(mark).filter(({ at }) => at >= started);
  const events = recorder.heard.slice(eventMark).filter(({ at }) => at >= started);
  result.pushes = pushes.map(({ payload }) => payload);
  result.events = events.map(({ payload }) => payload.workflow?.context ?? null);
  result.timing = { pushes: pushes.map(({ at }) => at - started), events: events.map(({ at }) => at - started) };
  return result;
}

const workflow = async () => (await api("GET", "/workflow")).response.body;
const profileTitled = async (title) => (await api("GET", "/profiles?includeHidden=true")).response.body.find((record) => record.profile.title === title);
const plugins = async () => (await api("GET", "/plugins")).response.body.filter((plugin) => plugin.id === "dye2.reaplugin");
const beanNamed = async (name) => (await api("GET", "/beans")).response.body.find((bean) => bean.name === name);
const batchOf = async (bean) => (await api("GET", "/bean-batches")).response.body.find((candidate) => candidate.beanId === bean.id);
const grinderNamed = async (model) => (await api("GET", "/grinders")).response.body.find((grinder) => grinder.model === model);
const recipes = async () => (await api("GET", RECIPES)).response.body ?? [];
const put = async (body) => [await api("PUT", "/workflow", body)];
const record = async () => [await api("POST", RECORD)];
/** Streamline's remembered values written from the script, as another device's Streamline writes them (`persistSharedValue`). */
const remember = async (values) => Promise.all(Object.entries(values).map(([key, value]) => (value === null ? api("DELETE", `${STREAMLINE_STORE}/${key}`) : api("POST", `${STREAMLINE_STORE}/${key}`, value))));

// ---- The library, and DYE2's keys as Decent Sync's server leaves them.

async function seedLibrary() {
  const ethiopia = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  await api("POST", `/beans/${ethiopia.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 });
  await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
  await api("POST", "/grinders", { model: "Fixture Grinder 83", burrs: "Fixture 83mm flat", settingType: "numeric", settingSmallStep: 0.1, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
}

/** DYE2's names of the settings a Recipe may hold, and where each sits in a Workflow (`RECIPE_SETTINGS` in protocol/src/index.ts). */
const RECIPE_SETTINGS = {
  steamTempC: "steamSettings.targetTemperature",
  steamTimeS: "steamSettings.duration",
  steamFlowMls: "steamSettings.flow",
  steamStopAtTempC: "steamSettings.stopAtTemperature",
  hotWaterTempC: "hotWaterData.targetTemperature",
  hotWaterTimeS: "hotWaterData.duration",
  hotWaterMl: "hotWaterData.volume",
  hotWaterFlowMls: "hotWaterData.flow",
  flushTempC: "rinseData.targetTemperature",
  flushS: "rinseData.duration",
  flushFlowMls: "rinseData.flow",
};

/** The Workflow parts holding the settings `settings` holds, as `recipeWorkflow` writes them into a record's embedded Workflow. */
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
 * A recipe record as Decent Sync's server writes one (`recipeRecord` in
 * server/src/library/recipe-intake.ts): its fields at the paths it writes,
 * its steam mode and the settings it holds in `dashboardVariables`, a blank
 * barista and drinker, shown exactly while in a slot, its embedded
 * `workflow` with the settings it holds (`recipeWorkflow`) and explicit nulls
 * for a Bean it names none of, a profile in `jsonb`'s key order; with the
 * record id and a made-up global id, as the plugin's write gives it.
 */
function serverRecord({ id, name, bean = null, batch = null, slot, profile, brewC, dose, drink, grind, grinder, steamMode, settings = {}, capturedAt }) {
  const context = {
    targetDoseWeight: dose,
    targetYield: drink,
    grinderSetting: String(grind),
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

/** Recipe `1`'s settings: every one a Recipe may hold. */
const RECIPE_ONE = { steamTempC: 150, steamTimeS: 40, steamFlowMls: 1.2, steamStopAtTempC: 65, hotWaterTempC: 85, hotWaterTimeS: 35, hotWaterMl: 200, hotWaterFlowMls: 6, flushTempC: 88, flushS: 5, flushFlowMls: 6 };
const NAMES = { 1: "Fixture Steam Recipe", 2: "Fixture Steam Temperature Only", 3: "Fixture No Steam" };
let seededRecipes;

/**
 * DYE2's keys and the Workflow as Decent Sync's server leaves them, written
 * from Node: recipes `1` (the Ethiopia and its batch, `Adaptive v3`, slot 1,
 * steam by time, every setting a Recipe may hold), `2` (no Bean, `Classic
 * Italian espresso`, slot 2, steam by time, only a steam temperature of 145)
 * and `3` (no Bean, `Classic Italian espresso`, slot 3, no steam mode and no
 * setting); and the Workflow on the Ethiopia's batch.
 */
async function seedServerStore() {
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const batch = await batchOf(ethiopia);
  const grinder = await grinderNamed("Fixture Grinder 64");
  const adaptive = await profileTitled("Adaptive v3");
  const classic = await profileTitled("Classic Italian espresso");
  const one = serverRecord({ id: "1", name: NAMES[1], bean: ethiopia, batch, slot: 1, profile: adaptive, brewC: 92, dose: 18, drink: 36, grind: 2.5, grinder, steamMode: "time", settings: RECIPE_ONE, capturedAt: "2026-11-05T10:00:01.000Z" });
  const two = serverRecord({ id: "2", name: NAMES[2], slot: 2, profile: classic, brewC: 93, dose: 19, drink: 38, grind: 3, grinder, steamMode: "time", settings: { steamTempC: 145 }, capturedAt: "2026-11-05T10:00:02.000Z" });
  const three = serverRecord({ id: "3", name: NAMES[3], slot: 3, profile: classic, brewC: 94, dose: 20, drink: 40, grind: 3.5, grinder, capturedAt: "2026-11-05T10:00:03.000Z" });
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

// ---- Streamline's and DYE2's pages.

/** Reads kept from Streamline: DYE2's selection, its recipes, the Workflow and Streamline's remembered values, which its steam switch reads. */
const streamlineReads = (route) => route === SELECTION || route === RECIPES || route === "/workflow" || route.startsWith(`${STREAMLINE_STORE}/`);

/**
 * Streamline v0.2.24's main page in its own browser context, its DYE2 switch
 * (`streamline.dye2Enabled`) set as `dye2Enabled` says before it loads, on
 * its DYE strip: opened, a strip button tapped, the steam heater switched
 * through the page's own module, its steam tile read and its + tapped, and
 * its settings page opened at a category, a toggle switched and Saved.
 *
 * Streamline mirrors its DYE2 switch into Decaid's store
 * (`streamlineSettings`, src/modules/settingsSync.js) and takes the store's
 * value over the page's own as it loads, so `open` writes the store's too, as
 * the switch on Streamline's settings page leaves both.
 */
async function streamlinePage(browser, name, { dye2Enabled }) {
  const r = await recordedPage(browser, {
    viewport: { width: 1920, height: 1200 },
    keepRead: streamlineReads,
    init: {
      script: (on) => {
        localStorage.setItem("streamline.dye2Enabled", on);
        localStorage.setItem("streamline.dyeStripMode", "R");
        localStorage.setItem("streamlineHelpHidden", "1");
      },
      arg: String(dye2Enabled),
    },
  });
  const { page } = r;
  const self = { name, r, page };
  const cell = (title) => page.locator("#dye-strip button", { hasText: title }).first();
  /** Loads the main page afresh, its DYE2 switch first written into Streamline's mirror of it in Decaid's store. */
  self.open = async () => {
    const mirrored = await api("POST", "/store/streamlineSettings/streamline.dye2Enabled", String(dye2Enabled));
    await page.goto(`${SKIN}/`);
    // With the DYE2 switch off, Streamline shows no DYE strip.
    const shown = dye2Enabled ? page.locator("#dye-strip button", { hasText: NAMES[1] }).first() : page.locator("#steam-duration-value");
    await shown.waitFor({ timeout: 20_000 });
    return [mirrored, ...(await r.take(6000))];
  };
  self.cells = () => page.locator("#dye-strip button").evaluateAll((all) => all.map((button) => button.textContent.trim()));
  self.strip = async (title) => {
    await cell(title).click({ timeout: 20_000 });
    return r.take(3000);
  };
  /**
   * The steam heater switched through `setSteamHeaterEnabled` in
   * streamline-js:src/modules/api.js, the one writer of the switch behind the
   * main page's steam tile (`switchSteamHeater` in src/modules/ui.js: − at the
   * shortest time, + from Off) and the descaling page.
   */
  self.heater = async (on) => {
    await page.evaluate(async (enabled) => {
      await (await import("/src/modules/api.js")).setSteamHeaterEnabled(enabled);
    }, on);
    return r.take(1500);
  };
  /** What the main page's steam tile shows: its time (or "Off"), its flow and its mode's buttons. */
  self.tile = () =>
    page.evaluate(() => {
      const text = (id) => document.getElementById(id)?.textContent.trim() ?? null;
      const visible = (id) => {
        const element = document.getElementById(id);
        return element ? element.offsetParent !== null : null;
      };
      return {
        duration: text("steam-duration-value"),
        flow: text("steam-flow-value"),
        modeTime: document.getElementById("steam-mode-time")?.className ?? null,
        modeFlow: document.getElementById("steam-mode-flow")?.className ?? null,
        mainPageShown: visible("steam-duration-value"),
      };
    });
  self.tap = async (id) => {
    await page.locator(`#${id}`).click();
    return r.take(2500);
  };
  /** Streamline's settings page opened from the main page's settings button, at `main` › `category` (as the shell restores its saved location). */
  self.settings = async (main, category) => {
    await page.evaluate(([m, c]) => localStorage.setItem("streamline.settings.location", JSON.stringify({ mainCategory: m, category: c })), [main, category]);
    await page.locator("#settings-btn").click();
    await page.waitForTimeout(4000);
    return r.take();
  };
  /** Streamline's settings page loaded afresh at `main` › `category`, by its address. */
  self.settingsFresh = async (main, category) => {
    await page.evaluate(([m, c]) => localStorage.setItem("streamline.settings.location", JSON.stringify({ mainCategory: m, category: c })), [main, category]);
    await page.goto(`${SKIN}/?page=settings`);
    await page.waitForTimeout(8000);
    return r.take();
  };
  /** The Settings › Steam heater toggle's state, or null where it is not shown. */
  self.heaterToggle = () => page.evaluate(() => document.getElementById("steamHeaterToggle")?.checked ?? null);
  self.toggleHeater = async () => {
    await page.locator("label:has(#steamHeaterToggle)").click();
    return r.take(1500);
  };
  self.save = async () => {
    await page.locator("#save-settings-btn").click();
    return r.take(4000);
  };
  /**
   * A profile switched to from the profile selector: opened from the main
   * page's Browse Profiles button, the profile titled `title` picked in its
   * list, and Confirm, which returns to the main page.
   */
  self.selectProfile = async (title) => {
    await page.locator("#profile-select-btn").click();
    const item = page.locator("#profile-list [data-profile-key]").filter({ hasText: title }).first();
    await item.waitFor({ timeout: 20_000 });
    await item.click();
    await page.waitForTimeout(500);
    await page.locator("#confirm-profile-btn").click();
    await page.locator("#steam-duration-value").waitFor({ timeout: 20_000 });
    return r.take(3000);
  };
  /** Streamline's "load a profile when the machine wakes" setting, in the page's own storage, as its settings page leaves it. */
  self.wakeProfile = (id) =>
    page.evaluate((profileId) => {
      localStorage.setItem("wakeProfileEnabled", profileId ? "true" : "false");
      if (profileId) localStorage.setItem("wakeProfileId", profileId);
      else localStorage.removeItem("wakeProfileId");
    }, id);
  /** The page's address, or the one given, without its origin. */
  self.where = (href = page.url()) => {
    const url = new URL(href);
    return url.href.startsWith(SKIN) ? url.pathname + url.search : url.href.replace(DECAID, "");
  };
  /** Does `act`, and gives each address the page went to meanwhile, in order. */
  self.navigating = async (act) => {
    const navigated = [];
    const heard = (frame) => {
      if (frame === page.mainFrame()) navigated.push(self.where(frame.url()));
    };
    page.on("framenavigated", heard);
    try {
      await act();
    } finally {
      page.off("framenavigated", heard);
    }
    return navigated;
  };
  /** Back to Streamline's main page, loaded afresh. */
  self.home = async () => {
    await page.goto(`${SKIN}/`);
    await page.locator("#steam-duration-value").waitFor({ timeout: 20_000 });
    return r.take(6000);
  };
  self.close = async () => {
    watching.delete(self);
    await r.context.close();
  };
  watching.add(self);
  return self;
}

/** The cards of a DYE2 grinder grid (its Grinders page, its grinder picker): each grinder's name, and whether it is the highlighted one. */
const grinderCards = (page) =>
  page.locator("#dye-cards-grid .dye-card").evaluateAll((cards) =>
    cards.filter((card) => !card.classList.contains("dye-card-add")).map((card) => ({ name: card.querySelector(".dye-card-name")?.textContent.trim() ?? card.textContent.trim(), selected: card.classList.contains("dye-card-selected") })),
  );
const grinderCard = (page, model) => page.locator("#dye-cards-grid .dye-card").filter({ hasText: model }).first();

/** DYE2 v0.1.36's Grinders page on a recorded page of its own: opened, a grinder's card tapped, and one held. */
function grindersPage(r) {
  const { page } = r;
  const modalOpen = () => page.evaluate(() => document.getElementById("dye-modal-backdrop")?.classList.contains("open") ?? null);
  return {
    open: async () => {
      await page.goto(DYE2("grinders"));
      await page.locator("#dye-cards-grid .dye-card").first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      return r.take();
    },
    cards: () => grinderCards(page),
    modalOpen,
    tap: async (model) => {
      await grinderCard(page, model).click();
      return r.take(1500);
    },
    /** A card held for 800 ms, past the page's 500 ms long press. */
    hold: async (model) => {
      await grinderCard(page, model).click({ delay: 800 });
      return r.take(1500);
    },
    cancelModal: async () => {
      await page.locator("#dye-modal-cancel").click();
      return r.take(500);
    },
  };
}

/** Reads kept on DYE2's Grinders page and its grinder picker: its selection, its recipes and the Workflow, which the page reads for its highlight. */
const grinderReads = (route) => route === SELECTION || route === RECIPES || route === "/workflow";

// ---- The recordings.

/** The settings recipe `1` holds written into the Workflow from the script, as the plugin's load write writes a Loaded Recipe's (steam on). */
const loadWriteOne = () => put(settingsWorkflow(RECIPE_ONE));

/** A recipe applied afresh from Streamline's strip: recipe `3` first, so that tapping the recipe's button is an apply, not a tap on the highlighted one. */
async function applyAfresh(s, steps, number, prefix = "") {
  steps[`${prefix}applyRecipe3First`] = await step(() => s.strip(NAMES[3]));
  steps[`${prefix}applyRecipe${number}`] = await step(() => s.strip(NAMES[number]));
}

/** 1. The strip: recipes `1`, `2` and `3` applied from Streamline's DYE strip, its DYE2 switch on. */
async function recordStrip(browser) {
  log("strip");
  const s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  const steps = {};
  steps.started = await step(s.open);
  steps.cells = await s.cells();
  steps.applyRecipe1 = await step(() => s.strip(NAMES[1]));
  steps.applyRecipe2 = await step(() => s.strip(NAMES[2]));
  steps.applyRecipe3 = await step(() => s.strip(NAMES[3]));
  await s.close();
  return steps;
}

/**
 * 2 to 4. The steam heater switched off and on from Streamline's main page:
 * with its DYE2 switch on and recipe `1` applied, then again with remembered
 * values set otherwise from the script; with its DYE2 switch off, as it is
 * and with remembered values set otherwise; and with recipe `2` (no steam
 * time) applied, then with no remembered steam time.
 */
async function recordHeater(browser) {
  log("heater, DYE2 switch on");
  const steps = {};
  let s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  steps.reseeded = await step(reseed);
  steps.startedDye2On = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  steps.heaterOffDye2On = await step(() => s.heater(false));
  steps.heaterOnDye2On = await step(() => s.heater(true));
  steps.heaterOffAgainDye2On = await step(() => s.heater(false));
  steps.rememberedOtherwise = await step(() => remember({ "last-steam-temp": 140, "last-steam-duration": 25 }));
  steps.heaterOnRecipeWins = await step(() => s.heater(true));
  await s.close();

  log("heater, DYE2 switch off");
  s = await streamlinePage(browser, "dye2Off", { dye2Enabled: false });
  steps.startedDye2Off = await step(s.open);
  steps.heaterOffDye2Off = await step(() => s.heater(false));
  steps.heaterOnDye2Off = await step(() => s.heater(true));
  steps.heaterOffAgainDye2Off = await step(() => s.heater(false));
  steps.rememberedOtherwiseDye2Off = await step(() => remember({ "last-steam-temp": 140, "last-steam-duration": 25 }));
  steps.heaterOnRememberedDye2Off = await step(() => s.heater(true));
  await s.close();

  log("heater, recipe 2");
  s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  steps.startedRecipe2 = await step(s.open);
  steps.applyRecipe2 = await step(() => s.strip(NAMES[2]));
  steps.loadWriteRecipe2 = await step(() => put({ steamSettings: { targetTemperature: 145 } }));
  steps.heaterOffRecipe2 = await step(() => s.heater(false));
  steps.heaterOnRecipe2 = await step(() => s.heater(true));
  steps.heaterOffRecipe2Again = await step(() => s.heater(false));
  steps.rememberedDurationRemoved = await step(() => remember({ "last-steam-duration": null }));
  steps.heaterOnRecipe2NothingRemembered = await step(() => s.heater(true));
  await s.close();
  return steps;
}

/**
 * 6. The main page's steam tile while the heater is off, and its + from Off;
 * then a steam time of 0 written from the script while the heater is on, and
 * its + again; recipe `1` applied, Streamline's DYE2 switch on.
 */
async function recordTile(browser) {
  log("tile");
  const steps = {};
  const s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  steps.started = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  steps.heaterOff = await step(() => s.heater(false));
  steps.plusFromOff = await step(() => s.tap("steam-plus"));
  steps.steamTimeZeroHeaterOn = await step(() => put({ steamSettings: { duration: 0 } }));
  steps.plusWithHeaterOn = await step(() => s.tap("steam-plus"));
  await s.close();
  return steps;
}

/**
 * 5. Settings › Calibration › Steam's heater toggle, staged until Save, with
 * recipe `1` applied and the Workflow's steam then set from the script to
 * 155 °C and 35 s: off and Save, on and Save, off and Save again, then the
 * page loaded afresh while steam is off, on and Save.
 */
async function recordSettingsToggle(browser) {
  log("settings toggle");
  const steps = {};
  const s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  const shown = async (act) => {
    const exchanges = await act();
    return [...exchanges, { toggle: await s.heaterToggle() }];
  };
  steps.reseeded = await step(reseed);
  steps.started = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  steps.workflowSteamOtherwise = await step(() => put({ steamSettings: { targetTemperature: 155, duration: 35 } }));
  steps.opened = await step(() => shown(() => s.settings("calibration", "calib_steam")));
  steps.toggleOff = await step(() => shown(s.toggleHeater));
  steps.saveOff = await step(s.save);
  steps.openedAgain = await step(() => shown(() => s.settings("calibration", "calib_steam")));
  steps.toggleOn = await step(() => shown(s.toggleHeater));
  steps.saveOn = await step(s.save);
  steps.openedThird = await step(() => shown(() => s.settings("calibration", "calib_steam")));
  steps.toggleOffAgain = await step(() => shown(s.toggleHeater));
  steps.saveOffAgain = await step(s.save);
  steps.openedFresh = await step(() => shown(() => s.settingsFresh("calibration", "calib_steam")));
  steps.toggleOnFresh = await step(() => shown(s.toggleHeater));
  steps.saveOnFresh = await step(s.save);
  await s.close();
  return steps;
}

/**
 * 7. DYE2's `record`, as the plugin calls it after each change, around
 * steam: recipe `1` applied and loaded, `record`; steam switched off, then
 * `record`; steam back on with Streamline's DYE2 switch off, as it is, then
 * `record`; off again, on at remembered values set otherwise from the script,
 * then `record`; recipe `2` (no steam time) applied while steam is off, steam
 * back on, then `record`.
 */
async function recordRecord(browser) {
  log("record");
  const steps = {};
  let s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  steps.reseeded = await step(reseed);
  steps.startedDye2On = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  steps.recordLoaded = await step(record);
  steps.heaterOff = await step(() => s.heater(false));
  steps.recordOff = await step(record);
  await s.close();

  s = await streamlinePage(browser, "dye2Off", { dye2Enabled: false });
  steps.startedDye2Off = await step(s.open);
  steps.heaterOnDye2Off = await step(() => s.heater(true));
  steps.recordOnDye2Off = await step(record);
  steps.heaterOffDye2Off = await step(() => s.heater(false));
  steps.recordOffDye2Off = await step(record);
  steps.rememberedOtherwise = await step(() => remember({ "last-steam-temp": 140, "last-steam-duration": 25 }));
  steps.heaterOnRememberedDye2Off = await step(() => s.heater(true));
  steps.recordOnRememberedDye2Off = await step(record);
  await s.close();

  s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  steps.startedRecipe2 = await step(s.open);
  steps.heaterOffBeforeRecipe2 = await step(() => s.heater(false));
  steps.recordOffBeforeRecipe2 = await step(record);
  steps.applyRecipe2WhileOff = await step(() => s.strip(NAMES[2]));
  steps.heaterOnRecipe2 = await step(() => s.heater(true));
  steps.recordOnRecipe2 = await step(record);
  await s.close();
  return steps;
}

/**
 * 9. A Recipe edited while its Machine's steam is off: recipe `1` applied and
 * loaded, steam switched off from Streamline; recipe `1`'s record rewritten
 * from the script as Decent Sync's server writes an edit of it; the Workflow
 * written as the previous plugin release writes it (the new steam time and
 * flow, no temperature); then the steam time put back to 0, and the Workflow
 * written as the new plugin writes it (flow and milk stop only); then
 * Streamline loaded again.
 */
async function recordSteamOffEdit(browser) {
  log("steam-off edit");
  const steps = {};
  const s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  steps.reseeded = await step(reseed);
  steps.started = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  steps.heaterOff = await step(() => s.heater(false));
  const edited = { ...RECIPE_ONE, steamTempC: 155, steamTimeS: 45, steamFlowMls: 1.0 };
  steps.recordRewritten = await step(async () => {
    const list = await recipes();
    return [
      await api(
        "POST",
        RECIPES,
        list.map((recipe) =>
          recipe?.id === "1"
            ? jsonbOrder({
                ...recipe,
                dashboardVariables: { ...recipe.dashboardVariables, ...edited },
                workflow: { ...recipe.workflow, ...settingsWorkflow(edited) },
              })
            : recipe,
        ),
      ),
    ];
  });
  steps.previousPluginWrite = await step(() => put({ steamSettings: { duration: 45, flow: 1.0 } }));
  steps.steamTimeBackToZero = await step(() => put({ steamSettings: { duration: 0 } }));
  steps.newPluginWrite = await step(() => put({ steamSettings: { flow: 1.0, stopAtTemperature: 65 } }));
  steps.reloaded = await step(s.open);
  await s.close();
  return steps;
}

const machineState = (state) => api("PUT", `/machine/state/${state}`);

/**
 * 11. A profile switch after a dial-in, Streamline's DYE2 switch on: recipe
 * `1` applied and loaded; `Classic Italian espresso` confirmed in the profile
 * selector; the dose tile's + tapped, which Streamline saves for that
 * profile; `Adaptive v3` confirmed, which it holds no dose or grind setting
 * for; `Classic Italian espresso` again; then, with it set as the profile to
 * load when the machine wakes and recipe `1` applied again, the machine put
 * to sleep and woken from the script.
 */
async function recordProfileSwitch(browser) {
  log("profile switch");
  const steps = {};
  const s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  const classic = await profileTitled("Classic Italian espresso");
  steps.reseeded = await step(reseed);
  steps.started = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  steps.selectClassic = await step(() => s.selectProfile("Classic Italian espresso"));
  steps.dosePlus = await step(() => s.tap("dose-in-plus"));
  steps.selectAdaptive = await step(() => s.selectProfile("Adaptive v3"));
  steps.selectClassicAgain = await step(() => s.selectProfile("Classic Italian espresso"));
  steps.applyRecipe1Again = await step(() => s.strip(NAMES[1]));
  await s.wakeProfile(classic.id);
  steps.asleep = await step(async () => [await machineState("sleeping")], { settleMs: 5000 });
  steps.woken = await step(async () => [await machineState("idle"), ...(await s.r.take(8000))]);
  await s.wakeProfile(null);
  await s.close();
  return steps;
}

/**
 * 12. The Grind tile's label tapped: with Streamline's DYE2 switch on and
 * recipe `1` named in the Workflow; with no recipe named, after a profile
 * switch, `Fixture Grinder 83` then picked in DYE2's grinder picker and
 * Confirmed; and with Streamline's DYE2 switch off. Each of those steps holds
 * `{"navigated": [...]}` among its exchanges, each address the page went to,
 * in order, without its origin.
 */
async function recordGrindLabel(browser) {
  log("grind label");
  const steps = {};
  let s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  const label = async () => {
    const navigated = await s.navigating(async () => {
      await s.page.locator("#grind-label").click();
      await s.page.waitForTimeout(4000);
    });
    return [...(await s.r.take()), { navigated }];
  };
  steps.reseeded = await step(reseed);
  steps.started = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  steps.labelWithRecipe = await step(label);
  steps.backWithoutSaving = await step(s.home);
  steps.selectClassic = await step(() => s.selectProfile("Classic Italian espresso"));
  steps.labelWithNoRecipe = await step(async () => [...(await label()), { cards: await grinderCards(s.page) }]);
  steps.pickerConfirm = await step(async () => {
    const navigated = await s.navigating(async () => {
      await grinderCard(s.page, "Fixture Grinder 83").click();
      await s.page.waitForTimeout(500);
      await s.page.locator("#dye-confirm-btn").click();
      await s.page.waitForTimeout(6000);
    });
    return [...(await s.r.take()), { navigated }];
  });
  await s.close();

  s = await streamlinePage(browser, "dye2Off", { dye2Enabled: false });
  steps.startedDye2Off = await step(s.open);
  steps.labelDye2Off = await step(async () => [
    ...(await label()),
    { settingsLocation: await s.page.evaluate(() => JSON.parse(localStorage.getItem("streamline.settings.location") ?? "null")), mainPageShown: (await s.tile()).mainPageShown },
  ]);
  await s.close();
  return steps;
}

/**
 * 13. DYE2 v0.1.36's Grinders page, on a page of its own while Streamline's
 * main page stays open, its DYE2 switch on. With recipe `1` named in the
 * Workflow: the page opened; `Fixture Grinder 83`'s card tapped; DYE2's
 * `record` after; `Fixture Grinder 64`'s card held, and its editor closed;
 * `Fixture Grinder 64`'s card tapped; `record` again. Then with no recipe
 * named, after a profile switch in Streamline: the page opened afresh, and
 * `Fixture Grinder 83`'s card tapped. The steps on DYE2's page hold
 * `{"cards": [...]}`, each card's name and whether it is highlighted, and the
 * hold `{"editorOpen": <whether the grinder's editor was open>}`.
 */
async function recordGrindersPage(browser) {
  log("grinders page");
  const steps = {};
  const s = await streamlinePage(browser, "dye2On", { dye2Enabled: true });
  steps.reseeded = await step(reseed);
  steps.started = await step(s.open);
  await applyAfresh(s, steps, 1);
  steps.loadWrite = await step(loadWriteOne);
  const g = await recordedPage(browser, { keepRead: grinderReads });
  const grinders = grindersPage(g);
  const shown = async (act) => [...(await act()), { cards: await grinders.cards() }];
  steps.opened = await step(() => shown(grinders.open));
  steps.tapOther = await step(() => shown(() => grinders.tap("Fixture Grinder 83")));
  steps.recordAfterTap = await step(record);
  steps.holdCard = await step(async () => {
    const held = await grinders.hold("Fixture Grinder 64");
    const editorOpen = await grinders.modalOpen();
    return [...held, ...(await grinders.cancelModal()), { editorOpen }, { cards: await grinders.cards() }];
  });
  steps.tapBack = await step(() => shown(() => grinders.tap("Fixture Grinder 64")));
  steps.recordAfterTapBack = await step(record);
  steps.selectClassic = await step(() => s.selectProfile("Classic Italian espresso"));
  steps.openedNoRecipe = await step(() => shown(grinders.open));
  steps.tapOtherNoRecipe = await step(() => shown(() => grinders.tap("Fixture Grinder 83")));
  steps.recordNoRecipe = await step(record);
  await g.context.close();
  await s.close();
  return steps;
}

/**
 * 10. The fan threshold and refill kit kept: both saved on Streamline's
 * settings page (Calibration › Fan, › Refill Kit), so its restore record
 * tracks them; then changed from the script through the routes Decent Sync's
 * Settings Edits use (`POST /machine/settings`, `POST
 * /machine/settings/advanced`) to 50 and Auto-Detect; then the settings page
 * loaded afresh and left open, every write it sent kept.
 */
async function recordSettingsKept(browser) {
  log("settings kept");
  const steps = {};
  const s = await streamlinePage(browser, "settings", { dye2Enabled: true });
  const machine = async () => [await api("GET", "/machine/settings"), await api("GET", "/machine/settings/advanced")];
  const restoreRecord = () =>
    s.page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open("shot_history");
          request.onerror = () => resolve({ error: String(request.error) });
          request.onsuccess = () => {
            const db = request.result;
            if (!Array.from(db.objectStoreNames).includes("settings")) return resolve({ stores: Array.from(db.objectStoreNames) });
            const get = db.transaction("settings").objectStore("settings").get("userMachineSettings");
            get.onsuccess = () => resolve(get.result ?? null);
            get.onerror = () => resolve({ error: String(get.error) });
          };
        }),
    );
  steps.started = await step(s.open);
  steps.machineBefore = await machine();
  steps.fanSaved = await step(async () => {
    const opened = await s.settings("calibration", "calib_fan");
    const input = s.page.locator("#calibFanInput");
    await input.fill("45");
    await input.dispatchEvent("change");
    await s.page.waitForTimeout(500);
    return [...opened, ...(await s.save())];
  });
  steps.refillKitSaved = await step(async () => {
    const opened = await s.settings("calibration", "calib_refillkit");
    await s.page.locator("button", { hasText: "Force Off" }).first().click();
    await s.page.waitForTimeout(500);
    return [...opened, ...(await s.save())];
  });
  steps.machineSaved = await machine();
  steps.restoreRecord = await restoreRecord();
  steps.editedElsewhere = await step(async () => [await api("POST", "/machine/settings", { fan: 50 }), await api("POST", "/machine/settings/advanced", { refillKitSetting: 2 })]);
  steps.settingsOpened = await step(async () => {
    const opened = await s.settingsFresh("calibration", "calib_fan");
    await s.page.waitForTimeout(6000);
    return [...opened, ...(await s.r.take())];
  });
  steps.machineAfter = await machine();
  steps.restoreRecordAfter = await restoreRecord();
  await s.close();
  return steps;
}

const keys = async () => Object.fromEntries(await Promise.all(["recipes", "selection"].map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body])));

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

log("installing DYE2 v0.1.36's dist deploy");
const bundledDye2 = await plugins();
const install = await api("POST", "/plugins/install/github-branch", { repo: "decentespresso/dye2", branch: DYE2_DIST });
await wait(4000);
const listed = await plugins();
if (!listed.some((plugin) => plugin.version === "0.1.36" && plugin.loaded)) throw new Error(`DYE2 v0.1.36 is not loaded: ${JSON.stringify(listed)}`);
await openChanged();

await seedLibrary();
const library = {
  beans: (await api("GET", "/beans")).response.body,
  beanBatches: (await api("GET", "/bean-batches")).response.body,
  grinders: (await api("GET", "/grinders")).response.body,
  profiles: (await api("GET", "/profiles")).response.body.filter((record) => ["Adaptive v3", "Classic Italian espresso"].includes(record.profile.title)),
  machineSettings: (await api("GET", "/machine/settings")).response.body,
  advancedSettings: (await api("GET", "/machine/settings/advanced")).response.body,
  info: (await api("GET", "/info")).response.body,
};

log("seeding DYE2's keys as Decent Sync's server leaves them");
const seeded = { exchanges: await seedServerStore() };
await wait(1000);
Object.assign(seeded, await snapshot(), { streamline: await steamKeys() });
write("loading.json", { bundledDye2, install, listed, seeded });

const browser = await chromium.launch();
try {
  write("strip.json", await recordStrip(browser));
  write("heater.json", await recordHeater(browser));
  write("tile.json", await recordTile(browser));
  write("settings.json", await recordSettingsToggle(browser));
  write("record.json", await recordRecord(browser));
  write("steam-off-edit.json", await recordSteamOffEdit(browser));
  write("settings-kept.json", await recordSettingsKept(browser));
  write("profile-switch.json", await recordProfileSwitch(browser));
  write("grind-label.json", await recordGrindLabel(browser));
  write("grinders-page.json", await recordGrindersPage(browser));
  write("library.json", { ...library, recipes: await recipes() });
  write("keys.json", await keys());
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
