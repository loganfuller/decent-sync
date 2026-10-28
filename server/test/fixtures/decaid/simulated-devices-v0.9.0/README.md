# Simulated devices on Decaid v0.9.0

Responses from Decaid v0.9.0's API with its own simulated devices: the app
settings beside the devices `../simulated-devices-v0.8.7/` records, and a
Shot pulled by the simulated machine, which shows the grinder's burrs Decaid
copies onto a Shot as it stores it. Also its local sockets as its simulated
machine was disconnected and connected again (Machine disconnects, below).

| File | Endpoint |
|---|---|
| `settings.json` | `GET /api/v1/settings`, with the devices connected as in `../simulated-devices-v0.8.7/` |
| `shot-grinder-burrs-setup.json` | Exchanges, in order: `POST /api/v1/grinders` of `Fixture Flat` with the burrs `Fixture 64mm flat`, and of `Fixture Conical` with `Fixture 83mm conical`; `PUT /api/v1/workflow` of a `context` naming `Fixture Flat` by its id and model, with `grinderBurrs` `Inherited burrs`, as a repeated Shot would bring, and the setting `12`; `PUT /api/v1/machine/state/espresso`, which started the Shot |
| `shot-grinder-burrs.json` | `GET /api/v1/shots/{id}` of that Shot, once it ran for about 10 s and the machine was idle again |

They were recorded on 2026-10-16 by Decaid's v0.9.0 Linux arm64 release
(`decaid-linux-arm64-0.9.0.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago` and, unlike the v0.8.7 recordings, the `tzdata`
package, so its `TZ` applied. Xvfb was its display, a D-Bus system bus and
Avahi were running, and it was started as `decaid --serial
--bypass-onboarding --no-account`. Its data was new, as on a fresh install.
For the Shot, `~/.local/share/decaid/shared_preferences.json` was set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected. For `settings.json`
Decaid was then restarted with `"simulateDevices"` set to
`["machine","bengle","scale","sensor"]`, as for `../simulated-devices-v0.8.7/`:
with two machines found, it connected neither until
`PUT /api/v1/devices/connect` with `{"deviceId":"MockDe1"}` chose `MockDe1`,
and the scale and sensors then connected by themselves. The requests were
sent with `Content-Type: application/json` from the host, through the
container's published port 8080, one after another.

`settings.json` differs from `../simulated-devices-v0.8.7/settings.json` only
in `preferredGrinderDeviceId`, null, which v0.9.0 added; the simulated
tablet (`simulatedDevices()` in `server/test/support/simulated-tablet.ts`)
answers `/settings` from here, and the devices from v0.8.7's recording.

The Shot's Workflow carries `grinderBurrs` `Fixture 64mm flat`, not the
Workflow's `Inherited burrs`: Decaid replaced them with those of the grinder
its `grinderId` names as it stored the Shot
(`PersistenceController.persistShot` in
`decaid:lib/src/controllers/persistence_controller.dart`). The Shot is whole,
its 46 samples untrimmed. Its `timestamp` and sample times are the
container's local time, America/Chicago's (UTC-5), without an offset, as
Decaid writes them; `createdAt` and `updatedAt` are UTC. The ids are those
Decaid assigned, and the grinders and burrs were made up for the recording.
The simulated machine reports serial `mock-de1` and names no real hardware,
so nothing is scrubbed.

## Machine disconnects

`machine-disconnects.json` holds what Decaid's local sockets sent as its
simulated machine was disconnected from the tablet and connected again, for
the Live View's line saying a Tablet isn't connected to its Machine (#264).
The test tablet's capture (`../de1pro-live-v0.9.0/`) never lost its machine.
It is in the Live View's fixture form, `{ "frames": [{ ms, source, frame }] }`,
`ms` since the first frame, from the same sockets as there: `machine`,
`waterLevels`, `scale`, `shotSettings` and `devices`.

It was recorded on 2026-10-28 by the same release and checksum as above, in
a throwaway Ubuntu 24.04 container with `tzdata` and `TZ=America/Toronto`,
started the same way with new data and `"simulateDevices"` set to
`["machine","scale"]`, which connected `MockDe1` and `Mock Scale` by
themselves. `record-machine-disconnects.mjs` ran on the host against the
container's published port 8080. It opened the sockets, then 4 s later sent
`PUT /api/v1/devices/disconnect` with `{"deviceId":"MockDe1"}`, and 8 s after
that `PUT /api/v1/devices/connect` with the same body, and recorded 8 s more.
Both answered 200. Between them, `GET /api/v1/machine/info` answered 500,
`DeviceNotConnectedException: machine not connected`.

What it shows:
- **Devices.** Three device lists: as the socket opened, with `MockDe1`
  `connected`; 0.5 s after the disconnect, still listing it but `disconnected`,
  with `connectionStatus.phase` `idle`; and 0.1 s after the connect, `connected`
  again, phase `ready`. The scale stayed `connected` throughout. A device
  list's `timestamp` is UTC.
- **The machine.** Its snapshots, every 500 to 600 ms, stopped at the
  disconnect and started again with the connect, as did the water levels,
  sent every second. Shot settings came as the socket opened and again as the
  machine connected. No socket closed.
- **The scale** went on sending, five frames a second.

The simulated machine and scale name no real hardware, so nothing is
scrubbed. Machine snapshots' `timestamp` is Toronto's local time, without an
offset.

