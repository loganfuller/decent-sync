-- Ticket #394: from Streamline v0.2.22 a steam time of 0 is steam off, which
-- stays each Machine's own, so a Recipe's steam time is 1 to 255 s or none.
-- Every Recipe holding a steam time of 0, as DYE2's editor saves one, holds
-- none: a version of its own, from the server, which its latest edit of the
-- field then names, as an edit made through the server would. Its tablets are
-- written their records without one as they connect again. It changes data,
-- a few rows per Location, which the owner decided on 2026-11-05
-- (docs/AI_STORAGE_NOTES.md). 1.6.2, which may still serve beside it for a
-- deploy's overlap, may take a tablet's 0 in again, which this release reads
-- as none.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Each Recipe holding 0, with its new version's id, the edit's time, after the
-- field's latest edit as `editsAfter` keeps it, and when it is decided: now, to
-- the millisecond, but after every edit of the Recipe decided before it, as the
-- server decides one (`decisionTime`).
WITH "off" AS (
  SELECT "id", gen_random_uuid() AS "version_id",
    GREATEST(transaction_timestamp()::timestamptz(3), ("field_edits" -> 'steamDuration' ->> 'at')::timestamptz) AS "at",
    GREATEST(
      clock_timestamp()::timestamptz(3),
      (SELECT max(("edit" ->> 'decidedAt')::timestamptz) + interval '1 millisecond' FROM jsonb_each(COALESCE("field_edits", '{}'::jsonb)) AS "edits"("field", "edit"))
    ) AS "decided_at"
  FROM "recipes"
  -- A CASE, as PostgreSQL may cast before it checks the type in an AND.
  WHERE CASE WHEN jsonb_typeof("content" -> 'steamDuration') = 'number' THEN ("content" ->> 'steamDuration')::numeric < 1 ELSE false END
  FOR UPDATE
), "versions" AS (
  INSERT INTO "item_versions" ("id", "kind", "item_id", "location_id", "fields", "edited_at")
  SELECT "version_id", 'recipe', "id"::text, NULL, '{"steamDuration": null}'::jsonb, "at" FROM "off"
)
UPDATE "recipes" SET
  "content" = "recipes"."content" - 'steamDuration',
  "field_edits" = COALESCE("recipes"."field_edits", '{}'::jsonb) || jsonb_build_object('steamDuration', jsonb_build_object(
    'at', to_char("off"."at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'decidedAt', to_char("off"."decided_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'tabletId', NULL,
    'versionId', "off"."version_id"::text
  ))
FROM "off"
WHERE "recipes"."id" = "off"."id";

-- An open Conflict whose losing steam time is 0 is dismissed, as it is no steam time to use.
UPDATE "conflicts" SET "state" = 'DISMISSED'
WHERE "kind" = 'recipe' AND "field" = 'steamDuration' AND "state" = 'OPEN'
  AND CASE WHEN jsonb_typeof("value") = 'number' THEN ("value" #>> '{}')::numeric < 1 ELSE false END;

COMMIT;
