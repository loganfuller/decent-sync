import type { RelayedLiveFrame } from "@decent-sync/protocol";

// Reading the Live View's events (ADR-0024): each is a live frame as the
// server relays it, Decaid's data inside left as Decaid sent it, so every
// value is read for what it is and may be missing. The latest of each source
// wins.

/**
 * The latest frame of each source the Live View has had, as the Machine's
 * plugin streamed them: its machine snapshot, and what Decaid's sockets sent.
 */
export interface LiveState {
  machine?: LiveMachine;
  /** The tank's water level and refill level (`currentLevel`, `refillLevel`, mm). */
  waterLevels?: Record<string, unknown>;
  /** The scale's latest frame: its connection status (`{"status": ...}`), or a weight. */
  scale?: Record<string, unknown>;
  /** The machine's shot settings, the steam temperature's target among them (`targetSteamTemp`). */
  shotSettings?: Record<string, unknown>;
  /** The Tablet's devices (`devices`), and whether each is connected. */
  devices?: Record<string, unknown>;
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
  if (!relayed || typeof relayed.source !== "string" || typeof relayed.receivedAt !== "string" || !record(relayed.frame)) return null;
  return relayed as unknown as RelayedLiveFrame;
}

/** The Live View with a relayed frame taken in, as the latest of its source; a frame of a source it doesn't show changes nothing. */
export function withLiveFrame(live: LiveState, relayed: RelayedLiveFrame): LiveState {
  switch (relayed.source) {
    case "machine": {
      const machine = liveMachineOf(relayed);
      return machine ? { ...live, machine } : live;
    }
    case "waterLevels":
    case "scale":
    case "shotSettings":
    case "devices":
      return { ...live, [relayed.source]: relayed.frame };
    default:
      return live;
  }
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

/** Whether the Machine is connected to its Tablet: whether the devices frame lists a machine connected, or null with none. */
export function machineConnectedOf(frame: Record<string, unknown> | undefined): boolean | null {
  if (!frame || !Array.isArray(frame.devices)) return null;
  return frame.devices.some((device: unknown) => {
    const listed = record(device);
    return listed?.type === "machine" && listed.state === "connected";
  });
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
