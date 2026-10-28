// Records Decaid's local sockets as its simulated machine is disconnected and connected again (README.md beside this
// script), from a computer that reaches Decaid's API:
//
//   DECAID=http://localhost:8080 node server/test/fixtures/decaid/simulated-devices-v0.9.0/record-machine-disconnects.mjs <output file>
//
// It opens the sockets the Live View reads and sends nothing on them. 4 s later it disconnects the machine with
// `PUT /api/v1/devices/disconnect`, and 8 s after that connects it again with `PUT /api/v1/devices/connect`, then
// records 8 s more. It writes `{ "frames": [{ ms, source, frame }] }`, `ms` since the first frame, and prints each
// request's answer and each socket's opening and closing.
import { writeFileSync } from "node:fs";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const MACHINE = "MockDe1";
const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: record-machine-disconnects.mjs <output file>");

const SOCKETS = {
  machine: "/ws/v1/machine/snapshot",
  waterLevels: "/ws/v1/machine/waterLevels",
  scale: "/ws/v1/scale/snapshot",
  shotSettings: "/ws/v1/machine/shotSettings",
  devices: "/ws/v1/devices",
};

const frames = [];
let first;
const log = (line) => console.log(new Date().toISOString(), line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [source, path] of Object.entries(SOCKETS)) {
  const socket = new WebSocket(DECAID.replace(/^http/, "ws") + path);
  socket.addEventListener("open", () => log(`${source} opened`));
  socket.addEventListener("message", ({ data }) => {
    const now = Date.now();
    first ??= now;
    frames.push({ ms: now - first, source, frame: JSON.parse(String(data)) });
  });
  socket.addEventListener("close", ({ code, reason }) => log(`${source} closed: ${code} ${reason}`));
}

async function request(method, path, body) {
  const response = await fetch(DECAID + path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  log(`${method} ${path}: ${response.status} ${await response.text()}`);
}

await sleep(4_000);
await request("GET", "/api/v1/devices");
await request("PUT", "/api/v1/devices/disconnect", { deviceId: MACHINE });
await sleep(8_000);
await request("GET", "/api/v1/devices");
await request("GET", "/api/v1/machine/info");
await request("PUT", "/api/v1/devices/connect", { deviceId: MACHINE });
await sleep(8_000);
await request("GET", "/api/v1/devices");
// One frame a line, as the other live fixtures are written (`trim.mjs` in ../de1pro-live-v0.9.0/).
writeFileSync(output, `{\n  "frames": [\n${frames.map((frame) => `    ${JSON.stringify(frame)}`).join(",\n")}\n  ]\n}\n`);
process.exit(0);
