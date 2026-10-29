# Settings writes on Decaid v0.9.0

What Decaid v0.9.0's API answers writes to the machine's settings, advanced
settings, flow calibration and sensor calibration, to Decaid's own settings,
and to its presence settings and wake schedules, and what it reads after
them, for decent-sync #223. The simulated tablet carries out these writes the
same way (`server/test/support/decaid-settings.ts`), and
`server/test/simulated-settings-writes.test.ts` replays every step against
it.

`settings-writes.json` holds one step per change, in order, each
`{exchanges, reads}`: the requests the script sent, with the status and body
Decaid answered (`exchanges`), then the reads of every settings route
(`reads`): `GET /machine/settings`, `/machine/settings/advanced`,
`/machine/calibration`, `/machine/calibration/flow`, `/pressure` and
`/temperature`, `/settings` and `/presence/settings`, each its status and
body, JSON parsed. A body that is not JSON is kept as its text, and an empty
one as `null`; a request sent with a body that is not JSON keeps it as
`rawBody`. A read whose answer is the same as the step before's read of that
route keeps its status and `"unchanged": true` in place of its body. Nothing
else was edited.

| Step | What it sent before the reads |
|---|---|
| `started` | Nothing: Decaid as it started, once its simulated machine was connected |
| `machineState` | `GET /machine/state` |
| `machineSettings` | `POST /machine/settings` of a fan threshold of 45 and steam purge mode 1 |
| `machineSettingsFlows` | `usb` `"enable"`, a steam flow of 1.5, a hot water flow of 8.5 and a flush flow of 7.5 |
| `machineSettingsLenient` | A fan threshold of 42.9, `usb` `true` and a steam flow of `"1.25"`, as text |
| `machineSettingsRefused` | A body that is a list, one that is not JSON, and a fan threshold of `"warm"` |
| `advancedSettings` | `POST /machine/settings/advanced` of every field: warmup flow 2, test flow 4.5, idle temperature 96, test time-out 6, heater voltage 230, refill kit 1 (force on) |
| `heaterVoltage200`, `heaterVoltage1120`, `heaterVoltage300` | A heater voltage of 200, 1120 and 300 |
| `advancedSettingsRefused` | A refill kit setting of 3; a warmup flow of 3 with a refill kit setting of 7; a body that is a list |
| `calibration` | `POST /machine/calibration` of a flow multiplier of 1.2 |
| `calibrationRefused` | A body that is a list |
| `sensorFlow` | `PUT /machine/calibration/flow` of `de1ReportedValue` 1, `measuredValue` 1.0625, the current value as reported and the one wanted, as Streamline sets one |
| `sensorPressure` | `PUT /machine/calibration/pressure` of 8 and 9, a correction of 9/8 |
| `sensorTemperature` | `PUT /machine/calibration/temperature` of 92 and 92.5, a correction of 0.5 |
| `sensorRefused` | A `de1ReportedValue` of 0 for flow; the target `humidity`; a `de1ReportedValue` of `"1"`; a `measuredValue` of 40000; a body that is a list |
| `appSettings` | `POST /settings` of every field Decaid keeps for itself but `webUiPath`, `defaultSkinId`, the preferred devices and `simulatedDevices`: automatic update checks off, gateway mode `tracking`, log level `FINE`, the three flow multipliers, scale power mode `displayOff`, the scale and hot water switches, charging mode `longevity`, night mode on from 23:00 to 06:00, the low battery brightness limit off, keep awake off and theme `dark` |
| `appSettingsPartChargingMode` | Scale power mode `disconnect` and charging mode `fast` |
| `appSettingsPartMorningTime` | Night mode off and a morning time of 1440 |
| `appSettingsRefused` | `blockOnNoScale` `"yes"`; `weightFlowMultiplier` `"1"`; gateway mode `remote`; theme `sepia`; a body that is a list; one that is not JSON |
| `appSettingsLenient` | Scale power mode `DISPLAY_OFF` and log level `LOUD` |
| `presenceSettings` | `POST /presence/settings` of presence on and a sleep timeout of 30 |
| `presenceClampedHigh`, `presenceClampedLow` | A sleep timeout of 300, then of -5 |
| `presenceRefused` | A sleep timeout of 12.5; `userPresenceEnabled` `"yes"` beside a sleep timeout of 20; a body that is a list; one that is not JSON |
| `scheduleAdded` | `POST /presence/schedules` at `06:30` on days 5, 1, 3 and 1, on, keeping awake for 120 minutes |
| `scheduleAddedEveryDay` | At `hour` 7 and `minute` 5, nothing else |
| `scheduleAddedOff` | At `21:15` on days 6 and 7, off, keeping awake for 0 minutes |
| `scheduleRefused` | Keeping awake for 721 minutes; hour 24; day 0 |
| `scheduleChanged` | `PUT /presence/schedules/{id}` of `scheduleAdded`'s: off, keeping awake for 0 minutes |
| `scheduleChangedTime` | The same schedule at `05:45` with `minute` 50, on days 4 and 2, keeping awake for 60 minutes |
| `scheduleChangeRefused` | The same schedule at hour 25; on day 8; keeping awake for 721 minutes; then a schedule id Decaid never gave |
| `schedulesListed` | `GET /presence/schedules` |
| `scheduleDeleted` | `DELETE /presence/schedules/{id}` of `scheduleAddedEveryDay`'s |
| `scheduleGone` | Its `DELETE` again, and a `PUT` of it |
| `machineDisconnected` | `PUT /devices/disconnect` of `{"deviceId":"MockDe1"}`, then 3 s before the reads |
| `withoutMachine` | `GET /machine/state`; `POST /machine/settings` of a fan threshold, and of a list; `POST /machine/settings/advanced` of an idle temperature, and of a refill kit setting of 9; `POST /machine/calibration`; `PUT /machine/calibration/flow` of 1 and 1, and of 0 and 1; `POST /settings` of a theme; `POST /presence/settings` of a sleep timeout |
| `scheduleAddedWithoutMachine`, `scheduleDeletedWithoutMachine` | A schedule added, then deleted |

## How they were recorded

They were recorded on 2026-10-25 (UTC) by Decaid's v0.9.0 Linux arm64
release (`decaid-linux-arm64-0.9.0.tar.gz`, SHA-256
`b76e64c89792cc3d7101ba211ecb81040fe353a46d353c7b0e73374f193970df`, as
`decaid-0.9.0-SHA256SUMS.txt` names it; `GET /info` answers `0.9.0+2977`,
commit `b9f9d055`), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago` and the `tzdata` package, Xvfb as its display, a D-Bus
system bus and Avahi running, started as `xvfb-run -a dbus-run-session --
decaid --serial --bypass-onboarding --no-account`, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected. Its data was new, as on a
fresh install. The script, `record.mjs`, ran on the host against the
container's published port 8080, one request after another:
`node server/test/fixtures/decaid/settings-writes-v0.9.0/record.mjs <output file>`.
It waited until `GET /machine/settings` answered 200, then 5 s more for
Decaid to write its defaults to the machine. It now waits 10 ms before each
request, which a fast host needs to stay under Decaid's limit of 256
requests a second from one client (`AdmissionGate`); the recording was made
without that wait. Decaid v0.9.1 answers every step and read the same
(`../simulated-devices-v0.9.1/README.md`). The wake schedules' times were
chosen away from the time of the recording, so no keep-awake time was
running, and `keepAwakeUntil` is null throughout.

The wake schedules' ids are those Decaid made (v4 UUIDs). The simulated
machine and scale are `MockDe1` and `MockScale`, the paths the container's,
and nothing names real hardware, so nothing is scrubbed.

## What they show

- **Answers.** The machine routes and `PUT /machine/calibration/{target}`
  answer 202 with no body (`jsonAccepted`), `POST /settings` 200 `null`,
  `POST /presence/settings` the two settings it holds, and a schedule its
  `toJson`, 201 when added, with the id Decaid gave it.
- **Refusals.** The machine routes refuse with `error`: a body that is not
  JSON or not an object, a refill kit setting other than 0, 1 or 2 (before
  any field is written), and a sensor write's values. `POST /settings`
  refuses a value with `message`, applying the fields before it in its order
  (`appSettingsPartChargingMode`, `appSettingsPartMorningTime`). The presence
  routes refuse with `error`, a schedule Decaid does not hold with 404 and
  its `id`. A value Decaid fails to read (a fan threshold of `"warm"`) or a
  `/settings` body that is not a JSON object is answered as shelf answers an
  uncaught error: 500, `Internal Server Error` as text.
- **Lenient reads.** `usb` turns on only for the text `"enable"`; `true`
  turns it off. A fan threshold of 42.9 is cut to 42, a steam flow of
  `"1.25"` is read as a number, scale power mode is read in any case, and an
  unknown log level is ignored. A sleep timeout is held to 0 to 240.
- **Heater voltage** is mapped as it is written: 200 is stored as 230, 1120
  (a DE1's 120 with 1000 added for a set value) as 120, and 300 as -1.
- **No machine.** The machine routes' reads and writes, and
  `GET /machine/state`, answer 500 with Decaid's `DeviceNotConnectedException`,
  after a body or refill kit setting Decaid refuses is refused with 400, and
  before a sensor write's zero `de1ReportedValue` is. `/settings` and the
  presence routes answer as with one; `keepAwakeUntil` is null without one.
- **Sensor calibration** is a correction, not a set: pressure's 9 corrected
  by 9/8 became 10.125, temperature's 93 corrected by 0.5 became 93.5.

## What the simulated machine does not show

Decaid's simulated machine (`MockDe1` in
`decaid:lib/src/models/device/impl/mock_de1/mock_de1.dart`) stores the values
it is sent as they are, and keeps no flush temperature, flush time-out or
tank temperature (it answers 25, 10 and 20 whatever is written). A DE1 holds
them in registers (`MMRItem` in
`decaid:lib/src/models/device/impl/de1/de1.models.dart`): Decaid writes a
value times the register's write scale, truncated (`_writeMMRScaled`), and
clamped to the register's bounds (`_writeMMRInt`), the fan threshold to 0 to
50 and the flow multiplier's register to 130 to 2000, and reads it back times
the read scale. So the recording writes only values a DE1 holds as they are,
and the simulated tablet, which acts as a DE1, answers them the same. It
takes the rest from Decaid's source: a flow multiplier of 1.001 is stored as
1, and one of 0.7 is read back as 0.7000000000000001 (700 times 0.001). A
sensor's calibration is held in signed Q16.16, as the calibration
characteristic carries it. And Decaid's defaults on each connect, which the
recording does not reconnect for: the fan threshold's default of 55 is
written to its register, which holds 50 (`_setDe1DefaultsFor` in
`decaid:lib/src/controllers/de1_controller.defaults.dart`; the simulated
machine kept 55, as `started` shows), and the refill kit is set to auto
(`UnifiedDe1.onConnect`).

Each machine route writes its fields one at a time, in the handler's order,
so a write can fail part-way, as when the machine does not take a
register's write in time. The simulated machine never fails one; the
simulated tablet's `failSettingWrites` does it.
