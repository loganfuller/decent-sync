-- DYE2 records every part of a Workflow that edits its Loaded Recipe into the
-- Recipe's record (ticket #173, ADR-0022): nothing of the Workflow itself is
-- an edit any more, so what edit of the Recipe a Workflow had seen is not
-- needed to merge one.

-- AlterTable
ALTER TABLE "tablet_loaded_recipes" DROP COLUMN "content_seen_at";
