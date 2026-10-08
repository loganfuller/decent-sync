-- When each Bean Batch was last added at or finished at each Location, by
-- PostgreSQL's clock, and the latest of those each tablet's record of each
-- batch, and of each Bean, has seen (ADR-0020;
-- server/src/library/location-state.ts).

-- AlterTable
ALTER TABLE "batch_locations" ADD COLUMN "presence_decided_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tablet_bean_batches" ADD COLUMN "seen_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tablet_beans" ADD COLUMN "seen_at" TIMESTAMPTZ(3);
