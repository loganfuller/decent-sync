-- CreateTable
CREATE TABLE "shots" (
    "id" TEXT NOT NULL,
    "has_full_record" BOOLEAN NOT NULL DEFAULT false,
    "record" JSONB NOT NULL,
    "version_at" TIMESTAMPTZ(6) NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "machine_inferred" BOOLEAN NOT NULL DEFAULT false,
    "pulled_at" TIMESTAMPTZ(3),
    "bean_batch_id" TEXT,
    "coffee_name" TEXT,
    "coffee_roaster" TEXT,
    "profile_title" TEXT,
    "profile_id" TEXT,
    "target_dose" DOUBLE PRECISION,
    "actual_dose" DOUBLE PRECISION,
    "target_yield" DOUBLE PRECISION,
    "actual_yield" DOUBLE PRECISION,
    "duration" DOUBLE PRECISION,
    "enjoyment" DOUBLE PRECISION,
    "barista" TEXT,
    "peak_pressure" DOUBLE PRECISION,
    "peak_flow" DOUBLE PRECISION,

    CONSTRAINT "shots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_measurements" (
    "shot_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "shot_measurements_pkey" PRIMARY KEY ("shot_id")
);

-- CreateIndex
CREATE INDEX "shots_pulled_at_id_idx" ON "shots"("pulled_at" DESC NULLS LAST, "id");

-- CreateIndex
CREATE INDEX "shots_machine_id_pulled_at_id_idx" ON "shots"("machine_id", "pulled_at" DESC NULLS LAST, "id");

-- CreateIndex
CREATE INDEX "shots_pending_machine_id_idx" ON "shots"("pending_machine_id");

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_measurements" ADD CONSTRAINT "shot_measurements_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Metadata pages never detoast the curves. PostgreSQL 14+ is required.
ALTER TABLE "shot_measurements" ALTER COLUMN "data" SET COMPRESSION lz4;
ALTER TABLE "shots" ADD CONSTRAINT "shots_credit_check" CHECK (
  (NOT has_full_record AND machine_id IS NULL AND pending_machine_id IS NULL)
  OR (has_full_record AND (machine_id IS NULL) <> (pending_machine_id IS NULL))
);
