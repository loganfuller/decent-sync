import fs from "node:fs";
import type { DecaidApi } from "./simulated-tablet.js";

/** Scrubbed real Decaid records; changes in tests are explicitly derived. */
export function shotFixture(kind: "espresso" | "de1app" = "espresso"): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/decaid/de1pro-v0.8.6/shot-${kind}.json`, import.meta.url), "utf8"));
}

export function withShots(api: DecaidApi, shots: Record<string, unknown>[]): DecaidApi {
  return { ...api, ...Object.fromEntries(shots.map((shot) => [`/shots/${encodeURIComponent(String(shot.id))}`, shot])) };
}

/** A real Shot with only the named changes, for acceptance scenarios. */
export function derivedShot(id: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...shotFixture(), id, ...changes };
}
