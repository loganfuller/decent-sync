import { type RelayedLiveFrame, machineStateOf } from "@decent-sync/protocol";
import { STEAM_CURVES, type Sample, type ShotCurve, shotSamples, steamSamples } from "./curves";
import { liveMachineOf } from "./live-view";

// The Live View's curves (#263): a shot's or steaming's, drawn from the
// Machine's frames as they arrive and held only in the page. Each machine
// snapshot is one measurement, with the scale's latest weight beside it, as
// Decaid records a Shot's, so the Shot page's and Steam Record page's samples
// (`shotSamples`, `steamSamples`) read them. The last curves stay until the
// next shot or steaming starts.

/** What a Live View's curves are of: a shot, while Decaid reports `espresso` or `skipStep`, or steaming, while it reports `steam`. */
export type LiveActivity = "shot" | "steaming";

const ACTIVITIES: Readonly<Record<string, LiveActivity>> = { espresso: "shot", skipStep: "shot", steam: "steaming" };

/** The curves steaming draws: a Steam Record's, but the milk temperature, which only a Bengle's probe reports (#265). */
export const LIVE_STEAM_CURVES = {
  steamTemperature: STEAM_CURVES.steamTemperature,
  pressure: STEAM_CURVES.pressure,
  flow: STEAM_CURVES.flow,
};

export type LiveSteamCurve = keyof typeof LIVE_STEAM_CURVES;

/** One measurement, as a record holds them: a machine snapshot, and the scale's latest weight before it, if any. */
interface LiveMeasurement {
  machine: Record<string, unknown>;
  scale?: Record<string, unknown>;
}

/** The curves of one shot or steaming, as the page took in its frames. */
export interface LiveCurve {
  activity: LiveActivity;
  /** When the plugin received its first frame the page took in, which tells it from the curves before it. */
  startedAt: string;
  measurements: readonly LiveMeasurement[];
  /** Whether it began before the page's first frame (`LiveCurves.firstFrameAt`), so its start isn't drawn. */
  partial: boolean;
  /** Whether a frame of something else has come since, so it is over. */
  ended: boolean;
  /**
   * When each Machine State it reported began (`stateSince`), such as its
   * Steaming's and its Purging's: the first frame after the stream opened
   * again continues it only from one of these.
   */
  since: readonly string[];
}

/** What the page has taken in toward its curves. */
export interface LiveCurves {
  /**
   * When the plugin received the first machine frame since the stream last
   * opened: a shot or steaming whose Machine State began before it began
   * before the page's frames did. Only machine frames count, as the server
   * sends a joining viewer earlier frames of other sources again.
   */
  firstFrameAt?: string;
  /** The scale's latest frame with a weight, while it is connected. */
  scale?: Record<string, unknown>;
  /** The latest shot's or steaming's curves, until the next starts. */
  curve?: LiveCurve;
}

/** The curves after the page's stream opened again: frames may have been missed meanwhile, so the next is its first. */
export function withStreamOpened(curves: LiveCurves): LiveCurves {
  return curves.firstFrameAt === undefined ? curves : { ...curves, firstFrameAt: undefined };
}

/**
 * The curves with a relayed frame taken in. A machine snapshot of a shot or
 * steaming adds a measurement to its curves, or starts new ones where the
 * last are over or are of the other activity. The first after the stream
 * opened again, when frames may have been missed, adds one only in a Machine
 * State the curves hold, which began as they say (`stateSince`); otherwise
 * the shot or steaming may be another, so it starts new ones. Any other
 * snapshot reporting a state ends them. A scale's weight is kept for the
 * snapshots after it, and dropped once the scale disconnects. Anything else
 * changes nothing, and gives back the same curves.
 */
export function withCurvesFrame(curves: LiveCurves, relayed: RelayedLiveFrame): LiveCurves {
  if (relayed.source === "scale") {
    const { frame } = relayed;
    if (typeof frame.weight === "number") return { ...curves, scale: frame };
    return frame.status === "disconnected" && curves.scale ? { ...curves, scale: undefined } : curves;
  }
  const live = liveMachineOf(relayed);
  const named = live && machineStateOf(live.snapshot);
  if (!live || !named) return curves;
  const firstFrameAt = curves.firstFrameAt ?? live.receivedAt;
  const activity = ACTIVITIES[named.state];
  const measurement: LiveMeasurement = curves.scale ? { machine: live.snapshot, scale: curves.scale } : { machine: live.snapshot };
  const { curve } = curves;
  const held = curve?.since.includes(live.stateSince) ?? false;
  if (curve && !curve.ended && activity === curve.activity && (curves.firstFrameAt !== undefined || held)) {
    const since = held ? curve.since : [...curve.since, live.stateSince];
    return { ...curves, firstFrameAt, curve: { ...curve, measurements: [...curve.measurements, measurement], since } };
  }
  if (activity) {
    const partial = Date.parse(live.stateSince) < Date.parse(firstFrameAt);
    const started: LiveCurve = { activity, startedAt: live.receivedAt, measurements: [measurement], partial, ended: false, since: [live.stateSince] };
    return { ...curves, firstFrameAt, curve: started };
  }
  if (curve && !curve.ended) return { ...curves, firstFrameAt, curve: { ...curve, ended: true } };
  return firstFrameAt === curves.firstFrameAt ? curves : { ...curves, firstFrameAt };
}

/** A curve's samples, read as its stored record's page reads them: a shot's naming the steps of `profile`, its Workflow's. */
export type LiveSamples = { activity: "shot"; samples: Sample<ShotCurve>[] } | { activity: "steaming"; samples: Sample<LiveSteamCurve>[] };

/**
 * A curve's samples: a shot's as the Shot page reads its record's, with
 * `profile` naming its steps, and steaming's as the Steam Record page reads
 * one's, with no milk temperature to stop at.
 */
export function liveSamples(curve: LiveCurve, profile?: unknown): LiveSamples {
  return curve.activity === "shot"
    ? { activity: "shot", samples: shotSamples(curve.measurements, profile) }
    : { activity: "steaming", samples: steamSamples(curve.measurements, null) };
}
