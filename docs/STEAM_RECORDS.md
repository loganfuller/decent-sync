# Steam Record capture

Ticket [#12](https://github.com/loganfuller/decent-sync/issues/12) extends
protocol version 1 with these messages, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `steam` | `id` (delivery id), `steamId` (Decaid id), `steamedAt` (UTC time), `steam` (opaque record) |
| Plugin to server | `steamIndex` | `id`, `steams: [{ id }]`, at most 100 entries |
| Server to plugin | `requestSteams` | `steamIds`, at most 100 ids |

`ack` acknowledges both, as it does Shots (`SHOTS.md`). Plugins that predate
these messages never send them, and the server sends `requestSteams` only in
answer to a `steamIndex`, so the protocol version stays 1.

## Time

Decaid writes a Steam Record's `timestamp` as the tablet's local time without
an offset, to the microsecond (`DateTime.now()` by `toIso8601String`, in
`decaid:lib/src/controllers/steam_sequencer.dart`), and records no UTC time:
Shots have a UTC `createdAt`, Steam Records nothing. The plugin runs in the
tablet's time zone, so it places the record: it builds the time from its parts
with `new Date(year, month - 1, day, ...)`, which JavaScript reads as local
time with daylight saving, and sends the UTC instant as `steamedAt`, leaving
the record as Decaid sent it. A local time that occurs twice, as the clocks go
back, is read as the first. A time with an offset, which Decaid does not write
today, is placed by its offset. A time that does not exist, such as the 30th
of February, a local time the clocks skip or an offset past 23:59, is refused
rather than rolled over into another. The validator accepts `steamedAt` only
as `Date.prototype.toISOString` writes it. A record whose `timestamp` the
plugin cannot read is not sent; it logs why.

Decaid runs plugins in QuickJS (`flutter_js`). Seam 1 runs the built plugin in
Node with `TZ` set to `America/Chicago`. On 2026-10-05 the built plugin also
ran in Decaid v0.8.7's Linux release, in a container with that `TZ` and
Decaid's simulated Bengle, against a scratch server: it backfilled and
captured Steam Records live, each placed at the right UTC instant, so QuickJS
on Linux reads local time in the process's time zone. Whether QuickJS on an
Android tablet reads it in the tablet's zone is unverified; that needs the
plugin installed on the test tablet. The upstream ask for a UTC time on Steam
Records, in the owner's planning notes, would remove the dependence.

## Plugin

Decaid has no plugin event for Steam Records. Every poll interval the plugin
reads `GET /steams/ids`, which lists every id in one response, and requests
the ids it had not seen before from its outbox, ahead of backfill. Its first
read only notes the ids. It never requests `GET /steams`, which returns every
record, workflow and profile included, in one response that outgrows Decaid's
10 MiB fetch limit at cafe volume.

On every `welcome` it reads the ids again and sends them as `steamIndex` pages
of at most 100. The server answers each page with the ids it does not store,
and the plugin backfills them one at a time. Steam Records and Shots share the
plugin's one outbox (`plugin/src/outbox.ts`): one logical delivery awaits
acknowledgment at a time, and index pages wait while four deliveries are
queued. The outbox reads every Steam Record with `GET /steams/{id}`, one at a
time and only while nothing else is queued; a record that cannot be read is
retried after the others. Shot events read their Shots on their own, as
before. A 404 means the tablet deleted the
record; nothing deletes the server's copy. A record too large for one frame is
sent in chunks (`AI_PROTOCOL_NOTES.md`).

Steam Record edits are out of scope in milestone 1: Steam Records have no
`updatedAt`, Decaid sends no event for them, and nothing in Decaid, Streamline
or DYE2 edits them. Every id fits in one `GET /steams/ids` response until a
tablet holds more than 250,000 Steam Records.

## Server

`SteamRecordsService` stores a Steam Record once, by its Decaid id, whichever
tablet sends it: a stored record is never replaced, so repeated deliveries,
from any instance or Machine, change nothing. A record without a measurements
array, which Decaid v0.8.7 and later always send, is acknowledged and ignored.
Two deliveries of one record at once are decided by the insert's conflict on
its id, so it is stored once whichever instance each reaches.

Decaid records no hardware on Steam Records, so each is credited to the
Machine whose tablet sent it, with no inferred marker (ADR-0015). From a
mismatched connection it is credited to the reported hardware, as an inferred
Shot is: to the Machine that has it, otherwise to its Pending Machine
(`creditReporter` in `server/src/machines/credit.ts`, which Shots share).
Dismissing the Pending Machine leaves its Steam Records out of every read
without deleting them; creating a machine entry for its hardware, or binding
the hardware to a Machine, hands them over with its Shots
(`transferPendingRecords`).

A Steam Record's Location is derived from its Machine's Location History at
`steamed_at`, stored in `steam_records.location_id` and derived again whenever
that history changes, as a Shot's is at its pulled-at time
(`server/src/machines/location-history.ts`). Storing it holds the Machine's
row lock, as history changes do. A Pending Machine's Steam Records have no
Location.

The record without measurements, the credit and the analytics live in
`steam_records`; the measurements live in `steam_measurements.data`, a
separate `jsonb` column with lz4 compression. `extractSteamRecord`
(`server/src/steam-records/extraction.ts`) is the pure, optional-field
projection: duration, peak and final milk temperature (null without a
probe) and Barista. Duration adds up the gaps between consecutive samples'
local times, leaving out the whole quarter hours a daylight-saving change adds
or takes away; a gap where the tablet's clock was otherwise corrected counts
for nothing (`elapsedSeconds`, which Shots share). The final temperature is
the last reading. Decaid starts each Steam Record with the probe's latest
reading, which, until the probe reports again, is the last one of the record
before: `SteamSequencer` subscribes to the probe afresh for each record, and
`BengleMilkProbe` replays its latest reading to a new subscriber. Steamed milk
warms, so when the probe's next reading is lower, the first is taken to be
carried over and left out of the peak; whether or not it was, that changes the
peak only if no later reading is as high. The extraction is tested against a
real DE1Pro record and two from Decaid's simulated Bengle, one of which starts
with the reading carried over.

## REST API

All endpoints require a signed-in account, Admin or Staff. Filters by
Location and date are ticket #18.

- `GET /api/steam-records?limit=20&offset=0&machineId=<uuid>` returns
  `{ steamRecords, total, limit, offset }`. Limit is 1–100; offset is
  nonnegative. Results are newest `steamedAt` first, with id as the tie-breaker.
  Rows carry the analytics, the Machine or Pending Machine credit and the
  Location (`locationId` and `location: { id, name, timeZone }`, null when
  unknown), without the record or its measurements.
- `GET /api/steam-records/:id` returns `{ steamRecord }`, including the
  Decaid record without measurements in `steamRecord.record`.
- `GET /api/steam-records/:id/measurements` returns `{ measurements }` as
  Decaid sent them.

A dismissed Pending Machine's Steam Records are hidden from all three.

`server/test/steam-records.test.ts` verifies the built plugin through Seam 1 on
two server instances sharing PostgreSQL: history backfill in pages through a
reconnect, live capture by the next poll, local times on both sides of a
daylight-saving change, Location credit and its corrections (including one
stored during a change on another instance), repeated and concurrent
deliveries, deletion on the tablet, chunked records, mismatched connections,
Pending Machines and their dismissal and adoption, and ignored records.
