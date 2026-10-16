import { STEAM_ON_FROM } from "@decent-sync/protocol";
import { request } from "./decaid.js";

// Streamline (streamline-js), a skin for Decaid, remembers what the barista
// last set for some of the steam, hot water and rinse settings in Decaid's
// store, under its namespace `streamline-app`, and adopts a Workflow change
// made elsewhere (ADR-0021), its steam temperature included since `main` at
// 98b6b90 (decentespresso/streamline-js#143). Nothing calls
// `keepStreamlineSteamTemperature` for now: steam settings are each
// Machine's own, and the plugin writes none. It stays for #173, which keeps
// `last-steam-temp` at the Recipe's steam temperature on each load and
// Loaded Recipe edit until Streamline does (decentespresso/streamline-js#156).

const PATH = "/store/streamline-app/last-steam-temp";

/**
 * Sets the steam temperature Streamline remembers to the one Decaid has just
 * taken into the Workflow, as a JSON number, as Streamline's
 * `persistSharedValue` does: only one that turns steam on, as Streamline keeps
 * no other, and only where the key holds a number. Decaid answers null for a
 * key never set, so a tablet that never ran Streamline is written nothing.
 * Never rejects: a key Decaid fails to read or set is logged, and Streamline
 * may then put its own back with the next steam time it sends.
 */
export async function keepStreamlineSteamTemperature(temperature: unknown, log: (message: string) => void): Promise<void> {
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < STEAM_ON_FROM) return;
  try {
    const held = await request("GET", PATH);
    if (!held.ok) {
      log(`Could not read Streamline's last-steam-temp: Decaid answered ${held.status}. Streamline may set the steam temperature back.`);
      return;
    }
    const stored = parsed(held.text);
    if (stored === null || stored === temperature) return;
    if (typeof stored !== "number" || !Number.isFinite(stored)) {
      log("Streamline's last-steam-temp holds something other than a number, so it is left as it is.");
      return;
    }
    const set = await request("POST", PATH, temperature);
    if (!set.ok) log(`Could not set Streamline's last-steam-temp: Decaid answered ${set.status}. Streamline may set the steam temperature back.`);
  } catch (error) {
    log(`Could not set Streamline's last-steam-temp: Decaid did not answer (${error instanceof Error ? error.message : String(error)}). Streamline may set the steam temperature back.`);
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
