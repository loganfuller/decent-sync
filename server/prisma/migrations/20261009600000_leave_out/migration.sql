-- A Machine joining a Location brings nothing to a Location that offers
-- items of a kind already (ADR-0018): the tablet's records the Library
-- leaves out, which its writer archives or hides there. Nothing is listed as
-- brought any more.

-- DropTable
DROP TABLE "brought_items";

-- CreateTable
CREATE TABLE "tablet_left_out" (
    "tablet_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "set_aside" BOOLEAN NOT NULL,

    CONSTRAINT "tablet_left_out_pkey" PRIMARY KEY ("tablet_id","kind","local_id")
);

-- AddForeignKey
ALTER TABLE "tablet_left_out" ADD CONSTRAINT "tablet_left_out_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
