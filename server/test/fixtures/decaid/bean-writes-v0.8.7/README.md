# Bean writes on Decaid v0.8.7

What Decaid's API answers writes to beans, recorded as exchanges: each
request, and the status and body Decaid answered. The simulated tablet carries
out bean writes the same way (`server/test/support/decaid-beans.ts`), and
`server/test/simulated-bean-writes.test.ts` replays these requests against it.

| File | Exchanges |
|---|---|
| `bean-writes.json` | In order: `POST /api/v1/beans` with another plugin's key in `extras`; `PUT` keeping that key beside a global id, then `PUT` with the global id alone, which replaces `extras` whole; `POST` with every field Decaid's bean has; `POST` with `archived` and an unknown field, which are ignored; `PUT` clearing a field with null, then archiving; refusals: `POST` without a name or with a number for one, `PUT` to an unknown id, `PUT` with a null roaster and with a mistyped altitude; then `GET` of one bean and of the list with and without archived beans |

They were recorded on 2026-10-07 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago`, Xvfb as its display, and a D-Bus system bus and Avahi
running, started as `decaid --serial --bypass-onboarding --no-account`, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`.
Its library was empty, as on a fresh install. The requests were sent with
`Content-Type: application/json` from the host, through the container's
published port 8080, one after another.

The ids are those Decaid assigned, and its times are Chicago's local time
(UTC-5 that day) without an offset, to the microsecond. The names, global ids
and the other plugin's key (`bcUuid`, as DYE2 keeps a Beanconqueror id) were
made up for the recording; nothing names real hardware. `BeansHandler` and
`Bean` are unchanged in v0.8.8.

Decaid lists beans with the most recently updated first. A refused write
answers 400 with Dart's error message, or 404 for an unknown bean.
