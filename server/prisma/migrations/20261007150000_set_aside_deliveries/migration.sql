-- Deliveries whose storage failed in a way that would repeat, kept as received
-- (server/src/set-aside-deliveries/set-aside-deliveries.service.ts).

-- CreateTable
CREATE TABLE "set_aside_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "record_id" TEXT,
    "sql_state" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message" TEXT NOT NULL,

    CONSTRAINT "set_aside_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "set_aside_deliveries_machine_id_id_idx" ON "set_aside_deliveries"("machine_id", "id");

-- CreateIndex
CREATE INDEX "set_aside_deliveries_machine_id_record_id_idx" ON "set_aside_deliveries"("machine_id", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "set_aside_deliveries_machine_id_delivery_id_key" ON "set_aside_deliveries"("machine_id", "delivery_id");

-- AddForeignKey
ALTER TABLE "set_aside_deliveries" ADD CONSTRAINT "set_aside_deliveries_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A Shot's message, curves included, can run to megabytes.
ALTER TABLE "set_aside_deliveries" ALTER COLUMN "message" SET COMPRESSION lz4;
