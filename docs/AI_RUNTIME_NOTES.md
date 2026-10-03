# AI Runtime Notes

Read before implementing the plugin or its simulated host. This note keeps the host constraints needed by milestone 1 in this repo; the archived plugin is prior art, not a required documentation dependency.

References use the checkout convention in `AGENTS.md`. Audited against local Decaid commit `a45961b3` on 2026-10-03; the `fetch` discrepancy below was also checked at v0.8.6. Check the oldest supported release and the version under investigation before relying on additional host behavior.

## Loading and settings

Milestone 1 targets Decaid v0.8.6 or newer and declares `log`, `api`, `events.machine`, `events.shots`, `events.workflow` and `network.websocket`, as specified in issue #1. Unknown permissions can prevent loading; check `decaid:lib/src/plugins/plugin_manifest.dart` before adding one.

Decaid calls the global `createPlugin(host)` entry point and calls `plugin.onLoad(settings)` synchronously without awaiting a returned promise (`decaid:lib/src/plugins/plugin_manager.dart`). Keep `onLoad` short and schedule connection work through a timer. The loader has a load watchdog; inspect `decaid:lib/src/plugins/plugin_loader_service.dart` when changing startup behavior.

The target build is one ES2020 `plugin.js` with no module syntax. Use the host APIs and timer callbacks; do not assume a browser or Node environment. Run the built file in the simulated host, not just the TypeScript source.

Secure settings are supplied to the loaded plugin, while the settings REST response reports whether they are set rather than exposing their values (`PluginLoaderService.pluginSettings`). The token must be declared secure. Settings changes can reload the plugin, so startup and unload must tolerate a new runtime generation.

## Server transport

Inspect `decaid:lib/src/plugins/plugin_transport_service.dart`, especially `_openWebSocket`, `send` and `_reserveOutbound`:

- `host.transport` opens `ws://` or `wss://` connections with `network.websocket`. The WebSocket open options support URL and subprotocols, not custom headers. Authenticate in the protocol handshake.
- `send` acceptance is not a server acknowledgment. Keep delivery state until the server acknowledges the stored logical message.
- Default pending outbound and queued inbound limits are each 1 MiB per transport. The outbound check covers both a single payload and the sum already pending; sends exceeding it fail with `transport_resource_limit`.
- Chunking must leave room for the encoded envelope and regulate pending sends. Splitting into frames just below 1 MiB is insufficient if several are pending. The simulated host must enforce the pending-byte limit, not just maximum frame size.
- Unloading retires the plugin's transports. Milestone 1's in-memory outbox cannot preserve every transient event across an unload; record history is recovered by backfill. A durable outbox belongs to milestone 2.

## Local API and events

Use plugin-scoped `fetch` for Decaid's local API. `PluginManager._performFetch` has response-size and timeout constraints; it does not provide a streaming response to JavaScript.

ADR-0009's original rationale and the original Further Notes in issue #1 stated that private-IP fetch is blocked; both have been clarified. **Source discrepancy:** `_performFetch` at v0.8.6 and `a45961b3` passes the URL to `HttpClient.openUrl` without a private-address check. Treat documented restrictions as host policy, not proof of enforcement. The agreed architecture still uses WebSocket for all server traffic.

| Data | Host source to inspect | Milestone 1 approach |
|---|---|---|
| Workflow and machine state | `decaid:lib/src/plugins/plugin_manager.dart` (`dispatchEvent`, workflow subscription) | `workflowUpdated`; `stateUpdate` transitions only |
| New and edited Shots | `decaid:lib/main.dart`, `decaid:lib/src/services/webserver/shots_handler.dart` | `shotStored` triggers a full fetch; `shotUpdated` carries an edit without measurements |
| Steam Records | `decaid:lib/src/services/webserver/steams_handler.dart`, `decaid:lib/src/models/data/steam_record.dart` | Poll ids and detect edits; no corresponding plugin event in the inspected source |
| Library, settings and device information | `decaid:assets/api/rest_v1.yml` and corresponding handlers | Poll; use ETags where supported, otherwise content comparison |
| DYE2 recipes, equipment and baskets | `dye2:docs/KV_CONTRACT.md` and the code that reads/writes each key | Read only in milestone 1; ADR-0005's writes are later work |

An unchanged id list cannot reveal edits to an existing Steam Record. Test edit detection as well as discovery and backfill. Check optional fields in real records from supported versions; absence of an endpoint means unavailable data, not an empty collection.

## Identity and attribution

`preferredMachineId` is a connection identifier, not the hardware identity. Inspect `decaid:lib/src/services/webserver/settings_handler.dart` and the relevant machine implementation for Bluetooth/USB behavior. Use model and serial per ADR-0004; serial `"0"` is not a real identity.

Shots and Steam Records include a Workflow; inspect `decaid:lib/src/models/data/shot_record.dart`, `steam_record.dart` and `workflow.dart` for capture-time identity. Legacy imports can lack that identity. Keep the spec's explicit inferred fallback instead of attributing every record to whichever tablet sent it.
