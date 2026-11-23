# Profile ids on Decaid v0.9.3

The ids Decaid v0.9.3 gives profiles, for decent-sync #655: every profile it
bundles, and its answers to the profiles `../profile-ids-v0.9.2/` posted, in
the same form as that folder's `profile-ids.json`, whose README says what
each key and case holds. `protocol/test/profile.test.ts` checks the server's
copy of Decaid's hash (`profileId` in `protocol/src/profile.ts`) against
every one of them, as it does v0.9.2's.

v0.9.3 bundles 94 profiles: v0.9.2's 73, with the same ids, and 21 more
(`assets/defaultProfiles/manifest.json`), the first of kind `calibrate` and a
second `cleaning` one. It changes neither how it reads a profile nor how it
hashes one: `git diff v0.9.2 v0.9.3` of `lib/src/models/data/profile.dart`,
`profile_hash.dart` and `utils.dart` is empty. Each posted case got the id it
got on v0.9.2.

## How they were recorded

They were recorded on 2026-11-23 (UTC) by Decaid's v0.9.3 Linux arm64
release (`decaid-linux-arm64-0.9.3.tar.gz`, SHA-256
`6df61c82f46ae864a985b4d3deb71fa522b328c2a6abce7f61c08dcccbfcd1c6`, as
`decaid-0.9.3-SHA256SUMS.txt` names it; `GET /info` answers `0.9.3+3265`,
commit `1d74fbf7`), run headless in a throwaway Ubuntu 24.04 container with
`TZ=UTC`, as `../simulated-devices-v0.9.2/README.md` describes, started with
no token. Its data was new, as on a fresh install. `../profile-ids-v0.9.2/record.mjs`
ran on the host against the container's published port, one request after
another:
`DECAID=http://127.0.0.1:<port> node server/test/fixtures/decaid/profile-ids-v0.9.2/record.mjs server/test/fixtures/decaid/profile-ids-v0.9.3/profile-ids.json`.

The posted profiles, their titles, author and notes were made up for the
recording; the bundled ones are Decaid's own. Nothing names real hardware or
a cafe, so nothing is scrubbed.
