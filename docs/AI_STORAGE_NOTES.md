# AI Storage Notes

Read this when changing where or how the server stores data, or when reading stored data. The current store is plain JSON files, a deliberate prototype choice; a database is on the roadmap.

## Layout

```
$DATA_DIR/machines/<machineId>/
  machine.json         latest accepted hello minus token, plus lastSeen and remote
  events.jsonl         every non-heartbeat message, append-only, with receivedAt
  state/<name>.json    latest value of each collection, plus workflow.json
  shots/<shotId>.json  full Decaid shot record, with measurements
```

`DATA_DIR` defaults to `./data`, which is git-ignored and holds the user's real history. Use a scratch `DATA_DIR` for experiments.

`machineId` is sanitized to `[a-zA-Z0-9._-]` for the directory name. Shot ids are Decaid UUIDs or legacy `de1app-<epoch>` ids imported from the old Tcl app; both are filename-safe.

## Rules

- Write through `writeJson()` (temp file, then rename) so readers never see a partial file.
- Handlers must be idempotent; see `AI_PROTOCOL_NOTES.md`. Overwrite by key; never append to state files.
- `events.jsonl` is the audit log. It may contain duplicate `id`s after a server restart. Its records are the raw envelope, so collection snapshots and shots make it large; do not read it whole.
- `shotUpdated` merges `shot` into the stored record but keeps the stored `measurements`, because Decaid's `shotUpdated` event carries the shot without measurements.
- Backfill decides what is missing by listing `shots/`. Renaming or moving shot files triggers a re-request of every shot on the next connect.

## Collection Diffing

`on_collection` compares the incoming value with the previous `state/<name>.json` before overwriting it:

- Arrays are diffed by `id` into added, changed, and removed. This is display-only today, but it is the starting point for server-to-machine sync.
- Objects (settings) are diffed by top-level key.
- The first sync of a collection prints everything; profiles are truncated to 12 lines because there are typically 70 or more.

## Payload Sizes

Observed on one DE1Pro running Decaid 0.8.6. Other machines, profiles, and Decaid versions differ; use these as orders of magnitude.

| Item | Size |
|------|------|
| `profiles` collection, 74 profiles | about 180 KB on the wire |
| One espresso shot, about 140 samples | about 70 KB |
| One filter shot, 1325 samples over 276 s | about 650 KB |
| beans, batches, grinders, settings | under 4 KB each |

Sizes are compact JSON as sent; files on disk are pretty-printed and about 50 percent larger. Shots cost about 490 bytes per sample at about 4.8 samples per second.

The server's `maxPayload` is 16 MiB. The binding limit is Decaid's 1 MiB per-transport outbound queue on the plugin side: a single `shot` frame over 1 MiB is rejected with `transport_resource_limit` and can never be sent. That is about 2100 samples, a shot of roughly 7 minutes. Long filter or tea shots will cross it. Shot chunking is on the roadmap in both repos.
