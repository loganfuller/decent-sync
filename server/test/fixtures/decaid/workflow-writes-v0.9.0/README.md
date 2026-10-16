# Workflow writes on Decaid v0.9.0

What Decaid v0.9.0's API answers writes to the grinder's burrs in the
Workflow's context (`grinderBurrs`, which v0.9.0 added), recorded as
exchanges: each request, and the status and body Decaid answered, its JSON
parsed. Every other Workflow write is answered as
`../workflow-writes-v0.8.7/` records. The simulated tablet carries out
workflow writes the same way (`server/test/support/decaid-workflow.ts`, whose
`CONTEXT` includes `grinderBurrs`), and
`server/test/simulated-workflow-writes.test.ts` replays these requests
against it.

| File | Exchanges |
|---|---|
| `workflow-burrs-writes.json` | In order, with the simulated machine connected throughout: `GET /api/v1/workflow`, Decaid's default Workflow. `PUT /api/v1/workflow` of a `context` setting a grinder's id, the model `Niche Zero`, the burrs `Stock 63mm conical` and the setting `12`, which are kept. `PUT` of `grinderId`, `grinderModel` and `grinderBurrs` null, which clears all three while the setting stays, as the plugin clears a Workflow's grinder (`WORKFLOW_GRINDER` in `protocol/`). The same again, which changes nothing. Then `GET` |

They were recorded on 2026-10-16 by Decaid's v0.9.0 Linux arm64 release
(`decaid-linux-arm64-0.9.0.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container as
`../simulated-devices-v0.9.0/README.md` describes, with `TZ=America/Chicago`
and the `tzdata` package, Xvfb, a D-Bus system bus and Avahi, started as
`decaid --serial --bypass-onboarding --no-account`, with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`.
Its data was new, as on a fresh install, so the Workflow began as Decaid's
default. The requests were sent with `Content-Type: application/json` from
the host, through the container's published port 8080, one after another.

The Workflow's id is the one Decaid assigned. The grinder's id, model and
burrs were made up for the recording; nothing names real hardware, so nothing
is scrubbed.

Decaid reads `grinderBurrs` as it reads the context's other strings
(`parseOptionalString` in `WorkflowContext.fromJson`,
`decaid:lib/src/models/data/workflow_context.dart`), so a null merged in
clears it. Its own `WorkflowContext.clearGrinder` clears it with the
grinder's id and model, keeping the setting.
