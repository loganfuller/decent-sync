-- A Shot's Recipe is read from DYE2's selection in its Workflow, by its
-- recipe's slot, no longer from the plugin's `decentSyncRecipeId` (ticket
-- #189, ADR-0022). A Shot whose selection named nothing, as while the plugin
-- selects the slot again after its own write, names the Recipe its Machine
-- had loaded latest by its end, found as it is stored through its Machine's
-- Loaded Recipes by when each was loaded, and is linked to it where that was
-- still loaded as it ended.

-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "selection_named" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "loaded_recipes_machine_id_loaded_at_id_idx" ON "loaded_recipes"("machine_id", "loaded_at", "id");
