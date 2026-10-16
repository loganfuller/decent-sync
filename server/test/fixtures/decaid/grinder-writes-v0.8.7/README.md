# Grinder writes on Decaid v0.8.7

What Decaid's API answers writes to grinders, recorded as exchanges: each
request, and the status and body Decaid answered, its JSON parsed (Dart writes
a whole double such as `40.0`, which reads back as `40`). The simulated tablet
carries out grinder writes the same way
(`server/test/support/decaid-grinders.ts`), and
`server/test/simulated-grinder-writes.test.ts` replays these requests against
it.

| File | Exchanges |
|---|---|
| `grinder-writes.json` | In order: `POST /api/v1/grinders` with another plugin's key in `extras`; `PUT /api/v1/grinders/{id}` keeping that key beside a global id, then `PUT` with the global id alone, which replaces `extras` whole; `POST` with every field Decaid's grinder has; `POST` with `archived`, an unknown field and the setting type `values`, which reads as `preset`, `archived` and the unknown field being ignored; `PUT` clearing a field with null, with an unknown setting type, which reads as `numeric`, and an unknown field, which is ignored; archiving, then un-archiving with new notes; archiving another. Refusals: `POST` without a model and with a number for one; `PUT` to an unknown id; `PUT` with a null `model` or `archived`, a string `burrSize`, numbers in `settingValues` and a number for `model`. Then `POST` of a grinder and its `DELETE`, a `DELETE` of an unknown id, which also answers 200, `GET` of the deleted grinder and of another, and the lists with and without archived grinders |

They were recorded on 2026-10-08 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago`, as `bean-writes-v0.8.7/README.md` describes. Its library
was empty, as on a fresh install. The requests were sent with
`Content-Type: application/json` from the host, through the container's
published port 8080, one after another.

The ids are those Decaid assigned, and its times are Decaid's local time
without an offset, to the microsecond, presumably UTC: the container was set
up as `bean-writes-v0.8.7`'s was, without the `tzdata` package, which left
that one's clock on UTC whatever its `TZ`. The models, global ids, the other
plugin's key (`otherPluginId`) and the ids no record has were made up for the
recording; nothing names real hardware. `GrindersHandler`, `Grinder`,
`GrinderDao` and the grinders table are unchanged in v0.8.8 and v0.9.0, so
v0.9.0 answers these requests the same.

`POST /grinders` takes no `archived`. Decaid lists grinders with the most
recently updated first; without `includeArchived=true`, `GET /grinders`
leaves out archived grinders. A refused write answers 400 with Dart's error
message, or 404 for an unknown grinder. `DELETE /grinders/{id}` deletes the
record outright, and answers 200 whether or not it existed.
