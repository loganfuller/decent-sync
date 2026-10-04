import {
  CLOSE_CODES,
  type ErrorCode,
  MISSED_HEARTBEATS,
  type MachineHardware,
  PROTOCOL_VERSION,
  type PluginMessage,
  type ServerMessage,
  decodeServerMessage,
  encode,
  sameHardware,
} from "@decent-sync/protocol";
import { readMachineHardware, readTabletIdentity } from "./decaid.js";
import type { PluginHost, TransportEvent } from "./host.js";
import type { SyncSettings } from "./settings.js";

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
/**
 * An attempt the server has not welcomed by then is abandoned and retried.
 * It covers opening the transport, which Decaid does not time out: a server
 * that accepts the TCP connection but never answers the WebSocket upgrade
 * would otherwise hold the attempt open for good. Reading Decaid's API comes
 * before it, since Decaid already times out its fetches (after 30 s).
 */
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Decaid's limit on transports per plugin generation, which counts opens
 * still in progress (plugin_transport_service.dart). An abandoned open cannot
 * be cancelled: it holds its slot until it ends, which for an upgrade the
 * server never answers may be never.
 */
const MAX_TRANSPORTS = 8;
/**
 * Machine state updates arrive many times a second while a machine is
 * connected; after one leads to a hardware check, the next waits this long.
 */
const HARDWARE_CHECK_COOLDOWN_MS = 5_000;

/** Close codes after which retrying cannot help until someone changes something. */
const FINAL_CLOSES = new Map<number, string>([
  [CLOSE_CODES.bad_token, "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one."],
  [CLOSE_CODES.plugin_too_old, "The server needs a newer version of this plugin. Update the plugin."],
  [CLOSE_CODES.replaced, "Another tablet connected with this Machine's token, so this one stopped. Reload the plugin to take over again."],
]);

type TimerName = "reconnect" | "heartbeat" | "silence" | "connect" | "hardwarePoll" | "hardwareCooldown";

/**
 * The plugin's one connection to the sync server: `hello` on every connect,
 * heartbeats once welcomed, and reconnecting with backoff after a drop.
 * Stops for good on a close that retrying cannot fix.
 *
 * The server answers every heartbeat, so a welcomed connection the server has
 * sent nothing on for `MISSED_HEARTBEATS` intervals is dropped. A server host
 * that vanished without resetting the connection would otherwise leave it
 * open, capturing nothing, until Android's TCP retransmissions give up.
 *
 * The server decides who the tablet is only at `hello` (ADR-0015), so when
 * the machine first reports its hardware, or reports different hardware,
 * the plugin reconnects to send a new one. It checks on machine state
 * updates and every poll interval. After the server refuses the reported
 * hardware for this token, it connects again only once the machine reports
 * other hardware.
 */
export class SyncConnection {
  /** The open handle, or undefined while disconnected. */
  private handle: string | undefined;
  /** Bumped by every attempt and drop, so late results of an older one are ignored. */
  private attempt = 0;
  private connecting = false;
  private stopped = false;
  private welcomed = false;
  /** How long a welcomed connection may go without hearing from the server, from its `welcome`. */
  private silenceMs = 0;
  private reconnectDelayMs = MIN_RECONNECT_MS;
  /** Transports opening, open or closing, as Decaid counts them against MAX_TRANSPORTS. */
  private transportsInUse = 0;
  private readonly timers = new Map<TimerName, number>();
  /** The hardware the latest `hello` reported, null while no machine was connected. */
  private sentHardware: MachineHardware | null = null;
  /** Hardware the server dismissed for this token; while set, the plugin does not connect. */
  private dismissedHardware: MachineHardware | null = null;
  private checkingHardware = false;
  private hardwareCooldown = false;

  constructor(
    private readonly host: PluginHost,
    private readonly settings: SyncSettings,
    private readonly log: (message: string) => void,
  ) {}

  /** Connects from a timer, so the caller (onLoad) returns at once. */
  start(): void {
    this.setTimer("reconnect", 0, () => void this.connect());
    this.scheduleHardwarePoll();
  }

  /** A machine state update: the machine is connected, and may have just reported its hardware. */
  machineActive(): void {
    if (this.stopped || this.hardwareCooldown) return;
    this.hardwareCooldown = true;
    this.setTimer("hardwareCooldown", HARDWARE_CHECK_COOLDOWN_MS, () => {
      this.hardwareCooldown = false;
    });
    void this.checkHardware();
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
      if (this.stopped || attempt !== this.attempt) return;
      if (this.transportsInUse >= MAX_TRANSPORTS) {
        this.drop(
          `${this.transportsInUse} earlier connection attempts are still waiting for the server to answer, and Decaid allows no more until one ends. Reloading the plugin releases them`,
        );
        return;
      }
      this.setTimer("connect", CONNECT_TIMEOUT_MS, () =>
        this.drop(`the server did not answer within ${CONNECT_TIMEOUT_MS / 1000} s`),
      );
      const handle = await this.openTransport();
      // Opened after the attempt was abandoned, by the deadline or by stop().
      if (this.stopped || attempt !== this.attempt) {
        this.closeTransport(handle);
        return;
      }
      this.handle = handle;
      this.welcomed = false;
      this.sentHardware = identity.machine;
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
        // Anything the server sends shows it is there, even a message this plugin cannot read.
        if (handle === this.handle && this.welcomed) this.awaitServer(handle);
        break;
      case "error":
        this.drop(`connection error (${event.code}): ${event.message}`);
        break;
      case "close": {
        if (event.code === CLOSE_CODES.hardware_dismissed && this.sentHardware) {
          this.dismissedHardware = this.sentHardware;
          this.abandon();
          this.log(
            "The server refused this machine's hardware for this Machine's token. Not connecting until the machine reports other hardware, or another token is entered.",
          );
          break;
        }
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
        this.silenceMs = message.heartbeatIntervalMs * MISSED_HEARTBEATS;
        this.scheduleHeartbeat(handle, message.heartbeatIntervalMs);
        break;
      case "heartbeat":
        // Its arrival is what counts.
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

  /** Restarts the wait for the server's next message, dropping the connection if none comes in time. */
  private awaitServer(handle: string): void {
    this.setTimer("silence", this.silenceMs, () => {
      if (handle === this.handle) this.drop(`heard nothing from the server for ${this.silenceMs / 1000} s`);
    });
  }

  private send(handle: string, message: PluginMessage): Promise<void> {
    return this.host.transport.send(handle, { type: "text", data: encode(message) });
  }

  /**
   * Reads the machine's hardware and reconnects if the current connection
   * reported other hardware, or none, or if it differs from hardware the
   * server dismissed.
   */
  private async checkHardware(): Promise<void> {
    if (this.stopped || this.checkingHardware) return;
    this.checkingHardware = true;
    try {
      const hardware = await readMachineHardware();
      // While no machine is connected there is nothing new to tell the server.
      if (this.stopped || hardware === null) return;
      if (this.dismissedHardware) {
        if (sameHardware(hardware, this.dismissedHardware)) return;
        this.dismissedHardware = null;
        this.log("The machine reports other hardware than the server refused. Connecting.");
        this.reconnectNow();
        return;
      }
      if (!this.welcomed || sameHardware(hardware, this.sentHardware)) return;
      this.log(
        this.sentHardware === null
          ? "The machine reports its hardware now. Reconnecting to tell the server."
          : "The machine reports different hardware. Reconnecting to tell the server.",
      );
      this.reconnectNow();
    } finally {
      this.checkingHardware = false;
    }
  }

  private scheduleHardwarePoll(): void {
    this.setTimer("hardwarePoll", this.settings.pollSeconds * 1000, () => {
      void this.checkHardware().finally(() => {
        if (!this.stopped) this.scheduleHardwarePoll();
      });
    });
  }

  /** Replaces the current connection, or ends a wait, with a new attempt at once. */
  private reconnectNow(): void {
    this.abandon();
    this.reconnectDelayMs = MIN_RECONNECT_MS;
    this.setTimer("reconnect", 0, () => void this.connect());
  }

  /** Abandons the current connection or attempt, if any, without trying again. */
  private abandon(): void {
    this.attempt++;
    this.connecting = false;
    this.clearTimer("reconnect");
    this.closeHandle();
  }

  /** Abandons the current connection or attempt, if any, and tries again after the backoff delay. */
  private drop(reason: string): void {
    this.abandon();
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
    this.clearTimer("silence");
    this.clearTimer("connect");
    if (handle !== undefined) this.closeTransport(handle);
  }

  private async openTransport(): Promise<string> {
    this.transportsInUse++;
    try {
      return (await this.host.transport.open({ kind: "websocket", url: this.settings.syncUrl })).handle;
    } catch (error) {
      this.transportsInUse--;
      throw error;
    }
  }

  /** Closes a transport, which counts against the limit until Decaid has closed it. */
  private closeTransport(handle: string): void {
    const release = () => {
      this.transportsInUse--;
    };
    this.host.transport.close(handle).then(release, release);
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
