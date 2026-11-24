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
  /**
   * With `emit`, sends the payload, as JSON, to every WebSocket open on the
   * plugin's endpoint of that name (`/ws/v1/plugins/{id}/{event}`), which the
   * manifest declares. Returns nothing, and keeps nothing for a socket opened
   * later. Without the permission it throws (`requirePermission` in
   * plugin_manager.dart, `_handlePluginSocketEndpoint` in plugins_handler.dart).
   */
  emit(event: string, payload: unknown): void;
  /**
   * With `manage.extensions`, calls one of Decaid's plugin and Skin
   * management routes in process, with the authority to manage them
   * (`PluginLocalApiBridge` in plugin_local_api_bridge.dart, from Decaid
   * v0.9.2): whatever the Tablet's "Require authorization for extension
   * management" setting asks of a plain request, which `fetch` is. `path`
   * is the whole path, from `/api/v1/`. It reaches those routes, the reads
   * of the plugin list, a plugin's settings and the Skins, and a `POST
   * /api/v1/settings` of `defaultSkinId` or `automaticUpdateCheck` alone,
   * and rejects for any other. Resolves with Decaid's answer whatever its
   * status, its body as text; rejects where Decaid sends none within 60 s,
   * or once the plugin is unloaded, as Decaid unloads it to install its
   * update or save its settings (`localApiTimeout` in plugin_manager.dart).
   */
  localApi(path: string, options?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; contentType?: string }): Promise<LocalApiAnswer>;
  /**
   * With `notifications`, puts up a notice in Decaid's notification center,
   * which Decaid shows as a bell over any Skin, or replaces the plugin's
   * notice with that id. Returns a request id at once; Decaid answers with a
   * `notificationResult` event carrying `{ requestId, id?, status, reason? }`,
   * `status` `accepted` or `rejected` with a `reason` of `validation`,
   * `capacity` or `storage`. An id is at most 128 characters and a message
   * at most 600, without control characters but tab and line feed; a plugin
   * holds at most five notices. Without the permission it throws
   * (`notify` in plugin_manager.dart, `parsePluginNotification` in
   * plugin_notifications.dart, decaid:doc/Plugins.md).
   */
  notify(notice: { id: string; message: string }): string;
  /** With `notifications`, withdraws the plugin's notice with that id, or all of its notices for none. Returns nothing. */
  dismissNotification(id?: string): void;
}

/** What `host.localApi` resolves with. */
export interface LocalApiAnswer {
  status: number;
  headers: Record<string, string>;
  /** The response's body, as text. */
  body: string;
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

/**
 * The sockets the plugin opens on Decaid itself, DYE2's and the Live View's,
 * counted against Decaid's limit per plugin generation with its connections
 * to the server, always leaving one transport free for those
 * (`plugin/src/connection.ts`).
 */
export interface Transports {
  /** Opens one, or rejects where that would leave no transport free for a connection to the server, or the open fails. */
  open(url: string): Promise<string>;
  onEvent(handle: string, listener: (event: TransportEvent) => void): void;
  /** Closes one, which counts against the limit until Decaid has closed it. */
  close(handle: string): void;
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

/**
 * A request to one of the plugin's HTTP endpoints, `/api/v1/plugins/{id}/{endpoint}`,
 * which Decaid dispatches only for an endpoint the manifest declares, with `api`
 * (`_handlePluginApiEndpoint` in plugins_handler.dart).
 */
export interface HttpRequest {
  requestId: string;
  /** The endpoint's id in the manifest. */
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  /** The body read as JSON, null when empty. */
  body: unknown;
  query: Record<string, string>;
}

/** What Decaid answers an HTTP request with; status 200 if none. */
export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Plugin {
  id: string;
  version: string;
  onLoad(settings: PluginSettings): void;
  onUnload(): void;
  onEvent(event: PluginEvent): void;
  /**
   * Answers the requests to the plugin's HTTP endpoints, as Decaid's loader
   * finds it on the plugin. Decaid awaits a promise, for up to 30 s
   * (`__dispatchPluginHttp` and `registerPendingHttp` in plugin_manager.dart).
   */
  __httpRequestHandler(request: HttpRequest): HttpAnswer | Promise<HttpAnswer>;
}
