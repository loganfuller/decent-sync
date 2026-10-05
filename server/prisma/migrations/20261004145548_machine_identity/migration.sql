-- CreateEnum
CREATE TYPE "machine_identification" AS ENUM ('HARDWARE_NOT_REPORTED', 'IDENTIFIED', 'UNIDENTIFIED', 'MISMATCH');

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "connection_id" TEXT,
ADD COLUMN     "decaid_version" TEXT,
ADD COLUMN     "firmware" TEXT,
ADD COLUMN     "identification" "machine_identification" NOT NULL DEFAULT 'HARDWARE_NOT_REPORTED',
ADD COLUMN     "plugin_version" TEXT,
ADD COLUMN     "refusal_reason" TEXT,
ADD COLUMN     "refused_at" TIMESTAMPTZ(3),
ADD COLUMN     "reported_model" TEXT,
ADD COLUMN     "reported_serial" TEXT;

-- CreateTable
CREATE TABLE "machine_aliases" (
    "machine_id" UUID NOT NULL,
    "connection_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_aliases_pkey" PRIMARY KEY ("machine_id","connection_id")
);

-- CreateTable
CREATE TABLE "pending_machines" (
    "id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3),
    "dismissed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pending_machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dismissed_hardware" (
    "machine_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dismissed_hardware_pkey" PRIMARY KEY ("machine_id","model","serial")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_machines_model_serial_key" ON "pending_machines"("model", "serial");

-- AddForeignKey
ALTER TABLE "machine_aliases" ADD CONSTRAINT "machine_aliases_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dismissed_hardware" ADD CONSTRAINT "dismissed_hardware_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
