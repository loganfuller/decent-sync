# AI Protocol Notes

Read this when changing message handling, acks, de-duplication, sessions, auth, or backfill. `docs/PROTOCOL.md` is the contract; this note is the reasoning behind it and the traps around it.

## Why WebSocket

Decaid plugins cannot open arbitrary sockets. The only outbound channel that reaches a LAN or internet host is `host.transport` with the `network.websocket` permission, which supports `ws://` and `wss://` with platform certificate validation. Plain HTTP `fetch` from a plugin is meant for Decaid's own API. A persistent socket also gives the server a push channel for future server-to-machine sync. See `decent-sync-plugin:docs/AI_RUNTIME_NOTES.md`.

## Delivery Semantics

- At-least-once. The plugin keeps each data message in its outbox until it receives `ack`. On reconnect it resends every unacked message, including ones the server already processed but whose ack was lost.
- The server de-duplicates by envelope `id` (`<bootId>:<seq>`) in a per-session window of `DEDUPE_WINDOW` ids. A replacing session inherits the old session's window (`hello`, 4409 path).
- The window is in memory. After a server restart a resent message is processed again, so handlers must be idempotent anyway: shots are keyed by shot id, collections and workflow overwrite a single file. `events.jsonl` can contain the same `id` twice after a restart; consumers of the log must de-duplicate by `id`.
- `hello` and `heartbeat` have no ack and are never resent.
- Ack after persisting. Acking first would let a crash lose a message the plugin has already discarded.

## Sessions and Identity

- The first frame must be `hello` within `HELLO_TIMEOUT_MS`, or the socket is closed.
- `machineId` comes from the accepted `hello` and is used for the storage directory. Envelope `machineId` is informational only; it can be `null` for events queued before the plugin resolved its identity.
- The plugin derives `machineId` from the preferred machine's BLE MAC (`de1-<hex>`), falling back to the serial, then a per-boot id. The MAC is used first because Decaid persists it, so it is known even before the DE1 connects. A per-boot fallback id creates a new directory each boot; if you see `install-*` directories, the tablet had no preferred machine.
- A second connection with the same `machineId` replaces the first (close code 4409).

## Auth

- `SYNC_TOKEN` unset means no auth. Set, the `hello.token` must match or the server closes with 4401.
- The token travels in `hello` because Decaid's WebSocket transport cannot send custom headers. Over the internet use `wss://` only, or the token is sent in clear.
- The prototype's token is shared. The target design issues one token per machine, bound to the machine's model and serial (ADR-0004).

## Backfill

1. After `welcome`, the plugin sends a full snapshot and then `shotIndex` with every shot id on the machine.
2. `on_shotIndex` compares against `shots/*.json` and replies `requestShots` with the missing ids.
3. The plugin fetches and sends them one at a time, only while its outbox holds fewer than `BACKFILL_LOW_WATER` messages, so a large history never sits in tablet memory.

A shot stored live during a backfill can be requested too; the plugin's `sentShots` set suppresses the duplicate fetch.

## Collections

- Sent in full on every `welcome`, then only when the plugin's poll detects a change (ETag from Decaid where available, otherwise a content hash).
- Arrays over 256 KB arrive in `parts`. Parts of one collection arrive in order on one connection; a reconnect restarts at part 1, and `part === 1` resets the accumulator.
- `appSettings` arrives without Decaid's `chargingState`, which carries live battery level and would otherwise trigger a resend on every poll.

## Mixed Versions

Every machine runs its own Decaid release and its own plugin release, and they update independently. `hello` reports both (`decaidVersion`, `pluginVersion`), and `machine.json` keeps the latest.

- Decaid payloads (shots, workflow, collections) are opaque to the protocol. Store them as sent; their fields come and go between Decaid versions. Anything that interprets them, like terminal summaries today or a future cross-machine merge, must tolerate missing and unknown fields.
- A collection may be absent entirely if a machine's Decaid lacks the endpoint. Treat "never received" as "unknown", not "empty".
- Compare data across machines by meaning, not by Decaid version. When behavior must depend on a version, branch on the reported `decaidVersion` for that machine, never on a global assumption.

## Evolving the Protocol

- Bump `v` and `protocol` only for incompatible changes. Additive fields and new message types do not need a bump: the plugin ignores unknown server messages and the server logs unknown plugin messages without failing.
- A new server-to-plugin message needs a plugin release before it does anything. Machines update plugins on their own schedule, so expect mixed plugin versions; `hello.pluginVersion` tells you which.
- Close codes in the 4xxx range are application codes; keep them listed in `docs/PROTOCOL.md`.
