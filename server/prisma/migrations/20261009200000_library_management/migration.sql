-- Hard deletes in the management interface (ticket #87): the Library's items
-- an Admin deleted, kept so a tablet reporting one later deletes it rather
-- than adding it again, and each tablet's records of them still to be
-- deleted there (server/src/library/hard-deletes.ts). A Shot's Grinder, by
-- its id on the tablet that pulled it, beside its batch, so an item a Shot
-- names is never deleted.

-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "grinder_id" TEXT;

UPDATE "shots" SET "grinder_id" = "record" -> 'workflow' -> 'context' ->> 'grinderId'
WHERE jsonb_typeof("record" -> 'workflow' -> 'context' -> 'grinderId') = 'string';

-- CreateTable
CREATE TABLE "deleted_items" (
    "kind" TEXT NOT NULL,
    "item_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "deleted_items_pkey" PRIMARY KEY ("kind","item_id")
);

-- CreateTable
CREATE TABLE "tablet_deletions" (
    "tablet_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "item_id" UUID NOT NULL,

    CONSTRAINT "tablet_deletions_pkey" PRIMARY KEY ("tablet_id","kind","local_id")
);

-- CreateIndex
CREATE INDEX "shots_bean_batch_id_idx" ON "shots"("bean_batch_id");

-- CreateIndex
CREATE INDEX "shots_grinder_id_idx" ON "shots"("grinder_id");

-- AddForeignKey
ALTER TABLE "tablet_deletions" ADD CONSTRAINT "tablet_deletions_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
