import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYNC_PATH } from "@decent-sync/protocol";
import WebSocket from "ws";

// Seam 1's simulated tablet: runs the built decent-sync.reaplugin/plugin.js
// (`npm run build` first) in a stand-in for Decaid's plugin host, the way
// Decaid v0.8.7 does (decaid:lib/src/plugins/plugin_manager.dart and
// plugin_transport_service.dart):
//
// - The source is pasted into a function body with `host`, `fetch`,
//   `setTimeout` and `clearTimeout` in scope; the global createPlugin(host)
//   must return an object whose id matches the manifest, and onLoad is called
//   synchronously without awaiting it.
// - `fetch` answers Decaid's local API from fixtures, failing after Decaid's
//   30 s timeout.
// - `host.transport` opens real WebSockets with only a URL and subprotocols
//   (no custom headers), allows 8 live transports per plugin generation
//   (counting opens still in progress, which cannot be cancelled),
//   rejects a send that would take the pending outbound bytes past 1 MiB,
//   closes a transport whose undelivered inbound bytes pass 1 MiB, and
//   delivers events asynchronously and in order, ending with a close event.
// - Unloading calls onUnload, then cancels the generation's timers and closes
//   its transports, dropping their later events.
// - Timers are the host's, so a test can run them faster with `timeScale` to
//   reach the plugin's timeouts and backoff quickly.
//
// RawConnection is the raw-frame mode, for protocol cases the plugin never
// produces.

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reapluginDir = path.join(repoDir, "decent-sync.reaplugin");
const fixturesDir = path.join(repoDir, "server/test/fixtures/decaid");

const API_ORIGIN = "http://localhost:8080";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_LIVE_TRANSPORTS = 8;
const MAX_PENDING_OUTBOUND_BYTES = 1 << 20;
const MAX_QUEUED_INBOUND_BYTES = 1 << 20;

export interface BuiltPlugin {
  id: string;
  version: string;
  onLoad(settings: Record<string, unknown>): unknown;
  onUnload(): unknown;
  onEvent(event: { name: string; payload?: unknown }): unknown;
}

export function readBuiltPlugin(): { source: string; manifest: Record<string, unknown> } {
  return {
    source: fs.readFileSync(path.join(reapluginDir, "plugin.js"), "utf8"),
    manifest: JSON.parse(fs.readFileSync(path.join(reapluginDir, "manifest.json"), "utf8")),
  };
}

/** Decaid API responses, by path under /api/v1 (such as "/machine/info"). */
export type DecaidApi = Record<string, unknown>;

/** The test tablet's DE1Pro on Decaid 0.8.6, with its hardware ids replaced (see the fixtures' README). */
export function de1ProOnDecaid086(): DecaidApi {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(fixturesDir, "de1pro-v0.8.6", file), "utf8"));
  return { "/info": read("info.json"), "/machine/info": read("machine-info.json"), "/settings": read("settings.json") };
}

/**
 * Derived from de1ProOnDecaid086(): the same responses, with the machine's
 * reported model and serial, or the preferred machine's connection id,
 * changed. Every other field is as Decaid sent it.
 */
export function derivedDe1Pro(changes: { model?: string; serial?: string; connectionId?: string }): DecaidApi {
  const api = de1ProOnDecaid086();
  const machineInfo = api["/machine/info"] as Record<string, unknown>;
  const settings = api["/settings"] as Record<string, unknown>;
  return {
    ...api,
    "/machine/info": {
      ...machineInfo,
      ...(changes.model === undefined ? {} : { model: changes.model }),
      ...(changes.serial === undefined ? {} : { serialNumber: changes.serial }),
    },
    "/settings": { ...settings, ...(changes.connectionId === undefined ? {} : { preferredMachineId: changes.connectionId }) },
  };
}

export interface SimulatedTabletOptions {
  /** Plugin settings as Decaid passes them: only the ones that are set. */
  settings: Record<string, unknown>;
  /** Decaid's API responses; defaults to de1ProOnDecaid086(). */
  api?: DecaidApi;
  /** Whether a machine is connected to the tablet; while not, /machine/info fails. Defaults to true. */
  machineConnected?: boolean;
  /** Runs the plugin's timers, and the delays below, this many times faster. Defaults to 1. */
  timeScale?: number;
  /** How long Decaid's API takes to answer each request; from 30 s on, the request times out. Defaults to 0. */
  apiDelayMs?: number;
}

type TransportEvent = Record<string, unknown> & { type: string };

interface TransportRecord {
  handle: string;
  socket: WebSocket;
  listener?: (event: TransportEvent) => void;
  inbound: { event: TransportEvent; size: number }[];
  inboundBytes: number;
  pendingOutboundBytes: number;
  /** Closed, by either end or a failure; no further sends. */
  terminal: boolean;
  closing: boolean;
  draining: boolean;
}

class TransportError extends Error {
  constructor(
    message: string,
    readonly code = "transport_error",
  ) {
    super(message);
  }
}

export class SimulatedTablet {
  readonly logs: string[] = [];
  readonly plugin: BuiltPlugin;
  machineConnected: boolean;
  private api: DecaidApi;
  private readonly timeScale: number;
  private readonly apiDelayMs: number;
  /** Opens not yet connected; Decaid counts them against the transport limit. */
  private opening = 0;
  private readonly transports = new Map<string, TransportRecord>();
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private nextTimerId = 0;
  private nextHandle = 0;
  private unloaded = false;

  /** Loads the built plugin and calls onLoad, as Decaid does when the plugin is enabled. */
  static load(options: SimulatedTabletOptions): SimulatedTablet {
    return new SimulatedTablet(options);
  }

  private constructor(options: SimulatedTabletOptions) {
    this.api = options.api ?? de1ProOnDecaid086();
    this.machineConnected = options.machineConnected ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.apiDelayMs = options.apiDelayMs ?? 0;
    const { source, manifest } = readBuiltPlugin();
    this.plugin = loadPlugin(source, String(manifest.id), {
      host: {
        log: (message: unknown) => this.logs.push(String(message)),
        transport: {
          open: (options: unknown) => this.open(options),
          onEvent: (handle: string, listener: (event: TransportEvent) => void) => this.onEvent(handle, listener),
          send: (handle: string, payload: unknown) => this.send(handle, payload),
          close: (handle: string) => this.close(handle),
        },
      },
      fetch: (input: unknown) => this.fetch(input),
      setTimeout: (callback: () => void, delay: number) => this.setTimer(callback, delay),
      clearTimeout: (id: number) => this.clearTimer(id),
    });
    this.plugin.onLoad(options.settings);
  }

  /** Answers Decaid's API with these responses from now on, as when another machine is connected. */
  serve(api: DecaidApi): void {
    this.api = api;
  }

  /**
   * Connects the machine to the tablet: /machine/info answers from now on,
   * and Decaid starts sending machine state updates, of which this delivers
   * one. The plugin reads nothing from its payload, so none is sent.
   */
  connectMachine(): void {
    this.machineConnected = true;
    this.fire("stateUpdate");
  }

  /** Delivers a Decaid event to the plugin. */
  fire(name: string, payload?: unknown): void {
    if (!this.unloaded) this.plugin.onEvent({ name, payload });
  }

  /** Loses the network: every connection ends without a close handshake, as if the Wi-Fi dropped. */
  dropConnections(): void {
    for (const record of this.transports.values()) record.socket.terminate();
  }

  /** Unloads the plugin, as disabling it, changing its settings or quitting Decaid does. */
  async unload(): Promise<void> {
    if (this.unloaded) return;
    try {
      this.plugin.onUnload();
    } finally {
      this.unloaded = true;
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      const closing = [...this.transports.values()].map((record) => this.closeNative(record));
      await Promise.all(closing);
      this.transports.clear();
    }
  }

  /** Resolves with the first log line, past or future, that matches. */
  async waitForLog(pattern: RegExp, timeoutMs = 10_000): Promise<string> {
    return (await this.waitForLogs(pattern, 1, timeoutMs))[0]!;
  }

  /** Resolves once at least `count` log lines, past or future, match. */
  async waitForLogs(pattern: RegExp, count: number, timeoutMs = 10_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const lines = this.logs.filter((log) => pattern.test(log));
      if (lines.length >= count) return lines;
      if (Date.now() > deadline) {
        throw new Error(`${lines.length} of ${count} logs matched ${pattern} within ${timeoutMs} ms. Logs:\n${this.logs.join("\n")}`);
      }
      await delay(20);
    }
  }

  // Decaid's plugin fetch, limited to its own API.
  private async fetch(input: unknown): Promise<unknown> {
    await delay(Math.min(this.apiDelayMs, FETCH_TIMEOUT_MS) / this.timeScale);
    if (this.apiDelayMs >= FETCH_TIMEOUT_MS) throw new Error("Fetch timed out");
    const url = String(input);
    if (!url.startsWith(`${API_ORIGIN}/api/v1/`)) throw new Error(`The simulated tablet has no network for ${url}`);
    const route = url.slice(`${API_ORIGIN}/api/v1`.length).split("?")[0]!;
    if (route === "/machine/info" && !this.machineConnected) {
      // de1handler.dart answers a DeviceNotConnectedException with a 500.
      return response(500, JSON.stringify({ error: "DeviceNotConnectedException: no machine connected" }));
    }
    if (!(route in this.api)) return response(404, "");
    return response(200, JSON.stringify(this.api[route]));
  }

  private setTimer(callback: () => void, delayMs: number): number {
    const id = ++this.nextTimerId;
    this.timers.set(
      id,
      setTimeout(
        () => {
          this.timers.delete(id);
          if (!this.unloaded) callback();
        },
        Math.max(0, Math.trunc(Number(delayMs) || 0)) / this.timeScale,
      ),
    );
    return id;
  }

  private clearTimer(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  private async open(options: unknown): Promise<{ handle: string; protocol?: string }> {
    const { kind, url, protocols } = (options ?? {}) as { kind?: unknown; url?: unknown; protocols?: unknown };
    if (kind !== "websocket") throw new TransportError(`The plugin may open only WebSocket transports, not ${String(kind)}`);
    if (typeof url !== "string" || !(url.startsWith("ws://") || url.startsWith("wss://"))) {
      throw new TransportError("WebSocket transport requires a ws:// or wss:// url");
    }
    if (protocols !== undefined && (!Array.isArray(protocols) || protocols.some((p) => typeof p !== "string"))) {
      throw new TransportError("WebSocket protocols must be an array of strings");
    }
    const live = [...this.transports.values()].filter((record) => !record.terminal || record.inbound.length > 0);
    if (live.length + this.opening >= MAX_LIVE_TRANSPORTS) {
      throw new TransportError("Too many open transports for this plugin", "transport_resource_limit");
    }

    // Only the URL and subprotocols: Decaid cannot send custom headers.
    const socket = new WebSocket(url, protocols as string[] | undefined);
    this.opening++;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", (error) => reject(new TransportError(`WebSocket connect failed: ${error.message}`)));
      });
    } finally {
      this.opening--;
    }
    socket.removeAllListeners("error");
    if (this.unloaded) {
      socket.terminate();
      throw new TransportError("Plugin unloaded during connect");
    }

    const record: TransportRecord = {
      handle: `simulated-${++this.nextHandle}`,
      socket,
      inbound: [],
      inboundBytes: 0,
      pendingOutboundBytes: 0,
      terminal: false,
      closing: false,
      draining: false,
    };
    this.transports.set(record.handle, record);
    let failure: string | undefined;
    socket.on("message", (data, isBinary) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      const event = isBinary
        ? { type: "data", dataType: "binary", data: buffer.toString("base64") }
        : { type: "data", dataType: "text", data: buffer.toString("utf8") };
      this.enqueue(record, event, buffer.length);
    });
    socket.on("error", (error) => {
      failure = `WebSocket error: ${error.message}`;
    });
    socket.on("close", (code, reason) => this.terminate(record, failure, "transport_error", code, reason.toString()));
    return { handle: record.handle, ...(socket.protocol ? { protocol: socket.protocol } : {}) };
  }

  private onEvent(handle: string, listener: (event: TransportEvent) => void): void {
    const record = this.record(handle);
    record.listener = listener;
    this.drain(record);
  }

  private async send(handle: string, payload: unknown): Promise<void> {
    const record = this.record(handle);
    if (record.terminal || record.closing) throw new TransportError("Transport already closed");
    const { type, data } = (payload ?? {}) as { type?: unknown; data?: unknown };
    if (type !== "text" || typeof data !== "string") {
      throw new TransportError('The simulated tablet supports only { type: "text", data: string } sends');
    }
    const size = Buffer.byteLength(data);
    if (size > MAX_PENDING_OUTBOUND_BYTES || record.pendingOutboundBytes + size > MAX_PENDING_OUTBOUND_BYTES) {
      throw new TransportError("Outbound data limit exceeded; send rejected", "transport_resource_limit");
    }
    record.pendingOutboundBytes += size;
    record.socket.send(data, () => {
      record.pendingOutboundBytes -= size;
    });
  }

  private async close(handle: string): Promise<void> {
    const record = this.record(handle);
    if (record.terminal || record.closing) throw new TransportError("Transport already closed");
    await this.closeNative(record);
    this.transports.delete(handle);
  }

  private closeNative(record: TransportRecord): Promise<void> {
    record.closing = true;
    if (record.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    const closed = new Promise<void>((resolve) => record.socket.once("close", () => resolve()));
    record.socket.close(1000);
    const forced = setTimeout(() => record.socket.terminate(), 5_000);
    return closed.finally(() => clearTimeout(forced));
  }

  private record(handle: string): TransportRecord {
    const record = this.transports.get(handle);
    if (!record) throw new TransportError("Unknown transport handle");
    return record;
  }

  private enqueue(record: TransportRecord, event: TransportEvent, size: number): void {
    if (record.terminal) return;
    if (record.inboundBytes + size > MAX_QUEUED_INBOUND_BYTES) {
      this.terminate(record, "Inbound data limit exceeded; transport closed", "transport_resource_limit");
      record.socket.terminate();
      return;
    }
    record.inbound.push({ event, size });
    record.inboundBytes += size;
    this.drain(record);
  }

  private terminate(record: TransportRecord, error: string | undefined, code: string, closeCode?: number, reason?: string): void {
    if (record.terminal) return;
    record.terminal = true;
    if (error !== undefined) record.inbound.push({ event: { type: "error", code, message: error }, size: 0 });
    // Decaid omits the code when the connection ended without a close frame.
    const close: TransportEvent = { type: "close" };
    if (closeCode !== undefined && closeCode !== 1006) close.code = closeCode;
    if (reason) close.reason = reason;
    record.inbound.push({ event: close, size: 0 });
    this.drain(record);
  }

  /** Delivers queued events in order, each in its own turn of the event loop, as Decaid's bridge does. */
  private drain(record: TransportRecord): void {
    if (!record.listener || record.draining) return;
    record.draining = true;
    setImmediate(() => {
      record.draining = false;
      const next = record.inbound.shift();
      // A closed transport stops counting against the limit once its events are delivered.
      if (record.terminal && record.inbound.length === 0) this.transports.delete(record.handle);
      if (!next) return;
      record.inboundBytes -= next.size;
      if (this.unloaded) return;
      try {
        record.listener?.(next.event);
      } catch (error) {
        this.logs.push(`Transport listener error: ${String(error)}`);
      }
      this.drain(record);
    });
  }
}

interface PluginScope {
  host: Record<string, unknown>;
  fetch: (input: unknown) => Promise<unknown>;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
}

/** Evaluates plugin.js the way Decaid's plugin manager does. */
export function loadPlugin(source: string, manifestId: string, scope: PluginScope): BuiltPlugin {
  const factory = new Function(
    "host",
    "fetch",
    "setTimeout",
    "clearTimeout",
    `${source}
    if (typeof createPlugin !== "function") {
      throw new Error("Plugin must export a 'createPlugin' function. Got: " + typeof createPlugin);
    }
    return createPlugin(host);`,
  ) as (...args: unknown[]) => BuiltPlugin;
  const plugin = factory(scope.host, scope.fetch, scope.setTimeout, scope.clearTimeout);
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`createPlugin did not return an object, got: ${typeof plugin}`);
  }
  if (plugin.id !== manifestId) {
    throw new Error(`Plugin ID mismatch. Expected: ${manifestId}, Got: ${plugin.id}`);
  }
  return plugin;
}

/**
 * Raw-frame mode: a WebSocket to a server's sync endpoint that sends whatever
 * a test gives it, with no headers, as Decaid would.
 */
export class RawConnection {
  /** Every message received, parsed as JSON where possible. */
  readonly messages: unknown[] = [];
  /** Resolves when the connection ends, with the close code the server sent. */
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: (() => void)[] = [];

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.on("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.wake();
      });
    });
    socket.on("message", (data) => {
      const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString("utf8");
      try {
        this.messages.push(JSON.parse(text));
      } catch {
        this.messages.push(text);
      }
      this.wake();
    });
  }

  /** Connects to the sync endpoint of a server's public http(s):// URL. */
  static async open(serverUrl: string): Promise<RawConnection> {
    const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}${SYNC_PATH}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new RawConnection(socket);
  }

  /** Sends a string as is, or anything else as JSON, in a text frame. */
  send(frame: unknown): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes, { binary: true });
  }

  /** Resolves with the message at `index` once it has arrived. */
  async message(index: number, timeoutMs = 10_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length <= index) {
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`The connection closed after ${this.messages.length} messages`);
      if (Date.now() > deadline) throw new Error(`No message ${index} within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.messages[index];
  }

  close(): Promise<{ code: number; reason: string }> {
    this.socket.close(1000);
    return this.closed;
  }

  /** Ends the connection without a close frame, as a lost network does. */
  terminate(): Promise<{ code: number; reason: string }> {
    this.socket.terminate();
    return this.closed;
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

function response(status: number, body: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => body,
    json: async () => JSON.parse(body || "null"),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
