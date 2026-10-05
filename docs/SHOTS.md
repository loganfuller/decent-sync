# Shot capture

Ticket [#9](https://github.com/loganfuller/decent-sync/issues/9) extends protocol
version 1 with these messages, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `shot` | `id` (delivery id), `shotId` (Decaid id), `shot` (opaque record) |
| Plugin to server | `shotUpdated` | The same fields, with the Shot's metadata only |
| Plugin to server | `shotIndex` | `id`, `shots: [{ id, updatedAt? }]`, at most 100 entries |
| Server to plugin | `requestShots` | `shotIds`, at most 100 ids |
| Server to plugin | `ack` | `id` (the logical delivery id) |

Decent Sync supports Decaid v0.8.7 and later. A `shotUpdated` carries the
complete metadata from Decaid's `shotUpdated` event (`ShotsHandler._updateShot`),
which has no measurements, so a newer edit replaces the stored metadata whole,
cleared fields included, and preserves stored measurements. A full `shot` is
a complete record; unknown inner fields are accepted and retained. A record
without a UTC `updatedAt` ending in `Z`, or a full record without a measurements array, is
not one those Decaid versions send: the server acknowledges and ignores it.

On load, the plugin pages `GET /shots?limit=100&offset=...&order=desc` once,
sending each page's ids and edit times. A reconnect in that runtime sends
cached ids only and resends unacknowledged deliveries. Backfill fetches one
Shot at a time. Only one logical delivery awaits acknowledgment at a time,
and the scan waits while its outbox has four deliveries. A Shot whose fetch
fails is retried after the other requested Shots; a 404 means the tablet
deleted the record. Shots Decaid imported from the legacy de1app (`de1app-*`
ids) are never indexed or sent (ADR-0004). Deletion
never removes a server record. The outbox is in memory, and Steam Records share
it (`STEAM_RECORDS.md`); reload reconciliation recovers lost Shots and edits.
A delivery too large for one frame, such as a long filter or tea shot, is sent
in chunks and acknowledged once (`AI_PROTOCOL_NOTES.md`).

`ShotsService` serializes a Shot's deliveries with a PostgreSQL advisory lock,
then compares `updatedAt` in PostgreSQL. Edit-time
precision is six fractional digits, matching Decaid, rather than JavaScript's
milliseconds. A tie keeps the stored metadata. An early edit is stored as an
incomplete Shot and acknowledged only after commit. Its full record is still
requested and adds its measurements without rolling back the edit. Incomplete
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
and status queries never read the measurements table. `extractShot` and
`extractCurves` are pure, optional-field projections tested against a scrubbed
real tablet record. See the fixtures' README for provenance.

Decaid writes a Shot's `timestamp` and sample times in the tablet's local time
without an offset, and `createdAt` in UTC as it saves the Shot, just after the
last sample. `extractCurves` takes the tablet's offset from that gap, rounded
to a quarter hour, so the pulled-at time needs the curves and is set by the
first full record, which also credits the Shot. Later records and edits change
neither, so a Shot's credit and the time its Location is credited by are
written once, with its Machine's row locked. Duration adds up the gaps between
consecutive samples, leaving out the whole quarter hours a daylight-saving
change adds or takes away; a gap where the tablet's clock was otherwise
corrected counts for nothing (`elapsedSeconds`).

## REST API

All endpoints require the existing account session. Staff Location scoping
is ticket #15.

- `GET /api/shots?limit=20&offset=0&machineId=<uuid>` returns
  `{ shots, total, limit, offset }`. Limit is 1–100; offset is nonnegative.
  Results are newest pulled-at first, with id as the deterministic tie-breaker
  and undated records last. Rows include analytics and Machine or Pending
  Machine credit, plus `machineInferred`, without metadata or measurements.
  They also carry the Location the Machine was at when the Shot was pulled
  (`locationId`, and `location: { id, name, timeZone }`, null when unknown),
  and `locationInferred`, true when that Location came through an inferred
  Machine. Correcting the Machine's Location History changes these, never
  the stored record.
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
unacknowledged edits, deletion, late full records, edits that clear fields,
replays, precise version ordering, restart, hardware attribution, dismissal
and adoption, identity mismatch, transient and persistent API failures, ignored
legacy imports and incompatible records, and lists while the measurements
table is locked.
