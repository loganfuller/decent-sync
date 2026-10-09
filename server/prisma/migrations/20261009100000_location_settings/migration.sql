-- Steam, hot water and rinse settings shared by a Location's Machines, whatever
-- their model (ADR-0014), each a field of its own merged as Library edits are
-- (ADR-0020), with what each tablet last had of them, their versions and
-- Conflicts, and each Machine's switch to take part
-- (server/src/library/location-settings.ts).

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "shares_settings" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "shares_settings_since" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "item_versions" ADD COLUMN     "settings_id" UUID;

-- AlterTable
ALTER TABLE "conflicts" ADD COLUMN     "settings_id" UUID;

-- CreateTable
CREATE TABLE "location_settings" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "field_edits" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "location_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tablet_settings" (
    "tablet_id" UUID NOT NULL,
    "settings_id" UUID NOT NULL,
    "values" JSONB NOT NULL,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_settings_pkey" PRIMARY KEY ("tablet_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_settings_location_id_key" ON "location_settings"("location_id");

-- CreateIndex
CREATE INDEX "tablet_settings_settings_id_idx" ON "tablet_settings"("settings_id");

-- CreateIndex
CREATE INDEX "item_versions_settings_id_received_at_idx" ON "item_versions"("settings_id", "received_at");

-- CreateIndex
CREATE INDEX "conflicts_settings_id_idx" ON "conflicts"("settings_id");

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_settings_id_fkey" FOREIGN KEY ("settings_id") REFERENCES "location_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_settings_id_fkey" FOREIGN KEY ("settings_id") REFERENCES "location_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_settings" ADD CONSTRAINT "location_settings_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_settings" ADD CONSTRAINT "tablet_settings_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_settings" ADD CONSTRAINT "tablet_settings_settings_id_fkey" FOREIGN KEY ("settings_id") REFERENCES "location_settings"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Each version and Conflict is of exactly one item, a Location's settings among them, which name their Location.
ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_one_item";
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_one_item" CHECK (num_nonnulls("bean_id", "batch_id", "grinder_id", "profile_id", "settings_id") = 1);
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_settings_location" CHECK ("settings_id" IS NULL OR "location_id" IS NOT NULL);
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_one_item";
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_one_item" CHECK (num_nonnulls("bean_id", "batch_id", "grinder_id", "profile_id", "settings_id") = 1);
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_settings_location" CHECK ("settings_id" IS NULL OR "location_id" IS NOT NULL);
