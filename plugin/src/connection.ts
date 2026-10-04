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
/** A connection the server has not welcomed by then is dropped and retried. */
const WELCOME_TIMEOUT_MS = 30_000;

/** Close codes after which retrying cannot help until someone changes something. */
const FINAL_CLOSES = new Map<number, string>([
  [CLOSE_CODES.bad_token, "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one."],
  [CLOSE_CODES.plugin_too_old, "The server needs a newer version of this plugin. Update the plugin."],
  [CLOSE_CODES.replaced, "Another tablet connected with this Machine's token, so this one stopped. Reload the plugin to take over again."],
]);

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
  private readonly timers = new Map<"reconnect" | "heartbeat" | "welcome", number>();

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
    try {
      const identity = await readTabletIdentity();
      const { handle } = await this.host.transport.open({ kind: "websocket", url: this.settings.syncUrl });
      if (this.stopped || attempt !== this.attempt) {
        this.host.transport.close(handle).catch(() => {});
        return;
      }
      this.handle = handle;
      this.welcomed = false;
      this.host.transport.onEvent(handle, (event) => this.onTransportEvent(handle, event));
      this.setTimer("welcome", WELCOME_TIMEOUT_MS, () => this.drop("the server sent no welcome"));
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
      this.connecting = false;
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
        this.clearTimer("welcome");
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

  /** Abandons the current connection, if any, and tries again after the backoff delay. */
  private drop(reason: string): void {
    this.attempt++;
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
    this.clearTimer("welcome");
    if (handle !== undefined) this.host.transport.close(handle).catch(() => {});
  }

  private setTimer(name: "reconnect" | "heartbeat" | "welcome", delay: number, callback: () => void): void {
    this.clearTimer(name);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        callback();
      }, delay),
    );
  }

  private clearTimer(name: "reconnect" | "heartbeat" | "welcome"): void {
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
