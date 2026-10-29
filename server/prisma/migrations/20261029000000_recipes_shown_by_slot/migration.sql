-- Ticket #379, with #371: a Recipe is on Streamline's strip exactly while it
-- is in a Recipe Slot, as DYE2 v0.1.32 holds no slot for a recipe hidden
-- from it, so a Recipe keeps no `showOnDashboard` of its own. It changes
-- data, a few rows per Location, an exception the owner approved on
-- 2026-10-29 (docs/AI_STORAGE_NOTES.md). 1.6.0, which may still serve
-- beside it for a deploy's overlap, shows a Recipe lacking the field as
-- shown, and writes its records without one, which DYE2 and Streamline read
-- as shown too, until their tablet connects to this release.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- A Recipe left hidden in a slot, as the previous release's switch or a
-- tablet's hide left one, which Streamline showed as an empty button, leaves
-- its slot, as DYE2 v0.1.32 takes a recipe it saves hidden out of its slot:
-- a version of its own, from the server. Its tablets are written it in no
-- slot as they connect again.
WITH "hidden" AS (
  UPDATE "recipes" SET "slot" = NULL
  WHERE "slot" IS NOT NULL AND "content" -> 'showOnDashboard' = 'false'::jsonb
  RETURNING "id", "location_id"
)
INSERT INTO "item_versions" ("id", "kind", "item_id", "location_id", "fields", "edited_at")
SELECT gen_random_uuid(), 'recipe', "id"::text, "location_id", '{"slot": null}'::jsonb, transaction_timestamp() FROM "hidden";

-- The field leaves every Recipe's content and its latest edit with it, as no
-- edit: past versions keep it as made. An open Conflict over it is
-- dismissed, as there is nothing left to use its value on.
UPDATE "recipes" SET "content" = "content" - 'showOnDashboard', "field_edits" = "field_edits" - 'showOnDashboard'
WHERE "content" ? 'showOnDashboard' OR "field_edits" ? 'showOnDashboard';

UPDATE "conflicts" SET "state" = 'DISMISSED'
WHERE "kind" = 'recipe' AND "field" = 'showOnDashboard' AND "state" = 'OPEN';

COMMIT;
