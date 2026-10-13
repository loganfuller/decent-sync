-- The record a tablet held in a Recipe Slot when the server removed it there
-- (ticket #142), so a Recipe's record created in the slot after it keeps the
-- fields a save from a page opened on the record removed did not change
-- (ADR-0005).

-- CreateTable
CREATE TABLE "tablet_removed_recipes" (
    "tablet_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,

    CONSTRAINT "tablet_removed_recipes_pkey" PRIMARY KEY ("tablet_id","local_id")
);

-- AddForeignKey
ALTER TABLE "tablet_removed_recipes" ADD CONSTRAINT "tablet_removed_recipes_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
