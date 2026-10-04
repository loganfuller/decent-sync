import {
  CLOSE_CODES,
  type ErrorCode,
  PROTOCOL_VERSION,
  type PluginMessage,
  type ServerMessage,
  decodeServerMessage,
  encode,
} from "@decent-sync/protocol";
import { readTabletIdentity } from "./decaid.js";
import type { PluginHost, TransportEvent } from "./host.js";
import type { SyncSettings } from "./settings.js";

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
/**
 * An attempt the server has not welcomed by then is abandoned and retried.
 * It covers opening the transport, which Decaid does not time out: a server
 * that accepts the TCP connection but never answers the WebSocket upgrade
 * would otherwise hold the attempt open for good.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/** Close codes after which retrying cannot help until someone changes something. */
const FINAL_CLOSES = new Map<number, string>([
  [CLOSE_CODES.bad_token, "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one."],
  [CLOSE_CODES.plugin_too_old, "The server needs a newer version of this plugin. Update the plugin."],
  [CLOSE_CODES.replaced, "Another tablet connected with this Machine's token, so this one stopped. Reload the plugin to take over again."],
]);

type TimerName = "reconnect" | "heartbeat" | "connect";

/**
 * The plugin's one connection to the sync server: `hello` on every connect,
 * heartbeats once welcomed, and reconnecting with backoff after a drop.
 * Stops for good on a close that retrying cannot fix.
 */
export class SyncConnection {
  /** The open handle, or undefined while disconnected. */
  private handle: string | undefined;
  /** Bumped by every attempt and drop, so late results of an older one are ignored. */
  private attempt = 0;
  private connecting = false;
  private stopped = false;
  private welcomed = false;
  private reconnectDelayMs = MIN_RECONNECT_MS;
  private readonly timers = new Map<TimerName, number>();

  constructor(
    private readonly host: PluginHost,
    private readonly settings: SyncSettings,
    private readonly log: (message: string) => void,
  ) {}

  /** Connects from a timer, so the caller (onLoad) returns at once. */
  start(): void {
    this.setTimer("reconnect", 0, () => void this.connect());
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.timers.values()) clearTimeout(id);
    this.timers.clear();
    this.closeHandle();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.handle !== undefined) return;
    this.connecting = true;
    const attempt = ++this.attempt;
    this.setTimer("connect", CONNECT_TIMEOUT_MS, () =>
      this.drop(`the server did not answer within ${CONNECT_TIMEOUT_MS / 1000} s`),
    );
    try {
      const identity = await readTabletIdentity();
      const { handle } = await this.host.transport.open({ kind: "websocket", url: this.settings.syncUrl });
      // Opened after the attempt was abandoned, by the deadline or by stop().
      if (this.stopped || attempt !== this.attempt) {
        this.host.transport.close(handle).catch(() => {});
        return;
      }
      this.handle = handle;
      this.welcomed = false;
      this.host.transport.onEvent(handle, (event) => this.onTransportEvent(handle, event));
      await this.send(handle, {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: this.settings.token,
        pluginVersion: __PLUGIN_VERSION__,
        decaidVersion: identity.decaidVersion,
        connectionId: identity.connectionId,
        machine: identity.machine,
      });
    } catch (error) {
      if (attempt === this.attempt) this.drop(`could not connect to ${this.settings.syncUrl}: ${describe(error)}`);
    } finally {
      // An abandoned attempt was released by drop(), and a newer one may be under way.
      if (attempt === this.attempt) this.connecting = false;
    }
  }

  private onTransportEvent(handle: string, event: TransportEvent): void {
    // Events for a handle already dropped, including its own close, are stale.
    if (handle !== this.handle) return;
    switch (event.type) {
      case "data":
        if (event.dataType === "text") this.onFrame(handle, event.data);
        break;
      case "error":
        this.drop(`connection error (${event.code}): ${event.message}`);
        break;
      case "close": {
        const final = event.code === undefined ? undefined : FINAL_CLOSES.get(event.code);
        if (final) {
          this.log(final);
          this.stop();
        } else {
          this.drop(`the server closed the connection${event.code === undefined ? "" : ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`}`);
        }
        break;
      }
    }
  }

  private onFrame(handle: string, frame: string): void {
    const decoded = decodeServerMessage(frame);
    if (!decoded.ok) {
      // A newer server may send messages this plugin does not know yet.
      this.log(`Ignoring a message from the server: ${decoded.problem}`);
      return;
    }
    this.onMessage(handle, decoded.message);
  }

  private onMessage(handle: string, message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        if (this.welcomed) return;
        this.welcomed = true;
        this.reconnectDelayMs = MIN_RECONNECT_MS;
        this.clearTimer("connect");
        this.log(`Connected to ${this.settings.syncUrl}`);
        this.scheduleHeartbeat(handle, message.heartbeatIntervalMs);
        break;
      case "error":
        // The close that follows decides what happens next.
        this.log(`The server reported ${describeError(message.code)}: ${message.message}`);
        break;
    }
  }

  private scheduleHeartbeat(handle: string, intervalMs: number): void {
    this.setTimer("heartbeat", intervalMs, () => {
      if (handle !== this.handle) return;
      this.send(handle, { type: "heartbeat" }).then(
        () => this.scheduleHeartbeat(handle, intervalMs),
        (error: unknown) => {
          if (handle === this.handle) this.drop(`could not send a heartbeat: ${describe(error)}`);
        },
      );
    });
  }

  private send(handle: string, message: PluginMessage): Promise<void> {
    return this.host.transport.send(handle, { type: "text", data: encode(message) });
  }

  /** Abandons the current connection or attempt, if any, and tries again after the backoff delay. */
  private drop(reason: string): void {
    this.attempt++;
    this.connecting = false;
    this.closeHandle();
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_MS);
    this.log(`Disconnected: ${reason}. Reconnecting in ${Math.round(delay / 1000)} s.`);
    this.setTimer("reconnect", delay, () => void this.connect());
  }

  private closeHandle(): void {
    const handle = this.handle;
    this.handle = undefined;
    this.welcomed = false;
    this.clearTimer("heartbeat");
    this.clearTimer("connect");
    if (handle !== undefined) this.host.transport.close(handle).catch(() => {});
  }

  private setTimer(name: TimerName, delay: number, callback: () => void): void {
    this.clearTimer(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        callback();
      }, delay),
    );
  }

  private clearTimer(name: TimerName): void {
    const id = this.timers.get(name);
    if (id !== undefined) clearTimeout(id);
    this.timers.delete(name);
  }
}

function describeError(code: ErrorCode | string): string {
  return code.replace(/_/g, " ");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
