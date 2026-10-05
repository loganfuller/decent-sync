-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "location_id" UUID;

-- CreateTable
CREATE TABLE "location_assignments" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_assignments_machine_id_effective_from_key" ON "location_assignments"("machine_id", "effective_from");

-- AddForeignKey
ALTER TABLE "location_assignments" ADD CONSTRAINT "location_assignments_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_assignments" ADD CONSTRAINT "location_assignments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only Machines have a Location History: a Shot held by a Pending Machine has no Location.
ALTER TABLE "shots" ADD CONSTRAINT "shots_location_check" CHECK (location_id IS NULL OR machine_id IS NOT NULL);
