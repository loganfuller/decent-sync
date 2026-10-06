# DE1Pro on Decaid v0.8.7

Responses from Decaid's local API on the test tablet (a DE1Pro, Decaid
0.8.7+2847, built from the v0.8.7 tag), read with `GET` requests on 2026-10-04:

| File | Endpoint |
|---|---|
| `info.json` | `GET /api/v1/info` |
| `machine-info.json` | `GET /api/v1/machine/info` |
| `settings.json` | `GET /api/v1/settings` |
| `shot-espresso.json` | `GET /api/v1/shots/45648d13-bb4c-4371-ba84-f34f2e89c583` |
| `steam.json` | `GET /api/v1/steams/1bec3908-e160-41c7-9b68-05de6d44b637`, read on 2026-10-05 |
| `workflow.json` | `GET /api/v1/workflow`, read on 2026-10-05 |
| `machine-state.json` | `GET /api/v1/machine/state`, read on 2026-10-05 |
| `beans.json` | `GET /api/v1/beans?includeArchived=true`, read on 2026-10-05 |
| `bean-batches.json` | `GET /api/v1/bean-batches?includeArchived=true`, read on 2026-10-05 |
| `grinders.json` | `GET /api/v1/grinders?includeArchived=true`, read on 2026-10-05 |
| `profiles.json` | `GET /api/v1/profiles?includeHidden=true`, read on 2026-10-05, trimmed |
| `dye2-recipes.json` | `GET /api/v1/store/dye2.reaplugin/recipes`, read on 2026-10-05 |
| `dye2-baskets.json` | `GET /api/v1/store/dye2.reaplugin/baskets`, read on 2026-10-05 |
| `machine-settings.json` | `GET /api/v1/machine/settings`, read on 2026-10-05 |
| `machine-settings-advanced.json` | `GET /api/v1/machine/settings/advanced`, read on 2026-10-05 |
| `devices.json` | `GET /api/v1/devices`, read on 2026-10-05 |
| `scale-info-no-scale.json` | `GET /api/v1/scale/info`, read on 2026-10-05, which answered 503 with this body: no scale was connected |
| `sensors.json` | `GET /api/v1/sensors`, read on 2026-10-05 |

Edited: the machine's serial number, the Bluetooth addresses of the preferred
machine and scale (in `settings.json` and `devices.json`), and the tablet's
LAN address are replaced with made-up values (serial `10001`, addresses from the `00:00:5E:00:53:xx` documentation
range, IP from `192.0.2.0/24`). Everything else is as Decaid sent it.

`workflow.json` is what Decaid's `workflowUpdated` event carries, and
`machine-state.json` what its `stateUpdate` event carries: both events send
the same `toJson()` as these endpoints (`PluginManager` in
`decaid:lib/src/plugins/plugin_manager.dart`). The Workflow's Barista and
drinker names are replaced with `Fixture Barista`. The machine state's
`timestamp` is the tablet's local time (UTC-4) without an offset. Seam 1
derives other states from it, changing only `state.state` and
`state.substate` to names from Decaid's `MachineState` and `MachineSubstate`
(`decaid:lib/src/models/device/machine.dart`), and other Workflows by
changing named fields, in tests that say so.

The Shot's `timestamp` and sample times are the tablet's local time (UTC-4)
without an offset, as Decaid writes them; `createdAt` and `updatedAt` are UTC.
Curves are trimmed to their first, last, peak-pressure and peak-flow samples
(in their original order), retaining the original duration and peaks. Barista
and drinker names are replaced with `Fixture Barista`; notes, plugin upload
bookkeeping and the deprecated metadata mirror are scrubbed. Machine serials
are replaced with `10001`.

v0.8.7 is the oldest Decaid that Decent Sync supports. Seam 1 Shot variants
change ids, times, hardware, annotations or unknown fields explicitly in
tests. Their measurement samples still come from this record; one Playwright
Shot in `e2e/shots.spec.ts` also changes its samples' pressure targets, and
says so. `longShot()` in
`server/test/support/shot-fixtures.ts` derives Shots larger than one frame by
repeating those samples.

The Steam Record is whole, measurements included, with only its Barista
name replaced with `Fixture Barista`. Its `timestamp` and sample times are
the tablet's local time (UTC-4) without an offset; Decaid records no UTC time
or hardware on Steam Records. This DE1Pro has no milk probe, so every sample's
`milkTemperature` is null. `bengle-simulated-v0.8.7/` has one with milk
temperatures.

The library and settings are as Decaid sent them, except that the profiles are
trimmed to 5 of the tablet's 75 (the two made on the tablet, and three of
Decaid's bundled ones) and the DYE2 recipe's Barista is replaced with
`Fixture Barista`. Nothing on this tablet was archived or hidden, and DYE2 had
never written its `equipment` key, which Decaid then answers with `null`
(`KvStoreHandler` in `decaid:lib/src/services/webserver/kv_store_handler.dart`);
`simulated-devices-v0.8.7/` has archived and hidden records. Its paired scale
was off: `devices.json` lists it as Decaid remembers it, `disconnected` and not
`available`.
