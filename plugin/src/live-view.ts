import { type LiveFrame, liveFrameFits, machineStateOf } from "@decent-sync/protocol";

// The plugin's side of the Live View (ADR-0024): from the server's
// `liveStart` until its `liveStop`, or until the connection closes, it
// forwards Decaid's live frames as Decaid sent them, each tagged with the
// plugin's time it received it. Nothing here is kept across an unload. Live
// frames skip the outbox: they have no id, are never acknowledged or sent
// again, and one that can't be sent is dropped.

/**
 * Decaid's states during which every live frame is forwarded: a shot,
 * steaming, a hot water pour and a flush. Otherwise each source forwards at
 * most one a LIVE_INTERVAL_MS, the latest winning.
 */
export const LIVE_ACTIVITIES: ReadonlySet<string> = new Set(["espresso", "steam", "hotWater", "flush"]);

/** How often a source forwards a live frame outside an activity, at most. */
export const LIVE_INTERVAL_MS = 1_000;

/**
 * How long the Machine has been in its Machine State, by the plugin's clock:
 * from when the plugin saw its name (`nameMachineState`) change. A change of
 * detail alone, such as preinfusion to pouring, a step skipped or a pause in
 * steaming, doesn't restart it. Decaid's own `timestamp` is the tablet's local
 * time without an offset, so it is never used.
 */
export class TimeInState {
  private name: string | undefined;
  private since: string | undefined;
  private state: string | undefined;

  /**
   * Takes in a machine snapshot the plugin received at `at`, in UTC. Says
   * when its Machine State's name began, and whether it began with this
   * snapshot; undefined while no snapshot has reported a state.
   */
  observe(snapshot: unknown, at: string): { since: string; changed: boolean } | undefined {
    const named = machineStateOf(snapshot);
    let changed = false;
    if (named) {
      this.state = named.state;
      if (named.name !== this.name) {
        this.name = named.name;
        this.since = at;
        changed = true;
      }
    }
    return this.since === undefined ? undefined : { since: this.since, changed };
  }

  /** Decaid's state in the latest snapshot that reported one, such as espresso. */
  latestState(): string | undefined {
    return this.state;
  }
}

/**
 * The rate rule: during an activity (LIVE_ACTIVITIES), or for a change of
 * Machine State, a frame is forwarded at once. Otherwise each source forwards
 * at most one frame a LIVE_INTERVAL_MS: a frame offered within that time of
 * the last forwarded is held, a newer one replacing it, and forwarded once the
 * time is up. Timed with the host's timers, which a test may run faster.
 */
export class LiveRate<T> {
  /** For each source that forwarded a frame within LIVE_INTERVAL_MS, its timer, and the frame it holds. */
  private readonly gates = new Map<string, { timer: ReturnType<typeof setTimeout>; held?: T }>();

  constructor(private readonly forward: (frame: T) => void) {}

  offer(source: string, frame: T, { now }: { now: boolean }): void {
    const gate = this.gates.get(source);
    if (gate && !now) {
      gate.held = frame;
      return;
    }
    if (gate) clearTimeout(gate.timer);
    this.send(source, frame);
  }

  /** Drops every frame held, as streaming stops. */
  clear(): void {
    for (const gate of this.gates.values()) clearTimeout(gate.timer);
    this.gates.clear();
  }

  private send(source: string, frame: T): void {
    this.gates.set(source, {
      timer: setTimeout(() => {
        const held = this.gates.get(source)?.held;
        this.gates.delete(source);
        if (held !== undefined) this.send(source, held);
      }, LIVE_INTERVAL_MS),
    });
    this.forward(frame);
  }
}

/**
 * Streams the plugin's live frames on the connection that asked, at the rate
 * rule's pace (`LiveRate`). For now its one source is the machine: each
 * `stateUpdate`, Decaid's machine snapshot, with when its Machine State began
 * (`TimeInState`), which is tracked whether or not it streams, and across
 * reconnects. A frame whose notification would pass PostgreSQL's limit
 * (`liveFrameFits`), or that Decaid's transport refuses, is dropped.
 */
export class LiveView {
  /** Sends on the connection streaming, while one is. */
  private streaming: ((frame: LiveFrame) => Promise<void>) | undefined;
  private readonly timeInState = new TimeInState();
  private readonly rate = new LiveRate<LiveFrame>((frame) => this.send(frame));
  /** Set once a frame too large to relay was dropped while streaming, so the log says so once a stream. */
  private droppedLarge = false;

  constructor(private readonly log: (message: string) => void) {}

  /** The server's `liveStart`: streams on the connection given, unless already streaming. */
  start(send: (frame: LiveFrame) => Promise<void>): void {
    if (this.streaming) return;
    this.streaming = send;
    this.droppedLarge = false;
  }

  /** The server's `liveStop`, or the end of the connection streaming. */
  stop(): void {
    this.streaming = undefined;
    this.rate.clear();
  }

  /** Decaid's `stateUpdate`: the machine snapshot, several times a second while a machine is connected. */
  stateUpdate(payload: unknown): void {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const receivedAt = new Date().toISOString();
    const named = this.timeInState.observe(payload, receivedAt);
    if (!this.streaming || !named) return;
    const frame: LiveFrame = { type: "liveFrame", source: "machine", receivedAt, stateSince: named.since, frame: payload as Record<string, unknown> };
    const activity = LIVE_ACTIVITIES.has(this.timeInState.latestState() ?? "");
    this.rate.offer("machine", frame, { now: activity || named.changed });
  }

  private send(frame: LiveFrame): void {
    const send = this.streaming;
    if (!send) return;
    if (!liveFrameFits(frame)) {
      if (!this.droppedLarge) this.log(`Dropped a ${frame.source} frame too large to relay to the Live View; any more are dropped too.`);
      this.droppedLarge = true;
      return;
    }
    // Refused by Decaid's transport, or the connection closed: a live frame is never sent again.
    send(frame).catch(() => {});
  }
}
