// The parts of Decaid's plugin host this plugin uses. Decaid builds the host
// in lib/src/plugins/plugin_manager.dart; each member exists only when the
// manifest declares its permission. `fetch`, `setTimeout` and `clearTimeout`
// are not on the host but in scope of the plugin's code (see globals.d.ts).

export interface PluginHost {
  log(message: string): void;
  /** Outbound connections, with `network.websocket` (plugin_transport_service.dart). */
  transport: Transport;
  /**
   * Decaid's storage for this plugin, with `pluginStorage`, kept across loads
   * and updates of the plugin. Sends the command and returns nothing: Decaid
   * answers a read with a `storageRead` event carrying `{ key, value }`,
   * `value` null for a key never written, and a write with a `storageWrite`
   * event carrying the data written. A command that fails is never answered
   * (`_handlePluginStorage` in plugin_manager.dart).
   */
  storage(command: StorageCommand): void;
}

export type StorageCommand = { type: "read"; key: string } | { type: "write"; key: string; data: unknown };

export interface Transport {
  /** Resolves once connected. WebSocket options are the URL and subprotocols only: no headers. */
  open(options: { kind: "websocket"; url: string; protocols?: string[] }): Promise<{ handle: string; protocol?: string }>;
  /** Registers the handle's one listener; events that arrived before it are delivered in order. */
  onEvent(handle: string, listener: (event: TransportEvent) => void): void;
  /**
   * Resolves once the frame is accepted for sending, not delivered. Rejects
   * with code `transport_resource_limit` if the handle's pending outbound
   * bytes would exceed 1 MiB.
   */
  send(handle: string, payload: { type: "text"; data: string }): Promise<void>;
  close(handle: string): Promise<void>;
}

export type TransportEvent =
  | { type: "data"; dataType: "text" | "binary"; data: string }
  | { type: "error"; code: string; message: string }
  /** `code` and `reason` are omitted when the connection ended without them. */
  | { type: "close"; code?: number; reason?: string };

/** Plugin settings as Decaid passes them to onLoad: only the ones that were set, keyed by manifest setting name. */
export type PluginSettings = Record<string, unknown>;

export interface PluginEvent {
  name: string;
  payload?: unknown;
}

export interface Plugin {
  id: string;
  version: string;
  onLoad(settings: PluginSettings): void;
  onUnload(): void;
  onEvent(event: PluginEvent): void;
}
