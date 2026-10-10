-- Shots linked to the Library (ticket #92): each Shot keeps the tablet that
-- reported its metadata, and the Library's Bean Batch and Grinder its ids on
-- that tablet resolve to through the tablet's map. A Shot stored before this
-- has no tablet, and resolves through the first tablet seen on its Machine.

-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "tablet_id" UUID,
ADD COLUMN     "library_batch_id" UUID,
ADD COLUMN     "library_grinder_id" UUID;

-- CreateIndex
CREATE INDEX "shots_library_batch_id_idx" ON "shots"("library_batch_id");

-- CreateIndex
CREATE INDEX "shots_library_grinder_id_idx" ON "shots"("library_grinder_id");

-- The Shots still to link, found by their ids on their tablet when its map gains one.
CREATE INDEX "shots_unlinked_batch_idx" ON "shots"("bean_batch_id") WHERE "library_batch_id" IS NULL;
CREATE INDEX "shots_unlinked_grinder_idx" ON "shots"("grinder_id") WHERE "library_grinder_id" IS NULL;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_batch_id_fkey" FOREIGN KEY ("library_batch_id") REFERENCES "bean_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_grinder_id_fkey" FOREIGN KEY ("library_grinder_id") REFERENCES "grinders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Shots already stored link through the first tablet seen on their Machine, where its map holds their ids.
UPDATE "shots" AS s SET "library_batch_id" = held."batch_id"
FROM "tablet_bean_batches" AS held
WHERE held."local_id" = s."bean_batch_id"
  AND held."tablet_id" = (
    SELECT mt."tablet_id" FROM "machine_tablets" AS mt WHERE mt."machine_id" = s."machine_id" ORDER BY mt."first_seen_at", mt."id" LIMIT 1
  );

UPDATE "shots" AS s SET "library_grinder_id" = held."grinder_id"
FROM "tablet_grinders" AS held
WHERE held."local_id" = s."grinder_id"
  AND held."tablet_id" = (
    SELECT mt."tablet_id" FROM "machine_tablets" AS mt WHERE mt."machine_id" = s."machine_id" ORDER BY mt."first_seen_at", mt."id" LIMIT 1
  );
