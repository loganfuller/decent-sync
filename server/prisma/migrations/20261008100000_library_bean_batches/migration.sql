-- The Library's Bean Batches, each one's state at each Location, and each
-- tablet's record of each (server/src/library/bean-batches.ts).

-- CreateTable
CREATE TABLE "bean_batches" (
    "id" UUID NOT NULL,
    "bean_id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "bean_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_locations" (
    "batch_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "remaining_weight" DOUBLE PRECISION,
    "remaining_weight_at" TIMESTAMPTZ(3),

    CONSTRAINT "batch_locations_pkey" PRIMARY KEY ("batch_id","location_id")
);

-- CreateTable
CREATE TABLE "tablet_bean_batches" (
    "tablet_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_bean_batches_pkey" PRIMARY KEY ("tablet_id","batch_id")
);

-- CreateIndex
CREATE INDEX "bean_batches_bean_id_idx" ON "bean_batches"("bean_id");

-- CreateIndex
CREATE INDEX "batch_locations_location_id_idx" ON "batch_locations"("location_id");

-- CreateIndex
CREATE INDEX "tablet_bean_batches_batch_id_idx" ON "tablet_bean_batches"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_bean_batches_tablet_id_local_id_key" ON "tablet_bean_batches"("tablet_id", "local_id");

-- AddForeignKey
ALTER TABLE "bean_batches" ADD CONSTRAINT "bean_batches_bean_id_fkey" FOREIGN KEY ("bean_id") REFERENCES "beans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bean_batches" ADD CONSTRAINT "bean_batches_created_location_id_fkey" FOREIGN KEY ("created_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_locations" ADD CONSTRAINT "batch_locations_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_locations" ADD CONSTRAINT "batch_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_bean_batches" ADD CONSTRAINT "tablet_bean_batches_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_bean_batches" ADD CONSTRAINT "tablet_bean_batches_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
