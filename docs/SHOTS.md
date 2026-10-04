# Shot capture

Ticket [#9](https://github.com/loganfuller/decent-sync/issues/9) extends protocol
version 1 with these messages, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `shot` | `id` (delivery id), `shotId` (Decaid id), `shot` (opaque record) |
| Plugin to server | `shotUpdated` | The same fields, and optional `snapshot` |
| Plugin to server | `shotIndex` | `id`, `shots: [{ id, updatedAt? }]`, at most 100 entries |
| Server to plugin | `requestShots` | `shotIds`, at most 100 ids |
| Server to plugin | `ack` | `id` (the logical delivery id) |

The plugin uses the complete metadata snapshot from Decaid's `shotUpdated`
event (`ShotsHandler._updateShot` in Decaid v0.8.7), marking it `snapshot: true`.
That preserves cleared fields, which Decaid omits from its serialization.
A delivery without that marker merges a partial edit recursively, including
explicit nulls. Both paths preserve stored measurements. A full `shot` is a
complete record; unknown and missing inner fields are accepted and retained.

On load, the plugin pages `GET /shots?limit=100&offset=...&order=desc` once,
sending each page's ids and edit times. Older records use `createdAt`, then
`timestamp`, when `updatedAt` is absent. A reconnect in that runtime sends
cached ids only and resends unacknowledged deliveries. Backfill fetches one
Shot at a time. Only one logical delivery awaits acknowledgment at a time,
and the scan waits while its outbox has four deliveries. Transient individual
Shot fetch failures retry; a 404 means the tablet deleted the record. Deletion
never removes a server record. The outbox is in memory; reload reconciliation
recovers lost Shots and edits. Oversized logical messages are ticket #10.

`ShotsService` serializes a Shot's deliveries with a PostgreSQL advisory lock,
then compares `updatedAt ?? createdAt ?? timestamp` in PostgreSQL. Edit-time
precision is six fractional digits, matching Decaid, rather than JavaScript's
milliseconds. A tie keeps the stored metadata. An early edit is stored as an
incomplete Shot and acknowledged only after commit. Its full record is still
requested and fills measurements without rolling back the edit. Incomplete
Shots are hidden from REST reads and Machine status.

First full records resolve credit from their own hardware (ADR-0015), or the
session's reporting identity when inferred. A mismatched session's inferred
records use its reported hardware, held by a Pending Machine until adopted.
Hardware is locked before Machine rows and the Pending Machine upsert,
matching identity resolution. The Shot advisory lock holds no Shot row while
waiting for that hardware lock; adoption never takes the Shot advisory lock.
Every path that binds or adopts Pending hardware transfers Shot credit before
removing the Pending Machine. Dismissal hides its Shots without deleting them.

The metadata and analytics live in `shots`; curves live in
`shot_measurements.data`, a separate jsonb column with lz4 compression. List
and status queries never read the measurements table. `extractShot` is a pure,
optional-field projection tested against scrubbed real tablet records and
labelled older-layout derivations. See the fixtures' README for provenance.

## REST API

All endpoints require the existing account session. Staff Location scoping
and Location history are later tickets (#15 and #11).

- `GET /api/shots?limit=20&offset=0&machineId=<uuid>` returns
  `{ shots, total, limit, offset }`. Limit is 1–100; offset is nonnegative.
  Results are newest pulled-at first, with id as the deterministic tie-breaker
  and undated records last. Rows include analytics and Machine or Pending
  Machine credit, plus `machineInferred`, without metadata or measurements.
- `GET /api/shots/:id` returns `{ shot }`, including the stored Decaid metadata
  in `shot.record`, without measurements.
- `GET /api/shots/:id/measurements` returns `{ measurements }`, as sent by
  Decaid (null when none were sent).
- Machine list and detail responses include
  `lastShot: { id, pulledAt } | null`, by credited hardware rather than the
  tablet that delivered it.

Dismissed Pending Shots are hidden from all three reads; adoption restores
access. No capture endpoint writes to the tablet.

`server/test/shots.test.ts` verifies the built plugin through Seam 1, REST
reads, and two server instances sharing PostgreSQL. It includes 205-record
history paging, mid-backfill reconnect, live capture and edits, reload recovery,
unacknowledged edits, deletion, late full records, complete and partial edits,
replays, precise version ordering, restart, hardware attribution, dismissal
and adoption, identity mismatch, transient API failures, and lists while the
measurements table is locked.
