// Records Shots pulled on Decaid v0.9.2's simulated machine and scale, one for each of the bundled profiles named
// below, for the simulation of a profile on a Shot's puck (#577; README.md beside this script).
//
//   node server/test/fixtures/decaid/simulated-shots-v0.9.2/record.mjs <output directory> <file>...
//
// It pulls the Shots named by their files, such as `classic-italian`, in turn. Decaid v0.9.2 run headless starts its
// Shot sequencer for the first Shot after it starts and for no later one, so restart Decaid, keeping its data,
// before each run of this script, and name one file each time.
//
// It reads DECAID from the environment for another address than http://localhost:8080. Every request goes to a
// throwaway Decaid with its simulated machine and scale connected. For each profile it sets the Workflow's profile,
// dose and yield, wakes the machine, starts a Shot and waits for Decaid to record it, then writes Decaid's record of
// it (`GET /shots/{id}`) to `<file>.json` in the output directory.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const API = `${process.env.DECAID ?? "http://localhost:8080"}/api/v1`;
const [output, ...files] = process.argv.slice(2);
if (!output || files.length === 0) throw new Error("Usage: record.mjs <output directory> <file>...");

/**
 * The bundled profiles pulled, by title, each with the file its Shot is written to: those whose steps Decaid's
 * simulated machine runs as recorded Shots on a DE1 show (README.md).
 */
const SHOTS = [
  { title: "Classic Italian espresso", file: "classic-italian" },
  { title: "Blooming Espresso", file: "blooming" },
  { title: "Default", file: "default" },
  { title: "Gentle and sweet", file: "gentle-and-sweet" },
];
const DOSE = 18;
const YIELD = 36;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
}

/** Waits until `check` answers true, polling every 500 ms. */
async function until(what, check, limit = 180_000) {
  for (let waited = 0; ; waited += 500) {
    if (await check()) return;
    if (waited > limit) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

const info = await send("GET", "/machine/info");
if (info.serialNumber !== "mock-de1") throw new Error(`Not Decaid's simulated machine: ${JSON.stringify(info)}`);
const devices = await send("GET", "/devices");
if (!devices.some((device) => device.id === "MockScale" && device.state === "connected")) throw new Error("Decaid's simulated scale is not connected");

const bundled = await send("GET", "/profiles");
for (const { title, file } of SHOTS.filter((shot) => files.includes(shot.file))) {
  const record = bundled.find((entry) => entry.profile.title === title);
  if (!record) throw new Error(`No bundled profile titled ${title}`);
  await send("PUT", "/workflow", { profile: record.profile, context: { targetDoseWeight: DOSE, targetYield: YIELD } });
  await send("PUT", "/machine/state/idle");
  await until("the machine to be idle", async () => (await send("GET", "/machine/state")).state.state === "idle");
  const before = (await send("GET", "/shots/ids")) ?? [];
  await send("PUT", "/machine/state/espresso");
  await until("the Shot to start", async () => (await send("GET", "/machine/state")).state.state === "espresso");
  await until("the Shot to end", async () => (await send("GET", "/machine/state")).state.state !== "espresso");
  let id;
  await until("Decaid to record the Shot", async () => {
    const ids = (await send("GET", "/shots/ids")) ?? [];
    id = ids.find((each) => !before.includes(each));
    return id !== undefined;
  });
  // Decaid records the Shot once its scale settles after the stop (`ShotSequencer`), so wait for the record to stop changing.
  let shot;
  let last = "";
  await until("the Shot's record to settle", async () => {
    shot = await send("GET", `/shots/${id}`);
    const now = JSON.stringify(shot);
    const settled = now === last;
    last = now;
    if (!settled) await sleep(2000);
    return settled;
  });
  writeFileSync(join(output, `${file}.json`), `${JSON.stringify(shot, null, 2)}\n`);
  console.log(`${title}: ${shot.measurements.length} samples, stopped by ${shot.stopReason}`);
}
