// Records what DYE2 v0.1.40 and Streamline v0.2.27 write to Decaid v0.9.2, as
// README.md describes: drives DYE2's and Streamline's pages in headless
// Chromium and sends requests from Node, as Decent Sync's plugin and server
// would, keeping each exchange with Decaid's answer, the pushes heard on
// DYE2's `changed` socket and the Workflows Decaid sent plugins (heard
// through ../dye2-v0.1.26/workflow-recorder/). Run it once, from the
// repository root, against a Decaid started with a token whose data is new,
// still holding its bundled DYE2, with Streamline v0.2.27's files served at
// SKIN:
//
//   DECAID_EXTENSIONS_TOKEN=<token> node server/test/fixtures/decaid/dye2-v0.1.40/record.mjs <output dir>
//
// It reads DECAID and SKIN from the environment for other addresses, and
// DECAID_EXTENSIONS_TOKEN for the token Decaid was started with, which it
// sends with the requests that install a plugin and never writes to a file:
// a request that carried it holds `"token": "launch"`. It installs the
// recorder and DYE2's latest release, which must be v0.1.40, makes the
// library, and writes DYE2's keys as Decent Sync's server left them before
// #550.
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
const BASKETS = `${STORE}/baskets`;
const FAVOURITES = `${STORE}/autoFavourites`;
const DYE2_VERSION = "0.1.40";
/** Time for DYE2 and Streamline to follow a Workflow change, and a margin. */
const SETTLE_MS = 2500;
/** The routes whose reads a page sends that may be kept. Every request but a read is kept, whatever its route. */
const KEPT = [
  /^\/plugins\/dye2\.reaplugin\/(selection|record|save-recipe)$/,
  /^\/store\/dye2\.reaplugin\/(recipes|baskets|equipment|selection|autoFavourites)$/,
  /^\/workflow$/,
  /^\/grinders(\/[^/]+)?$/,
];
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
 * ../streamline-v0.2.24/record.mjs makes its own: in each file, in document
 * order, a read of DYE2's `recipes` or of `/workflow` whose answer is the
 * same as the last one read or posted before it in that file keeps its
 * status and `unchanged: true` in place of its body; and outside
 * `WHOLE_PROFILES`, each whole profile is `{"$profile": "<title>/<hash>"}`,
 * one copy of each kept in `library.json`'s `profileCopies`.
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

/** The pages open on Streamline, whose exchanges a step also takes. */
const watching = new Set();

/** The reads a step may make after its action, by the name `after` asks for them by. */
const READS = {
  workflow: () => api("GET", "/workflow"),
  selection: () => api("GET", SELECTION),
  recipes: () => api("GET", RECIPES),
  favourites: () => api("GET", FAVOURITES),
  grinders: () => api("GET", "/grinders?includeArchived=true"),
  offered: () => api("GET", "/grinders"),
};

/**
 * A step: the exchanges `act` gives, then those each open Streamline page
 * sent meanwhile that `act` did not take (`alsoSent`, by page name), then, as
 * `after` asks, reads made once DYE2 and Streamline have followed (the
 * Workflow, DYE2's derived selection, its recipes, its favourites, Decaid's
 * grinders with the archived ones, and those it offers), the pushes heard on
 * `changed` meanwhile, the context of each Workflow Decaid sent plugins
 * (`events`), and when each push and event came, in ms from the step's start
 * (`timing`).
 */
async function step(act, { after = ["workflow", "selection", "recipes"], settleMs = SETTLE_MS } = {}) {
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
  for (const name of after) reads.push(await READS[name]());
  const result = { exchanges };
  if (Object.keys(alsoSent).length) result.alsoSent = alsoSent;
  result.after = reads;
  const pushes = changed.heard.slice(mark).filter(({ at }) => at >= started);
  const events = recorder.heard.slice(eventMark).filter(({ at }) => at >= started);
  result.pushes = pushes.map(({ payload }) => payload);
  result.events = events.map(({ payload }) => payload.workflow?.context ?? null);
  result.timing = { pushes: pushes.map(({ at }) => at - started), events: events.map(({ at }) => at - started) };
  return result;
}

const profileTitled = async (title) => (await api("GET", "/profiles?includeHidden=true")).response.body.find((record) => record.profile.title === title);
const plugins = async () => (await api("GET", "/plugins")).response.body.filter((plugin) => plugin.id === "dye2.reaplugin");
const recipes = async () => (await api("GET", RECIPES)).response.body ?? [];
const put = async (body) => [await api("PUT", "/workflow", body)];
/** DYE2's `record`, as Decent Sync's plugin calls it after each change. */
const record = async () => [await api("POST", RECORD)];

// ---- The library, and DYE2's keys as Decent Sync's server left them before #550.

const GRINDERS = {
  /** The grinder the seeded recipes name: no range and no default. */
  base: { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 },
  /** One declaring a default grind setting and RPM, and no range. */
  withDefault: { model: "Fixture Grinder Default", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100, extras: { settingDefault: 12, rpmDefault: 900 } },
  /** One declaring a range alone, whose middles are 6 and 800. */
  withRange: { model: "Fixture Grinder Range", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100, extras: { settingMin: 2, settingMax: 10, rpmMin: 400, rpmMax: 1200 } },
  /** One declaring neither. */
  plain: { model: "Fixture Grinder Plain", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 },
  /** One deleted from the tablet in `editor.json`. */
  gone: { model: "Fixture Grinder Gone", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 },
};
const BASKET_RECORDS = [
  { name: "Fixture 18g Precision", size: "double", notes: "Fixture notes", diameterMm: 58.5, id: randomUUID(), createdAt: "2026-11-14T09:00:00.000Z" },
  { name: "Fixture 20g High-flow", size: "double", diameterMm: 58, id: randomUUID(), createdAt: "2026-11-14T09:00:01.000Z" },
];
const NAMES = {
  full: "Fixture Full Recipe",
  bareServer: "Fixture Bare Server",
  bareDye2: "Fixture Bare DYE2",
  rpmZeroServer: "Fixture RPM Zero Server",
  rpmZeroDye2: "Fixture RPM Zero DYE2",
  grinderOnly: "Fixture Grinder Only",
  goneGrinder: "Fixture Gone Grinder",
  ratio: "Fixture Ratio Recipe",
};
/** The library's records, by the names above, once made. */
const made = {};

async function seedLibrary() {
  made.bean = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  made.batch = (await api("POST", `/beans/${made.bean.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 })).response.body;
  made.grinders = {};
  for (const [key, body] of Object.entries(GRINDERS)) made.grinders[key] = (await api("POST", "/grinders", body)).response.body;
  made.adaptive = await profileTitled("Adaptive v3");
  made.classic = await profileTitled("Classic Italian espresso");
  return [await api("POST", BASKETS, BASKET_RECORDS)];
}

/**
 * A recipe record as Decent Sync's server wrote one before #550
 * (`recipeRecord`, `recipeWorkflow` and `recordOf` in
 * server/src/library/recipe-intake.ts at `origin/main`): each field only
 * where the Recipe holds one, so no null for a dose, grind setting, RPM,
 * feed rate, Grinder or Basket it names none of, in `dashboardVariables` or
 * in its embedded Workflow, and no `targetYield` there for no yield; a blank
 * barista and drinker; shown exactly while in a slot; explicit nulls for a
 * Bean it names none of; a profile in `jsonb`'s key order; with the record
 * id and a made-up global id, as the plugin's write gives it.
 */
function serverRecord({ id, name, bean = null, batch = null, slot = null, profile, brewC, dose, drink, grind, rpm, feedRate, grinder, basket, capturedAt }) {
  const held = (value) => value !== undefined && value !== null;
  const extras = { ...(held(rpm) ? { rpm } : {}), ...(held(feedRate) ? { feedRate } : {}), ...(basket ? { basketId: basket.id, basketName: basket.name } : {}) };
  const context = {
    ...(held(dose) ? { targetDoseWeight: dose } : {}),
    ...(held(drink) ? { targetYield: drink } : {}),
    ...(held(grind) ? { grinderSetting: String(grind) } : {}),
    ...(grinder ? { grinderId: grinder.id, grinderModel: grinder.model } : {}),
    ...(Object.keys(extras).length ? { extras } : {}),
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
      ...(held(dose) ? { dose } : {}),
      ...(held(drink) ? { drink } : {}),
      brewC,
      hotWaterMode: "vol",
      ...(held(grind) ? { grind } : {}),
      ...(held(rpm) ? { rpm } : {}),
      ...(held(feedRate) ? { feedRate } : {}),
      ...(grinder ? { grinderId: grinder.id, grinderModel: grinder.model } : {}),
      ...(basket ? { basketId: basket.id, basketName: basket.name } : {}),
      equipmentIds: [],
      equipmentNames: [],
      equipmentCustom: {},
    },
    title: name,
    subtitle: bean ? bean.name : "",
    workflow: { context, profile: profileAtBrewC(profile.profile, brewC) },
    id,
    capturedAt,
    decentSyncId: randomUUID(),
  });
}

/** The recipes README.md lists, as the server wrote them, each built once so its global id stays. */
let RECIPE;
function buildRecipes() {
  const { bean, batch, grinders, adaptive, classic } = made;
  const at = (second) => `2026-11-14T10:00:0${second}.000Z`;
  RECIPE = {
    full: (slot) => serverRecord({ id: "1", name: NAMES.full, bean, batch, slot, profile: adaptive, brewC: 92, dose: 18, drink: 36, grind: 2.5, rpm: 1000, feedRate: "MF", grinder: grinders.base, basket: BASKET_RECORDS[0], capturedAt: at(1) }),
    bareServer: (slot) => serverRecord({ id: "2", name: NAMES.bareServer, slot, profile: classic, brewC: 93, capturedAt: at(2) }),
    bareDye2: (slot) => serverRecord({ id: "3", name: NAMES.bareDye2, slot, profile: classic, brewC: 93, capturedAt: at(3) }),
    rpmZeroServer: (slot) => serverRecord({ id: "4", name: NAMES.rpmZeroServer, slot, profile: classic, brewC: 93, dose: 19, drink: 38, grind: 3, rpm: 0, grinder: grinders.base, capturedAt: at(4) }),
    rpmZeroDye2: (slot) => serverRecord({ id: "5", name: NAMES.rpmZeroDye2, slot, profile: classic, brewC: 93, dose: 19, drink: 38, grind: 3, rpm: 0, grinder: grinders.base, capturedAt: at(5) }),
    grinderOnly: (slot) => serverRecord({ id: "6", name: NAMES.grinderOnly, slot, profile: classic, brewC: 93, dose: 19, drink: 38, grinder: grinders.base, capturedAt: at(6) }),
    ratio: (slot) => serverRecord({ id: "8", name: NAMES.ratio, bean, batch, slot, profile: adaptive, brewC: 92, dose: 18, drink: 45, grind: 2.5, grinder: grinders.base, capturedAt: at(8) }),
    goneGrinder: (slot) => serverRecord({ id: "7", name: NAMES.goneGrinder, slot, profile: classic, brewC: 93, dose: 20, drink: 40, grind: 4, rpm: 700, grinder: grinders.gone, capturedAt: at(7) }),
  };
  const ids = new Map();
  for (const [key, build] of Object.entries(RECIPE)) {
    RECIPE[key] = (slot) => {
      const built = build(slot);
      if (!ids.has(key)) ids.set(key, built.decentSyncId);
      return { ...built, decentSyncId: ids.get(key) };
    };
  }
}

/** DYE2's recipes written from the script, as Decent Sync's server writes records: those named, in slots 1 on, in the order given. */
const seed = (...keys) => async () => [await api("POST", RECIPES, keys.map((key, index) => RECIPE[key](index + 1)))];

/** DYE2's keys and the Workflow, read at once. */
async function snapshot() {
  const listed = await api("GET", STORE);
  const keys = Array.isArray(listed.response.body) ? listed.response.body : [];
  const values = {};
  for (const key of keys) values[key] = (await api("GET", `${STORE}/${key}`)).response.body;
  return { keys: listed, values, workflow: (await api("GET", "/workflow")).response.body };
}

// ---- DYE2's and Streamline's pages.

/** Reads kept on DYE2's pages: its selection, the recipes it reads again before an apply, and the Workflow. */
const dye2Reads = (route) => route === SELECTION || route === RECIPES || route === "/workflow";
/** Reads kept on Streamline: DYE2's selection, its recipes and the Workflow; and, where `grinders` says so, Decaid's grinders, which the strip reads before an apply for a grinder the tablet no longer holds. */
const streamlineReads = (grinders) => (route) => route === SELECTION || route === RECIPES || route === "/workflow" || (grinders && route === "/grinders");

/** DYE2's dashboard on a recorded page: opened afresh, a recipe's pill tapped, a grinder's tab tapped. */
function dashboard(r) {
  const { page } = r;
  const open = async () => {
    await page.goto(DYE2("dashboard"));
    await page.locator("#dye-recipe-pills .dye-recipe-pill").first().waitFor({ timeout: 20_000 });
    await r.take(3000);
  };
  const pill = async (title) => {
    await page.locator(`#dye-recipe-pills .dye-recipe-pill[title="${title}"]`).first().click();
    return r.take(2000);
  };
  /** Opens the dashboard and taps a pill, giving the tap's exchanges. */
  const apply = async (title) => {
    await open();
    return pill(title);
  };
  const tab = async (model) => {
    await page.locator("#dye-grinder-tabs .dye-grinder-tab", { hasText: model }).first().click();
    return r.take(2000);
  };
  const pills = () => page.locator("#dye-recipe-pills .dye-recipe-pill").evaluateAll((all) => all.map((pill) => ({ title: pill.getAttribute("title"), active: pill.classList.contains("active") })));
  const tabs = () => page.locator("#dye-grinder-tabs .dye-grinder-tab").evaluateAll((all) => all.map((tab) => ({ label: tab.textContent.trim(), active: tab.classList.contains("active") })));
  return { open, pill, apply, tab, pills, tabs };
}

/** The cards of a DYE2 grid (its Grinders page, its grinder and profile pickers): each one's name, and whether it is the highlighted one or shown archived. */
const cards = (page) =>
  page.locator("#dye-cards-grid .dye-card").evaluateAll((all) =>
    all
      .filter((card) => !card.classList.contains("dye-card-add"))
      .map((card) => ({
        name: card.querySelector(".dye-card-name")?.textContent.trim() ?? card.textContent.trim(),
        selected: card.classList.contains("dye-card-selected"),
        ...(card.classList.contains("dye-card-archived") ? { archived: true } : {}),
      })),
  );
const card = (page, name) => page.locator("#dye-cards-grid .dye-card").filter({ has: page.locator(".dye-card-name", { hasText: new RegExp(`^${name}$`) }) }).first();

/** DYE2's recipe editor on a recorded page: a recipe opened, what its grinder and Basket rows and its steppers show, a chip tapped, and Save. */
function recipeEditor(r) {
  const { page } = r;
  const open = async (id) => {
    await page.goto(DYE2(`recipe-edit?id=${encodeURIComponent(id)}`));
    await page.locator("#re-save-btn").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2500);
    return r.take();
  };
  /** Each chip of the grinder and Basket rows with whether it is the lit one, and what the dose, yield, grind setting and RPM steppers show. */
  const shown = () =>
    page.evaluate(() => {
      const chips = (id) => Array.from(document.querySelectorAll(`#${id} .re-grinder-chip`)).map((chip) => ({ label: chip.textContent.trim(), active: chip.classList.contains("active") }));
      const value = (id) => {
        const element = document.getElementById(id);
        return element ? (element.value ?? element.textContent).trim() : null;
      };
      return { grinderChips: chips("re-grinder-chips"), basketChips: chips("re-basket-chips"), dose: value("re-dose-value"), drink: value("re-drink-value"), grind: value("re-grind-value"), rpm: value("re-rpm-value") };
    });
  const chip = (row, label) => page.locator(`#${row} .re-grinder-chip`, { hasText: new RegExp(`^${label}$`) }).first().click();
  const save = async () => {
    const button = page.locator("#re-save-btn");
    await button.click();
    await page.waitForTimeout(300);
    if (/^REPLACE/.test((await button.textContent().catch(() => "")) ?? "")) await button.click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(2500);
  };
  return { open, shown, chip, save };
}

/**
 * Streamline v0.2.27's main page in its own browser context, its DYE2 switch
 * (`streamline.dye2Enabled`) on, on its recipe strip: opened, a strip button
 * tapped, a tile's button tapped, and what its dose, grind and Drink tiles
 * show.
 *
 * Streamline mirrors its DYE2 switch into Decaid's store
 * (`streamlineSettings`, src/modules/settingsSync.js) and takes the store's
 * value over the page's own as it loads, so `open` writes the store's too.
 */
async function streamlinePage(browser, name, { grinders = false } = {}) {
  const r = await recordedPage(browser, {
    viewport: { width: 1920, height: 1200 },
    keepRead: streamlineReads(grinders),
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
  /** Loads the main page afresh, its DYE2 switch first written into Streamline's mirror of it in Decaid's store, and waits for the strip button named. */
  self.open = (first) => async () => {
    const mirrored = await api("POST", "/store/streamlineSettings/streamline.dye2Enabled", "true");
    await page.goto(`${SKIN}/`);
    await cell(first).waitFor({ timeout: 30_000 });
    return [mirrored, ...(await r.take(6000))];
  };
  self.cells = () => page.locator("#dye-strip button").evaluateAll((all) => all.map((button) => button.textContent.trim()));
  self.strip = async (title) => {
    await cell(title).click({ timeout: 20_000 });
    return r.take(3000);
  };
  self.tap = async (id) => {
    await page.locator(`#${id}`).click();
    return r.take(2500);
  };
  /** What the main page's dose, grind and Drink tiles show. */
  self.tiles = () =>
    page.evaluate(() => {
      const text = (id) => document.getElementById(id)?.textContent.trim() ?? null;
      return { dose: text("dose-in-value"), grind: text("grind-value"), drink: text("drink-out-value"), ratio: text("drink-ratio-value") };
    });
  self.close = async () => {
    watching.delete(self);
    await r.context.close();
  };
  watching.add(self);
  return self;
}

// ---- The recordings.

/**
 * 1 to 3. Applies that clear. Recipes `1` (naming every part), `2` and `3`
 * (naming none), `4` and `5` (an RPM of 0) seeded as the server wrote them;
 * `3` and `5` then opened in DYE2's recipe editor and saved as they are, so
 * their records are DYE2 v0.1.40's own. Then, on DYE2's dashboard, recipe
 * `1`'s pill before each of the other four; and the same from Streamline's
 * strip.
 */
async function recordApplies(browser) {
  log("applies, dashboard");
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const d = dashboard(r);
  const editor = recipeEditor(r);
  const dash = {};
  dash.seeded = await step(seed("full", "bareServer", "bareDye2", "rpmZeroServer", "rpmZeroDye2"));
  const resave = (id) => async () => {
    const opened = await editor.open(id);
    const shown = await editor.shown();
    return [...opened, ...(await editor.save()), { shown }];
  };
  dash.editorSavedBare = await step(resave("3"));
  dash.editorSavedRpmZero = await step(resave("5"));
  dash.applyFull = await step(() => d.apply(NAMES.full));
  dash.pills = await d.pills();
  dash.applyBareServer = await step(() => d.apply(NAMES.bareServer));
  dash.applyFullAgain = await step(() => d.apply(NAMES.full));
  dash.applyBareDye2 = await step(() => d.apply(NAMES.bareDye2));
  dash.applyFullThird = await step(() => d.apply(NAMES.full));
  dash.applyRpmZeroServer = await step(() => d.apply(NAMES.rpmZeroServer));
  dash.applyFullFourth = await step(() => d.apply(NAMES.full));
  dash.applyRpmZeroDye2 = await step(() => d.apply(NAMES.rpmZeroDye2));
  await r.context.close();

  log("applies, strip");
  const s = await streamlinePage(browser, "streamline");
  const strip = {};
  const tapped = (name) => async () => [...(await s.strip(name)), { tiles: await s.tiles() }];
  strip.started = await step(s.open(NAMES.full));
  strip.cells = await s.cells();
  strip.applyFull = await step(tapped(NAMES.full));
  strip.applyBareServer = await step(tapped(NAMES.bareServer));
  strip.applyFullAgain = await step(tapped(NAMES.full));
  strip.applyBareDye2 = await step(tapped(NAMES.bareDye2));
  strip.applyFullThird = await step(tapped(NAMES.full));
  strip.applyRpmZeroServer = await step(tapped(NAMES.rpmZeroServer));
  strip.applyFullFourth = await step(tapped(NAMES.full));
  strip.applyRpmZeroDye2 = await step(tapped(NAMES.rpmZeroDye2));
  await s.close();
  return { dash, strip };
}

/**
 * 4. Grinder picks with a recipe loaded. For each of the dashboard's grinder
 * tabs, a card on DYE2's Grinders page and the grinder picker's CONFIRM, and
 * for each of the three grinders: the records written back, recipe `1` (a
 * grind setting of 2.5 and 1000 RPM on `Fixture Grinder 64`) applied from
 * the dashboard, the pick, then DYE2's `record`. Then the same three picks
 * from the tabs with recipe `6` loaded, which names the grinder and no grind
 * setting or RPM.
 */
async function recordGrinderPicks(browser) {
  log("grinder picks");
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const { page } = r;
  const d = dashboard(r);
  const surfaces = {
    tab: async (model) => [...(await d.tab(model)), { tabs: await d.tabs() }],
    card: async (model) => {
      await page.goto(DYE2("grinders"));
      await page.locator("#dye-cards-grid .dye-card").first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      const opened = await r.take();
      await card(page, model).click();
      return [...opened, ...(await r.take(2000)), { cards: await cards(page) }];
    },
    picker: async (model) => {
      await page.goto(DYE2("grinder-picker"));
      await page.locator("#dye-cards-grid .dye-card").first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      const opened = await r.take();
      await card(page, model).click();
      await page.waitForTimeout(500);
      await page.locator("#dye-confirm-btn").click();
      await page.waitForURL(/dashboard/, { waitUntil: "commit" });
      return [...opened, ...(await r.take(3000))];
    },
  };
  const grinders = { Default: GRINDERS.withDefault.model, Range: GRINDERS.withRange.model, Plain: GRINDERS.plain.model };
  const steps = {};
  const pick = async (recipe, surface, model) => ({
    reseeded: await step(seed("full", "grinderOnly"), { after: [] }),
    applied: await step(() => d.apply(NAMES[recipe])),
    picked: await step(() => surfaces[surface](model)),
    recorded: await step(record),
  });
  for (const surface of Object.keys(surfaces)) {
    for (const [grinder, model] of Object.entries(grinders)) steps[`${surface}${grinder}`] = await pick("full", surface, model);
  }
  for (const [grinder, model] of Object.entries(grinders)) steps[`grinderOnlyTab${grinder}`] = await pick("grinderOnly", "tab", model);
  await r.context.close();
  return steps;
}

/**
 * 5. The recipe editor's None chips, and a grinder deleted from the tablet.
 * Recipe `1` applied from the dashboard; `Fixture Grinder Gone` deleted from
 * the script; recipe `7`, which names it, applied from Streamline's strip
 * and from DYE2's dashboard, recipe `1` before each; recipe `7` opened in
 * the editor and saved as it shows; then recipe `1` applied, opened in the
 * editor, None tapped in its grinder and Basket rows, and saved.
 */
async function recordEditor(browser) {
  log("editor");
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const d = dashboard(r);
  const editor = recipeEditor(r);
  const steps = {};
  const withGrinders = { after: ["workflow", "selection", "recipes", "grinders"] };
  steps.seeded = await step(seed("full", "goneGrinder"));
  steps.applyFull = await step(() => d.apply(NAMES.full));
  steps.grinderDeleted = await step(async () => [await api("DELETE", `/grinders/${made.grinders.gone.id}`)], withGrinders);
  const s = await streamlinePage(browser, "streamline", { grinders: true });
  steps.streamlineStarted = await step(s.open(NAMES.full));
  steps.stripGoneGrinder = await step(async () => [...(await s.strip(NAMES.goneGrinder)), { tiles: await s.tiles() }]);
  await s.close();
  steps.applyFullAgain = await step(() => d.apply(NAMES.full));
  steps.dashboardGoneGrinder = await step(async () => [...(await d.apply(NAMES.goneGrinder)), { tabs: await d.tabs() }]);
  steps.editorGoneGrinder = await step(async () => {
    const opened = await editor.open("7");
    const shown = await editor.shown();
    return [...opened, ...(await editor.save()), { shown }];
  });
  steps.applyFullThird = await step(() => d.apply(NAMES.full));
  steps.editorNoneChips = await step(async () => {
    const opened = await editor.open("1");
    const shown = await editor.shown();
    await editor.chip("re-grinder-chips", "None");
    await editor.chip("re-basket-chips", "None");
    const shownAfter = await editor.shown();
    return [...opened, ...(await editor.save()), { shown }, { shownAfter }];
  });
  await r.context.close();
  return steps;
}

/**
 * 6. A grinder archived and unarchived on DYE2's Grinders page: the page
 * opened; `Fixture Grinder Plain`'s card held, which opens its form, and
 * ARCHIVE; its card, now shown archived, tapped, which opens its form, and
 * UNARCHIVE.
 */
async function recordGrinderArchive(browser) {
  log("grinder archive");
  const r = await recordedPage(browser, { keepRead: (route) => route.startsWith("/grinders") });
  const { page } = r;
  const model = GRINDERS.plain.model;
  const single = () => api("GET", `/grinders/${made.grinders.plain.id}`);
  const reads = { after: ["grinders", "offered"] };
  const steps = {};
  const archiveButton = async () => {
    await page.locator("#dye-modal-backdrop.open").waitFor();
    const label = (await page.locator("#dye-modal-archive").textContent()).trim();
    await page.locator("#dye-modal-archive").click();
    return [...(await r.take(2500)), { button: label }, { cards: await cards(page) }, await single()];
  };
  steps.opened = await step(async () => {
    await page.goto(DYE2("grinders"));
    await page.locator("#dye-cards-grid .dye-card").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    return [...(await r.take()), { cards: await cards(page) }];
  }, reads);
  steps.archived = await step(async () => {
    // Held for 800 ms, past the page's 500 ms long press.
    await card(page, model).click({ delay: 800 });
    return archiveButton();
  }, reads);
  steps.unarchived = await step(async () => {
    await card(page, model).click();
    return archiveButton();
  }, reads);
  await r.context.close();
  return steps;
}

/**
 * 7. DYE2's profile picker with recipe `8` loaded (`Adaptive v3`, 18 g in
 * and 45 g out, where both profiles name a yield of 36 g): its own
 * profile's card and CONFIRM, then DYE2's `record`; the records written back
 * and recipe `8` applied again; `Classic Italian espresso`'s card and
 * CONFIRM, then `record`.
 */
async function recordProfilePicker(browser) {
  log("profile picker");
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const { page } = r;
  const d = dashboard(r);
  const confirm = (title) => async () => {
    await page.goto(DYE2("profile-picker"));
    await card(page, title).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    const opened = await r.take();
    const before = (await cards(page)).filter((shown) => shown.selected).map((shown) => shown.name);
    await card(page, title).click();
    await page.waitForTimeout(500);
    await page.locator("#dye-confirm-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return [...opened, ...(await r.take(3000)), { highlightedAsOpened: before }];
  };
  const steps = {};
  steps.seeded = await step(seed("ratio"));
  steps.applyRatio = await step(() => d.apply(NAMES.ratio));
  steps.confirmOwn = await step(confirm("Adaptive v3"));
  steps.recordAfterOwn = await step(record);
  steps.reseeded = await step(seed("ratio"), { after: [] });
  steps.applyRatioAgain = await step(() => d.apply(NAMES.ratio));
  steps.confirmOther = await step(confirm("Classic Italian espresso"));
  steps.recordAfterOther = await step(record);
  await r.context.close();
  return steps;
}

/**
 * 8. SAVE TO RECIPE on Edit Auto Favourite, opened afresh, as the Auto
 * Favourites page's add card opens it, which takes the Workflow as its
 * snapshot, recipe `1` applied: a title typed and SAVE TO RECIPE, "Always
 * display on Dashboard" as it opens (Yes); then again with it set to No.
 */
async function recordSaveToRecipe(browser) {
  log("save to recipe");
  const r = await recordedPage(browser, { keepRead: (route) => dye2Reads(route) || route === FAVOURITES });
  const { page } = r;
  const d = dashboard(r);
  const reads = { after: ["workflow", "selection", "recipes", "favourites"] };
  const save = (title, { display }) => async () => {
    await d.open();
    await page.goto(DYE2("auto-fav-edit"));
    await page.locator("#afe-save-btn").waitFor({ timeout: 20_000 });
    await page.waitForTimeout(3000);
    const opened = await r.take();
    await page.locator("#afe-title-input").fill(title);
    if (!display) await page.locator('#afe-always-display .dye-seg-btn[data-idx="1"]').click();
    await page.waitForTimeout(500);
    const shown = await page.evaluate(() => ({
      alwaysDisplay: document.querySelector("#afe-always-display .dye-seg-btn.active")?.textContent.trim() ?? null,
      favNumber: document.querySelector(".afe-fav-num.active")?.dataset.num ?? null,
      button: document.getElementById("afe-save-btn")?.textContent.trim() ?? null,
    }));
    await page.locator("#afe-save-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return [...opened, ...(await r.take(3000)), { shown }];
  };
  const steps = {};
  steps.seeded = await step(seed("full"), reads);
  steps.applyFull = await step(() => d.apply(NAMES.full), reads);
  steps.saved = await step(save("Fixture Saved From Favourite", { display: true }), reads);
  steps.pillsAfterSave = await d.pills();
  steps.savedNotDisplayed = await step(save("Fixture Saved Unpinned", { display: false }), reads);
  await r.context.close();
  return steps;
}

/**
 * 9. Workflow writes clearing each part with an explicit null, from the
 * script, as this release's load write will: recipe `1` applied from the
 * dashboard; every part cleared in one write, the yield as 0; then a yield
 * of null alone; then recipe `1` applied again and each part cleared in a
 * write of its own.
 */
async function recordExplicitNulls(browser) {
  log("explicit nulls");
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const d = dashboard(r);
  const steps = {};
  steps.seeded = await step(seed("full"));
  steps.applyFull = await step(() => d.apply(NAMES.full));
  steps.clearedAll = await step(() => put({ context: { targetDoseWeight: null, grinderSetting: null, grinderId: null, grinderModel: null, targetYield: 0, extras: { rpm: null, feedRate: null, basketId: null, basketName: null } } }));
  steps.yieldNull = await step(() => put({ context: { targetYield: null } }));
  steps.applyFullAgain = await step(() => d.apply(NAMES.full));
  steps.doseNull = await step(() => put({ context: { targetDoseWeight: null } }));
  steps.grindNull = await step(() => put({ context: { grinderSetting: null } }));
  steps.grinderNull = await step(() => put({ context: { grinderId: null, grinderModel: null } }));
  steps.rpmNull = await step(() => put({ context: { extras: { rpm: null } } }));
  steps.feedRateNull = await step(() => put({ context: { extras: { feedRate: null } } }));
  steps.basketNull = await step(() => put({ context: { extras: { basketId: null, basketName: null } } }));
  steps.yieldZero = await step(() => put({ context: { targetYield: 0 } }));
  await r.context.close();
  return steps;
}

/**
 * 10. A yield set on a recipe holding none, Streamline's main page open:
 * recipe `2` (naming none of the parts, as the server wrote it), recipe `1`
 * and recipe `2` again applied from the strip, so that each tap is an apply
 * whatever the Workflow named before; DYE2's `record`; the Drink tile's + tapped;
 * `record`; a yield of 40 written from the script; `record`.
 */
async function recordYieldSet(browser) {
  log("yield set");
  const s = await streamlinePage(browser, "streamline");
  const steps = {};
  const tiles = async (act) => [...(await act()), { tiles: await s.tiles() }];
  steps.seeded = await step(seed("full", "bareServer"));
  steps.started = await step(s.open(NAMES.full));
  steps.applyBareFirst = await step(() => tiles(() => s.strip(NAMES.bareServer)));
  steps.applyFull = await step(() => tiles(() => s.strip(NAMES.full)));
  steps.applyBare = await step(() => tiles(() => s.strip(NAMES.bareServer)));
  steps.recordUnmoved = await step(record);
  steps.drinkPlus = await step(() => tiles(() => s.tap("drink-out-plus")));
  steps.recordAfterPlus = await step(record);
  steps.yieldForty = await step(async () => {
    const written = await put({ context: { targetYield: 40 } });
    await wait(SETTLE_MS);
    return [...written, ...(await s.r.take(0)), { tiles: await s.tiles() }];
  });
  steps.recordAfterForty = await step(record);
  await s.close();
  return steps;
}

// ---- One run, on a Decaid whose data is new.

log("installing the recorder");
const recorderSource = {
  manifest: JSON.parse(fs.readFileSync(path.join(RECORDER, "manifest.json"), "utf8")),
  plugin: fs.readFileSync(path.join(RECORDER, "plugin.js"), "utf8"),
};
const sourceRefused = await api("PUT", "/plugins/workflow-recorder.reaplugin/source", recorderSource);
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
const installRefused = await api("POST", "/plugins/install/github-release", { repo: "decentespresso/dye2" });
const install = await api("POST", "/plugins/install/github-release", { repo: "decentespresso/dye2" }, "launch");
await wait(4000);
const listed = await plugins();
if (!listed.some((plugin) => plugin.version === DYE2_VERSION && plugin.loaded)) throw new Error(`DYE2 v${DYE2_VERSION} is not loaded: ${JSON.stringify(listed)}`);
changed = listen("dye2.reaplugin", "changed");
if ((await changed.opened) !== 101) throw new Error("DYE2's changed socket did not open");

const basketsWritten = await seedLibrary();
buildRecipes();
const library = {
  beans: (await api("GET", "/beans")).response.body,
  beanBatches: (await api("GET", "/bean-batches")).response.body,
  grinders: (await api("GET", "/grinders")).response.body,
  baskets: (await api("GET", BASKETS)).response.body,
  profiles: (await api("GET", "/profiles")).response.body.filter((record) => ["Adaptive v3", "Classic Italian espresso"].includes(record.profile.title)),
  info: (await api("GET", "/info")).response.body,
};
write("loading.json", {
  recorder: { sourceRefused: withoutSource(sourceRefused), source: withoutSource(sourceTaken), enabled },
  bundledDye2,
  installRefused,
  install,
  listed,
  basketsWritten,
  ...(await snapshot()),
});

// Streamline covers its page with a screensaver while the machine sleeps, which Decaid puts it to after an idle hour.
await api("PUT", "/machine/state/idle");
const browser = await chromium.launch();
try {
  const { dash, strip } = await recordApplies(browser);
  write("dashboard-applies.json", dash);
  write("strip-applies.json", strip);
  write("grinder-picks.json", await recordGrinderPicks(browser));
  write("editor.json", await recordEditor(browser));
  write("grinder-archive.json", await recordGrinderArchive(browser));
  write("profile-picker.json", await recordProfilePicker(browser));
  write("save-to-recipe.json", await recordSaveToRecipe(browser));
  write("explicit-nulls.json", await recordExplicitNulls(browser));
  write("yield-set.json", await recordYieldSet(browser));
  write("library.json", { ...library, grindersAtEnd: (await api("GET", "/grinders?includeArchived=true")).response.body });
  write("keys.json", Object.fromEntries(await Promise.all(["recipes", "autoFavourites", "selection"].map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body]))));
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
