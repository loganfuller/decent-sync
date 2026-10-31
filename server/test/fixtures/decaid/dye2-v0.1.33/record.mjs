// Records what DYE2 v0.1.33 and Streamline v0.2.21 changed from DYE2 v0.1.32
// and Streamline `main` at cec5664 in what they write to Decaid v0.9.1, as
// README.md describes: drives their pages in headless Chromium and sends
// requests from Node, as the plugin would, keeping each exchange with
// Decaid's answer, the pushes heard on DYE2's `changed` socket and the
// Workflows Decaid sent plugins (heard through
// ../dye2-v0.1.26/workflow-recorder/). Run it once, from the repository root,
// against a Decaid whose data is new, still holding its bundled DYE2, with
// Streamline v0.2.21's files served at SKIN:
//
//   node server/test/fixtures/decaid/dye2-v0.1.33/record.mjs <output dir>
//
// It installs the recorder and, once it has seeded DYE2's keys as Decent
// Sync's server leaves them, DYE2's latest release (v0.1.33) from GitHub, and
// last Streamline's `dist` deploy of v0.2.21 by URL. Its helpers are
// ../dye2-v0.1.32/record.mjs's.
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
/** Streamline's `dist` deploy of the v0.2.21 tag, `c568255`, as the owner's tablets run it. */
const STREAMLINE_DIST = "https://github.com/decentespresso/streamline-js/archive/aa45652639f4c2715b72a47d4169a8d1e15adec1.zip";
/** Time for DYE2 to follow a Workflow change (its recipeId check, its mirror and push), and a margin. */
const SETTLE_MS = 2500;
/** The routes whose requests a page sends that are kept: DYE2's routes and keys, Streamline's remembered values, the Workflow and single Shots. */
const KEPT = [
  /^\/plugins\/dye2\.reaplugin\/(selection|record|save-recipe)$/,
  /^\/store\/dye2\.reaplugin\/(recipes|baskets|equipment|selection|autoFavourites)$/,
  /^\/store\/streamline-app\/[^/]+$/,
  /^\/workflow$/,
  /^\/shots\/[^/?]+$/,
];
/** DYE2's one-time migrations, by their store flags: v0.1.33 adds none to v0.1.32's. */
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
 * ../dye2-v0.1.32/record.mjs makes its own: in each file, in document order,
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

/** A profile with its first step lasting `seconds`, as an edit of the Profile changes it: a field of every step, which Decaid keeps. */
const withFirstSeconds = (profile, seconds) => profile && { ...profile, steps: profile.steps.map((s, i) => (i === 0 ? { ...s, seconds } : s)) };

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

/**
 * A recipe record as Decent Sync's server writes one (`recipeRecord` in
 * server/src/library/recipe-intake.ts, since #371): its fields at the paths
 * it writes, a blank barista and drinker, shown exactly while in a slot, its
 * embedded `workflow` with no flags of DYE2's, explicit nulls for a Bean it
 * names none of, and its Basket where it holds one, a profile in `jsonb`'s
 * key order; with the record id and global id the plugin's write gives it.
 */
function serverRecord({ id, name, bean = null, batch = null, slot, profile, brewC, dose, drink, grind, grinder, basket = null, capturedAt }) {
  const extras = basket ? { basketId: basket.id, basketName: basket.name } : null;
  const context = {
    targetDoseWeight: dose,
    targetYield: drink,
    grinderSetting: String(grind),
    grinderId: grinder.id,
    grinderModel: grinder.model,
    ...(extras ? { extras } : {}),
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
      hotWaterMode: "vol",
      grind,
      grinderId: grinder.id,
      grinderModel: grinder.model,
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

/**
 * DYE2's keys and the Workflow as Decent Sync's server leaves them, written
 * from Node, the bundled DYE2 having run its own migrations on the empty
 * store already: two baskets; recipes `1` (the Ethiopia and its batch,
 * `Adaptive v3`, in slot 1), `2` (no Bean, `Classic Italian espresso`, slot
 * 2), `3` (no Bean, `Classic Italian espresso`, in no slot) and `4` (the
 * Ethiopia, `Classic Italian espresso`, holding the first Basket, slot 4),
 * none but `4` holding a Basket; and the Workflow on the Ethiopia's batch,
 * with no Basket.
 */
async function seedServerStore() {
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const batch = await batchOf(ethiopia);
  const grinder = await grinderNamed("Fixture Grinder 64");
  const adaptive = await profileTitled("Adaptive v3");
  const classic = await profileTitled("Classic Italian espresso");
  const baskets = [
    { name: "Fixture 18g Precision", size: "double", notes: "Fixture notes", diameterMm: 58.5, id: randomUUID(), createdAt: "2026-10-30T09:00:00.000Z" },
    { name: "Fixture 20g High-flow", size: "double", diameterMm: 58, id: randomUUID(), createdAt: "2026-10-30T09:00:01.000Z" },
  ];
  const one = serverRecord({ id: "1", name: "Fixture Ethiopia Espresso", bean: ethiopia, batch, slot: 1, profile: adaptive, brewC: 92, dose: 18, drink: 36, grind: 2.5, grinder, capturedAt: "2026-10-30T10:00:01.000Z" });
  const two = serverRecord({ id: "2", name: "Fixture No Bean Espresso", slot: 2, profile: classic, brewC: 93, dose: 19, drink: 38, grind: 3, grinder, capturedAt: "2026-10-30T10:00:02.000Z" });
  const three = serverRecord({ id: "3", name: "Fixture No Bean Library", slot: null, profile: classic, brewC: 94, dose: 20, drink: 40, grind: 3.5, grinder, capturedAt: "2026-10-30T10:00:03.000Z" });
  const four = serverRecord({ id: "4", name: "Fixture Basket Espresso", bean: ethiopia, batch, slot: 4, profile: classic, brewC: 93, dose: 18.5, drink: 37, grind: 2.8, grinder, basket: baskets[0], capturedAt: "2026-10-30T10:00:04.000Z" });
  return [
    await api("POST", `${STORE}/baskets`, baskets),
    await api("POST", RECIPES, [one, two, three, four]),
    await api("PUT", "/workflow", { context: { beanBatchId: batch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster, extras: { basketId: null, basketName: null } } }),
  ];
}

/** DYE2's keys and the Workflow, read at once. */
async function snapshot() {
  const listed = await api("GET", STORE);
  const keys = Array.isArray(listed.response.body) ? listed.response.body : [];
  const values = {};
  for (const key of keys) values[key] = (await api("GET", `${STORE}/${key}`)).response.body;
  return { keys: listed, values, workflow: await workflow() };
}

/**
 * DYE2 v0.1.33 installed from its latest GitHub release over the bundled
 * DYE2, its first load, on the keys seeded: the install's exchange, then
 * DYE2's keys and the Workflow read as it installs, over 6 s, and the
 * Workflows plugins were sent meanwhile.
 */
async function recordInstall() {
  const eventMark = recorder.heard.length;
  const started = Date.now();
  let answeredAtMs;
  const installing = api("POST", "/plugins/install/github-release", { repo: "decentespresso/dye2" }).then((exchange) => {
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

/** Reads kept on DYE2's dashboard, Select Recipe and basket picker: its selection, and the recipes it reads again before an apply. */
const dashboardReads = (route) => route === SELECTION || route === RECIPES;

/** DYE2's dashboard on a recorded page: opened afresh, and a recipe's pill tapped. */
function dashboard(r) {
  const open = async () => {
    await r.page.goto(DYE2("dashboard"));
    await r.take(3000);
  };
  const pills = () => r.page.locator("#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)").evaluateAll((all) => all.map((pill) => pill.getAttribute("title")));
  const pill = async (title) => {
    await r.page.locator(`#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)[title="${title}"]`).first().click();
    return r.take(1500);
  };
  /** Opens the dashboard and taps a pill, giving the tap's exchanges. */
  const apply = async (title) => {
    await open();
    return pill(title);
  };
  /** DYE2's basket picker, as the dashboard's Basket field opens it: a basket's card picked and confirmed. */
  const pickBasket = async (name) => {
    await r.page.goto(DYE2("basket-picker"));
    await r.page.waitForTimeout(2500);
    await r.take();
    await r.page.locator(".dye-card:not(.dye-card-add)", { has: r.page.locator(".dye-card-name", { hasText: name }) }).click();
    await r.page.locator("#dye-confirm-btn").click();
    await r.page.waitForURL(/dashboard/, { waitUntil: "commit" }).catch(() => {});
    return r.take(3000);
  };
  return { open, pills, pill, apply, pickBasket };
}

/**
 * decentespresso/dye2#43: DYE2's dashboard applying a recipe whose record
 * holds its profile in `jsonb`'s key order, as Decent Sync's server writes
 * one, again after that profile changed; the Workflow written the record's
 * profile with the same `recipeId` in one PUT, as the plugin's load writes
 * it; and another profile written so.
 */
async function recordApplies(browser) {
  log("DYE2 applies");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply } = dashboard(r);
  const steps = {};
  const all = { after: ["selection", "stored", "recipes", "workflow"] };
  const reads = { after: ["selection", "workflow"] };
  const adaptive = (await profileTitled("Adaptive v3")).profile;
  const classic = (await profileTitled("Classic Italian espresso")).profile;
  /** The Ethiopia's record rewritten from Node with its profile so, in `jsonb`'s key order, as the plugin writes an edited Profile. */
  const rewrite = async (profile) => {
    const list = await recipes();
    const ordered = jsonbOrder(profile);
    return api("POST", RECIPES, list.map((recipe) => (recipe?.id === "1" ? { ...recipe, profileSnapshot: ordered, workflow: { ...recipe.workflow, profile: ordered } } : recipe)));
  };
  steps.applyBeforeProfileEdit = await step(() => apply("Fixture Ethiopia Espresso"), all);
  steps.recordProfileEdited = await step(async () => [await rewrite(withFirstSeconds(profileAtBrewC(adaptive, 92), 6))], all);
  steps.reapplyEdited = await step(() => apply("Fixture Ethiopia Espresso"), all);
  steps.recordProfileEditedAgain = await step(async () => [await rewrite(withFirstSeconds(profileAtBrewC(adaptive, 92), 8))], reads);
  // The record's profile, in Decaid's key order, written into the Workflow with the same recipeId, as one PUT.
  steps.ownProfileSameId = await step(() => put({ profile: withFirstSeconds(profileAtBrewC(adaptive, 92), 8), context: { extras: { dye: { recipeId: "1" } } } }), all);
  steps.otherProfileSameId = await step(() => put({ profile: classic, context: { extras: { dye: { recipeId: "1" } } } }), all);
  await r.context.close();
  return steps;
}

/**
 * DYE2's `record` of a Basket (`163a7c8`): a recipe holding none applied
 * over a Workflow holding none, a Basket picked on DYE2's basket picker, and
 * `record`; a recipe holding none applied over a Workflow holding a Basket,
 * `record` with it unmoved, another picked and `record`; the Basket cleared
 * from Node, as the dashboard's Clear writes it, and `record`; and a recipe
 * holding one, another picked and `record`.
 */
async function recordBaskets(browser) {
  log("baskets");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply, pickBasket } = dashboard(r);
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow"] };
  const recorded = async () => [await record()];
  steps.applyNoBasket = await step(() => apply("Fixture No Bean Espresso"), reads);
  steps.basketPicked = await step(() => pickBasket("Fixture 18g Precision"), reads);
  steps.recordPicked = await step(recorded, reads);
  steps.applyOverBasket = await step(() => apply("Fixture Ethiopia Espresso"), reads);
  steps.recordUnmoved = await step(recorded, reads);
  steps.basketPickedAgain = await step(() => pickBasket("Fixture 20g High-flow"), reads);
  steps.recordMoved = await step(recorded, reads);
  steps.basketCleared = await step(() => put({ context: { extras: { basketId: null, basketName: null } } }), reads);
  steps.recordCleared = await step(recorded, reads);
  steps.applyHolding = await step(() => apply("Fixture Basket Espresso"), reads);
  steps.basketPickedOnHolding = await step(() => pickBasket("Fixture 20g High-flow"), reads);
  steps.recordOnHolding = await step(recorded, reads);
  await r.context.close();
  return steps;
}

/** Reads kept from Streamline: DYE2's selection, and its stored mirror of it. */
const streamlineReads = (route) => route === SELECTION || route === STORED_SELECTION;

/**
 * Streamline v0.2.21's DYE strip with DYE2 v0.1.33: a recipe applied, its
 * highlighted cell tapped again, the long-press menus of a filled cell and
 * an empty one, and "Replace <name>", which opens DYE2's Select Recipe to
 * assign a recipe to that button, a library recipe picked and assigned.
 */
async function recordStreamline(browser) {
  log("Streamline");
  const r = await recordedPage(browser, { viewport: { width: 1920, height: 1200 }, keepRead: streamlineReads });
  const { page } = r;
  await r.context.addInitScript(() => {
    localStorage.setItem("streamline.dye2Enabled", "true");
    localStorage.setItem("streamline.dyeStripMode", "R");
    localStorage.setItem("streamlineHelpHidden", "1");
  });
  const cell = (title) => page.locator("#dye-strip button", { hasText: title }).first();
  const strip = async (title) => {
    await cell(title).click();
    return r.take(3000);
  };
  /** Holds the pointer on a strip button past Streamline's long press, and gives the menu's labels, then picks one where `label` names it. */
  const menu = async (button, label) => {
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    const items = page.locator(".context-menu__item");
    await items.first().waitFor();
    const labels = await items.allTextContents();
    if (label) await page.locator(".context-menu__item", { hasText: label }).first().click();
    else await page.keyboard.press("Escape");
    return labels;
  };
  const cells = () => page.locator("#dye-strip button").evaluateAll((all) => all.map((button) => button.textContent.trim()));
  const all = { after: ["selection", "stored", "recipes", "workflow"] };
  const steps = {};
  const start = async () => {
    await page.goto(`${SKIN}/`);
    return r.take(8000);
  };
  steps.started = await step(start, { after: ["selection", "stored", "workflow"] });
  steps.cells = await cells();
  steps.applyFromStrip = await step(() => strip("Fixture No Bean Espresso"), all);
  steps.tapHighlighted = await step(() => strip("Fixture No Bean Espresso"), all);
  steps.filledMenu = await menu(cell("Fixture Ethiopia Espresso"));
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(5, 5);
  await page.waitForTimeout(500);
  const blank = page.locator("#dye-strip button").nth(2);
  steps.emptyMenu = await menu(blank);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(500);
  let opened;
  let confirmLabel;
  steps.replace = await step(async () => {
    await menu(cell("Fixture Basket Espresso"), "Replace");
    await page.waitForURL(/select-recipe/, { waitUntil: "load" });
    opened = page.url().replace(DECAID, "").replace(SKIN, "<skin>");
    await page.waitForTimeout(2500);
    const before = await r.take();
    const card = page.locator(".dye-card:not(.dye-card-add)", { has: page.locator(".dye-card-name", { hasText: "Fixture No Bean Library" }) });
    await card.click();
    const confirm = page.locator("#dye-confirm-btn");
    confirmLabel = (await confirm.textContent())?.trim();
    await confirm.click();
    await page.waitForURL((url) => url.href.startsWith(SKIN), { waitUntil: "load" });
    return [...before, ...(await r.take(8000))];
  }, all);
  steps.replace.opened = opened;
  steps.replace.confirmLabel = confirmLabel;
  steps.cellsAfterReplace = await cells();
  await r.context.close();
  return steps;
}

/** Streamline's `dist` deploy of v0.2.21 installed by URL, as on the owner's tablets, and the Skins Decaid then lists. */
async function recordSkins() {
  log("skins");
  const installed = await api("POST", "/webui/skins/install/url", { url: STREAMLINE_DIST });
  await wait(2000);
  return { installed, skins: await api("GET", "/webui/skins") };
}

const keys = async () => Object.fromEntries(await Promise.all(["recipes", "baskets", "selection", ...MIGRATION_FLAGS].map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body])));

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
log("installing DYE2's latest release");
changed.socket.close();
const install = await recordInstall();
if (!install.listed.some((plugin) => plugin.version === "0.1.33" && plugin.loaded)) throw new Error(`DYE2 v0.1.33 is not loaded: ${JSON.stringify(install.listed)}`);
await openChanged();
write("loading.json", { seeded, install });
write("plugins.json", { installed: install.exchanges[0], listed: await plugins() });

const browser = await chromium.launch();
try {
  write("applies.json", await recordApplies(browser));
  write("baskets.json", await recordBaskets(browser));
  write("streamline.json", await recordStreamline(browser));
  write("library.json", { ...library, recipes: await recipes() });
  write("keys.json", await keys());
  write("skins.json", await recordSkins());
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
