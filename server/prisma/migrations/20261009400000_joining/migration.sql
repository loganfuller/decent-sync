-- Joining a Location (ADR-0008, ADR-0018): where each of a tablet's reports
-- was last taken in, so a report under another Location History entry is
-- known as part of joining; the Workflow grinder and batch still to be cleared
-- on a tablet whose Machine joined a Location that does not offer them; and
-- what each Machine's tablet brought to the Library as it joined
-- (server/src/library/joining.ts).

-- CreateTable
CREATE TABLE "tablet_reports" (
    "tablet_id" UUID NOT NULL,
    "report" TEXT NOT NULL,
    "assignment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,

    CONSTRAINT "tablet_reports_pkey" PRIMARY KEY ("tablet_id","report")
);

-- CreateTable
CREATE TABLE "workflow_clears" (
    "tablet_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "expected" JSONB NOT NULL,

    CONSTRAINT "workflow_clears_pkey" PRIMARY KEY ("tablet_id")
);

-- CreateTable
CREATE TABLE "brought_items" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "tablet_id" UUID NOT NULL,
    "location_id" UUID,
    "bean_id" UUID,
    "batch_id" UUID,
    "grinder_id" UUID,
    "profile_id" TEXT,
    "matched" BOOLEAN NOT NULL,
    "brought_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "brought_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_clears_location_id_idx" ON "workflow_clears"("location_id");

-- CreateIndex
CREATE INDEX "brought_items_tablet_id_idx" ON "brought_items"("tablet_id");

-- CreateIndex
CREATE INDEX "brought_items_location_id_idx" ON "brought_items"("location_id");

-- CreateIndex
CREATE INDEX "brought_items_bean_id_idx" ON "brought_items"("bean_id");

-- CreateIndex
CREATE INDEX "brought_items_batch_id_idx" ON "brought_items"("batch_id");

-- CreateIndex
CREATE INDEX "brought_items_grinder_id_idx" ON "brought_items"("grinder_id");

-- CreateIndex
CREATE INDEX "brought_items_profile_id_idx" ON "brought_items"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "brought_items_machine_id_bean_id_key" ON "brought_items"("machine_id", "bean_id");

-- CreateIndex
CREATE UNIQUE INDEX "brought_items_machine_id_batch_id_key" ON "brought_items"("machine_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "brought_items_machine_id_grinder_id_key" ON "brought_items"("machine_id", "grinder_id");

-- CreateIndex
CREATE UNIQUE INDEX "brought_items_machine_id_profile_id_key" ON "brought_items"("machine_id", "profile_id");

-- AddForeignKey
ALTER TABLE "tablet_reports" ADD CONSTRAINT "tablet_reports_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_clears" ADD CONSTRAINT "workflow_clears_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_clears" ADD CONSTRAINT "workflow_clears_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brought_items" ADD CONSTRAINT "brought_items_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brought_items" ADD CONSTRAINT "brought_items_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brought_items" ADD CONSTRAINT "brought_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brought_items" ADD CONSTRAINT "brought_items_bean_id_fkey" FOREIGN KEY ("bean_id") REFERENCES "beans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brought_items" ADD CONSTRAINT "brought_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brought_items" ADD CONSTRAINT "brought_items_grinder_id_fkey" FOREIGN KEY ("grinder_id") REFERENCES "grinders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brought_items" ADD CONSTRAINT "brought_items_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
