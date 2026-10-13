-- Recipes (ticket #140): DYE2's recipes, each belonging to one Location and
-- in one of its Recipe Slots or none, taken into the Library from DYE2's
-- `recipes` list in Decaid's store and written back to it (ADR-0005), with
-- each tablet's map of its records.

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "location_id" UUID,
    "slot" INTEGER,
    "content" JSONB NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id"),
    -- A slot is a positive whole number, and an Archived Recipe has none.
    CONSTRAINT "recipes_slot_check" CHECK ("slot" IS NULL OR "slot" > 0),
    CONSTRAINT "recipes_archived_slot_check" CHECK (NOT "archived" OR "slot" IS NULL)
);

-- CreateTable
CREATE TABLE "tablet_recipes" (
    "tablet_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "before_write" JSONB,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_recipes_pkey" PRIMARY KEY ("tablet_id","recipe_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipes_location_id_slot_key" ON "recipes"("location_id", "slot");

-- CreateIndex
CREATE INDEX "tablet_recipes_recipe_id_idx" ON "tablet_recipes"("recipe_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_recipes_tablet_id_local_id_key" ON "tablet_recipes"("tablet_id", "local_id");

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_recipes" ADD CONSTRAINT "tablet_recipes_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_recipes" ADD CONSTRAINT "tablet_recipes_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The triggers that keep `versioned_items` for the kind (20261012000000_versioned_items).
CREATE TRIGGER "recipes_versioned_added" AFTER INSERT ON "recipes" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('recipe');
CREATE TRIGGER "recipes_versioned_renamed" AFTER UPDATE OF "id" ON "recipes" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('recipe');
CREATE TRIGGER "recipes_versioned_removed" AFTER DELETE ON "recipes" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('recipe');
CREATE TRIGGER "recipes_versioned_truncated" AFTER TRUNCATE ON "recipes" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('recipe');

-- A tablet that took part at its Location before this release first reports its recipes after it: that is no join of
-- its Location (ADR-0008), so its recipes are taken into the Library by slot, each an edit of the Recipe another tablet
-- there brought to that slot, or a new Recipe in a slot none did (ADR-0005), rather than left out and removed from its
-- list. Its first report of them is taken in where its profiles last were.
INSERT INTO "tablet_reports" ("tablet_id", "report", "assignment_id", "location_id", "sharing_since")
SELECT reported."tablet_id", 'dye2Recipes', reported."assignment_id", reported."location_id", reported."sharing_since"
FROM "tablet_reports" AS reported
WHERE reported."report" = 'profiles'
ON CONFLICT DO NOTHING;
