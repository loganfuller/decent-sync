import fs from "node:fs";
import { withRepeatedSamples } from "./shot-fixtures.js";
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
 * Derived: the real Steam Record with its samples repeated until it is larger
 * than 1.25 MiB of JSON, as a long steaming session's would be.
 */
export function longSteam(id: string): Record<string, unknown> {
  return withRepeatedSamples(milkProbeSteamFixture(), id);
}
