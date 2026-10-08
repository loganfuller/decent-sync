---
status: accepted (corrected in place on 2026-10-08, while building milestone 2: Decaid refuses to delete a bean that has batches)
---

# A delete on a tablet acts at that tablet's Location

ADR-0003 archived a Bean or Profile everywhere when any tablet deleted it. That clashes with ADR-0008, which shows or hides each Profile per Location and offers each Bean where its batches are: a cafe clearing out a Profile or Bean it has moved on from would take it away from the lab, which still uses it. Decaid also replaces a Profile whose steps change through `PUT /profiles/{id}`, so the old id disappears from that tablet and reads as a delete.

So a delete on a tablet acts at its Machine's Location. A Profile deleted on a tablet, or gone from it, is hidden at that Location. A deleted Bean Batch is no longer at that Location (ADR-0008). A deleted Bean takes its batches at that Location with it, as a bean goes only with its batches (Decaid refuses to delete a bean that has any, so DYE2 deletes them first), so it stops being offered there. A deleted Grinder is Archived, since it belongs to that one Location. Only the management interface Archives a Bean, a Profile or a Bean Batch, and only an Admin hard-deletes.

This amends ADR-0003.

## Consequences

- **Only what a tablet is known to hold can be deleted there.** The server keeps its map per tablet (ADR-0006), so an item missing from a tablet counts as deleted only if that tablet held it. A new, reset or replaced tablet that lacks the Library's items joins as ADR-0018 describes, and nothing is deleted on its account.
