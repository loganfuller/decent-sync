// Records what Decaid v0.9.3 answers the requests that manage its plugins and Skins, and what `host.localApi` gives a
// plugin that makes them (README.md beside this script). One phase a run, as Decaid is restarted between them:
//
//   node server/test/fixtures/decaid/tablet-software-v0.9.3/record.mjs <phase> <output file>
//
// The phases are `fresh` (a new Decaid), `pending` (one started with an older Decent Sync release in its plugins
// folder, so that an update waits for approval) and `protected` (one started with "Require authorization for
// extension management" on), and `skins` (a new Decaid: Skin installs, update checks, the default Skin, its web server
// and removals). It reads DECAID from the environment for another address than http://localhost:8080.
// Every request goes to a throwaway Decaid: it installs, removes and configures plugins and Skins.
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.DECAID ?? "http://localhost:8080";
const API = `${BASE}/api/v1`;
const [phase, output] = process.argv.slice(2);
if (!["fresh", "pending", "protected", "skins"].includes(phase) || !output) throw new Error("Usage: record.mjs <fresh|pending|protected|skins> <output file>");

const PROBE = "localapi-probe.reaplugin";
const probeFile = (name) => readFileSync(new URL(`./probe/${name}`, import.meta.url), "utf8");

async function send(method, path, body) {
  const response = await fetch(API + path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { request: { method, path, ...(body === undefined ? {} : { body }) }, response: { status: response.status, body: parsed } };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Skin without its description, which nothing here reads: in the `skins` phase only, as the others keep it. */
const skinTrimmed = (skin) => {
  if (phase !== "skins" || !skin || typeof skin !== "object" || !("reaMetadata" in skin)) return skin;
  const { description: _description, ...rest } = skin;
  return rest;
};

/** The plugin list without each plugin's endpoints and description, which no step changes and nothing here reads, and
 * the Skin list and default Skin without each Skin's description (`skins` only). */
function trimmed(route, answer) {
  if (route === "/webui/skins" && Array.isArray(answer.body)) return { status: answer.status, body: answer.body.map(skinTrimmed) };
  if (route === "/webui/skins/default") return { status: answer.status, body: skinTrimmed(answer.body) };
  if (route !== "/plugins" || !Array.isArray(answer.body)) return answer;
  return { status: answer.status, body: answer.body.map(({ api: _api, description: _description, ...plugin }) => plugin) };
}

/** Each route's last answer, so one read again unchanged is kept as `"unchanged": true` in place of its body. */
const lastRead = new Map();
async function reads(routes) {
  const answers = {};
  for (const route of routes) {
    const answer = trimmed(route, (await send("GET", route)).response);
    const text = JSON.stringify(answer);
    answers[route] = lastRead.get(route) === text ? { status: answer.status, unchanged: true } : answer;
    lastRead.set(route, text);
  }
  return answers;
}

const recorded = {};
/** One step: its requests, a moment for a plugin's load to settle, then the reads. */
async function step(name, requests, routes = ["/plugins"]) {
  const exchanges = [];
  for (const [method, path, body] of requests) exchanges.push(await send(method, path, body));
  if (requests.length > 0) await pause(2000);
  recorded[name] = { exchanges, reads: await reads(routes) };
  process.stdout.write(`${name}: ${exchanges.map((exchange) => exchange.response.status).join(", ") || "-"}\n`);
}

/** What the probe plugin's `host.localApi` made of each call, in order. */
async function localApi(name, calls, routes = []) {
  const answer = await send("POST", `/plugins/${PROBE}/call`, { calls });
  // The probe answers with one entry a call; a body of another shape is Decaid's own answer, such as to a probe
  // that was reloaded under the request.
  const results = Array.isArray(answer.response.body)
    ? answer.response.body.map((result, index) => ({ call: calls[index], ...parsedBody(result) }))
    : { calls, status: answer.response.status, body: answer.response.body };
  await pause(2000);
  recorded[name] = { localApi: results, reads: await reads(routes) };
  process.stdout.write(`${name}: ${Array.isArray(results) ? results.map((result) => result.resolved?.status ?? "rejected").join(", ") : answer.response.status}\n`);
}

/** A resolved answer with its body read as JSON where it is JSON, the plugin list trimmed as the reads are. */
function parsedBody(result) {
  if (!result.resolved || typeof result.resolved.body !== "string") return result;
  let body = result.resolved.body;
  try {
    body = JSON.parse(body);
  } catch {
    return result;
  }
  if (Array.isArray(body)) body = body.map((item) => ("reaMetadata" in Object(item) ? skinTrimmed(item) : (({ api: _api, description: _description, ...plugin }) => plugin)(item)));
  else body = skinTrimmed(body);
  return { resolved: { ...result.resolved, body, bodyWasText: true } };
}

/** The frames Decaid's update socket sends for a command, until it has been quiet for `quietMs`. */
async function updateSocket(name, command, quietMs = 5000) {
  const frames = [];
  const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/v1/update`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("The update socket did not open"));
  });
  let last = Date.now();
  socket.onmessage = (event) => {
    last = Date.now();
    frames.push(JSON.parse(String(event.data)));
  };
  await pause(1000);
  const opened = frames.splice(0);
  socket.send(JSON.stringify({ command }));
  last = Date.now();
  while (Date.now() - last < quietMs) await pause(250);
  socket.close();
  recorded[name] = { opened, sent: { command }, frames, reads: await reads(["/update"]) };
  process.stdout.write(`${name}: ${frames.length} frames\n`);
}

async function installProbe(permissions) {
  const manifest = JSON.parse(probeFile("manifest.json"));
  if (permissions) manifest.permissions = permissions;
  return [
    ["PUT", `/plugins/${PROBE}/source`, { manifest, plugin: probeFile("plugin.js") }],
    ["POST", `/plugins/${PROBE}/enable`],
  ];
}

// Decaid answers before it has loaded its plugins and installed the Skins it comes with: the first step waits until
// it lists a plugin and every Skin's source.
for (let waited = 0; ; waited += 1000) {
  const plugins = (await send("GET", "/plugins")).response.body;
  const skins = (await send("GET", "/webui/skins")).response.body;
  if (Array.isArray(plugins) && plugins.length > 0 && Array.isArray(skins) && skins.length > 0 && skins.every((skin) => skin.reaMetadata)) break;
  if (waited > 180_000) throw new Error("Decaid did not load its plugins and install its Skins");
  await pause(1000);
}

const VISUALIZER = "/plugins/visualizer.reaplugin/settings";

if (phase === "fresh") {
  recorded.info = (await send("GET", "/info")).response;
  await step("started", [], ["/plugins", "/update", "/webui/skins", "/webui/skins/default", "/webui/server/status", "/settings", VISUALIZER]);
  await step("checked", [["POST", "/plugins/update"]]);
  await step("releaseInstalled", [["POST", "/plugins/install/github-release", { repo: "loganfuller/decent-sync" }]]);
  await step("enabled", [["POST", "/plugins/decent-sync.reaplugin/enable"]]);
  await step("disabled", [["POST", "/plugins/decent-sync.reaplugin/disable"]]);
  await step("branchInstalled", [["POST", "/plugins/install/github-branch", { repo: "decentespresso/dye2", branch: "dist" }]]);
  // The branch's commit, as Decaid just recorded it, installed by name: what pins a plugin to a build.
  const commit = (await send("GET", "/plugins")).response.body.find((plugin) => plugin.id === "dye2.reaplugin").source.commit;
  await step("commitInstalled", [["POST", "/plugins/install/github-branch", { repo: "decentespresso/dye2", branch: commit }]]);
  await step("checkedAgain", [["POST", "/plugins/update"]]);
  await step("installsRefused", [
    ["POST", "/plugins/install/github-release", {}],
    ["POST", "/plugins/install/github-release", { repo: "decent-sync-fixtures/no-such-repository" }],
    ["POST", "/plugins/install/github-branch", { repo: "decentespresso/dye2", branch: "no-such-branch" }],
    ["POST", "/plugins/install/github-branch", { repo: "decentespresso/dye2", branch: "main" }],
  ]);
  await step(
    "settingsSaved",
    [["POST", VISUALIZER, { Username: "sam", Password: "not-a-real-password", LengthThreshold: 7, AutoUpload: false }]],
    ["/plugins", VISUALIZER],
  );
  await step("settingsSavedInPart", [["POST", VISUALIZER, { LengthThreshold: 9 }]], [VISUALIZER]);
  await step("settingCleared", [["POST", VISUALIZER, { Username: null, Password: null }]], [VISUALIZER]);
  await step(
    "settingsRefused",
    [
      ["POST", VISUALIZER, { NoSuchSetting: 1 }],
      ["POST", VISUALIZER, { LengthThreshold: "seven" }],
      ["GET", "/plugins/no-such.reaplugin/settings"],
      ["POST", "/plugins/no-such.reaplugin/settings", { Any: 1 }],
    ],
    [VISUALIZER],
  );
  await step("unknownRefused", [
    ["POST", "/plugins/no-such.reaplugin/enable"],
    ["POST", "/plugins/no-such.reaplugin/disable"],
    ["POST", "/plugins/no-such.reaplugin/update/approve"],
    ["DELETE", "/plugins/no-such.reaplugin"],
    ["POST", "/plugins/dye2.reaplugin/update/approve"],
  ]);
  await step("removed", [["DELETE", "/plugins/dcamp.reaplugin"]]);
  await step("checksOff", [["POST", "/settings", { automaticUpdateCheck: false }]], ["/settings"]);
  await step("checksOn", [["POST", "/settings", { automaticUpdateCheck: true }]], ["/settings"]);
  await updateSocket("updateChecked", "check");
  await updateSocket("updateInstall", "install");

  // The probe without the permission first, then with it.
  await step("probeWithoutPermission", await installProbe(["log", "api"]));
  await localApi("withoutPermission", [{ path: "/api/v1/plugins" }]);
  await step("probeInstalled", await installProbe());
  await localApi("reads", [
    { path: "/api/v1/plugins" },
    { path: "/api/v1/plugins/visualizer.reaplugin/settings" },
    { path: "/api/v1/webui/server/status" },
  ]);
  await localApi(
    "managed",
    [
      { path: "/api/v1/plugins/visualizer.reaplugin/disable", options: { method: "POST" } },
      { path: "/api/v1/plugins/visualizer.reaplugin/enable", options: { method: "POST" } },
      { path: "/api/v1/plugins/visualizer.reaplugin/settings", options: { method: "POST", body: { Username: "alex" } } },
      { path: "/api/v1/plugins/no-such.reaplugin/enable", options: { method: "POST" } },
      { path: "/api/v1/plugins/install/github-release", options: { method: "POST", body: {} } },
      { path: "/api/v1/settings", options: { method: "POST", body: { automaticUpdateCheck: false } } },
      { path: "/api/v1/settings", options: { method: "POST", body: { automaticUpdateCheck: true } } },
    ],
    ["/plugins", VISUALIZER, "/settings"],
  );
  await localApi("outOfReach", [
    { path: "/api/v1/settings" },
    { path: "/api/v1/update" },
    { path: "/api/v1/machine/state" },
    { path: "/api/v1/settings", options: { method: "POST", body: { gatewayMode: "tracking" } } },
    { path: "/api/v1/settings", options: { method: "POST", body: { automaticUpdateCheck: true, gatewayMode: "tracking" } } },
    { path: "/plugins" },
    { path: "http://localhost:8080/api/v1/plugins" },
    { path: "/api/v1/plugins", options: { method: "PATCH" } },
  ]);
  // The probe saving its own settings, which makes Decaid load it again under its own call.
  await localApi("ownSettingsSaved", [{ path: `/api/v1/plugins/${PROBE}/settings`, options: { method: "POST", body: { Note: "saved by itself" } } }], [`/plugins/${PROBE}/settings`, "/plugins"]);
  // The probe disabling itself.
  await localApi("disabledItself", [{ path: `/api/v1/plugins/${PROBE}/disable`, options: { method: "POST" } }], ["/plugins"]);
}

if (phase === "pending") {
  await step("staged", []);
  await step("checked", [["POST", "/plugins/update"]]);
  await step("checkedAgain", [["POST", "/plugins/update"]]);
  await step("approved", [["POST", "/plugins/decent-sync.reaplugin/update/approve"]]);
  await step("approvedAgain", [["POST", "/plugins/decent-sync.reaplugin/update/approve"]]);
}

if (phase === "protected") {
  await step(
    "withoutToken",
    [
      ["GET", "/plugins"],
      ["GET", VISUALIZER],
      ["POST", "/plugins/visualizer.reaplugin/disable"],
      ["POST", VISUALIZER, { Username: "sam" }],
      ["POST", "/plugins/update"],
      ["POST", "/plugins/install/github-release", { repo: "loganfuller/decent-sync" }],
      ["DELETE", "/plugins/dcamp.reaplugin"],
      ["POST", "/settings", { automaticUpdateCheck: false }],
      ["POST", "/settings", { automaticUpdateCheck: true }],
      ["GET", "/update"],
    ],
    ["/plugins", "/settings"],
  );
  // The probe was installed before the setting was turned on, as a plugin already approved on a Tablet is.
  await localApi(
    "localApi",
    [
      { path: "/api/v1/plugins" },
      { path: "/api/v1/plugins/visualizer.reaplugin/settings" },
      { path: "/api/v1/plugins/visualizer.reaplugin/disable", options: { method: "POST" } },
      { path: "/api/v1/plugins/visualizer.reaplugin/enable", options: { method: "POST" } },
      { path: "/api/v1/settings", options: { method: "POST", body: { automaticUpdateCheck: true } } },
    ],
    ["/plugins", "/settings"],
  );
  // Each body's first entry stands for the rest: the list is the one `fresh` holds.
  for (const exchange of recorded.withoutToken.exchanges) {
    if (exchange.request.path === "/plugins" && Array.isArray(exchange.response.body)) {
      exchange.response.body = `${exchange.response.body.length} plugins, as in the reads`;
    }
  }
}

if (phase === "skins") {
  const SKIN_READS = ["/webui/skins", "/webui/skins/default", "/webui/server/status"];
  const skinStep = (name, requests) => step(name, requests, SKIN_READS);
  const skinList = async () => (await send("GET", "/webui/skins")).response.body;
  /** The Skin an install put there: the one new to the list, or the one whose `installedAt` changed. */
  async function installedBy(name, request) {
    const before = new Map((await skinList()).map((skin) => [skin.id, skin.reaMetadata?.installedAt]));
    await skinStep(name, [request]);
    const after = await skinList();
    return (after.find((skin) => !before.has(skin.id)) ?? after.find((skin) => skin.reaMetadata && skin.reaMetadata.installedAt !== before.get(skin.id)))?.id;
  }
  const COMMIT = "d7729dc9532ae31d606447ee0648e20284268b2c";
  const ZIP = `https://github.com/loganfuller/streamline-cafe-js/archive/${COMMIT}.zip`;

  await skinStep("started", []);
  const releaseId = await installedBy("releaseInstalled", ["POST", "/webui/skins/install/github-release", { repo: "loganfuller/streamline-cafe-js" }]);
  const branchId = await installedBy("branchInstalled", ["POST", "/webui/skins/install/github-branch", { repo: "decentespresso/streamline-js", branch: "dist" }]);
  const commitId = await installedBy("commitAsBranch", ["POST", "/webui/skins/install/github-branch", { repo: "loganfuller/streamline-cafe-js", branch: COMMIT }]);
  const urlId = await installedBy("urlInstalled", ["POST", "/webui/skins/install/url", { url: ZIP }]);
  recorded.installedIds = { releaseInstalled: releaseId ?? null, branchInstalled: branchId ?? null, commitAsBranch: commitId ?? null, urlInstalled: urlId ?? null };
  process.stdout.write(`installed: ${JSON.stringify(recorded.installedIds)}\n`);
  await skinStep("checked", [["POST", "/webui/skins/update"]]);
  await skinStep("defaultSwitched", [["PUT", "/webui/skins/default", { skinId: releaseId }]]);
  await skinStep("unknownDefault", [["PUT", "/webui/skins/default", { skinId: "no-such-skin" }]]);
  await skinStep("serverStopped", [["POST", "/webui/server/stop"]]);
  await skinStep("stoppedAgain", [["POST", "/webui/server/stop"]]);
  await skinStep("serverStarted", [["POST", "/webui/server/start"]]);
  await skinStep("startedAgain", [["POST", "/webui/server/start"]]);
  await skinStep("bundledRemoveRefused", [["DELETE", "/webui/skins/insight"]]);
  await skinStep("unknownRemoved", [["DELETE", "/webui/skins/no-such-skin"]]);
  const defaultId = () => send("GET", "/webui/skins/default").then((answer) => answer.response.body?.id);
  if (branchId && branchId !== (await defaultId())) await skinStep("removed", [["DELETE", `/webui/skins/${branchId}`]]);

  // The same through the probe plugin's `host.localApi`: the default switched away and served, then switched back and
  // served again, so that `defaultRemoved` removes the Skin being served.
  await step("probeInstalled", await installProbe(), ["/plugins"]);
  await localApi(
    "localApi",
    [
      { path: "/api/v1/webui/skins/default", options: { method: "PUT", body: { skinId: "passione" } } },
      { path: "/api/v1/webui/server/stop", options: { method: "POST" } },
      { path: "/api/v1/webui/server/start", options: { method: "POST" } },
      { path: "/api/v1/webui/server/status" },
      { path: "/api/v1/webui/skins/update", options: { method: "POST" } },
      { path: "/api/v1/webui/skins/no-such-skin", options: { method: "DELETE" } },
      { path: "/api/v1/webui/skins/install/url", options: { method: "POST", body: { url: ZIP } } },
      { path: "/api/v1/webui/skins/default", options: { method: "PUT", body: { skinId: releaseId } } },
      { path: "/api/v1/webui/server/stop", options: { method: "POST" } },
      { path: "/api/v1/webui/server/start", options: { method: "POST" } },
    ],
    SKIN_READS,
  );

  await skinStep("defaultRemoved", [["DELETE", `/webui/skins/${await defaultId()}`]]);
  await skinStep("startAfterDefaultRemoved", [
    ["POST", "/webui/server/stop"],
    ["POST", "/webui/server/start"],
  ]);
}

writeFileSync(output, `${JSON.stringify(recorded, null, 2)}\n`);
