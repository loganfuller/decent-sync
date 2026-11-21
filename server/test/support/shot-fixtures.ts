import fs from "node:fs";
import type { DecaidApi } from "./simulated-tablet.js";

/** Scrubbed real Decaid records; changes in tests are explicitly derived. */
export function shotFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL("../fixtures/decaid/de1pro-v0.8.7/shot-espresso.json", import.meta.url), "utf8"));
}

/**
 * A Shot Decaid v0.9.0 recorded from its simulated machine, with the burrs it
 * copied from the record of the Grinder its Workflow named
 * (simulated-devices-v0.9.0/).
 */
export function burrsShotFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL("../fixtures/decaid/simulated-devices-v0.9.0/shot-grinder-burrs.json", import.meta.url), "utf8"));
}

/**
 * A real Shot with a long Preheat: its first 43 of 168 samples, 7.36 s, while
 * the Machine heated its water at the heater test's 8 ml/s
 * (de1pro-v0.9.0/shot-preheat.json).
 */
export function preheatShotFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(new URL("../fixtures/decaid/de1pro-v0.9.0/shot-preheat.json", import.meta.url), "utf8"));
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
 * repeated until the record is larger than 1.25 MiB of JSON, as a long filter
 * or tea shot's would be.
 */
export function longShot(id: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return withRepeatedSamples(shotFixture(), id, changes);
}

/**
 * Derived: a real Shot's or Steam Record's fixture with the named changes and
 * its measurement samples repeated, in order and with their recorded times,
 * until the record is larger than 1.25 MiB of JSON.
 */
export function withRepeatedSamples(fixture: Record<string, unknown>, id: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  const minBytes = 1.25 * 1024 * 1024;
  const samples = fixture.measurements as unknown[];
  const record = { ...fixture, id, ...changes, measurements: [] as unknown[] };
  // Each repeat adds the samples and a comma, and drops the brackets.
  const repeatBytes = Buffer.byteLength(JSON.stringify(samples)) - 1;
  const repeats = Math.ceil((minBytes - Buffer.byteLength(JSON.stringify(record))) / repeatBytes) + 1;
  record.measurements = Array.from({ length: Math.max(1, repeats) }, () => samples).flat();
  return record;
}

/**
 * Derived: a real Shot whose samples after its Preheat are repeated until it
 * runs at least `seconds` from the start of its profile, each repeat timed on
 * from the one before, a sample's gap after it, as a long filter shot's or a
 * slow bloom's run on (#607). Its Preheat is its leading `preparingForShot`
 * samples, kept once.
 */
export function stretchedShot(fixture: Record<string, unknown>, seconds: number): Record<string, unknown> {
  type Sample = { machine: { timestamp: string; state: { substate: string } }; scale: { timestamp: string } | null };
  const samples = fixture.measurements as Sample[];
  const start = samples.findIndex((sample) => sample.machine.state.substate !== "preparingForShot");
  const profile = samples.slice(start);
  const at = (sample: Sample) => Date.parse(`${sample.machine.timestamp}Z`);
  const gap = at(profile[1]!) - at(profile[0]!);
  const span = at(profile.at(-1)!) - at(profile[0]!) + gap;
  const shifted = (timestamp: string, by: number) => new Date(Date.parse(`${timestamp}Z`) + by).toISOString().slice(0, -1);
  const repeats = Math.ceil((seconds * 1000) / span) + 1;
  const measurements = [
    ...samples.slice(0, start),
    ...Array.from({ length: repeats }, (_, n) =>
      profile.map((sample) => ({
        ...sample,
        machine: { ...sample.machine, timestamp: shifted(sample.machine.timestamp, n * span) },
        scale: sample.scale && { ...sample.scale, timestamp: shifted(sample.scale.timestamp, n * span) },
      })),
    ).flat(),
  ];
  return { ...fixture, measurements };
}
