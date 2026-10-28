import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The test tablet's DE1Pro's live streams, recorded from Decaid v0.9.0's
// local sockets in #259's supervised capture (fixtures/decaid/de1pro-live-v0.9.0/,
// whose README says how and what each holds). Its machine socket sends what
// the plugin's `stateUpdate` carries: Decaid's `MachineSnapshot.toJson()`.

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid/de1pro-live-v0.9.0");

/** One frame of a recording: when it arrived, in ms from the first, the socket it came from, and Decaid's JSON. */
export interface LiveFixtureFrame {
  ms: number;
  source: string;
  frame: Record<string, unknown>;
}

/** A recording's frames, such as `shot.json`'s, in the order they arrived. */
export function liveFixture(file: string): LiveFixtureFrame[] {
  return (JSON.parse(fs.readFileSync(path.join(fixturesDir, file), "utf8")) as { frames: LiveFixtureFrame[] }).frames;
}

/** A recording's machine snapshots, in order, each as `stateUpdate` carries it. */
export function machineSnapshots(file: string): Record<string, unknown>[] {
  return liveFixture(file)
    .filter((frame) => frame.source === "machine")
    .map((frame) => frame.frame);
}

/** Decaid's state and substate in a machine snapshot. */
export function stateOf(snapshot: Record<string, unknown>): { state: string; substate: string } {
  return snapshot.state as { state: string; substate: string };
}
