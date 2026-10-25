-- Ticket #216: DYE2 v0.1.26 names the recipe a Workflow is dialled in to by
-- its record's id (`context.extras.dye.recipeId`), and a recipe's id no
-- longer says its Recipe Slot (`stripSlot` does, 1 to 5).

-- Each Recipe keeps one record id on every tablet at its Location. One in a
-- slot keeps its slot's number, the id its records have on the tablets now;
-- the rest, which no tablet holds, get a new one.
ALTER TABLE "recipes" ADD COLUMN "record_id" TEXT;
UPDATE "recipes" SET "record_id" = COALESCE("slot"::text, gen_random_uuid()::text);
ALTER TABLE "recipes" ALTER COLUMN "record_id" SET NOT NULL;
CREATE UNIQUE INDEX "recipes_location_id_record_id_key" ON "recipes"("location_id", "record_id") WHERE NOT "archived";

-- A Location has five Recipe Slots, the buttons of Streamline's DYE strip:
-- a Recipe in a higher one leaves its slot, and stays at the Location.
UPDATE "recipes" SET "slot" = NULL WHERE "slot" > 5;
ALTER TABLE "recipes" DROP CONSTRAINT "recipes_slot_check";
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_slot_check" CHECK ("slot" IS NULL OR "slot" BETWEEN 1 AND 5);

-- What a load write replaced is no longer judged (decentespresso/dye2#31),
-- nor a recipe record's stale save, nor the record removed from a slot.
ALTER TABLE "loaded_recipes" DROP COLUMN "load_before";
ALTER TABLE "tablet_recipes" DROP COLUMN "before_write";
DROP TABLE "tablet_removed_recipes";

-- The recipe each tablet's Workflow names, by its record id, and the
-- Recipe's parts as the Workflow last took them. Each tablet's next Workflow
-- delivery names its recipe afresh.
DELETE FROM "tablet_loaded_recipes";
ALTER TABLE "tablet_loaded_recipes" ADD COLUMN "record_id" TEXT NOT NULL;
ALTER TABLE "tablet_loaded_recipes" ADD COLUMN "named_at" TIMESTAMPTZ(3) NOT NULL;
ALTER TABLE "tablet_loaded_recipes" ADD COLUMN "base" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "tablet_loaded_recipes" ALTER COLUMN "recipe_id" DROP NOT NULL;

-- A Shot names its Recipe by the record id its Workflow carried, and one
-- naming none has none.
ALTER TABLE "shots" DROP COLUMN "selection_named";

-- Shots naming a recipe by a record id the tablet's map does not hold yet,
-- linked once it does (`linkRecipeShots`), as the unlinked batch, Grinder and
-- Basket indexes serve their links.
CREATE INDEX "shots_unlinked_recipe_idx" ON "shots"(("record" #>> '{workflow,context,extras,dye,recipeId}')) WHERE "recipe_id" IS NULL;
