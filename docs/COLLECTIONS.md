# Library, settings, paired devices, plugins and Skins

Ticket [#14](https://github.com/loganfuller/decent-sync/issues/14) extends
protocol version 1 with one delivery, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `collection` | `id` (delivery id), `name` (one of `COLLECTION_NAMES`), `available`, and `value` (opaque, as Decaid's API answered) while available; for one of `LIBRARY_LISTS`, `updatedAt` too (ticket #80); for one of `UTC_OFFSET_COLLECTIONS`, `utcOffsetMinutes` too (ticket #229); for a Settings Edit's read-back, `settingsEditId` too (ticket #432, Settings History below); for a Software Action's read-back, `softwareActionId` instead (ticket #660, Software Actions below) |

It is acknowledged with `ack` once stored, or set aside because storing it
fails in a way that would repeat, as Shots are (`AI_PROTOCOL_NOTES.md`,
Deliveries set aside). The protocol version stays 1, as it does for any
change (ADR-0017). A name the server does not know, as
a newer plugin might send, is acknowledged and ignored. While `available` is
true, `value` is any JSON but null; while false, it is absent.

Decaid writes a Library record's `updatedAt` in the tablet's local time
without an offset, as it does a Steam Record's time. So with the library's
lists (`beans`, `beanBatches`, `grinders` and `profiles`, `LIBRARY_LISTS`), the
plugin sends `updatedAt`, an array as long as the list, each record's
`updatedAt` placed in UTC in the tablet's time zone (`plugin/src/local-time.ts`,
as `STEAM_RECORDS.md` describes), or null for one it cannot place. The value
stays as Decaid sent it.

DYE2's baskets and tools (`dye2Baskets` and `dye2Equipment`) are Library lists
too since ticket [#138](https://github.com/loganfuller/decent-sync/issues/138)
(ADR-0005). Their records carry no edit time, so beside each the plugin sends
when it first read the record's current content, in UTC, which times its edits
(`FirstReads` in `plugin/src/change-detection.ts`): a record read again
unchanged keeps its time, and one whose content changed, or that is new to the
list, is read now. The plugin keeps these times for one runtime, so after a
reload a record is first read then. A record without a string id has null.

Decaid keeps night mode's times (`appSettings`), the wake schedules' times
and `keepAwakeUntil` (`presenceSettings`) in the tablet's own time too, as
minutes after midnight, `HH:MM` and a local date and time without an offset.
They are settings, not times to place in UTC, so the value stays as Decaid
sent it, and beside a value of either collection (`UTC_OFFSET_COLLECTIONS`)
the plugin sends `utcOffsetMinutes`, the tablet's UTC offset as it read the
value, in whole minutes east of UTC: the negative of
`Date.prototype.getTimezoneOffset()`, such as -240 for Toronto in summer, and
within 18 hours of UTC (ticket
[#229](https://github.com/loganfuller/decent-sync/issues/229)). The offset is
part of what the plugin compares, so a daylight saving change sends both
collections at the next poll, unchanged but for it. The server keeps it with
the value (`reported_collections.utc_offset_minutes`), as an unavailable
report keeps the value, and the REST API serves it beside the value as
`utcOffsetMinutes`, null for every other collection. The one offset labels
every time in the value, so a `keepAwakeUntil` read before a daylight saving
change, for a keep-awake window ending after it, is shown with the offset
before the change until the window ends: an accepted gap, as such a window
must span the change in the night.

## Collections

Each is read from Decaid v0.9.0's API (`decaid:assets/api/rest_v1.yml`):

| Name | Read from | Compared by |
|---|---|---|
| `beans` | `GET /beans?includeArchived=true` | ETag |
| `beanBatches` | `GET /bean-batches?includeArchived=true` | ETag |
| `grinders` | `GET /grinders?includeArchived=true` | ETag |
| `profiles` | `GET /profiles?includeHidden=true`, which includes deleted ones too | ETag |
| `dye2Recipes`, `dye2Equipment`, `dye2Baskets` | `GET /store/dye2.reaplugin/{recipes,equipment,baskets}` | content |
| `appSettings` | `GET /settings` | content, with the UTC offset |
| `presenceSettings` | `GET /presence/settings`, the wake schedules included | content, with the UTC offset |
| `machineSettings` | `GET /machine/settings` | content |
| `advancedSettings` | `GET /machine/settings/advanced` | content |
| `machineCalibration` | `GET /machine/calibration` | content |
| `sensorCalibration` | `GET /machine/calibration/{flow,pressure,temperature}`, three reads | content |
| `plugins` | `GET /plugins` | content |
| `pluginSettings` | `GET /plugins/{id}/settings` for each plugin in the list just read that declares settings, one read each | content |
| `decaidUpdate` | `GET /update` | content |
| `skins` | `GET /webui/skins`, `/webui/skins/default` and `/webui/server/status`, three reads | content |
| `skinPage` | none: the page a Skin last reported to the plugin's `page` endpoint, held by the plugin (Plugins and Skins, below) | content |
| `pairedDevices` | `GET /devices`, without devices only discovered nearby | content |
| `scaleInfo` | `GET /scale/info` | content |
| `sensors` | `GET /sensors` | content |

A read is unavailable when it fails or has nothing to report: any status but
200 or 304 (the machine's settings answer 500 while no machine is connected,
`/scale/info` 503 while no scale is), a fetch that fails or times out, or
`null` for a collection read from Decaid's API. `sensorCalibration` is
unavailable if any of its three reads is, and its later reads are then not
made: a partial set would be compared with another Machine's complete one.
It is sent as unavailable, never as an empty collection. So is
`pluginSettings` where the plugin list was not read or any of its reads
fails, as a partial set would read as settings cleared. So is `skins` if any
of its reads is, as a partial set could name another Skin active than the
tablet's, but for the default Skin with no Skin installed (Plugins and
Skins, below). One of DYE2's keys never written answers `null`
too (`KvStoreHandler` in
`decaid:lib/src/services/webserver/kv_store_handler.dart`), which DYE2 reads
as an empty list, and so does the plugin, which sends it as one
(`DYE2_LISTS`); a read of one that fails is still unavailable, and never taken
as empty.

DYE2's recipes, baskets and tools are written by the plugin too, through
the Library (`LIBRARY.md`, Taking in a tablet's baskets and tools, and
Taking in a tablet's recipes): after it writes one of those lists, its next
read is sent whatever it holds, as another app rewriting the list at the same
moment may have put it back as last sent. `pairedDevices` keeps Decaid's inventory entries as sent, leaving
out those whose `state` is `discovered`: devices nearby come and go and may
belong to another Machine at the same Location. Connected and connecting
devices, and those Decaid remembers (`disconnected`, and not `available` while
out of range), stay. A remembered device in range but not connected is listed
by Decaid as `discovered` too, so it is left out until it connects or leaves.

## Settings fields

Milestone 4 ([#220](https://github.com/loganfuller/decent-sync/issues/220),
ADR-0023) makes a Machine's settings editable. Each field of
`machineSettings`, `advancedSettings`, `machineCalibration`,
`sensorCalibration`, `appSettings` and `presenceSettings` is defined once, in
`protocol/src/settings-fields.ts` (`SETTINGS_FIELDS`, ticket
[#222](https://github.com/loganfuller/decent-sync/issues/222)), for the
server, the plugin and the management interface: Decaid's name for it (for
`sensorCalibration`, the target, whose `measuredValue` is the value), its
label and unit, its kind (number, whole number, on or off, choice, time of
day, a time written HH:MM, days of the week, a local date and time, or wake
schedules), its range and its step or choices, whether none is a value too,
who may change it (Staff or Admin),
or what sets it for a read-only field, and its notes: kept by the Tablet, so
a replacement Tablet or a reset of Decaid's data puts Decaid's default back
(ADR-0023); written again by the Tablet as the Machine connects, where it
was last written through that Tablet, so a value set from elsewhere lasts
only until then, the flow calibration's (ADR-0023); or to restart the Machine
after a change. Decaid's automatic update checks are an Admin's, and marked
`withSoftware`: edited on the Machine's Software tab with the Tablet's
plugins and Skins, shown read-only on the Settings card, and offered to no
assistant (Settings Edits, below; ADR-0023, ADR-0034). Streamline's settings
page no longer puts back a fan threshold of 50 or a refill kit of
Auto-Detect from v0.2.22 on Decaid v0.9.1, so no note says it does.
Labels, units, ranges, steps and choices follow Streamline's settings page at
v0.2.31, in this repository's sentence case, and Decaid's own limits where it
has none: from v0.2.29 it names the weight, volume and hot water flow
multipliers "Weight look-ahead", "Volume look-ahead" and "Hot water
look-ahead", on its "Shot control" page, and the flow multiplier "Flow
calibration", as the management interface does, while Decaid's field names
are unchanged. A ±
button's increment is no step: Streamline's move the look-aheads of the
Tablet Settings by 0.1 and 0.05, but its text boxes and Decaid take any value
of 0 or more, so their step of 0.01 is chosen here (ticket
[#343](https://github.com/loganfuller/decent-sync/issues/343)). A
wake schedule's fields, which an edit adding or changing one sets, are
defined apart (`WAKE_SCHEDULE_FIELDS`): its time, `HH:MM`; its days, ISO
weekdays 1 to 7, each once and in order, none for every day; whether it is
on; and its keep-awake time, 1 to 720 min or null for none.

`validateSettingsEdit`, a pure function, decides whether an edit's fields and
values are allowed by the definitions and to the account making it. It
refuses an unknown or read-only field, an Admin's field for Staff, a value not
of the field's kind, a choice not offered, a value out of range, one off its
step (`onStep`), and an edit of more than one sensor's calibration, as an edit
names one target. For a wake schedule's edit, it refuses an add that does not
set every field, a change that sets none, a delete that sets any, and a
schedule named for a collection other than `presenceSettings`. A number may have no more decimal places than its step, and
must be a whole multiple of it, counted in the step's least decimal place on
the number's decimal digits rather than by floating-point arithmetic, so a
step of 0.05 takes 0.35 and refuses 0.33, however large the number. The
server checks every Settings Edit with it, and the plugin again before it
writes (Settings Edits, below).

The Machine page's Settings card groups the Machine Settings (`General`, the
`machineSettings`; `Advanced`; `Flow calibration`; `Sensor calibration`) and
the Tablet Settings (`appSettings`), with its `Presence` (`presenceSettings`,
ticket #229) under them. Each field is shown by its label, with
its unit or its choice's label, and a reported value outside its range or
choices is shown as it is. Presence lists the wake schedules in a table, each
with its time, its days (none chosen is every day, as Decaid takes it),
whether it is on and how long it keeps the Machine awake. Night mode's
times, the schedules' times and `keepAwakeUntil` are shown as the tablet
holds them, in its own time, not moved into the browser's, each labelled with
the offset reported beside them, such as `06:30 (UTC−4)`
(`web/src/lib/tablet-time.ts`). What sets a read-only field, and a field's notes,
are in a tooltip on an info icon beside its value, which opens on hover,
focus or a tap, as is when each section was reported; a section not reported, or unavailable when last read, says so in
plain sight. A field Decaid reports that no definition covers is shown
read-only under Decaid's name, after the others.

## Settings Edits

A Settings Edit (ADR-0023) is one write of a settings collection's fields,
made in the management interface, or through an assistant (ADR-0026), and
carried out at once by the plugin on
the Tablet whose connection holds the Machine. Nothing holds what a setting
should be afterwards: the setting is whatever the Tablet next reports, and a
change made on the Tablet later stands. Ticket
[#224](https://github.com/loganfuller/decent-sync/issues/224) edits the
`machineSettings` (the fan threshold and steam purge mode), and
[#227](https://github.com/loganfuller/decent-sync/issues/227) the
`advancedSettings` (the heater's flows, idle temperature, test time-out and
voltage, and the refill kit) and the `machineCalibration` (the flow
multiplier), all an Admin's, and
[#228](https://github.com/loganfuller/decent-sync/issues/228) sets a
sensor's calibration (`sensorCalibration`), an Admin's too, and
[#230](https://github.com/loganfuller/decent-sync/issues/230) the Tablet
Settings (`appSettings`), Staff's but for gateway mode and the automatic
update checks, an Admin's (the checks shown only from ticket
[#549](https://github.com/loganfuller/decent-sync/issues/549), and edited
again on the Software tab from ticket
[#660](https://github.com/loganfuller/decent-sync/issues/660)), and
[#231](https://github.com/loganfuller/decent-sync/issues/231) the presence
settings (`presenceSettings`), Staff's: presence and the sleep timeout, and
each wake schedule added, changed or deleted on its own. That is every
collection in `EDITABLE_SETTINGS_COLLECTIONS`.

- **Made through REST.** `POST /api/machines/:id/settings-edits` takes `{
  collection, fields, expected }`: each field it sets with its new value, and
  `expected`, each of those fields' raw value in the report the page showed,
  as the API sent it, never the rounded value the card displays. An edit of
  `sensorCalibration` sets one target, such as `{ "pressure": 1.02 }`,
  expecting its current read's `measuredValue`. A wake schedule's edit adds
  `schedule`: `{ action: "add" }` with every one of its fields, expecting
  nothing (`{}`); or `{ action: "change" | "delete", id }`, naming the
  schedule by the id Decaid gave it, with the fields changed, or none for a
  delete, and expecting the whole schedule as reported, its id included. It is
  refused at once, with nothing kept: 400 where `validateSettingsEdit`
  refuses a field (but for an Admin's field), where `expected` does not name
  exactly the fields set, or for a wake schedule, is not the schedule named,
  or not empty for an add; 403 for an
  Admin's field asked by Staff, or Staff editing a Machine at no Location
  they work at; 409 while the Machine is offline, as its status judges it,
  or while its connection's tablet reports another machine's hardware, which
  nothing is written to (ADR-0004). An Admin edits any Machine with an
  entry, a Capture-only one or one at no Location included, as Settings
  Edits are no Library writes. It answers `{ settingsEdit }` with its outcome
  pending (null), and for a wake schedule its `schedule`, `{ action, id }`,
  whose id is null for an add until its answer gives the new schedule's.
  `GET /api/machines/:id/settings-edits/:editId` reads one,
  which the page reads until it has an outcome, and `GET
  /api/machines/:id/settings-edits` lists the Machine's edits, newest first,
  paged by `limit` and `offset` as the other histories are, as `{
  settingsEdits, total, limit, offset }`, each judged not confirmed as one
  read alone is. All three are marked for Staff. An edit's account is named
  to Admins, and to Staff by its id only, as the Library's history names
  accounts, their own included. Its `connectedApp`, `{ id, name, host }`,
  names the Connected App it was made through, by the name the app gave and
  its client id's host, and is null for one made in the management interface
  (`settings_edits.connected_app_id`, which the previous release leaves
  null, ADR-0025).
- **Made through an assistant** (#413, ADR-0026). `edit_machine_settings`
  takes what the REST API takes, with the Machine's id, reads it with the
  same reader (`readSettingsEdit`), and makes the edit as the account,
  through its Connected App, so it is refused as the REST API refuses it,
  with its message. Its description lists each collection's settings from
  `SETTINGS_FIELDS`, so it stays in step with them, leaving out the fields
  marked `withSoftware`, the automatic update checks, which it refuses with
  400: whether anything on the Tablet updates is no assistant's to change
  (ADR-0034). It answers with the edit as `list_settings_edits` gives it, its
  outcome usually still to come, which the assistant reads there.
- **Kept and sent** (`server/src/settings-edits/`, ADR-0016). An edit is a row
  of `settings_edits`, inserted with the Machine's row locked, which also
  judges it online, naming the connection (`connected_session_id`) and tablet
  holding it then, and announced with `NOTIFY settings_edits` in the same
  transaction. The instance holding that connection claims it with the row
  locked again, while the connection still holds the Machine, by setting
  when it was sent, then sends it as `settingsEdit`, with the time it has
  left of `SETTINGS_EDIT_MS` (60 s) by PostgreSQL's clock. Each is sent as
  soon as it is made, without waiting for earlier answers. A connection looks
  for its edits once welcomed, and every connection after its instance listens
  anew, so one made meanwhile is still sent, unless it has no time left. A
  later connection, even from the same tablet, sends nothing made for an
  earlier one.
- **Carried out** (`plugin/src/settings-edits.ts`), one at a time in the order
  received, in a queue of its own (`SettingsAccess`) beside the reads of the
  settings collections, apart from the Library's writes and their reads: so
  an edit never waits for a Library write's answer, and a poll started before
  an edit cannot report a value older than the edit's read-back after its
  answer. An edit is never queued for later: the plugin counts down its
  `timeLeftMs` from when it arrives, both by a host timer, which a correction
  of the tablet's clock does not move, and by that clock, which counts time
  the tablet spent asleep, and refuses it as `expired` once the connection
  that sent it has closed, or where it would start the write with less than
  `SETTINGS_EDIT_WRITE_MARGIN_MS` (15 s) left, judged as the edit's turn comes
  and again just before the write. So a write it starts has time to finish
  within the 60 s, and none is started after the 60 s, nor once the plugin
  knows its connection closed. A write started in time can still finish later,
  as Decaid writes fields one at a time. It keeps no edit across an unload:
  one waiting its turn, or under way, as the plugin unloads is dropped
  unanswered, and no write is started after it. For each edit the
  plugin:
  1. checks the fields against their definitions again, writing none without
     one, and refuses an edit they refuse by `decaid`, with a null status and
     a message of `NOT_WRITTEN` followed by what they refuse. A plugin at
     another release, whose definitions differ, refuses so an edit the
     server's allow, as 1.3.1's plugin refused a weight flow multiplier of
     0.86 off its step of 0.1 (#343);
  2. reads `GET /machine/state`, going ahead only while the state is `idle`,
     `schedIdle`, `sleeping` or `needsWater` (`SETTINGS_EDIT_STATES`), and
     refusing it as `machineBusy`, naming the state, otherwise, or with
     Decaid's answer where the read fails, as with a 500 naming
     `DeviceNotConnectedException` while no machine is connected. Decaid
     reads and writes the Tablet Settings without a machine, so an edit of
     `appSettings` or `presenceSettings` goes ahead on that 500;
  3. reads the collection, reports it if it changed, and refuses the edit as
     `changedSince`, with the fields' current values, if any field no longer
     holds its expected value (`sameValue`);
  4. writes only the edit's fields through the collection's route: `POST
     /machine/settings`, `/machine/settings/advanced`,
     `/machine/calibration`, `/settings` or `/presence/settings`. The
     automatic update checks go through `host.localApi`, in a request of
     their own, as Decaid takes them turned on from a plain request only
     while its "Require authorization for extension management" setting is
     off, and `localApi` takes no other Tablet Setting; so the server
     takes an edit of them with no other field, which could be left
     applied in part (`writeFields`). Decaid follows a change of the checks made over its API
     when it next starts. Decaid writes each field in
     turn, so a refusal part-way leaves the fields before it written, as
     `/settings` does as it refuses a value with 400 and its `message`. A
     scaled register's value is truncated (`_writeMMRScaled`), so a flow
     multiplier of 1.001 is stored as 1.000 and reads as `adjusted`, and a
     DE1's firmware holds some flow multipliers lower still (below); the
     heater voltage and refill kit read back as Decaid holds them (below);
  5. whether Decaid took the write or not, reads the collection again and
     queues it as a `collection` delivery naming the edit
     (`settingsEditId`, Settings History below), then queues its answer,
     `settingsEdited`, behind it: `written` with the values read back, or
     refused by `decaid` with Decaid's status and its `error` or `message`,
     and the values read back, as Decaid writes the fields one at a time. The
     read counts for the machine settings' 60 s interval. A report an edit
     queues stays where it is: a later report of the collection is queued
     after the answer rather than replacing it, so the answer never overtakes
     the read-back it reports.
  A Shot started between the state's read and the write is an accepted gap.
  A sensor's calibration is read and set by target instead, as
  `PUT /machine/calibration/{target}` is a correction of the value the
  sensor holds, not a set: the machine multiplies a ratio by
  `measuredValue / de1ReportedValue` and adds their difference to an
  offset. The plugin reads the one target, checks its current value C, the
  read's `measuredValue`, against `expected` (3), then writes
  `{ de1ReportedValue: C, measuredValue: X }` for the value X asked for,
  which lands on X, as Streamline's `absoluteSetCorrection` does
  (`streamline-js:src/modules/sensor-cal.js`; `absoluteSet` in
  `plugin/src/sensor-calibration.ts`, with module tests). It refuses a
  `flow` or `pressure` target whose C encodes as 0 in Q16.16 by `decaid`,
  with a null status and nothing written, as Decaid would refuse to divide
  by it (`De1Calibration`). Each read of the target is reported within the
  collection, beside the other two targets as last read. Where the last read
  of the collection was unavailable, the read before the write is not
  reported, so no other read delays the write, and the read-back reads all
  three again, as a partial set is never sent (5). The machine holds the value nearest X in
  Q16.16, within half the field's step, so the edit reads as `applied`.
  A wake schedule is added, changed or deleted on its own, through Decaid's
  presence routes. For a change or a delete, the plugin reads `GET
  /presence/settings`, reports it if it changed, and goes ahead only while it
  holds the schedule of that id as the edit expected it, whole
  (`sameValue`); otherwise it refuses the edit as `changedSince` with the
  schedule as held, or with none (`{}`) where it is gone. Then it sends
  `POST /presence/schedules` with the fields for an add, `PUT
  /presence/schedules/{id}` with the fields changed, or `DELETE
  /presence/schedules/{id}`; a 404, as for a schedule deleted between the
  read and the write, is refused as `changedSince` too. Decaid takes a
  keep-awake time of null as none for both. After the write, it reads
  `/presence/settings` again and reports it, and its answer carries the
  schedule as read back, by the id the edit named or Decaid gave the new one
  (`scheduleId`, from the add's 201), with a `keepAwakeFor` of null for none,
  which Decaid leaves out, or `{}` once deleted. The server keeps that whole
  schedule as the read-back, and the new id in the edit's
  `schedule_id`.
- **Not confirmed.** An edit still unanswered is `notConfirmed` once 60 s
  have passed since it was made, or once its connection no longer holds the
  Machine: it closed and was released, or a newer connection replaced it, as
  in a reconnect or a Tablet swap. Every instance judges it the same way from
  the database, by PostgreSQL's clock, whenever the edit is read; nothing
  marks it. A connection gone unheard, as when its instance crashed, counts
  only once the 60 s are up, as a plugin whose heartbeats the database is
  merely slow to record could still start the write. Two gaps are accepted.
  Where the server replaces a connection, or releases it as its instance
  shuts down, the plugin hears of it only afterwards, at most at its next
  heartbeat, so a write it starts meanwhile is answered late and replaces the
  mark. And an answer recorded just as the 60 s run out, whose commit lands
  after them, can show the edit not confirmed for that moment and then on
  time.
- **Answered.** Whichever instance the answer reaches, on the connection it
  was sent on or a later one, records it for the edit of that Machine still
  unanswered, by PostgreSQL's clock, and acknowledges it. An answer arriving
  once the edit was not confirmed replaces the mark with what came of it,
  marked `late`, but for an `expired` refusal, which leaves it not confirmed.
  An `expired` refusal arriving before then, of an edit with too little time
  left for its write, is shown as refused. A pure module
  (`server/src/settings-edits/outcome.ts`) decides the outcome: `applied`
  where every field read back is within half its step of the value sent (a
  step of 1 for a whole number; the same JSON for a choice or on or off
  value), `adjusted` naming each field the Machine stored otherwise and what
  it holds, or `refused` with the plugin's reason, and for Decaid's refusal
  the fields the read-back shows changed from what the edit expected (none
  for a wake schedule added, which expected nothing). A delete sets no field,
  so Decaid taking it is `applied`.
- **The Settings card.** A section the account may change a field of has an
  Edit button, which opens an inline form offering only those fields, each
  with its notes, and the others in their place, read-only. While the Machine
  is offline, or its Tablet reports another machine's hardware, Edit is
  disabled with the reason. A number reported with the noise of Decaid's
  register scaling, such as a heater flow of 2.3000000000000003, opens in its
  input on the field's step, as does a sensor calibration within half a
  step of Q16.16 of it, such as 1.0199966430664062 for 1.02. Each sensor's
  calibration has an Edit button of its own, which opens a form for that
  target alone, and saving it first asks, in an `AlertDialog`, to go ahead
  past a warning modelled on Streamline's: bad calibration settings might
  make the Machine unusable. Night mode's times are edited in time inputs
  in the Tablet's own time, each labelled with the offset reported beside
  the section, such as `Night mode sleep time (UTC−4)`, and sent as minutes
  after midnight, as Decaid keeps them. Where that offset differs from the
  offset of the Machine's Location's time zone now (`differingZoneOffset`
  in `web/src/lib/tablet-time.ts`), the form warns that the times are the
  Tablet's own; a Machine with no Location gets no warning. A field Staff
  are not offered as an Admin's, such as gateway mode, keeps its place
  read-only, saying so. The Presence section's form offers presence and the
  sleep timeout, and `keepAwakeUntil` stays read-only. Its wake schedules
  (`web/src/components/wake-schedules.tsx`) each have Edit and Delete, and an
  Add button follows them, for any account that may change them. Add and
  Edit open a form of the schedule's time, in a time input in the Tablet's
  own time labelled with its offset, with the time zone warning; its days, as
  checkboxes, none for every day; whether it is on; and its keep-awake time,
  empty for none. An add sends every field, and a change only those changed,
  expecting the schedule as the form opened over it. Delete asks first, in
  an `AlertDialog`. On a Bengle, Decaid also writes the presence settings
  into the Machine's firmware, its enabled schedules as at most 32 wake
  windows, dropping the rest (`translateWakeSchedules` and
  `kFirmwareMaxWakeWindows` in
  `decaid:lib/src/models/firmware_wake_window.dart`). So on a Machine whose
  model is `Bengle`, while presence is on, the schedule form and the
  section's form count the windows the schedules make as they would be
  (`firmwareWakeWindows` in `web/src/lib/wake-windows.ts`, with module
  tests): one per day a schedule runs, every day where it names none, and
  another where its keep-awake time, 240 min where it has none, runs past
  midnight; and warn where they come to more than 32. Saving sends only the fields
  changed, each with `expected` from the report the form opened over: a
  report the page loads while the form is open changes neither, so a change
  made on the Tablet meanwhile refuses the edit as changed since, and a field
  left as it opened is never sent. The section then shows the edit as
  pending, reads it every second until it has an outcome, shows the outcome
  in place, and loads the reports again, so its values come from the latest
  one. An edit not confirmed is shown so, and read every 5 s until a late
  answer replaces the mark, shown as answered late. A refusal by the plugin's
  own definitions of an edit the page's allow (`refusedByOtherDefinitions`)
  says the Tablet's plugin must update before it takes the change, rather
  than repeating the plugin's reason, such as a step the page no longer has.
- **The Settings History card** (`web/src/components/settings-history.tsx`)
  lists the Machine's edits among the changes its Tablet reported (ticket
  [#545](https://github.com/loganfuller/decent-sync/issues/545), Settings
  History, below), in place of a Settings Edits card of their own: an edit
  that made a change is that change's row, with who made it ("You" for the
  account's own, the account's name to Admins, and otherwise "An account", as
  the Library's history shows Staff, followed by ", through <app>" for one
  made through a Connected App) and its outcome, a late answer marked so.
  Such a row is timed when the change was received, and a tooltip beside who
  made it says when the edit was made. An
  edit that changed nothing, being pending, refused, not confirmed or put
  back by the Machine, is listed at the time it was made, a row for each
  field it set, with the value asked for and the value in the report it was
  made over, and its outcome. A wake schedule's is one row, named by its
  time as reported, with what it asked: to add it, with each field it set,
  to change it, with each field changed, from what to what, or to delete it. The section's
  status names a wake schedule's edit as asked while pending, such as
  "Change the wake schedule at 06:30", and as done, such as "Wake schedule at
  06:30 changed", once applied. The card is shown closed, since most who read
  the page do not need it, and loads nothing until opened. Open, it loads
  every 30 s, and again as an edit made on the page is answered. A page read
  for one choice of what to list is never shown under another, so nothing
  made outside Decent Sync stands under "Settings Edits" while that list
  loads. A time of
  day there is the Tablet's own, written without its offset, as an edit
  does not keep the offset it was made in. `GET
  /api/machines/:id/settings-edits` stays for the REST API's other clients,
  the previous release's page (ADR-0025) and `list_settings_edits`.

`server/test/settings-edits.test.ts` covers this through Seam 1, with the
built plugin on two instances sharing PostgreSQL,
`server/test/advanced-settings-edits.test.ts` the advanced settings and the
flow multiplier, `server/test/sensor-calibration-edits.test.ts` the sensor
calibration, `server/test/tablet-settings-edits.test.ts` the Tablet
Settings, `server/test/presence-settings-edits.test.ts` the presence
settings and wake schedules, and
`server/test/settings-edit-deadline.test.ts` the 60 s limit, edits not
confirmed, late answers, reconnects, unloads, a Tablet swap and a crashed
instance, with Decaid slowed by `holdRequests`;
`server/test/settings-edit-outcome.test.ts` covers the outcome module, and
`server/test/settings-edit-log.test.ts` the list, and
`e2e/settings-edits.spec.ts` the management interface.

## Plugin

`plugin/src/collections.ts` reads the collections and sends them through the
plugin's one outbox (`plugin/src/outbox.ts`), which Shots, Steam Records and
Workflow events share; large ones are chunked like any delivery. Whether to
send is decided by `plugin/src/change-detection.ts`, a pure module with module
tests (`plugin/test/change-detection.test.ts`):

- While connected, every poll interval the plugin reads each collection but
  the machine's own settings and its sensor calibration, one after another,
  and sends one that changed since it was last queued: it became available or unavailable, or its ETag
  differs, or, without one, a hash of its JSON does. The library's lists are
  read with the last ETag in `If-None-Match`; Decaid's 304 sends nothing.
  While disconnected it does not poll.
- It reads the machine's own settings (`machineSettings`, `advancedSettings`
  and `machineCalibration`) on their own interval, 60 s from the end of their
  last read, or the poll interval where that is longer, as Decaid answers them
  by reading the machine (below). Nothing needs them fresher: the server only stores them,
  and a Machine's page in the management interface loads them every 30 s.
  While connected it also reads them at once after a `workflowUpdated` whose
  steam, hot water or flush settings (`steamSettings`, `hotWaterData` or
  `rinseData`, `MACHINE_SETTING_PARTS`) differ from the last Workflow's, as
  after a Loaded Recipe's write or a barista's change on the tablet: Decaid
  writes those parts to the machine, and reports the Workflow only once the
  machine holds them (`AI_RUNTIME_NOTES.md`). The first Workflow after the
  plugin loads is compared with nothing, as the welcome's read covers it. A
  change made outside the Workflow, as Streamline's settings page makes with
  `POST /machine/settings`, reaches the server by their next interval.
- On every `welcome`, it reads every collection again, without
  `If-None-Match`, and sends each, unavailable ones included, whether or not it
  changed. That also covers whatever changed while it was disconnected. It
  does the same when the server sends `requestCollections`, as it does when
  the Machine's Location changes, after sending its latest Workflow again
  (`LIBRARY.md`, Joining a Location). Either counts as a read of the
  machine's own settings for their interval.
- It reads the sensor calibration (`sensorCalibration`) on those full
  reads, on every `welcome` and `requestCollections`, and once a day while
  connected, a day after the end of the latest of those reads, sending it
  then only if it changed (#432): never on a poll, on the machine settings'
  interval or after a Workflow change. Its three reads each go to the
  machine (below), and its values change only through a deliberate
  calibration (`PUT` on the same route), so a recalibration on the Tablet
  reaches the server within a day, or at its next reconnect or
  `requestCollections` if sooner, for the Machine's Settings History. A day
  that ends while the plugin is disconnected waits for the next `welcome`,
  which reads it.
- It reads the machine's own settings and its sensor calibration only while
  the machine runs nothing (`plugin/src/machine-activity.ts`, #403): the
  latest state Decaid reported in `stateUpdate` is one of
  `SETTINGS_EDIT_STATES` (`idle`, `schedIdle`, `sleeping`, `needsWater`), the
  states a Settings Edit goes ahead in, and no Shot is yet to be stored
  (`ShotGate.running`), so a Shot that left `espresso` but isn't stored yet
  still counts. Before the first state update after the plugin loads, the
  machine runs nothing. A read of them that falls due while it runs something,
  on their interval, after a Workflow change or in a full read, waits, and the
  rest of its pass, DYE2's recipes, the server's Library writes and Settings
  Edits go on. The reads waiting make one read of each, which runs as soon as
  the machine next runs nothing, without waiting for their interval, and sends
  them whatever they hold where a full read was among them. A pass checks as
  it reaches each of them, so a Shot started mid-pass stops the reads not yet
  begun; the read under way finishes, as Decaid can't cancel it. Their
  interval still runs from the end of their latest read. A machine left in
  another state, such as `heating`, `error` or `fwUpgrade`, keeps them waiting
  for as long as it stays there, and the server keeps the values it took, as
  Settings Edits are refused then too. A machine that disconnects keeps the
  state it last reported, as Decaid sends no update as it goes. On Bluetooth,
  Decaid v0.9.1 drops a machine that leaves a read unanswered
  (`AI_RUNTIME_NOTES.md`), which mid-Shot lost a Shot.
- Whenever it sends the beans, it sends the bean batches in full after them,
  changed or not, as the server takes in a batch only once it knows the
  batch's bean (`LIBRARY.md`). The library's lists the server writes to (the
  beans, bean batches, grinders and profiles, and DYE2's baskets, equipment
  and recipes) are read, and queued, between
  the server's writes to the tablet, never during one.
- A newer delivery of a collection drops an older one still queued, unless
  the older one was ever handed to a connection. Such a delivery may still be
  being stored by the instance that received it, so it is sent again, under
  its id, ahead of the newer one; the server then finds it handled, or waits
  for it, and the newer value always lands last. A report that a collection
  became unavailable never drops a value queued before it: that value goes
  first, and the server keeps it.

Decaid's plugin `fetch` passes request headers and gives response headers
through `headers.get` (`PluginManager` in
`decaid:lib/src/plugins/plugin_manager.dart`). Decaid answers the machine and
advanced settings and the flow calibration by reading them from the machine's
memory over its Bluetooth or USB connection (`UnifiedDe1`), eight requests
each time for a DE1 on Decaid v0.9.2, which reads its values in groups
(`getCoalescedMachineSettings`), where v0.9.1 made fourteen, one for each
value, on the link the scale also uses, which is why the plugin reads them
less often than the rest, and only while the machine runs nothing. Only the
advanced settings' `heaterVoltage` and
`refillKitSetting` are what Decaid holds rather than reads: the voltage it read
as the machine connected, and the refill kit setting it last wrote, each until
written through Decaid. As the machine connects, Decaid writes the refill kit
setting last written through its API for that Machine, which it keeps, or
`auto` where none was, and the flow multiplier last written through its API
for that Machine, or none where none was (ADR-0023).

`machineCalibration` is the machine's flow estimation multiplier, Decaid's
`flowMultiplier` (the DE1's `calFlowEst`, read and written in thousandths),
which scales the flow the machine reports, and which each Shot records as
`workflow.machine.flowCalibration`. The Machine page shows the settings
fields, other than the sensor calibrations (below), to five decimal places
at most, so a change of a thousandth shows.
Decaid writes it truncated to the thousandth (`_writeMMRScaled`), which
writes 12 of the thousandths from 0.13 to 2.0 a thousandth lower, such as
1.001 as 1.000. The DE1's firmware then holds some lower still: the test
DE1Pro (firmware 1358) held 1.004 and 1.005 as 1.003, 1.012 and 1.013 as
1.011, and 0.251 as 0.25
(`server/test/fixtures/decaid/de1pro-v0.9.0/calibration-writes.json`). Its
reads fit a register kept as the float32 of the thousandths over 1000 and
answered as that times 1000 in float32, truncated, as the simulated tablet
holds it, which holds eight more of those thousandths a thousandth lower
(0.251, 0.253, 0.502, 0.506, 0.511, 1.004, 1.012 and 1.022) and three of
Decaid's 12 two lower (1.005, 1.013 and 1.023). An edit to one the Machine
holds lower is answered Stored otherwise.
Decaid keeps a flow multiplier written through `POST
/api/v1/machine/calibration` for that Machine, as it was asked for, and
writes it again each time the Machine connects; its reset of the Machine's
settings leaves it (ADR-0023;
`server/test/fixtures/decaid/simulated-devices-v0.9.2/`). So an edit lasts,
and one set from elsewhere since, such as on another Tablet or in de1app,
lasts only until this Tablet next connects, which the field's note says.
Something other than a person may change it, such as an auto flow calibration
plugin rewriting it per profile; a change reaches the server by the
collection's next interval. Streamline's calibration page edits it too, from
v0.2.23 (`0cb60bb`), through `POST /api/v1/machine/calibration`, the route
the Flow calibration Settings Edit uses, and only as a barista changes it
there: its ± buttons step it by 0.01, and it rounds what is typed to 0.01,
within 0.13 to 2.0 (`clampFlowMultiplier` and `FLOW_MULTIPLIER_STEP` in
`streamline-js:src/modules/sensor-cal.js`), where the field takes a
thousandth. Opening the page writes nothing, so a value set here between two
of its steps stands until a barista changes it there. The `volumeFlowMultiplier`,
`hotWaterFlowMultiplier` and `weightFlowMultiplier` in `appSettings` are not
calibration but Decaid's lookahead times, in seconds, for stopping at a volume
or weight (`ShotSequencer`, `HotWaterSequencer`), labelled the look-aheads.

`sensorCalibration` is the firmware's own calibration of the machine's flow,
pressure and temperature sensors, separate from the flow estimation
multiplier: the corrections the machine applies to what each sensor reads, as
they are now. Comparing them across Machines helps when two at a Location
report different pressure or temperature for the same Recipe. Decaid answers
each target by a request over the machine's A012 calibration characteristic
(`UnifiedDe1.readCalibration`), on the link the scale also uses, and keeps no
copy. The plugin reports Decaid's three answers as sent, by target:

```json
{
  "flow": { "target": "flow", "source": "current", "de1ReportedValue": 1.0, "measuredValue": 1.0 },
  "pressure": { ... },
  "temperature": { ... }
}
```

It leaves out the factory calibration (`?source=factory`): the DE1's
firmware answers that read with the current calibration. On 2026-10-24, on
the test tablet's DE1Pro with firmware 1358 under Decaid 0.9.0, all six
reads (three targets, `current` and `factory`) agreed; after moving the
temperature calibration by 0.5 °C (Decaid's read-then-write), the `factory`
read moved with it, and it moved back when the value was restored. Decaid
takes only a reply tagged as a factory read for that target
(`UnifiedDe1Calibration._calibrationRequest`), so the firmware itself tags
its current calibration as factory. Streamline's settings page reads no
factory values for the same reason, reasoned for firmware 1357 rather than
measured (the comment above `SENSOR_CAL_PREV_KEY` in
`streamline-js:src/settings/settings.js`), and shows the value from before its
own last write instead. A reset reaches no factory value either. On the same
day and machine, the calibration characteristic's reset command (2), which
de1app's `de1_send_calibration` calls a reset to factory settings and
Decaid's API never sends, was sent for the temperature target through
Decaid's raw machine WebSocket. The machine acknowledged it and changed
nothing, both at the original value and after the value was moved by 0.5 °C,
and no other machine setting changed. Other firmware versions are untested.

The calibration is always in `measuredValue`. For `flow` and `pressure`,
which are ratiometric, `de1ReportedValue` is 1.0; for `temperature`, an
offset, it is 0.0 (`rest_v1.yml`). The machine keeps each in signed Q16.16,
seldom on the field's step: the test DE1Pro reports 1.100006103515625,
1.293609619140625 and −2.899993896484375. So the Machine page shows each
rounded to its field's step, 0.0001 for a multiplier and 0.01 °C for the
offset, as Streamline's Sensor Calibration page does, in the Settings card,
an edit's status and the Settings Edits log alike (ticket
[#272](https://github.com/loganfuller/decent-sync/issues/272)); its form
opens on the value as it is. Two values the machine can hold may then look
the same, and an off-step value can't be set back exactly: the form takes
only values on the field's step, each of which the machine then holds to
within 1/65536.
Decaid answers 500 while no machine was ever connected, 503 if the machine
disconnects mid-read, and 504 if it doesn't answer in time.

## Plugins and Skins

Ticket [#236](https://github.com/loganfuller/decent-sync/issues/236) reports
the DYE2 and Streamline on each tablet, which the Machine page's Hardware and
software card shows. Those two rows are only shown: nothing is refused at
`hello` or flagged below ADR-0017's minimums. Ticket
[#660](https://github.com/loganfuller/decent-sync/issues/660) shows every
plugin and Skin, with Decaid, as the Machine's Tablet Software, and has an
Admin manage the plugins through Software Actions (below). Ticket
[#661](https://github.com/loganfuller/decent-sync/issues/661) adds the
Skins, Reload and the restart of the Skin view, and the start of Decaid's
update.

`plugins` is Decaid's plugin list as sent: each plugin's manifest with
`loaded`, `autoLoad`, `source` (how it was installed, such as
`{"kind":"github_branch","branch":"dist",…}`, or null for a bundled one)
and `pendingUpdate` (`PluginsHandler` in
`decaid:lib/src/services/webserver/plugins_handler.dart`). `skins` is
Decaid's Skins as `{ skins, default, server }`: the Skins list, the default
Skin and the WebUI server's status, each as sent. With no Skin installed,
Decaid has no default and answers its read 404, so the plugin reads it only
when the list holds a Skin, and reports `default` null otherwise. Both are
read on every poll, as the other collections are, and sent when they
changed, so a DYE2 update or disable, or a Skin switch, reaches the server at
the next poll. Neither carries an ETag. A plugin's `source.lastChecked` moves
with each of Decaid's update checks, and Decaid replaces its bundled Skins
with their latest releases in the background after it starts, each a change
sent as any other.

The server works out the two rows from the latest value of each, kept while
a later read is unavailable (`server/src/collections/tablet-versions.ts`,
module tests in `server/test/tablet-versions.test.ts`):

- **DYE2** is the `dye2.reaplugin` entry of the plugin list: its manifest
  `version`, whether it is `loaded` (not when disabled, or when it failed to
  load) and, when its `source` is a branch install (`kind`
  `github_branch`), the branch. A branch build carries the version committed
  on the branch, which lags DYE2's tags; only release builds have their
  version stamped from the tag. Not installed when the list has no such
  entry.
- **Streamline** counts only as the active Skin: the one whose `path` is
  the WebUI server status's `path`, or, when none is (Decaid serves nothing,
  or a folder no Skin holds), the default Skin. Quick Settings can serve a
  Skin other than `defaultSkinId`, which is why the default alone is not
  enough. Streamline is the active Skin when its id is `streamline.js`, a
  release, or `streamline.js-dist`, a build of `main` (its `dist` branch),
  whatever else is installed. So is
  [Streamline Cafe](https://github.com/loganfuller/streamline-cafe-js), a
  Skin forked from Streamline that loads a recipe through Streamline's own
  apply, so that for everything Decent Sync follows it behaves as the
  Streamline version it contains: `streamline-cafe.js`, a release, or
  `streamline-cafe.js-dist`, a build of its `main`. The row gives its
  `version`, which it is and the Streamline version it is or contains;
  otherwise the active Skin's name and version, or not installed when no
  Skin is any of the four ids. A build of Streamline's `main` reports a
  version of its own: the latest release's, with `-dev`, its commit and the
  number of the run that built it, such as `0.2.21-dev.c568255.686` for the
  deploy of v0.2.21 (from streamline-js `800a521`,
  `server/test/fixtures/decaid/dye2-v0.1.33/skins.json`), which the row shows
  as it is, with "main build". Streamline Cafe's version is the Streamline
  version it contains, `-cafe.` and a counter that restarts with each
  Streamline release it adopts, such as `0.2.31-cafe.1`, and a build of its
  `main` adds `.dev.`, the run's number and its commit, such as
  `0.2.31-cafe.1.dev.12.a1b2c3d`. The row shows it as "Streamline Cafe
  0.2.31-cafe.1 (release), built on Streamline 0.2.31"; a Streamline Cafe
  version not of that form is shown as reported, with no Streamline version.

Neither row is anything until its collection is reported. The recording in
`server/test/fixtures/decaid/plugins-and-skins-v0.9.0/` shows Decaid's answers
to each change; `AI_RUNTIME_NOTES.md` (Skins) has the routes.

Two more collections go with the plugins (#660). `pluginSettings` holds the
settings of each plugin in the list that declares any, by the plugin's id,
each as `{ declared, values }`: `values` as Decaid's `GET
/plugins/{id}/settings` answers, the settings that were set, without
defaults, a `secure` one only as `{ "isSet": true|false }`, never its value;
and `declared`, the names of the settings its manifest declares, in the
manifest's order, which the settings form shows them in, as the server keeps
the plugin list as JSON whose keys PostgreSQL does not keep in order. It is
read after the plugin list, on every poll, one plugin at a time. `decaidUpdate` is Decaid's own update state as `GET /update`
answers it: `{ phase, currentVersion, latestVersion, releaseNotes,
releaseUrl, installable, progress, error }`. Both are read, with the plugin
list, in Software Actions' own queue (a `SettingsAccess` apart from the
Settings Edits'), so a report of one either holds each action begun before
it or is queued before that action's read-back. A poll skips the three while
an action runs, which may wait minutes on Decaid, so the rest of the poll,
DYE2's recipes and the Library lists included, is never held up by one: the
action's read-back reports them, and the next poll, in full where the
skipped read was a full one. The Skins (`skins`) are read in that queue
too, for the actions on them (#661).

`skinPage` is the page a Skin last reported it shows, as `{ skinId, version,
loadedAt, reportedAt }` (`SkinPage` in `protocol/src/software-actions.ts`):
what a Skin's author has it PUT to the plugin's `page` endpoint each time
its page loads and each time its socket on `changes` opens (`PLUGIN.md`,
Reporting the page), `loadedAt` as the Skin gave it and `reportedAt` when
the plugin heard it, both by the tablet's clock. The plugin holds it for its
load, reports it as each arrives and on each full read, and reports it
unavailable until a Skin reports one in that load, so the server keeps the
page an earlier load heard of. It is no part of the Settings History, as it
changes with each load of the page.

### Tablet Software

A Machine's Tablet Software (`GLOSSARY.md`) is worked out by the server from
the latest `plugins`, `pluginSettings`, `skins`, `decaidUpdate` and
`appSettings` its tablet reported, each kept while a later read is
unavailable (`server/src/software-actions/tablet-software.ts`, module tests
in `server/test/tablet-software.test.ts` on the recorded lists):

- **Decaid**: its release and build, from the `fullVersion` its tablet's
  latest `hello` gave; its update state (`phase`, `latestVersion`,
  `installable`, `error`, and when it was reported), null until reported;
  and the Tablet's `automaticUpdateCheck`.
- **Each plugin**: its id, name, version and permissions; `enabled` where
  `loaded`, `disabled` where `autoLoad` is false, and otherwise `notLoaded`,
  as while it updates or where it failed to load; how it updates; the
  latest update check's `lastError`; any `pendingUpdate`, with its version
  and the permissions it adds; whether it is Decent Sync's own
  (`decent-sync.reaplugin`); and each setting its manifest declares, in its
  order: its `type` read as `text`, `number` (`number`), `switch`
  (`boolean`) or `choice` (`enum`, with its `values`), a type Decaid adds
  later as text; its `label`, `description` and `default`; whether it is a
  secret (`secure`); whether a Software Action may change it, which of the
  plugin's own settings only `PollSeconds` may; and, to an Admin alone, what
  the Tablet holds: a value, null for one not set, or `{ isSet }` for a
  secret.
- **Each Skin**: its id, name and version, whether it is the default, and
  whether Decaid's Skin server is serving its folder now, and how it
  updates; whether an Admin may remove it (`removable`: neither the default
  nor one that comes with Decaid); and, for the one served, whether it has
  reported its page (`pageReported`), which Reload needs.
- **What the Tablet shows** (`showing`, #661), null until the Skins are
  reported: the Skin served now with the version installed; the page it
  reported, where the latest `skinPage` is that Skin's, with its version,
  `loadedAt` and `reportedAt`; whether a newer build is installed than the
  one showing (`newerInstalled`: both versions known and different); and
  the default Skin where it is not the one served (`nextDefault`), which
  shows once the Skin view restarts.
- **Whether its plugin must update**: its plugin's wire revision, as its
  latest `hello` gave it, is from before Software Actions.

How a plugin or Skin updates is worked out from where Decaid says it was
installed from, with no list of Decaid's ids, and is shown, never switched:
Decaid has one setting for update checks, Tablet-wide, and nothing per item
(ADR-0034).

| Decaid reports | Shown as (`how`) |
|---|---|
| A plugin whose `source.kind` is `github_release` | Follows releases (`followsReleases`), with its `repo` |
| A plugin from `github_branch` whose `branch` names a commit, 7 to 40 hexadecimal digits (`namesCommit`), as Decaid records an install of a commit, with the commit as both `branch` and `commit` | Pinned (`pinned`), with its `repo` and commit |
| A plugin from any other `github_branch` | Follows a branch (`followsBranch`), with its `repo` and `branch` |
| A plugin with no `source`, as a plugin Decaid bundles is until its first update check, or one from a zip or folder | Not updated (`notUpdated`) |
| A Skin Decaid flags `isBundled` | Comes with Decaid (`comesWithDecaid`): Decaid may put its latest release back as it starts |
| A Skin whose `reaMetadata.sourceUrl` is `github_release:<repo>@…` | Follows releases |
| A Skin whose `sourceUrl` is `github_branch:<repo>@<branch>` | Follows a branch |
| A Skin from an `http` or `https` URL with a segment of 40 hexadecimal digits, a commit's archive | Pinned, with its URL and commit |
| A Skin from any other URL | Follows its URL (`followsUrl`) |
| A Skin with no `sourceUrl` | Not updated |

## Software Actions

A Software Action (ADR-0034, `GLOSSARY.md`) is one thing an Admin asks a
Machine's Tablet to do to its plugins, its Skins or Decaid, or that Staff at
the Machine's Location ask of its Skin view, made in the management
interface and carried out at once by the plugin on the Tablet whose
connection holds the Machine, through Decaid's own routes. As with a Settings
Edit, nothing holds what the Tablet should run afterwards: its software is
whatever it next reports, and a change made on the Tablet later stands.
Ticket [#660](https://github.com/loganfuller/decent-sync/issues/660) builds
the kinds that act on plugins and on Decaid's own update check
(`SOFTWARE_ACTION_KINDS` in `protocol/src/software-actions.ts`):

- `installPlugin`: installs a plugin from a GitHub repository, `owner/name`,
  its latest release, or the head of a `branch`, or a commit given as the
  branch, which never moves and so is Pinned. Decaid installs by no release
  tag (decentespresso/decaid#1030). A plugin newly installed is not enabled;
- `enablePlugin`, `disablePlugin`: loads a plugin and has Decaid load it as
  it starts, or neither;
- `changePluginSettings`: saves some of a plugin's settings, which makes
  Decaid load that plugin again;
- `checkPluginUpdates`: has Decaid check every plugin it updates, those with
  a `github_release` or `github_branch` source, installing each update it
  finds unless the update adds a permission, which then waits;
- `approvePluginUpdate`: installs a plugin's update that waits, the one shown;
- `removePlugin`: removes a plugin with its settings. One Decaid bundles is
  back after Decaid next starts;
- `checkDecaidUpdate`: has Decaid check for a newer release of itself.

Ticket [#661](https://github.com/loganfuller/decent-sync/issues/661) adds
the kinds that act on Skins, on the Skin view and on Decaid's own update:

- `installSkin`: installs a Skin from a GitHub repository's latest release,
  or the head of a `branch`, or from a `url` serving a zip, such as a
  commit's archive (`https://github.com/<repo>/archive/<commit>.zip`),
  which is Pinned. Decaid fails a commit given as a Skin's branch, as it
  downloads `archive/refs/heads/<branch>.zip` (recorded in
  `server/test/fixtures/decaid/tablet-software-v0.9.3/skin-management.json`),
  so the server refuses one with 400 naming the archive's URL. A Skin's id
  is the one its own `skin-manifest.json` gives, whatever it was installed
  from, so a `dist` build installs beside the release rather than over it;
- `chooseDefaultSkin`: makes a Skin the default (`PUT /webui/skins/default`),
  which changes nothing on screen until the Skin view restarts;
- `checkSkinUpdates`: has Decaid check every Skin it updates for a newer
  build now, with a result for each (`POST /webui/skins/update`), a Skin
  Decaid comes with named by its repository, any other by its id. Where
  Decaid stops waiting on the call after its minute, the check goes on, and
  the plugin asks again, which joins it and answers with its results
  (`checkForSkinUpdates`); not confirmed where that times out too;
- `removeSkin`: removes a Skin that is neither the default nor one Decaid
  comes with. Decaid refuses the second (403) but removes the default as
  any other, and its server then serves a folder that is gone, so the
  plugin refuses that itself;
- `reloadSkin`: pushes `{"what":"reload"}` on the plugin's `changes`
  socket, and is done once a page of the same Skin with a later `loadedAt` reports in within
  `SKIN_RELOAD_MS` (15 s), with that page; otherwise the plugin answers it
  as not confirmed, saying so (`note`);
- `restartSkinView`: `POST /webui/server/stop` then `/webui/server/start`,
  which has Decaid build its Skin view again on the default Skin (#659's
  trial), then reads `GET /webui/server/status` every 0.5 s for up to 5 s
  until it serves; where it does not, it starts it once more, and refuses
  the action as `noSkinServed` where the Tablet is left serving no Skin;
- `startDecaidUpdate`: sends `{"command":"install"}` on Decaid's update
  socket once it has sent the state it opens with, and is done at Decaid's
  second `installing`, which it sends once Android's installer opens (the
  first comes before it checks the download and launches the installer),
  where someone at the Tablet must tap Open; Decaid does not reopen by
  itself (#659). Refused as `installNotPermitted` where Decaid answers
  `local_approval_required`, as Android's permission for it to install apps
  was not granted at the Tablet, and as `decaid` where it is checking,
  downloading or installing already (it ignores the command then, saying
  nothing), found no update, did not open the installer, failed, or does
  not install itself, as on Linux.

How each is made, carried out and answered:

- **Made through REST.** `POST /api/machines/:id/software-actions` takes `{
  kind, ... }`: for `installPlugin`, `repo` and `branch`, null or absent for
  the latest release; for the kinds that act on one plugin, its `pluginId`;
  for `approvePluginUpdate`, also the `version` and `addedPermissions` of the
  update shown; for `installSkin`, `repo` and `branch` or a `url`; for
  `chooseDefaultSkin` and `removeSkin`, its `skinId`; for `changePluginSettings`, `values`, each setting changed
  by its name with its new value, null clearing one, and `expected`, each of
  those settings as the page showed it: a value, null for one not set, or `{
  "isSet": true|false }` for a secret. Only an Admin makes one, as most can
  put code on the Tablet, but that Staff at the Machine's Location may make
  `reloadSkin` and `restartSkinView` (`SKIN_VIEW_KINDS`), which install
  nothing: anyone else is refused with 403, Staff elsewhere with "You can
  reload or restart the Skin only of a Machine at a Location you work at",
  and Viewers change nothing. It is refused at once, with nothing kept: 400 for a body of the
  wrong shape, a setting the plugin's manifest declares none of, a value not
  of the setting's type, or disabling, removing or changing any but the poll
  interval of Decent Sync's own plugin, which the plugin refuses too; 409
  while the Machine is offline, as its status judges it, while its
  connection's Tablet reports another machine's hardware, while its plugin
  is from before `SOFTWARE_ACTIONS_WIRE_REVISION` ("The Tablet's plugin must
  update before it takes a Software Action", ADR-0025), for a plugin the
  Tablet's latest list does not hold, or for an approval of an update other
  than the one that waits now; 400 for removing the default Skin or one
  Decaid comes with; 409 for a Skin the Tablet's latest list does not hold,
  for Reload while the Skin served has not reported its page, and for
  starting Decaid's update while its latest reported state offers none it
  can install (`latestVersion` and `installable`). No refusal repeats a setting's value. It
  answers 201 with `{ softwareAction }`, its outcome pending (null). `GET
  /api/machines/:id/software-actions/:actionId` reads one, which the page
  reads until it has an outcome, and `GET /api/machines/:id/software-actions`
  lists the Machine's actions, newest first, paged by `limit` and `offset`,
  as `{ softwareActions, total, limit, offset }`: both are marked for Staff,
  so Staff and Viewers read them. Each action is `{ id, machineId, kind,
  params, account, connectedApp, madeAt, sentAt, answeredAt, outcome, note,
  late, refusal, result }`: `params` what it named, the plugin or Skin as `{
  id, name }`, with its name as the Tablet reported it then, the `repo` and
  `branch` or `url`, the offered `version` of Decaid's update started, the
  update's `version` and `addedPermissions`, and for a settings change the
  names of the settings changed (`settings`), never their values; `account`
  named to Admins and to others by its id only, and `connectedApp` as a
  Settings Edit's.
- **Kept and sent** (`server/src/software-actions/`, ADR-0016), as a Settings
  Edit is. An action is a row of `software_actions`, inserted with the
  Machine's row locked, which also judges it online, naming the connection
  and tablet holding it then, with its time (`softwareActionMs`): 2 minutes
  for an install, an update check, of the plugins, the Skins or Decaid, an
  approval, which installs, and the start of Decaid's update, which
  downloads it, and 1 minute for the rest. It is announced with `NOTIFY
  software_actions` in the same transaction. The instance holding that
  connection claims it with the row locked again, while the connection still
  holds the Machine and its plugin is at the revision, by setting when it was
  sent, and sends it as `softwareAction` with the time it has left by
  PostgreSQL's clock; one with none left is never sent. A connection looks for
  its actions once welcomed, and every connection after its instance listens
  anew. A later connection, even from the same Tablet, sends nothing made for
  an earlier one: an action is never queued.
- **A settings change's values** are held in the row apart from what is
  shown (`software_actions.held`), only until the action is claimed, by the
  same statement that claims it, or is no longer awaited: removed a second
  after its time by a timer of every instance that hears it was made, the
  one that made it included, by every instance as it starts and again once
  any action made before it started is past its time, and before it makes
  or lists an action of that Machine, so none outlives its action whatever
  instance stops. No response, log line or notification holds one. A value
  removed is gone from the row, not from PostgreSQL's own history of it
  until that is cleared: its dead row versions until a vacuum, its
  write-ahead log, and any backup taken meanwhile.
- **Carried out** (`plugin/src/software-actions.ts`), one at a time in the
  order received, in a queue of their own that the reads of the software
  collections share (`SettingsAccess`), apart from the Settings Edits'. The plugin counts down
  `timeLeftMs` as it does a Settings Edit's, and refuses an action as
  `expired`, asking nothing of Decaid, once the connection that sent it has
  closed, or where it would start with less than
  `SOFTWARE_ACTION_START_MARGIN_MS` (15 s) left, judged as its turn comes and
  again just before Decaid is asked. An install Decaid has started can still
  finish later, as Decaid answers it only once it is done. One waiting its
  turn as the plugin unloads is dropped unanswered. For each action the
  plugin:
  1. refuses as `notAllowed`, whatever it is sent, what its own protections
     forbid: disabling or removing itself, and changing any of its own
     settings but `PollSeconds`, as its server address and Token are its
     connection to the server; and, once it has read the Skins (step 3),
     removing the default Skin;
  2. reads `GET /machine/state`, going ahead only in a state a Settings Edit
     goes ahead in (`SETTINGS_EDIT_STATES`), or where no machine is connected
     to the Tablet, and otherwise refusing it as `machineBusy`, naming the
     state. `checkDecaidUpdate` skips this, as Decaid's check touches neither
     the Machine nor the Skin; Reload and the restart do not, so neither
     runs while a Shot is pulled, or the Machine steams, flushes or pours
     water;
  3. reads the plugin list and the plugins' settings, reports them if they
     changed, and refuses the action as `changedSince`, in words, where what
     it was made over no longer holds: the plugin it names is gone, another
     update waits than the one shown, or none, or a setting it changes holds
     another value than the form showed, a secret compared by whether it is
     set; for an action on the Skins, it reads them instead, and refuses as
     `changedSince` where the Skin it names is gone, or, for Reload, where
     the Skin served is not the one whose page it last heard;
  4. asks Decaid through `host.localApi` (`manage` in `plugin/src/decaid.ts`):
     `POST /plugins/install/github-release` or `/install/github-branch`,
     `POST /plugins/{id}/enable` or `/disable`, `POST /plugins/{id}/settings`
     with the values, `POST /plugins/update`, `POST
     /plugins/{id}/update/approve` or `DELETE /plugins/{id}`; or, for
     `checkDecaidUpdate`, sends `{"command":"check"}` on Decaid's update
     socket (`/ws/v1/update`) and waits, up to 45 s, for its state to leave
     `checking`; for the Skin kinds, the routes above, through `host.localApi`
     too; for `startDecaidUpdate`, `{"command":"install"}` on the update
     socket, waiting up to 95 s;
  5. whether Decaid took it or not, reads the lists again and queues each as
     a `collection` delivery naming the action (`softwareActionId`): the
     plugin list and the plugins' settings, the Skins for an action on
     them, or Decaid's update state for one on it; then queues its answer,
     `softwareActed`, behind them.
- **Outcomes.** `done`, with a `result`: the plugin it acted on, by its id
  and the name the Tablet listed it under, its version afterwards and
  whether it was loaded; for `checkPluginUpdates`, a result
  for each plugin Decaid checked (`item`, `status`: `updated`,
  `alreadyCurrent`, `pendingApproval` or `failed`, with Decaid's `error`,
  and the version installed afterwards); for `checkDecaidUpdate`, Decaid's
  update state without its release notes, refused as `decaid` where the
  check left it in `error`; for a Skin installed, made the default or
  removed, the Skin by `skinId`, name and version, and for the restart the
  one served afterwards; for `checkSkinUpdates`, a result for each Skin; for
  Reload, the fresh `page`; for `startDecaidUpdate`, Decaid's update state.
  Or `refused`, with a reason: `machineBusy`, with the state;
  `changedSince`, `notAllowed`, `installNotPermitted` or `noSkinServed`,
  with the plugin's or Decaid's words; `expired`; or `decaid`, with
  Decaid's HTTP status, null where it did not answer or was not asked, and
  its words. Or not confirmed: unanswered in its time (below), or answered
  so by the plugin, `outcome: "notConfirmed"` with its words as `note`, as
  for a Reload whose fresh page never reported in.
- **When Decaid loads the plugin again.** Decaid unloads a plugin to install
  its update or save its settings, and the call that asked is never answered
  to it. So before an action that may do that to the plugin itself, any
  install or update check, an approval of its own update and a change of its
  own poll interval, the plugin keeps it in Decaid's plugin storage (key
  `softwareAction`: its id, kind, what it named, and each plugin's version,
  build and install time before, never a setting's value). A plugin's build
  is its version with the commit or release it came from, as a branch's new
  commit may keep the version. Its next load answers it first, within 10
  minutes, from the plugin list it then reads, read again every 3 s for up
  to 30 s, as Decaid writes where a plugin came from and clears an update
  that waited only once it has loaded the new build and settled its
  notification permission (`resume`, `watch` and `settled`): an approval of
  its own update is done once no update waits and its build changed; an
  install, once a plugin from the repository and branch asked for was
  installed since; an update check, once its own build changed and Decaid
  gives the check's results, asked for again with `POST /plugins/update`,
  which Decaid answers with the check still under way (it goes on to the
  plugins after this one) or, where it ended, with a new one's, each plugin
  `updated` where its build changed since; and a change of its poll interval
  once it was loaded again with the value asked for, as Decaid saves the
  settings before it loads the plugin again.
  One it can't tell the outcome of by then is left unanswered, and so not
  confirmed.
- **When Decaid stops waiting.** `host.localApi` rejects a call after a
  minute (`localApiTimeout`) while Decaid goes on with it, so a slow install
  or update check is not refused for that: the plugin reads the lists again
  every 3 s, the same way, until what came of it shows or the action's time
  is up, and otherwise leaves it unanswered, kept for the plugin's next load
  where it was kept.
- **Not confirmed.** An action still unanswered is `notConfirmed` once its
  time has passed since it was made, or where it was never sent and its
  connection no longer holds the Machine, so that it never will be. Unlike a
  Settings Edit, one that was sent stays awaited for its whole time though
  its connection closed, as an action that has Decaid load the plugin again
  is answered on the next connection. Every instance judges it from the
  database by PostgreSQL's clock whenever it is read; nothing marks it.
- **Answered.** Whichever instance the answer reaches, on the connection it
  was sent on or a later one, records it for that Machine's action still
  unanswered and acknowledges it. An answer arriving once the action was not
  confirmed replaces the mark, marked `late`, but for an `expired` refusal,
  which leaves it not confirmed. The plugin drops an answer that would go to
  a server from before `SOFTWARE_ACTIONS_WIRE_REVISION`, as that server
  closes the connection on a message it does not know, and the action stays
  not confirmed.
- **Settings History.** The read-back's changes are tied to the action: as
  it follows a read of the same lists just before Decaid was asked, every
  field it changes is the action's (Settings History, below).
- **Through an assistant** (ADR-0026). `get_machine_software` gives a
  Machine's Tablet Software as `GET /api/machines/:id/tablet-software` does,
  and `list_software_actions` its actions as the list above does, times in
  the zone of the Location the Machine was at, with `showing`. One tool
  makes a Software Action, `reload_skin`, marked as changing: `how` is
  `reload` or `restart`, made through the same service as the REST route,
  so with the same limits, Staff's Location among them, and recorded as the
  account's through its Connected App. No other: installing code on a
  Tablet is no assistant's to do (ADR-0034).
- **The Software tab.** The Machine page's fifth tab, between Settings and
  Setup, shows the Machine's Tablet Software: a Decaid card, with its
  version, the update it offers, Check now, and the automatic update checks,
  which an Admin turns on or off there as a Settings Edit, with the notes
  that Decaid follows a change when it next starts and that nothing on the
  Tablet updates by itself while they are off, and, where Decaid offers an
  update it can install, Start the update on the Tablet; a Plugins table; a
  Skins table, with the strip of what the Tablet shows above it, Reload
  where the Skin served reported its page and Restart the Skin view behind a
  confirmation always; and a Software Actions log, which starts collapsed.
  Staff at the Machine's Location are offered Reload and the restart, and
  nothing else. With
  the automatic update checks off, the tab says so above the lists. Where
  the Tablet's plugin is from before Software Actions, it says the plugin
  must update. The Setup tab keeps the firmware version and links to it.

`server/test/software-actions.test.ts` covers this through Seam 1, with the
built plugin on two instances sharing PostgreSQL and a simulated Decaid
managing its plugins as v0.9.3 does
(`server/test/support/decaid-plugins.ts`),
`server/test/software-action-deadline.test.ts` the times, actions never
sent, unloads, the plugin's own protections and the actions answered after
it loads again, `server/test/skin-actions.test.ts` the Skin kinds, Reload,
the restart and Decaid's update with a simulated Decaid managing its Skins
as v0.9.3 does (`server/test/support/decaid-skins.ts`),
`server/test/assistant-software.test.ts` the three tools,
`protocol/test/software-actions.test.ts` the messages, and
`server/test/latest-release/mixed-versions.test.ts` the previous release's
plugin beside this server.

## Server

`server/src/collections/collections.service.ts` stores the latest value of
each collection in `reported_collections`, one row per Machine (or Pending
Machine) and name. One of the Library's lists (`beans`, `beanBatches`,
`grinders`, `profiles`, `dye2Baskets`, `dye2Equipment` or `dye2Recipes`) from a connection
that is not mismatched, whose Machine takes part at a Location, is also taken
into the Library in the same transaction (`LIBRARY.md`):

- `available` and `reported_at`: whether the latest report had a value, and
  when it arrived, by PostgreSQL's clock.
- `value`, `received_at` and `items`: the latest value reported, as sent,
  when it arrived, and how many entries it lists if it is a list. An
  unavailable report keeps them.

Each delivery is handled once, by its delivery id, recorded in
`machine_event_deliveries` and kept for 90 days as Workflow deliveries are
(`docs/WORKFLOW-AND-STATE.md`), so a resend changes nothing. A resend after
that is stored as a new report, so at worst it puts back one stale value
until a later report with a value, such as the one its plugin reads on that
same `welcome`, replaces it. A collection belongs to the session's token's
Machine, or for a mismatched session to its reported hardware: the Machine
that has it, or else its Pending Machine (ADR-0015), locked before the
delivery's id is recorded, as `creditFirstDelivery` in
`server/src/machines/credit.ts` locks it. The token's
Machine therefore keeps what its own tablet last reported. Every way a
Machine takes over hardware hands its collections over with its records
(`transferPendingRecords`, through `transferPendingCollections` in
`server/src/collections/transfer.ts`): where the Machine has the same
collection, the later report says whether it is available, and the later
value received is kept.

Values are stored as jsonb, which keeps their content but not the order of
their keys, and compressed with lz4. The plugin sends every collection on
every `welcome`, changed or not, so a value equal to the one stored, as jsonb
compares them, is left as stored rather than written again: large ones, such
as profiles, would otherwise rewrite their TOAST data and WAL on every
reconnect. Its report time, received time and item count are recorded just as
for a changed value. jsonb counts numbers equal however they are written, so a
value that changes only `1.0` to `1` keeps the spelling stored.

## Settings History

Ticket [#432](https://github.com/loganfuller/decent-sync/issues/432) keeps
each Machine's Settings History (`GLOSSARY.md`): every value its tablet
reports for a collection other than the Library's lists
(`SETTINGS_HISTORY_COLLECTIONS` in `protocol/src/settings-history.ts`: the
Machine Settings, the Tablet Settings and presence settings, the plugins,
their settings and the Skins, the paired devices, the scale's information and
the sensors, but not Decaid's own update state, `decaidUpdate`, which changes
by itself with each check) that
differs from the one before it, whatever changed it, as a row of
`settings_history`, kept forever
(`server/src/collections/settings-history.ts`). A row holds the Machine, or
Pending Machine, the collection is credited to, the tablet whose connection
reported it, the value as sent, with the UTC offset sent beside it, when the
server received it (PostgreSQL's clock: for a report, the same time as the
latest value's `received_at`), and its source. Ticket
[#433](https://github.com/loganfuller/decent-sync/issues/433) reads it
(Reading the Settings History, below).

- **What counts as a change.** Values are compared field by field, through a
  projection that leaves out what something other than these settings sets,
  or what changes on its own (`settingsHistoryFields`): in
  `machineSettings`, the steam, hot water and flush settings, which the
  Workflow sets and whose changes are Workflow changes, the tank
  temperature, which each profile sets, and `usb`, which the charging mode
  switches (ADR-0023); `appSettings.chargingState`;
  `presenceSettings.keepAwakeUntil`; each paired device's `state`,
  `available` and `connectionRole`, how it is connected now (Decaid's
  inventory carries no battery level); `scaleInfo.batteryLevel`; and each
  plugin's `source.lastChecked` and `source.lastError`, which Decaid's update
  checks write, the error set by a check that fails, as while the Tablet is
  offline, and cleared by the next, and its `pendingUpdate.detectedAt`,
  written again by each check while an update waits for its new permissions
  to be approved. The wake schedules are compared one by one, by their ids, each as
  a wake schedule's Settings Edit names its fields; the sensor calibration by
  target, its `measuredValue`; the plugins, paired devices and sensors entry
  by entry, by their ids, in any order; the plugins' settings setting by
setting, each keyed `<plugin id>/<setting>` (`pluginSettingKey`), a secret
as Decaid reports it, whether it is set. A field absent counts as null, and an
  object's keys may come in any order, as `sameValue` judges an edit's
  expected values. The value stored stays whole. A report changed only in what
  is left out, or only in its UTC offset, records nothing, and neither does an
  unavailable report.
- **Baseline.** The first value of each Machine's collection is its
  baseline. Collections stored before the history was kept take theirs from
  the latest value stored, as and when it was received, and with no tablet,
  as none was stored: as the server starts and hourly, in batches in the
  background (`SettingsHistoryBaselines`), each under the lock a report's
  credit takes (the Machine's row, or a Pending Machine's hardware lock),
  skipping one another transaction holds; or as a report finds none yet,
  before comparing itself with it. A collection never stored takes its first
  report as its baseline.
- **Source.** A report naming a Settings Edit of its Machine and collection
  (`settingsEditId`), which the plugin sends only with an edit's read-back,
  labels the changes of the fields that edit set with it, whatever came of
  it: applied, adjusted or partly refused (`settings_edit_id`, and
  `edited_fields`, the fields as `settingsHistoryFields` keys them). A wake
  schedule's change or delete set the schedule it names; an add, the
  schedule new in the read-back that holds the fields it set, as Decaid gives
  its id only in the edit's answer, which follows the read-back. Any other
  field changed in the same report, and every change in a report naming no
  edit, or one of another Machine or collection, was made outside Decent
  Sync, and is tied to no person. A report naming a Software Action of its
  Machine (`softwareActionId`), which the plugin sends only with an action's
  read-back, labels every field it changed with that action
  (`settings_history.software_action_id`, and `edited_fields`), as the
  read-back follows a read of the same lists made just before Decaid was
  asked, so what changed between the two is what the action did.
- **Recorded once.** A report is compared with the latest row of its
  collection, the last written, in the transaction storing it, before the
  latest value is replaced, under the locks of its credit, so two instances
  never record one change twice, and a delivery handled before records
  nothing.
- **Pending Machines.** A Pending Machine's history moves, whole, to the
  Machine that takes over its hardware, with its collections
  (`transferPendingCollections`). Each row keeps its id and when its value was
  received, so where both reported a collection, its history holds both,
  interleaved. A history's order is the order its rows were written, by id,
  which a report is compared in. That is about the order their values were
  received, but for a report that waited for its Machine's lock behind a
  later one, which by its received time comes before it, and a baseline
  taken from a stored value, which keeps that value's time: a Pending
  Machine's baseline taken after the Machine's own rows sorts after them,
  though received before, until the next report.
- **Limits.** Times are when the server received a report. A change on the
  Tablet reaches it within about 30 to 60 s: at the next poll, or the machine
  settings' next read, later while the Machine runs something (Plugin,
  above); a sensor calibration change within a day. A change from outside
  Decent Sync is tied to no person. A previous release's server, beside this
  one during a deploy (ADR-0025), records no history: a change it stores is
  missed, though the next report this release stores is compared with the
  latest row, and a collection it alone stored takes its baseline from it;
  and a Machine it gives a Pending Machine's hardware to doesn't take the
  Pending Machine's history, which goes with it.
  A previous release's plugin names no edit, so its edits' read-backs are
  labelled as from outside, and so is an edit's change where the read-back
  itself failed, as an unavailable report names none, and the next poll
  reports the change.
- **Volume.** Estimated for #432 from Roux's Belmont on 2026-11-07, two
  DE1XXLs, at one to three rows per Machine on a usual day, each under 1 KB
  but the plugin list's 16 KB: the projection leaves out what changes
  through the day, the Tablet's battery, the charging switch, the
  Workflow's steam and flush settings, the wake schedules' keep-awake end,
  device connections and update checks. What remains is mostly a remembered
  scale the plugin leaves out of the paired devices while Decaid lists it
  `discovered`, for the few seconds between switching it on and connecting
  (Plugin, above), caught by a poll and put back by the next, which is
  folded as a brief change (below); on a Machine whose kept refill kit is not
  automatic, the refill kit Decaid shows on automatic after each reconnect
  of the machine and the value it keeps (ADR-0023); a plugin or Skin
  updated; and a deliberate change. A Bengle's sensors list its milk probe
  only while it is connected, so each of its drops adds two rows.

### Reading the Settings History

`SettingsHistoryService` (`server/src/collections/settings-history.service.ts`)
reads a Machine's history two ways, for the REST API and the MCP endpoint
alike (ADR-0026), and its changes a third way for the Machine's page, with
its Settings Edits:

- **Its changes,** newest first, worked out by `settingsHistoryChanges`
  (`protocol/src/settings-history.ts`) from each collection's values in the
  history's order, as written (Pending Machines, above): each value's fields
  changed from the value before it, as `settingsHistoryFields` keys and
  projects them, each `added`, `changed` or `removed`, with its value before
  and after as compared (null where absent). A wake schedule is `schedules/<id>`, the
  sensor calibration a target's `measuredValue`, and a plugin, paired device
  or sensor an entry by its id. A collection's first value, its baseline, is
  no change, and nor is a value with no field changed, as compared, from the
  one before it. A read-back's changes of the fields its Settings Edit set
  are one change, naming the edit and who made it, as a Settings Edit names
  them (an Admin sees the account's name, Staff and Viewers its id); the
  fields changed outside it are another, of the same id, naming none. A
  Software Action's read-back is one change naming the action, its kind and
  who made it. A plugin setting's values, before and after, are shown to
  Admins alone: to Staff and Viewers `{ "hidden": true }` stands in for a
  value, but for null and a secret's `{ isSet }`, as a plugin's settings may
  name an account on another service (`server/src/collections/plugin-settings.ts`).
- **Brief changes.** A field changed from outside Decent Sync and changed
  back to its value before, by its next change, also from outside, within
  `BRIEF_CHANGE_MS` (2 minutes), is a brief change: one change, its
  `backAt` saying when it changed back, and the change back left out. That
  covers the refill kit Decaid shows on automatic as the machine reconnects
  (ADR-0023) and a remembered scale left out while it connects. A change made
  or undone through a Settings Edit or a Software Action is never brief. Brief changes are left
  out unless asked for, a field at a time, so a change holding only brief
  ones is left out too. Each collection's whole history is read to work them
  out, and only then are those received in the range kept, so a brief change
  is folded wherever a range or page ends.
- **As of a time:** of each collection's values received at or before it,
  the last written, whole as sent, with when it was received; none before
  its first. A baseline taken from a stored value has that value's
  `received_at`, when it was last reported, not first, so a time before it
  gives none though the Machine held a value then. As the history keeps
  only reports with a value and their changes, what it compares none of,
  such as the Tablet's battery, may have changed since without being kept.
- **With its Settings Edits** (`withEdits`, ticket
  [#545](https://github.com/loganfuller/decent-sync/issues/545)): the
  changes above, each with the Settings Edit that made it whole, so with
  what came of it, and each of the Machine's Settings Edits that changed
  nothing, placed by when it was made. An edit changed nothing where no
  change of its collection names it: one still pending, refused or not
  confirmed, or one answered whose read-back held nothing new of the fields
  it set, as when the Machine put a value back. So an edit that made a
  change is listed once, as that change, whatever its outcome, a not
  confirmed one whose read-back still arrived included; and every edit is
  listed at least once while no filter leaves it out. The two lists are
  merged newest first, each keeping its own order, a change going before an
  edit made no later than the change was received. They are read in one
  repeatable-read transaction, so an edit whose read-back arrives meanwhile
  is a change or an edit that has changed nothing yet, never both or
  neither. `editsOnly` leaves out the changes made outside Decent Sync. An
  assistant has the same through `list_settings_history`, whose changes name
  their edit by its id, and `list_settings_edits`, which gives every edit
  with its outcome, so the MCP endpoint has no tool of its own for it.

## REST API

All endpoints require the account session, and answer 404 for an unknown
Machine. Pending Machines' collections are not exposed; they appear on the
Machine that takes their hardware over. Staff read them as Admins do, but
for the values of plugins' settings, which only Admins are shown: to anyone
else `pluginSettings` holds `{ "hidden": true }` in place of each value but
null and a secret's `{ isSet }`, in its latest value, as of a time, and in
the Settings History.

- `GET /api/machines/:id/collections` returns `{ collections }`, each reported
  collection's `{ name, available, reportedAt, receivedAt, items }`, without
  its value, in `COLLECTION_NAMES` order.
- `GET /api/machines/:id/collections/:name` returns `{ collection }`, the same
  with its `value`, or null until the Machine's tablet reports it. An unknown
  name answers 404. With `at`, a moment with its offset, a collection the
  Settings History keeps is given as last received at or before then, its
  `available` true and its `reportedAt` and `receivedAt` that value's, or
  null if none was received by then; a Library list answers 400.
- `GET /api/machines/:id/settings-history` returns `{ changes, total, limit,
  offset }`, the Machine's Settings History's changes newest first (Reading
  the Settings History, above), each `{ id, receivedAt, collection,
  settingsEdit, softwareAction, fields }`: `settingsEdit` is `{ id, account,
  connectedApp }`, or null for a change made outside Decent Sync or by a
  Software Action; `softwareAction` is `{ id, kind, account, connectedApp }`
  for a change a Software Action made, and null otherwise; and each field `{ field,
  change, before, after, backAt }`. It takes `collection`, once or more, each
  a collection the history keeps; `from`, included, and `to`, not, moments
  with their offsets, by when each change was received; `includeBrief`,
  `true` or `false` (the default); and `limit` (1 to 100, 20 if not given)
  and `offset`. Viewers read it too.
- `GET /api/machines/:id/settings-history/with-edits` returns `{ entries,
  total, limit, offset }`, the Settings History with the Machine's Settings
  Edits, newest first, as its page lists them (ticket
  [#545](https://github.com/loganfuller/decent-sync/issues/545); Reading the
  Settings History, above). Each entry is `{ at, collection, change,
  settingsEdit, softwareAction }`, `softwareAction` the whole Software Action
  that made a change, as `GET /api/machines/:id/software-actions/:actionId`
  gives it, or null. A change has `change: { id, fields }`, as the list above
  gives them, `at` when it was received, and `settingsEdit` the whole Settings
  Edit that made it, as `GET /api/machines/:id/settings-edits/:editId` gives
  it, so with its outcome, or null for a change made outside Decent Sync. A
  Settings Edit that changed nothing has `change: null` and `at` when it was
  made. It takes the list's `collection`, `from`, `to`, `includeBrief`,
  `limit` and `offset`, the times narrowing a change by when it was received
  and such an edit by when it was made, and `editsOnly`, `true` or `false`
  (the default), which leaves out the changes made outside Decent Sync.
  Viewers read it too.
- `GET /api/machines/:id/tablet-versions` returns `{ tabletVersions: { dye2,
  streamline } }` (Plugins and Skins, above), each with a `status`:
  `notReported` until its collection is reported, `notInstalled`, and for
  DYE2 `installed`, with its `version`, `loaded` and `branch` (null but for
  a branch install); for Streamline `active`, with its `skin`
  (`streamline` or `streamlineCafe`), `version`, `build` (`release` or
  `main`) and `streamlineVersion` (Streamline's own version, or the part of
  Streamline Cafe's before `-cafe.`, null for a version of neither form),
  or `notActive`, with the `activeSkin`'s `name` and `version`, or null if
  none is. Every field from Decaid's payload is null
  where it is missing or not a string.
- `GET /api/machines/:id/tablet-software` returns `{ tabletSoftware: {
  decaid, plugins, skins, showing, pluginMustUpdate } }` (Tablet Software, above):
  `decaid` as `{ version, build, update, automaticUpdateCheck }`; each
  plugin `{ id, name, version, state, updates, lastError, pendingUpdate,
  permissions, own, settings }`; each Skin `{ id, name, version, default,
  served, updates, removable, pageReported }`; `showing` as `{ skin, page,
  newerInstalled, nextDefault }`; `updates` as `{ how, ... }` with its `repo`, `branch`,
  `commit` or `url`; `plugins`, `skins` and `showing` null until reported. Everyone who
  reads the Machine reads it; a setting's `value` is given to Admins only.
- `GET /api/machines/:id/plugin-sources` returns `{ pluginSources }`, the
  distinct sources the plugins on the other Machines were installed from,
  which the install form suggests, most used first: each `{ pluginId, name,
  version, repo, branch, updates, machines }`, `branch` the branch or commit
  an install names, null for the latest release, `version` the highest
  reported, and `machines` how many use it. Admins only.
- `GET /api/machines/:id/skin-sources` returns `{ skinSources }`, the same
  for the Skins on the other Machines, for the Skin install form: each `{
  skinId, name, version, repo, branch, url, updates, machines }`, a
  repository with its branch, null for the latest release, or a `url` with
  no repository. Skins that come with Decaid and those with no recorded
  source are left out. Admins only.
- The Software Actions routes are under Software Actions, above.
- `GET /api/machines/:id/paired-devices` returns `{ pairedDevices: { reportedAt,
  available, receivedAt, scale, auxiliaryScale, sensors, others } }`, each
  device `{ id, type, model, vendor, state, firmware, batteryLevel }`
  (`server/src/collections/paired-devices.ts`). `reportedAt` and `available`
  are the latest report's; the devices are the latest read, from `receivedAt`,
  with their state then. The scale is the one Decaid has connected as its
  primary scale, or else the one `appSettings` names as preferred; the
  auxiliary scale is one connected as `auxiliary`. Firmware and battery level
  come from `scaleInfo` and belong to a connected primary scale, joined only
  while the latest inventory read succeeded: `scaleInfo` names no scale, so
  against an older inventory it could describe a scale that replaced the one
  listed. In Decaid v0.9.0 only Skale2 scales and scale plugins that publish
  them (`context.publishInfo`, a battery level only with the `battery`
  capability) report them, so other scales answer `{}`; `/devices` entries
  carry neither. A device's `type` is `machine`, `scale`, `sensor` or, for a
  plugin's grinder, `grinder`, which the Machine page shows as a Grinder.
  Sensors are those in the inventory, and, while the latest inventory read
  succeeded, those `/sensors` lists that it leaves out, such as a Bengle's milk
  probe, each with its manifest's name and vendor. So every device shown is as
  of `receivedAt`.
  Everything else paired, such as the machine itself, is in `others`.

The Machine page (ticket
[#545](https://github.com/loganfuller/decent-sync/issues/545)) shows these on
three of its tabs, each loading what it shows only while it is open, every
30 s rather than every 5 s as the Machine's status is. Its Settings tab shows the
Machine Settings and Tablet Settings by their field definitions (Settings
fields, above), the steam, hot water and flush settings of the current
Workflow, the paired devices, and its Settings History with its Settings
Edits, a row per field changed, with brief changes shown on asking and a
control that narrows it to what was made through a Settings Edit. Its
Software tab shows the Tablet Software (Software Actions, above). Its Setup
tab shows its hardware and firmware in its Hardware card, with a link to the
Software tab for Decaid, the plugins and the Skins, and how many of each
library collection its tablet reported. Through
the MCP endpoint, `get_machine` gives the Machine Settings, the Tablet
Settings and the DYE2 and Streamline, and `get_machine_reports` (ticket
[#441](https://github.com/loganfuller/decent-sync/issues/441)) gives
`scaleInfo`, `sensors`, `plugins` and `skins` with the `available`,
`reportedAt`, `receivedAt` and `value` that
`GET /api/machines/:id/collections/:name` gives, and the paired devices as
`GET /api/machines/:id/paired-devices` and the Machine page do, each the latest
reported. `get_machine_software` and `list_software_actions` give the Tablet
Software and the Software Actions (Software Actions, above), and
`list_settings_history` names a change's Software Action and keeps the
`pluginSettings`, a setting's value to Admins only.

`server/test/collections.test.ts` covers this through Seam 1, with the built
plugin and raw frames on two instances sharing PostgreSQL,
`server/test/settings-history.test.ts` the Settings History, with
`protocol/test/settings-history.test.ts` its projection and its changes,
`server/test/settings-history-reads.test.ts` its REST reads, the one with its
Settings Edits among them,
`server/test/assistant-machines.test.ts` and `assistant-budget.test.ts`
`list_settings_history`, `get_machine` with a time and `get_machine_reports`,
`server/test/machine-settings-while-busy.test.ts` the reads from the machine
waiting while it runs something, with `plugin/test/machine-activity.test.ts`
when it runs nothing, and `e2e/library-settings-devices.spec.ts` and
`e2e/settings-history.spec.ts` the management interface.

Known limits: a collection read from a connection whose `hello` reported no
machine belongs to the token's Machine, as everything on that connection does.
A collection read just before a tablet moved to other hardware, and delivered
on the next connection, is credited to the new hardware, until the full
resend on that connection's `welcome` replaces it.
