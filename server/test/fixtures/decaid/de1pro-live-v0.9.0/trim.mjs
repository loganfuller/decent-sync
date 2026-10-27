// Trims the recordings `record.mjs` made into this directory's fixtures, with hardware ids and LAN addresses scrubbed,
// and prints each stream's rates in each Machine State (README.md beside this script).
//
//   node server/test/fixtures/decaid/de1pro-live-v0.9.0/trim.mjs <recording> <Steam Record> \
//     <Two Tap Stop recording> <Two Tap Stop Steam Record>
//
// The first recording holds the whole run with Steam Purge Mode Normal, the second the steaming with Two Tap Stop. Each
// Steam Record is Decaid's `GET /api/v1/steams/{id}` of the steaming recorded, saved as it answered.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 4) {
  throw new Error("Usage: trim.mjs <recording> <Steam Record> <Two Tap Stop recording> <Two Tap Stop Steam Record>");
}
const [normalFile, normalSteamRecordFile, twoTapFile, twoTapSteamRecordFile] = args;
const HERE = dirname(fileURLToPath(import.meta.url));

// Bluetooth addresses become ones in the documentation range, the machine's and scale's as in `../de1pro-v0.8.7/`, and
// IPv4 addresses one in 192.0.2.0/24.
const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i;
const fakes = new Map();
const scrub = (value) =>
  JSON.parse(JSON.stringify(value), (_, v) => {
    if (typeof v !== "string") return v;
    if (MAC.test(v)) {
      if (!fakes.has(v)) fakes.set(v, `00:00:5E:00:53:${String(fakes.size + 1).padStart(2, "0")}`);
      return fakes.get(v);
    }
    return v.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "192.0.2.10");
  });

/** A recording's frames, each with its arrival in ms, and its machine frames. */
function read(file) {
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => JSON.parse(text));
  // Each socket's first frame is then the one it sent as it opened.
  if (lines.some((line) => line.event === "close")) throw new Error(`A socket closed in ${file}`);
  const frames = lines
    .filter((line) => "frame" in line && line.source !== "sensors")
    .map((line) => ({ ...line, ms: Date.parse(line.at) }));
  for (const { frame } of frames.filter((line) => line.source === "devices")) {
    for (const { id, type } of frame.devices) {
      if (MAC.test(id) && !fakes.has(id)) fakes.set(id, type === "machine" ? "00:00:5E:00:53:01" : "00:00:5E:00:53:02");
    }
  }
  return { frames, machine: frames.filter((line) => line.source === "machine") };
}

const stateOf = (line) => line.frame.state.state;

/** The runs of machine frames in one of the states, each as [first, last]. */
function runs({ machine }, states) {
  const found = [];
  for (let i = 0; i < machine.length; i++) {
    if (!states.includes(stateOf(machine[i]))) continue;
    let end = i;
    while (end + 1 < machine.length && states.includes(stateOf(machine[end + 1]))) end++;
    found.push([machine[i], machine[end]]);
    i = end;
  }
  if (found.length === 0) throw new Error(`No ${states.join(" or ")} was recorded`);
  return found;
}

/** Every source's frames from `from` to `to` (ms, inclusive), each at its ms since the first. */
function window({ frames }, from, to) {
  const inside = frames.filter((line) => line.ms >= from && line.ms <= to);
  return inside.map((line) => ({ ms: line.ms - inside[0].ms, source: line.source, frame: scrub(line.frame) }));
}

/** The frame each socket sent as it opened, at its ms since the first. */
function opening({ frames }) {
  const first = new Map();
  for (const line of frames) if (!first.has(line.source)) first.set(line.source, line);
  const lines = [...first.values()];
  return lines.map((line) => ({ ms: line.ms - lines[0].ms, source: line.source, frame: scrub(line.frame) }));
}

/** A run of the states, from 2 s before it to 3 s after it, the Machine idle again by then. */
const around = (recording, [first, last]) => window(recording, first.ms - 2000, last.ms + 3000);

/** Writes a fixture's frames one to a line. */
function writeFrames(name, frames) {
  const lines = frames.map((frame) => `    ${JSON.stringify(frame)}`).join(",\n");
  writeFileSync(join(HERE, name), `{\n  "frames": [\n${lines}\n  ]\n}\n`);
}

/** Writes a Steam Record as Decaid stored it, with any Barista or drinker named as in the other fixtures. */
function writeSteamRecord(name, file) {
  const record = scrub(JSON.parse(readFileSync(file, "utf8")));
  const context = record.workflow?.context;
  for (const key of ["baristaName", "drinkerName"]) if (context?.[key]) context[key] = "Fixture Barista";
  writeFileSync(join(HERE, name), `${JSON.stringify(record, null, 2)}\n`);
}

const normal = read(normalFile);
const twoTap = read(twoTapFile);

const slept = normal.machine.find((line, i) => i > 0 && stateOf(line) === "sleeping" && stateOf(normal.machine[i - 1]) !== "sleeping");
if (!slept) throw new Error("The Machine was not recorded going to sleep");
const twoTapSteaming = runs(twoTap, ["steam"]).find(([first, last]) =>
  twoTap.machine.some((line) => line.ms >= first.ms && line.ms <= last.ms && line.frame.state.substate === "puffing"),
);
if (!twoTapSteaming) throw new Error("No steaming with puffing was recorded");
const scaleConnected = normal.frames.find((line) => line.source === "scale" && line.frame.status === "connected");
if (!scaleConnected) throw new Error("The scale was not recorded connecting");

writeFrames("opening.json", opening(normal));
writeFrames("opening-scale-connected.json", opening(twoTap));
writeFrames("scale-connects.json", window(normal, scaleConnected.ms - 2000, scaleConnected.ms + 3000));
writeFrames("shot.json", around(normal, runs(normal, ["espresso", "skipStep"])[0]));
writeFrames("steam.json", around(normal, runs(normal, ["steam"])[0]));
writeFrames("steam-two-tap-stop.json", around(twoTap, twoTapSteaming));
writeFrames("flush.json", around(normal, runs(normal, ["flush"])[0]));
writeFrames("hot-water.json", around(normal, runs(normal, ["hotWater"])[0]));
writeFrames("needs-water.json", around(normal, runs(normal, ["needsWater"])[0]));
writeFrames("idle.json", window(normal, slept.ms - 35_000, slept.ms - 5000));
writeFrames("asleep.json", window(normal, slept.ms - 5000, slept.ms + 30_000));
writeSteamRecord("steam-record.json", normalSteamRecordFile);
writeSteamRecord("steam-record-two-tap-stop.json", twoTapSteamRecordFile);

// Rates: each source's frames a second while the Machine was in each state, by the state of the latest machine frame
// before each one, over the whole of the first recording.
const spans = new Map();
const counts = new Map();
let current = null;
for (const line of normal.frames) {
  if (line.source === "machine") {
    if (current) spans.set(current.state, (spans.get(current.state) ?? 0) + (line.ms - current.ms));
    current = { state: stateOf(line), ms: line.ms };
  }
  if (!current) continue;
  const key = `${current.state} ${line.source}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const intervals = new Map();
for (let i = 1; i < normal.machine.length; i++) {
  const state = stateOf(normal.machine[i]);
  if (state !== stateOf(normal.machine[i - 1])) continue;
  intervals.set(state, [...(intervals.get(state) ?? []), normal.machine[i].ms - normal.machine[i - 1].ms]);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sources = ["machine", "waterLevels", "scale", "devices", "shotState", "shotSettings"];
console.log(`| State | Seconds | ${sources.map((source) => `\`${source}\``).join(" | ")} | \`machine\`'s median interval |`);
console.log(`|---|---|${sources.map(() => "---|").join("")}---|`);
for (const [state, span] of spans) {
  const rates = sources.map((source) => ((counts.get(`${state} ${source}`) ?? 0) / (span / 1000)).toFixed(2));
  console.log(`| \`${state}\` | ${(span / 1000).toFixed(0)} | ${rates.join(" | ")} | ${median(intervals.get(state) ?? [0])} ms |`);
}
