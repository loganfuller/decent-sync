import fs from "node:fs";
import type { DecaidApi } from "./simulated-tablet.js";

/** Scrubbed real Decaid records; changes in tests are explicitly derived. */
export function shotFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL("../fixtures/decaid/de1pro-v0.8.7/shot-espresso.json", import.meta.url), "utf8"));
}

export function withShots(api: DecaidApi, shots: Record<string, unknown>[]): DecaidApi {
  return { ...api, ...Object.fromEntries(shots.map((shot) => [`/shots/${encodeURIComponent(String(shot.id))}`, shot])) };
}

/** A real Shot with only the named changes, for acceptance scenarios. */
export function derivedShot(id: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...shotFixture(), id, ...changes };
}

/**
 * Derived: the real Shot with the named changes and its measurement samples
 * repeated, in order and with their recorded times, until the record is
 * larger than `minBytes` of JSON, as a long filter or tea shot's would be.
 */
export function longShot(id: string, changes: Record<string, unknown> = {}, minBytes = 1.25 * 1024 * 1024): Record<string, unknown> {
  const fixture = shotFixture();
  const samples = fixture.measurements as unknown[];
  const record = { ...fixture, id, ...changes, measurements: [] as unknown[] };
  // Each repeat adds the samples and a comma, and drops the brackets.
  const repeatBytes = Buffer.byteLength(JSON.stringify(samples)) - 1;
  const repeats = Math.ceil((minBytes - Buffer.byteLength(JSON.stringify(record))) / repeatBytes) + 1;
  record.measurements = Array.from({ length: Math.max(1, repeats) }, () => samples).flat();
  return record;
}
