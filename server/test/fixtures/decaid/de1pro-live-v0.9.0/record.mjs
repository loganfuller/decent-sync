// Records Decaid's local streams on a tablet (README.md beside this script), read-only: it opens Decaid's local
// WebSockets and sends nothing on them, and makes only `GET` requests.
//
//   DECAID=http://<tablet>:8080 node server/test/fixtures/decaid/de1pro-live-v0.9.0/record.mjs <output file>
//
// Each line it appends to the output is one JSON object: `{ at, source, frame }` for a frame, `at` this computer's UTC
// time it arrived, or `{ at, source, event }` when a socket opens or closes. A closed socket is opened again after 2 s.
// Ctrl-C ends it.
import { appendFileSync } from "node:fs";

const DECAID = process.env.DECAID ?? "http://localhost:8080";
const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: record.mjs <output file>");

const SOCKETS = {
  machine: "/ws/v1/machine/snapshot",
  waterLevels: "/ws/v1/machine/waterLevels",
  scale: "/ws/v1/scale/snapshot",
  shotSettings: "/ws/v1/machine/shotSettings",
  devices: "/ws/v1/devices",
  shotState: "/ws/v1/machine/shotState",
};
const SENSORS_EVERY_MS = 30_000;

const write = (line) => appendFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);

const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const open = new Map();

/** Opens a socket, and opens it again 2 s after it closes. */
function listen(source, path) {
  const socket = new WebSocket(DECAID.replace(/^http/, "ws") + path);
  open.set(source, socket);
  socket.addEventListener("open", () => write({ source, event: "open" }));
  socket.addEventListener("message", ({ data }) => write({ source, frame: parsed(String(data)) }));
  socket.addEventListener("error", () => write({ source, event: "error" }));
  socket.addEventListener("close", ({ code, reason }) => {
    write({ source, event: "close", code, reason });
    if (open.get(source) !== socket) return;
    open.delete(source);
    setTimeout(() => {
      if (!open.has(source)) listen(source, path);
    }, 2000);
  });
}

/** Lists the sensors, recording the answer, and listens to each one's snapshot socket not yet open. */
async function sensors() {
  try {
    const response = await fetch(`${DECAID}/api/v1/sensors`, { signal: AbortSignal.timeout(10_000) });
    const body = parsed(await response.text());
    write({ source: "sensors", status: response.status, frame: body });
    for (const { id } of Array.isArray(body) ? body : []) {
      const source = `sensor:${id}`;
      if (!open.has(source)) listen(source, `/ws/v1/sensors/${encodeURIComponent(id)}/snapshot`);
    }
  } catch (error) {
    write({ source: "sensors", event: "error", reason: String(error) });
  }
}

for (const [source, path] of Object.entries(SOCKETS)) listen(source, path);
await sensors();
setInterval(sensors, SENSORS_EVERY_MS);
