# DE1Pro's live streams on Decaid v0.9.0

Decaid's local streams on the test tablet, recorded for the Live View (#258)
in one supervised, read-only capture on 2026-10-27 (#259), and two Steam
Records from a second supervised capture that evening for #308 (the third
recording below), which made one write. The tablet ran Decaid 0.9.0+2977
(built from the v0.9.0 tag, commit `b9f9d055`), DYE2 0.1.26, the plugin
1.4.0, which stayed connected to its server throughout, and, in #259's
capture, Streamline's `dist` build `55bd37d`. Its DE1Pro was on firmware 1358, with a Bookoo Mini scale
and no milk probe. Its identity was confirmed with
`GET /api/v1/machine/info` first each time.

## How they were taken

`record.mjs` ran on a computer on the tablet's LAN. It opened these sockets
and sent nothing on them:

| Source | Socket |
|---|---|
| `machine` | `ws/v1/machine/snapshot` |
| `waterLevels` | `ws/v1/machine/waterLevels` |
| `scale` | `ws/v1/scale/snapshot` |
| `shotSettings` | `ws/v1/machine/shotSettings` |
| `devices` | `ws/v1/devices` |
| `shotState` | `ws/v1/machine/shotState`, which the Live View doesn't forward |

Its only request was `GET /api/v1/sensors` every 30 s, which listed no
sensor all along. The Steam Records were read afterwards with
`GET /api/v1/steams/latest` and `/api/v1/steams/{id}`, and every other request
to the tablet in the first two recordings was a `GET` too. The third made one
write (below). The machine socket sends what the
plugin's `stateUpdate` carries. Both are `MachineSnapshot.toJson()` of the
machine's `currentSnapshot`: `_handleSnapshot` in
`decaid:lib/src/services/webserver/de1handler.dart` sends one, and
`broadcastEvent('stateUpdate', …)` in
`decaid:lib/src/plugins/plugin_manager.dart` the other.

While the first recording ran, the owner worked the Machine, with Steam Purge
Mode Normal (`steamPurgeMode` 0):
- woke it and turned the scale on while it warmed up;
- took the tank out and refilled it;
- pulled a shot;
- steamed and pressed stop, letting the purge run;
- ran a flush;
- poured hot water;
- left it idle for 2 min;
- put it to sleep, and turned the Tablet's screen off with its power button.

A second recording took a steaming with Two Tap Stop (`steamPurgeMode` 1).
The owner set Two Tap Stop with a Settings Edit from the management interface,
tapped stop twice, and set Normal back the same way. It also holds an earlier
steaming with Normal, after the first attempt was put back as below, which ran
as the first recording's did; `trim.mjs` takes the one with `puffing`.
In Streamline's own settings page, choosing Two Tap Stop showed Normal again
at once, so it looked refused (decentespresso/streamline-js#175). Its
`onchange` stores the select's string `"1"`, and the page drawn again finds
no option equal to it, though the choice stays staged for saving. The first
attempt's Settings Edit held until that page next opened and put Normal back
(`checkMachineSettingsDrift`, the `putBackByStreamline` note in
`protocol/src/settings-fields.ts`), so the second left the page closed.
#259's capture itself wrote nothing to the tablet.

A third recording, later the same evening for #308, took two steamings with
Normal, to see how other stops end. It wasn't read-only: the owner authorized
one write, `PUT /api/v1/machine/state/idle`, which a script sent 10 s into the
first steaming's `pouring`. That's what Streamline's on-screen Stop sends on a
Machine without a group head controller. To stop at a milk temperature, Decaid
requests the same state (`requestMachineState(MachineState.idle)`, as that
route's handler does), except on a Bengle with its probe attached, which stops
in firmware (`_maybeAppSideStop` and `useFwAutonomousStop` in
`decaid:lib/src/controllers/steam_sequencer.dart`). This DE1Pro has a group
head controller (`GHC: true`), so Streamline hides that button. For the second steaming, the
owner set the Workflow's steam duration to 10 s on the Tablet and let the
Machine stop by itself. It puffed until the owner tapped stop on the group
head controller, then purged. The owner set 120 s back after it. Only the two
Steam Records are committed from it, parsed and written again as
`writeSteamRecord` in `trim.mjs` writes them. They named no Barista or
drinker.

`trim.mjs` cut the first two recordings, which aren't committed, into the
other fixtures and printed the rates below:

```sh
node server/test/fixtures/decaid/de1pro-live-v0.9.0/trim.mjs <recording> <Steam Record> \
  <Two Tap Stop recording> <Two Tap Stop Steam Record>
```

## Fixtures

Each fixture is `{ "frames": [...] }`. Each frame is `{ ms, source, frame }`:
- `ms`: when it arrived at the recording computer, in ms since the fixture's
  first frame. It came over Wi-Fi, so arrivals jitter by tens of ms.
- `source`: as in the table above.
- `frame`: Decaid's JSON as Decaid sent it, parsed and written again, as the
  plugin forwards it, so a number Decaid wrote as `4.0` reads `4`.

A `timestamp` in a machine, scale or shot state frame is the tablet's local
time without an offset (UTC-4, EDT), as Decaid writes it. A devices frame's
is UTC, ending in `Z` (`_buildSnapshot` in
`decaid:lib/src/services/webserver/devices_handler.dart`). The tablet's clock
and the recording computer's differ, so a `timestamp` and an arrival time
can't be compared.

| File | What it holds |
|---|---|
| `opening.json` | The frame each socket sent as it opened, the Machine asleep and the scale off: the latest snapshot, shot settings, devices, water levels and shot state, and the scale's `{"status":"disconnected"}` |
| `opening-scale-connected.json` | The same at the second recording's start, the scale on: its frame is `{"status":"connected"}`, and its weights follow live |
| `scale-connects.json` | The scale connecting while the Machine warmed up (`idle` / `preparingForShot`): `{"status":"connected"}`, then its weights |
| `wake.json` | The Machine waking: `sleeping`, then `idle` / `preparingForShot` for 18.7 s, until the group reached about 74 °C against its target of 84 °C, then 3 s of `idle` while it went on heating |
| `shot.json` | A shot: `espresso` with `preparingForShot` 2.9 s, `preinfusion` 7.7 s, `pouring` 23.8 s and `pouringDone` 4.2 s, with its `shotState` events and the scale's weights |
| `steam.json` | Steaming with Normal: `preparingForShot` 2 s, `pouring` 16.9 s, then `pouringDone` 6.3 s from the stop, holding the purge, then `idle` as the purge tails off |
| `steam-two-tap-stop.json` | Steaming with Two Tap Stop: `preparingForShot` 3.1 s, `pouring` 21.8 s, `puffing` 4.6 s after the first tap, `pouringDone` 4.8 s after the second, holding the purge, then `idle` |
| `flush.json` | A flush: `flush` / `pouring` 5 s |
| `hot-water.json` | Hot water: `hotWater` with `preparingForShot` 0.4 s and `pouring` 10.7 s |
| `needs-water.json` | The tank taken out and refilled, at the end of the first warm-up: `idle` / `preparingForShot` for 5.4 s, then `idle`. The tank's reading falls from 4.7 mm to 0, then nothing for 25.8 s, through 14.8 s of `needsWater` that began 12 s after the 0. Then `idle` as the refilled tank's reading climbs, to 32.3 mm in the window |
| `idle.json` | 30 s idle, ending 5 s before the Machine went to sleep |
| `asleep.json` | The Machine going to sleep: 5 s idle, then 30 s `sleeping` |
| `steam-record.json` | `GET /api/v1/steams/{id}` of `steam.json`'s steaming: 10 `preparingForShot`, 81 `pouring`, 30 `pouringDone` and 1 `idle` sample |
| `steam-record-two-tap-stop.json` | The same of `steam-two-tap-stop.json`'s: 15 `preparingForShot`, 105 `pouring`, 22 `puffing`, 23 `pouringDone` and 1 `idle` sample |
| `steam-record-idle-request.json` | The same of the third recording's first steaming, stopped by the `idle` request: 15 `preparingForShot`, 50 `pouring`, 33 `pouringDone` and 1 `idle` sample |
| `steam-record-timed-stop.json` | The same of its second, stopped on time: 12 `preparingForShot`, 66 `pouring`, 171 `puffing`, 37 `pouringDone` and 1 `idle` sample |

No socket closed in any recording, so each one's first frame is the one
it sent as it opened. Each activity's fixture, `wake.json` and
`scale-connects.json` run from 2 s before it to 3 s after it.
`needs-water.json` starts 4 s before the reading reached 0. The Steam
Records are whole, measurements included, with the ids Decaid gave them.

Edited: the Bluetooth addresses of the machine and the scale, in `devices`
frames, are replaced with `00:00:5E:00:53:01` and `00:00:5E:00:53:02`, as in
`../de1pro-v0.8.7/`. Nothing else held a hardware id, a LAN address or a
Barista's name.

## What was measured

Each source's frames a second, and all sources' throughput, over the first
recording, while the latest machine frame was in each state, as `trim.mjs`
prints them:

| State | Seconds | `machine` | `waterLevels` | `scale` | `devices` | `shotState` | `shotSettings` | `machine`'s median interval | KB/s |
|---|---|---|---|---|---|---|---|---|---|
| `sleeping` | 454 | 1.85 | 1.52 | 8.25 | 0.02 | 0.00 | 0.00 | 631 ms | 1.5 |
| `idle` / `preparingForShot` | 111 | 4.87 | 2.74 | 4.48 | 0.06 | 0.00 | 0.00 | 198 ms | 2.3 |
| `idle` | 315 | 5.09 | 4.40 | 9.93 | 0.02 | 0.00 | 0.00 | 197 ms | 2.9 |
| `needsWater` | 15 | 4.79 | 0.20 | 9.92 | 0.07 | 0.00 | 0.00 | 199 ms | 2.7 |
| `espresso` | 39 | 4.81 | 4.81 | 9.94 | 0.00 | 0.26 | 0.00 | 198 ms | 3.0 |
| `steam` | 25 | 4.80 | 4.80 | 9.91 | 0.00 | 0.00 | 0.00 | 199 ms | 2.8 |
| `flush` | 5 | 4.78 | 4.78 | 9.96 | 0.00 | 0.00 | 0.00 | 200 ms | 2.8 |
| `hotWater` | 11 | 4.78 | 4.78 | 9.93 | 0.00 | 0.00 | 0.00 | 198 ms | 2.9 |

- **Machine.** About 4.8 snapshots a second (200 ms apart) in every waking
  state, idle and warming up included, and 1.85 (631 ms apart) asleep. That's
  more than the 4 a second de1app's recordings suggest. The second
  recording's steaming ran at the same rate.
- **Water levels** are sent only when the reading changes: of 2,771 frames,
  1 repeats the one before. A level that holds still sends nothing, such as
  25.8 s at 0 mm with the tank out and 6.3 s at 4.79 mm asleep, so the rates
  above are the sensor's noise. Decaid sends every notification the DE1 makes
  (`waterLevels` in
  `decaid:lib/src/models/device/impl/de1/unified_de1/unified_de1.dart`). Only
  the frame sent as the socket opens covers a steady tank.
- **Scale.** About 10 a second while connected, whatever the Machine did,
  asleep included, after `{"status":"connected"}` as it connected. It was off
  for the first 77 s asleep and the first 61 s of warming up, which lowers its
  rates for those two.
- **Devices.** One frame as the socket opened, one on each change in the
  Tablet's connections (five while it scanned for the scale, found it and
  connected to it), and one a minute, as
  `BatteryController` checks the battery
  (`decaid:lib/src/controllers/battery_controller.dart`).
- **Shot settings.** Only the frame sent as the socket opened (`opening.json`):
  nothing changed them in the run. In the third recording, the socket sent a
  frame on each change of the steam duration, to 10 s and back to 120 s.
- **Shot state.** Only around the shot: 10 frames of its states and decisions.
- **Sizes.** A machine frame is about 310 to 335 bytes, a scale frame about
  105 to 115, water levels 43, a devices frame 718 and a shot state frame 352.
  Asleep with the scale on, all sources came to 1.7 KB/s.
- **Waking.** After each wake the Machine reported `idle` with
  `preparingForShot` for the first part of its warm-up: 111 s, 55.6 s and
  18.7 s after the three wakes recorded (`wake.json` holds the last). Decaid
  maps the DE1's heating substates to `preparingForShot`
  (`mapDe1SubToMachineSubstate` in
  `decaid:lib/src/models/device/impl/de1/de1.utils.dart`). Each time, the
  substate ended with the group at about 73.7 °C against its target of 84 °C.
  The group then went on heating under plain `idle`. It came within 1 °C of
  its target 50 to 58 s later, and reached it after 88 and 92 s; after the
  third wake, steaming began first. After the first wake the steam heater, at
  75 °C, took 108 s more to reach 150 °C. So `idle` doesn't mean the Machine is up to
  temperature: only the temperatures against their targets show that. A
  shot's own warm-up was `espresso` with `preparingForShot`, 2.9 s.
- **Water level and refill level.** For the first 106 s of the first
  warm-up, until the tank was taken out, it read 4.64 to 4.86 mm against a
  refill level of 5 mm, and the Machine didn't report `needsWater`. It did so
  12 s after the reading fell to 0 as the tank came out, until the refilled
  tank went back.
- **Going to sleep.** A `sleeping` frame arrived at once, 100 ms by Decaid's
  timestamps after the Tablet asked Decaid to put the Machine to sleep
  (`PUT /api/v1/machine/state/sleeping`, in Decaid's log). Snapshots kept
  coming every 630 ms, state `sleeping` and substate `idle`, with the
  temperatures still reported. The scale also kept sending, and water levels
  whenever the reading changed.
- **The Tablet's screen off.** From just after the Machine went to sleep at
  21:09:24 UTC, the Tablet's screen was off until after the first recording
  ended at 21:15:40. Every stream kept its rate. The management interface
  showed the Machine online in every poll of its server's
  `GET /api/machines/{id}` (75, 5 s apart, the last at 21:15:36). Its
  `lastSeenAt` moved on every 30 s throughout. This shows a plugged-in
  Tablet only: it was on the DE1's USB charger throughout (`usbChargerOn` in
  every devices frame), and Android doesn't put a device on power into Doze.
  The recording computer's open sockets may also have kept the Tablet's Wi-Fi
  awake, as a plugin streaming to a Live View would.
- **Steaming's stop.** No steaming reported `pausedSteam`.
  - **Normal:** stop turned `pouring` into `pouringDone`. Flow fell from 2.3
    ml/s to 0 over 3.3 s, then the purge ran at targets of 2 and then 4 ml/s.
    The state turned `idle` 6.3 s after the stop, at 2.8 ml/s, and the purge
    tailed off in `idle` over 2 s.
  - **Two Tap Stop:** the first tap set the target flow to 0. Flow fell over
    2 s still in `pouring`, then `puffing` held a target of 0.125 ml/s for
    4.6 s, a small puff about every 1.5 s. The second tap began
    `pouringDone`: flow fell for 2 s, then the purge ran as in Normal and
    tailed off in `idle`.
  - **An `idle` request** (the third recording) stopped steaming as a tap
    does in Normal: `pouringDone` at a target of 0 for 3.75 s as the flow
    fell, then the purge at targets of 2 and then 4 ml/s, then `idle`.
  - **On time** (the third recording, a steam duration of 10 s): the target
    flow went to 0 after 9.99 s of `pouring`, so the Machine counts its
    steam duration from `pouring`, not from `preparingForShot`. Flow fell
    over 3.8 s still in `pouring`, as after Two Tap Stop's first tap. Then
    `puffing` held a target of 0.125 ml/s for 35.6 s, until the owner tapped
    stop. The tap began `pouringDone`, 2.1 s at a target of 0, then the
    purge.
  - So `puffing` follows a stop that waits for the barista's tap: Two Tap
    Stop's first tap, or a stop on time. The purge is reported as
    `pouringDone` after every stop recorded. Each stop begins with a target
    flow of 0 while the flow falls, under `pouring` or `pouringDone`, and no
    substate of its own.
