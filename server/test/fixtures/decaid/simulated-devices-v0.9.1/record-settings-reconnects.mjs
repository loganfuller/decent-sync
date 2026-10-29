// Records what Decaid keeps of the machine's settings as its simulated machine reconnects and Decaid restarts
// (README.md beside this script): each step's requests, then the reads of the machine's settings and advanced
// settings.
//
//   node server/test/fixtures/decaid/simulated-devices-v0.9.1/record-settings-reconnects.mjs <output file>
//
// It reads DECAID from the environment for another address than http://localhost:8080. Every request goes to a
// throwaway Decaid with its simulated machine connected: it changes the machine's settings, disconnects and connects
// the machine, and resets its settings. At the steps `restarted` and `restartedAfterReset` it asks for Decaid to be
// restarted with its data kept, and waits until Decaid has stopped answering and answers again with its machine
// connected.
import { writeFileSync } from "node:fs";

const API = `${process.env.DECAID ?? "http://localhost:8080"}/api/v1`;
const MACHINE = "MockDe1";
const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: record-settings-reconnects.mjs <output file>");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(method, path, body) {
  const response = await fetch(API + path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const answered = await response.text();
  let parsed;
  try {
    parsed = answered === "" ? null : JSON.parse(answered);
  } catch {
    parsed = answered;
  }
  return { request: { method, path, ...(body === undefined ? {} : { body }) }, response: { status: response.status, body: parsed } };
}

/** The machine's settings routes, read after each step. */
const READS = ["/machine/settings", "/machine/settings/advanced"];

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

// Each step's requests, as [method, path, body], then what to wait for before the reads.
const disconnect = ["PUT", "/devices/disconnect", { deviceId: MACHINE }];
const connect = ["PUT", "/devices/connect", { deviceId: MACHINE }];
const steps = [
  ["started", [], async () => {}],
  [
    "written",
    [
      ["POST", "/machine/settings", { fan: 45, steamPurgeMode: 1 }],
      ["POST", "/machine/settings/advanced", { heaterIdleTemp: 96, refillKitSetting: 1 }],
    ],
    async () => {},
  ],
  // Disconnecting the machine is answered before Decaid has let it go; a moment more lets it settle.
  ["disconnected", [disconnect], () => sleep(3000)],
  ["reconnected", [connect], machineConnected],
  ["fanWritten", [["POST", "/machine/settings", { fan: 40 }]], async () => {}],
  ["reconnectedAgain", [disconnect, "settle", connect], machineConnected],
  ["restarted", [], restarted],
  ["reset", [["DELETE", "/machine/settings/reset"]], async () => {}],
  ["restartedAfterReset", [], restarted],
];

await machineConnected();
const recorded = {};
for (const [name, requests, then] of steps) {
  const exchanges = [];
  for (const request of requests) {
    if (request === "settle") await sleep(3000);
    else exchanges.push(await send(...request));
  }
  await then();
  const reads = {};
  for (const path of READS) reads[path] = (await send("GET", path)).response;
  recorded[name] = { exchanges, reads };
  console.log(`${name}: ${exchanges.map((exchange) => exchange.response.status).join(", ") || "-"} ${JSON.stringify(reads)}`);
}
writeFileSync(output, `${JSON.stringify(recorded, null, 2)}\n`);
