-- Ticket #308: how long a Steam Record steamed, which its shown duration is,
-- leaving out its lead-in, its pauses, its puffs and its purge. `duration`
-- stays the whole recording, as the previous release stores and reads it.
-- The Steam Records stored before keep curves revision 0, with no steaming
-- time kept, until the server computes them again from their measurements
-- (`CurvesRefresh`). Both columns are added without rewriting the table, so
-- the previous release keeps serving meanwhile.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "steam_records" ADD COLUMN "steaming" DOUBLE PRECISION,
ADD COLUMN "curves_revision" INTEGER NOT NULL DEFAULT 0;

COMMIT;
