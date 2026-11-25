// Samples recent Shots from a running Decent Sync server for the README's images, read-only, and writes them
// anonymized: only their physics (curves, profile steps, dose, yield, stop reason), with no names, Beans, roasters,
// notes, serials, ids, grind settings or visualizer ids, and every Shot's samples moved to start at SAMPLE_EPOCH, so
// no time of day or date is kept. Check every string left in the output before committing it: the repo is public.
//
// Usage: SAMPLE_SERVER=<server URL> SAMPLE_EMAIL=<Admin email> SAMPLE_PASSWORD=<password> \
//          node scripts/images/sample.mjs <out.json>
// It signs in, makes only GET requests, and signs out. README.md beside this file says when to use it.

import fs from "node:fs";

/** Every sampled Shot's earliest sample is moved into the first millisecond of this made-up instant (`rebaseTimes`). */
export const SAMPLE_EPOCH = "2000-01-01T00:00:00";

const MACHINE_KEYS = ["timestamp", "state", "flow", "pressure", "targetFlow", "targetPressure", "mixTemperature", "groupTemperature", "targetMixTemperature", "targetGroupTemperature", "profileFrame", "steamTemperature"];
const SCALE_KEYS = ["timestamp", "weight", "weightFlow", "battery", "timerValue"];
const pick = (object, keys) => (object ? Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]])) : object);

/** A local time as Decaid writes it (no offset, 3 or 6 fractional digits), in microseconds. */
function toMicros(iso) {
  const [whole, fraction = ""] = iso.split(".");
  return Date.parse(`${whole}Z`) * 1000 + Number(fraction.padEnd(6, "0"));
}

/** Microseconds back to Decaid's form: 6 fractional digits, or 3 where the microseconds past the millisecond are 0, as Dart writes them. */
function fromMicros(micros) {
  const below = micros % 1000;
  const millis = new Date((micros - below) / 1000).toISOString().slice(0, 23);
  return below ? millis + String(below).padStart(3, "0") : millis;
}

/**
 * Moves every machine and scale timestamp of a Shot's measurements by one whole number of milliseconds, so its
 * earliest falls within the first millisecond of SAMPLE_EPOCH. Every interval between samples stays exactly as
 * recorded, to the microsecond, and so does each one read to the millisecond, as the server and the README spec read
 * them. Changes the measurements in place and returns them.
 */
export function rebaseTimes(measurements) {
  const stamped = measurements.flatMap((m) => [m.machine, m.scale]).filter((sample) => typeof sample?.timestamp === "string");
  const earliest = Math.min(...stamped.map((sample) => toMicros(sample.timestamp)));
  const shift = toMicros(SAMPLE_EPOCH) - (earliest - (earliest % 1000));
  for (const sample of stamped) sample.timestamp = fromMicros(toMicros(sample.timestamp) + shift);
  return measurements;
}

function cleanProfile(profile) {
  const { notes, author, id, ...rest } = profile ?? {};
  return rest;
}

/** A Shot and its measurements as the README spec reads them, and nothing else. */
export function anonymize(record, measurements) {
  const workflow = record.workflow ?? {};
  const context = workflow.context ?? {};
  return {
    profile: cleanProfile(workflow.profile),
    steamSettings: workflow.steamSettings,
    hotWaterData: workflow.hotWaterData,
    rinseData: workflow.rinseData,
    stopReason: record.stopReason ?? null,
    targetDoseWeight: context.targetDoseWeight ?? null,
    targetYield: context.targetYield ?? null,
    actualDoseWeight: record.annotations?.actualDoseWeight ?? null,
    actualYield: record.annotations?.actualYield ?? null,
    measurements: rebaseTimes(measurements.map((m) => ({ machine: pick(m.machine, MACHINE_KEYS), scale: pick(m.scale, SCALE_KEYS) ?? null, volume: m.volume ?? null }))),
  };
}

async function sample(base, email, password, out) {
  let cookie = "";
  async function api(method, path, body) {
    const response = await fetch(new URL(path, base), {
      method,
      headers: { origin: new URL(base).origin, cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  try {
    await api("POST", "/api/session", { email, password });
    const { shots } = await api("GET", "/api/shots?limit=100");
    const kept = [];
    const titles = {};
    for (const summary of shots) {
      if (kept.length >= 24) break;
      const detail = await api("GET", `/api/shots/${encodeURIComponent(summary.id)}`);
      const record = detail.shot?.record ?? detail.record ?? detail.shot;
      const title = record?.workflow?.profile?.title ?? "";
      if (/clean|flush|descal|tea|water|steam|calib/i.test(title)) continue;
      if ((titles[title] ?? 0) >= 4) continue;
      const { measurements } = await api("GET", `/api/shots/${encodeURIComponent(summary.id)}/measurements`);
      if (!Array.isArray(measurements) || measurements.length < 80) continue;
      const espresso = measurements.filter((m) => m.machine?.state?.state === "espresso");
      const seconds = (Date.parse(espresso.at(-1)?.machine?.timestamp + "Z") - Date.parse(espresso[0]?.machine?.timestamp + "Z")) / 1000;
      if (!(seconds > 18 && seconds < 60)) continue;
      if (!(record.annotations?.actualYield > 15)) continue;
      titles[title] = (titles[title] ?? 0) + 1;
      kept.push(anonymize(record, measurements));
    }
    fs.writeFileSync(out, JSON.stringify(kept));
    console.log(`kept ${kept.length} of ${shots.length} recent Shots`);
    console.log("profiles, in the order kept:", JSON.stringify(kept.map((shot) => shot.profile.title)));
  } finally {
    await api("DELETE", "/api/session").catch((error) => console.log("sign-out:", error.message));
  }
}

if (import.meta.main) {
  const out = process.argv[2];
  const { SAMPLE_SERVER: base, SAMPLE_EMAIL: email, SAMPLE_PASSWORD: password } = process.env;
  const missing = [["SAMPLE_SERVER", base], ["SAMPLE_EMAIL", email], ["SAMPLE_PASSWORD", password]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length || !out) {
    console.error(`Missing ${[...missing, ...(out ? [] : ["the output path"])].join(", ")}.`);
    console.error("Usage: SAMPLE_SERVER=<server URL> SAMPLE_EMAIL=<Admin email> SAMPLE_PASSWORD=<password> node scripts/images/sample.mjs <out.json>");
    process.exit(1);
  }
  await sample(base, email, password, out);
}
