# Decent Sync protocol (v1)

This is the wire contract between `decent-sync` and `decent-sync-plugin`.
This file is the authoritative copy. If you change it, update both repos.

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
  makes delivery at-least-once and idempotent.
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
| `error` | `message` | sent before the server closes with 4400 (protocol), 4401 (bad token) or 4409 (replaced by a newer connection from the same machine) |
