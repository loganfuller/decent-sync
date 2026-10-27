# DE1Pro's live streams on Decaid v0.9.0

Decaid's local streams on the test tablet, recorded for the Live View (#258)
in one supervised, read-only capture on 2026-10-27 (#259). The tablet ran
Decaid 0.9.0+2977 (built from the v0.9.0 tag, commit `b9f9d055`), DYE2
0.1.26, Streamline's `dist` build `55bd37d` and the plugin 1.4.0, which stayed
connected to its server throughout. Its DE1Pro was on firmware 1358, with a
Bookoo Mini scale and no milk probe. Its identity was confirmed with
`GET /api/v1/machine/info` first.

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

Its only requests were `GET`s: `/api/v1/sensors` every 30 s, which listed no
sensor all along, then `/api/v1/steams/latest` and `/api/v1/steams/{id}` for
each Steam Record. The machine socket sends what the plugin's `stateUpdate`
carries. Both are `MachineSnapshot.toJson()` of the machine's
`currentSnapshot`: `_handleSnapshot` in
`decaid:lib/src/services/webserver/de1handler.dart` sends one, and
`broadcastEvent('stateUpdate', …)` in
`decaid:lib/src/plugins/plugin_manager.dart` the other.

While the first recording ran, the owner worked the Machine, with Steam Purge
Mode Normal (`steamPurgeMode` 0):
- woke it; it needed water for 15 s until it was refilled;
- pulled a shot;
- steamed and pressed stop, letting the purge run;
- ran a flush;
- poured hot water;
- left it idle for 2 min;
- put it to sleep, and turned the Tablet's screen off with its power button.

A second recording took one more steaming with Two Tap Stop
(`steamPurgeMode` 1). The owner set Two Tap Stop with a Settings Edit from the
management interface, tapped stop twice, and set Normal back the same way.
Streamline's own settings page couldn't set it: its `onchange` stores the
select's string `"1"`, and the page drawn again finds no option equal to it.
The first attempt's Settings Edit held until that page next opened and put
Normal back (`checkMachineSettingsDrift`, the `putBackByStreamline` note in
`protocol/src/settings-fields.ts`), so the second left the page closed. The capture itself wrote nothing to the
tablet.

`trim.mjs` cut the two recordings, which aren't committed, into the fixtures
and printed the rates below:

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

A `timestamp` in a frame is the tablet's local time without an offset
(UTC-4, EDT), as Decaid writes it. The tablet's clock and the recording
computer's differ, so a `timestamp` and an arrival time can't be compared.

| File | What it holds |
|---|---|
| `shot.json` | A shot: `espresso` with `preparingForShot` 2.9 s, `preinfusion` 7.7 s, `pouring` 23.8 s and `pouringDone` 4.2 s, with its `shotState` events and the scale's weights |
| `steam.json` | Steaming with Normal: `preparingForShot` 2 s, `pouring` 16.9 s, then `pouringDone` 6.3 s from the stop, holding the purge, then `idle` as the purge tails off |
| `steam-two-tap-stop.json` | Steaming with Two Tap Stop: `preparingForShot` 3.1 s, `pouring` 21.8 s, `puffing` 4.6 s after the first tap, `pouringDone` 4.8 s after the second, holding the purge, then `idle` |
| `flush.json` | A flush: `flush` / `pouring` 5 s |
| `hot-water.json` | Hot water: `hotWater` with `preparingForShot` 0.4 s and `pouring` 10.7 s |
| `needs-water.json` | `needsWater` for 14.8 s at wake, the tank at 4.8 mm against a refill level of 5 mm, then `idle` as it was refilled to about 34 mm |
| `idle.json` | 30 s idle, ending 5 s before the Machine went to sleep |
| `asleep.json` | The Machine going to sleep: 5 s idle, then 30 s `sleeping` |
| `steam-record.json` | `GET /api/v1/steams/{id}` of `steam.json`'s steaming: 10 `preparingForShot`, 81 `pouring`, 30 `pouringDone` and 1 `idle` sample |
| `steam-record-two-tap-stop.json` | The same of `steam-two-tap-stop.json`'s: 15 `preparingForShot`, 105 `pouring`, 22 `puffing`, 23 `pouringDone` and 1 `idle` sample |

Each activity's fixture runs from 2 s before it to 3 s after it. The Steam
Records are whole, measurements included, with the ids Decaid gave them.

Edited: the Bluetooth addresses of the machine and the scale, in `devices`
frames, are replaced with `00:00:5E:00:53:01` and `00:00:5E:00:53:02`, as in
`../de1pro-v0.8.7/`. Nothing else held a hardware id, a LAN address or a
Barista's name.

## What was measured

Each source's frames a second, over the first recording, while the latest
machine frame was in each state, as `trim.mjs` prints them:

| State | Seconds | `machine` | `waterLevels` | `scale` | `devices` | `shotState` | `shotSettings` | `machine`'s median interval |
|---|---|---|---|---|---|---|---|---|
| `sleeping` | 454 | 1.85 | 1.52 | 8.25 | 0.02 | 0.00 | 0.00 | 631 ms |
| `idle` | 426 | 5.03 | 3.97 | 8.51 | 0.03 | 0.00 | 0.00 | 197 ms |
| `needsWater` | 15 | 4.79 | 0.20 | 9.92 | 0.07 | 0.00 | 0.00 | 199 ms |
| `espresso` | 39 | 4.81 | 4.81 | 9.94 | 0.00 | 0.26 | 0.00 | 198 ms |
| `steam` | 25 | 4.80 | 4.80 | 9.91 | 0.00 | 0.00 | 0.00 | 199 ms |
| `flush` | 5 | 4.78 | 4.78 | 9.96 | 0.00 | 0.00 | 0.00 | 200 ms |
| `hotWater` | 11 | 4.78 | 4.78 | 9.93 | 0.00 | 0.00 | 0.00 | 198 ms |

- **Machine.** About 4.8 snapshots a second (200 ms apart) in every waking
  state, idle included, and 1.85 (631 ms apart) asleep. That's more than the 4
  a second de1app's recordings suggest. The second recording's steaming ran at
  the same rate.
- **Water levels.** With most snapshots while awake, about 1.5 a second
  asleep, and 3 frames in 15 s while the Machine needed water.
- **Scale.** About 10 a second while connected, whatever the Machine did,
  asleep included, after `{"status":"connected"}` as it connected. It was off
  for the first 77 s asleep, which lowers its rates for `sleeping` and `idle`
  above.
- **Devices.** One frame as the socket opened, then one a minute, as
  `BatteryController` checks the battery
  (`decaid:lib/src/controllers/battery_controller.dart`).
- **Shot settings.** Only the frame sent as the socket opened: nothing changed
  them in the run.
- **Shot state.** Only around the shot: 10 frames of its states and decisions.
- **Sizes.** A machine frame is about 310 to 335 bytes, a scale frame about
  105 to 115, water levels 43, a devices frame 718 and a shot state frame 352.
  All sources together came to about 3.1 KB/s during the shot, 2.7 KB/s idle
  and 1.9 KB/s asleep.
- **Going to sleep.** A `sleeping` frame arrived at once, 100 ms by Decaid's
  timestamps after the Tablet asked Decaid to put the Machine to sleep
  (`PUT /api/v1/machine/state/sleeping`, in Decaid's log). Snapshots kept
  coming every 630 ms, state `sleeping` and substate `idle`, with the
  temperatures still reported. Water levels and the scale also kept coming.
- **The Tablet's screen off.** From just after the Machine went to sleep at
  21:09:24 UTC, the Tablet's screen was off until after the first recording
  ended at 21:15:20. Every stream kept its rate. The management interface
  showed the Machine online in every poll of its server's
  `GET /api/machines/{id}` (75, 5 s apart). Its `lastSeenAt` moved on every
  30 s throughout. The recording computer's open sockets may have kept the
  Tablet's Wi-Fi awake, as a plugin streaming to a Live View would.
- **Steaming's stop.** Neither mode reported `pausedSteam`.
  - **Normal:** stop turned `pouring` into `pouringDone`. Flow fell from 2.3
    ml/s to 0 over 3.3 s, then the purge ran at targets of 2 and then 4 ml/s.
    The state turned `idle` 6.3 s after the stop, at 2.8 ml/s, and the purge
    tailed off in `idle` over 2 s.
  - **Two Tap Stop:** the first tap set the target flow to 0. Flow fell over
    2 s still in `pouring`, then `puffing` held a target of 0.1 ml/s for
    4.6 s, a small puff about every 1.5 s. The second tap began
    `pouringDone`: flow fell for 2 s, then the purge ran as in Normal and
    tailed off in `idle`.
  - So `puffing` is the pause between the two taps. The purge is reported as
    `pouringDone` in either mode.
