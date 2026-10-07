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

Decaid has no plugin event for Steam Records, so the plugin polls: every poll
interval while a connection is welcomed, and at once on each `welcome`, which
leaves the intervals as they were. A poll reads `GET /steams/latest` (Decaid
v0.8.7 and later): the newest Steam Record by its time, without measurements,
or `null` while there are none. The plugin reads only its `id`, so a poll's work does
not grow with history. If the plugin has not seen that id in this load, it
requests the record from its outbox, ahead of backfill. While no connection
is welcomed, and after a final close, the plugin reads no Steam Records; the
polls from the next `welcome` find those recorded meanwhile.

It reads `GET /steams/ids`, which lists every id in one response, only:

- To build the index, once per load. The first `welcome` reads every id and
  sends them as `steamIndex` pages of at most 100. The server answers each
  page with the ids it does not store, and the plugin backfills them. A
  reconnect does not send the index again. A disconnect partway through
  pauses it, and the next `welcome` sends the pages it had not sent, after
  any page sent but not acknowledged, which the outbox sends again with its
  delivery id. Pages already acknowledged are safe: the server sends its
  request before its acknowledgment, and requested ids survive reconnects.
- Otherwise, at most once every 10 poll intervals while connected, requesting
  the ids it has not seen, ahead of backfill. This finds what
  `/steams/latest` misses: several Steam Records recorded in one interval, a
  record whose time is not the newest, and those recorded while
  disconnected. Intervals spent disconnected count, so after an outage of 10
  intervals or more the read comes with the poll on `welcome`. A read begun
  between intervals, as on a `welcome`, counts from the next, so reads stay
  whole intervals apart however often the connection drops.

The two reads run apart, each skipped while its last one is still running,
so a slow read of every id, as near the fetch limit, holds up no read of the
newest. At a load's first `welcome` the newest may therefore be requested
before the index has been read, and sent though the server has it; the server
stores it once.

Indexes are sent once per load, for Shots too (`SHOTS.md`), replacing
milestone 1's "on every `welcome`". So a server whose database was wiped or
restored learns which records it lacks only when each tablet's plugin is
reloaded.

Past about 268,900 Steam Records (39 bytes per UUID), `GET /steams/ids` is
larger than Decaid's 10 MiB plugin fetch limit, and the fetch fails. The
plugin logs that once per load, with Decaid's reason. It tries again after 1
whole poll interval, then 2, 4 and so on up to 64, or from 10 once the index
has been sent, rather than every 5 s. The intervals count from the failure,
so a read Decaid times out after 30 s waits as long as one refused at once.
Each try makes Decaid buffer up to 10 MiB.
Live capture through `/steams/latest` continues. History the server lacks is
not backfilled until every id can be read, which needs Decaid support (the
upstream ask in the owner's planning notes). The plugin never requests
`GET /steams`, which returns every record, workflow and profile included, in
one response that outgrows the limit far sooner.

Steam Records and Shots share the
plugin's one outbox (`plugin/src/outbox.ts`): one logical delivery awaits
acknowledgment at a time, and index pages wait while four deliveries are
queued. The outbox reads every Steam Record with `GET /steams/{id}`, one at a
time and only while nothing else is queued; a record that cannot be read is
retried after the others. Shots Decaid reports stored are requested and read
the same way (`SHOTS.md`). A 404 means the tablet deleted the
record; nothing deletes the server's copy. A record too large for one frame is
sent in chunks (`AI_PROTOCOL_NOTES.md`).

Steam Record edits are out of scope in milestone 1: Steam Records have no
`updatedAt`, Decaid sends no event for them, and nothing in Decaid, Streamline
or DYE2 edits them.

## Server

`SteamRecordsService` stores a Steam Record once, by its Decaid id, whichever
tablet sends it: a stored record is never replaced, so repeated deliveries,
from any instance or Machine, change nothing. A record without a measurements
array, which Decaid v0.8.7 and later always send, is acknowledged and ignored,
and logged as a warning naming the Machine, the Steam Record's id (quoted,
with anything that could end or restyle the line escaped) and what it lacks,
with no field's value. One whose id the server cannot store
(`isRecordId`), which the plugin never indexes or sends and the server never
requests, is acknowledged and ignored without a warning. A delivery whose
storage fails in a way that would repeat is set aside and acknowledged as
stored, and the record counts as known to that Machine's indexes from then on
(`AI_PROTOCOL_NOTES.md`, Deliveries set aside).
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
`steamed_at`, stored in `steam_records.location_id` and derived again when a
change to that history spans its time, as a Shot's is at its pulled-at time
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

All endpoints require a signed-in account, Admin or Staff; Staff read every
Steam Record an Admin does.

- `GET /api/steam-records?limit=20&offset=0` returns
  `{ steamRecords, total, limit, offset }`. Limit is 1–100; offset is
  nonnegative. Results are newest `steamedAt` first, with id as the
  tie-breaker, and `total` counts the whole filtered list, read in one
  snapshot with the page. Rows carry the analytics, the Machine or Pending
  Machine credit and the Location (`locationId` and
  `location: { id, name, timeZone }`, null when unknown), without the record
  or its measurements, and no inferred marker.
- Filters, each given at most once and combined with AND, are the ones Shots
  lists have by Machine, Location and date (`server/src/record-filters.ts`;
  `SHOTS.md` describes them): `machineId`, `pendingMachineId`, `locationId`
  (`none` for Steam Records with no Location), and `from` and `to`, a local
  date or date and time read on each Steam Record's own Location's wall
  clock, or UTC for one with no Location. A malformed id is a 404, and an
  unreadable date or a repeated parameter a 400.
- `GET /api/steam-records/:id` returns `{ steamRecord }`, including the
  Decaid record without measurements in `steamRecord.record`.
- `GET /api/steam-records/:id/measurements` returns `{ measurements }` as
  Decaid sent them.

A dismissed Pending Machine's Steam Records are hidden from all three, and
listed again, under the machine entry, once one is created for its hardware.
`server/test/steam-record-lists.test.ts` covers the filters, alone and
combined, across Locations in different time zones and both of New York's
2025-2026 daylight-saving changes.

`server/test/steam-records.test.ts` verifies the built plugin through Seam 1 on
two server instances sharing PostgreSQL: history backfill in pages, indexed
once and resumed after a disconnect partway through the index; live capture
by the next poll's read of the newest, while reads of every id are held; two
records recorded in one interval; reads of every id on schedule through
reconnects more frequent than the poll interval, and none holding up the
newest's; no reads while the server is unreachable or after a final close,
and those recorded meanwhile sent after reconnecting; no index sent again on
a reconnect; live capture past the fetch limit, which is logged once and
retried with backoff, counted from a slow failure; local times on both sides of a
daylight-saving change, Location credit and its corrections (including one
stored during a change on another instance), repeated and concurrent
deliveries, deletion on the tablet, chunked records, mismatched connections,
Pending Machines and their dismissal and adoption, and ignored records and their warnings.

## Management interface

`/steam-records` lists Steam Records with the REST filters in its address, as
`/shots` lists Shots (`web/src/components/record-lists.tsx`), with times in
each Steam Record's Location's time zone, or UTC, labelled, for one with no
Location. `/steam-records/:id` shows a Steam Record's peak and final milk
temperature, its credit, the steam settings its Workflow recorded, and its
curves, drawn as a Shot's are (`web/src/lib/curves.ts`): the milk
temperature, with the temperature its Workflow stops steaming at
(`stopAtTemperature`, when above 0) dashed; the steam heater's temperature;
and the steam's pressure and flow, with the targets the machine reported.
The curves show every reading as recorded, including one carried over from
the Steam Record before; when that reading is above the peak, the page says
the peak leaves it out. `e2e/steam-records.spec.ts` covers them with Steam
Records backfilled by simulated tablets.
