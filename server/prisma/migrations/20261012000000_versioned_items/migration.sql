-- Versions and Conflicts name their item by its kind and id (ticket #135),
-- so a new kind of Library item needs no column of its own in them. Each
-- item that keeps versions and Conflicts has a row in `versioned_items`,
-- which they reference, kept by a trigger on each kind's table: inserted as
-- the item is, its id changed as the item's is, and deleted as the item is,
-- taking the item's versions and Conflicts with it, as their foreign keys to
-- the item did. A new kind's migration creates its table's triggers. Rows
-- are kept, each named by the column that named its item.

-- CreateTable
CREATE TABLE "versioned_items" (
    "kind" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,

    CONSTRAINT "versioned_items_pkey" PRIMARY KEY ("kind","item_id")
);

INSERT INTO "versioned_items" ("kind", "item_id")
SELECT 'bean', "id"::text FROM "beans"
UNION ALL SELECT 'beanBatch', "id"::text FROM "bean_batches"
UNION ALL SELECT 'grinder', "id"::text FROM "grinders"
UNION ALL SELECT 'profile', "id" FROM "profiles"
UNION ALL SELECT 'settings', "id"::text FROM "location_settings";

-- AlterTable
ALTER TABLE "item_versions" ADD COLUMN "kind" TEXT, ADD COLUMN "item_id" TEXT;
ALTER TABLE "conflicts" ADD COLUMN "kind" TEXT, ADD COLUMN "item_id" TEXT;

UPDATE "item_versions" SET
  "kind" = CASE WHEN "bean_id" IS NOT NULL THEN 'bean' WHEN "batch_id" IS NOT NULL THEN 'beanBatch' WHEN "grinder_id" IS NOT NULL THEN 'grinder'
    WHEN "profile_id" IS NOT NULL THEN 'profile' ELSE 'settings' END,
  "item_id" = COALESCE("bean_id"::text, "batch_id"::text, "grinder_id"::text, "profile_id", "settings_id"::text);
UPDATE "conflicts" SET
  "kind" = CASE WHEN "bean_id" IS NOT NULL THEN 'bean' WHEN "batch_id" IS NOT NULL THEN 'beanBatch' WHEN "grinder_id" IS NOT NULL THEN 'grinder'
    WHEN "profile_id" IS NOT NULL THEN 'profile' ELSE 'settings' END,
  "item_id" = COALESCE("bean_id"::text, "batch_id"::text, "grinder_id"::text, "profile_id", "settings_id"::text);

ALTER TABLE "item_versions" ALTER COLUMN "kind" SET NOT NULL, ALTER COLUMN "item_id" SET NOT NULL;
ALTER TABLE "conflicts" ALTER COLUMN "kind" SET NOT NULL, ALTER COLUMN "item_id" SET NOT NULL;

ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_one_item", DROP CONSTRAINT "item_versions_settings_location";
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_one_item", DROP CONSTRAINT "conflicts_settings_location";

-- DropForeignKey
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_batch_id_fkey";

-- DropForeignKey
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_bean_id_fkey";

-- DropForeignKey
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_grinder_id_fkey";

-- DropForeignKey
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_profile_id_fkey";

-- DropForeignKey
ALTER TABLE "conflicts" DROP CONSTRAINT "conflicts_settings_id_fkey";

-- DropForeignKey
ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_batch_id_fkey";

-- DropForeignKey
ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_bean_id_fkey";

-- DropForeignKey
ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_grinder_id_fkey";

-- DropForeignKey
ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_profile_id_fkey";

-- DropForeignKey
ALTER TABLE "item_versions" DROP CONSTRAINT "item_versions_settings_id_fkey";

-- DropIndex
DROP INDEX "conflicts_batch_id_idx";

-- DropIndex
DROP INDEX "conflicts_bean_id_idx";

-- DropIndex
DROP INDEX "conflicts_grinder_id_idx";

-- DropIndex
DROP INDEX "conflicts_profile_id_idx";

-- DropIndex
DROP INDEX "conflicts_settings_id_idx";

-- DropIndex
DROP INDEX "item_versions_batch_id_received_at_idx";

-- DropIndex
DROP INDEX "item_versions_bean_id_received_at_idx";

-- DropIndex
DROP INDEX "item_versions_grinder_id_received_at_idx";

-- DropIndex
DROP INDEX "item_versions_profile_id_received_at_idx";

-- DropIndex
DROP INDEX "item_versions_settings_id_received_at_idx";

-- AlterTable
ALTER TABLE "conflicts" DROP COLUMN "batch_id",
DROP COLUMN "bean_id",
DROP COLUMN "grinder_id",
DROP COLUMN "profile_id",
DROP COLUMN "settings_id";

-- AlterTable
ALTER TABLE "item_versions" DROP COLUMN "batch_id",
DROP COLUMN "bean_id",
DROP COLUMN "grinder_id",
DROP COLUMN "profile_id",
DROP COLUMN "settings_id";

-- CreateIndex
CREATE INDEX "conflicts_kind_item_id_idx" ON "conflicts"("kind", "item_id");

-- CreateIndex
CREATE INDEX "item_versions_kind_item_id_received_at_idx" ON "item_versions"("kind", "item_id", "received_at");

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_kind_item_id_fkey" FOREIGN KEY ("kind", "item_id") REFERENCES "versioned_items"("kind", "item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_kind_item_id_fkey" FOREIGN KEY ("kind", "item_id") REFERENCES "versioned_items"("kind", "item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A Location's settings are always of their Location, as before.
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_settings_location" CHECK ("kind" <> 'settings' OR "location_id" IS NOT NULL);
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_settings_location" CHECK ("kind" <> 'settings' OR "location_id" IS NOT NULL);

-- The triggers that keep `versioned_items`, each given its table's kind.
CREATE FUNCTION "versioned_item_added"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "versioned_items" ("kind", "item_id") VALUES (TG_ARGV[0], NEW."id"::text);
  RETURN NULL;
END $$;

CREATE FUNCTION "versioned_item_renamed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "versioned_items" SET "item_id" = NEW."id"::text WHERE "kind" = TG_ARGV[0] AND "item_id" = OLD."id"::text;
  RETURN NULL;
END $$;

CREATE FUNCTION "versioned_item_removed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "versioned_items" WHERE "kind" = TG_ARGV[0] AND "item_id" = OLD."id"::text;
  RETURN NULL;
END $$;

CREATE TRIGGER "beans_versioned_added" AFTER INSERT ON "beans" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('bean');
CREATE TRIGGER "beans_versioned_renamed" AFTER UPDATE OF "id" ON "beans" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('bean');
CREATE TRIGGER "beans_versioned_removed" AFTER DELETE ON "beans" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('bean');

CREATE TRIGGER "bean_batches_versioned_added" AFTER INSERT ON "bean_batches" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('beanBatch');
CREATE TRIGGER "bean_batches_versioned_renamed" AFTER UPDATE OF "id" ON "bean_batches" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('beanBatch');
CREATE TRIGGER "bean_batches_versioned_removed" AFTER DELETE ON "bean_batches" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('beanBatch');

CREATE TRIGGER "grinders_versioned_added" AFTER INSERT ON "grinders" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('grinder');
CREATE TRIGGER "grinders_versioned_renamed" AFTER UPDATE OF "id" ON "grinders" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('grinder');
CREATE TRIGGER "grinders_versioned_removed" AFTER DELETE ON "grinders" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('grinder');

CREATE TRIGGER "profiles_versioned_added" AFTER INSERT ON "profiles" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('profile');
CREATE TRIGGER "profiles_versioned_renamed" AFTER UPDATE OF "id" ON "profiles" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('profile');
CREATE TRIGGER "profiles_versioned_removed" AFTER DELETE ON "profiles" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('profile');

CREATE TRIGGER "location_settings_versioned_added" AFTER INSERT ON "location_settings" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('settings');
CREATE TRIGGER "location_settings_versioned_renamed" AFTER UPDATE OF "id" ON "location_settings" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('settings');
CREATE TRIGGER "location_settings_versioned_removed" AFTER DELETE ON "location_settings" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('settings');
