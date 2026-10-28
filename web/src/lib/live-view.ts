import type { RelayedLiveFrame } from "@decent-sync/protocol";

// Reading the Live View's events (ADR-0024): each is a live frame as the
// server relays it, Decaid's data inside left as Decaid sent it, so every
// value is read for what it is and may be missing.

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
