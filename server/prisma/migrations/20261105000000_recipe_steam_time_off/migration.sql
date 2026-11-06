-- Ticket #394: from Streamline v0.2.22 a steam time of 0 is steam off, which
-- stays each Machine's own, so a Recipe's steam time is 1 to 255 s or none.
-- Every Recipe holding a steam time of 0, as DYE2's editor saves one, holds
-- none: a version of its own, from the server. Its tablets are written their
-- records without one as they connect again. It changes data, a few rows per
-- Location, which the owner decided on 2026-11-05 (docs/AI_STORAGE_NOTES.md).
-- 1.6.2, which may still serve beside it for a deploy's overlap, may take a
-- tablet's 0 in again, which this release reads as none.

BEGIN;
SET LOCAL lock_timeout = '5s';

WITH "off" AS (
  UPDATE "recipes" SET "content" = "content" - 'steamDuration'
  WHERE jsonb_typeof("content" -> 'steamDuration') = 'number' AND ("content" ->> 'steamDuration')::numeric < 1
  RETURNING "id"
)
INSERT INTO "item_versions" ("id", "kind", "item_id", "location_id", "fields", "edited_at")
SELECT gen_random_uuid(), 'recipe', "id"::text, NULL, '{"steamDuration": null}'::jsonb, transaction_timestamp() FROM "off";

-- An open Conflict whose losing steam time is 0 is dismissed, as it is no steam time to use.
UPDATE "conflicts" SET "state" = 'DISMISSED'
WHERE "kind" = 'recipe' AND "field" = 'steamDuration' AND "state" = 'OPEN'
  AND jsonb_typeof("value") = 'number' AND ("value" #>> '{}')::numeric < 1;

COMMIT;
