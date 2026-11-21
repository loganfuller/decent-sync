import { shotTimeline } from "@decent-sync/protocol";

// A Shot's samples at full resolution, as get_shot_samples gives them (#607):
// one column per channel its measurements hold, one value per sample, in the
// order Decaid recorded them, each value as stored, beside the seconds its
// curves are timed at (`shotSamples`). Decaid's raw timestamps and the
// scale's battery are left out.

/** Where each sample's value is in a measurement as Decaid records it, and what the value is: a number or a name. */
const CHANNELS = {
  pressure: ["machine", "pressure"],
  flow: ["machine", "flow"],
  targetPressure: ["machine", "targetPressure"],
  targetFlow: ["machine", "targetFlow"],
  mixTemperature: ["machine", "mixTemperature"],
  groupTemperature: ["machine", "groupTemperature"],
  targetMixTemperature: ["machine", "targetMixTemperature"],
  targetGroupTemperature: ["machine", "targetGroupTemperature"],
  steamTemperature: ["machine", "steamTemperature"],
  weight: ["scale", "weight"],
  weightFlow: ["scale", "weightFlow"],
  timerValue: ["scale", "timerValue"],
  volume: ["volume"],
} as const satisfies Record<string, readonly string[]>;

export type Channel = keyof typeof CHANNELS;

/** The channels, in the order a page gives their columns, after seconds, frame, state and substate. */
export const CHANNEL_NAMES = Object.keys(CHANNELS) as Channel[];

/** A page of a Shot's samples, as columns of equal length. */
export type SampleColumns = {
  seconds: (number | null)[];
  frame: (number | null)[];
  state: (string | null)[];
  substate: (string | null)[];
} & Record<Channel, (number | null)[]>;

/** A Shot's samples as columns: those from `offset`, `count` of them at most. `total` is how many it has. */
export interface ShotSamples {
  total: number;
  /** Its samples from `offset`, at most `count` of them. */
  columns(offset: number, count: number): SampleColumns;
}

/**
 * A Shot's samples, from its measurements as stored. Each sample's `seconds`
 * is its time on the Shot's curves' axis (`shotTimeline`), negative in its
 * Preheat, and null where Decaid recorded no machine time, which the curves
 * leave out. `frame` is the step of its profile the Machine was running, by
 * its index, as the curves' steps give it: null in Preheat, where the frame
 * is left over from before the Shot, and where it reported none. Every other
 * value is as stored: a number, or for `state` and `substate` Decaid's name,
 * and null where the sample holds none.
 */
export function shotSamplesOf(measurements: unknown): ShotSamples {
  const all: unknown[] = Array.isArray(measurements) ? measurements : [];
  const timeline = shotTimeline(all);
  return {
    total: all.length,
    columns(offset, count) {
      const indices = Array.from({ length: Math.max(0, Math.min(count, all.length - offset)) }, (_, n) => offset + n);
      const at = (n: number, path: readonly string[]) => path.reduce<unknown>((value, key) => fields(value)[key], all[n]);
      const state = (n: number) => fields(fields(all[n]).machine).state;
      return {
        seconds: indices.map((n) => timeline[n]!.seconds),
        frame: indices.map((n) => (timeline[n]!.lead ? null : frameOf(at(n, ["machine", "profileFrame"])))),
        state: indices.map((n) => text(fields(state(n)).state)),
        substate: indices.map((n) => text(fields(state(n)).substate)),
        ...(Object.fromEntries(CHANNEL_NAMES.map((channel) => [channel, indices.map((n) => number(at(n, CHANNELS[channel])))])) as Record<Channel, (number | null)[]>),
      };
    },
  };
}

function frameOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
