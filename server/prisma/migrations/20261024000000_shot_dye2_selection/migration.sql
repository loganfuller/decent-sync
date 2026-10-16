-- A Shot's Recipe is read from DYE2's selection in its Workflow, by its
-- recipe's slot, no longer from the plugin's `decentSyncRecipeId` (ticket
-- #189, ADR-0022). A Shot whose selection named nothing, as while the plugin
-- selects the slot again after its own write, is linked to the Recipe its
-- Machine still had loaded as it ended, found through its Machine's Loaded
-- Recipes by when each was loaded.

-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "selection_named" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "loaded_recipes_machine_id_loaded_at_id_idx" ON "loaded_recipes"("machine_id", "loaded_at", "id");
