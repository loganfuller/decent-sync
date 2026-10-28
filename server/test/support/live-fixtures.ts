import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The test tablet's DE1Pro's live streams, recorded from Decaid v0.9.0's
// local sockets in #259's supervised capture (fixtures/decaid/de1pro-live-v0.9.0/,
// whose README says how and what each holds). Its machine socket sends what
// the plugin's `stateUpdate` carries: Decaid's `MachineSnapshot.toJson()`.
// Also Decaid v0.9.0's sockets as its simulated machine was disconnected and
// connected again (fixtures/decaid/simulated-devices-v0.9.0/, #264).

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid");

/** One frame of a recording: when it arrived, in ms from the first, the socket it came from, and Decaid's JSON. */
export interface LiveFixtureFrame {
  ms: number;
  source: string;
  frame: Record<string, unknown>;
}

/** A recording's frames, such as `shot.json`'s, in the order they arrived, from the test tablet's unless another directory is named. */
export function liveFixture(file: string, directory = "de1pro-live-v0.9.0"): LiveFixtureFrame[] {
  return (JSON.parse(fs.readFileSync(path.join(fixturesDir, directory, file), "utf8")) as { frames: LiveFixtureFrame[] }).frames;
}

/**
 * The device lists Decaid v0.9.0's devices socket sent as its simulated
 * machine was disconnected and connected again (`machine-disconnects.json`):
 * the machine connected, then disconnected, then connected again.
 */
export function machineDisconnects(): Record<"connected" | "disconnected" | "reconnected", Record<string, unknown>> {
  const lists = liveFixture("machine-disconnects.json", "simulated-devices-v0.9.0").filter((frame) => frame.source === "devices");
  const [connected, disconnected, reconnected] = lists.map((frame) => frame.frame);
  return { connected: connected!, disconnected: disconnected!, reconnected: reconnected! };
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

/** Decaid's own sockets the Live View reads, by the source of their frames. */
export type DecaidSocket = "waterLevels" | "scale" | "shotSettings" | "devices";

/** What Decaid's own sockets send as each opens: the latest water levels, shot settings and device list, and the scale's status. */
export interface DecaidSocketState {
  waterLevels: Record<string, unknown>;
  shotSettings: Record<string, unknown>;
  devices: Record<string, unknown>;
  scale: "connected" | "disconnected";
}

/**
 * What the test tablet's sockets sent as #259 opened them (`opening.json`):
 * the Machine asleep, its tank at 4.79 mm against a refill level of 5 mm,
 * and the scale off.
 */
export function openingFrames(): DecaidSocketState {
  const opening = liveFixture("opening.json");
  const first = (source: string) => opening.find((frame) => frame.source === source)!.frame;
  return {
    waterLevels: first("waterLevels"),
    shotSettings: first("shotSettings"),
    devices: first("devices"),
    scale: first("scale").status as "connected" | "disconnected",
  };
}

/** A recording's frames from one of Decaid's sockets, in order, as Decaid sent them. */
export function socketFrames(file: string, source: DecaidSocket): Record<string, unknown>[] {
  return liveFixture(file)
    .filter((frame) => frame.source === source)
    .map((frame) => frame.frame);
}

/** What Decaid's sockets send as each opens (`openingFrames` by default), as a Live View's events carry them. */
export function openingSocketFrames(state = openingFrames()): { source: DecaidSocket; frame: Record<string, unknown> }[] {
  return [
    { source: "waterLevels", frame: state.waterLevels },
    { source: "scale", frame: { status: state.scale } },
    { source: "shotSettings", frame: state.shotSettings },
    { source: "devices", frame: state.devices },
  ];
}
