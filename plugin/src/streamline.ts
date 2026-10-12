import { STEAM_ON_FROM, type SharedSetting } from "@decent-sync/protocol";
import { request } from "./decaid.js";

// Streamline (streamline-js), a skin for Decaid, remembers what the barista
// last set for some of the steam, hot water and rinse settings in Decaid's
// store, under its namespace `streamline-app`, and pushes a remembered value
// back through `PUT /workflow` whenever the Workflow holds another, whoever
// changed it (`resyncIfDrifted` in streamline-js:src/modules/api.js, which
// `resyncDriftedShotSettings` calls on every shot-settings frame from the
// machine, and `loadInitialData` on every load, both in src/modules/app.js;
// checked at v0.2.12, bf72a0c). Its key names are not a published contract.
// So before the plugin writes settings into the Workflow, it sets each of
// those values Streamline holds to the one it is about to write, store
// first, as Streamline's own steam and hot water setters do (ADR-0021). Only
// the keys of the settings a write carries are set: a Location's settings
// are steam and rinse alone (ADR-0014), so Streamline's hot water keys wait
// for a Loaded Recipe's hot water to be written (ADR-0022).

const NAMESPACE = "streamline-app";

interface Remembered {
  /** Streamline's key for the setting. */
  key: string;
  /** Whether Streamline remembers this value of it; any by default. */
  remembers?: (value: number) => boolean;
}

/** A Workflow setting the plugin writes: a shared one, or a hot water setting, which a Loaded Recipe is to set (ADR-0022). */
type WrittenSetting = SharedSetting | "hotWaterData.volume" | "hotWaterData.targetTemperature";

/** The settings Streamline remembers, by their Workflow fields (`steamSettings.flow`), with its keys in src/modules/api.js. */
const REMEMBERED: Partial<Record<WrittenSetting, Remembered>> = {
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

/** A key `rememberInStreamline` set: the value it held before, and the one set. */
export interface RememberedChange {
  key: string;
  before: number;
  after: number;
}

/**
 * Sets each value Streamline remembers of the settings about to be written
 * to the one written, through Decaid's store API, as a JSON number, as
 * Streamline's `persistSharedValue` does, and resolves with the keys set.
 * Only a key that holds a number is
 * set: Decaid answers null for a key never set, which Streamline pushes
 * nothing for, so a tablet that never ran Streamline is written nothing.
 * Never rejects: a key Decaid fails to read or set is logged, and left to
 * Streamline, which may push it back over the Workflow, as it did before.
 * Once Decaid does not answer, the keys left are not tried, as each would
 * hold up the write until Decaid's fetch times out.
 */
export async function rememberInStreamline(fields: Readonly<Record<string, unknown>>, log: (message: string) => void): Promise<RememberedChange[]> {
  const changes: RememberedChange[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const remembered = Object.prototype.hasOwnProperty.call(REMEMBERED, field) ? REMEMBERED[field as WrittenSetting] : undefined;
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
      if (set.ok) changes.push({ key, before: stored, after: value });
      else log(`Could not set Streamline's ${key}: Decaid answered ${set.status}. Streamline may set it back.`);
    } catch (error) {
      log(`Could not set Streamline's ${key} or the rest: Decaid did not answer (${error instanceof Error ? error.message : String(error)}). Streamline may set them back.`);
      break;
    }
  }
  return changes;
}

/**
 * Sets back each key `rememberInStreamline` set for a Workflow write Decaid
 * then refused, where it still holds the value set, so a barista's change
 * made meanwhile stays. Otherwise Streamline would push the value of a write
 * that never took, which the server, finding the Workflow holding the
 * Location's settings, as when the Location's value was set back meanwhile,
 * would not write again. Never rejects: a key Decaid fails to read or set is
 * logged, and once Decaid does not answer, the keys left are not tried.
 */
export async function forgetInStreamline(changes: readonly RememberedChange[], log: (message: string) => void): Promise<void> {
  for (const { key, before, after } of changes) {
    const path = `/store/${NAMESPACE}/${encodeURIComponent(key)}`;
    try {
      const held = await request("GET", path);
      if (!held.ok || parsed(held.text) !== after) continue;
      const set = await request("POST", path, before);
      if (!set.ok) log(`Could not set Streamline's ${key} back: Decaid answered ${set.status}. Streamline may push a value the Workflow was refused.`);
    } catch (error) {
      log(`Could not set Streamline's ${key} or the rest back: Decaid did not answer (${error instanceof Error ? error.message : String(error)}). Streamline may push values the Workflow was refused.`);
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
