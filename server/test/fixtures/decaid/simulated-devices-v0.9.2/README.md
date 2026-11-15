# Simulated devices on Decaid v0.9.2

Responses from Decaid v0.9.2's API with its own simulated devices, for
decent-sync #549: its version; the machine's settings and flow calibration
as its simulated machine was disconnected and connected again, as Decaid
restarted and as it reset the machine's settings, which show the fan
threshold, refill kit and flow multiplier Decaid v0.9.2 keeps for a machine;
and its answers to the changes of its own settings that need a token.

| File | Endpoint |
|---|---|
| `info.json` | `GET /api/v1/info` |
| `settings-reconnects.json` | Steps of writes, reconnects, restarts and a reset, each with the reads after it (below) |
| `settings-gate.json` | Steps of `POST /api/v1/settings`, without a token and with one, each with the reads after it (below) |

## How they were recorded

They were recorded on 2026-11-15 (UTC) by Decaid's v0.9.2 Linux arm64
release (`decaid-linux-arm64-0.9.2.tar.gz`, SHA-256
`a2c5d0bb8c54a53bbb4923c5427f3a3a2bd6d9daaad56f78a25fb2b80e233016`, as
`decaid-0.9.2-SHA256SUMS.txt` names it; `GET /info` answers `0.9.2+3191`,
commit `875b7a6a`), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago` and the `tzdata` package, Xvfb as its display, a D-Bus
system bus and Avahi running, started as `xvfb-run -a dbus-run-session --
decaid --serial --bypass-onboarding --no-account`, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected, and with
`DECAID_EXTENSIONS_TOKEN` in its environment set to 64 hexadecimal
characters from `openssl rand -hex 32`: the token Decaid then takes for
managing its plugins and Skins, for as long as it runs. Decaid ignores one
shorter than 32 characters. Its data was new, as on a fresh install, once its
bundled Skins were installed (`GET /webui/skins` listed `insight`).

`record.mjs` ran on the host against the container's published port 8080,
one request after another, with the same token in its own environment:
`DECAID_EXTENSIONS_TOKEN=<token> node server/test/fixtures/decaid/simulated-devices-v0.9.2/record.mjs <settings-reconnects output> <settings-gate output>`.
It waited until `GET /machine/settings` answered 200, then 5 s more for
Decaid to write what it keeps, or its defaults, to the machine, and did the
same after each connect and restart. It recorded `settings-gate.json` first,
then `settings-reconnects.json`. Decaid was restarted with `pkill -x decaid`
and started again the same way, its data kept.

`info.json` is what the release answered, `localIp` empty in the container.
The simulated tablet answers `/info` from it (`de1ProOnDecaid092` in
`server/test/support/simulated-tablet.ts`).

The simulated machine is `MockDe1`, which reports serial `mock-de1`, the
paths are the container's, and nothing names real hardware, so nothing is
scrubbed. The token is in neither file: a request that carried one names
which, `"token": "launch"` for Decaid's own and `"token": "unknown"` for 64
zeros, which Decaid does not know.

## Settings writes, unchanged

`../settings-writes-v0.9.0/record.mjs` ran against the same release on new
data, in the same container, before these. v0.9.2 answered every step's
requests and reads as `../settings-writes-v0.9.0/settings-writes.json` holds
them, but for `GET /machine/state`'s timestamp and temperatures, which
change with time, and the ids it gave the wake schedules, so they are not
recorded again. Those steps hold the flow calibration route's answers: 202
to a flow multiplier, 400 to a body that is a list, and 500 with no machine
connected. The simulated tablet's settings writes
(`server/test/support/decaid-settings.ts`) follow both.

## Settings reconnects

`settings-reconnects.json` holds one step per change, in order, each
`{exchanges, reads}`: the requests the script sent, with the status and body
Decaid answered, then `GET /machine/settings`, `/machine/settings/advanced`
and `/machine/calibration`, each its status and body, whole.

| Step | What came before the reads |
|---|---|
| `started` | Nothing: Decaid as it started, once its simulated machine was connected |
| `written` | `POST /machine/settings` of a fan threshold of 45 and steam purge mode 1, `POST /machine/settings/advanced` of an idle temperature of 96 and refill kit 1 (force on), and `POST /machine/calibration` of a flow multiplier of 1.2 |
| `disconnected` | `PUT /devices/disconnect` of `{"deviceId":"MockDe1"}`, then 3 s |
| `reconnected` | `PUT /devices/connect` of the same |
| `fanWritten` | `POST /machine/settings` of a fan threshold of 40 alone |
| `reconnectedAgain` | The machine disconnected, 3 s, and connected again |
| `restarted` | Decaid restarted, its data kept |
| `reset` | `DELETE /machine/settings/reset` |
| `restartedAfterReset` | Decaid restarted again, its data kept |

What they show:

- **Kept across a reconnect.** The fan threshold, refill kit and flow
  multiplier last written through those routes are written again as the
  machine connects (`_setDe1DefaultsFor` in
  `decaid:lib/src/controllers/de1_controller.defaults.dart`), each kept on
  its own: 45, force on and 1.2 after `reconnected`, then 40, force on and
  1.2 after `reconnectedAgain`. The simulated machine keeps its values across
  a reconnect, as a DE1 keeps its registers, so for the refill kit and the
  flow multiplier only the restart shows Decaid writing them.
- **Kept across a restart.** A restarted Decaid's new simulated machine
  starts with its own values (steam purge mode 0, idle temperature 98, and a
  flow multiplier of 1, as `started` reads it), and Decaid writes the 40,
  force on and 1.2 it kept. It keeps nothing else of these routes.
- **Reset.** `DELETE /machine/settings/reset` answers 202 and writes
  Decaid's defaults (fan threshold 55, idle temperature 95, warmup flow 2,
  test flow 4, test time-out 4, refill kit auto and steam purge mode 0). It
  writes no flow multiplier, where v0.9.1 wrote 1: the machine still holds
  1.2. It clears the fan threshold and refill kit Decaid kept for the
  machine and keeps the flow multiplier (`clearResetOverrides` in
  `decaid:lib/src/settings/machine_settings_store.dart`), so after the next
  restart the fan threshold is 55 again, the refill kit auto, and the flow
  multiplier 1.2 on a new simulated machine that started at 1.
- **Where.** Decaid kept them in its own preferences
  (`SharedPreferencesMachineSettingsStore`), on Linux
  `~/.local/share/decaid/shared_preferences.json`, under
  `flutter.machineSettings`: a JSON map from the machine, `serial:` and the
  serial it reported as it connected, or `device:` and its device id where
  that serial is empty or `0`, to its `fan`, `refillKit`, `flowCalibration`
  and `updatedAt`. Read in the container, it held
  `{"serial:mock-de1":{"fan":40,"updatedAt":4,"refillKit":1,"flowCalibration":1.2}}`
  before `restarted`, and `{"serial:mock-de1":{"flowCalibration":1.2,"updatedAt":4}}`
  after `reset`. Decaid keeps the water refill level written through
  `POST /machine/waterLevels` there too (`refillLevel`), which these steps
  do not write.

`server/test/simulated-settings-writes.test.ts` replays every step against
the simulated tablet. Its machine holds a fan threshold of 55 as 50, as a
DE1's register does, and it does not restart Decaid, so it reconnects the
machine instead and compares only what Decaid keeps there.

## The changes that need a token

`settings-gate.json` holds one step per `POST /settings`, in order, each
`{exchanges, reads}` as above, its reads `GET /settings` and
`GET /webui/skins/default`, whole.

| Step | What it sent | Token | Answer |
|---|---|---|---|
| `started` | Nothing | | |
| `updateChecksOnWhileOn` | `automaticUpdateCheck` true, while it is on | None | 200 |
| `updateChecksOff` | `automaticUpdateCheck` false | None | 200 |
| `updateChecksOnRefused` | Theme `dark` and `automaticUpdateCheck` true | None | 401, `Missing or malformed bearer token` |
| `updateChecksOnUnknownToken` | The same | One Decaid does not know | 401, `Invalid token` |
| `sameSkin` | `defaultSkinId` as it is, `streamline.js` | None | 200 |
| `skinRefused` | Keep awake off and `defaultSkinId` `insight` | None | 401 |
| `webUiPathRefused` | Keep awake off and `webUiPath` as it is | None | 401 |
| `updateChecksOnWithToken` | Theme `dark` and `automaticUpdateCheck` true | Decaid's | 200 |
| `skinWithToken` | `defaultSkinId` `insight` | Decaid's | 200 |
| `skinBackWithToken` | `defaultSkinId` `streamline.js` | Decaid's | 200 |
| `webUiPathWithToken` | `webUiPath` as it is | Decaid's | 200 |

What they show (`SettingsHandler` in
`decaid:lib/src/services/webserver/settings_handler.dart`, and
`extension_management_auth.dart` beside it):

- **Three changes need a token.** A body that turns `automaticUpdateCheck`
  on while it is off, changes `defaultSkinId`, or holds `webUiPath`,
  whatever its value, is answered 401 where the request carries no bearer
  token, or one Decaid does not know, and taken with one scoped
  `extensions:manage`. A token Decaid knows that lacks the scope is answered
  403 in its source, which is not recorded. Turning the checks off, turning them on
  while they are on, and naming the default Skin as it is need none.
- **Nothing of a refused body is applied.** The theme and keep awake sent
  beside the refused keys stayed as they were: the reads after each 401 are
  the reads before it.
- **Off stays off without a token.** After `updateChecksOff`, only
  `updateChecksOnWithToken` turned the checks on again. A plugin's `fetch`
  carries no token, which is why Decent Sync shows the setting and no longer
  edits it (ADR-0023).

The routes that manage plugins and Skins answer the same 401 without a
token, with a `WWW-Authenticate: Bearer` header. Checked on this release
and not recorded: `POST /plugins/update`,
`POST /plugins/install/github-release` and
`POST /plugins/{id}/settings` answered 401 without the token, the first two
200 with it, and `GET /plugins`, `/webui/skins`, `/webui/skins/default` and
`/webui/server/status` answered 200 without one.

`server/test/simulated-settings-writes.test.ts` replays the steps sent
without a token against the simulated tablet, which knows no token, and
stops at the first sent with Decaid's.

## A refill kit that gave up

Decaid v0.9.2 reports a refill kit that gave up as the substate
`refillStopped` under `needsWater` (`decaid:assets/api/websocket_v1.yml`),
from the firmware's substate `0x11` (`mapDe1SubToMachineSubstate` in
`decaid:lib/src/models/device/impl/de1/de1.utils.dart`). Its simulated
machine never reports it, so no state report with it is recorded. The
Machine State reads "Needs water · Refill stopped"
(`protocol/test/machine-states.test.ts`).
