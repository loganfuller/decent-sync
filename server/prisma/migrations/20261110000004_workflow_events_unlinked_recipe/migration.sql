-- Ticket #434: the Workflow changes not linked to their Recipe yet, by the
-- tablet that reported them and the id they name it by there, which link
-- once that tablet's map gains the id (server/src/machine-events/workflow-links.ts).
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "workflow_events_unlinked_recipe_idx";
CREATE INDEX CONCURRENTLY "workflow_events_unlinked_recipe_idx" ON "workflow_events" ("tablet_id", ("workflow" #>> '{context,extras,dye,recipeId}')) WHERE "tablet_id" IS NOT NULL AND "recipe_id" IS NULL AND ("workflow" #>> '{context,extras,dye,recipeId}') IS NOT NULL;
