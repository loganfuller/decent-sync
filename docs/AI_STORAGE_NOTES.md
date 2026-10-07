# AI Storage Notes

## Capture storage

Milestone 1 uses PostgreSQL through Prisma (ADR-0007 and ADR-0011). Follow [the spec's Capture and Schema outline sections](https://github.com/loganfuller/decent-sync/issues/1) for entities, identity attribution, editable Location history and idempotent storage.

Keep the Decaid record as sent, separating measurements into their own tables so lists do not load them. Extract analytics columns through optional fields. Record edits preserve existing measurements. Collections are the latest reported value per Machine in milestone 1 (`reported_collections`; an unavailable report keeps the value known), credited and handed over as Workflow events are; see `COLLECTIONS.md`. Merging a shared library comes later.

Shots and Steam Records are stored once by their Decaid ids. Shots are credited by their recorded hardware, to a Machine or a Pending Machine, with ADR-0015's inferred fallback; Steam Records carry no hardware identity and are credited to the reporting Machine. Each record's Location is derived from its Machine's Location History at the record's time and stored beside the credit; history edits re-derive it, and neither touches the stored Decaid payload. Records deleted on a tablet stay on the server, and a tablet backfills its history on adoption. Workflow changes and machine state transitions are timed events, credited like inferred Shots: to the token's Machine, or for a mismatch to the reported hardware's Machine or Pending Machine, which hands them over. Each delivery is handled once, by its delivery id, which is recorded whether or not it changes anything and kept for 90 days; it is stored only if it differs from the latest stored for whoever it belongs to, decided under that Machine's row lock (or the hardware's lock), and the latest stored is the current one. See `WORKFLOW-AND-STATE.md`.

A delivery whose storage fails in a way that would repeat, such as one with a NUL in a string, is set aside in `set_aside_deliveries`, its message kept as received as text, which can hold the escapes jsonb refuses, and acknowledged as stored; see `AI_PROTOCOL_NOTES.md`, Deliveries set aside.
