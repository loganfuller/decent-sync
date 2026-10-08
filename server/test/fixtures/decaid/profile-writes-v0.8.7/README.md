# Profile writes on Decaid v0.8.7

What Decaid's API answers writes to profiles, recorded as exchanges: each
request, and the status and body Decaid answered, its JSON parsed (Dart writes
a whole double such as `92.0`, which reads back as `92`). The simulated tablet
carries out profile writes the same way
(`server/test/support/decaid-profiles.ts`), and
`server/test/simulated-profile-writes.test.ts` replays these requests against
it, starting from the two bundled profiles the first two exchanges read.

| File | Exchanges |
|---|---|
| `profile-writes.json` | In order: `GET /api/v1/profiles/{id}` of two bundled profiles, "GHC/manual flow control" and "PSPH". `POST /api/v1/profiles` of a profile with metadata, fields Decaid does not know in it and in a step and its exit, a whole number for each double and its beverage type capitalised; the same steps under another title, which answers the record already held, unchanged; a second profile with the first as its parent, without a version, notes or author, and a temperature written as a string. Refusals: a parent Decaid lacks, no `profile`, an empty title, no steps. `PUT /api/v1/profiles/{id}/visibility` hiding and showing the first, refusals for an unknown visibility, `deleted` for a bundled profile and an unknown id, and hiding a bundled one. `DELETE /api/v1/profiles/{id}` of the other bundled one, which hides it, and of the second profile, which marks it deleted, each read back, then showing the second again. `PUT /api/v1/profiles/{id}` with a new title and the same steps, which keeps the id; with `metadata` null, which clears it; with new steps, which replaces the record under a new id, keeping its parent, visibility and `createdAt`, so the old id answers 404; with the second profile's steps, refused as an id held already; refusals for a bundled profile's content, an unknown id and a null `profile`. `GET /api/v1/profiles?parentId=` of the first, whose id is gone, listing its child. `DELETE /api/v1/profiles/{id}/purge` of the second, twice, the second refused, and of a bundled one, refused; `DELETE` of an unknown id. The second profile posted again after its purge, under a new title with the replaced profile as its parent, which makes it anew under the same id, then deleted. Last, the lists of hidden and of deleted profiles, the replaced profile's children, and the replaced profile |

They were recorded on 2026-10-08 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago`, as `bean-writes-v0.8.7/README.md` describes. Its
database was new, as on a fresh install, so it held only Decaid's 73 bundled
profiles, all visible. The requests were sent with
`Content-Type: application/json` from the host, through the container's
published port 8080, one after another.

A profile's id is `profile:` and the first 20 hex digits of the SHA-256 of
what the machine executes, as Dart's `jsonEncode` writes it with sorted keys
(`ProfileHash` in `decaid:lib/src/models/data/profile_hash.dart`), so the
recorded ids are what any Decaid gives the same profile. Its times are
Chicago's local time (UTC-5 that day) without an offset, to the microsecond.
The two user profiles, their titles, notes, author and metadata were made up
for the recording, as was the id no profile has; the bundled ones are
Decaid's own. Nothing names real hardware. `ProfileHandler`,
`ProfileController`, `ProfileRecord`, `Profile` and `ProfileHash` are
unchanged in v0.8.8.

Posting a profile whose id Decaid holds answers 201 with the record it holds,
whatever its visibility, so a client that wants it shown sets its visibility
afterwards. A parent Decaid lacks is refused, even for a profile it holds.
Changing a profile's steps through `PUT` replaces the record under the new
steps' id, keeping its parent rather than taking the old profile as one.
Deleting a user's profile only marks it `deleted`; deleting a bundled one
hides it, and Decaid refuses to mark a bundled one deleted or purge it.
Decaid lists profiles with the most recently updated first.
