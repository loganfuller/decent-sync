-- CreateTable
CREATE TABLE "steam_records" (
    "id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "location_id" UUID,
    "steamed_at" TIMESTAMPTZ(3) NOT NULL,
    "duration" DOUBLE PRECISION,
    "peak_milk_temperature" DOUBLE PRECISION,
    "final_milk_temperature" DOUBLE PRECISION,
    "barista" TEXT,

    CONSTRAINT "steam_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steam_measurements" (
    "steam_record_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "steam_measurements_pkey" PRIMARY KEY ("steam_record_id")
);

-- CreateIndex
CREATE INDEX "steam_records_steamed_at_id_idx" ON "steam_records"("steamed_at" DESC, "id");

-- CreateIndex
CREATE INDEX "steam_records_machine_id_steamed_at_id_idx" ON "steam_records"("machine_id", "steamed_at" DESC, "id");

-- CreateIndex
CREATE INDEX "steam_records_pending_machine_id_idx" ON "steam_records"("pending_machine_id");

-- AddForeignKey
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_measurements" ADD CONSTRAINT "steam_measurements_steam_record_id_fkey" FOREIGN KEY ("steam_record_id") REFERENCES "steam_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Lists never detoast the curves. PostgreSQL 14+ is required.
ALTER TABLE "steam_measurements" ALTER COLUMN "data" SET COMPRESSION lz4;
-- Each Steam Record is credited to a Machine or to a Pending Machine, never both.
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_credit_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
-- Only Machines have a Location History: a Steam Record held by a Pending Machine has no Location.
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_location_check" CHECK (location_id IS NULL OR machine_id IS NOT NULL);
