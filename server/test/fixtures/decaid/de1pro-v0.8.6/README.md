# DE1Pro on Decaid v0.8.6

Responses from Decaid's local API on the test tablet (a DE1Pro, Decaid
0.8.6+2801), read with `GET` requests on 2026-10-03:

| File | Endpoint |
|---|---|
| `info.json` | `GET /api/v1/info` |
| `machine-info.json` | `GET /api/v1/machine/info` |
| `settings.json` | `GET /api/v1/settings` |

Edited: the machine's serial number, the Bluetooth addresses of the preferred
machine and scale, and the tablet's LAN address are replaced with made-up
values (serial `10001`, addresses from the `00:00:5E:00:53:xx` documentation
range, IP from `192.0.2.0/24`). Everything else is as Decaid sent it.
