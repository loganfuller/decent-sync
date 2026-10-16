-- DYE2 records a Loaded Recipe's RPM and Basket into its record, and a
-- change of its Bean Batch unloads it (ticket #187, ADR-0022): no part of a
-- Workflow that names a Basket or batch is an edit of the Recipe any more,
-- so none waits for the tablet's map to hold it.

-- AlterTable
ALTER TABLE "tablet_loaded_recipes" DROP COLUMN "pending";
