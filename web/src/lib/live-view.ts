import { type RelayedLiveFrame, isMilkProbe, machineStateOf } from "@decent-sync/protocol";

// Reading the Live View's events (ADR-0024): each is a live frame as the
// server relays it, Decaid's data inside left as Decaid sent it, so every
// value is read for what it is and may be missing. The latest of each source
// wins. Whether there is anything live to show is judged from them and the
// page's polling of the Machine (`liveConditionOf`).

/**
 * The latest frame of each source the Live View has had, as the Machine's
 * plugin streamed them: its machine snapshot, and what Decaid's sockets sent,
 * all from one Tablet's connection.
 */
export interface LiveState {
  /** The Tablet whose connection sent them, by its id. */
  tabletId: string;
  /** When the page received the latest of them, by its own clock, in ms since the epoch. */
  arrivedAt: number;
  machine?: LiveMachine;
  /**
   * When the page received `machine`, by its own clock, in ms since the
   * epoch. Staleness is judged by it: the tablet's clock is never compared
   * with the page's.
   */
  machineArrivedAt?: number;
  /** The tank's water level and refill level (`currentLevel`, `refillLevel`, mm). */
  waterLevels?: Record<string, unknown>;
  /** The scale's latest frame: its connection status (`{"status": ...}`), or a weight. */
  scale?: Record<string, unknown>;
  /** The machine's shot settings, the steam temperature's target among them (`targetSteamTemp`). */
  shotSettings?: Record<string, unknown>;
  /** The Tablet's devices (`devices`), and whether each is connected. */
  devices?: Record<string, unknown>;
  /** A Bengle's milk probe's latest frame (`temperature`, °C, and `timestamp`), which may be old (`milkTemperatureOf`). */
  milkProbe?: Record<string, unknown>;
}

/** The Machine's latest machine snapshot, as its plugin streamed it. */
export interface LiveMachine {
  /** Decaid's machine snapshot, as `stateUpdate` carries it. */
  snapshot: Record<string, unknown>;
  /** When the plugin received it, by the tablet's clock. */
  receivedAt: string;
  /** When the plugin saw its Machine State's name begin, by the same clock. */
  stateSince: string;
}

/** An event's data as a relayed live frame, or null for anything else. */
export function readLiveEvent(data: unknown): RelayedLiveFrame | null {
  let value: unknown;
  try {
    value = typeof data === "string" ? JSON.parse(data) : null;
  } catch {
    return null;
  }
  const relayed = record(value);
  const envelope = relayed && typeof relayed.tabletId === "string" && typeof relayed.source === "string" && typeof relayed.receivedAt === "string";
  if (!envelope || !record(relayed.frame)) return null;
  return relayed as unknown as RelayedLiveFrame;
}

/**
 * The Live View with a relayed frame taken in, as the latest of its source,
 * the page having received it at `arrivedAt` by its own clock. The server
 * relays only the frames of the connection holding the Machine, so one from
 * another Tablet than the rest shows it has taken the Machine over: what the
 * last one sent is dropped. Otherwise a frame it doesn't show changes nothing:
 * undefined, while no frame it shows has come, stays undefined.
 */
export function withLiveFrame(live: LiveState | undefined, relayed: RelayedLiveFrame, arrivedAt: number): LiveState | undefined {
  const { tabletId } = relayed;
  const held = live?.tabletId === tabletId ? live : undefined;
  switch (relayed.source) {
    case "machine": {
      const machine = liveMachineOf(relayed);
      return machine ? { ...held, tabletId, arrivedAt, machine, machineArrivedAt: arrivedAt } : held;
    }
    case "waterLevels":
    case "scale":
    case "shotSettings":
    case "devices":
      return { ...held, tabletId, arrivedAt, [relayed.source]: relayed.frame };
    case "sensor":
      return isMilkProbe(relayed.sensorId) ? { ...held, tabletId, arrivedAt, milkProbe: relayed.frame } : held;
    default:
      return held;
  }
}

/**
 * The Live View once a poll of the Machine, asked for at `askedAt` by the
 * page's clock, found `tabletId` holding it, as after a takeover: what
 * another Tablet sent before the poll was asked is dropped, as a Tablet that
 * sends nothing, such as one on the previous release, would otherwise leave
 * it standing. Frames that came since were sent by a Tablet holding the
 * Machine after the poll looked, so are kept.
 */
export function withHolder(live: LiveState | undefined, tabletId: string, askedAt: number): LiveState | undefined {
  return !live || live.tabletId === tabletId || live.arrivedAt > askedAt ? live : undefined;
}

/** The tank's water level and refill level, in mm, each null where not sent, and whether it is low: at or below the refill level. */
export function waterLevelOf(frame: Record<string, unknown> | undefined): { level: number | null; refill: number | null; low: boolean } {
  const level = frame ? reported(frame, "currentLevel") : null;
  const refill = frame ? reported(frame, "refillLevel") : null;
  return { level, refill, low: level !== null && refill !== null && level <= refill };
}

/**
 * The scale, from its latest frame: whether it is connected, null where it
 * has sent nothing, and its weight, weight flow and battery, each null where
 * not sent. A weight shows it connected, as Decaid sends weights only then.
 */
export function scaleOf(frame: Record<string, unknown> | undefined): {
  connected: boolean | null;
  weight: number | null;
  weightFlow: number | null;
  battery: number | null;
} {
  const none = { weight: null, weightFlow: null, battery: null };
  if (!frame) return { connected: null, ...none };
  if (frame.status === "disconnected") return { connected: false, ...none };
  if (frame.status === "connected") return { connected: true, ...none };
  return { connected: true, weight: reported(frame, "weight"), weightFlow: reported(frame, "weightFlow"), battery: reported(frame, "battery") };
}

/**
 * A milk probe's temperature, in °C, while it reports: where its frame was
 * taken within STALE_AFTER_MS of the machine snapshot, before or after it, as
 * frames of two sources may come in either order. Decaid's simulated Bengle
 * sends a reading with each snapshot while it steams. The probe's socket
 * sends its last reading as it opens, which may be from long before, and
 * nothing once it is detached. Both times are Decaid's `timestamp`, the
 * Tablet's local time without an offset, so they are compared with each
 * other only, read alike. Across a change of the Tablet's clock, such as a
 * daylight saving one, a reading from before it is far from the snapshots
 * after it, either way, so isn't current. Null with no snapshot, or for a
 * reading not current or not sent.
 */
export function milkTemperatureOf(probe: Record<string, unknown> | undefined, snapshot: Record<string, unknown> | undefined): number | null {
  if (!probe || !snapshot) return null;
  const taken = localTime(probe.timestamp);
  const now = localTime(snapshot.timestamp);
  if (taken === null || now === null || Math.abs(now - taken) > STALE_AFTER_MS) return null;
  return reported(probe, "temperature");
}

/** A time Decaid wrote in the Tablet's local time without an offset, in ms as if it were UTC, so two such differ exactly; null for anything else. */
function localTime(text: unknown): number | null {
  if (typeof text !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(text)) return null;
  const ms = Date.parse(`${text}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether the Machine is connected to its Tablet: whether the devices frame lists a machine connected, or null with none. */
export function machineConnectedOf(frame: Record<string, unknown> | undefined): boolean | null {
  if (!frame || !Array.isArray(frame.devices)) return null;
  return frame.devices.some((device: unknown) => {
    const listed = record(device);
    return listed?.type === "machine" && listed.state === "connected";
  });
}

/** How long the Live View goes without a machine frame before its values are stale (#258). */
export const STALE_AFTER_MS = 5_000;

/**
 * What the Live View can show of the Machine (#258, Stale and disconnected),
 * the first of these that holds:
 * - `offline`: the page's latest poll of the Machine found it offline, and
 *   no machine frame has come since the poll was asked that is still current:
 *   one that has is from a connection that took the Machine since, which the
 *   next poll will find;
 * - `mismatch`: its connection reports other hardware than the Machine's,
 *   which the server never asks to stream;
 * - `waiting`: nothing has come from its stream yet;
 * - `notConnected`: its Tablet's latest device list has its machine not
 *   connected;
 * - `asleep` or `stale`: by the page's clock, more than STALE_AFTER_MS has
 *   passed since the latest machine frame came (`staleAtOf`). Asleep where it
 *   said the Machine was asleep, as some firmware sends nothing while it
 *   sleeps; stale otherwise;
 * - `live`.
 */
export type LiveCondition = "offline" | "mismatch" | "waiting" | "notConnected" | "asleep" | "stale" | "live";

export function liveConditionOf({
  offlineAt,
  mismatched,
  live,
  openedAt,
  now,
}: {
  /** When the page asked for its latest poll of the Machine, if that found it offline, by its own clock, in ms; null if it found it online. */
  offlineAt: number | null;
  /** Whether its connection reports other hardware, as the page last polled it. */
  mismatched: boolean;
  live: LiveState | undefined;
  /** When the page last opened its stream, by its own clock, in ms, which counts as the latest machine frame until one comes. */
  openedAt: number;
  /** The page's time now, by the same clock. */
  now: number;
}): LiveCondition {
  const current = now <= staleAtOf(live, openedAt);
  if (offlineAt !== null && !(current && live?.machineArrivedAt !== undefined && live.machineArrivedAt > offlineAt)) return "offline";
  if (mismatched) return "mismatch";
  if (!live) return "waiting";
  if (machineConnectedOf(live.devices) === false) return "notConnected";
  if (current) return "live";
  return machineStateOf(live.machine?.snapshot)?.state === "sleeping" ? "asleep" : "stale";
}

/**
 * When, by the page's clock, the Live View's values go stale unless another
 * machine frame comes: STALE_AFTER_MS after the latest came, or, before the
 * first, after the page last opened its stream.
 */
export function staleAtOf(live: LiveState | undefined, openedAt: number): number {
  return (live?.machineArrivedAt ?? openedAt) + STALE_AFTER_MS;
}

/** A machine frame's snapshot and times, or null for a frame of another source or one without them. */
export function liveMachineOf(relayed: RelayedLiveFrame): LiveMachine | null {
  if (relayed.source !== "machine" || typeof relayed.stateSince !== "string") return null;
  return { snapshot: relayed.frame, receivedAt: relayed.receivedAt, stateSince: relayed.stateSince };
}

/**
 * How long the Machine has been in its Machine State: from when the plugin
 * saw its name begin to when it received the latest snapshot, both by the
 * tablet's clock, as "12 s", "3 min 4 s" or "2 h 5 min". Null where the
 * times can't be read.
 */
export function timeInState({ receivedAt, stateSince }: Pick<LiveMachine, "receivedAt" | "stateSince">): string | null {
  const ms = Date.parse(receivedAt) - Date.parse(stateSince);
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A finite number a snapshot sends under `key`, or null for one not sent. */
export function reported(snapshot: Record<string, unknown>, key: string): number | null {
  const value = snapshot[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
