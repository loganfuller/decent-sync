// Records what Decaid v0.9.3 does with a plugin's notices: what `host.notify` and `host.dismissNotification` return,
// the `notificationResult` events that follow, and what its notification center then holds (README.md beside this
// script). One phase a run, as Decaid is restarted between them:
//
//   DECAID=<address> CENTER="<command>" node server/test/fixtures/decaid/notices-v0.9.3/record.mjs <phase> <output file>
//
// The phases are `fresh` (a new Decaid) and `restarted` (the same Decaid started again). CENTER is a shell command
// that prints Decaid's shared_preferences.json, where the center is kept, such as a `docker exec … cat` of it.
// Every request goes to a throwaway Decaid: it installs, configures, disables and enables a plugin.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.DECAID ?? "http://localhost:8080";
const API = `${BASE}/api/v1`;
const [phase, output] = process.argv.slice(2);
if (!["fresh", "restarted"].includes(phase) || !output || !process.env.CENTER) {
  throw new Error("Usage: CENTER=<command> record.mjs <fresh|restarted> <output file>");
}

const PROBE = "notice-probe.reaplugin";
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

/** The notification center as Decaid saved it: the stored snapshot, parsed, under whatever key it is kept. */
function center() {
  const preferences = JSON.parse(execSync(process.env.CENTER, { encoding: "utf8" }));
  const key = Object.keys(preferences).find((name) => name.endsWith("private.notificationCenter.v1"));
  if (key === undefined) return { key: null };
  const value = preferences[key];
  return { key, value: typeof value === "string" ? JSON.parse(value) : value };
}

const recorded = {};

/** A step of requests to Decaid's API, then what the center holds. */
async function step(name, requests) {
  const exchanges = [];
  for (const [method, path, body] of requests) exchanges.push(await send(method, path, body));
  await pause(2000);
  recorded[name] = { exchanges, center: center() };
  process.stdout.write(`${name}: ${exchanges.map((exchange) => exchange.response.status).join(", ")}\n`);
}

/** A step of calls the probe makes, what each returned and the events that followed, then what the center holds. */
async function probe(name, calls) {
  const answer = await send("POST", `/plugins/${PROBE}/call`, { calls });
  await pause(500);
  recorded[name] = { calls, answer: answer.response, center: center() };
  const events = answer.response.body?.events ?? [];
  process.stdout.write(`${name}: ${answer.response.status}, ${events.map((event) => event.payload?.status ?? event.name).join(", ")}\n`);
}

const notify = (notice) => ({ op: "notify", notice });
const dismiss = (id) => (id === undefined ? { op: "dismiss" } : { op: "dismiss", id });

if (phase === "fresh") {
  await step("installed", [
    ["PUT", `/plugins/${PROBE}/source`, { manifest: JSON.parse(probeFile("manifest.json")), plugin: probeFile("plugin.js") }],
    ["POST", `/plugins/${PROBE}/enable`],
  ]);
  await probe("published", [notify({ id: "sync", message: "First message." })]);
  await probe("publishedAgain", [notify({ id: "sync", message: "First message." })]);
  await probe("changed", [notify({ id: "sync", message: "Second message." })]);
  await probe("lengths", [
    notify({ id: "long", message: "x".repeat(600) }),
    notify({ id: "tooLong", message: "x".repeat(601) }),
    notify({ id: "newlines", message: "One line.\nAnother line.\tTabbed." }),
    notify({ id: "bell", message: "A bell\u0007 in it." }),
    notify({ id: "blank", message: "   " }),
    notify({ id: "i".repeat(129), message: "An id too long." }),
    notify({ message: "No id." }),
  ]);
  // "sync", "long" and "newlines" are held, so two more fit in the plugin's five and the third does not.
  await probe("capacity", [
    notify({ id: "n4", message: "Fourth." }),
    notify({ id: "n5", message: "Fifth." }),
    notify({ id: "n6", message: "Sixth." }),
    notify({ id: "sync", message: "Third message." }),
  ]);
  await probe("dismissedOne", [dismiss("long"), dismiss("never-published")]);
  await probe("dismissedAll", [dismiss()]);
  await probe("publishedForReload", [notify({ id: "sync", message: "Held across a reload." })]);
  // Saving a plugin's settings reloads it.
  await step("reloaded", [["POST", `/plugins/${PROBE}/settings`, { Note: "reload" }]]);
  await probe("publishedAfterReload", [notify({ id: "sync", message: "Held across a reload." })]);
  await step("disabled", [["POST", `/plugins/${PROBE}/disable`]]);
  await step("enabled", [["POST", `/plugins/${PROBE}/enable`]]);
  await probe("publishedForRestart", [notify({ id: "sync", message: "Held across a restart." })]);
} else {
  await step("started", []);
  await probe("publishedAfterRestart", [notify({ id: "sync", message: "Held across a restart." })]);
  await probe("dismissedAfterRestart", [dismiss("sync")]);
}

writeFileSync(output, `${JSON.stringify(recorded, null, 2)}\n`);
