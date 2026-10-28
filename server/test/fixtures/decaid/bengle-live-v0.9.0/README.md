# Simulated Bengle's live streams on Decaid v0.9.0

What Decaid v0.9.0's local sockets and sensor routes sent with its simulated
Bengle (`MockBengle`) and its milk probe, for the Live View's milk
temperature and a Bengle's scale (#265). The test tablet's DE1Pro has no
milk probe, and no real Bengle was recorded.

| File | What |
|---|---|
| `sensors.json` | `GET /api/v1/sensors`: `attached`, as the recording began, listing the milk probe; `machineDisconnected`, once the Bengle was disconnected, `[]` |
| `steam.json` | The Live View's sockets through 3 s idle, 8 s of steaming and 3 s idle, in the Live View's fixture form, `{ "frames": [{ ms, source, sensorId?, frame }] }`, `ms` since the sockets opened: `machine`, `waterLevels`, `scale`, `shotSettings`, `devices`, and `sensor`, the probe's `ws/v1/sensors/{id}/snapshot`, with its id |
| `probe-socket.json` | The probe's socket opened again 3 s after steaming ended, for 2 s (`opening`), and opened while the Bengle was disconnected (`notFound`), each with how it closed |

They were recorded on 2026-10-28 by Decaid's v0.9.0 Linux arm64 release
(`decaid-linux-arm64-0.9.0.tar.gz`, as `../simulated-devices-v0.9.0/`
records), run headless in a throwaway Ubuntu 24.04 container with `tzdata`
and `TZ=America/Toronto`, Xvfb as its display, and a D-Bus system bus and
Avahi running. It was started as `decaid --serial --bypass-onboarding
--no-account`, with new data and `~/.local/share/decaid/shared_preferences.json`
set to
`{"simulateDevices":["bengle"],"onboardingCompleted":true,"accountStepSeen":true}`.
The Bengle connected by itself within about 10 s, with its probe attached,
as `MockBengle` starts one, and its own scale, `Bengle scale`. `record.mjs`
ran on the host against the container's published port 8080, and wrote
these files. It sends only `GET` requests, and the `PUT` requests its
comment names.

What they show:
- **Finding the probe.** Decaid lists it at `GET /api/v1/sensors` as
  `<the Bengle's device id>-milkprobe`, named `Bengle Milk Probe`, with
  `timestamp` and `temperature` (°C) data channels (`BengleMilkProbe` in
  `decaid:lib/src/models/device/impl/bengle/bengle_milk_probe.dart`), only
  while the Bengle is connected and its probe attached
  (`BengleProbeBridge`).
- **Its readings.** One with each machine snapshot while steaming, sent
  just after it, every 500 to 600 ms: `{ "timestamp", "temperature" }`, the
  timestamp Toronto's local time without an offset, as the machine
  snapshots' are. The simulated probe reads 4 °C rising 5 °C a second
  (`MockBengle._tickProbeTemperature`), so its 13 readings run from 7 °C to
  40.5 °C, and it sends none while idle. A real Bengle reads its probe with
  each of its own samples (`Bengle._handleProbeSample`).
- **Its socket.** It sends nothing as it opens until the probe has read, and
  then its last reading, however old: `opening` holds the reading taken as
  steaming ended, 3 s before. The socket stays open, silent, while the
  Bengle is disconnected; one opened then sends `{"error":"not found"}` and
  closes at once, without a status (`SensorsHandler` in
  `decaid:lib/src/services/webserver/sensors_handler.dart`).
- **Its scale.** The Bengle's own scale reports a battery of 100, with each
  machine snapshot (`MockBengle._emit`; a real Bengle's,
  `IntegratedScaleCapability`, does the same). The device list names it
  `Bengle scale`, its id `bengle-internal-` and the Bengle's device id.
- **Steaming.** The simulated Bengle steams at zero flow and pressure, under
  the substate `idle`, as the spec of #258 says Decaid's simulated machine
  does; it was stopped with `PUT /api/v1/machine/state/idle`, as its
  Workflow set no milk temperature to stop at.

Decaid's simulated Bengle didn't connect again after the disconnect
(`PUT /api/v1/devices/connect` answered 503, `machineConnectFailed`, in a
first run): `MockBengle.onDisconnect` closes its streams for good. So
nothing here shows a probe attached again; the simulated tablet lists it
again when a test attaches it (`attachMilkProbe` in
`server/test/support/simulated-tablet.ts`).

The Bengle's device id, `MockBengle`, a Connection Id, is replaced with the
made-up `00:00:5E:00:53:21` wherever it is part of an id (`record.mjs`,
`scrub`), so the probe is `00:00:5E:00:53:21-milkprobe`, as a Bluetooth
Bengle's is its address followed by `-milkprobe`. The device list's `name`
stays `MockBengle`. The simulated Bengle reports serial `mock-bengle` and
names no real hardware.
