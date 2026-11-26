-- Ticket #653: a Lost Edit's `state`, what a release before Lost Edits
-- (ADR-0033) made of a Conflict, goes with its enum and its index. Every row
-- holds `OPEN` or `USED`, as `20261123000001_dismissed_lost_edits_deleted`
-- deleted each `DISMISSED` one, and no release since 1.13.0, the latest
-- included, names it in a query: it writes a Lost Edit leaving the column to
-- its default and reads Lost Edits omitting it, so it runs beside this one
-- (ADR-0025).

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP INDEX "conflicts_state_created_at_idx";
ALTER TABLE "conflicts" DROP COLUMN "state";
DROP TYPE "conflict_state";

COMMIT;
