import { type RelayedLiveFrame, isMilkProbe, machineStateOf, steamPhaseOf } from "@decent-sync/protocol";
import { type CurveInfo, STEAM_CURVES, type Sample, type ShotCurve, type SteamCurve, shotSamples, steamSamples } from "./curves";
import { liveMachineOf, milkTemperatureOf } from "./live-view";

// The Live View's curves (#263): a shot's or steaming's, drawn from the
// Machine's frames as they arrive and held only in the page. Each machine
// snapshot is one measurement, with the scale's latest weight beside it, as
// Decaid records a Shot's, and a Bengle's milk probe's latest temperature, as
// it records a Steam Record's, so the Shot page's and Steam Record page's
// samples (`shotSamples`, `steamSamples`) read them. The last curves stay
// until the next shot or steaming starts.

/** What a Live View's curves are of: a shot, while Decaid reports `espresso` or `skipStep`, or steaming, while it reports `steam`. */
export type LiveActivity = "shot" | "steaming";

const ACTIVITIES: Readonly<Record<string, LiveActivity>> = { espresso: "shot", skipStep: "shot", steam: "steaming" };

/** The curves steaming draws but for the milk temperature, which only a Bengle's probe reports (`liveSteamCurves`). */
export const LIVE_STEAM_CURVES = {
  steamTemperature: STEAM_CURVES.steamTemperature,
  pressure: STEAM_CURVES.pressure,
  flow: STEAM_CURVES.flow,
};

export type LiveSteamCurve = keyof typeof LIVE_STEAM_CURVES;

/**
 * The curves steaming draws: a Steam Record's, the milk temperature among
 * them only where a Bengle's milk probe reported one as it steamed (#265).
 */
export function liveSteamCurves(samples: readonly Sample<SteamCurve>[]): Record<LiveSteamCurve, CurveInfo> {
  return samples.some((sample) => sample.values.milkTemperature !== null) ? STEAM_CURVES : LIVE_STEAM_CURVES;
}

/**
 * One measurement, as a record holds them: a machine snapshot, the scale's
 * latest weight before it, if any, and a milk probe's latest temperature, if
 * current (`milkTemperatureOf`).
 */
interface LiveMeasurement {
  machine: Record<string, unknown>;
  scale?: Record<string, unknown>;
  milkTemperature?: number;
}

/** The curves of one shot or steaming, as the page took in its frames. */
export interface LiveCurve {
  activity: LiveActivity;
  /** When the plugin received its first frame the page took in, which tells it from the curves before it. */
  startedAt: string;
  measurements: readonly LiveMeasurement[];
  /**
   * Whether it began before the page's first frame (`LiveCurves.firstFrameAt`),
   * so its start isn't drawn, as is steaming's whose first frame is its purge.
   */
  partial: boolean;
  /** Whether a frame of something else has come since, so it is over. */
  ended: boolean;
  /**
   * When each Machine State it reported began (`stateSince`), such as its
   * Steaming's and its Purging's: the first frame after a gap in the stream
   * continues it only from one of these.
   */
  since: readonly string[];
  /**
   * Whether frames the page missed in a gap may hold its end, or a shot or
   * steaming after it: the first machine frame after the gap didn't continue
   * it, and reported a Machine State begun since the last the page saw. Its
   * record can't then be told from another's.
   */
  missed: boolean;
}

/** What the page has taken in toward its curves. */
export interface LiveCurves {
  /**
   * When the plugin received the first machine frame since the stream last
   * opened, or undefined in a gap: from when the stream closes or fails until
   * its first machine frame once open again. A shot or steaming whose Machine
   * State began before it began before the page's frames did. Only machine
   * frames count, as the server sends a joining viewer earlier frames of
   * other sources again.
   */
  firstFrameAt?: string;
  /** When the Machine State of the last machine frame taken in began. */
  lastSince?: string;
  /** The scale's latest frame with a weight, while it is connected and the stream open. */
  scale?: Record<string, unknown>;
  /** A milk probe's latest frame, while the stream is open. */
  milkProbe?: Record<string, unknown>;
  /** The latest shot's or steaming's curves, until the next starts. */
  curve?: LiveCurve;
}

/**
 * The curves once the page's stream has closed or failed: a gap, in which
 * frames may be missed, until its first machine frame once open again. The
 * scale's weight and the milk probe's reading are dropped, as one from
 * before the gap may be long gone.
 */
export function withStreamGap(curves: LiveCurves): LiveCurves {
  if (curves.firstFrameAt === undefined && curves.scale === undefined && curves.milkProbe === undefined) return curves;
  return { ...curves, firstFrameAt: undefined, scale: undefined, milkProbe: undefined };
}

/**
 * The curves with a relayed frame taken in. A machine snapshot of a shot or
 * steaming adds a measurement to its curves, or starts new ones where the
 * last are over or are of the other activity. The first after a gap adds one
 * only in a Machine State the curves hold, which began as they say
 * (`stateSince`); otherwise the shot or steaming may be another, so it
 * starts new ones. Any other snapshot reporting a state ends them, and the
 * first after a gap, from a Machine State begun since the last the page saw,
 * marks them `missed`. A scale's weight is kept for the snapshots after it,
 * and dropped once the scale disconnects, and so is a milk probe's reading,
 * which each snapshot takes only while it is current. Anything else changes
 * nothing, and gives back the same curves.
 */
export function withCurvesFrame(curves: LiveCurves, relayed: RelayedLiveFrame): LiveCurves {
  if (relayed.source === "scale") {
    const { frame } = relayed;
    if (typeof frame.weight === "number") return { ...curves, scale: frame };
    return frame.status === "disconnected" && curves.scale ? { ...curves, scale: undefined } : curves;
  }
  if (relayed.source === "sensor") return isMilkProbe(relayed.sensorId) ? { ...curves, milkProbe: relayed.frame } : curves;
  const live = liveMachineOf(relayed);
  const named = live && machineStateOf(live.snapshot);
  if (!live || !named) return curves;
  const afterGap = curves.firstFrameAt === undefined;
  const taken: LiveCurves = { ...curves, firstFrameAt: curves.firstFrameAt ?? live.receivedAt, lastSince: live.stateSince };
  const activity = ACTIVITIES[named.state];
  const milkTemperature = milkTemperatureOf(curves.milkProbe, live.snapshot);
  const measurement: LiveMeasurement = {
    machine: live.snapshot,
    ...(curves.scale ? { scale: curves.scale } : {}),
    ...(milkTemperature !== null ? { milkTemperature } : {}),
  };
  const { curve } = curves;
  const held = curve?.since.includes(live.stateSince) ?? false;
  if (curve && !curve.ended && activity === curve.activity && (!afterGap || held)) {
    const since = held ? curve.since : [...curve.since, live.stateSince];
    return { ...taken, curve: { ...curve, measurements: [...curve.measurements, measurement], since } };
  }
  if (activity) {
    // Purging begins once steaming has: whenever it began, steaming began before it.
    const purge = activity === "steaming" && steamPhaseOf(live.snapshot) === "purge";
    const partial = purge || Date.parse(live.stateSince) < Date.parse(taken.firstFrameAt!);
    const started: LiveCurve = { activity, startedAt: live.receivedAt, measurements: [measurement], partial, ended: false, since: [live.stateSince], missed: false };
    return { ...taken, curve: started };
  }
  const unchanged = !afterGap && live.stateSince === curves.lastSince;
  if (!curve) return unchanged ? curves : taken;
  const missed = curve.missed || (afterGap && live.stateSince !== curves.lastSince);
  if (curve.ended && missed === curve.missed) return unchanged ? curves : taken;
  return { ...taken, curve: { ...curve, ended: true, missed } };
}

/** A curve's samples, read as its stored record's page reads them: a shot's naming the steps of `profile`, its Workflow's. */
export type LiveSamples = { activity: "shot"; samples: Sample<ShotCurve>[] } | { activity: "steaming"; samples: Sample<SteamCurve>[] };

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
