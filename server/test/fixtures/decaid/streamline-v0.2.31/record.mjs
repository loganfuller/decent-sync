// Records what Streamline v0.2.31 and DYE2 v0.1.42 write to Decaid v0.9.2
// around steam, as README.md describes: drives Streamline's and DYE2's pages
// in headless Chromium and sends requests from Node, as Decent Sync's plugin
// and server would, keeping each exchange with Decaid's answer, the pushes
// heard on DYE2's `changed` socket and the Workflows Decaid sent plugins
// (heard through ../dye2-v0.1.26/workflow-recorder/). Run it once, from the
// repository root, against a Decaid started with a token whose data is new,
// still holding its bundled DYE2, with Streamline v0.2.31's files served at
// SKIN:
//
//   DECAID_EXTENSIONS_TOKEN=<token> node server/test/fixtures/decaid/streamline-v0.2.31/record.mjs <output dir>
//
// It reads DECAID and SKIN from the environment for other addresses, and
// DECAID_EXTENSIONS_TOKEN for the token Decaid was started with, which it
// sends with the requests that install a plugin and never writes to a file:
// a request that carried it holds `"token": "launch"`. It installs the
// recorder and DYE2's latest release, which must be v0.1.42, makes the
// library, and writes DYE2's recipes as Decent Sync's server writes them for
// #616. Its pages reach no address but Decaid's and SKIN's.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const SKIN = process.env.SKIN ?? "http://localhost:13999";
const TOKEN = process.env.DECAID_EXTENSIONS_TOKEN;
const SOCKETS = DECAID.replace(/^http/, "ws");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDER = path.join(HERE, "..", "dye2-v0.1.26", "workflow-recorder");
const DYE2 = (page) => `${DECAID}/api/v1/plugins/dye2.reaplugin/${page}`;
const SELECTION = "/plugins/dye2.reaplugin/selection";
const RECORD = "/plugins/dye2.reaplugin/record";
const STORE = "/store/dye2.reaplugin";
const RECIPES = `${STORE}/recipes`;
const STREAMLINE_STORE = "/store/streamline-app";
/** Streamline's remembered steam values (`STEAM_TEMP_LAST_VALUE_KEY` and its neighbours in streamline-js:src/modules/api.js). */
const STEAM_KEYS = ["last-steam-temp", "last-steam-duration", "last-steam-flow"];
const DYE2_VERSION = "0.1.42";
/** Time for DYE2 and Streamline to follow a Workflow change, and a margin. */
const SETTLE_MS = 2500;
/** The routes whose reads a page sends that may be kept. Every request but a read is kept, whatever its route. */
const KEPT = [
  /^\/plugins\/dye2\.reaplugin\/(selection|record|save-recipe)$/,
  /^\/store\/dye2\.reaplugin\/(recipes|selection)$/,
  /^\/store\/streamline-app\/[^/]+$/,
  /^\/workflow$/,
];
/** The addresses a page may reach: Decaid's and Streamline's own. Anything else is aborted. */
const LOCAL = /^(https?|wss?):\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;
const log = (message) => console.log(new Date().toISOString(), message);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const out = process.argv[2];
if (!out) throw new Error("Usage: DECAID_EXTENSIONS_TOKEN=<token> record.mjs <output dir> [--compact]");
fs.mkdirSync(out, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + "\n");

/** Files whose profiles stay whole. */
const WHOLE_PROFILES = new Set(["library.json"]);
const isProfile = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.title === "string" && Array.isArray(value.steps) && "tank_temperature" in value;

/**
 * The recordings made smaller, once every file is written, as
 * ../dye2-v0.1.40/record.mjs makes its own: in each file, in document order,
 * a read of DYE2's `recipes` or of `/workflow` whose answer is the same as
 * the last one read or posted before it in that file keeps its status and
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

if (process.argv[3] === "--compact") {
  compactAll(out);
  process.exit(0);
}
if (!TOKEN) throw new Error("DECAID_EXTENSIONS_TOKEN is not set");

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

/**
 * A page whose kept requests are recorded, in the order sent: every request
 * but a read (and a CORS preflight), whatever its route, and of the reads,
 * only those of `KEPT`'s routes that `keepRead` accepts. Each is fetched by
 * Playwright and its answer handed to the page unchanged, so an answer is
 * recorded even when a page navigates away before reading it. A request to
 * any address but Decaid's and Streamline's is aborted.
 */
async function recordedPage(browser, { viewport = { width: 1280, height: 800 }, keepRead = () => false, init } = {}) {
  const context = await browser.newContext({ viewport });
  if (init) await context.addInitScript(init.script, init.arg);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  const recorded = [];
  await context.route((url) => !LOCAL.test(url.href), (route) => route.abort());
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
  return Object.fromEntries(
    await Promise.all(
      STEAM_KEYS.map(async (key) => {
        const { response } = await api("GET", `${STREAMLINE_STORE}/${key}`);
        return [key, response.status === 200 ? response.body : { status: response.status, body: response.body }];
      }),
    ),
  );
}

/** The pages open on Streamline, whose exchanges a step also takes and whose steam tile it reads after. */
const watching = new Set();

/**
 * A step: Streamline's remembered steam values read before the action
 * (`streamlineBefore`), the exchanges `act` gives, then those each open
 * Streamline page sent meanwhile that `act` did not take (`alsoSent`, by page
 * name), then, as `after` asks, reads made once DYE2 and Streamline have
 * followed (the Workflow, DYE2's derived selection, its recipes, Streamline's
 * remembered steam values as `streamline`), what each open Streamline page's
 * steam tile shows (`tiles`), the pushes heard on `changed` meanwhile, the
 * context and steam settings of each Workflow Decaid sent plugins (`events`),
 * and when each push and event came, in ms from the step's start (`timing`).
 */
async function step(act, { after = ["workflow", "selection", "recipes", "streamline"], settleMs = SETTLE_MS } = {}) {
  const streamlineBefore = after.includes("streamline") ? await steamKeys() : undefined;
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
  const result = {};
  if (streamlineBefore) result.streamlineBefore = streamlineBefore;
  result.exchanges = exchanges;
  if (Object.keys(alsoSent).length) result.alsoSent = alsoSent;
  result.after = reads;
  if (after.includes("streamline")) result.streamline = await steamKeys();
  const tiles = {};
  for (const page of watching) tiles[page.name] = await page.tile();
  if (Object.keys(tiles).length) result.tiles = tiles;
  const pushes = changed.heard.slice(mark).filter(({ at }) => at >= started);
  const events = recorder.heard.slice(eventMark).filter(({ at }) => at >= started);
  result.pushes = pushes.map(({ payload }) => payload);
  result.events = events.map(({ payload }) => (payload.workflow ? { context: payload.workflow.context ?? null, steamSettings: payload.workflow.steamSettings ?? null } : null));
  result.timing = { pushes: pushes.map(({ at }) => at - started), events: events.map(({ at }) => at - started) };
  return result;
}

const profileTitled = async (title) => (await api("GET", "/profiles?includeHidden=true")).response.body.find((record) => record.profile.title === title);
const plugins = async () => (await api("GET", "/plugins")).response.body.filter((plugin) => plugin.id === "dye2.reaplugin");
const recipes = async () => (await api("GET", RECIPES)).response.body ?? [];
const put = async (body) => [await api("PUT", "/workflow", body)];
/** DYE2's `record`, as Decent Sync's plugin calls it after each change. */
const record = async () => [await api("POST", RECORD)];
/** Steam switched off from the script, as Streamline's off and the plugin's load write of "Off" write it. */
const steamOff = () => put({ steamSettings: { targetTemperature: 0, duration: 0 } });
/** Streamline's remembered values written (or, for null, deleted) from the script, as another device's Streamline writes them (`persistSharedValue`). */
const remember = async (values) => Promise.all(Object.entries(values).map(([key, value]) => (value === null ? api("DELETE", `${STREAMLINE_STORE}/${key}`) : api("POST", `${STREAMLINE_STORE}/${key}`, value))));

// ---- The library, and DYE2's recipes as Decent Sync's server writes them for #616.

/** The library's records, once made. */
const made = {};

async function seedLibrary() {
  made.bean = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  made.batch = (await api("POST", `/beans/${made.bean.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 })).response.body;
  made.grinder = (await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 })).response.body;
  made.classic = await profileTitled("Classic Italian espresso");
}

/** DYE2's names of the settings a Recipe may hold, and where each sits in a Workflow (`RECIPE_MACHINE_FIELDS` in dye2:dye2-plugin/src/utils/dev-api.ts). */
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

/** The Workflow parts holding the settings `settings` holds, partial, as `recipeMachineSettings` builds them. */
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
 * A recipe record as Decent Sync's server writes one (`recipeRecord`,
 * `recipeWorkflow` and `recordOf` in server/src/library/recipe-intake.ts at
 * `origin/main`, with #616's steam rule): its fields only where the Recipe
 * holds one, its steam mode and each steam, hot water and flush setting it
 * holds in `dashboardVariables`; a blank barista and drinker; shown exactly
 * while in a slot; its embedded Workflow as DYE2's `buildRecipeWorkflow`
 * builds one, with explicit nulls for what it names none of, its profile at
 * its brew temperature, and partial `steamSettings` / `hotWaterData` /
 * `rinseData` of the settings it holds ("Off" being `{targetTemperature: 0,
 * duration: 0}`); in `jsonb`'s key order; with the record id and a made-up
 * global id, as the plugin's write gives it.
 */
function serverRecord({ id, name, bean = null, batch = null, slot, profile, brewC, dose, drink, grind, grinder, steamMode, settings = {}, capturedAt }) {
  const context = {
    targetDoseWeight: dose,
    grinderSetting: String(grind),
    extras: { rpm: null, feedRate: null, basketId: null, basketName: null },
    grinderId: grinder.id,
    grinderModel: grinder.model,
    targetYield: drink,
    coffeeName: bean ? bean.name : null,
    coffeeRoaster: bean ? bean.roaster : null,
    beanBatchId: bean && batch ? batch.id : null,
    baristaName: null,
    drinkerName: null,
  };
  return jsonbOrder({
    name,
    beverage: "",
    barista: "",
    drinker: "",
    ...(bean ? { beanId: bean.id, beanName: bean.name, beanRoaster: bean.roaster, ...(batch ? { beanBatchId: batch.id } : {}) } : {}),
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

/** Recipe `1`'s settings: every one a Recipe may hold, as ../streamline-v0.2.24/'s recipe `1`. */
const RECIPE_ONE = { steamTempC: 150, steamTimeS: 40, steamFlowMls: 1.2, steamStopAtTempC: 65, hotWaterTempC: 85, hotWaterTimeS: 35, hotWaterMl: 200, hotWaterFlowMls: 6, flushTempC: 88, flushS: 5, flushFlowMls: 6 };
/** "Off": a steam temperature and time of 0. */
const STEAM_OFF = { steamTempC: 0, steamTimeS: 0 };
const NAMES = { 1: "Fixture Steam Recipe", 2: "Fixture Steam Temperature Only", 3: "Fixture No Steam", 4: "Fixture Steam Off", 5: "Fixture Steam Time Only" };
let seededRecipes;

/** The recipes README.md lists, in strip buttons 1 to 5, each built once so its global id stays. */
function buildRecipes() {
  const { bean, batch, grinder, classic } = made;
  const at = (second) => `2026-11-22T10:00:0${second}.000Z`;
  const common = { profile: classic, brewC: 93, grinder };
  seededRecipes = [
    serverRecord({ id: "1", name: NAMES[1], bean, batch, slot: 1, ...common, dose: 18, drink: 36, grind: 2.5, steamMode: "time", settings: RECIPE_ONE, capturedAt: at(1) }),
    serverRecord({ id: "2", name: NAMES[2], slot: 2, ...common, dose: 19, drink: 38, grind: 3, steamMode: "time", settings: { steamTempC: 145 }, capturedAt: at(2) }),
    serverRecord({ id: "3", name: NAMES[3], slot: 3, ...common, dose: 20, drink: 40, grind: 3.5, capturedAt: at(3) }),
    serverRecord({ id: "4", name: NAMES[4], slot: 4, ...common, dose: 18, drink: 40, grind: 4, steamMode: "time", settings: STEAM_OFF, capturedAt: at(4) }),
    serverRecord({ id: "5", name: NAMES[5], slot: 5, ...common, dose: 19, drink: 42, grind: 4.5, steamMode: "time", settings: { steamTimeS: 35 }, capturedAt: at(5) }),
  ];
}

/** The seeded records written from the script, as Decent Sync's server writes them. */
const seed = async () => [await api("POST", RECIPES, seededRecipes)];

/** Recipe `1`'s record rewritten from the script to hold "Off", as Decent Sync's server writes an edit of the Recipe made elsewhere. */
async function rewriteRecipeOneOff() {
  const list = await recipes();
  return [
    await api(
      "POST",
      RECIPES,
      list.map((recipe) =>
        recipe?.id === "1"
          ? jsonbOrder({
              ...recipe,
              dashboardVariables: { ...recipe.dashboardVariables, ...STEAM_OFF },
              workflow: { ...recipe.workflow, steamSettings: { ...(recipe.workflow?.steamSettings ?? {}), targetTemperature: 0, duration: 0 } },
            })
          : recipe,
      ),
    ),
  ];
}

/** DYE2's keys and the Workflow, read at once. */
async function snapshot() {
  const listed = await api("GET", STORE);
  const keys = Array.isArray(listed.response.body) ? listed.response.body : [];
  const values = {};
  for (const key of keys) values[key] = (await api("GET", `${STORE}/${key}`)).response.body;
  return { keys: listed, values, workflow: (await api("GET", "/workflow")).response.body };
}

// ---- Streamline's and DYE2's pages.

/** Reads kept on DYE2's pages: its selection, its recipes and the Workflow. */
const dye2Reads = (route) => route === SELECTION || route === RECIPES || route === "/workflow";
/** Reads kept on Streamline: DYE2's selection, its recipes, the Workflow and Streamline's remembered values. */
const streamlineReads = (route) => route === SELECTION || route === RECIPES || route === "/workflow" || route.startsWith(`${STREAMLINE_STORE}/`);

/**
 * Streamline v0.2.31's main page in its own browser context, its DYE2 switch
 * (`streamline.dye2Enabled`) on, on its recipe strip: opened, a strip button
 * tapped, the steam heater switched through the page's own module, its steam
 * tile read, Auto Steam's session flag set, and its settings page opened.
 *
 * Streamline mirrors its DYE2 switch into Decaid's store
 * (`streamlineSettings`, src/modules/settingsSync.js) and takes the store's
 * value over the page's own as it loads, so `open` writes the store's too.
 */
async function streamlinePage(browser, name) {
  const r = await recordedPage(browser, {
    viewport: { width: 1920, height: 1200 },
    keepRead: streamlineReads,
    init: {
      script: () => {
        localStorage.setItem("streamline.dye2Enabled", "true");
        localStorage.setItem("streamline.dyeStripMode", "R");
        localStorage.setItem("streamlineHelpHidden", "1");
      },
    },
  });
  const { page } = r;
  const self = { name, r, page };
  const cell = (title) => page.locator("#dye-strip button", { hasText: title }).first();
  /** Loads the main page afresh, its DYE2 switch first written into Streamline's mirror of it in Decaid's store, and waits for recipe `1`'s strip button. */
  self.open = async () => {
    const mirrored = await api("POST", "/store/streamlineSettings/streamline.dye2Enabled", "true");
    await page.goto(`${SKIN}/`);
    await cell(NAMES[1]).waitFor({ timeout: 30_000 });
    return [mirrored, ...(await r.take(6000))];
  };
  self.cells = () => page.locator("#dye-strip button").evaluateAll((all) => all.map((button) => button.textContent.trim()));
  self.strip = async (number) => {
    await cell(NAMES[number]).click({ timeout: 20_000 });
    return r.take(3000);
  };
  /** The steam heater switched through `setSteamHeaterEnabled` in streamline-js:src/modules/api.js, as ../streamline-v0.2.24/ switches it. */
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
  /** Auto Steam's session flag (`streamline.autoSteamSession`, which `isAutoSteamActive` reads) set or removed, and what `isAutoSteamActive` then answers. */
  self.autoSteam = (active) =>
    page.evaluate(async (on) => {
      if (on) localStorage.setItem("streamline.autoSteamSession", JSON.stringify({ active: true }));
      else localStorage.removeItem("streamline.autoSteamSession");
      return { isAutoSteamActive: (await import("/src/modules/api.js")).isAutoSteamActive() };
    }, active);
  /**
   * Streamline's settings page opened from the main page's settings button at
   * `main` › `category` (as the shell restores its saved location), and what
   * it shows: its content area's visible text, line by line, each visible
   * element's text that names a translation key, and each input of the
   * content area with its value and bounds, and each button's label.
   */
  self.settingsShown = async (main, category) => {
    await page.evaluate(([m, c]) => localStorage.setItem("streamline.settings.location", JSON.stringify({ mainCategory: m, category: c })), [main, category]);
    await page.locator("#settings-btn").click();
    await page.locator("#settings-content-area").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(6000);
    const shown = await page.evaluate(() => {
      const visible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
      const area = document.getElementById("settings-content-area");
      const nav = Array.from(document.querySelectorAll("[data-i18n-key]"))
        .filter((element) => !area?.contains(element) && visible(element))
        .map((element) => element.textContent.trim().replace(/\s+/g, " "))
        .filter(Boolean);
      return {
        lines: (area?.innerText ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
        labels: Array.from(area?.querySelectorAll("[data-i18n-key]") ?? [])
          .filter(visible)
          .map((element) => ({ key: element.getAttribute("data-i18n-key"), text: element.textContent.trim().replace(/\s+/g, " "), ...(element.id ? { id: element.id } : {}) })),
        inputs: Array.from(area?.querySelectorAll("input") ?? [])
          .filter(visible)
          .map((input) => ({ id: input.id || null, setting: input.dataset.setting ?? null, type: input.type, value: input.value, step: input.getAttribute("step"), min: input.getAttribute("min"), max: input.getAttribute("max"), labelledBy: input.getAttribute("aria-labelledby") })),
        buttons: Array.from(area?.querySelectorAll("button") ?? [])
          .filter(visible)
          .map((button) => ({ label: button.getAttribute("aria-label") || button.textContent.trim().replace(/\s+/g, " "), ...(button.dataset.delta ? { delta: button.dataset.delta } : {}), ...(button.getAttribute("onclick") ? { onclick: button.getAttribute("onclick").trim() } : {}) }))
          .filter((button) => button.label),
        outsideContent: nav,
      };
    });
    return { location: { mainCategory: main, category }, exchanges: await r.take(), shown };
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

/** DYE2's dashboard on a recorded page: opened afresh, and a recipe's pill tapped, as ../dye2-v0.1.40/ taps them. */
function dashboard(r) {
  const { page } = r;
  const open = async () => {
    await page.goto(DYE2("dashboard"));
    await page.locator("#dye-recipe-pills .dye-recipe-pill").first().waitFor({ timeout: 20_000 });
    await r.take(3000);
  };
  /** Opens the dashboard and taps a recipe's pill, giving the tap's exchanges. */
  const apply = async (number) => {
    await open();
    await page.locator(`#dye-recipe-pills .dye-recipe-pill[title="${NAMES[number]}"]`).first().click();
    return r.take(2000);
  };
  const pills = () => page.locator("#dye-recipe-pills .dye-recipe-pill").evaluateAll((all) => all.map((pill) => ({ title: pill.getAttribute("title"), active: pill.classList.contains("active") })));
  return { open, apply, pills };
}

/**
 * DYE2's recipe editor on a recorded page: a recipe opened, its Machine
 * Settings section opened, what its steam rows show, the steam temperature's
 * Off preset tapped, a steam temperature and a steam time typed, and Save.
 */
function recipeEditor(r) {
  const { page } = r;
  const open = async (id) => {
    await page.goto(DYE2(`recipe-edit?id=${encodeURIComponent(id)}`));
    await page.locator("#re-save-btn").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2500);
    const toggle = page.locator("#re-machine-toggle");
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await page.waitForTimeout(300);
    return r.take();
  };
  /** What the steam, milk stop, flush and hot water steppers show, and the steam mode lit. */
  const shown = () =>
    page.evaluate(() => {
      const value = (id) => {
        const element = document.getElementById(id);
        return element ? (element.value ?? element.textContent).trim() : null;
      };
      return {
        steamMode: document.querySelector(".re-steam-mode.active")?.dataset.mode ?? null,
        steam: value("re-steam-value"),
        steamTemp: value("re-steam-temp-value"),
        milkStop: value("re-milk-stop-value"),
        hotWater: value("re-hotwater-value"),
        hotWaterTime: value("re-hw-time-value"),
        hotWaterFlow: value("re-hw-flow-value"),
        flush: value("re-flush-value"),
        flushTemp: value("re-flush-temp-value"),
        flushFlow: value("re-flush-flow-value"),
      };
    });
  /**
   * The steam temperature's Off preset tapped, and what the steppers then
   * show; then, as the preset leaves the number as it was (`applyPreset` in
   * dye2:dye2-plugin/src/utils/shared-components.ts sets the `textContent`
   * of what is now an `<input>`), its − tapped until it shows Off.
   */
  const steamTempOff = async () => {
    await page.locator('#re-steam-temp-presets .dye-preset[data-preset="Off"]').click();
    await page.waitForTimeout(300);
    const shownAfterPreset = await shown();
    let minusTaps = 0;
    while (minusTaps < 12 && (await page.locator("#re-steam-temp-value").inputValue()).trim() !== "Off") {
      await page.locator("#re-steam-temp-minus").click();
      minusTaps += 1;
      await page.waitForTimeout(150);
    }
    return [{ shownAfterPreset }, { minusTaps }];
  };
  /** A value typed into a stepper's number, as a tap on it opens it for typing, and Enter. */
  const type = async (id, value) => {
    const input = page.locator(`#${id}`);
    await input.click();
    await input.fill(String(value));
    await input.press("Enter");
    await page.waitForTimeout(200);
  };
  const steamMode = (mode) => page.locator(`.re-steam-mode[data-mode="${mode}"]`).first().click();
  const save = async () => {
    const button = page.locator("#re-save-btn");
    await button.click();
    await page.waitForTimeout(300);
    if (/^REPLACE/.test((await button.textContent().catch(() => "")) ?? "")) await button.click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(2500);
  };
  return { open, shown, steamTempOff, type, steamMode, save };
}

// ---- The recordings.

/** Each file's start: the recipes written as the server writes them, the Workflow's steam set to 160 °C and 30 s from the script, and Streamline's main page opened. */
async function begin(steps, s) {
  steps.seeded = await step(seed);
  steps.steamStart = await step(() => put({ steamSettings: { targetTemperature: 160, duration: 30 } }));
  steps.started = await step(s.open);
  steps.cells = await s.cells();
}

/**
 * 1. Streamline's strip, its DYE2 switch on. With steam on: recipes `3`,
 * `1`, `2`, `5`, `4`. Then with steam off: `3`, `1`; off; `2`; off; `5`;
 * off; remembered 140 and 25; `2`; off; `5`; remembered values deleted; off;
 * `5`; off; `2`; remembered values deleted again; off; `2`. A strip tap on the highlighted recipe does nothing (`if (active)
 * return` in src/modules/dyeStrip.js), so recipe `3`, which holds no steam,
 * is tapped between two applies of one recipe. DYE2's `record` after recipe
 * `4` and after each apply of `2` and `5` made while steam was off.
 */
async function recordStrip(browser) {
  log("strip");
  const s = await streamlinePage(browser, "streamline");
  const steps = {};
  const apply = (number) => () => s.strip(number);
  await begin(steps, s);
  steps.applyRecipe3SteamOn = await step(apply(3));
  steps.applyRecipe1SteamOn = await step(apply(1));
  steps.applyRecipe2SteamOn = await step(apply(2));
  steps.applyRecipe5SteamOn = await step(apply(5));
  steps.applyRecipe4SteamOn = await step(apply(4));
  steps.recordAfterRecipe4 = await step(record);
  steps.applyRecipe3SteamOff = await step(apply(3));
  steps.applyRecipe1SteamOff = await step(apply(1));
  steps.steamOffBeforeRecipe2 = await step(steamOff);
  steps.applyRecipe2SteamOff = await step(apply(2));
  steps.recordAfterRecipe2SteamOff = await step(record);
  steps.steamOffBeforeRecipe5 = await step(steamOff);
  steps.applyRecipe5SteamOff = await step(apply(5));
  steps.recordAfterRecipe5SteamOff = await step(record);
  steps.steamOffBeforeRemembered = await step(steamOff);
  steps.rememberedOtherwise = await step(() => remember({ "last-steam-temp": 140, "last-steam-duration": 25 }));
  steps.applyRecipe2Remembered = await step(apply(2));
  steps.recordAfterRecipe2Remembered = await step(record);
  steps.steamOffBeforeRecipe5Remembered = await step(steamOff);
  steps.applyRecipe5Remembered = await step(apply(5));
  steps.recordAfterRecipe5Remembered = await step(record);
  steps.rememberedDeleted = await step(() => remember({ "last-steam-temp": null, "last-steam-duration": null }));
  steps.steamOffBeforeNothingRemembered = await step(steamOff);
  steps.applyRecipe3Between = await step(apply(3));
  steps.applyRecipe5NothingRemembered = await step(apply(5));
  steps.recordAfterRecipe5NothingRemembered = await step(record);
  steps.steamOffBeforeRecipe2NothingRemembered = await step(steamOff);
  steps.applyRecipe2NothingRemembered = await step(apply(2));
  steps.recordAfterRecipe2NothingRemembered = await step(record);
  // Recipe `5`'s apply above remembered its 35 s, so recipe `2` came back at it: deleted again, so recipe `2` meets nothing remembered.
  steps.rememberedDeletedAgain = await step(() => remember({ "last-steam-temp": null, "last-steam-duration": null }));
  steps.steamOffBeforeRecipe2Defaults = await step(steamOff);
  steps.applyRecipe3BetweenAgain = await step(apply(3));
  steps.applyRecipe2Defaults = await step(apply(2));
  steps.recordAfterRecipe2Defaults = await step(record);
  await s.close();
  return steps;
}

/**
 * 2. DYE2's dashboard, on a page of its own, Streamline's main page left
 * open. With steam on: recipes `1`, `2`, `5`, `4`. With steam off: `3`, `1`;
 * off; `2`; off; `5`. DYE2's `record` after `4` and after the off-state
 * applies of `2` and `5`.
 */
async function recordDashboard(browser) {
  log("dashboard");
  const s = await streamlinePage(browser, "streamline");
  const steps = {};
  await begin(steps, s);
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const d = dashboard(r);
  const apply = (number) => () => d.apply(number);
  steps.applyRecipe1SteamOn = await step(apply(1));
  steps.pills = await d.pills();
  steps.applyRecipe2SteamOn = await step(apply(2));
  steps.applyRecipe5SteamOn = await step(apply(5));
  steps.applyRecipe4SteamOn = await step(apply(4));
  steps.recordAfterRecipe4 = await step(record);
  steps.applyRecipe3SteamOff = await step(apply(3));
  steps.applyRecipe1SteamOff = await step(apply(1));
  steps.steamOffBeforeRecipe2 = await step(steamOff);
  steps.applyRecipe2SteamOff = await step(apply(2));
  steps.recordAfterRecipe2SteamOff = await step(record);
  steps.steamOffBeforeRecipe5 = await step(steamOff);
  steps.applyRecipe5SteamOff = await step(apply(5));
  steps.recordAfterRecipe5SteamOff = await step(record);
  await r.context.close();
  await s.close();
  return steps;
}

/**
 * 3. "Off" saved in DYE2's recipe editor on the loaded recipe, Streamline's
 * main page open: recipe `1` from the strip; the editor opened on it, its
 * steam temperature's Off preset tapped (which changes nothing), then its −
 * until it shows Off, and Save; `record`; steam back on
 * from Streamline's heater switch; `record`. Then a steam temperature of 155
 * and a steam time of 45 saved onto it while the Workflow's steam is on;
 * "Off" saved again; steam off from the script; 155 and 45 saved while it is
 * off. Then recipe `4` from the strip, and 155 and 45 saved onto it, the
 * server's own record of "Off", while steam is off.
 */
async function recordEditor(browser) {
  log("editor");
  const s = await streamlinePage(browser, "streamline");
  const steps = {};
  await begin(steps, s);
  steps.applyRecipe3First = await step(() => s.strip(3));
  steps.applyRecipe1 = await step(() => s.strip(1));
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const editor = recipeEditor(r);
  const edit = (id, change) => async () => {
    const opened = await editor.open(id);
    const shown = await editor.shown();
    const noted = (await change()) ?? [];
    const shownAfter = await editor.shown();
    return [...opened, ...(await editor.save()), { shown }, ...noted, { shownAfter }];
  };
  const steamOn155 = async () => {
    await editor.type("re-steam-temp-value", 155);
    await editor.steamMode("time");
    await editor.type("re-steam-value", 45);
  };
  steps.editorOff = await step(edit("1", editor.steamTempOff));
  steps.recordAfterEditorOff = await step(record);
  steps.heaterOn = await step(() => s.heater(true));
  steps.recordAfterHeaterOn = await step(record);
  steps.editorOnSteamOn = await step(edit("1", steamOn155));
  steps.recordAfterEditorOnSteamOn = await step(record);
  steps.editorOffAgain = await step(edit("1", editor.steamTempOff));
  steps.steamOffFromScript = await step(steamOff);
  steps.editorOnSteamOff = await step(edit("1", steamOn155));
  steps.recordAfterEditorOnSteamOff = await step(record);
  steps.applyRecipe4 = await step(() => s.strip(4));
  steps.editorOnRecipe4SteamOff = await step(edit("4", steamOn155));
  await r.context.close();
  await s.close();
  return steps;
}

/**
 * 4. Writes from the script standing for Decent Sync's plugin, Streamline's
 * main page open: steam off, recipe `3` then `1` from the strip, and recipe
 * `1`'s steam temperature and time written again; recipe `4` from the strip
 * with steam on, and "Off" written again. Then recipe `3` and `1` again
 * (steam back on), recipe `1`'s record rewritten from the script to hold
 * "Off" (record only), "Off" written into the Workflow, and `record`.
 */
async function recordLoadWrite(browser) {
  log("load write");
  const s = await streamlinePage(browser, "streamline");
  const steps = {};
  await begin(steps, s);
  steps.steamOffFirst = await step(steamOff);
  steps.applyRecipe3First = await step(() => s.strip(3));
  steps.applyRecipe1SteamOff = await step(() => s.strip(1));
  steps.loadWriteMatching = await step(() => put({ steamSettings: { targetTemperature: 150, duration: 40 } }));
  steps.applyRecipe4SteamOn = await step(() => s.strip(4));
  steps.loadWriteOff = await step(steamOff);
  steps.applyRecipe3Again = await step(() => s.strip(3));
  steps.applyRecipe1Again = await step(() => s.strip(1));
  steps.recordRewrittenOff = await step(rewriteRecipeOneOff);
  steps.loadWriteOffEdit = await step(steamOff);
  steps.recordAfterOffEdit = await step(record);
  await s.close();
  return steps;
}

/**
 * 5. Recipe `1` from the strip while Auto Steam's session flag is set
 * (`isAutoSteamActive` in src/modules/api.js reads it from the page's
 * storage): steam on at 160 °C and 30 s, recipe `3` first, the flag set,
 * recipe `1`, the flag removed.
 */
async function recordAutoSteam(browser) {
  log("auto steam");
  const s = await streamlinePage(browser, "streamline");
  const steps = {};
  await begin(steps, s);
  steps.applyRecipe3First = await step(() => s.strip(3));
  steps.autoSteamActive = await step(async () => [await s.autoSteam(true)]);
  steps.applyRecipe1AutoSteam = await step(() => s.strip(1));
  steps.autoSteamEnded = await step(async () => [await s.autoSteam(false)]);
  await s.close();
  return steps;
}

/** 6. Streamline's settings pages whose labels #616 renames: Quick Adjustments › Shot control and › Hot Water, and Calibration › Sensor Calibration. Not exchanges. */
async function recordSettingsLabels(browser) {
  log("settings labels");
  const s = await streamlinePage(browser, "settings");
  watching.delete(s);
  const result = {};
  await s.open();
  result.shotControl = await s.settingsShown("quickadjustments", "flowmultiplier");
  await s.home();
  result.hotWater = await s.settingsShown("quickadjustments", "hotwater");
  await s.home();
  result.sensorCalibration = await s.settingsShown("calibration", "calib_sensors");
  await s.r.context.close();
  return result;
}

const keys = async () => Object.fromEntries(await Promise.all(["recipes", "selection"].map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body])));

// ---- One run, on a Decaid whose data is new.

log("installing the recorder");
const recorderSource = {
  manifest: JSON.parse(fs.readFileSync(path.join(RECORDER, "manifest.json"), "utf8")),
  plugin: fs.readFileSync(path.join(RECORDER, "plugin.js"), "utf8"),
};
const sourceTaken = await api("PUT", "/plugins/workflow-recorder.reaplugin/source", recorderSource, "launch");
if (sourceTaken.response.status >= 300) throw new Error(`The recorder was not installed: ${JSON.stringify(sourceTaken.response)}`);
const enabled = await api("POST", "/plugins/workflow-recorder.reaplugin/enable", undefined, "launch");
await wait(1000);
recorder = listen("workflow-recorder.reaplugin", "workflow");
if ((await recorder.opened) !== 101) throw new Error("The recorder's socket did not open");
/** The recorder's own source is ../dye2-v0.1.26/workflow-recorder/, so the recording names it and leaves it out. */
const withoutSource = (exchange) => ({ request: { ...exchange.request, body: "<../dye2-v0.1.26/workflow-recorder/>" }, response: exchange.response });

log(`installing DYE2 v${DYE2_VERSION}`);
const bundledDye2 = await plugins();
const install = await api("POST", "/plugins/install/github-release", { repo: "decentespresso/dye2" }, "launch");
await wait(4000);
const listed = await plugins();
if (!listed.some((plugin) => plugin.version === DYE2_VERSION && plugin.loaded)) throw new Error(`DYE2 v${DYE2_VERSION} is not loaded: ${JSON.stringify(listed)}`);
changed = listen("dye2.reaplugin", "changed");
if ((await changed.opened) !== 101) throw new Error("DYE2's changed socket did not open");

await seedLibrary();
buildRecipes();
const library = {
  beans: (await api("GET", "/beans")).response.body,
  beanBatches: (await api("GET", "/bean-batches")).response.body,
  grinders: (await api("GET", "/grinders")).response.body,
  profiles: (await api("GET", "/profiles")).response.body.filter((record) => record.profile.title === "Classic Italian espresso"),
  info: (await api("GET", "/info")).response.body,
};
write("loading.json", {
  recorder: { source: withoutSource(sourceTaken), enabled },
  bundledDye2,
  install,
  listed,
  ...(await snapshot()),
  streamline: await steamKeys(),
});

// Streamline covers its page with a screensaver while the machine sleeps, which Decaid puts it to after an idle hour.
await api("PUT", "/machine/state/idle");
const browser = await chromium.launch();
try {
  write("strip.json", await recordStrip(browser));
  write("dashboard.json", await recordDashboard(browser));
  write("editor.json", await recordEditor(browser));
  write("load-write.json", await recordLoadWrite(browser));
  write("auto-steam.json", await recordAutoSteam(browser));
  write("settings-labels.json", await recordSettingsLabels(browser));
  write("library.json", { ...library, recipes: await recipes() });
  write("keys.json", await keys());
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
