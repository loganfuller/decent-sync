// Records the ids Decaid v0.9.2 gives profiles (README.md beside this script): every profile it bundles, as a new
// install lists them, and its answers to profiles posted to it that differ in what its hash covers, or only in
// what it leaves out of the hash or normalises away.
//
//   node server/test/fixtures/decaid/profile-ids-v0.9.2/record.mjs <output>
//
// It reads DECAID from the environment for another address than http://localhost:8080. Every request goes to a
// throwaway Decaid with new data: it creates profiles there.
import { writeFileSync } from "node:fs";

const API = `${process.env.DECAID ?? "http://localhost:8080"}/api/v1`;
const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: record.mjs <output>");

/** Sends a request and gives it with the status and body Decaid answered, the body's JSON parsed. */
async function send(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

/** A made-up profile of two steps: a flow fill that exits on pressure under a pressure limit, then a pressure ramp. */
function base() {
  return {
    version: "2",
    title: "Id case",
    author: "Decent Sync",
    notes: "Made up for the recording.",
    beverage_type: "espresso",
    steps: [
      { name: "fill", pump: "flow", transition: "fast", exit: { type: "pressure", condition: "over", value: 4 }, volume: 0, seconds: 8, temperature: 92, sensor: "coffee", flow: 6, limiter: { value: 4, range: 0.6 } },
      { name: "pour", pump: "pressure", transition: "smooth", exit: null, volume: 0, seconds: 30, weight: null, temperature: 92, sensor: "coffee", pressure: 9, limiter: null },
    ],
    target_volume: 0,
    target_weight: 36,
    target_volume_count_start: 0,
    tank_temperature: 0,
  };
}

/** The base profile changed by `change`, which edits a copy in place. */
function changed(change) {
  const profile = base();
  change(profile);
  return profile;
}

/** Each case's name, what it changes from the base profile, and whether Decaid's id should be the base profile's. */
const CASES = [
  ["base", base(), "base"],
  ["weightZero", changed((p) => (p.steps[0].weight = 0)), "differs"],
  ["weightNull", changed((p) => (p.steps[0].weight = null)), "base"],
  ["limiterZero", changed((p) => (p.steps[1].limiter = { value: 0, range: 0.6 })), "differs"],
  ["limiterAbsent", changed((p) => delete p.steps[1].limiter), "base"],
  ["exitAbsent", changed((p) => delete p.steps[1].exit), "base"],
  [
    "numbersAsText",
    changed((p) => {
      p.steps[0] = { ...p.steps[0], seconds: "8", temperature: "92.0", flow: "6", volume: "0", exit: { ...p.steps[0].exit, value: "4" }, limiter: { value: "4", range: "0.6" } };
      p.target_weight = "36";
      p.target_volume = "0";
      p.target_volume_count_start = "0";
      p.tank_temperature = "0";
    }),
    "base",
  ],
  ["stepRenamed", changed((p) => (p.steps[0].name = "Fill")), "differs"],
  ["retitled", changed((p) => Object.assign(p, { title: "Another title", author: "Someone else", notes: "Other notes." })), "base"],
  ["versionAbsent", changed((p) => delete p.version), "differs"],
  ["versionNumber", changed((p) => (p.version = 2)), "base"],
  ["beverageCapitalised", changed((p) => (p.beverage_type = "Espresso")), "base"],
  ["beverageUnknown", changed((p) => (p.beverage_type = "latte")), "base"],
  ["beverageFilter", changed((p) => (p.beverage_type = "pourover")), "differs"],
  ["targetsNull", changed((p) => Object.assign(p, { target_weight: null, target_volume: null })), "differs"],
  ["countStartFraction", changed((p) => (p.target_volume_count_start = 1.7)), "differs"],
  ["countStartOne", changed((p) => (p.target_volume_count_start = 1)), "countStartFraction"],
  [
    "unknownFields",
    changed((p) => {
      p.lang = "en";
      p.steps[0].extra = 1;
      p.steps[0].exit.extra = 1;
      p.steps[0].limiter.extra = 1;
    }),
    "base",
  ],
  ["fractions", changed((p) => Object.assign(p.steps[1], { pressure: 8.6, seconds: 27.25, temperature: 91.5 })), "differs"],
];

const bundled = await send("GET", "/profiles?includeHidden=true");
if (bundled.response.status !== 200 || !Array.isArray(bundled.response.body)) throw new Error("Decaid did not list its profiles");
if (bundled.response.body.some((record) => !record.isDefault)) throw new Error("Decaid's data is not new: it holds a profile of its own making");

const posted = [];
for (const [name, profile, sameIdAs] of CASES) {
  posted.push({ name, sameIdAs, ...(await send("POST", "/profiles", { profile })) });
}

writeFileSync(output, `${JSON.stringify({ bundled: bundled.response.body, posted }, null, 2)}\n`);
console.log(`${bundled.response.body.length} bundled profiles, ${posted.length} posted`);
