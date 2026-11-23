-- Ticket #642: a Conflict dismissed through a release before Lost Edits
-- (ADR-0033) has been kept in the table, in state 'DISMISSED', and left out
-- of its item's history. This deletes those rows, so that no release reads
-- `state`, and the next one can drop it with its enum and index. No release
-- since 1.12.2 writes 'DISMISSED', and 1.12.2, which may still serve beside
-- this one for a deploy's overlap, leaves such rows out, so nothing it shows
-- changes. Rows in 'OPEN' or 'USED' are kept and shown as Lost Edits. It
-- changes data, which the owner approved on 2026-11-23
-- (docs/AI_STORAGE_NOTES.md).

BEGIN;
SET LOCAL lock_timeout = '5s';

DELETE FROM "conflicts" WHERE "state" = 'DISMISSED';

COMMIT;
