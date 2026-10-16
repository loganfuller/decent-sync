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
tablet's app settings as they are now: the skin `streamline.js-dist`,
charging mode `longevity`, scale power mode `displayOff`, and a battery at
51% and not charging. The simulated tablet (`de1ProOnDecaid090` in
`server/test/support/simulated-tablet.ts`) answers `/info` and `/settings`
from here, and everything else from `../de1pro-v0.8.7/`.
