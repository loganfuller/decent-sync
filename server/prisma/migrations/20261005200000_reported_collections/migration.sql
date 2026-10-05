-- CreateTable
CREATE TABLE "reported_collections" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "name" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL,
    "value" JSONB,
    "received_at" TIMESTAMPTZ(3),
    "items" INTEGER,

    CONSTRAINT "reported_collections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reported_collections_machine_id_name_key" ON "reported_collections"("machine_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "reported_collections_pending_machine_id_name_key" ON "reported_collections"("pending_machine_id", "name");

-- AddForeignKey
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A Machine's profiles can run to megabytes.
ALTER TABLE "reported_collections" ALTER COLUMN "value" SET COMPRESSION lz4;
-- A collection belongs to a Machine, or to a Pending Machine until a Machine takes its hardware over.
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
-- A value is kept with the time it was received, and a count only for a value.
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_value_check" CHECK ((value IS NULL) = (received_at IS NULL) AND (value IS NOT NULL OR items IS NULL));
