-- Ticket #434: who changed each Workflow, as its delivery says (`cause`,
-- with the plugin's write), the tablet that reported it, and the Library's
-- Bean Batch, Grinder, Basket and Recipe it names, through that tablet's
-- map. The previous release leaves them null, read as unknown and unlinked
-- (ADR-0025). Each constraint is added NOT VALID: every row's value is null
-- as the column is added, so there is nothing to check, and the table is not
-- scanned under its lock; rows written from now on are checked.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "workflow_events"
  ADD COLUMN "cause" TEXT,
  ADD COLUMN "plugin_write" TEXT,
  ADD COLUMN "tablet_id" UUID,
  ADD COLUMN "library_batch_id" UUID,
  ADD COLUMN "library_grinder_id" UUID,
  ADD COLUMN "library_basket_id" UUID,
  ADD COLUMN "recipe_id" UUID;

ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_library_batch_id_fkey" FOREIGN KEY ("library_batch_id") REFERENCES "bean_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_library_grinder_id_fkey" FOREIGN KEY ("library_grinder_id") REFERENCES "grinders"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_library_basket_id_fkey" FOREIGN KEY ("library_basket_id") REFERENCES "baskets"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

COMMIT;
