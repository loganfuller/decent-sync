# Library, settings and paired devices

Ticket [#14](https://github.com/loganfuller/decent-sync/issues/14) extends
protocol version 1 with one delivery, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `collection` | `id` (delivery id), `name` (one of `COLLECTION_NAMES`), `available`, and `value` (opaque, as Decaid's API answered) while available |

It is acknowledged with `ack` once stored, as Shots are. Older plugins never
send it, so the protocol version stays 1. A name the server does not know, as
a newer plugin might send, is acknowledged and ignored. While `available` is
true, `value` is any JSON but null; while false, it is absent.

## Collections

Each is read from Decaid v0.8.7's API (`decaid:assets/api/rest_v1.yml`):

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
| `pairedDevices` | `GET /devices`, without devices only discovered nearby | content |
| `scaleInfo` | `GET /scale/info` | content |
| `sensors` | `GET /sensors` | content |

A read is unavailable when it fails or has nothing to report: any status but
200 or 304 (the machine's settings answer 500 while no machine is connected,
`/scale/info` 503 while no scale is), a fetch that fails or times out, or
`null`, which Decaid answers for a key of plugin storage never written
(`KvStoreHandler` in `decaid:lib/src/services/webserver/kv_store_handler.dart`).
It is sent as unavailable, never as an empty collection.

DYE2's keys are only read: DYE2 is their only writer until Location sharing
(ADR-0005). `pairedDevices` keeps Decaid's inventory entries as sent, leaving
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

- While connected, every poll interval the plugin reads each collection, one
  after another, and sends one that changed since it was last queued: it
  became available or unavailable, or its ETag differs, or, without one, a
  hash of its JSON does. The library's lists are read with the last ETag in
  `If-None-Match`; Decaid's 304 sends nothing. While disconnected it does not
  poll.
- On every `welcome`, it reads every collection again, without
  `If-None-Match`, and sends each, unavailable ones included, whether or not it
  changed. That also covers whatever changed while it was disconnected.
- A newer delivery of a collection drops an older one still queued, unless
  the older one was ever handed to a connection. Such a delivery may still be
  being stored by the instance that received it, so it is sent again, under
  its id, ahead of the newer one; the server then finds it handled, or waits
  for it, and the newer value always lands last.

Decaid's plugin `fetch` passes request headers and gives response headers
through `headers.get` (`PluginManager` in
`decaid:lib/src/plugins/plugin_manager.dart`). Decaid answers the machine and
advanced settings by reading each one from the machine's memory over its
Bluetooth or USB connection (`UnifiedDe1`), fifteen reads per poll.

## Server

`server/src/collections/collections.service.ts` stores the latest value of
each collection in `reported_collections`, one row per Machine (or Pending
Machine) and name:

- `available` and `reported_at`: whether the latest report had a value, and
  when it arrived, by PostgreSQL's clock.
- `value`, `received_at` and `items`: the latest value reported, as sent,
  when it arrived, and how many entries it lists if it is a list. An
  unavailable report keeps them.

Each delivery is handled once, by its delivery id, recorded in
`machine_event_deliveries` as Workflow deliveries are, so a resend changes
nothing however late it arrives. A collection belongs to the session's token's
Machine, or for a mismatched session to its reported hardware: the Machine that
has it, or else its Pending Machine (ADR-0015), locked as `creditReporter` in
`server/src/machines/credit.ts` locks it. The token's Machine therefore keeps
what its own tablet last reported. Every way a Machine takes over hardware
hands its collections over with its records (`transferPendingRecords`, through
`transferPendingCollections` in `server/src/collections/transfer.ts`): where
the Machine has the same collection, the later report says whether it is
available, and the later value received is kept.

Values are stored as jsonb, which keeps their content but not the order of
their keys, and compressed with lz4.

## REST API

All endpoints require the account session, and answer 404 for an unknown
Machine. Pending Machines' collections are not exposed; they appear on the
Machine that takes their hardware over.

- `GET /api/machines/:id/collections` returns `{ collections }`, each reported
  collection's `{ name, available, reportedAt, receivedAt, items }`, without
  its value, in `COLLECTION_NAMES` order.
- `GET /api/machines/:id/collections/:name` returns `{ collection }`, the same
  with its `value`, or null until the Machine's tablet reports it. An unknown
  name answers 404.
- `GET /api/machines/:id/paired-devices` returns `{ pairedDevices: { reportedAt,
  scale, auxiliaryScale, sensors, others } }`, each device
  `{ id, type, model, vendor, state, firmware, batteryLevel }`
  (`server/src/collections/paired-devices.ts`). The scale is the one Decaid has
  connected as its primary scale, or else the one `appSettings` names as
  preferred; the auxiliary scale is one connected as `auxiliary`. Firmware and
  battery level come from `scaleInfo` and belong to a connected primary scale;
  in Decaid v0.8.7 only Skale2 scales report them, so other scales answer `{}`.
  Sensors are those in the inventory and those `/sensors` lists, which can
  include some the inventory leaves out, with their manifest's name and vendor.
  Everything else paired, such as the machine itself, is in `others`.

The Machine page shows the paired devices, the app, machine and advanced
settings, the steam, hot water and rinse settings of the current Workflow, and
how many of each library collection its tablet reported.

`server/test/collections.test.ts` covers this through Seam 1, with the built
plugin and raw frames on two instances sharing PostgreSQL, and
`e2e/library-settings-devices.spec.ts` the management interface.

Known limits: a collection read from a connection whose `hello` reported no
machine belongs to the token's Machine, as everything on that connection does.
A collection read just before a tablet moved to other hardware, and delivered
on the next connection, is credited to the new hardware, until the full
resend on that connection's `welcome` replaces it.
