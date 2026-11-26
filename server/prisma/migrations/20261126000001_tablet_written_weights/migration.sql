-- Ticket #705: what the server has written a tablet's record of a Bean Batch
-- as its weight (ADR-0037). `written_weights` holds the latest weights the
-- record has held or been written under its count, with the count of each,
-- so a write whose answer was lost, or a form saved with the weight it was
-- opened with, is not read back as a weight a barista entered. `weight_count_version_id` is the count
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
