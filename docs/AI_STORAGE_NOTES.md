# AI Storage Notes

## Capture storage

Milestone 1 uses PostgreSQL through Prisma (ADR-0007 and ADR-0011). Follow [the spec's Capture and Schema outline sections](https://github.com/loganfuller/decent-sync/issues/1) for entities, identity attribution, editable Location history and idempotent storage.

Keep the Decaid record as sent, separating measurements into their own tables so lists do not load them. Extract analytics columns through optional fields. Record edits preserve existing measurements. Collections are the latest reported value per Machine in milestone 1; merging a shared library comes later.

Shots and Steam Records are stored once by their Decaid ids. Shots are credited by their recorded hardware, to a Machine or a Pending Machine, with ADR-0015's inferred fallback; Steam Records carry no hardware identity and are credited to the reporting Machine. Each record's Location is derived from its Machine's Location History at the record's time and stored beside the credit; history edits re-derive it, and neither touches the stored Decaid payload. Records deleted on a tablet stay on the server, and a tablet backfills its history on adoption. Workflow and state changes are timed events.
