// Records what DYE2 v0.1.26 and Streamline `main` at cec5664 write to Decaid
// v0.9.0, as README.md describes: drives their pages in headless Chromium and
// sends requests from Node, as the plugin would, keeping each exchange with
// Decaid's answer, the pushes heard on DYE2's `changed` socket and the
// Workflows Decaid sent plugins (heard through workflow-recorder/, beside this
// script). Run it once, from the repository root, against a Decaid whose data
// is new, still holding its bundled DYE2, with Streamline's files at cec5664
// served at SKIN:
//
//   RESTART_DECAID=<command> node server/test/fixtures/decaid/dye2-v0.1.26/record.mjs <output dir>
//
// It installs the recorder and, once it has seeded DYE2's keys as an earlier
// DYE2 left them, DYE2's latest release (v0.1.26) from GitHub.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const SKIN = process.env.SKIN ?? "http://localhost:13999";
const SOCKETS = DECAID.replace(/^http/, "ws");
const HERE = path.dirname(fileURLToPath(import.meta.url));
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
const log = (message) => console.log(new Date().toISOString(), message);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const out = process.argv[2];
if (!out) throw new Error("Usage: record.mjs <output dir> [--compact]");
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

/** Files whose profiles stay whole: the fingerprint and restart-check evidence. */
const WHOLE_PROFILES = new Set(["fingerprints.json", "restart.json", "library.json"]);
const isProfile = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.title === "string" && Array.isArray(value.steps) && "tank_temperature" in value;

/**
 * The recordings made smaller, once every file is written: in each file, in
 * document order, a read of DYE2's `recipes`, of `/workflow`, or of one of
 * DYE2's keys in `loading.json`'s snapshots, whose answer is the same as the
 * last one read or posted before it in that file, keeps its status and
 * `unchanged: true` in place of its body; and outside `WHOLE_PROFILES`, each
 * whole profile is `{"$profile": "<title>/<hash>"}`, one copy of each kept in
 * `library.json`'s `profileCopies`.
 */
function compactAll(dir) {
  // store.json is the store's own answers, kept as they are.
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "store.json");
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
    let value = walk(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
    if (!WHOLE_PROFILES.has(file)) value = byRef(value);
    fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2) + "\n");
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
 * DYE2 v0.1.26's `profileFingerprint` (dye2:dye2-plugin/src/utils/workflow-record.ts),
 * ported: title, tank temperature and steps but their temperatures, a limiter
 * of value 0 read as none.
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

/** A socket that hears nothing, until DYE2 v0.1.26 (which has a `changed` endpoint) is installed. */
let changed = { heard: [], closed: true, socket: { close() {} } };
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
 * recipes, its keys, the Workflow, the machine's settings), the pushes heard
 * on `changed` meanwhile, the context of each Workflow Decaid sent plugins in
 * a `workflowUpdated` (`events`), and when each push and event came, in ms
 * from the step's start (`timing`).
 */
async function step(act, { after = ["selection", "recipes"], settleMs = SETTLE_MS } = {}) {
  const mark = changed.heard.length;
  const eventMark = recorder.heard.length;
  const changedNow = changed;
  const recorderNow = recorder;
  const started = Date.now();
  const exchanges = await act();
  await wait(settleMs);
  const reads = [];
  if (after.includes("selection")) reads.push(await api("GET", SELECTION));
  if (after.includes("stored")) reads.push(await api("GET", STORED_SELECTION));
  if (after.includes("recipes")) reads.push(await api("GET", RECIPES));
  if (after.includes("keys")) reads.push(await api("GET", STORE));
  if (after.includes("workflow")) reads.push(await api("GET", "/workflow"));
  if (after.includes("machine")) reads.push(await api("GET", "/machine/settings"));
  // A restart in the step opens new sockets; what they heard is all the step's.
  const pushes = (changedNow === changed ? changed.heard.slice(mark) : changed.heard).filter(({ at }) => at >= started);
  const events = (recorderNow === recorder ? recorder.heard.slice(eventMark) : recorder.heard).filter(({ at }) => at >= started);
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
const basketNamed = async (name) => (await api("GET", `${STORE}/baskets`)).response.body.find((candidate) => candidate.name === name);
const recipes = async () => (await api("GET", RECIPES)).response.body ?? [];
const recipeNamed = async (name) => (await recipes()).find((recipe) => recipe && recipe.name === name);
const put = async (body) => [await api("PUT", "/workflow", body)];
const record = () => api("POST", RECORD);
/** A Workflow change from Node, then DYE2's `record`, as the plugin calls it after each change. */
const changeAndRecord = async (body) => [...(await put(body)), await record()];

/**
 * Restarts Decaid, keeping its data, with the command RESTART_DECAID names,
 * and opens the sockets again: the earlier recordings found its simulated
 * machine storing only the first Shot pulled after it started (on v0.8.7).
 * Resolves once DYE2 has loaded.
 */
async function restartDecaid() {
  if (!process.env.RESTART_DECAID) throw new Error("RESTART_DECAID is not set");
  log("restarting Decaid");
  changed.socket.close();
  recorder.socket.close();
  execFileSync(process.env.RESTART_DECAID, { stdio: "inherit" });
  for (let waited = 0; !(await plugins().catch(() => [])).some((plugin) => plugin.loaded); waited++) {
    if (waited > 90) throw new Error("DYE2 did not load");
    await wait(1000);
  }
  await wait(3000);
  await openChanged();
  recorder = listen("workflow-recorder.reaplugin", "workflow");
  if ((await recorder.opened) !== 101) throw new Error("The recorder's socket did not open");
  await wait(2000);
}

/** DYE2 disabled and enabled, as on an update, with the sockets opened again; the exchanges. */
async function reloadDye2() {
  const exchanges = [await api("POST", "/plugins/dye2.reaplugin/disable"), await api("POST", "/plugins/dye2.reaplugin/enable")];
  await wait(500);
  if (changed.closed) await openChanged();
  return exchanges;
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

// ---- The library, and DYE2's keys as an earlier DYE2 left them.

async function seedLibrary() {
  const ethiopia = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Ethiopia", country: "Ethiopia", processing: "Washed" })).response.body;
  const brazil = (await api("POST", "/beans", { roaster: "Fixture Roasters", name: "Fixture Brazil", country: "Brazil", processing: "Natural" })).response.body;
  await api("POST", `/beans/${ethiopia.id}/batches`, { roastDate: "2026-10-01T00:00:00.000", weight: 1000 });
  await api("POST", `/beans/${brazil.id}/batches`, { roastDate: "2026-10-03T00:00:00.000", weight: 1000 });
  await api("POST", "/grinders", { model: "Fixture Grinder 64", burrs: "Fixture 64mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
  // A second grinder, for a switch of grinder while a recipe is applied.
  await api("POST", "/grinders", { model: "Fixture Grinder 83", burrs: "Fixture 83mm flat", settingType: "numeric", settingSmallStep: 0.5, settingBigStep: 1, rpmSmallStep: 50, rpmBigStep: 100 });
}

/** Decaid's store answering a key never written, a POST, a read, a DELETE and a DELETE of a key it no longer holds. */
async function recordStore() {
  return [await api("GET", RECIPES), await api("POST", RECIPES, []), await api("GET", RECIPES), await api("DELETE", RECIPES), await api("GET", RECIPES), await api("DELETE", RECIPES)];
}

/**
 * DYE2's keys and the Workflow as DYE2 before v0.1.25 left them, written from
 * Node in the shapes the 2cf631c recording found: two baskets; recipes `1`,
 * `2` and `3` with no `stripSlot`; `4` with none and an older `capturedAt`
 * than a recipe with an opaque id holding `stripSlot` 4, as a v0.1.25 editor
 * saves one; a `suggested` row; the stored selection of recipe `2`, armed;
 * and the Workflow with recipe `2` applied and `context.extras.dye.selection`
 * naming it.
 */
async function seedLegacyStore() {
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const brazil = await beanNamed("Fixture Brazil");
  const grinder = await grinderNamed("Fixture Grinder 64");
  const adaptive = await profileTitled("Adaptive v3");
  const classic = (await profileTitled("Classic Italian espresso")).profile;
  const baskets = [
    { name: "Fixture 18g Precision", size: "double", notes: "Fixture notes", diameterMm: 58.5, id: randomUUID(), createdAt: "2026-10-20T09:00:00.000Z" },
    { name: "Fixture 20g High-flow", size: "double", diameterMm: 58, id: randomUUID(), createdAt: "2026-10-20T09:00:01.000Z" },
  ];
  const [precision, highFlow] = baskets;
  const grinderFields = { grinderId: grinder.id, grinderModel: grinder.model };
  const flags = (keys) => ({ v: 1, ...Object.fromEntries(keys.map((key) => [key, key === "beanBatchId" ? null : true])) });
  const one = {
    name: "Fixture Ethiopia Espresso",
    beverage: "Fixture Flat White",
    barista: "Fixture Barista",
    drinker: "Fixture Drinker",
    beanId: ethiopia.id,
    beanName: ethiopia.name,
    beanRoaster: ethiopia.roaster,
    profileId: adaptive.id,
    profileTitle: "Adaptive v3",
    showOnStreamlineDashboard: true,
    id: "1",
    capturedAt: "2026-10-20T10:00:01.000Z",
    dashboardVariables: { dose: 18, drink: 36, brewC: 92, steamMode: "time", steamTimeS: 30, flushS: 5, hotWaterMode: "temp", hotWaterTempC: 85, grind: 2.5, rpm: 900, ...grinderFields, basketId: precision.id, basketName: precision.name, equipmentIds: [], equipmentNames: [], equipmentCustom: {} },
    title: "Fixture Ethiopia Espresso",
    subtitle: ethiopia.name,
    workflow: {
      context: {
        targetDoseWeight: 18,
        targetYield: 36,
        grinderSetting: "2.5",
        extras: { rpm: 900, basketId: precision.id, basketName: precision.name, dye: flags(["beanBatchId", "coffeeName", "coffeeRoaster", "grinderId", "grinderModel", "baristaName", "drinkerName", "basketId", "basketName", "rpm"]) },
        ...grinderFields,
        coffeeName: ethiopia.name,
        coffeeRoaster: ethiopia.roaster,
        beanBatchId: null,
        baristaName: "Fixture Barista",
        drinkerName: "Fixture Drinker",
      },
      profile: profileAtBrewC(adaptive.profile, 92),
      steamSettings: { duration: 30 },
      hotWaterData: { targetTemperature: 85 },
      rinseData: { duration: 5 },
    },
  };
  const two = {
    name: "Fixture Brazil Espresso",
    beverage: "",
    barista: "",
    drinker: "",
    beanId: brazil.id,
    beanName: brazil.name,
    beanRoaster: brazil.roaster,
    profileTitle: "Classic Italian espresso",
    profileSnapshot: classic,
    showOnStreamlineDashboard: true,
    id: "2",
    capturedAt: "2026-10-20T10:00:02.000Z",
    dashboardVariables: { dose: 19, drink: 36, steamMode: "flow", steamFlowMls: 1.2, flushS: 4, hotWaterMode: "vol", hotWaterMl: 150, grind: 3, rpm: 1100, ...grinderFields, basketId: highFlow.id, basketName: highFlow.name, equipmentIds: [], equipmentNames: [], equipmentCustom: {} },
    title: "Fixture Brazil Espresso",
    subtitle: brazil.name,
    workflow: {
      context: {
        targetDoseWeight: 19,
        targetYield: 36,
        grinderSetting: "3",
        extras: { rpm: 1100, basketId: highFlow.id, basketName: highFlow.name, dye: flags(["beanBatchId", "coffeeName", "coffeeRoaster", "grinderId", "grinderModel", "basketId", "basketName", "rpm"]) },
        ...grinderFields,
        coffeeName: brazil.name,
        coffeeRoaster: brazil.roaster,
        beanBatchId: null,
      },
      profile: classic,
      steamSettings: { flow: 1.2 },
      hotWaterData: { volume: 150 },
      rinseData: { duration: 4 },
    },
  };
  const three = {
    name: "Fixture Blank Recipe",
    beverage: "",
    barista: "",
    drinker: "",
    showOnStreamlineDashboard: true,
    id: "3",
    capturedAt: "2026-10-20T10:00:03.000Z",
    dashboardVariables: { steamMode: "flow", hotWaterMode: "vol", equipmentIds: [], equipmentNames: [], equipmentCustom: {} },
    title: "Fixture Blank Recipe",
    subtitle: "",
    workflow: { context: {} },
  };
  const small = (id, name, bean, capturedAt, dose, extra = {}) => ({
    name,
    beverage: "",
    barista: "",
    drinker: "",
    beanId: bean.id,
    beanName: bean.name,
    beanRoaster: bean.roaster,
    profileTitle: "Classic Italian espresso",
    profileSnapshot: classic,
    showOnStreamlineDashboard: true,
    id,
    ...extra,
    capturedAt,
    dashboardVariables: { dose, drink: 40, steamMode: "flow", hotWaterMode: "vol", equipmentIds: [], equipmentNames: [], equipmentCustom: {} },
    title: name,
    subtitle: bean.name,
    workflow: {
      context: { targetDoseWeight: dose, targetYield: 40, coffeeName: bean.name, coffeeRoaster: bean.roaster, beanBatchId: null, extras: { dye: flags(["beanBatchId", "coffeeName", "coffeeRoaster"]) } },
      profile: classic,
    },
  });
  const four = small("4", "Fixture Old Slot 4 Recipe", ethiopia, "2026-10-01T10:00:04.000Z", 18);
  const newerFour = small(randomUUID(), "Fixture Newer Slot 4 Recipe", brazil, "2026-10-22T10:00:05.000Z", 20, { stripSlot: 4 });
  const suggested = { ...small("sug-fixture", "Fixture Suggested Espresso", ethiopia, "2026-10-20T10:00:06.000Z", 17, { stripSlot: 5 }), suggested: true };
  const list = [one, two, three, four, newerFour, suggested];
  const machine = (await workflow()) ?? {};
  const stored = {
    kind: "recipe",
    id: "2",
    profileFingerprint: profileFingerprint(classic),
    armedBrewC: classic.steps[0].temperature,
    armedBeanBatchId: "",
    armedGrinderId: grinder.id,
    armedMachine: { steamTempC: machine.steamSettings.targetTemperature, steamFlowMls: 1.2, hotWaterMl: 150, flushS: 4 },
  };
  const applied = {
    context: { ...two.workflow.context, extras: { ...two.workflow.context.extras, dye: { ...two.workflow.context.extras.dye, selection: { kind: "recipe", id: "2" } } } },
    profile: classic,
    steamSettings: { flow: 1.2 },
    hotWaterData: { volume: 150 },
    rinseData: { duration: 4 },
  };
  return [
    await api("POST", `${STORE}/baskets`, baskets),
    await api("POST", RECIPES, list),
    await api("POST", STORED_SELECTION, stored),
    await api("PUT", "/workflow", applied),
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
 * DYE2 v0.1.26 installed from its latest GitHub release over the bundled
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
  for (const at of [0, 250, 500, 750, 1000, 1250, 1500, 2000, 3000, 6000]) {
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

/** DYE2's recipe editor on a recorded page: opening a recipe, its slot tabs, steppers, chips and Save. */
function recipeEditor(r) {
  const { page } = r;
  /** Opens the editor on a new recipe (`{ new: true }`) or on a recipe by id, as Streamline and Select Recipe open it. */
  const open = async (target) => {
    await page.goto(DYE2(`recipe-edit?${target.new ? "new=1" : `id=${encodeURIComponent(target.id)}`}`));
    // initRecipeEdit reads the recipes and libraries before it renders.
    await page.waitForTimeout(2500);
    await r.take();
  };
  const tab = (slot) => page.locator(`#re-tabs .re-tab[data-slot="${slot}"]`).click();
  const stepper = async (prefix, value) => {
    await page.locator(`#${prefix}-value`).click();
    const input = page.locator(`#${prefix}-value input`);
    await input.fill(String(value));
    await input.press("Enter");
  };
  const chip = (list, name) => page.locator(`#${list}`).getByText(name, { exact: true }).click();
  const mode = (kind, value) => page.locator(`.re-${kind}-mode[data-mode="${value}"]`).click();
  const machine = async () => {
    await page.locator("#re-machine-toggle").click();
    await page.locator("#re-machine-rows").waitFor();
  };
  /** Taps SAVE, and again if it asks to confirm replacing a slot's holder. */
  const save = async () => {
    const button = page.locator("#re-save-btn");
    await button.click();
    await page.waitForTimeout(300);
    if (/^REPLACE/.test((await button.textContent().catch(() => "")) ?? "")) await button.click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(2500);
  };
  return { open, tab, stepper, chip, mode, machine, save };
}

/** DYE2's recipe editor: recipes saved into an empty slot and into none, moved onto a held slot, taken off the strip, edited, hidden from Streamline, and its Machine Settings. */
async function recordRecipes(browser) {
  const r = await recordedPage(browser);
  const { page } = r;
  const { open, tab, stepper, chip, mode, machine, save } = recipeEditor(r);
  const steps = {};

  log("editor: a new recipe into empty slot 5");
  await open({ new: true });
  await tab(5);
  await page.locator("#re-name-input").fill("Fixture Slot Recipe");
  await chip("re-bean-chips", "Fixture Ethiopia");
  await chip("re-profile-chips", "Adaptive v3");
  await chip("re-grinder-chips", "Fixture Grinder 64");
  await chip("re-basket-chips", "Fixture 18g Precision");
  await stepper("re-dose", 18);
  await stepper("re-drink", 36);
  await stepper("re-brew-c", 92);
  await mode("steam", "time");
  await stepper("re-steam", 30);
  await stepper("re-flush", 5);
  await mode("hotwater", "temp");
  await stepper("re-hotwater", 85);
  await stepper("re-grind", 2.5);
  await stepper("re-rpm", 900);
  steps.newInEmptySlot = await save();

  log("editor: a new recipe in no slot, read from the Workflow");
  await open({ new: true });
  await page.locator("#re-read-from-btn").click();
  await page.locator("#re-read-from-workflow").click();
  await r.take();
  await page.locator("#re-name-input").fill("Fixture Library Recipe");
  await chip("re-bean-chips", "Fixture Brazil");
  await chip("re-grinder-chips", "Fixture Grinder 64");
  await chip("re-basket-chips", "Fixture 20g High-flow");
  await stepper("re-dose", 19);
  await stepper("re-drink", 38);
  await stepper("re-brew-c", 93);
  await mode("steam", "flow");
  await stepper("re-steam", 1.2);
  await stepper("re-flush", 4);
  await mode("hotwater", "vol");
  await stepper("re-hotwater", 150);
  await stepper("re-grind", 3);
  await stepper("re-rpm", 1100);
  steps.newInNoSlot = await save();
  const library = await recipeNamed("Fixture Library Recipe");
  const slotted = await recipeNamed("Fixture Slot Recipe");

  log("editor: the library recipe moved onto slot 1, which recipe 1 holds");
  await open({ id: library.id });
  await tab(1);
  steps.moveToHeldSlot = await save();

  log("editor: the slot 5 recipe taken off the strip");
  await open({ id: slotted.id });
  await tab(5);
  steps.takeOffStrip = await save();

  log("editor: a field edited");
  await open({ id: library.id });
  await stepper("re-dose", 19.5);
  await stepper("re-grind", 3.2);
  steps.editFields = await save();

  log("editor: recipe 3 hidden from Streamline's strip");
  await open({ id: "3" });
  await page.locator("#re-show-streamline-btn").click();
  steps.hideFromStreamline = await save();

  log("editor: Machine Settings");
  await open({ id: slotted.id });
  await machine();
  await stepper("re-steam-temp", 150);
  await stepper("re-milk-stop", 60);
  await stepper("re-hw-time", 30);
  await stepper("re-hw-flow", 4);
  await stepper("re-flush-temp", 90);
  await stepper("re-flush-flow", 6);
  steps.saveMachineSettings = await save();

  log("editor: steam temperature Off");
  await open({ id: slotted.id });
  await machine();
  await page.locator('#re-steam-temp-presets .dye-preset[data-preset="Off"]').click();
  steps.steamOff = await save();

  // The Auto Favourites page's add card opens auto-fav-edit, whose SAVE TO RECIPE saves a recipe (updateRecipe), in no slot.
  log("editor: a recipe saved from the Auto Favourites editor");
  await page.goto(DYE2("auto-favs"));
  await page.waitForTimeout(2000);
  await r.take();
  await page.locator(".dye-card-add").click();
  await page.waitForURL(/auto-fav-edit/);
  await page.waitForTimeout(1500);
  await page.locator("#afe-title-input").fill("Fixture Favourite Recipe");
  await page.locator("#afe-save-btn").click();
  steps.newFromFavouriteEditor = await r.take(2500);
  await r.context.close();
  return steps;
}

/** Reads kept on DYE2's dashboard and Select Recipe: its selection, and the recipes it reads again before an apply. */
const dashboardReads = (route) => route === SELECTION || route === RECIPES;

/** DYE2's dashboard on a recorded page: opened afresh, and a recipe's pill tapped. */
function dashboard(r) {
  const open = async () => {
    await r.page.goto(DYE2("dashboard"));
    await r.take(3000);
  };
  const pill = async (title) => {
    await r.page.locator(`#dye-recipe-pills .dye-recipe-pill:not(.dye-pill-recent)[title="${title}"]`).first().click();
    return r.take(1500);
  };
  /** Opens the dashboard and taps a pill, giving the tap's exchanges. */
  const apply = async (title) => {
    await open();
    return pill(title);
  };
  return { open, pill, apply };
}

/** The profile of each Workflow a load left, as the last `workflowUpdated` carried it and as `GET /workflow` answers, beside the recipe record's, with DYE2's fingerprint of each. */
const fingerprints = [];
async function noteFingerprint(name, recipeName) {
  await wait(300);
  const event = recorder.heard.at(-1)?.payload.workflow;
  const live = await workflow();
  const recipe = await recipeNamed(recipeName);
  const profiles = { workflowUpdated: event?.profile ?? null, workflow: live.profile, recipeWorkflowProfile: recipe?.workflow?.profile ?? null, recipeProfileSnapshot: recipe?.profileSnapshot ?? null };
  const computed = Object.fromEntries(Object.entries(profiles).map(([key, profile]) => [key, profileFingerprint(profile)]));
  const record = recipe?.workflow?.profile || recipe?.profileSnapshot;
  fingerprints.push({
    name,
    recipe: { id: recipe?.id ?? null, name: recipeName },
    recipeIdInWorkflow: live.context?.extras?.dye?.recipeId ?? null,
    ...profiles,
    fingerprints: computed,
    recordMatchesWorkflow: profileFingerprint(record) === computed.workflow,
    recordMatchesWorkflowUpdated: profileFingerprint(record) === computed.workflowUpdated,
  });
}

/** DYE2's dashboard applying a recipe in a slot, Select Recipe applying one in none, a recent favourite applied, and the selected recipe edited. */
async function recordDye2Applies(browser) {
  log("DYE2 applies");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { page } = r;
  const { open, pill, apply } = dashboard(r);
  const steps = {};
  const all = { after: ["selection", "stored", "recipes", "workflow"] };
  steps.applyInSlot = await step(() => apply("Fixture Library Recipe"), all);
  await noteFingerprint("dashboardInSlot", "Fixture Library Recipe");
  steps.applyFromSelectRecipe = await step(async () => {
    await page.goto(DYE2("select-recipe"));
    await page.waitForTimeout(2500);
    await page.locator(".dye-card:not(.dye-card-add)", { has: page.locator(".dye-card-name", { hasText: "Fixture Ethiopia Espresso" }) }).click();
    await page.locator("#dye-confirm-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return r.take(3000);
  }, all);
  await noteFingerprint("selectRecipeNoSlot", "Fixture Ethiopia Espresso");
  // DYE2 v0.1.26 saves no favourites of its own any more (auto-fav-edit saves a recipe): the favourite is the recent one shot.json's Shot made.
  steps.applyFavourite = await step(async () => {
    await open();
    await page.locator("#dye-recipe-pills .dye-recipe-pill.dye-pill-recent").first().click();
    return r.take(1500);
  }, all);
  // The selected recipe edited in DYE2's editor, which applies the saved recipe again (reapplyIfSelected).
  steps.applyBeforeEdit = await step(() => apply("Fixture Library Recipe"), all);
  const library = await recipeNamed("Fixture Library Recipe");
  const editor = recipeEditor(r);
  steps.editSelected = await step(async () => {
    await editor.open({ id: library.id });
    await editor.stepper("re-grind", 3.3);
    return editor.save();
  }, all);
  await open();
  await r.context.close();
  return steps;
}

/** A Shot pulled with the library recipe applied on DYE2's dashboard and a batch set, after a restart for the simulated machine to store it; it makes a recent favourite. */
async function recordShot(browser) {
  log("shot");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply } = dashboard(r);
  const brazil = await beanNamed("Fixture Brazil");
  const steps = {};
  steps.applied = await step(() => apply("Fixture Library Recipe"), { after: ["selection", "workflow"] });
  steps.batchSet = await step(async () => put({ context: { beanBatchId: (await batchOf(brazil)).id, coffeeName: brazil.name, coffeeRoaster: brazil.roaster } }), { after: ["selection", "workflow"] });
  await r.context.close();
  await restartDecaid();
  let shotId;
  steps.pulled = await step(async () => {
    shotId = await pullShot();
    return [];
  }, { after: ["selection", "workflow"], settleMs: 4000 });
  steps.shot = await api("GET", `/shots/${shotId}`);
  steps.favourites = await api("GET", FAVOURITES);
  return steps;
}

/** DYE2's dashboard: a recipe applied, the Workflow changed from elsewhere, a dial tap and Done (dye2#31). */
async function recordDashboard(browser) {
  log("dashboard");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { page } = r;
  const { apply } = dashboard(r);
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow"] };
  steps.applyInSlot = await step(() => apply("Fixture Library Recipe"), reads);
  // As the plugin's load write would, after the page read the Workflow: the other bean's batch and coffee, a Basket and a hot water volume.
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const batch = await batchOf(ethiopia);
  const basket = await basketNamed("Fixture 18g Precision");
  steps.writtenElsewhere = await step(
    () => put({ context: { beanBatchId: batch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster, extras: { basketId: basket.id, basketName: basket.name } }, hotWaterData: { volume: 90 } }),
    reads,
  );
  steps.dialTap = await step(async () => {
    await page.locator("#dye-grind-plus").click();
    return r.take(1500);
  }, reads);
  steps.done = await step(async () => {
    await page.locator("#dye-done-btn").click();
    return r.take(1500);
  }, reads);
  await r.context.close();
  return steps;
}

/** DYE2's `record` after each kind of Workflow change from Node, the library recipe applied on DYE2's dashboard. */
async function recordRecording(browser) {
  log("recording");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply } = dashboard(r);
  const steps = {};
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const ethiopiaBatch = await batchOf(ethiopia);
  const grinder83 = await grinderNamed("Fixture Grinder 83");
  const precision = await basketNamed("Fixture 18g Precision");
  steps.select = await step(() => apply("Fixture Library Recipe"), { after: ["selection", "recipes", "workflow"] });
  steps.dose = await step(() => changeAndRecord({ context: { targetDoseWeight: 19.8 } }));
  steps.yield = await step(() => changeAndRecord({ context: { targetYield: 40 } }));
  steps.grind = await step(() => changeAndRecord({ context: { grinderSetting: "3.6" } }));
  steps.rpm = await step(() => changeAndRecord({ context: { extras: { rpm: 1150 } } }));
  steps.basket = await step(() => changeAndRecord({ context: { extras: { basketId: precision.id, basketName: precision.name } } }));
  const raised = (await workflow()).profile;
  steps.brewTemperature = await step(() => changeAndRecord({ profile: { ...raised, steps: raised.steps.map((s) => ({ ...s, temperature: s.temperature + 1 })) } }));
  steps.steamHeld = await step(() => changeAndRecord({ steamSettings: { flow: 1.4 } }));
  steps.hotWaterHeld = await step(() => changeAndRecord({ hotWaterData: { volume: 160 } }));
  steps.flushHeld = await step(() => changeAndRecord({ rinseData: { duration: 6 } }));
  steps.notHeldMoved = await step(() => changeAndRecord({ hotWaterData: { targetTemperature: 80 } }), { after: ["selection", "recipes", "workflow"] });
  const apply0 = (await workflow()).hotWaterData;
  steps.notHeldNotMoved = await step(() => changeAndRecord({ hotWaterData: { flow: apply0.flow } }), { after: ["selection", "recipes", "workflow"] });
  steps.steamOff = await step(() => changeAndRecord({ steamSettings: { targetTemperature: 0, flow: 1.6 } }), { after: ["selection", "recipes", "workflow"] });
  steps.steamBackOn = await step(() => changeAndRecord({ steamSettings: { targetTemperature: 150 } }), { after: ["selection", "recipes", "workflow"] });
  steps.steamTimeZero = await step(() => changeAndRecord({ steamSettings: { duration: 0 } }), { after: ["selection", "recipes", "workflow"] });
  steps.clearedValue = await step(() => changeAndRecord({ context: { grinderSetting: null } }), { after: ["selection", "recipes", "workflow"] });
  steps.anotherBatch = await step(() => changeAndRecord({ context: { beanBatchId: ethiopiaBatch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } }), { after: ["selection", "recipes", "workflow"] });
  steps.anotherGrinder = await step(() => changeAndRecord({ context: { grinderId: grinder83.id, grinderModel: grinder83.model } }), { after: ["selection", "recipes", "workflow"] });
  steps.twiceInARow = await step(async () => [...(await changeAndRecord({ context: { targetDoseWeight: 20 } })), await record()]);
  steps.nothingSelected = await step(() => changeAndRecord({ context: { extras: { dye: { recipeId: null } } } }), { after: ["selection", "recipes", "workflow"] });
  await r.context.close();
  return steps;
}

/** What unloads a recipe: profile changes by DYE2's fingerprint, and the writes that keep it. */
async function recordUnloads(browser) {
  log("unloads");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { page, take } = r;
  const { apply } = dashboard(r);
  const steps = {};
  const reads = { after: ["selection", "workflow"] };
  const adaptive = (await profileTitled("Adaptive v3")).profile;
  const classic = (await profileTitled("Classic Italian espresso")).profile;
  const ethiopia = await beanNamed("Fixture Ethiopia");
  const brazil = await beanNamed("Fixture Brazil");
  const grinder64 = await grinderNamed("Fixture Grinder 64");
  const grinder83 = await grinderNamed("Fixture Grinder 83");
  const select = () => step(() => apply("Fixture Library Recipe"), reads);
  const library = await recipeNamed("Fixture Library Recipe");

  steps.select = await select();
  steps.profileChange = await step(() => put({ profile: adaptive }), reads);
  steps.selectAgain = await select();
  steps.sameProfileWrittenBack = await step(async () => put({ profile: (await workflow()).profile }), reads);
  steps.targetWeightOnly = await step(async () => {
    const current = (await workflow()).profile;
    return put({ profile: { ...current, target_weight: 42 } });
  }, reads);
  steps.anotherBatch = await step(async () => put({ context: { beanBatchId: (await batchOf(ethiopia)).id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster } }), reads);
  steps.anotherGrinder = await step(() => put({ context: { grinderId: grinder83.id, grinderModel: grinder83.model } }), reads);
  steps.batchAndGrinderBack = await step(async () => put({ context: { beanBatchId: (await batchOf(brazil)).id, coffeeName: brazil.name, coffeeRoaster: brazil.roaster, grinderId: grinder64.id, grinderModel: grinder64.model } }), reads);
  steps.newProfileWithSameRecipeId = await step(() => put({ profile: adaptive, context: { extras: { dye: { recipeId: library.id } } } }), reads);
  steps.selectBeforeTwoPuts = await select();
  steps.twoPuts = await step(async () => [...(await put({ context: { extras: { dye: { recipeId: null } } } })), ...(await put({ profile: adaptive, context: { extras: { dye: { recipeId: library.id } } } }))], reads);
  steps.profileChangeAfterTwoPuts = await step(() => put({ profile: classic }), reads);

  // A recipe on Adaptive v3, whose steps hold limiters of value 0, applied from Select Recipe; then its profile written with those limiters null, as Streamline sends it.
  steps.selectAdaptive = await step(async () => {
    await page.goto(DYE2("select-recipe"));
    await page.waitForTimeout(2500);
    await page.locator(".dye-card:not(.dye-card-add)", { has: page.locator(".dye-card-name", { hasText: "Fixture Ethiopia Espresso" }) }).click();
    await page.locator("#dye-confirm-btn").click();
    await page.waitForURL(/dashboard/, { waitUntil: "commit" });
    return take(3000);
  }, reads);
  steps.limiterZeroAsNull = await step(async () => {
    const current = (await workflow()).profile;
    return put({ profile: { ...current, steps: current.steps.map((s) => (s.limiter && Number(s.limiter.value) === 0 ? { ...s, limiter: null } : s)) } });
  }, reads);
  steps.limiterZeroWritten = await step(async () => {
    const current = (await workflow()).profile;
    return put({ profile: { ...current, steps: current.steps.map((s, i) => (s.limiter === null && adaptive.steps[i]?.limiter ? { ...s, limiter: adaptive.steps[i].limiter } : s)) } });
  }, reads);
  await r.context.close();
  return steps;
}

/** A recipe applied across DYE2 restarts: disabled and enabled, Decaid restarted, its record or the live profile changed while it was away, and `record` after. */
async function recordRestart(browser) {
  log("restart");
  const r = await recordedPage(browser, { keepRead: dashboardReads });
  const { apply } = dashboard(r);
  const steps = {};
  const reads = { after: ["selection", "stored", "workflow"] };
  const adaptive = (await profileTitled("Adaptive v3")).profile;
  const select = () => step(() => apply("Fixture Library Recipe"), reads);
  const readTwice = async () => [await api("GET", SELECTION), await wait(3000), await api("GET", SELECTION)].filter(Boolean);

  steps.select = await select();
  steps.disableEnable = await step(async () => [...(await reloadDye2()), ...(await readTwice())], { ...reads, settleMs: 3000 });
  steps.decaidRestart = await step(async () => {
    await restartDecaid();
    return [];
  }, { ...reads, settleMs: 1000 });
  // The recipe's record changed while DYE2 runs, as the plugin's write of `recipes` would (its profile's last step at 8.5 bar), then Decaid restarted.
  const changedProfile = (profile) => profile && { ...profile, steps: profile.steps.map((s, i, all) => (i === all.length - 1 ? { ...s, pressure: 8.5 } : s)) };
  const withChangedProfile = (list) =>
    list.map((recipe) => (recipe?.name === "Fixture Library Recipe" ? { ...recipe, profileSnapshot: changedProfile(recipe.profileSnapshot), workflow: { ...recipe.workflow, profile: changedProfile(recipe.workflow.profile) } } : recipe));
  const unchanged = await recipes();
  steps.decaidRestartRecordChanged = await step(async () => {
    const written = await api("POST", RECIPES, withChangedProfile(unchanged));
    await restartDecaid();
    return [written];
  }, { after: ["selection", "stored", "recipes", "workflow"], settleMs: 1000 });
  steps.recordRestoredAfterDecaidRestart = { exchanges: [await api("POST", RECIPES, unchanged)] };
  steps.disableEnableAfterRestart = await step(async () => [...(await reloadDye2()), ...(await readTwice())], { ...reads, settleMs: 3000 });

  // The recipe's record changed while DYE2 was away, as another writer of `recipes` would: its profile's last step at 8.5 bar.
  const before = await recipes();
  steps.recordProfileChangedWhileAway = await step(async () => {
    const disabled = await api("POST", "/plugins/dye2.reaplugin/disable");
    const written = await api("POST", RECIPES, withChangedProfile(before));
    const enabled = await api("POST", "/plugins/dye2.reaplugin/enable");
    await wait(500);
    if (changed.closed) await openChanged();
    return [disabled, written, enabled, ...(await readTwice())];
  }, { after: ["selection", "stored", "recipes", "workflow"], settleMs: 3000 });
  const restored = await api("POST", RECIPES, before);
  steps.recordRestored = { exchanges: [restored] };

  steps.selectBeforeLiveChange = await select();
  steps.liveProfileChangedWhileAway = await step(async () => {
    const disabled = await api("POST", "/plugins/dye2.reaplugin/disable");
    const written = await put({ profile: adaptive });
    const enabled = await api("POST", "/plugins/dye2.reaplugin/enable");
    await wait(500);
    if (changed.closed) await openChanged();
    return [disabled, ...written, enabled, ...(await readTwice())];
  }, { ...reads, settleMs: 3000 });

  // `record` after a restart: changes made after DYE2 loaded again, then changes made while it was away.
  const raise = async () => {
    const profile = (await workflow()).profile;
    return { ...profile, steps: profile.steps.map((s) => ({ ...s, temperature: s.temperature + 1 })) };
  };
  // The recipe applied again on DYE2's dashboard, its profile now the recipe's own: DYE2's baseline is the profile it found as it loaded (decentespresso/dye2#38).
  steps.reapplyAfterLiveChange = await select();
  steps.selectBeforeRecordAfterRestart = await select();
  steps.reloadBeforeRecord = await step(reloadDye2, { ...reads, settleMs: 3000 });
  steps.recordAfterRestart = await step(async () => changeAndRecord({ context: { targetDoseWeight: 21 }, profile: await raise(), steamSettings: { stopAtTemperature: 60 } }), {
    after: ["selection", "recipes", "workflow"],
  });
  steps.selectBeforeChangeWhileAway = await select();
  steps.recordChangedWhileAway = await step(async () => {
    const disabled = await api("POST", "/plugins/dye2.reaplugin/disable");
    const written = await put({ context: { targetDoseWeight: 21.5 }, profile: await raise(), steamSettings: { stopAtTemperature: 65 } });
    const enabled = await api("POST", "/plugins/dye2.reaplugin/enable");
    await wait(3000);
    if (changed.closed) await openChanged();
    return [disabled, ...written, enabled, await record()];
  }, { after: ["selection", "recipes", "workflow"] });
  await r.context.close();
  return steps;
}

/** DYE2's `save-recipe` from Node, as Streamline's long-press menu calls it: into an empty slot, a held one, and none. */
async function recordSaveRecipe() {
  log("save-recipe");
  const steps = {};
  const reads = { after: ["selection", "recipes", "workflow"] };
  steps.intoEmptySlot = await step(async () => [await api("POST", SAVE_RECIPE, { slot: 5 })], reads);
  steps.intoHeldSlot = await step(async () => [await api("POST", SAVE_RECIPE, { slot: 4 })], reads);
  steps.noSlot = await step(async () => [await api("POST", SAVE_RECIPE, {})], reads);
  return steps;
}

/** Reads kept from Streamline: DYE2's selection, and its stored mirror of it. */
const streamlineReads = (route) => route === SELECTION || route === STORED_SELECTION;

/** Streamline's DYE strip: its page load, applies, its long-press menu, a Shot pulled, and its steam settings. */
async function recordStreamline(browser) {
  log("Streamline");
  // Slot 5 freed for "Save to recipe 5", as DYE2's editor frees it.
  const freeing = await recordedPage(browser);
  const editor = recipeEditor(freeing);
  const inFive = (await recipes()).find((recipe) => recipe?.stripSlot === 5);
  await editor.open({ id: inFive.id });
  await editor.tab(5);
  const freeSlot5 = await editor.save();
  await freeing.context.close();

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
  const all = { after: ["selection", "stored", "recipes", "workflow"] };
  const steps = { freeSlot5 };
  const load = async () => {
    await page.goto(`${SKIN}/`);
    return r.take(8000);
  };
  steps.started = await step(load, { after: ["selection", "stored", "workflow"] });
  steps.applyFromStrip = await step(() => strip("Fixture Brazil Espresso"), all);
  await noteFingerprint("streamlineStrip", "Fixture Brazil Espresso");
  steps.doseTile = await step(async () => {
    await page.locator("#dose-in-plus").click();
    return r.take(3000);
  }, all);
  let shown;
  steps.saveChanges = await step(async () => {
    shown = await menu(cell("Fixture Brazil Espresso"), "Save changes");
    return shown.exchanges;
  }, all);
  steps.saveChanges.menu = shown.menu;
  steps.saveToEmptyCell = await step(async () => {
    // The fifth button, empty since slot 5 was freed.
    shown = await menu(page.locator("#dye-strip button").nth(4), "Save to recipe 5");
    return shown.exchanges;
  }, all);
  steps.saveToEmptyCell.menu = shown.menu;
  const inFour = (await recipes()).find((recipe) => recipe?.stripSlot === 4);
  steps.replaceFilledCell = await step(async () => {
    shown = await menu(cell(inFour.name), "Replace");
    return shown.exchanges;
  }, all);
  steps.replaceFilledCell.menu = shown.menu;
  steps.applyBeforeClear = await step(() => strip("Fixture Brazil Espresso"), all);
  steps.clearButton = await step(async () => {
    shown = await menu(cell("Fixture Brazil Espresso"), "Clear button");
    return shown.exchanges;
  }, all);
  steps.clearButton.menu = shown.menu;

  // A Shot pulled with Streamline open and a recipe applied from its strip, after a restart for the simulated machine to store it.
  await restartDecaid();
  steps.restarted = await step(load, { after: ["selection", "stored", "workflow"] });
  steps.applyBeforeShot = await step(() => strip("Fixture Library Recipe"), all);
  await noteFingerprint("streamlineStripLibraryRecipe", "Fixture Library Recipe");
  steps.writtenBeforeShot = await step(() => put({ context: { baristaName: "Fixture Barista", drinkerName: "Fixture Drinker", extras: { note: "Fixture note" } } }), { after: ["selection", "workflow"] });
  let shotId;
  steps.shotPulled = await step(async () => {
    shotId = await pullShot();
    return r.take(4000);
  }, { after: ["selection", "recipes", "workflow"] });
  const shot = await api("GET", `/shots/${shotId}`);

  // The steam tile's time set to 0, and the heater switched off and on, through the page's own module (src/modules/api.js).
  const viaApi = (name, value) =>
    step(async () => {
      await page.evaluate(async ([fn, arg]) => (await import("/src/modules/api.js"))[fn](arg), [name, value]);
      return r.take(2000);
    }, { after: ["selection", "recipes", "workflow"] });
  steps.steamTimeZero = await viaApi("setTargetSteamDuration", 0);
  steps.heaterOff = await viaApi("setSteamHeaterEnabled", false);
  steps.heaterOn = await viaApi("setSteamHeaterEnabled", true);
  await r.context.close();
  return { steps, shot };
}

const keys = async () => Object.fromEntries(await Promise.all(["recipes", "baskets", "equipment", "selection", "selectionMigrated", "recipesMigrated", "favSlotsMigrated", "favProfilesMigrated"].map(async (key) => [key, (await api("GET", `${STORE}/${key}`)).response.body])));

// ---- One run, on a Decaid whose data is new.

if (process.argv[3] === "--compact") {
  // Compacts recordings already written to <output dir>, written before compaction was part of the run.
  compactAll(out);
  process.exit(0);
}

log("installing the recorder");
const recorderSource = {
  manifest: JSON.parse(fs.readFileSync(path.join(HERE, "workflow-recorder", "manifest.json"), "utf8")),
  plugin: fs.readFileSync(path.join(HERE, "workflow-recorder", "plugin.js"), "utf8"),
};
const installed = await api("PUT", "/plugins/workflow-recorder.reaplugin/source", recorderSource);
if (installed.response.status >= 300) throw new Error(`The recorder was not installed: ${JSON.stringify(installed.response)}`);
await api("POST", "/plugins/workflow-recorder.reaplugin/enable");
await wait(1000);
recorder = listen("workflow-recorder.reaplugin", "workflow");
if ((await recorder.opened) !== 101) throw new Error("The recorder's socket did not open");

await seedLibrary();
const library = {
  beans: (await api("GET", "/beans")).response.body,
  beanBatches: (await api("GET", "/bean-batches")).response.body,
  grinders: (await api("GET", "/grinders")).response.body,
  profiles: (await api("GET", "/profiles")).response.body.filter((record) => ["Adaptive v3", "Classic Italian espresso"].includes(record.profile.title)),
  workflow: await workflow(),
  machineSettings: (await api("GET", "/machine/settings")).response.body,
  bundledDye2: await plugins(),
};
write("store.json", await recordStore());

log("seeding DYE2's keys as an earlier DYE2 left them");
const seeded = { exchanges: await seedLegacyStore() };
await wait(1000);
Object.assign(seeded, await snapshot());
log("installing DYE2's latest release");
const install = await recordInstall();
if (!install.listed.some((plugin) => plugin.version === "0.1.26" && plugin.loaded)) throw new Error(`DYE2 v0.1.26 is not loaded: ${JSON.stringify(install.listed)}`);
await openChanged();
write("loading.json", { seeded, install });
write("plugins.json", { installed: install.exchanges[0], listed: await plugins(), selection: await api("GET", SELECTION), skin: await api("GET", "/plugins/dye2.reaplugin/skin") });

const browser = await chromium.launch();
try {
  write("recipes.json", await recordRecipes(browser));
  write("library.json", { ...library, recipes: await recipes(), baskets: (await api("GET", `${STORE}/baskets`)).response.body, workflowAfterEditor: await workflow() });
  const dashboardShot = await recordShot(browser);
  write("dye2-applies.json", await recordDye2Applies(browser));
  write("dashboard.json", await recordDashboard(browser));
  write("recording.json", await recordRecording(browser));
  write("unloads.json", await recordUnloads(browser));
  write("restart.json", await recordRestart(browser));
  write("save-recipe.json", await recordSaveRecipe());
  const { steps, shot } = await recordStreamline(browser);
  write("streamline.json", steps);
  write("shot.json", { dashboard: dashboardShot, streamline: { pulled: shot } });
  write("fingerprints.json", fingerprints);
  write("keys.json", await keys());
} finally {
  await browser.close();
  changed.socket.close();
  recorder.socket.close();
}
compactAll(out);
log("done");
