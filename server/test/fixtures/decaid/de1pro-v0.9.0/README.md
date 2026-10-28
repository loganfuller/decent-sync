# DE1Pro on Decaid v0.9.0

Responses from Decaid's local API on the test tablet (a DE1Pro, Decaid
0.9.0+2977, built from the v0.9.0 tag, commit `b9f9d055`), read with `GET`
requests on 2026-10-16:

| File | Endpoint |
|---|---|
| `info.json` | `GET /api/v1/info` |
| `settings.json` | `GET /api/v1/settings` |

Edited: the tablet's LAN address is replaced with `192.0.2.10`, and the
Bluetooth addresses of the preferred machine and scale with
`00:00:5E:00:53:01` and `00:00:5E:00:53:02`, as in `../de1pro-v0.8.7/`.
Everything else is as Decaid sent it.

These supersede `../de1pro-v0.8.7/`'s `info.json` and `settings.json`, the
only endpoints v0.9.0 answers otherwise there. The settings now include
`preferredGrinderDeviceId`, null, and hold the
tablet's app settings as they are now: the default skin
`streamline.js-dist` while it serves the release's folder (`webUiPath`,
`.../app_flutter/web-ui/streamline.js`, which Decaid answers with the folder
it serves, `settings_handler.dart`), charging mode `longevity`, scale power mode `displayOff`, and a battery at
51% and not charging. The simulated tablet (`de1ProOnDecaid090` in
`server/test/support/simulated-tablet.ts`) answers `/info` and `/settings`
from here, and everything else from `../de1pro-v0.8.7/`, but for
`/machine/calibration` and `/machine/calibration/{target}`, which were not
recorded, and Decaid's Skins routes (`/webui/...`), which it answers as
Decaid's Linux release did with the same default and the release served
(`../plugins-and-skins-v0.9.0/`, `defaultSwitched`), its paths the
container's. It answers Decaid's `{"flowMultiplier": …}` (`de1handler.dart`)
with 1.1, the flow calibration `../de1pro-v0.8.7/shot-espresso.json`
recorded, and each sensor calibration with derived values in Decaid's shape
(`sensorCalibration` there).

## Read on 2026-10-25, in the supervised run of #232

The same tablet and build, with DYE2 0.1.26 and Streamline's `dist` build
`55bd37d` (the deploy of `cec5664`), its DE1Pro on firmware 1358. Read with
`GET` requests before the run's Settings Edits, and the same again after
every value was set back:

| File | Endpoint |
|---|---|
| `machine-settings.json` | `GET /api/v1/machine/settings` |
| `machine-settings-advanced.json` | `GET /api/v1/machine/settings/advanced` |
| `machine-calibration.json` | `GET /api/v1/machine/calibration` |
| `machine-calibration-flow.json`, `-pressure.json`, `-temperature.json` | `GET /api/v1/machine/calibration/{target}` |
| `presence-settings.json` | `GET /api/v1/presence/settings` |

These are the real Machine's answers to the routes the simulated tablet
answers with derived values above. Its sensor calibrations are Q16.16 values,
such as a pressure multiplier of 1.293609619140625 (84778/65536), none of them
on the management interface's steps.

`calibration-writes.json` holds what the Machine held after each write of the
flow multiplier and the pressure sensor's calibration in the run: the value
wanted, the route, and Decaid's `GET` of the same route afterwards (`read`).
Each write was a Settings Edit from the management interface, the plugin
sending `{"flowMultiplier": wanted}`, or the correction `absoluteSet` makes
(the value read before as `de1ReportedValue`, the one wanted as
`measuredValue`), but for the last, sent to Decaid directly to set the
original value back, off the field's step. The first two pressure writes'
`sent` bodies are the plugin's, by its code, and the last's as it was sent;
the reads are as Decaid sent them. The DE1 held flow multipliers of 1.005 and
1.004 as 1.003, where Decaid's truncated write (`_writeMMRScaled`) sends 1004
for both, and 1.012 and 1.013 as 1.011, and 0.251 as 0.25: the firmware holds
some values a thousandth lower than the register written. The four after 1.18
were written to check that. Each pressure write held the Q16.16 value nearest
the one wanted.

Nothing here is edited: none of these answers holds a hardware id.

## A Shot with a long Preheat, read on 2026-10-25

`shot-preheat.json` is `GET /api/v1/shots/399cf1d5-aced-480d-aa93-01a3897f3820`,
read from the same tablet and build (Decaid 0.9.0+2977, DE1Pro firmware
1358), after #287 was filed from it. It was pulled at 15:53 local time with
Adaptive v3, the heater test set to 8 ml/s for 8 s (`heaterPh2Flow`,
`heaterPh2Timeout`). Its first 43 of 168 samples, 7.36 s, have the substate
`preparingForShot`: the Machine's Preheat, at 8 ml/s, its mix temperature
held near 85.7 °C against an 88 °C target, until the heater test's timeout.
Its peak flow, 8.05 ml/s, is in Preheat; after it the peak is 8.045 ml/s.

Edited: the machine's serial number is replaced with `10001`, as in
`../de1pro-v0.8.7/`, and the Visualizer upload's id, in `metadata` and the
annotations' extras, with `00000000-0000-4000-8000-000000000287`. Everything
else is as Decaid sent it, with no Barista or notes recorded.
