-- Ticket #287: a Shot's Preheat, the Machine heating its water before the
-- profile starts, is left out of its duration and peaks, and how long it
-- lasted is kept. The Shots stored before keep the values computed with
-- Preheat, at curves revision 0, until the server computes them again from
-- their measurements (`CurvesRefresh`). Both columns are added without
-- rewriting the table, so the previous release keeps serving meanwhile.

SET lock_timeout = '5s';

ALTER TABLE "shots" ADD COLUMN "preheat" DOUBLE PRECISION,
ADD COLUMN "curves_revision" INTEGER NOT NULL DEFAULT 0;
