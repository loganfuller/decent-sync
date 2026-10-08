-- When each Bean Batch was last added at or finished at each Location, and by
-- when each tablet's record of each batch shows what the tablet had seen of
-- that, both by PostgreSQL's clock (ADR-0020;
-- server/src/library/location-state.ts).

-- AlterTable
ALTER TABLE "batch_locations" ADD COLUMN "presence_decided_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tablet_bean_batches" ADD COLUMN "seen_at" TIMESTAMPTZ(3);
