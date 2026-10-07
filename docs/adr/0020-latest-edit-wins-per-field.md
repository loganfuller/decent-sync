# The latest edit wins per field, not per record

ADR-0003 resolves conflicting edits to the same record by last writer wins. Taken per record, an edit to one field undoes a concurrent edit to another: if Uptown corrects a Bean's country while Belmont, offline, adds tasting notes to it, the later edit replaces the whole Bean and the other change is lost. So the server compares each edit with the version its tablet last had (ADR-0006 keeps that per tablet) and applies only the fields the edit changed. Two edits conflict only when both changed the same field without seeing each other. The later one wins, and the other is kept as a Conflict, which the management interface shows with where and when it was made until someone uses its value or dismisses it. Each piece of per-Location state (whether a Profile is shown, whether a Bean Batch is at a Location and its remaining weight there, each steam, hot water and rinse setting) is a field of its own. Decaid's update endpoints already change only the fields they are sent.

This amends ADR-0003.

## Consequences

- **Each item keeps its versions.** The server stores every accepted edit with the Machine or account that made it and when, which also gives each item a change history in the management interface.
- **Edit times are unchanged.** A tablet edit is timed by the record's `updatedAt` (ADR-0003), a management-interface edit by PostgreSQL's clock (ADR-0016).
