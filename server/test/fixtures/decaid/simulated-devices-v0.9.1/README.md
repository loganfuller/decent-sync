# Simulated devices on Decaid v0.9.1

Decaid v0.9.1's version, as its API answers it, for decent-sync #372. v0.9.1
is no longer supported (ADR-0017): the file is what a tablet on the minimum
before v0.9.2 reports, which the server refuses
(`server/test/machine-identity.test.ts`).

| File | Endpoint |
|---|---|
| `info.json` | `GET /api/v1/info` |

It was recorded on 2026-10-29 (UTC) by Decaid's v0.9.1 Linux arm64 release
(`decaid-linux-arm64-0.9.1.tar.gz`, SHA-256
`b048626001f6c6e1eff1b4941e12213f05cf6bed9a6b0a81cbf41f80fc081740`, as
`decaid-0.9.1-SHA256SUMS.txt` names it; `GET /info` answers `0.9.1+3027`,
commit `14361a94`), run headless in a throwaway Ubuntu 24.04 container as
`../simulated-devices-v0.9.2/README.md` describes for v0.9.2, without a
token. `info.json` is what the release answered, `localIp` empty in the
container, and nothing names real hardware, so nothing is scrubbed.

The steps recorded beside it then, of the fan threshold and refill kit
v0.9.1 keeps for a machine across reconnects and restarts, are recorded
again on v0.9.2, with the flow multiplier it keeps too, in
`../simulated-devices-v0.9.2/settings-reconnects.json`.
