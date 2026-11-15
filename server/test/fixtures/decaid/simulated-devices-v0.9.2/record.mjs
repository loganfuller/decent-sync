// Records what Decaid v0.9.2 keeps of the machine's settings as its simulated machine reconnects and Decaid restarts,
// and what `POST /settings` answers the changes that need a token (README.md beside this script): each step's
// requests, then the reads after them.
//
//   DECAID_EXTENSIONS_TOKEN=<token> node server/test/fixtures/decaid/simulated-devices-v0.9.2/record.mjs <settings-reconnects output> <settings-gate output>
//
// It reads DECAID from the environment for another address than http://localhost:8080, and
// DECAID_EXTENSIONS_TOKEN for the token Decaid was started with (`--extensions-token`, or the same variable in its
// own environment), which it sends where a step says so and never writes to a file. Every request goes to a throwaway
// Decaid with its simulated machine connected and new data: it changes the machine's settings and Decaid's own,
// disconnects and connects the machine, and resets its settings. At the steps `restarted` and `restartedAfterReset`
// it asks for Decaid to be restarted with its data kept, and waits until Decaid has stopped answering and answers
// again with its machine connected.
import { writeFileSync } from "node:fs";

const API = `${process.env.DECAID ?? "http://localhost:8080"}/api/v1`;
const TOKEN = process.env.DECAID_EXTENSIONS_TOKEN;
const MACHINE = "MockDe1";
const [reconnectsOutput, gateOutput] = process.argv.slice(2);
if (!reconnectsOutput || !gateOutput || !TOKEN) throw new Error("Usage: DECAID_EXTENSIONS_TOKEN=<token> record.mjs <settings-reconnects output> <settings-gate output>");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The bearer token each kind of request carries: Decaid's own, or one it does not know, of the same length. */
const BEARERS = { launch: TOKEN, unknown: "0".repeat(64) };

/** Sends a request, with a bearer token where `token` names one, kept in the recording by that name only. */
async function send(method, path, body, token) {
  const response = await fetch(API + path, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token === undefined ? {} : { Authorization: `Bearer ${BEARERS[token]}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answered = await response.text();
  let parsed;
  try {
    parsed = answered === "" ? null : JSON.parse(answered);
  } catch {
    parsed = answered;
  }
  return { request: { method, path, ...(body === undefined ? {} : { body }), ...(token === undefined ? {} : { token }) }, response: { status: response.status, body: parsed } };
}

/**
 * Waits until the machine is connected, then 5 s more: Decaid answers as the machine connects, and writes what it
 * keeps for it, or its defaults, just after (`_setDe1DefaultsFor` in decaid:lib/src/controllers/de1_controller.defaults.dart).
 */
async function machineConnected() {
  for (let waited = 0; ; waited += 1000) {
    const answer = await send("GET", "/machine/settings").catch(() => undefined);
    if (answer?.response.status === 200) break;
    if (waited > 120_000) throw new Error("Decaid's simulated machine did not connect");
    await sleep(1000);
  }
  await sleep(5000);
}

/** Waits until Decaid stops answering, then until it answers again with its machine connected. */
async function restarted() {
  console.log("Restart Decaid now, keeping its data.");
  for (let waited = 0; ; waited += 500) {
    if ((await fetch(`${API}/info`).catch(() => undefined)) === undefined) break;
    if (waited > 300_000) throw new Error("Decaid was not stopped");
    await sleep(500);
  }
  await machineConnected();
}

/** Carries out each step, as [name, requests, what to wait for before the reads], and gives every step's exchanges and reads of `routes`. */
async function record(steps, routes) {
  const recorded = {};
  for (const [name, requests, then = async () => {}] of steps) {
    const exchanges = [];
    for (const request of requests) {
      if (request === "settle") await sleep(3000);
      else exchanges.push(await send(...request));
    }
    await then();
    const reads = {};
    for (const path of routes) reads[path] = (await send("GET", path)).response;
    recorded[name] = { exchanges, reads };
    console.log(`${name}: ${exchanges.map((exchange) => exchange.response.status).join(", ") || "-"}`);
  }
  return recorded;
}

await machineConnected();

// The changes of Decaid's own settings that need a token, without one, then with one. Each request is
// [method, path, body, the token it carries, if any].
const { webUiPath, defaultSkinId } = (await send("GET", "/settings")).response.body;
const skins = (await send("GET", "/webui/skins")).response.body.map((skin) => skin.id);
const otherSkin = skins.find((id) => id === "insight");
if (!otherSkin || defaultSkinId === otherSkin) throw new Error(`Expected the skin insight beside the default one, ${defaultSkinId}: ${skins.join(", ")}`);
const settings = (body, token) => ["POST", "/settings", body, token];
const gate = await record(
  [
    ["started", []],
    // Not a change: the setting is on already.
    ["updateChecksOnWhileOn", [settings({ automaticUpdateCheck: true })]],
    ["updateChecksOff", [settings({ automaticUpdateCheck: false })]],
    ["updateChecksOnRefused", [settings({ themeMode: "dark", automaticUpdateCheck: true })]],
    ["updateChecksOnUnknownToken", [settings({ themeMode: "dark", automaticUpdateCheck: true }, "unknown")]],
    // Not a change: the default skin as it is.
    ["sameSkin", [settings({ defaultSkinId })]],
    ["skinRefused", [settings({ keepAwake: false, defaultSkinId: otherSkin })]],
    // The path it serves already is refused all the same.
    ["webUiPathRefused", [settings({ keepAwake: false, webUiPath })]],
    ["updateChecksOnWithToken", [settings({ themeMode: "dark", automaticUpdateCheck: true }, "launch")]],
    ["skinWithToken", [settings({ defaultSkinId: otherSkin }, "launch")]],
    ["skinBackWithToken", [settings({ defaultSkinId }, "launch")]],
    ["webUiPathWithToken", [settings({ webUiPath }, "launch")]],
  ],
  ["/settings", "/webui/skins/default"],
);
writeFileSync(gateOutput, `${JSON.stringify(gate, null, 2)}\n`);

// What Decaid keeps of the machine's settings.
const disconnect = ["PUT", "/devices/disconnect", { deviceId: MACHINE }];
const connect = ["PUT", "/devices/connect", { deviceId: MACHINE }];
const reconnects = await record(
  [
    ["started", []],
    [
      "written",
      [
        ["POST", "/machine/settings", { fan: 45, steamPurgeMode: 1 }],
        ["POST", "/machine/settings/advanced", { heaterIdleTemp: 96, refillKitSetting: 1 }],
        ["POST", "/machine/calibration", { flowMultiplier: 1.2 }],
      ],
    ],
    // Disconnecting the machine is answered before Decaid has let it go; a moment more lets it settle.
    ["disconnected", [disconnect], () => sleep(3000)],
    ["reconnected", [connect], machineConnected],
    ["fanWritten", [["POST", "/machine/settings", { fan: 40 }]]],
    ["reconnectedAgain", [disconnect, "settle", connect], machineConnected],
    ["restarted", [], restarted],
    ["reset", [["DELETE", "/machine/settings/reset"]]],
    ["restartedAfterReset", [], restarted],
  ],
  ["/machine/settings", "/machine/settings/advanced", "/machine/calibration"],
);
writeFileSync(reconnectsOutput, `${JSON.stringify(reconnects, null, 2)}\n`);
