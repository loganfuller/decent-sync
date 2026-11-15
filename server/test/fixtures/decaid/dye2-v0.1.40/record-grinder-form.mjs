// Records what DYE2 v0.1.40's Grinders page writes to Decaid v0.9.2 of a
// grinder's range and defaults, as README.md describes (`grinder-form.json`,
// recorded for decent-sync #551): drives the page's form in headless
// Chromium and sends requests from Node, as Decent Sync's plugin would,
// keeping each exchange with Decaid's answer. Run it once, from the
// repository root, against a Decaid started with a token whose data is new,
// still holding its bundled DYE2:
//
//   DECAID_EXTENSIONS_TOKEN=<token> node server/test/fixtures/decaid/dye2-v0.1.40/record-grinder-form.mjs <output dir>
//
// It reads DECAID from the environment for another address, and
// DECAID_EXTENSIONS_TOKEN for the token Decaid was started with, which it
// sends with the request that installs DYE2's latest release, which must be
// v0.1.40, and never writes to a file.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const TOKEN = process.env.DECAID_EXTENSIONS_TOKEN;
const DYE2_VERSION = "0.1.40";
const GRINDERS_PAGE = `${DECAID}/api/v1/plugins/dye2.reaplugin/grinders`;
/** A made-up global id, as Decent Sync's plugin writes one into a grinder's `extras`. */
const GLOBAL_ID = "5c0f3d52-7a1e-4c55-9d0e-2f6a41b7c551";
const log = (message) => console.log(new Date().toISOString(), message);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const out = process.argv[2];
if (!out) throw new Error("Usage: DECAID_EXTENSIONS_TOKEN=<token> record-grinder-form.mjs <output dir>");
if (!TOKEN) throw new Error("DECAID_EXTENSIONS_TOKEN is not set");
fs.mkdirSync(out, { recursive: true });

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Sends a request to Decaid's API, with Decaid's token where asked, and gives the exchange. */
async function api(method, route, body, withToken = false) {
  const response = await fetch(`${DECAID}/api/v1${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(withToken ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { request: { method, path: route, ...(body === undefined ? {} : { body }) }, response: { status: response.status, body: text === "" ? null : parse(text) } };
}

const dye2Listed = async () => (await api("GET", "/plugins")).response.body.find((plugin) => plugin.id === "dye2.reaplugin");

/**
 * DYE2's Grinders page opened afresh, on the form of the grinder with that
 * id (`grinders?edit=<id>`, as the dashboard's long-press of a grinder opens
 * it) or, for null, its ADD NEW GRINDER card tapped; `typed` filled into the
 * form's inputs by name, the Setting Type chosen first where given, and SAVE
 * tapped. Gives every request but a read the page sent, each with Decaid's
 * answer, then what the form's inputs showed as it opened (`shown`) and the
 * error it showed after SAVE, null for none (`error`).
 */
async function saveForm(browser, id, typed) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
  const recorded = [];
  await context.route(/\/api\/v1\//, async (route) => {
    const request = route.request();
    if (request.method() === "GET" || request.method() === "OPTIONS") return route.continue();
    const url = new URL(request.url());
    const exchange = { request: { method: request.method(), path: url.pathname.slice("/api/v1".length) + url.search }, response: undefined };
    const body = request.postData();
    if (body !== null) exchange.request.body = parse(body);
    recorded.push(exchange);
    const response = await route.fetch();
    const text = await response.text();
    exchange.response = { status: response.status(), body: text === "" ? null : parse(text) };
    await route.fulfill({ response, body: text }).catch(() => {});
  });
  await page.goto(id === null ? GRINDERS_PAGE : `${GRINDERS_PAGE}?edit=${id}`);
  await page.waitForSelector("#dye-cards-grid .dye-card-add");
  if (id === null) await page.click("#dye-cards-grid .dye-card-add");
  await page.waitForSelector("#dye-modal-backdrop.open");
  const inputs = () =>
    page.evaluate(() => {
      const form = document.getElementById("dye-grinder-form");
      const names = ["model", "settingType", "settingSmallStep", "settingBigStep", "settingMin", "settingMax", "settingDefault", "settingValues", "rpmSmallStep", "rpmBigStep", "rpmMin", "rpmMax", "rpmDefault", "feedRate"];
      return Object.fromEntries(names.map((name) => [name, form.elements[name].value]));
    });
  const shown = await inputs();
  const { settingType, ...rest } = typed;
  if (settingType !== undefined) await page.selectOption('#dye-grinder-form [name="settingType"]', settingType);
  for (const [name, value] of Object.entries(rest)) await page.fill(`#dye-grinder-form [name="${name}"]`, value);
  await page.click("#dye-modal-save");
  await page.waitForTimeout(1500);
  for (let waited = 0; recorded.some((exchange) => !exchange.response); waited += 100) {
    if (waited > 10_000) throw new Error("A request was never answered");
    await page.waitForTimeout(100);
  }
  const error = await page.evaluate(() => {
    const element = document.getElementById("dye-modal-error");
    return element.classList.contains("dye-hidden") ? null : element.textContent;
  });
  await context.close();
  return [...recorded, { shown }, { typed }, { error }];
}

/** A step: the exchanges `act` gives, then the grinder as Decaid holds it, where it is named. */
async function step(act, grinderId) {
  const exchanges = await act();
  await wait(500);
  return { exchanges, after: grinderId === undefined ? [] : [await api("GET", `/grinders/${grinderId}`)] };
}

log("installing DYE2");
const bundled = await dye2Listed();
const install = await api("POST", "/plugins/install/github-release", { repo: "decentespresso/dye2" }, true);
if (install.response.status !== 200) throw new Error(`DYE2's install answered ${install.response.status}: ${JSON.stringify(install.response.body)}`);
const listed = await dye2Listed();
if (listed.version !== DYE2_VERSION) throw new Error(`DYE2 is at ${listed.version}, not ${DYE2_VERSION}`);

const browser = await chromium.launch();
const steps = {};
const info = (await api("GET", "/info")).response.body;
steps.versions = { decaid: info.fullVersion, bundledDye2: bundled.version, dye2: listed.version };

log("the grinder, as a tablet holds one of the Library's");
const made = await api("POST", "/grinders", {
  model: "Fixture Grinder Form",
  burrs: "Fixture 64mm flat",
  settingSmallStep: 0.5,
  settingBigStep: 1,
  rpmSmallStep: 50,
  rpmBigStep: 100,
  extras: { bcUuid: "fixture-bc-uuid", decentSyncId: GLOBAL_ID },
});
if (made.response.status !== 201 && made.response.status !== 200) throw new Error(`The grinder's create answered ${made.response.status}`);
const id = made.response.body.id;
steps.made = { exchanges: [made], after: [await api("GET", `/grinders/${id}`)] };

log("a range and defaults saved, a lowest setting of 0 among them");
steps.rangeSaved = await step(
  () => saveForm(browser, id, { feedRate: "manual FF/MF/SF", settingMin: "0", settingMax: "10", settingDefault: "4", rpmMin: "400", rpmMax: "1200", rpmDefault: "900" }),
  id,
);

log("another field edited, the range kept");
steps.otherEdited = await step(() => saveForm(browser, id, { notes: "Fixture notes" }), id);

log("a lowest above a highest, refused");
steps.settingReversed = await step(() => saveForm(browser, id, { settingMin: "12" }), id);
steps.rpmReversed = await step(() => saveForm(browser, id, { rpmMin: "1500" }), id);

log("a lowest equal to a highest, and a default outside the range");
steps.defaultOutside = await step(() => saveForm(browser, id, { settingMin: "10", settingDefault: "40", rpmDefault: "100" }), id);

log("a default cleared");
steps.defaultCleared = await step(() => saveForm(browser, id, { settingMin: "0", settingDefault: "", rpmDefault: "" }), id);

log("a range below 0");
steps.belowZero = await step(() => saveForm(browser, id, { settingMin: "-5", settingDefault: "-1.5" }), id);

log("a top-level range, as the previous release's plugin writes one, and one in extras, as this release's does");
steps.topLevel = await step(async () => [await api("PUT", `/grinders/${id}`, { settingMin: 1, settingMax: 20, rpmDefault: 700 })], id);
const held = (await api("GET", `/grinders/${id}`)).response.body.extras;
steps.inExtras = await step(async () => [await api("PUT", `/grinders/${id}`, { extras: { ...held, settingMin: 1, settingMax: 20, settingDefault: null, rpmDefault: 700 } })], id);

log("edited to named positions");
steps.namedPositions = await step(() => saveForm(browser, id, { settingType: "preset", settingValues: "Fine, Medium, Coarse" }), id);

log("edited back to a numbered dial");
steps.numericAgain = await step(() => saveForm(browser, id, { settingType: "numeric" }), id);

log("new grinders");
const created = await saveForm(browser, null, { model: "Fixture Grinder Ranged", settingMin: "0", settingMax: "50", rpmDefault: "800" });
const createdId = created.find((exchange) => exchange.response)?.response.body.id;
steps.created = { exchanges: created, after: [await api("GET", `/grinders/${createdId}`)] };
const preset = await saveForm(browser, null, { model: "Fixture Grinder Named", settingType: "preset", settingValues: "Fine, Coarse", rpmMin: "300", rpmMax: "1400" });
const presetId = preset.find((exchange) => exchange.response)?.response.body.id;
steps.createdNamed = { exchanges: preset, after: [await api("GET", `/grinders/${presetId}`)] };
steps.createdReversed = await step(() => saveForm(browser, null, { model: "Fixture Grinder Reversed", settingMin: "9", settingMax: "3" }));

steps.grindersAtEnd = (await api("GET", "/grinders?includeArchived=true")).response.body;
await browser.close();
fs.writeFileSync(path.join(out, "grinder-form.json"), JSON.stringify(steps, null, 2) + "\n");
log("done");
