import { STEAM_ON_FROM, type SharedSetting } from "@decent-sync/protocol";
import { request } from "./decaid.js";

// Streamline (streamline-js), a skin for Decaid, remembers what the barista
// last set for some of the shared settings in Decaid's store, under its
// namespace `streamline-app`, and pushes a remembered value back through
// `PUT /workflow` whenever the Workflow holds another, whoever changed it
// (`resyncIfDrifted` in streamline-js:src/modules/api.js, which
// `resyncDriftedShotSettings` calls on every shot-settings frame from the
// machine, and `loadInitialData` on every load, both in src/modules/app.js;
// checked at v0.2.12, bf72a0c). Its key names are not a published contract.
// So before the plugin writes a Location's settings into the Workflow, it
// sets each of those values Streamline holds to the one it is about to
// write, store first, as Streamline's own steam and hot water setters do
// (ADR-0021).

const NAMESPACE = "streamline-app";

interface Remembered {
  /** Streamline's key for the setting. */
  key: string;
  /** Whether Streamline remembers this value of it; any by default. */
  remembers?: (value: number) => boolean;
}

/** The shared settings Streamline remembers, by its keys in src/modules/api.js. */
const REMEMBERED: Partial<Record<SharedSetting, Remembered>> = {
  "steamSettings.duration": { key: "last-steam-duration" },
  "steamSettings.flow": { key: "last-steam-flow" },
  // Only a stop that is on: 0 is off (`setStopAtTemperature`).
  "steamSettings.stopAtTemperature": { key: "last-milk-stop", remembers: (value) => value > 0 },
  // The temperature Streamline turns steam back on at (`steamHeaterFor`), so never one that is off.
  "steamSettings.targetTemperature": { key: "last-steam-temp", remembers: (value) => value >= STEAM_ON_FROM },
  "hotWaterData.volume": { key: "last-hot-water-volume" },
  "hotWaterData.targetTemperature": { key: "last-hot-water-temp" },
  "rinseData.duration": { key: "last-flush-duration" },
};

/**
 * Sets each value Streamline remembers of the settings about to be written
 * to the one written, through Decaid's store API, as a JSON number, as
 * Streamline's `persistSharedValue` does. Only a key that holds a number is
 * set: Decaid answers null for a key never set, which Streamline pushes
 * nothing for, so a tablet that never ran Streamline is written nothing.
 * Never rejects: a key Decaid fails to read or set is logged, and left to
 * Streamline, which may push it back over the Workflow, as it did before.
 * Once Decaid does not answer, the keys left are not tried, as each would
 * hold up the write until Decaid's fetch times out.
 */
export async function rememberInStreamline(fields: Readonly<Record<string, unknown>>, log: (message: string) => void): Promise<void> {
  for (const [field, value] of Object.entries(fields)) {
    const remembered = Object.prototype.hasOwnProperty.call(REMEMBERED, field) ? REMEMBERED[field as SharedSetting] : undefined;
    if (!remembered || typeof value !== "number" || !Number.isFinite(value) || remembered.remembers?.(value) === false) continue;
    const { key } = remembered;
    const path = `/store/${NAMESPACE}/${encodeURIComponent(key)}`;
    try {
      const held = await request("GET", path);
      if (!held.ok) {
        log(`Could not read Streamline's ${key}: Decaid answered ${held.status}. Streamline may set it back.`);
        continue;
      }
      const stored = parsed(held.text);
      if (stored === null || stored === value) continue;
      if (typeof stored !== "number" || !Number.isFinite(stored)) {
        log(`Streamline's ${key} holds something other than a number, so it is left as it is.`);
        continue;
      }
      const set = await request("POST", path, value);
      if (!set.ok) log(`Could not set Streamline's ${key}: Decaid answered ${set.status}. Streamline may set it back.`);
    } catch (error) {
      log(`Could not set Streamline's ${key} or the rest: Decaid did not answer (${error instanceof Error ? error.message : String(error)}). Streamline may set them back.`);
      return;
    }
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
