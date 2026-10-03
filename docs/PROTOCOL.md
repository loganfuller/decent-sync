# Prototype wire format (unreleased)

Historical reference for `server.mjs` and the archived `decent-sync-plugin` only.
The prototype is not the milestone 1 contract. The replacement also starts at
version 1, without prototype compatibility, and defines messages and validators
once in the new `protocol/` package. See [milestone 1](https://github.com/loganfuller/decent-sync/issues/1)
and `AI_PROTOCOL_NOTES.md`. Ticket #19 removes this reference with the prototype.

## Transport

The plugin opens one WebSocket to `ws(s)://<server>/sync`. Every frame is a
JSON text frame.

## Envelope (plugin → server)

```json
{ "v": 1, "id": "<bootId>:<seq>", "seq": 12, "type": "shot",
  "machineId": "de1-f7d47524f55c", "sentAt": "2026-10-01T20:09:40Z", "data": { } }
```

`id` is unique per message. `bootId` changes every time the plugin loads.

## Delivery

- Data messages stay in the plugin's outbox until the server replies
  `{"type":"ack","id":"<id>"}`.
- After a reconnect, the plugin resends every message that wasn't acknowledged.
- The server de-duplicates by `id`. Shots are stored by shot id. Together this
  suppresses ordinary duplicate deliveries. The event log can still repeat ids
  after restart; multipart collections are acknowledged per part, with only
  in-memory reassembly. These are prototype limitations, not target guarantees.
- `hello` and `heartbeat` are control frames. They are not acknowledged and
  never resent.

## Plugin → server

| `type` | `data` | When |
|---|---|---|
| `hello` | `protocol, pluginVersion, bootId, token, machineId, name, model, serialNumber, firmware, decaidVersion, localIp` | first frame on every connection |
| `collection` | `collection, part, parts, value` | full set after `welcome`, then whenever a poll sees a change. Collections are `beans`, `beanBatches`, `grinders`, `profiles`, `appSettings`, `machineSettings` and `machineAdvancedSettings`. Arrays larger than 256 KB are split into `parts` |
| `workflow` | Decaid workflow JSON | Decaid's `workflowUpdated` event fires, and the latest one again after each `welcome` |
| `machineState` | `from, to, state, substate, at, groupTemperature, steamTemperature` | a state or substate transition |
| `shot` | `reason` (`stored` or `backfill`), `shot` (full record with measurements) | a new shot, or one the server requested |
| `shotUpdated` | `id, shot, patch` | a shot is edited |
| `shotIndex` | `ids` | after `welcome` |
| `heartbeat` | `outbox, backfill` | every 30 s |

## Server → plugin

| `type` | Fields | Meaning |
|---|---|---|
| `welcome` | `serverTime` | hello accepted. The plugin starts sending |
| `ack` | `id` | message stored |
| `requestShots` | `ids` | send these shots (a reply to `shotIndex`) |
| `error` | `message` | sent by `reject()` before close code 4400 (protocol) or 4401 (bad token). Replacement uses 4409 directly, without an `error` message |
