-- Ticket #287: how long a Shot's Preheat lasted, the Machine heating its
-- water before the profile starts, which its shown duration and its peaks
-- leave out. `duration` stays the whole recording, as the previous release
-- stores and reads it. The Shots stored before keep curves revision 0, with
-- Preheat in their peaks and none kept, until the server computes them again
-- from their measurements (`CurvesRefresh`). Both columns are added without
-- rewriting the table, so the previous release keeps serving meanwhile.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "shots" ADD COLUMN "preheat" DOUBLE PRECISION,
ADD COLUMN "curves_revision" INTEGER NOT NULL DEFAULT 0;

COMMIT;
