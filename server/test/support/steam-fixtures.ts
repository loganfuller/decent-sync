import fs from "node:fs";
import type { DecaidApi } from "./simulated-tablet.js";

// Steam Records Decaid v0.8.7 produced (see the fixtures' READMEs). Records
// changed in tests are explicitly derived from these.

function read(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL(`../fixtures/decaid/${file}`, import.meta.url), "utf8"));
}

/** A real Steam Record from the test tablet's DE1Pro, which has no milk probe, so every milk temperature is null. */
export function steamFixture(): Record<string, unknown> {
  return read("de1pro-v0.8.7/steam.json");
}

/** A Steam Record Decaid v0.8.7 recorded from its simulated Bengle, whose milk probe reported temperatures. */
export function milkProbeSteamFixture(): Record<string, unknown> {
  return read("bengle-simulated-v0.8.7/steam-milk-probe.json");
}

/** The simulated Bengle's Steam Record recorded right after another, which starts with that one's last milk temperature. */
export function nextMilkProbeSteamFixture(): Record<string, unknown> {
  return read("bengle-simulated-v0.8.7/steam-milk-probe-next.json");
}

/** Decaid's API serving these Steam Records too, each at GET /steams/{id} and listed by GET /steams/ids. */
export function withSteams(api: DecaidApi, steams: Record<string, unknown>[]): DecaidApi {
  return { ...api, ...Object.fromEntries(steams.map((steam) => [`/steams/${encodeURIComponent(String(steam.id))}`, steam])) };
}

/** A real Steam Record with only the named changes, such as its id and local time. */
export function derivedSteam(id: string, changes: Record<string, unknown> = {}, fixture = milkProbeSteamFixture()): Record<string, unknown> {
  return { ...fixture, id, ...changes };
}

/**
 * Derived: the real Steam Record with the named changes and its samples
 * repeated, in order and with their recorded times, until the record is
 * larger than `minBytes` of JSON, as a long steaming session's would be.
 */
export function longSteam(id: string, changes: Record<string, unknown> = {}, minBytes = 1.25 * 1024 * 1024): Record<string, unknown> {
  const fixture = milkProbeSteamFixture();
  const samples = fixture.measurements as unknown[];
  const record = { ...fixture, id, ...changes, measurements: [] as unknown[] };
  // Each repeat adds the samples and a comma, and drops the brackets.
  const repeatBytes = Buffer.byteLength(JSON.stringify(samples)) - 1;
  const repeats = Math.ceil((minBytes - Buffer.byteLength(JSON.stringify(record))) / repeatBytes) + 1;
  record.measurements = Array.from({ length: Math.max(1, repeats) }, () => samples).flat();
  return record;
}
