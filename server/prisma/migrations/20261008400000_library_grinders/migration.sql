-- The Library's Grinders, each belonging to one Location, and each tablet's
-- record of each (server/src/library/grinders.ts).

-- CreateTable
CREATE TABLE "grinders" (
    "id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "grinders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tablet_grinders" (
    "tablet_id" UUID NOT NULL,
    "grinder_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_grinders_pkey" PRIMARY KEY ("tablet_id","grinder_id")
);

-- CreateIndex
CREATE INDEX "grinders_location_id_idx" ON "grinders"("location_id");

-- CreateIndex
CREATE INDEX "tablet_grinders_grinder_id_idx" ON "tablet_grinders"("grinder_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_grinders_tablet_id_local_id_key" ON "tablet_grinders"("tablet_id", "local_id");

-- AddForeignKey
ALTER TABLE "grinders" ADD CONSTRAINT "grinders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_grinders" ADD CONSTRAINT "tablet_grinders_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_grinders" ADD CONSTRAINT "tablet_grinders_grinder_id_fkey" FOREIGN KEY ("grinder_id") REFERENCES "grinders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
