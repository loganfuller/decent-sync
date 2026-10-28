// Records Decaid's local sockets and its sensors with its simulated Bengle and milk probe (README.md beside this
// script), from a computer that reaches Decaid's API:
//
//   DECAID=http://localhost:8080 node server/test/fixtures/decaid/bengle-live-v0.9.0/record.mjs <output directory>
//
// It reads `GET /api/v1/sensors`, opens the sockets the Live View reads, the milk probe's among them, and sends
// nothing on them. 3 s later it starts steaming with `PUT /api/v1/machine/state/steam`, stops it 8 s after that with
// `PUT /api/v1/machine/state/idle`, and records 3 s more. Then it opens the probe's socket again for 2 s, and
// disconnects the Bengle with `PUT /api/v1/devices/disconnect`, reads the sensors and opens the probe's socket again.
// It writes `sensors.json`, `steam.json` and `probe-socket.json`, with the Bengle's device id replaced by a made-up one
// wherever it is part of an id, and prints each request's answer and each socket's opening and closing.
import { writeFileSync } from "node:fs";
import path from "node:path";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const BENGLE = "MockBengle";
/** Stands for the Bengle's device id, a Connection Id: an address in the range RFC 7042 reserves for documentation. */
const MADE_UP = "00:00:5E:00:53:21";
const ID_KEYS = new Set(["id", "deviceId", "sensorId", "preferredMachineId"]);
const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: record.mjs <output directory>");

const SOCKETS = {
  machine: "/ws/v1/machine/snapshot",
  waterLevels: "/ws/v1/machine/waterLevels",
  scale: "/ws/v1/scale/snapshot",
  shotSettings: "/ws/v1/machine/shotSettings",
  devices: "/ws/v1/devices",
};

const log = (line) => console.log(new Date().toISOString(), line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The value with the Bengle's device id replaced wherever it is part of an id. */
function scrub(value, key) {
  if (typeof value === "string") return ID_KEYS.has(key) ? value.replaceAll(BENGLE, MADE_UP) : value;
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]));
  return value;
}

async function request(method, path, body) {
  const response = await fetch(DECAID + path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const text = await response.text();
  log(`${method} ${path}: ${response.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
}

/** Opens a socket, recording each frame it sends as `{ ms, source, sensorId?, frame }`, `ms` since `start`, and how it closes. */
function record(source, socketPath, start, sensorId) {
  const frames = [];
  const recorded = { frames, closed: null };
  const socket = new WebSocket(DECAID.replace(/^http/, "ws") + socketPath);
  socket.addEventListener("open", () => log(`${source} ${socketPath} opened`));
  socket.addEventListener("message", ({ data }) => {
    frames.push({ ms: Date.now() - start, source, ...(sensorId ? { sensorId } : {}), frame: JSON.parse(String(data)) });
  });
  socket.addEventListener("close", ({ code, reason }) => {
    recorded.closed = { ms: Date.now() - start, code, reason };
    log(`${source} ${socketPath} closed: ${code} ${reason}`);
  });
  return { recorded, close: () => socket.close() };
}

const probeSocket = (id) => `/ws/v1/sensors/${encodeURIComponent(id)}/snapshot`;

/** Frames one a line, as the other live fixtures are written (`trim.mjs` in ../de1pro-live-v0.9.0/). */
const framesText = (frames, indent) => `[\n${frames.map((frame) => `${indent}  ${JSON.stringify(scrub(frame))}`).join(",\n")}\n${indent}]`;

const attached = await request("GET", "/api/v1/sensors");
const probe = attached.find((sensor) => sensor.id.endsWith("-milkprobe"));
if (!probe) throw new Error("No milk probe listed");

const start = Date.now();
const steam = [...Object.entries(SOCKETS).map(([source, socketPath]) => record(source, socketPath, start)), record("sensor", probeSocket(probe.id), start, probe.id)];
await sleep(3_000);
await request("PUT", "/api/v1/machine/state/steam");
await sleep(8_000);
await request("PUT", "/api/v1/machine/state/idle");
await sleep(3_000);
const steamFrames = steam.flatMap(({ recorded }) => recorded.frames).sort((a, b) => a.ms - b.ms);

// What the probe's socket sends as it opens once steaming is over: its last temperature, from then.
const reopenedAt = Date.now();
const reopened = record("sensor", probeSocket(probe.id), reopenedAt, probe.id);
await sleep(2_000);
reopened.close();

// While the Bengle is disconnected, its probe is not listed, and its socket answers that it is not found.
await request("PUT", "/api/v1/devices/disconnect", { deviceId: BENGLE });
await sleep(3_000);
const disconnected = await request("GET", "/api/v1/sensors");
const refusedAt = Date.now();
const refused = record("sensor", probeSocket(probe.id), refusedAt, probe.id);
await sleep(2_000);
refused.close();
log(`The first probe socket closed: ${JSON.stringify(steam.at(-1).recorded.closed)}`);

writeFileSync(
  path.join(output, "sensors.json"),
  `${JSON.stringify(scrub({ attached, machineDisconnected: disconnected }), null, 2)}\n`,
);
writeFileSync(path.join(output, "steam.json"), `{\n  "frames": ${framesText(steamFrames, "  ")}\n}\n`);
writeFileSync(
  path.join(output, "probe-socket.json"),
  `{\n  "opening": { "frames": ${framesText(reopened.recorded.frames, "    ")}, "closed": ${JSON.stringify(reopened.recorded.closed)} },\n` +
    `  "notFound": { "frames": ${framesText(refused.recorded.frames, "    ")}, "closed": ${JSON.stringify(refused.recorded.closed)} }\n}\n`,
);
process.exit(0);
