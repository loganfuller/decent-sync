// Records Decaid's plugin list and Skins (README.md beside this script):
// each step's request, then `GET /plugins`, `/webui/skins`,
// `/webui/skins/default` and `/webui/server/status` as Decaid answered them,
// one the same as that route's previous read kept as `"unchanged": true`.
//
//   node server/test/fixtures/decaid/plugins-and-skins-v0.9.0/record.mjs <output file>
//
// It reads DECAID from the environment for another address than
// http://localhost:8080. Every request goes to a throwaway Decaid: it
// installs, disables and switches plugins and Skins.
import { writeFileSync } from "node:fs";

const API = `${process.env.DECAID ?? "http://localhost:8080"}/api/v1`;
const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: record.mjs <output file>");

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

/** What the plugin reads: the plugin list and the three Skins routes, one after another. */
async function reads() {
  const answers = {};
  for (const path of ["/plugins", "/webui/skins", "/webui/skins/default", "/webui/server/status"]) {
    const { response } = await send("GET", path);
    answers[path] = response;
  }
  return answers;
}

const steps = [
  ["started", []],
  ["dye2Release", [["POST", "/plugins/install/github-release", { repo: "decentespresso/dye2" }]]],
  ["dye2Disabled", [["POST", "/plugins/dye2.reaplugin/disable"]]],
  ["dye2Enabled", [["POST", "/plugins/dye2.reaplugin/enable"]]],
  ["dye2Branch", [["POST", "/plugins/install/github-branch", { repo: "decentespresso/dye2", branch: "dist" }]]],
  ["streamlineRelease", [["POST", "/webui/skins/install/github-release", { repo: "decentespresso/streamline-js" }]]],
  ["streamlineMain", [["POST", "/webui/skins/install/github-branch", { repo: "decentespresso/streamline-js", branch: "dist" }]]],
  ["defaultSwitched", [["PUT", "/webui/skins/default", { skinId: "streamline.js-dist" }]]],
  // Decaid's settings serve the folder named (`webUiPath` in settings_handler.dart), as Quick Settings serves a Skin:
  // the new default, then a Skin other than the default.
  ["servedMain", [["POST", "/settings", { webUiPath: "/root/.local/share/decaid/web-ui/streamline.js-dist" }]]],
  ["servedOther", [["POST", "/settings", { webUiPath: "/root/.local/share/decaid/web-ui/passione" }]]],
  ["serverStopped", [["POST", "/webui/server/stop"]]],
];

// Decaid answers before it has loaded its plugins and Skins: until then its plugin list and Skins are empty, the
// default Skin 404 and nothing is served. The first step waits for both.
for (let waited = 0; ; waited += 1000) {
  const plugins = (await send("GET", "/plugins")).response.body;
  const status = (await send("GET", "/webui/server/status")).response.body;
  if (Array.isArray(plugins) && plugins.length > 0 && status?.serving === true) break;
  if (waited > 120_000) throw new Error("Decaid did not load its plugins and serve a Skin");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const recorded = {};
/** Each route's last answer, so one read again unchanged is kept as `"unchanged": true` in place of its body. */
const lastRead = new Map();
for (const [name, requests] of steps) {
  const exchanges = [];
  for (const [method, path, body] of requests) exchanges.push(await send(method, path, body));
  // Decaid answers an install or switch once it is done; a moment more lets a plugin's load settle.
  if (requests.length > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
  const answers = await reads();
  for (const [path, answer] of Object.entries(answers)) {
    const text = JSON.stringify(answer);
    if (lastRead.get(path) === text) answers[path] = { status: answer.status, unchanged: true };
    lastRead.set(path, text);
  }
  recorded[name] = { exchanges, reads: answers };
  process.stdout.write(`${name}: ${exchanges.map((exchange) => exchange.response.status).join(", ") || "-"}\n`);
}
writeFileSync(output, `${JSON.stringify(recorded, null, 2)}\n`);
