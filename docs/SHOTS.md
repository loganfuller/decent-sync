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
It does the same with a Shot whose id it cannot store (`isRecordId`: more than
`MAX_RECORD_ID_LENGTH`, 128, code units, or a NUL); Decaid's are UUIDs. A
delivery whose storage fails in a way that would repeat, such as one with a
NUL in a string, is set aside as received and acknowledged as stored, and the
Shot counts as known to that Machine's indexes from then on
(`AI_PROTOCOL_NOTES.md`, Deliveries set aside).

Decaid's `shotStored` event names a new Shot. The plugin requests it from its
outbox by id, ahead of backfill, and fetches it with `GET /shots/{id}` only
when the outbox is about to send it, as it fetches backfill. With its
measurements a Shot is tens of KB, so while the server is unreachable the
plugin holds only the ids of the Shots stored meanwhile, and sends them once
a connection is welcomed. A Shot deleted before it is read is skipped. A
`shotUpdated` is queued as Decaid reports it, so
an edit can reach the server before its Shot's full record; the server stores
it as an early edit (below).

On load, the plugin pages `GET /shots?limit=100&offset=...&order=desc` once,
sending each page's ids and edit times. Offsets shift when Shots are deleted
or added during the scan, so each page after the first repeats the previous
page's last 10 positions and resumes after the last Shot already read whose
edit time is unchanged, so Shots that exist for the whole scan are all
indexed. An edit to a Shot's time can move it from the part not yet read into
the part already read: Decaid's edit API reports that Shot in `shotUpdated`,
but an import that overwrites it reports nothing, so a scan that reaches the
end checks it has read or been told of as many Shots as `total` says the
tablet holds. (A Shot deleted while another moved that way goes unnoticed.)
If that count falls short, no Shot already read reappears (more than the
overlap were deleted between two pages), or the list grows past what the
first page's `total` allows, the scan starts again. After
three passes it logs and leaves the rest to the next load. The index is sent
once per load, replacing milestone 1's "on every `welcome`", as the Steam
Record index is (`STEAM_RECORDS.md`). A reconnect sends no index, only the
deliveries still unacknowledged, and a scan that a disconnect interrupted
carries on where it was, so no page acknowledged before the disconnect is
sent again. A server whose database was wiped or restored therefore learns
which Shots it lacks only when the plugin is reloaded. The server's
`requestShots` lists the Shots it lacks in the order the index offered them,
each once, so backfill goes newest first. The outbox
fetches requested Shots, new ones first, one at a time, when it has nothing
else queued. Only one logical
delivery awaits acknowledgment at a time, and the scan waits while the outbox
has four deliveries. A Shot whose fetch
fails is retried after the other requested Shots; a 404 means the tablet
deleted the record. Shots Decaid imported from the legacy de1app (`de1app-*`
ids), and Shots whose ids the server cannot store, are never indexed or sent
(ADR-0004). Deletion
never removes a server record. The outbox (`plugin/src/outbox.ts`) is in
memory, and Steam Records and Workflow and machine state events share it
(`STEAM_RECORDS.md`, `WORKFLOW-AND-STATE.md`); reload reconciliation recovers
lost Shots and edits.
A delivery too large for one frame, such as a long filter or tea shot, is sent
in chunks and acknowledged once (`AI_PROTOCOL_NOTES.md`).

`ShotsService` serializes a Shot's deliveries with a PostgreSQL advisory lock,
then compares `updatedAt` in PostgreSQL. Edit-time
precision is six fractional digits, matching Decaid, rather than JavaScript's
milliseconds. A tie keeps the stored metadata. An early edit is stored as an
incomplete Shot and acknowledged only after commit, or once set aside. Its full record is still
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

All endpoints require a signed-in account, Admin or Staff.

- `GET /api/shots?limit=20&offset=0` returns `{ shots, total, limit, offset }`.
  Limit is 1–100; offset is nonnegative. Results are newest pulled-at first,
  with id as the deterministic tie-breaker and undated records last, and
  `total` counts the whole filtered list. Rows include analytics and Machine
  or Pending Machine credit, plus `machineInferred`, without metadata or
  measurements. They also carry the Location the Machine was at when the Shot
  was pulled (`locationId`, and `location: { id, name, timeZone }`, null when
  unknown), and `locationInferred`, true when that Location came through an
  inferred Machine. Correcting the Machine's Location History changes these,
  never the stored record.
- Filters, each given at most once and combined with AND
  (`server/src/shots/filters.ts`; the Machine, Location and date filters are
  `server/src/record-filters.ts`, which Steam Records lists share):
  - `machineId`, `pendingMachineId`, and `locationId`, which is `none` for
    Shots with no Location. A malformed id is a 404, as in a path.
  - `coffeeRoaster` and `coffeeName` (together, a Bean as each Shot recorded
    it, so the same Bean is found across Machines), `barista` and
    `profileTitle`: exact matches on what the Shot recorded. An empty value
    matches Shots that recorded none. There is no Bean Batch filter: each
    tablet has its own id for the same roast until milestone 2's global ids
    (ADR-0006).
  - `from` and `to`: a local date (`2026-10-05`) or date and time
    (`2026-10-05T06:00`) without an offset, read on each Shot's own
    Location's wall clock, or UTC for a Shot with no Location. `from` is the
    first moment listed; `to` the first moment after them, except that a
    date alone includes the whole of that day. So a day is 23 or 25 hours
    across a daylight-saving change, and an hour the clocks repeat is listed
    twice. Shots whose time is unknown match no time filter.
- `GET /api/shots/filters` returns `{ beans, baristas, profiles }`: the
  distinct Beans (`{ coffeeRoaster, coffeeName }`), Baristas and profile
  titles listed Shots recorded, sorted ignoring case, with null for Shots
  that recorded none.
- `GET /api/shots/:id` returns `{ shot }`, including the stored Decaid metadata
  in `shot.record`, without measurements, and `shot.previousShot`
  (`{ id, pulledAt }` or null): the listed Shot just before it on the same
  Machine, or held by the same Pending Machine, in list order.
- `GET /api/shots/:id/measurements` returns `{ measurements }`, as sent by
  Decaid (null when none were sent).
- `GET /api/machines/:id/set-aside-deliveries?limit=20&offset=0` returns
  `{ deliveries, total, limit, offset }`: the deliveries from that Machine's
  tablet set aside, latest first, each with `receivedAt`, `type`,
  `deliveryId`, `recordId`, `sqlState` and `error`, never its message.
- Machine list and detail responses include
  `lastShot: { id, pulledAt } | null`, by credited hardware rather than the
  tablet that delivered it.

Dismissed Pending Shots are hidden from every read, including filter choices
and previous Shots; adoption restores access. No capture endpoint writes to
the tablet.

`server/test/shot-lists.test.ts` covers the filters, alone and combined,
across Locations in different time zones and both of New York's 2025-2026
daylight-saving changes, and previous Shots.

## Management interface

`/shots` lists Shots with the REST filters in its address, so a filtered
list can be shared or reloaded; `/shots/:id` shows a Shot's curves (pressure,
flow, weight and basket temperature, with the targets its profile set),
everything its record holds, its credit, and a comparison with its previous
Shot. Times are shown in each Shot's Location's time zone, or UTC, labelled,
for a Shot with no Location. `web/src/lib/curves.ts` turns Decaid's
measurements into curves, counting time as `elapsedSeconds` does.
`e2e/shots.spec.ts` covers them with Shots seeded through simulated tablets.

`server/test/shots.test.ts` verifies the built plugin through Seam 1, REST
reads, and two server instances sharing PostgreSQL. It includes 205-record
history paging, mid-backfill reconnect with no index page sent again, live
capture and edits, Shots stored,
edited or deleted while the server is unreachable, reload recovery,
unacknowledged edits, deletion, late full records, edits that clear fields,
replays, precise version ordering, restart, hardware attribution, dismissal
and adoption, identity mismatch, transient and persistent API failures, ignored
legacy imports and incompatible records, and lists while the measurements
table is locked.
