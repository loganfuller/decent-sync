-- Each tablet's sharing status: the writes, deletes and leave-outs it
-- refused, each with Decaid's answer, until one of the same item is carried
-- out, and the last change it applied.

-- CreateTable
CREATE TABLE "tablet_refusals" (
    "tablet_id" UUID NOT NULL,
    "change_key" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT,
    "local_id" TEXT,
    "signature" TEXT NOT NULL,
    "status" INTEGER,
    "error" TEXT NOT NULL,
    "refused_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "tablet_refusals_pkey" PRIMARY KEY ("tablet_id","change_key")
);

-- CreateTable
CREATE TABLE "tablet_last_applied" (
    "tablet_id" UUID NOT NULL,
    "change" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT,
    "local_id" TEXT,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tablet_last_applied_pkey" PRIMARY KEY ("tablet_id")
);

-- AddForeignKey
ALTER TABLE "tablet_refusals" ADD CONSTRAINT "tablet_refusals_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_last_applied" ADD CONSTRAINT "tablet_last_applied_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
