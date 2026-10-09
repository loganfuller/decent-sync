-- Edits of the Library merged per field (ADR-0020): each item's latest edit of
-- each content field, what each tablet's record has seen of them, each
-- accepted edit as a version, and each edit that lost as a Conflict
-- (server/src/library/content-edits.ts, server/src/library/history.ts).

-- CreateEnum
CREATE TYPE "conflict_state" AS ENUM ('OPEN', 'USED', 'DISMISSED');

-- AlterTable
ALTER TABLE "batch_locations" ADD COLUMN     "presence_version_id" UUID,
ADD COLUMN     "remaining_weight_version_id" UUID;

-- AlterTable
ALTER TABLE "bean_batches" ADD COLUMN     "field_edits" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "beans" ADD COLUMN     "field_edits" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "grinders" ADD COLUMN     "field_edits" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "profile_locations" ADD COLUMN     "version_id" UUID;

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "field_edits" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "tablet_bean_batches" ADD COLUMN     "content_seen_at" TIMESTAMPTZ(3),
ADD COLUMN     "record_saved_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tablet_beans" ADD COLUMN     "content_seen_at" TIMESTAMPTZ(3),
ADD COLUMN     "record_saved_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tablet_grinders" ADD COLUMN     "content_seen_at" TIMESTAMPTZ(3),
ADD COLUMN     "record_saved_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tablet_profiles" ADD COLUMN     "content_seen_at" TIMESTAMPTZ(3),
ADD COLUMN     "record_saved_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "item_versions" (
    "id" UUID NOT NULL,
    "bean_id" UUID,
    "batch_id" UUID,
    "grinder_id" UUID,
    "profile_id" TEXT,
    "location_id" UUID,
    "fields" JSONB NOT NULL,
    "machine_id" UUID,
    "tablet_id" UUID,
    "account_id" UUID,
    "edited_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "item_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflicts" (
    "id" UUID NOT NULL,
    "bean_id" UUID,
    "batch_id" UUID,
    "grinder_id" UUID,
    "profile_id" TEXT,
    "location_id" UUID,
    "field" TEXT NOT NULL,
    "value" JSONB,
    "machine_id" UUID,
    "tablet_id" UUID,
    "account_id" UUID,
    "edited_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "state" "conflict_state" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "item_versions_bean_id_received_at_idx" ON "item_versions"("bean_id", "received_at");

-- CreateIndex
CREATE INDEX "item_versions_batch_id_received_at_idx" ON "item_versions"("batch_id", "received_at");

-- CreateIndex
CREATE INDEX "item_versions_grinder_id_received_at_idx" ON "item_versions"("grinder_id", "received_at");

-- CreateIndex
CREATE INDEX "item_versions_profile_id_received_at_idx" ON "item_versions"("profile_id", "received_at");

-- CreateIndex
CREATE INDEX "item_versions_location_id_idx" ON "item_versions"("location_id");

-- CreateIndex
CREATE INDEX "item_versions_machine_id_idx" ON "item_versions"("machine_id");

-- CreateIndex
CREATE INDEX "item_versions_tablet_id_idx" ON "item_versions"("tablet_id");

-- CreateIndex
CREATE INDEX "item_versions_account_id_idx" ON "item_versions"("account_id");

-- CreateIndex
CREATE INDEX "conflicts_state_created_at_idx" ON "conflicts"("state", "created_at");

-- CreateIndex
CREATE INDEX "conflicts_bean_id_idx" ON "conflicts"("bean_id");

-- CreateIndex
CREATE INDEX "conflicts_batch_id_idx" ON "conflicts"("batch_id");

-- CreateIndex
CREATE INDEX "conflicts_grinder_id_idx" ON "conflicts"("grinder_id");

-- CreateIndex
CREATE INDEX "conflicts_profile_id_idx" ON "conflicts"("profile_id");

-- CreateIndex
CREATE INDEX "conflicts_location_id_idx" ON "conflicts"("location_id");

-- CreateIndex
CREATE INDEX "conflicts_machine_id_idx" ON "conflicts"("machine_id");

-- CreateIndex
CREATE INDEX "conflicts_tablet_id_idx" ON "conflicts"("tablet_id");

-- CreateIndex
CREATE INDEX "conflicts_account_id_idx" ON "conflicts"("account_id");

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_bean_id_fkey" FOREIGN KEY ("bean_id") REFERENCES "beans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_grinder_id_fkey" FOREIGN KEY ("grinder_id") REFERENCES "grinders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_bean_id_fkey" FOREIGN KEY ("bean_id") REFERENCES "beans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_grinder_id_fkey" FOREIGN KEY ("grinder_id") REFERENCES "grinders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Each version and Conflict is of exactly one item.
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_one_item" CHECK (num_nonnulls("bean_id", "batch_id", "grinder_id", "profile_id") = 1);
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_one_item" CHECK (num_nonnulls("bean_id", "batch_id", "grinder_id", "profile_id") = 1);
