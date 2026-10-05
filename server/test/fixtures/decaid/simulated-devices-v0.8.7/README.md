# Simulated devices on Decaid v0.8.7

Responses from Decaid's API with its own simulated devices connected: a
machine (`MockDe1`), a scale (`MockScale`) and two sensors (`SensorBasket` and
`DebugPort`), and a second machine (`MockBengle`) only discovered nearby. The
test tablet has no sensors, and its scale was off, so these show what Decaid
reports for connected ones.

| File | Endpoint |
|---|---|
| `devices.json` | `GET /api/v1/devices`: the scale and `MockDe1` connected, `MockBengle` discovered |
| `devices-disconnected.json` | `GET /api/v1/devices` after `PUT /api/v1/devices/disconnect` for the scale and `MockDe1` |
| `sensors.json` | `GET /api/v1/sensors` |
| `scale-info.json` | `GET /api/v1/scale/info` with the scale connected |
| `machine-not-connected.json` | What `GET /api/v1/machine/settings`, `/machine/settings/advanced` and `/machine/info` answered, with status 500, once `MockDe1` was disconnected |
| `machine-settings.json` | `GET /api/v1/machine/settings` |
| `machine-settings-advanced.json` | `GET /api/v1/machine/settings/advanced` |
| `settings.json` | `GET /api/v1/settings` |
| `beans.json` | `GET /api/v1/beans?includeArchived=true` |
| `bean-batches.json` | `GET /api/v1/bean-batches?includeArchived=true` |
| `grinders.json` | `GET /api/v1/grinders?includeArchived=true` |
| `profiles.json` | `GET /api/v1/profiles?includeHidden=true`, trimmed |

They were recorded on 2026-10-05 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container with `TZ=America/Chicago`,
Xvfb as its display, and a D-Bus system bus and Avahi running, started as
`decaid --serial --bypass-onboarding --no-account`, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","bengle","scale","sensor"],"onboardingCompleted":true,"accountStepSeen":true}`.
With two machines found, Decaid connected neither until
`PUT /api/v1/devices/connect` chose `MockDe1`; the scale and sensors then
connected by themselves.

The library records were made through Decaid's API for these fixtures:
`POST /api/v1/beans` created `Fixture Archived Bean` and `Fixture Bean`,
`POST /api/v1/beans/{id}/batches` two batches of `Fixture Bean`, and
`POST /api/v1/grinders` `Fixture Grinder`; `PUT` with `{"archived": true}`
archived the first bean, the older batch and the grinder, and
`PUT /api/v1/profiles/{id}/visibility` hid the bundled `Default` profile.
The profiles are trimmed to `Default` and two other bundled ones.

The mock scale is not one of the scales that report device information
(only `Skale2Scale` does in v0.8.7), so `/scale/info` answers `{}` while it is
connected, and `503` with `{"error":"No scale connected"}` while none is, as
`de1pro-v0.8.7/scale-info-no-scale.json` shows. Sensor manifests list their
channels as `data`, not `dataChannels` as `rest_v1.yml` documents. The
simulated devices name no real hardware, so nothing is scrubbed. Decaid does
not remember simulated devices (`RememberedDevice`), so a disconnected one is
still listed as `available`.
