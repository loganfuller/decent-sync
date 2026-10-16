-- Shots linked to their Recipe and Basket (ticket #147): each Shot keeps the
-- Basket and Tools DYE2 recorded, by their ids on its tablet, the Basket
-- linked through that tablet's map as its batch and Grinder are, and the
-- Recipe its Workflow named as loaded, linked where its Machine had it
-- loaded as it was pulled (server/src/shots/links.ts). Shots stored before
-- this keep none until they are stored again.

-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "basket_id" TEXT,
ADD COLUMN     "library_basket_id" UUID,
ADD COLUMN     "tool_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "recipe_id" UUID;

-- CreateIndex
CREATE INDEX "shots_basket_id_idx" ON "shots"("basket_id");

-- CreateIndex
CREATE INDEX "shots_library_basket_id_idx" ON "shots"("library_basket_id");

-- CreateIndex
CREATE INDEX "shots_recipe_id_idx" ON "shots"("recipe_id");

-- The Shots still to link, found by their ids on their tablet when its map gains one.
CREATE INDEX "shots_unlinked_basket_idx" ON "shots"("basket_id") WHERE "library_basket_id" IS NULL;

-- The Shots naming a Tool, which its hard delete looks for.
CREATE INDEX "shots_tool_ids_idx" ON "shots" USING gin ("tool_ids");

-- A Shot's Recipe is read through its Machine's latest entry for it loaded by the Shot's end.
CREATE INDEX "loaded_recipes_machine_id_recipe_id_loaded_at_id_idx" ON "loaded_recipes"("machine_id", "recipe_id", "loaded_at", "id");

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_basket_id_fkey" FOREIGN KEY ("library_basket_id") REFERENCES "baskets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
