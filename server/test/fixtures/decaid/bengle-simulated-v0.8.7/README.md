# Simulated Bengle on Decaid v0.8.7

Steam Records with milk temperatures, from Decaid's own simulated devices. No
real Steam Record with a milk temperature exists: the test tablet's DE1Pro has
no milk probe.

| File | Record |
|---|---|
| `steam-milk-probe.json` | The first Steam Record after Decaid started |
| `steam-milk-probe-next.json` | One recorded right after another, in a second run of the container: it starts with that one's last reading, 61.945 °C, before the probe reports the new milk's |

They were recorded on 2026-10-05 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container:

- with `TZ=America/Chicago`, Xvfb as its display, and a D-Bus system bus and
  Avahi running for its scale discovery;
- started as `decaid --serial`, which leaves out Bluetooth;
- with `~/.local/share/decaid/shared_preferences.json` set to
  `{"simulateDevices":["bengle"],"onboardingCompleted":true,"accountStepSeen":true}`
  before it started. Decaid starts device discovery from its onboarding, which
  otherwise waits for someone to click through it. `simulateDevices` enables
  its simulated Bengle (`MockBengle`), whose milk probe Decaid registers as
  the `Bengle Milk Probe` sensor; the scan at startup connects it.

Then, through Decaid's API on port 8080:

1. `PUT /api/v1/workflow` set the Barista, coffee and roaster to `Fixture`
   names and the steam settings to stop at a milk temperature of 60 °C.
2. `PUT /api/v1/machine/state/steam` started steaming. The simulated probe
   reports 4 °C rising by 5 °C a second, and the Bengle stopped itself once it
   passed 60 °C.
3. `GET /api/v1/steams/{id}` returned each record, which is unchanged here
   apart from its formatting.

The second run also had `gnome-keyring` unlocked on its D-Bus session, which
installing a plugin with a secure setting needs, and had this repo's built
plugin connected to a scratch server; the plugin reads Steam Records but does
not change them.

Their `timestamp` and sample times are Chicago's local time (UTC-5 that day)
without an offset, as Decaid writes them. The records name no hardware; the
simulated Bengle reports serial `mock-bengle`.
