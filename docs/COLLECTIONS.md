# Library, settings, paired devices, plugins and Skins

Ticket [#14](https://github.com/loganfuller/decent-sync/issues/14) extends
protocol version 1 with one delivery, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `collection` | `id` (delivery id), `name` (one of `COLLECTION_NAMES`), `available`, and `value` (opaque, as Decaid's API answered) while available; for one of `LIBRARY_LISTS`, `updatedAt` too (ticket #80); for one of `UTC_OFFSET_COLLECTIONS`, `utcOffsetMinutes` too (ticket #229); for a Settings Edit's read-back, `settingsEditId` too (ticket #432, Settings History below) |

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
| `skins` | `GET /webui/skins`, `/webui/skins/default` and `/webui/server/status`, three reads | content |
| `pairedDevices` | `GET /devices`, without devices only discovered nearby | content |
| `scaleInfo` | `GET /scale/info` | content |
| `sensors` | `GET /sensors` | content |

A read is unavailable when it fails or has nothing to report: any status but
200 or 304 (the machine's settings answer 500 while no machine is connected,
`/scale/info` 503 while no scale is), a fetch that fails or times out, or
`null` for a collection read from Decaid's API. `sensorCalibration` is
unavailable if any of its three reads is, and its later reads are then not
made: a partial set would be compared with another Machine's complete one.
It is sent as unavailable, never as an empty collection. So is `skins` if any
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
(ADR-0023); or to restart the Machine after a change. Streamline's settings
page no longer puts back a fan threshold of 50 or a refill kit of
Auto-Detect from v0.2.22 on Decaid v0.9.1, so no note says it does.
Labels, units, ranges, steps and choices follow Streamline's settings page at
v0.2.24, and Decaid's own limits where it has none. A ±
button's increment is no step: Streamline's move the flow multipliers of the
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
Settings (`appSettings`), Staff's but for gateway mode, an Admin's, and
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
  `SETTINGS_FIELDS`, so it stays in step with them. It answers with the edit
  as `list_settings_edits` gives it, its outcome usually still to come, which
  the assistant reads there.
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
     `/machine/calibration`, `/settings` or `/presence/settings`. Decaid writes each field in
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
- **The Settings Edits card** (`web/src/components/settings-edit-log.tsx`)
  lists the Machine's edits, newest first, 20 a page: when each was made, who
  made it ("You" for the account's own, the account's name to Admins, and
  otherwise "An account", as the Library's history shows Staff, followed by
  ", through <app>" for one made through a Connected App), its section,
  each field's value in the report it was made over and the value asked for,
  and its outcome, a late answer marked so. A wake schedule's edit names its
  action first, as asked, such as "Change the wake schedule at 06:30", then
  each field changed, or for an add each field it set, in the schedule's
  order. The section's status names it the same way while pending, and as
  done, such as "Wake schedule at 06:30 changed", once applied. It is shown
  closed, as is the Settings History card, since most who read the page need
  neither, and loads nothing until opened. Open, it loads every 30 s, and
  again as an edit made on the page is answered. A time of
  day there is the Tablet's own, written without its offset, as an edit
  does not keep the offset it was made in.

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
memory over its Bluetooth or USB connection (`UnifiedDe1`), fourteen reads
each time, on the link the scale also uses, which is why the plugin reads them
less often than the rest, and only while the machine runs nothing. Only the
advanced settings' `heaterVoltage` and
`refillKitSetting` are what Decaid holds rather than reads: the voltage it read
as the machine connected, and the refill kit setting it last wrote, each until
written through Decaid. As the machine connects, Decaid writes the refill kit
setting last written through its API for that Machine, which it keeps, or
`auto` where none was (ADR-0023).

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
Something other than a person may change it, such as an auto flow calibration
plugin rewriting it per profile; a change reaches the server by the
collection's next interval. Streamline's calibration page edits it too, from
v0.2.23 (`0cb60bb`), through `POST /api/v1/machine/calibration`, the route
the Flow multiplier Settings Edit uses, and only as a barista changes it
there: its ± buttons step it by 0.01, and it rounds what is typed to 0.01,
within 0.13 to 2.0 (`clampFlowMultiplier` and `FLOW_MULTIPLIER_STEP` in
`streamline-js:src/modules/sensor-cal.js`), where the field takes a
thousandth. Opening the page writes nothing, so a value set here between two
of its steps stands until a barista changes it there. The `volumeFlowMultiplier`,
`hotWaterFlowMultiplier` and `weightFlowMultiplier` in `appSettings` are not
calibration but Decaid's lookahead times, in seconds, for stopping at a volume
or weight (`ShotSequencer`, `HotWaterSequencer`).

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
the DYE2 and Streamline on each tablet, which the Machine page's Versions card
shows. They are only shown: nothing is refused at `hello` or flagged below
ADR-0017's minimums.

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
  whatever else is installed. The row gives its `version` and which it is;
  otherwise the active Skin's name and version, or not installed when no
  Skin is either id. A build of `main` reports a version of its own: the
  latest release's, with `-dev`, its commit and the number of the run that
  built it, such as `0.2.21-dev.c568255.686` for the deploy of v0.2.21 (from
  streamline-js `800a521`, `server/test/fixtures/decaid/dye2-v0.1.33/skins.json`),
  which the row shows as it is, with "main build".

Neither row is anything until its collection is reported. The recording in
`server/test/fixtures/decaid/plugins-and-skins-v0.9.0/` shows Decaid's answers
to each change; `AI_RUNTIME_NOTES.md` (Skins) has the routes.

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
Machine Settings, the Tablet Settings and presence settings, the plugins and
Skins, the paired devices, the scale's information and the sensors) that
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
  by entry, by their ids, in any order. A field absent counts as null, and an
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
  Sync, and is tied to no person.
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
alike (ADR-0026):

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
  fields changed outside it are another, of the same id, naming none.
- **Brief changes.** A field changed from outside Decent Sync and changed
  back to its value before, by its next change, also from outside, within
  `BRIEF_CHANGE_MS` (2 minutes), is a brief change: one change, its
  `backAt` saying when it changed back, and the change back left out. That
  covers the refill kit Decaid shows on automatic as the machine reconnects
  (ADR-0023) and a remembered scale left out while it connects. A change made
  or undone through a Settings Edit is never brief. Brief changes are left
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

## REST API

All endpoints require the account session, and answer 404 for an unknown
Machine. Pending Machines' collections are not exposed; they appear on the
Machine that takes their hardware over. Staff read them as Admins do.

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
  settingsEdit, fields }`: `settingsEdit` is `{ id, account, connectedApp }`,
  or null for a change made outside Decent Sync, and each field `{ field,
  change, before, after, backAt }`. It takes `collection`, once or more, each
  a collection the history keeps; `from`, included, and `to`, not, moments
  with their offsets, by when each change was received; `includeBrief`,
  `true` or `false` (the default); and `limit` (1 to 100, 20 if not given)
  and `offset`. Viewers read it too.
- `GET /api/machines/:id/tablet-versions` returns `{ tabletVersions: { dye2,
  streamline } }` (Plugins and Skins, above), each with a `status`:
  `notReported` until its collection is reported, `notInstalled`, and for
  DYE2 `installed`, with its `version`, `loaded` and `branch` (null but for
  a branch install); for Streamline `active`, with its `version` and `build`
  (`release` or `main`), or `notActive`, with the `activeSkin`'s `name` and
  `version`, or null if none is. Every field from Decaid's payload is null
  where it is missing or not a string.
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

The Machine page shows the DYE2 and Streamline in its Versions card, which
keeps the last reported while the Machine is offline, the paired devices, the
Machine Settings and Tablet Settings by their field definitions (Settings
fields, above), the steam, hot water and flush settings of the current
Workflow, its Settings History, a row per field changed, with brief changes
shown on asking, and how many of each library collection its tablet reported,
loaded every 30 s rather than every 5 s as the Machine's status is. Through
the MCP endpoint, `get_machine` gives the Machine Settings, the Tablet
Settings and the Versions card's rows, and `get_machine_reports` (ticket
[#441](https://github.com/loganfuller/decent-sync/issues/441)) gives
`scaleInfo`, `sensors`, `plugins` and `skins` with the `available`,
`reportedAt`, `receivedAt` and `value` that
`GET /api/machines/:id/collections/:name` gives, and the paired devices as
`GET /api/machines/:id/paired-devices` and the Machine page do, each the latest
reported.

`server/test/collections.test.ts` covers this through Seam 1, with the built
plugin and raw frames on two instances sharing PostgreSQL,
`server/test/settings-history.test.ts` the Settings History, with
`protocol/test/settings-history.test.ts` its projection and its changes,
`server/test/settings-history-reads.test.ts` its REST reads,
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
