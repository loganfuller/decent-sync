# Library, settings, paired devices, plugins and Skins

Ticket [#14](https://github.com/loganfuller/decent-sync/issues/14) extends
protocol version 1 with one delivery, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `collection` | `id` (delivery id), `name` (one of `COLLECTION_NAMES`), `available`, and `value` (opaque, as Decaid's API answered) while available; for one of `LIBRARY_LISTS`, `updatedAt` too (ticket #80) |

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

## Collections

Each is read from Decaid v0.9.0's API (`decaid:assets/api/rest_v1.yml`):

| Name | Read from | Compared by |
|---|---|---|
| `beans` | `GET /beans?includeArchived=true` | ETag |
| `beanBatches` | `GET /bean-batches?includeArchived=true` | ETag |
| `grinders` | `GET /grinders?includeArchived=true` | ETag |
| `profiles` | `GET /profiles?includeHidden=true`, which includes deleted ones too | ETag |
| `dye2Recipes`, `dye2Equipment`, `dye2Baskets` | `GET /store/dye2.reaplugin/{recipes,equipment,baskets}` | content |
| `appSettings` | `GET /settings` | content |
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
- It reads the sensor calibration (`sensorCalibration`) only on those full
  reads, on every `welcome` and `requestCollections`: never on a poll, on the
  machine settings' interval or after a Workflow change. Its three reads each
  go to the machine (below), and its values change only through a deliberate
  calibration (`PUT` on the same route), so a recalibration reaches the
  server on the tablet's next reconnect or `requestCollections`.
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
less often than the rest. Only the advanced settings' `heaterVoltage` and
`refillKitSetting` are what Decaid holds rather than reads: the voltage it read
as the machine connected, and the refill kit setting it last wrote (`auto` as
the machine connects), each until written through Decaid.

`machineCalibration` is the machine's flow estimation multiplier, Decaid's
`flowMultiplier` (the DE1's `calFlowEst`, kept in thousandths), which scales
the flow the machine reports, and which each Shot records as
`workflow.machine.flowCalibration`. The Machine page shows settings to three
decimal places at most, so a change of a thousandth shows.
Something other than a person may change it, such as an auto flow calibration
plugin rewriting it per profile; a change reaches the server by the
collection's next interval. The `volumeFlowMultiplier`,
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
so the Machine page shows them to five decimal places at most, not three as
other settings: any two values it can hold then still differ when shown.
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
  Skin is either id. A build of `main` reports the version of the release
  before it (`0.2.18` at `cec5664`) and Decaid gives no commit for it, so the
  row says only "main build".

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

## REST API

All endpoints require the account session, and answer 404 for an unknown
Machine. Pending Machines' collections are not exposed; they appear on the
Machine that takes their hardware over. Staff read them as Admins do.

- `GET /api/machines/:id/collections` returns `{ collections }`, each reported
  collection's `{ name, available, reportedAt, receivedAt, items }`, without
  its value, in `COLLECTION_NAMES` order.
- `GET /api/machines/:id/collections/:name` returns `{ collection }`, the same
  with its `value`, or null until the Machine's tablet reports it. An unknown
  name answers 404.
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
app, machine and advanced settings, the flow calibration, the sensor calibration (each sensor's
`measuredValue`), the steam, hot water and flush settings of the current
Workflow, and how many of each library collection its tablet reported, loaded
every 30 s rather than every 5 s as the Machine's status is.

`server/test/collections.test.ts` covers this through Seam 1, with the built
plugin and raw frames on two instances sharing PostgreSQL, and
`e2e/library-settings-devices.spec.ts` the management interface.

Known limits: a collection read from a connection whose `hello` reported no
machine belongs to the token's Machine, as everything on that connection does.
A collection read just before a tablet moved to other hardware, and delivered
on the next connection, is credited to the new hardware, until the full
resend on that connection's `welcome` replaces it.
