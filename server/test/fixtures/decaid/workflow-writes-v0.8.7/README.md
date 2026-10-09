# Workflow writes on Decaid v0.8.7

What Decaid's API answers writes to the Workflow, recorded as exchanges: each
request, and the status and body Decaid answered, its JSON parsed (Dart writes
a whole double such as `10.0`, which reads back as `10`). The simulated tablet
carries out workflow writes the same way
(`server/test/support/decaid-workflow.ts`), and
`server/test/simulated-workflow-writes.test.ts` replays these requests against
it.

| File | Exchanges |
|---|---|
| `workflow-writes.json` | In order, with the simulated machine connected: `GET /api/v1/workflow`. `PUT /api/v1/workflow` with only a steam flow, merged field by field. `PUT` with new values for every field of `steamSettings`, `hotWaterData` and `rinseData`, a field Decaid does not know in `hotWaterData` and an unknown top-level key, which are both dropped; the same body again, which changes nothing. Turning steam off with a target temperature of 0, on again at 135, then back to 150. A whole number for steam flow, a double, and a fraction for hot water duration, an int, which is cut to 30. Refusals, each 400: `steamSettings` null, a null steam flow, `steamSettings` a number, a string for hot water volume, a body that is an array. Between them `hotWaterData` null, which answers 200 and resets hot water to Decaid's defaults. Then `GET`. With the machine disconnected: `GET`; `PUT` of a steam flow, which answers 500 at once and changes nothing; `PUT` of only `context.targetYield`, which answers 200; `GET`; `PUT` of only `steamSettings.stopAtTemperature`, which answers 200, as it is not written to the machine; `GET` |

They were recorded on 2026-10-09 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago`, Xvfb as its display, and a D-Bus system bus and Avahi
running, started as `decaid --serial --bypass-onboarding --no-account`, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`.
Its data was new, as on a fresh install, so the Workflow began as Decaid's
default. The requests were sent with `Content-Type: application/json` from the
host, through the container's published port 8080, one after another. Before
the last six, the simulated machine was disconnected with
`PUT /api/v1/devices/disconnect` and `{"deviceId":"MockDe1"}`, which answered
200 with no body; that request is not in the file. Decaid did not reconnect
it.

The Workflow's id is the one Decaid assigned, and it stays the same across
every write. The unknown fields were made up for the recording. Decaid's
simulated machine reports no serial here, and the Workflow carries no
`machine` field, so there was nothing to scrub; nothing names real hardware.
`WorkflowHandler`, `Workflow`, `deepMergeJson` and
`De1Controller.updateWorkflowSettings` are unchanged in v0.8.8.

Decaid deep-merges the body into the current Workflow, rebuilds the Workflow
from the result, and answers the whole Workflow. Rebuilding it drops any field
it does not know, at any level. Ints and doubles are read leniently: a whole
number is taken for a double, and a fraction for an int is cut toward zero.
A string that is not a number is refused with Dart's parse error. Decaid
refuses null only for `steamSettings`, its fields and `context`. A null
`hotWaterData` or `rinseData` is merged in as null and rebuilt as Decaid's
defaults (hot water 75 degrees, 30 s, 50 ml, flow 10; rinse 90 degrees, 10 s,
flow 6), which are then written to the machine.

Decaid writes steam, hot water and rinse settings to the machine only when
they change, and only the parts that changed. `stopAtTemperature` is not
written to the machine and does not count as a change. A steam target below
135 is written to the machine as 0, steam off, but the Workflow keeps the
value sent (`De1Controller._writeSteamSettings`). With no machine connected,
a write that would reach the machine answers 500 with
`DeviceNotConnectedException` at once, and the Workflow is left unchanged.
Decaid's source waits up to 10 s for a machine only when it disconnects while
the write is queued, and then answers 503; that was not recorded. A write
that needs no machine, such as one to `context`, succeeds without one.
