---
status: accepted (amended in place on 2026-10-08, while building milestone 2: how deletes are timed, and how what a tablet saw is judged)
---

# The latest edit wins per field, not per record

ADR-0003 resolves conflicting edits to the same record by last writer wins. Taken per record, an edit to one field undoes a concurrent edit to another: if Uptown corrects a Bean's country while Belmont, offline, adds tasting notes to it, the later edit replaces the whole Bean and the other change is lost. So the server compares each edit with the version its tablet last had (ADR-0006 keeps that per tablet) and applies only the fields the edit changed. Two edits conflict only when both changed the same field without seeing each other. The later one wins, and the other is kept as a Conflict, which the management interface shows with where and when it was made until someone uses its value or dismisses it. Each piece of per-Location state (whether a Profile is shown, whether a Bean Batch is at a Location and its remaining weight there, each steam, hot water and rinse setting) is a field of its own. Decaid's update endpoints already change only the fields they are sent.

This amends ADR-0003 and ADR-0014.

## Consequences

- **Each item keeps its versions.** The server stores every accepted edit with the Machine or account that made it and when, which also gives each item a change history in the management interface.
- **Edit times are unchanged.** A tablet edit is timed by the record's `updatedAt` (ADR-0003), a management-interface edit by PostgreSQL's clock (ADR-0016). A delete on a tablet, which Decaid does not time, is timed by PostgreSQL's clock when the server learns of it, but never before the record that tablet last had.
- **What a tablet saw is judged by its record.** An edit from a tablet whose record of the item had seen the field's last change, by PostgreSQL's clock (a report of it taken in, or the write it answers planned, after that change), was made after seeing it, and applies whatever its time. Otherwise, as from a tablet that was offline, edit times decide: for whether a Bean Batch is at a Location or a Profile is shown there, an edit timed before the one that set the field loses to it. A record the server never took in, such as a Profile a barista re-creates, is judged by its time alone, so a tablet whose clock runs behind can lose such an edit, a tablet clock error ADR-0003 accepts.
