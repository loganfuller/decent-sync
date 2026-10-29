# Simulated devices on Decaid v0.9.1

Responses from Decaid v0.9.1's API with its own simulated devices, for
decent-sync #372: its version, and the machine's settings as its simulated
machine was disconnected and connected again and as Decaid restarted, which
show the fan threshold and refill kit Decaid v0.9.1 keeps for a machine
(decentespresso/decaid#1043).

| File | Endpoint |
|---|---|
| `info.json` | `GET /api/v1/info` |
| `settings-reconnects.json` | Steps of writes, reconnects and restarts, each with the reads after it (below) |

## How they were recorded

They were recorded on 2026-10-29 (UTC) by Decaid's v0.9.1 Linux arm64
release (`decaid-linux-arm64-0.9.1.tar.gz`, SHA-256
`b048626001f6c6e1eff1b4941e12213f05cf6bed9a6b0a81cbf41f80fc081740`, as
`decaid-0.9.1-SHA256SUMS.txt` names it; `GET /info` answers `0.9.1+3027`,
commit `14361a94`), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago` and the `tzdata` package, Xvfb as its display, a D-Bus
system bus and Avahi running, started as `xvfb-run -a dbus-run-session --
decaid --serial --bypass-onboarding --no-account`, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected. Its data was new, as on a
fresh install. `record-settings-reconnects.mjs` ran on the host against the
container's published port 8080, one request after another:
`node server/test/fixtures/decaid/simulated-devices-v0.9.1/record-settings-reconnects.mjs <output file>`.
It waited until `GET /machine/settings` answered 200, then 5 s more for
Decaid to write what it keeps, or its defaults, to the machine, and did the
same after each connect and restart. Decaid was restarted with `pkill -x
decaid` and started again the same way, its data kept.

`info.json` is what the release answered, `localIp` empty in the container.
The simulated tablet answers `/info` from it (`de1ProOnDecaid091` in
`server/test/support/simulated-tablet.ts`).

The simulated machine is `MockDe1`, which reports serial `mock-de1`, and
nothing names real hardware, so nothing is scrubbed.

## Settings writes, unchanged

`../settings-writes-v0.9.0/record.mjs`, waiting 10 ms before each request
as it now does, ran against the same release on new data, in the same
container and time zone, before these. v0.9.1 answered
every step's requests and reads as `../settings-writes-v0.9.0/settings-writes.json`
holds them, but for `GET /machine/state`'s timestamp and temperatures, which
change with time, so they are not recorded again. The simulated tablet's
settings writes (`server/test/support/decaid-settings.ts`) follow both.

## Settings reconnects

`settings-reconnects.json` holds one step per change, in order, each
`{exchanges, reads}`: the requests the script sent, with the status and body
Decaid answered, then `GET /machine/settings` and
`/machine/settings/advanced`, each its status and body, whole.

| Step | What came before the reads |
|---|---|
| `started` | Nothing: Decaid as it started, once its simulated machine was connected |
| `written` | `POST /machine/settings` of a fan threshold of 45 and steam purge mode 1, and `POST /machine/settings/advanced` of an idle temperature of 96 and refill kit 1 (force on) |
| `disconnected` | `PUT /devices/disconnect` of `{"deviceId":"MockDe1"}`, then 3 s |
| `reconnected` | `PUT /devices/connect` of the same |
| `fanWritten` | `POST /machine/settings` of a fan threshold of 40 alone |
| `reconnectedAgain` | The machine disconnected, 3 s, and connected again |
| `restarted` | Decaid restarted, its data kept |
| `reset` | `DELETE /machine/settings/reset` |
| `restartedAfterReset` | Decaid restarted again, its data kept |

What they show:

- **Kept across a reconnect.** The fan threshold and refill kit last written
  through those routes are written again as the machine connects
  (`_setDe1DefaultsFor` in
  `decaid:lib/src/controllers/de1_controller.defaults.dart`): 45 and force on
  after `reconnected`, then 40 and force on after `reconnectedAgain`, each
  field kept on its own. v0.9.0 wrote 55 there, which a DE1's register holds
  as 50. The simulated machine keeps its other values across a reconnect, as
  a DE1 keeps its registers, and its refill kit too, as it does not set it
  to auto as it connects, which a DE1's connection does
  (`UnifiedDe1.onConnect`), so for the refill kit only the restart shows
  Decaid writing it.
- **Kept across a restart.** A restarted Decaid's new simulated machine
  starts with its own values (steam purge mode 0, idle temperature 98), and
  Decaid writes the 40 and force on it kept. It keeps nothing else.
- **Reset.** `DELETE /machine/settings/reset` answers 202, writes Decaid's
  defaults (fan threshold 55, idle temperature 95, warmup flow 2, test flow 4,
  test time-out 4, refill kit auto, steam purge mode 0 and a flow multiplier
  of 1) and clears what Decaid kept for the machine, so after the next
  restart the fan threshold is 55 again and the refill kit auto.
- **Where.** Decaid kept them in its own preferences
  (`SharedPreferencesMachineSettingsStore` in
  `decaid:lib/src/settings/machine_settings_store.dart`), on Linux
  `~/.local/share/decaid/shared_preferences.json`, under
  `flutter.machineSettings`: a JSON map from the machine, `serial:` and the
  serial it reported as it connected, or `device:` and its device id where
  that serial is empty or `0`, to its `fan`, `refillKit` and `updatedAt`.
  Read in the container, it held
  `{"serial:mock-de1":{"fan":40,"updatedAt":3,"refillKit":1}}` after
  `fanWritten`, and `{}` after `reset`. It holds at most 32 machines, dropping
  the one updated longest ago, and Decaid's backups leave it out, so a new
  tablet, or Decaid's data reset, starts again from Decaid's defaults.

`server/test/simulated-settings-writes.test.ts` replays the steps before
`reset` against the simulated tablet, comparing only the fan threshold and
refill kit after `restarted`: the plugin never resets the machine's
settings, and the simulated tablet does not restart Decaid, so it reconnects
the machine instead.
