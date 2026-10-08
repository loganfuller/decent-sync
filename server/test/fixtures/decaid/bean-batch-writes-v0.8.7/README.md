# Bean batch writes on Decaid v0.8.7

What Decaid's API answers writes to bean batches, and deletes of beans that
have them, recorded as exchanges: each request, and the status and body
Decaid answered, its JSON parsed (Dart writes a whole double such as `250.0`,
which reads back as `250`). The simulated tablet carries out batch writes the
same way (`server/test/support/decaid-batches.ts`), and
`server/test/simulated-batch-writes.test.ts` replays these requests against
it.

| File | Exchanges |
|---|---|
| `bean-batch-writes.json` | In order: `POST /api/v1/beans`, then three `POST /api/v1/beans/{id}/batches`: one with `archived`, `weightRemaining`, an unknown field and another plugin's key in `extras`, which are ignored but for `extras`, `weightRemaining` taking `weight`; one with every field Decaid's batch has, its dates written as a date, a local time, a UTC time and a time with an offset; and one with none. Then `PUT /api/v1/bean-batches/{id}` setting `weightRemaining`, archiving, un-archiving with a new `weightRemaining`, keeping another key in `extras` beside a global id, then the global id alone, which replaces `extras` whole; clearing fields with null; and sending `beanId`, `id`, `createdAt` and an unknown field, which are ignored. Refusals: `PUT` with a null `archived` or `frozen`, a string `weight`, a number or unparseable `roastDate`, or a string `frozen`, and to an unknown id; `POST` to a bean that does not exist, with an unparseable `roastDate` and with a string `weight`. Then `GET` of one batch and an unknown one, and of the lists with and without archived batches, across beans and for one bean; a second bean with a batch, archived, whose batch leaves the list without archived ones; `DELETE` of a batch, twice; `DELETE` of a bean that has batches, which is refused, then of its batches and the bean; and the lists left |

They were recorded on 2026-10-07 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container with
`TZ=America/Chicago`, as `bean-writes-v0.8.7/README.md` describes. Its library
was empty, as on a fresh install. The requests were sent with
`Content-Type: application/json` from the host, through the container's
published port 8080, one after another.

The ids are those Decaid assigned, and its times are Chicago's local time
(UTC-5 that day) without an offset, to the microsecond. The names, global ids,
the other plugin's key (`bcUuid`) and the ids no record has were made up for
the recording; nothing names real hardware. `BeansHandler`, `BeanBatch` and
`BeanDao` are unchanged in v0.8.8.

`POST /beans/{id}/batches` takes neither `archived` nor `weightRemaining`,
and sets `weightRemaining` to `weight`. Decaid lists batches with the most
recently updated first; without `includeArchived=true`, `GET /bean-batches`
leaves out archived batches and every batch of an archived bean. A refused
write answers 400 with Dart's error message, or 404 for an unknown batch.
Deleting a bean that still has batches, archived ones included, fails
SQLite's foreign key and answers 500, deleting nothing: a client deletes the
batches first, as DYE2 does (`dye2:dye2-plugin/src/utils/bean-delete.ts`).
