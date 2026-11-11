-- Ticket #467: what a Shot's measurements show of how it went, worked out
-- once and kept (`measuredValues` in server/src/shots/extraction.ts): its
-- time to first drip, the step it ended in, whether it poured, the scale's
-- last weight with its seconds, and the flow at the stop. Each column is
-- nullable with no default, so adding it rewrites no row. The server fills
-- them as it stores a full record, and those of the Shots already stored in
-- the background, as the raised curves revision has it compute them again
-- (`CurvesRefresh`). The previous release doesn't know them, and leaves them
-- as they are (ADR-0025).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "shots"
  ADD COLUMN "time_to_first_drip" DOUBLE PRECISION,
  ADD COLUMN "last_step_frame" DOUBLE PRECISION,
  ADD COLUMN "last_step_name" TEXT,
  ADD COLUMN "poured" BOOLEAN,
  ADD COLUMN "last_weight" DOUBLE PRECISION,
  ADD COLUMN "last_weight_seconds" DOUBLE PRECISION,
  ADD COLUMN "flow_at_stop" DOUBLE PRECISION;

COMMIT;
