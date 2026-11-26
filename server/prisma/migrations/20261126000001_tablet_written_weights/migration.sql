-- Ticket #705: what the server has written a tablet's record of a Bean Batch
-- as its weight (ADR-0037). `written_weights` holds each weight written to
-- the record that no answer or report has shown it to hold yet, with the
-- count it was worked out from, so a write whose answer was lost is not read
-- back as a weight a barista entered. `weight_count_version_id` is the count
-- the weight the record holds was written from, or the one its own entry
-- started, so an entry made on it is known to have seen that count. Both
-- have defaults, and the previous release neither reads nor writes them
-- (ADR-0025). No data is changed.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "tablet_bean_batches"
    ADD COLUMN "written_weights" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "weight_count_version_id" UUID;

COMMIT;
