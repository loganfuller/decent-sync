// Records what DYE2 v0.1.32 changed from v0.1.26 in what it writes to Decaid
// v0.9.1, with Streamline `main` at cec5664, as README.md describes: drives
// their pages in headless Chromium and sends requests from Node, as the
// plugin would, keeping each exchange with Decaid's answer, the pushes heard
// on DYE2's `changed` socket and the Workflows Decaid sent plugins (heard
// through ../dye2-v0.1.26/workflow-recorder/). Run it once, from the
// repository root, against a Decaid whose data is new, still holding its
// bundled DYE2, with Streamline's files at cec5664 served at SKIN:
//
//   RESTART_DECAID=<command> node server/test/fixtures/decaid/dye2-v0.1.32/record.mjs <output dir>
//
// It installs the recorder and, once it has seeded DYE2's keys as Decent
// Sync's server and an earlier DYE2 left them, DYE2's latest release
// (v0.1.32) from GitHub. Its helpers are ../dye2-v0.1.26/record.mjs's.
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
const SAVE_RECIPE = "/plugins/dye2.reaplugin/save-recipe";
const STORE = "/store/dye2.reaplugin";
const STORED_SELECTION = `${STORE}/selection`;
const RECIPES = `${STORE}/recipes`;
const FAVOURITES = `${STORE}/autoFavourites`;
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
/** DYE2's one-time migrations, by their store flags: those v0.1.26 ran, then the two v0.1.32 adds. */
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
 * ../dye2-v0.1.26/record.mjs makes its own: in each file, in document order,
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

/**
 * DYE2 v0.1.32's `profileFingerprint` (dye2:dye2-plugin/src/utils/workflow-record.ts),
 * ported: title, tank temperature and steps but their temperatures, a limiter
 * of value 0 read as none, each step's keys in the order it holds them.
 */
function profileFingerprint(profile) {
  if (!profile) return null;
  const steps = Array.isArray(profile.steps)
    ? profile.steps.map(({ temperature, limiter, ...rest }) => ({ ...rest, limiter: limiter && Number(limiter.value) !== 0 ? limiter : null }))
    : profile.steps;
  return JSON.stringify({ title: profile.title, tank_temperature: profile.tank_temperature, steps });
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
const recipeNamed = async (name) => (await recipes()).find((recipe) => recipe && recipe.name === name);
const put = async (body) => [await api("PUT", "/workflow", body)];
const record = () => api("POST", RECORD);
/** A Workflow change from Node, then DYE2's `record`, as the plugin calls it after each change. */
const changeAndRecord = async (body) => [...(await put(body)), await record()];
/** The Ethiopia's batch put into the Workflow from Node, as a barista picking it would. */
const ethiopiaBatchSet = async () => {
  const ethiopia = await beanNamed("Fixture Ethiopia");
  return put({ context: { beanBatchId: (await batchOf(ethiopia)).id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } });
};

// ---- The library, and DYE2's keys as Decent Sync's server and an earlier DYE2 left them.

async function seedLibrary() {
  const ethiopia = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  const brazil = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Brazil", country: "Brazil", processing: "Natural" })).response.body;
  await api("POST", `/beans/${ethiopia.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 });
  await api("POST", `/beans/${brazil.id}/batches`, { roastDate: "2026-10-03T00:00:00.000", weight: 1000 });
  await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
}

/**
 * A recipe record as Decent Sync's server writes one (`recipeRecord` in
 * server/src/library/recipe-intake.ts) before #371: its fields at the paths
 * it writes, a blank barista and drinker, its embedded `workflow` with no
 * flags of DYE2's and, for a recipe naming no Bean, no coffee, roaster or
 * batch; with the record id and global id the plugin's write gives it.
 */
function serverRecord({ id, name, bean = null, slot, shown = true, profile, brewC, dose, drink, grind, grinder, capturedAt }) {
  const context = { targetDoseWeight: dose, targetYield: drink, grinderSetting: String(grind), grinderId: grinder.id, grinderModel: grinder.model };
  if (bean) Object.assign(context, { coffeeName: bean.name, coffeeRoaster: bean.roaster, beanBatchId: null });
  const embedded = jsonbOrder(profileAtBrewC(profile.profile, brewC));
  return {
    name,
    beverage: "",
    barista: "",
    drinker: "",
    ...(bean ? { beanId: bean.id, beanName: bean.name, beanRoaster: bean.roaster } : {}),
    profileId: profile.id,
    profileTitle: profile.profile.title,
    profileSnapshot: jsonbOrder(profile.profile),
    showOnStreamlineDashboard: shown,
    stripSlot: slot,
    dashboardVariables: { dose, drink, brewC, hotWaterMode: "vol", grind, grinderId: grinder.id, grinderModel: grinder.model, equipmentIds: [], equipmentNames: [], equipmentCustom: {} },
    title: name,
    subtitle: bean ? bean.name : "",
    workflow: { context, profile: embedded },
    id,
    capturedAt,
    decentSyncId: randomUUID(),
  };
}

/**
 * DYE2's keys and the Workflow as Decent Sync's server and DYE2 v0.1.26 left
 * them, written from Node, the bundled DYE2 having run its own migrations on
 * the empty store already: two baskets; recipes `1` (the Ethiopia, in slot
 * 1), `2` (no Bean, slot 2) and `3` (no Bean, in no slot), as the server
 * writes them; `4` (the Brazil), in slot 4 but hidden, as Streamline's
 * "Clear button" leaves a recipe the server wrote; and a recipe naming no
 * Bean with an opaque id, in no slot, as DYE2 v0.1.26's editor saved one; and
 * the Workflow on the Ethiopia's batch.
 */
async function seedServerStore() {
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const brazil = await beanNamed("Fixture Brazil");
  const grinder = await grinderNamed("Fixture Grinder 64");
  const adaptive = await profileTitled("Adaptive v3");
  const classic = await profileTitled("Classic Italian espresso");
  const baskets = [
    { name: "Fixture 18g Precision", size: "double", notes: "Fixture notes", diameterMm: 58.5, id: randomUUID(), createdAt: "2026-10-20T09:00:00.000Z" },
    { name: "Fixture 20g High-flow", size: "double", diameterMm: 58, id: randomUUID(), createdAt: "2026-10-20T09:00:01.000Z" },
  ];
  const one = serverRecord({ id: "1", name: "Fixture Ethiopia Espresso", bean: ethiopia, slot: 1, profile: adaptive, brewC: 92, dose: 18, drink: 36, grind: 2.5, grinder, capturedAt: "2026-10-26T10:00:01.000Z" });
  const two = serverRecord({ id: "2", name: "Fixture No Bean Espresso", slot: 2, profile: classic, brewC: 93, dose: 19, drink: 38, grind: 3, grinder, capturedAt: "2026-10-26T10:00:02.000Z" });
  const three = serverRecord({ id: "3", name: "Fixture No Bean Library", slot: null, profile: classic, brewC: 94, dose: 20, drink: 40, grind: 3.5, grinder, capturedAt: "2026-10-26T10:00:03.000Z" });
  const four = serverRecord({ id: "4", name: "Fixture Cleared Recipe", bean: brazil, slot: 4, shown: false, profile: classic, brewC: 93, dose: 18.5, drink: 37, grind: 2.8, grinder, capturedAt: "2026-10-26T10:00:04.000Z" });
  // As DYE2 v0.1.26's editor saved a recipe naming no bean: flags of the keys it set, and no coffee keys (`buildRecipeWorkflow` at v0.1.26).
  const editorSaved = {
    id: randomUUID(),
    stripSlot: null,
    name: "Fixture Editor No Bean",
    beverage: "",
    barista: "",
    drinker: "",
    profileId: classic.id,
    profileTitle: classic.profile.title,
    showOnStreamlineDashboard: true,
    capturedAt: "2026-10-26T10:00:05.000Z",
    dashboardVariables: { dose: 17, drink: 34, steamMode: "flow", hotWaterMode: "vol", grind: 2, grinderId: grinder.id, grinderModel: grinder.model, equipmentIds: [], equipmentNames: [], equipmentCustom: {} },
    title: "Fixture Editor No Bean",
    subtitle: "",
    workflow: {
      context: { targetDoseWeight: 17, targetYield: 34, grinderSetting: "2", grinderId: grinder.id, grinderModel: grinder.model, extras: { dye: { v: 1, grinderId: true, grinderModel: true } } },
      profile: classic.profile,
    },
  };
  const batch = await batchOf(ethiopia);
  return [
    await api("POST", `${STORE}/baskets`, baskets),
    await api("POST", RECIPES, [one, two, three, four, editorSaved]),
    await api("PUT", "/workflow", { context: { beanBatchId: batch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } }),
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
 * DYE2 v0.1.32 installed from its latest GitHub release over the bundled
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

/** DYE2's recipe editor on a recorded page: opening a recipe, its slot tabs, steppers, chips, its Streamline switch and Save. */
function recipeEditor(r) {
  const { page } = r;
  /** Opens the editor on a new recipe (`{ new: true }`) or on a recipe by id, as Streamline and Select Recipe open it, and gives what its form shows of the strip. */
  const open = async (target) => {
    await page.goto(DYE2(`recipe-edit?${target.new ? "new=1" : `id=${encodeURIComponent(target.id)}`}`));
    // initRecipeEdit reads the recipes and libraries before it renders.
    await page.waitForTimeout(2500);
    await r.take();
    return shown();
  };
  /** The tab the form targets and whether its "Show on Streamline Dashboard" switch is on. */
  const shown = () =>
    page.evaluate(() => ({
      activeTab: document.querySelector("#re-tabs .re-tab.active")?.getAttribute("data-slot") ?? null,
      showOnStreamline: document.getElementById("re-show-streamline-btn")?.classList.contains("on") ?? null,
    }));
  const tab = (slot) => page.locator(`#re-tabs .re-tab[data-slot="${slot}"]`).click();
  const toggle = () => page.locator("#re-show-streamline-btn").click();
  const stepper = async (prefix, value) => {
    await page.locator(`#${prefix}-value`).click();
    const input = page.locator(`#${prefix}-value input`);
    await input.fill(String(value));
    await input.press("Enter");
  };
  const chip = (list, name) => page.locator(`#${list}`).getByText(name, { exact: true }).click();
  /** Taps SAVE, and again if it asks to confirm replacing a slot's holder. */
  const save = async () => {
    const button = page.locator("#re-save-btn");
    await button.click();
    await page.waitForTimeout(300);
    if (/^REPLACE/.test((await button.textContent().catch(() => "")) ?? "")) await button.click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(2500);
  };
  return { open, shown, tab, toggle, stepper, chip, save };
}

/** Reads kept on DYE2's dashboard and Select Recipe: its selection, and the recipes it reads again before an apply. */
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
  /** Select Recipe: the recipe's card picked and confirmed, which the dashboard then applies as it opens. */
  const select = async (title) => {
    await r.page.goto(DYE2("select-recipe"));
    await r.page.waitForTimeout(2500);
    await r.page.locator(".dye-card:not(.dye-card-add)", { has: r.page.locator(".dye-card-name", { hasText: title }) }).click();
    await r.page.locator("#dye-confirm-btn").click();
    await r.page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(3000);
  };
  return { open, pills, pill, apply, select };
}

/**
 * DYE2's dashboard and Select Recipe applying a recipe naming a Bean, then
 * one naming none, each over a batch the Workflow holds; and a recipe applied
 * again after its record's profile changed (decentespresso/dye2#38), its
 * profile in the record in Decaid's key order and in `jsonb`'s.
 */
async function recordApplies(browser) {
  log("DYE2 applies");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply, select, open, pills } = dashboard(r);
  const steps = {};
  const all = { after: ["selection", "stored", "recipes", "workflow"] };
  const reads = { after: ["selection", "workflow"] };
  await open();
  steps.pillsShown = await pills();
  steps.batchSet = await step(ethiopiaBatchSet, reads);
  steps.applyWithBean = await step(() => apply("Fixture Ethiopia Espresso"), all);
  steps.batchSetAgain = await step(ethiopiaBatchSet, reads);
  steps.applyNoBean = await step(() => apply("Fixture No Bean Espresso"), all);
  steps.batchSetBeforeSelect = await step(ethiopiaBatchSet, reads);
  steps.selectNoBean = await step(() => select("Fixture No Bean Library"), all);

  // The Ethiopia's record rewritten from Node with its profile's first step at 6 s, as the plugin writes an edited Profile, then applied again.
  const adaptive = (await profileTitled("Adaptive v3")).profile;
  const classic = (await profileTitled("Classic Italian espresso")).profile;
  const rewrite = async (profileOf) => {
    const list = await recipes();
    return api(
      "POST",
      RECIPES,
      list.map((recipe) => (recipe?.id === "1" ? { ...recipe, profileSnapshot: profileOf(recipe.profileSnapshot), workflow: { ...recipe.workflow, profile: profileOf(recipe.workflow.profile) } } : recipe)),
    );
  };
  steps.applyBeforeProfileEdit = await step(() => apply("Fixture Ethiopia Espresso"), reads);
  steps.recordProfileEdited = await step(async () => [await rewrite((profile) => withFirstSeconds(profile, 6))], all);
  steps.reapplyEdited = await step(() => apply("Fixture Ethiopia Espresso"), all);
  // The same record in Decaid's key order, its profile's first step at 7 s, then the Workflow written that profile in Decaid's order with the same recipeId, as one PUT.
  const decaidOrder = withFirstSeconds(profileAtBrewC(adaptive, 92), 7);
  steps.recordInDecaidOrder = await step(async () => [await rewrite(() => decaidOrder)], reads);
  steps.ownProfileSameId = await step(() => put({ profile: decaidOrder, context: { extras: { dye: { recipeId: "1" } } } }), all);
  // Again with the record in jsonb's key order, as Decent Sync's server writes one, at 8 s.
  steps.applyBeforeJsonbOrder = await step(() => apply("Fixture Ethiopia Espresso"), reads);
  const jsonbProfile = withFirstSeconds(profileAtBrewC(adaptive, 92), 8);
  steps.recordInJsonbOrder = await step(async () => [await rewrite(() => jsonbOrder(jsonbProfile))], reads);
  steps.ownProfileJsonbOrderSameId = await step(() => put({ profile: jsonbProfile, context: { extras: { dye: { recipeId: "1" } } } }), all);
  // Another profile with the same recipeId.
  steps.applyBeforeOtherProfile = await step(() => apply("Fixture Ethiopia Espresso"), reads);
  steps.otherProfileSameId = await step(() => put({ profile: classic, context: { extras: { dye: { recipeId: "1" } } } }), all);
  await r.context.close();
  return steps;
}

/** DYE2's `record` of grind settings typed as text, and of a batch picked, a recipe naming no Bean applied on its dashboard. */
async function recordRecording(browser) {
  log("recording");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply } = dashboard(r);
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow"] };
  steps.select = await step(() => apply("Fixture No Bean Espresso"), reads);
  steps.grindText = await step(() => changeAndRecord({ context: { grinderSetting: "1.5." } }), reads);
  steps.grindWord = await step(() => changeAndRecord({ context: { grinderSetting: "fine" } }), reads);
  steps.grindNumber = await step(() => changeAndRecord({ context: { grinderSetting: "2.75" } }), reads);
  steps.batchPicked = await step(async () => [...(await ethiopiaBatchSet()), await record()], reads);
  await r.context.close();
  return steps;
}

/** DYE2's `save-recipe` from Node over a Workflow naming no Bean, as Streamline's long-press menu calls it, and with a beverage. */
async function recordSaveRecipe() {
  log("save-recipe");
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow"] };
  steps.beanCleared = await step(() => put({ context: { beanBatchId: null, coffeeName: null, coffeeRoaster: null } }), { after: ["workflow"] });
  steps.noBean = await step(async () => [await api("POST", SAVE_RECIPE, {})], reads);
  steps.withBeverage = await step(async () => [await api("POST", SAVE_RECIPE, { beverage: "Fixture Latte" })], reads);
  return steps;
}

/** Reads kept from Streamline: DYE2's selection, and its stored mirror of it. */
const streamlineReads = (route) => route === SELECTION || route === STORED_SELECTION;

/** Streamline's DYE strip with DYE2 v0.1.32: a recipe naming no Bean applied over a batch, and "Clear button". */
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
  /** Holds the pointer on a strip button past Streamline's long press, then picks a menu item. */
  const menu = async (button, label) => {
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    const items = page.locator(".context-menu__item");
    await items.first().waitFor();
    const labels = await items.allTextContents();
    await page.locator(".context-menu__item", { hasText: label }).first().click();
    return { menu: labels, exchanges: await r.take(3000) };
  };
  const cells = () => page.locator("#dye-strip button").evaluateAll((all) => all.map((button) => button.textContent.trim()));
  const all = { after: ["selection", "stored", "recipes", "workflow"] };
  const steps = {};
  steps.started = await step(async () => {
    await page.goto(`${SKIN}/`);
    return r.take(8000);
  }, { after: ["selection", "stored", "workflow"] });
  steps.cells = await cells();
  steps.batchSet = await step(ethiopiaBatchSet, { after: ["selection", "workflow"] });
  steps.applyNoBeanFromStrip = await step(() => strip("Fixture No Bean Espresso"), all);
  steps.applyWithBeanFromStrip = await step(() => strip("Fixture Ethiopia Espresso"), all);
  let shown;
  steps.clearButton = await step(async () => {
    shown = await menu(cell("Fixture Ethiopia Espresso"), "Clear button");
    return shown.exchanges;
  }, all);
  steps.clearButton.menu = shown.menu;
  steps.cellsAfterClear = await cells();
  await r.context.close();
  // DYE2's dashboard then: the pills it shows.
  const d = await recordedPage(browser, { keepRead: dashboardReads });
  const { open, pills } = dashboard(d);
  await open();
  steps.dashboardPillsAfterClear = await pills();
  await d.context.close();
  return steps;
}

/**
 * DYE2's recipe editor: a recipe "Clear button" hid opened and saved; the
 * switch turned off on a recipe in a slot; a slot targeted for a hidden one;
 * a new recipe naming no Bean; and grind settings typed as text.
 */
async function recordEditor(browser) {
  log("editor");
  const r = await recordedPage(browser);
  const { page } = r;
  const { open, shown, tab, toggle, stepper, chip, save } = recipeEditor(r);
  const steps = {};
  const at = async (id, edit) => {
    const opened = await open({ id });
    await edit();
    const form = await shown();
    return { opened, form, exchanges: await save() };
  };
  steps.saveCleared = await at("1", () => stepper("re-dose", 18.2));
  steps.saveHiddenInSlot = await at("4", () => stepper("re-dose", 18.8));
  steps.hideSlotted = await at("2", toggle);
  steps.slotHidden = await at("4", () => tab(4));
  steps.newWithoutBean = await (async () => {
    const opened = await open({ new: true });
    await tab(5);
    await page.locator("#re-name-input").fill("Fixture New No Bean");
    await chip("re-profile-chips", "Adaptive v3");
    await chip("re-grinder-chips", "Fixture Grinder 64");
    await stepper("re-dose", 18);
    await stepper("re-drink", 36);
    const form = await shown();
    return { opened, form, exchanges: await save() };
  })();
  steps.grindText = await at("3", () => stepper("re-grind", "1.5."));
  steps.grindWord = await at("3", () => stepper("re-grind", "fine"));
  steps.grindNumber = await at("3", () => stepper("re-grind", "2.75"));
  await r.context.close();
  return steps;
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

log("seeding DYE2's keys as Decent Sync's server and an earlier DYE2 left them");
const seeded = { exchanges: await seedServerStore() };
await wait(1000);
Object.assign(seeded, await snapshot());
log("installing DYE2's latest release");
changed.socket.close();
const install = await recordInstall();
if (!install.listed.some((plugin) => plugin.version === "0.1.32" && plugin.loaded)) throw new Error(`DYE2 v0.1.32 is not loaded: ${JSON.stringify(install.listed)}`);
await openChanged();
write("loading.json", { seeded, install });
write("plugins.json", { installed: install.exchanges[0], listed: await plugins() });

const browser = await chromium.launch();
try {
  write("applies.json", await recordApplies(browser));
  write("streamline.json", await recordStreamline(browser));
  write("recording.json", await recordRecording(browser));
  write("save-recipe.json", await recordSaveRecipe());
  write("editor.json", await recordEditor(browser));
  write("library.json", { ...library, recipes: await recipes() });
  write("keys.json", await keys());
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
