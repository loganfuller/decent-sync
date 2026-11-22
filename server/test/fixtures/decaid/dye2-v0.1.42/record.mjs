// Records what DYE2 v0.1.42 and Streamline v0.2.31 write to Decaid v0.9.2
// with a grind setting of 0, as README.md describes: drives DYE2's and
// Streamline's pages in headless Chromium and sends requests from Node, as
// Decent Sync's plugin and server would, keeping each exchange with Decaid's
// answer, the pushes heard on DYE2's `changed` socket and the Workflows
// Decaid sent plugins (heard through ../dye2-v0.1.26/workflow-recorder/).
// Made from ../dye2-v0.1.40/record.mjs, whose helpers it keeps. Run it once,
// from the repository root, against a Decaid started with a token whose data
// is new, still holding its bundled DYE2, with Streamline v0.2.31's files
// served at SKIN:
//
//   DECAID_EXTENSIONS_TOKEN=<token> node server/test/fixtures/decaid/dye2-v0.1.42/record.mjs <output dir>
//
// It reads DECAID and SKIN from the environment for other addresses, and
// DECAID_EXTENSIONS_TOKEN for the token Decaid was started with, which it
// sends with the requests that install, disable and enable a plugin and
// never writes to a file: a request that carried it holds `"token":
// "launch"`. It installs the recorder and DYE2's latest release, which must
// be v0.1.42, makes the library, and writes DYE2's keys as Decent Sync's
// server writes records, and one as DYE2 saved a recipe at 0 before v0.1.42.
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
const DYE2_VERSION = "0.1.42";
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
  const socket = changed;
  const mark = socket.heard.length;
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
  // A step that loads DYE2 again opens its socket again (`reloadDye2`): the pushes heard on both.
  const pushes = [...socket.heard.slice(mark), ...(changed === socket ? [] : changed.heard)].filter(({ at }) => at >= started);
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


// ---- The library, and DYE2's keys as Decent Sync's server writes them.

const GRINDERS = {
  /** The grinder the seeded recipes name: no range and no default. */
  base: { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 },
  /** One declaring a range from 0 and a default grind setting of 0, which a pick brings. */
  zeroDefault: { model: "Fixture Grinder Zero", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100, extras: { settingMin: 0, settingMax: 10, settingDefault: 0 } },
};
const BASKET_RECORDS = [{ name: "Fixture 18g Precision", size: "double", notes: "Fixture notes", diameterMm: 58.5, id: randomUUID(), createdAt: "2026-11-22T09:00:00.000Z" }];
const NAMES = {
  full: "Fixture Full Recipe",
  zero: "Fixture Zero Grind",
  oldZero: "Fixture Old Zero Grind",
  noGrind: "Fixture No Grind",
  zeroText: "Fixture Zero Text",
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
 * A recipe record as ../dye2-v0.1.40/record.mjs writes one, as Decent
 * Sync's server wrote records before #550: each field only where the Recipe
 * holds one, a grind setting of 0 included, which its embedded Workflow
 * holds as the text "0", as this server writes one from #617 and DYE2
 * v0.1.42 builds one (`buildRecipeWorkflow`); with `oldZero`, none there
 * instead, as DYE2 saved a recipe at 0 before v0.1.42; a blank barista and
 * drinker; shown exactly while in a slot; explicit nulls for a Bean it names
 * none of; a profile in `jsonb`'s key order; with the record id and a
 * made-up global id, as the plugin's write gives it.
 */
function serverRecord({ id, name, bean = null, batch = null, slot = null, profile, brewC, dose, drink, grind, rpm, feedRate, grinder, basket, capturedAt, oldZero = false }) {
  const held = (value) => value !== undefined && value !== null;
  const extras = { ...(held(rpm) ? { rpm } : {}), ...(held(feedRate) ? { feedRate } : {}), ...(basket ? { basketId: basket.id, basketName: basket.name } : {}) };
  const context = {
    ...(held(dose) ? { targetDoseWeight: dose } : {}),
    ...(held(drink) ? { targetYield: drink } : {}),
    ...(held(grind) ? { grinderSetting: oldZero ? null : String(grind) } : {}),
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

/** The recipes README.md lists, as written, each built once so its global id stays. */
let RECIPE;
function buildRecipes() {
  const { bean, batch, grinders, adaptive, classic } = made;
  const at = (second) => `2026-11-22T10:00:0${second}.000Z`;
  const zero = { profile: classic, brewC: 93, dose: 19, drink: 38, grind: 0, grinder: grinders.base };
  RECIPE = {
    full: (slot) => serverRecord({ id: "1", name: NAMES.full, bean, batch, slot, profile: adaptive, brewC: 92, dose: 18, drink: 36, grind: 2.5, rpm: 1000, feedRate: "MF", grinder: grinders.base, basket: BASKET_RECORDS[0], capturedAt: at(1) }),
    zero: (slot) => serverRecord({ id: "2", name: NAMES.zero, slot, ...zero, capturedAt: at(2) }),
    oldZero: (slot) => serverRecord({ id: "3", name: NAMES.oldZero, slot, ...zero, oldZero: true, capturedAt: at(3) }),
    noGrind: (slot) => serverRecord({ id: "4", name: NAMES.noGrind, slot, ...zero, grind: undefined, capturedAt: at(4) }),
    zeroText: (slot) => serverRecord({ id: "5", name: NAMES.zeroText, slot, ...zero, grind: "0", capturedAt: at(5) }),
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
 * Streamline v0.2.31's main page in its own browser context, its DYE2 switch
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
 * 1 and 2. Applies. Recipes `1` (a grind setting of 2.5), `2` (0, "0" in its
 * embedded Workflow), `4` (none) and `5` (the text "0") seeded as the server
 * writes them; then, on DYE2's dashboard, each applied, with recipe `1`
 * between, so each apply changes the grind setting; recipe `2` opened in
 * DYE2's recipe editor and saved as it shows, and applied again; and the
 * same applies from Streamline's strip.
 */
async function recordApplies(browser) {
  log("applies, dashboard");
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const d = dashboard(r);
  const editor = recipeEditor(r);
  const dash = {};
  dash.seeded = await step(seed("full", "zero", "noGrind", "zeroText"));
  dash.applyFull = await step(() => d.apply(NAMES.full));
  dash.pills = await d.pills();
  dash.applyZero = await step(() => d.apply(NAMES.zero));
  dash.applyFullAgain = await step(() => d.apply(NAMES.full));
  dash.applyNoGrind = await step(() => d.apply(NAMES.noGrind));
  dash.applyZeroAgain = await step(() => d.apply(NAMES.zero));
  dash.applyZeroText = await step(() => d.apply(NAMES.zeroText));
  dash.applyFullThird = await step(() => d.apply(NAMES.full));
  dash.editorSavedZero = await step(async () => {
    const opened = await editor.open("2");
    const shown = await editor.shown();
    return [...opened, ...(await editor.save()), { shown }];
  });
  dash.applyFullFourth = await step(() => d.apply(NAMES.full));
  dash.applyZeroSaved = await step(() => d.apply(NAMES.zero));
  await r.context.close();

  log("applies, strip");
  const s = await streamlinePage(browser, "streamline");
  const strip = {};
  const tapped = (name) => async () => [...(await s.strip(name)), { tiles: await s.tiles() }];
  strip.seeded = await step(seed("full", "zero", "noGrind", "zeroText"));
  strip.started = await step(s.open(NAMES.full));
  strip.cells = await s.cells();
  strip.applyFull = await step(tapped(NAMES.full));
  strip.applyZero = await step(tapped(NAMES.zero));
  strip.applyFullAgain = await step(tapped(NAMES.full));
  strip.applyNoGrind = await step(tapped(NAMES.noGrind));
  strip.applyZeroAgain = await step(tapped(NAMES.zero));
  strip.applyZeroText = await step(tapped(NAMES.zeroText));
  await s.close();
  return { dash, strip };
}

/**
 * 3. DYE2's `record` with a grind setting of 0. Recipes `1` and `2` seeded;
 * recipe `1` applied from the dashboard; the Workflow's grind setting set to
 * "0" from the script, as a barista dials it; `record`; recipe `2` applied;
 * `record` with nothing moved; the grind setting written as the number 0;
 * `record`. Then recipe `1` written back and applied, `Fixture Grinder
 * Zero` picked on the dashboard's tabs, which brings its default of 0, and
 * `record`.
 */
async function recordRecord(browser) {
  log("record");
  const r = await recordedPage(browser, { keepRead: dye2Reads });
  const d = dashboard(r);
  const steps = {};
  steps.seeded = await step(seed("full", "zero"));
  steps.applyFull = await step(() => d.apply(NAMES.full));
  steps.dialledZero = await step(() => put({ context: { grinderSetting: "0" } }));
  steps.recordZero = await step(record);
  steps.applyZero = await step(() => d.apply(NAMES.zero));
  steps.recordUnmoved = await step(record);
  steps.dialledNumberZero = await step(() => put({ context: { grinderSetting: 0 } }));
  steps.recordNumberZero = await step(record);
  steps.reseeded = await step(seed("full", "zero"));
  steps.applyFullAgain = await step(() => d.apply(NAMES.full));
  steps.pickedZeroDefault = await step(async () => [...(await d.tab(GRINDERS.zeroDefault.model)), { tabs: await d.tabs() }]);
  steps.recordAfterPick = await step(record);
  await r.context.close();
  return steps;
}

/** DYE2 disabled and enabled again with Decaid's token, as an update of it loads it again, and its `changed` socket opened again. */
async function reloadDye2() {
  const exchanges = [await api("POST", "/plugins/dye2.reaplugin/disable", undefined, "launch")];
  await wait(1000);
  exchanges.push(await api("POST", "/plugins/dye2.reaplugin/enable", undefined, "launch"));
  await wait(2000);
  changed = listen("dye2.reaplugin", "changed");
  if ((await changed.opened) !== 101) throw new Error("DYE2's changed socket did not open again");
  return exchanges;
}

/**
 * 4. DYE2's repair as it loads. Recipes `1` and `3`, `3` saved at 0 as
 * DYE2 did before v0.1.42, none in its embedded Workflow, seeded; Streamline
 * opened; recipe `3` applied from its strip, which applies that Workflow;
 * recipe `1`; DYE2 loaded again (`reloaded`), which repairs `3`; loaded again
 * (`reloadedAgain`), with nothing to repair; Streamline opened again; and
 * recipe `3` applied from its strip once repaired, after `1`.
 */
async function recordRepair(browser) {
  log("repair");
  const steps = {};
  steps.seeded = await step(seed("full", "oldZero"));
  let s = await streamlinePage(browser, "streamline");
  const tapped = (name) => async () => [...(await s.strip(name)), { tiles: await s.tiles() }];
  steps.started = await step(s.open(NAMES.full));
  steps.applyOldZero = await step(tapped(NAMES.oldZero));
  steps.applyFull = await step(tapped(NAMES.full));
  await s.close();
  steps.reloaded = await step(reloadDye2, { settleMs: 5000 });
  steps.reloadedAgain = await step(reloadDye2, { settleMs: 5000 });
  s = await streamlinePage(browser, "streamline");
  steps.startedAgain = await step(s.open(NAMES.full));
  steps.applyFullAgain = await step(tapped(NAMES.full));
  steps.applyRepaired = await step(tapped(NAMES.oldZero));
  await s.close();
  return steps;
}

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
  recorder: { source: withoutSource(sourceTaken), enabled },
  bundledDye2,
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
  write("record.json", await recordRecord(browser));
  write("repair.json", await recordRepair(browser));
  write("library.json", library);
  write("keys.json", Object.fromEntries(await Promise.all(["recipes", "selection"].map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body]))));
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
