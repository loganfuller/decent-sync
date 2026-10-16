-- What the plugin's write of each load replaced in the Workflow, until the Machine's first espresso since (ADR-0022, #177).
ALTER TABLE "loaded_recipes" ADD COLUMN "load_before" JSONB;
