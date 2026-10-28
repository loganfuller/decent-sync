import { type LiveFrame, encode, liveFrameFits, liveSourceOf, machineStateOf, utf8Length } from "@decent-sync/protocol";
import type { Transports } from "./host.js";

// The plugin's side of the Live View (ADR-0024): from the server's
// `liveStart` until its `liveStop`, or until the connection closes, it
// forwards Decaid's live frames as Decaid sent them, each tagged with the
// plugin's time it received it: the machine snapshots of `stateUpdate`, and
// the frames of Decaid's local sockets (`LIVE_SOCKETS`), which it opens only
// while streaming. Nothing here is kept across an unload. Live frames skip
// the outbox: they have no id, are never acknowledged or sent again, and one
// that can't be sent is dropped. They have a budget of their own instead
// (`LiveBudget`), so a slow link never fills Decaid's queue with them.

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
 * How many bytes of live frames the plugin may have sent that the server has
 * not yet said it received (`liveReceived`). Decaid writes a transport's
 * frames in order and its `send` resolves once a frame is queued, so this is
 * the only measure of what may still be unsent. It leaves Decaid's 1 MiB
 * queue room for the outbox's 512 KiB of unconfirmed frames (sender.ts), a
 * `hello` and heartbeats, which live frames on a slow or stalled link would
 * otherwise fill.
 */
export const LIVE_BUDGET_BYTES = 64 * 1024;

/**
 * The live budget of one connection: a frame is sent while the bytes sent on
 * it, less those the server says it has received (`received`), stay within
 * LIVE_BUDGET_BYTES. Past it, each source holds at most one frame, which a
 * newer one replaces, and every frame offered waits behind those held, so
 * they go in the order they came as `liveReceived` frees room. A frame
 * Decaid refuses never leaves the tablet, so its bytes are freed too.
 */
export class LiveBudget<T> {
  /** The bytes of live frames sent on the connection, less those Decaid refused. */
  private sent = 0;
  /** The bytes of them the server has said it received. */
  private receivedBytes = 0;
  /** The frames held, the latest of each source, in the order they came. */
  private readonly held = new Map<string, { frame: T; bytes: number }>();

  constructor(private readonly send: (frame: T) => Promise<void>) {}

  /** Sends the frame, of `bytes` as sent, or holds it as its source's latest. */
  offer(source: string, frame: T, bytes: number): void {
    if (this.held.size === 0 && this.fits(bytes)) return this.forward(frame, bytes);
    this.held.delete(source);
    this.held.set(source, { frame, bytes });
  }

  /** The server's `liveReceived`: the bytes of live frames it has received on the connection, in all. */
  received(bytes: number): void {
    this.receivedBytes = Math.max(this.receivedBytes, bytes);
    this.release();
  }

  /** Drops the frames it holds, as streaming stops. What was sent stays counted until the server receives it. */
  clear(): void {
    this.held.clear();
  }

  private fits(bytes: number): boolean {
    return this.sent - this.receivedBytes + bytes <= LIVE_BUDGET_BYTES;
  }

  /** Sends what is held, in order, while it fits. */
  private release(): void {
    for (const [source, { frame, bytes }] of this.held) {
      if (!this.fits(bytes)) return;
      this.held.delete(source);
      this.forward(frame, bytes);
    }
  }

  private forward(frame: T, bytes: number): void {
    this.sent += bytes;
    // Refused by Decaid's transport, or the connection closed: a live frame is never sent again.
    this.send(frame).catch(() => {
      this.sent -= bytes;
      this.release();
    });
  }
}

/**
 * Decaid's local sockets the Live View forwards, by the source their frames
 * are tagged with. As each opens, Decaid sends the latest water levels, shot
 * settings and device list, and the scale's connection status; the scale's
 * weights are live only. The water levels and shot settings come only while
 * a machine is connected (`_withDe1Ws` in
 * decaid:lib/src/services/webserver/de1handler.dart, `ScaleHandler` and
 * `DevicesHandler` beside it, at v0.9.0).
 */
export const LIVE_SOCKETS = {
  waterLevels: "ws://localhost:8080/ws/v1/machine/waterLevels",
  scale: "ws://localhost:8080/ws/v1/scale/snapshot",
  shotSettings: "ws://localhost:8080/ws/v1/machine/shotSettings",
  devices: "ws://localhost:8080/ws/v1/devices",
} as const;

export type SocketSource = keyof typeof LIVE_SOCKETS;

const SOCKET_SOURCES = Object.keys(LIVE_SOCKETS) as SocketSource[];

/**
 * How long after a socket fails to open, as for want of a transport, or
 * closes, it is opened again while streaming.
 */
export const LIVE_SOCKET_RETRY_MS = 5_000;

/**
 * Decaid's local sockets (LIVE_SOCKETS), open while the Live View streams:
 * each text frame one sends is passed to `received`. A socket that can't
 * open, as where that would leave no transport free for a connection to the
 * server (`Transports`), or that closes, is opened again after
 * LIVE_SOCKET_RETRY_MS while they are wanted.
 */
export class LiveSockets {
  private wanted = false;
  /** Bumped by every close, so an open that ends after it is closed at once. */
  private generation = 0;
  private readonly handles = new Map<SocketSource, string>();
  private readonly opening = new Set<SocketSource>();
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly transports: Transports,
    private readonly received: (source: SocketSource, text: string) => void,
  ) {}

  /** Opens each socket not open or opening. */
  open(): void {
    this.wanted = true;
    for (const source of SOCKET_SOURCES) this.openSocket(source);
  }

  /** Closes every socket, and one still opening once it opens. */
  close(): void {
    this.wanted = false;
    this.generation++;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    this.opening.clear();
    for (const handle of this.handles.values()) this.transports.close(handle);
    this.handles.clear();
  }

  private openSocket(source: SocketSource): void {
    if (!this.wanted || this.handles.has(source) || this.opening.has(source)) return;
    const generation = this.generation;
    this.opening.add(source);
    this.transports.open(LIVE_SOCKETS[source]).then(
      (handle) => {
        if (generation !== this.generation) return void this.transports.close(handle);
        this.opening.delete(source);
        this.handles.set(source, handle);
        this.transports.onEvent(handle, (event) => {
          if (this.handles.get(source) !== handle) return;
          if (event.type !== "data") {
            this.handles.delete(source);
            this.transports.close(handle);
            this.retryLater();
          } else if (event.dataType === "text") {
            this.received(source, event.data);
          }
        });
      },
      () => {
        if (generation !== this.generation) return;
        this.opening.delete(source);
        this.retryLater();
      },
    );
  }

  private retryLater(): void {
    if (this.retry !== undefined) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      for (const source of SOCKET_SOURCES) this.openSocket(source);
    }, LIVE_SOCKET_RETRY_MS);
  }
}

/**
 * Streams the plugin's live frames on the connection that asked, at the rate
 * rule's pace (`LiveRate`), within the live budget (`LiveBudget`), each
 * source on its own: the machine, each `stateUpdate`, Decaid's machine
 * snapshot, with when its Machine State began (`TimeInState`), which is
 * tracked whether or not it streams, and across reconnects; and Decaid's
 * local sockets (`LiveSockets`), open only while streaming. A frame whose
 * notification would pass PostgreSQL's limit (`liveFrameFits`), or that
 * Decaid's transport refuses, is dropped, as is a socket's frame that isn't
 * a JSON object.
 */
export class LiveView {
  /** Sends on the connection streaming, while one is. */
  private streaming: ((frame: LiveFrame) => Promise<void>) | undefined;
  private readonly timeInState = new TimeInState();
  private readonly rate = new LiveRate<LiveFrame>((frame) => this.send(frame));
  /** The live budget of the connection, which the next connection starts afresh. */
  private budget = this.newBudget();
  /** Set once a frame too large to relay was dropped while streaming, so the log says so once a stream. */
  private droppedLarge = false;
  private readonly sockets: LiveSockets;

  constructor(
    private readonly log: (message: string) => void,
    transports: Transports,
  ) {
    this.sockets = new LiveSockets(transports, (source, text) => this.socketFrame(source, text));
  }

  /** The server's `liveStart`: streams on the connection given, opening Decaid's sockets, unless already streaming. */
  start(send: (frame: LiveFrame) => Promise<void>): void {
    if (this.streaming) return;
    this.streaming = send;
    this.droppedLarge = false;
    this.sockets.open();
  }

  /**
   * The server's `liveStop`: closes Decaid's sockets and drops the frames
   * held. The bytes the server has yet to receive stay counted, as it may
   * start the same connection again.
   */
  stop(): void {
    this.streaming = undefined;
    this.sockets.close();
    this.rate.clear();
    this.budget.clear();
  }

  /** The end of the connection, streaming or not: the next connection's budget starts afresh. */
  disconnected(): void {
    this.stop();
    this.budget = this.newBudget();
  }

  /** The server's `liveReceived`: the bytes of live frames it has received on this connection, in all. */
  received(bytes: number): void {
    this.budget.received(bytes);
  }

  /** Decaid's `stateUpdate`: the machine snapshot, several times a second while a machine is connected. */
  stateUpdate(payload: unknown): void {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const receivedAt = new Date().toISOString();
    const named = this.timeInState.observe(payload, receivedAt);
    if (!this.streaming || !named) return;
    const frame: LiveFrame = { type: "liveFrame", source: "machine", receivedAt, stateSince: named.since, frame: payload as Record<string, unknown> };
    this.rate.offer("machine", frame, { now: this.inActivity() || named.changed });
  }

  /** A text frame one of Decaid's sockets sent: forwarded as it is, if a JSON object. */
  private socketFrame(source: SocketSource, text: string): void {
    if (!this.streaming) return;
    const receivedAt = new Date().toISOString();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    this.rate.offer(source, { type: "liveFrame", source, receivedAt, frame: payload as Record<string, unknown> }, { now: this.inActivity() });
  }

  /** Whether the latest machine snapshot reported an activity (LIVE_ACTIVITIES), during which every frame goes. */
  private inActivity(): boolean {
    return LIVE_ACTIVITIES.has(this.timeInState.latestState() ?? "");
  }

  private send(frame: LiveFrame): void {
    if (!this.streaming) return;
    if (!liveFrameFits(frame)) {
      if (!this.droppedLarge) this.log(`Dropped a ${frame.source} frame too large to relay to the Live View; any more are dropped too.`);
      this.droppedLarge = true;
      return;
    }
    this.budget.offer(liveSourceOf(frame), frame, utf8Length(encode(frame)));
  }

  private newBudget(): LiveBudget<LiveFrame> {
    return new LiveBudget((frame) => (this.streaming ? this.streaming(frame) : Promise.reject(new Error("Not streaming"))));
  }
}
