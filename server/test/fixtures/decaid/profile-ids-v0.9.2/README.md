# Profile ids on Decaid v0.9.2

The ids Decaid v0.9.2 gives profiles, for decent-sync #576: every profile it
bundles, and its answers to profiles posted to it that differ in what its
hash covers, or only in what it leaves out of the hash or normalises away.
`protocol/test/profile.test.ts` checks the server's copy of Decaid's hash
(`profileId` in `protocol/src/profile.ts`) against every one of them.

v0.9.2 is the oldest Decaid supported (ADR-0017). `../profile-ids-v0.9.3/`
holds v0.9.3's answers to the same requests, recorded by the same script.

| Key of `profile-ids.json` | What it holds |
|---|---|
| `bundled` | `GET /api/v1/profiles?includeHidden=true` on new data: Decaid's 73 bundled profiles, each record whole, all visible |
| `posted` | One `POST /api/v1/profiles` of `{ profile }` per case below, in order, each with its `name`, the case whose id it should share (`sameIdAs`, or `differs` for one that should differ from `base`'s), the request and Decaid's status and body |

| Case | What it sends | Id |
|---|---|---|
| `base` | A made-up profile of two steps: a flow fill that exits over a pressure, under a pressure limit, its weight left out; then a pressure ramp, weight and limiter null | |
| `weightZero` | The fill's weight 0 | Differs |
| `weightNull` | The fill's weight null | `base`'s |
| `limiterZero` | The ramp's limiter of value 0, range 0.6 | Differs |
| `limiterAbsent` | The ramp's limiter left out | `base`'s |
| `exitAbsent` | The ramp's exit left out | `base`'s |
| `numbersAsText` | Every number of the fill, and the profile's, written as text, its temperature as `"92.0"` | `base`'s |
| `stepRenamed` | The fill named `Fill` | Differs |
| `retitled` | Another title, author and notes | `base`'s |
| `versionAbsent` | No version | Differs |
| `versionNumber` | The version as the number 2 | `base`'s |
| `beverageCapitalised` | Drink kind `Espresso` | `base`'s |
| `beverageUnknown` | Drink kind `latte`, which Decaid reads as espresso | `base`'s |
| `beverageFilter` | Drink kind `pourover` | Differs |
| `targetsNull` | Target weight and volume null | Differs |
| `countStartFraction` | Preinfusion count 1.7, which Decaid cuts to 1 | Differs |
| `countStartOne` | Preinfusion count 1 | `countStartFraction`'s |
| `unknownFields` | A field Decaid does not know in the profile, a step, its exit and its limiter | `base`'s |
| `fractions` | The ramp's pressure, time and temperature with fractions | Differs |

Posting a profile whose id Decaid holds answers 201 with the record it
holds, unchanged (`../profile-writes-v0.8.7/README.md`), so a case sharing an
id answers the record the first post of it made, not the profile it sent.
Decaid writes a whole double with `.0` (`92.0`), which reads back as `92`;
its hash writes it the same way, and `profileId` writes each double so
whatever JavaScript read it as.

## How they were recorded

They were recorded on 2026-11-18 (UTC) by Decaid's v0.9.2 Linux arm64
release (`decaid-linux-arm64-0.9.2.tar.gz`, SHA-256
`a2c5d0bb8c54a53bbb4923c5427f3a3a2bd6d9daaad56f78a25fb2b80e233016`, as
`decaid-0.9.2-SHA256SUMS.txt` names it; `GET /info` answers `0.9.2+3191`,
commit `875b7a6a`), run headless in a throwaway Ubuntu 24.04 container with
`TZ=UTC`, as `../simulated-devices-v0.9.2/README.md` describes. Its data was
new, as on a fresh install. `record.mjs` ran on the host against the
container's published port, one request after another:
`DECAID=http://127.0.0.1:<port> node server/test/fixtures/decaid/profile-ids-v0.9.2/record.mjs <output>`.

The posted profiles, their titles, author and notes were made up for the
recording; the bundled ones are Decaid's own. Nothing names real hardware or
a cafe, so nothing is scrubbed.
