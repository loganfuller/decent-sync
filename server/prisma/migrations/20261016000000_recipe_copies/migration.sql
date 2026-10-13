-- The Recipe a copy was copied from, and its Location then, named by the
-- copy's first version (ticket #144). The Recipe is named by id alone, so
-- the note outlives its hard delete.

-- AlterTable
ALTER TABLE "item_versions" ADD COLUMN     "copied_from_id" TEXT,
ADD COLUMN     "copied_from_location_id" UUID;

-- CreateIndex
CREATE INDEX "item_versions_copied_from_location_id_idx" ON "item_versions"("copied_from_location_id");

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_copied_from_location_id_fkey" FOREIGN KEY ("copied_from_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
