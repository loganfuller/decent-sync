# Shots on Decaid v0.9.2's simulated machine

Four Shots Decaid v0.9.2 recorded with its own simulated machine and scale,
each on one of its bundled profiles, for the simulation of a profile on a
Shot's puck (#577): `protocol/test/simulation.test.ts` works out each Shot's
puck from its samples, runs the Shot's own steps on it, and checks the run
lands within the margins the test states of the Shot's duration, time to
first drip, peak pressure and each step's end. Nothing in them comes from a
real Machine or cafe: the machine is `MockDe1` (serial `mock-de1`) and the
scale `MockScale`, and the Workflow names only a dose and a yield.

| File | Profile | Samples | Stop |
|---|---|---|---|
| `classic-italian.json` | Classic Italian espresso | 177 | `targetWeight` |
| `blooming.json` | Blooming Espresso | 565 | `targetWeight` |
| `default.json` | Default | 188 | `targetWeight` |
| `gentle-and-sweet.json` | Gentle and sweet | 245 | `targetWeight` |

Each is Decaid's `GET /api/v1/shots/{id}` of the Shot, unchanged.

## How they were recorded

They were recorded on 2026-11-19 (UTC) by Decaid's v0.9.2 Linux arm64
release (`decaid-linux-arm64-0.9.2.tar.gz`, SHA-256
`a2c5d0bb8c54a53bbb4923c5427f3a3a2bd6d9daaad56f78a25fb2b80e233016`, as
`decaid-0.9.2-SHA256SUMS.txt` names it), run headless in a throwaway Ubuntu
24.04 container with `TZ=America/Chicago` and the `tzdata` package, Xvfb as
its display, a D-Bus system bus and Avahi running, started as
`xvfb-run -a dbus-run-session -- decaid --serial --bypass-onboarding --no-account`,
with `~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected (`simulated-devices-v0.9.2/README.md`
has the same start).

`record.mjs` ran on the host against the container's published port, once
for each file: `DECAID=<address> node server/test/fixtures/decaid/simulated-shots-v0.9.2/record.mjs <this directory> <file>`.
For its profile it sets the Workflow's profile, a dose of 18 g and a yield of
36 g, asks for the machine to be idle, then for an espresso, waits for the
machine to leave it and for Decaid to record the Shot, and writes the record
once two reads 2 s apart agree.

Decaid run this way starts its Shot sequencer for the first Shot after it
starts and for none after: a second espresso in one run ran on the machine
but was never recorded. So Decaid was stopped (`pkill -x decaid`) and started
again the same way, its data kept, before each file.

## Why these profiles

Decaid's simulated machine (`MockDe1`) differs from a DE1 in two ways a
simulation following recorded Shots does not copy (ADR-0032): a step that
gets to its target over its whole time ramps from the previous step's target,
where a DE1 ramps from what it measures as the step begins, and a pressure
step whose target is below the pressure drops the pressure to it at once,
where a DE1's falls over seconds as the group drains through the puck. A
Shot of a profile that leans on either can't be matched by a simulation of a
DE1, so these four lean on neither. Adaptive v3 and D-Flow / default were
recorded the same way and left out for that reason: on Adaptive v3, whose
extraction ramps from the target of a step of no length and whose soak drops
to 0.1 bar, the run came 4.4 s short of the Shot's duration and 7.4 s early
to its first drip.

The simulated machine also runs the first 0.5 s of its first step in its
Preheat (`preparingForShot` for its first five ticks), so each Shot's first
step ends about 0.5 s short of its time after 0 s, which the margins cover.
