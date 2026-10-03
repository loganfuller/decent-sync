# AI Storage Notes

## Target capture storage

Milestone 1 uses PostgreSQL through Prisma (ADR-0007 and ADR-0011). Follow [the spec's Capture and Schema outline sections](https://github.com/loganfuller/decent-sync/issues/1) for entities, identity attribution, editable Location history and idempotent storage. JSON files and `writeJson()` are prototype implementation details.

Keep the Decaid record as sent, separating measurements into their own tables so lists do not load them. Extract analytics columns through optional fields. Record edits preserve existing measurements. Collections are the latest reported value per Machine in milestone 1; merging a shared library comes later.

Shots and Steam Records are stored once by their Decaid ids. Shots are credited by their recorded hardware, to a Machine or a Pending Machine, with ADR-0015's inferred fallback; Steam Records carry no hardware identity and are credited to the reporting Machine. Records deleted on a tablet stay on the server. Never derive target storage ownership from the prototype's `machineId` directory. Workflow and state changes are timed events; the prototype's overwrite-only workflow file is not sufficient.

No prototype-data migration is required. The tablet backfills its history on adoption. Any data still present locally remains user data and requires approval before destructive changes.

## Prototype inspection only

`server.mjs` stores:

```
$DATA_DIR/machines/<machineId>/
  machine.json         accepted hello without token, plus connection-time lastSeen and remote
  events.jsonl         non-heartbeat envelopes processed after hello, excluding in-session duplicates
  state/<name>.json    latest collection or workflow
  shots/<shotId>.json  shot record with measurements
```

`DATA_DIR` defaults to `./data`. Use a scratch directory for experiments.

- `writeJson()` writes a temporary file and renames it; this is not a PostgreSQL persistence pattern.
- The append-only envelope log can repeat ids after restart; it is not a deduplicated event store. Do not read it whole.
- `on_shotUpdated` updates only an existing shot and retains its measurements.
- `on_shotIndex` requests ids absent from the current Machine's `shots/` directory.
- Collection diffs in terminal output are display-only, not a shared-library merge algorithm.
- Multipart collections accumulate in memory, and each part is acknowledged after its envelope is logged. Reassembly is not recovered from that log after restart. The replacement must acknowledge only the complete stored logical message.
- The prototype server accepts up to 16 MiB, but the host's outbound limit can prevent large shots reaching it at all. See `AI_RUNTIME_NOTES.md`; milestone 1 adds whole-message chunking.

Ticket #19 removes this section with the prototype.
