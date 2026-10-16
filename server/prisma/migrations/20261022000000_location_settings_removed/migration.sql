-- Steam and rinse settings leave Location sharing (ticket #190): each
-- Machine keeps its own until a Recipe holds them (#173), and nothing syncs
-- them. Pre-v1, nothing of them is kept (ADR-0016): each Location's
-- settings, each tablet's as it last had them, each Machine's sharing of
-- them, and their versions, Conflicts, and the writes of them each tablet
-- refused or last applied go.

-- Their versions and Conflicts go with their rows here.
DELETE FROM "versioned_items" WHERE "kind" = 'settings';
DELETE FROM "tablet_refusals" WHERE "kind" = 'settings';
DELETE FROM "tablet_last_applied" WHERE "kind" = 'settings';
ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_settings_location";
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_settings_location";

-- DropForeignKey
ALTER TABLE "location_settings" DROP CONSTRAINT "location_settings_location_id_fkey";

-- DropForeignKey
ALTER TABLE "tablet_settings" DROP CONSTRAINT "tablet_settings_settings_id_fkey";

-- DropForeignKey
ALTER TABLE "tablet_settings" DROP CONSTRAINT "tablet_settings_tablet_id_fkey";

-- AlterTable
ALTER TABLE "machines" DROP COLUMN "shares_settings",
DROP COLUMN "shares_settings_since";

-- DropTable
DROP TABLE "location_settings";

-- DropTable
DROP TABLE "tablet_settings";
