-- Ticket #704: Batch Moves (ADR-0037), each move of a Bean Batch from one
-- Location to another, with the amount moved, kept because a Location's
-- Remaining Weight is worked out from the amounts moved to it and away from
-- it since its count started. A new table, which the previous release
-- neither reads nor writes (ADR-0025), and no data is changed: a batch at
-- several Locations stays at each. Its version ids have no foreign key: a
-- version goes only with its item, which takes its moves with it.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "batch_moves" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "amount" DOUBLE PRECISION,
    "moved_all" BOOLEAN NOT NULL,
    "moved_at" TIMESTAMPTZ(3) NOT NULL,
    "version_id" UUID,
    "from_count_version_id" UUID,
    "to_count_version_id" UUID,

    CONSTRAINT "batch_moves_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_moves_batch_id_idx" ON "batch_moves"("batch_id");

CREATE INDEX "batch_moves_from_location_id_idx" ON "batch_moves"("from_location_id");

CREATE INDEX "batch_moves_to_location_id_idx" ON "batch_moves"("to_location_id");

ALTER TABLE "batch_moves" ADD CONSTRAINT "batch_moves_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "batch_moves" ADD CONSTRAINT "batch_moves_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "batch_moves" ADD CONSTRAINT "batch_moves_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
