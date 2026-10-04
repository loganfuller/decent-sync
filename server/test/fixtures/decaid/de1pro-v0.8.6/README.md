# DE1Pro on Decaid v0.8.6

Responses from Decaid's local API on the test tablet (a DE1Pro, Decaid
0.8.6+2801), read with `GET` requests on 2026-10-03:

| File | Endpoint |
|---|---|
| `info.json` | `GET /api/v1/info` |
| `machine-info.json` | `GET /api/v1/machine/info` |
| `settings.json` | `GET /api/v1/settings` |

Edited: the machine's serial number, the Bluetooth addresses of the preferred
machine and scale, and the tablet's LAN address are replaced with made-up
values (serial `10001`, addresses from the `00:00:5E:00:53:xx` documentation
range, IP from `192.0.2.0/24`). Everything else is as Decaid sent it.

Shot fixtures were read from the same confirmed tablet on 2026-10-04:

| File | Endpoint |
|---|---|
| `shot-espresso.json` | `GET /api/v1/shots/45648d13-bb4c-4371-ba84-f34f2e89c583` |
| `shot-de1app.json` | `GET /api/v1/shots/de1app-1790428090` |

Both are records Decaid produced. The latter is a real import from the legacy
Tcl app, with no `workflow.machine`. Curves are trimmed to their first, last,
peak-pressure and peak-flow samples (in their original order), retaining the
original duration and peaks. Barista and drinker names are replaced with
`Fixture Barista`; notes, plugin upload bookkeeping and the deprecated
metadata mirror are scrubbed. Machine serials are replaced with `10001`.

`shot-extraction.test.ts` also derives older layouts from the native record:
no hardware provenance or edit times (the v0.7.5 `ShotRecord`/`Workflow`
serializers), and the legacy `doseData`/`coffeeData` fields accepted by those
serializers (also written by v0.5.1). These are compatibility derivations of
a real record, not independent captures from those older builds. Other
Seam 1 variants change ids, times, hardware, annotations or unknown fields
explicitly in tests. Their measurement samples still come from these records.
