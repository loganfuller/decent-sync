-- Ticket #550: from DYE2 v0.1.37 and Streamline v0.2.25 a recipe is the
-- whole shot, and one holding a dose, grind setting or RPM of 0 is applied
-- as naming none, while DYE2's editor saves an RPM left blank as 0. So a
-- Recipe holds a dose, grind setting or RPM above 0, or none. Every Recipe
-- holding 0 for one holds none: a version of its own, from the server, which
-- each field's latest edit then names, as an edit made through the server
-- would. Its tablets' records are left as they are: a 0 there reads as
-- none. It changes data, a few rows per Location, which the owner approved
-- on 2026-11-15 (docs/AI_STORAGE_NOTES.md). 1.10.0, which may still serve
-- beside it for a deploy's overlap, may take a tablet's 0 in again, which
-- this release reads as none, and reads a Recipe holding none as it did.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Each Recipe holding 0 for any of them, with the fields that do, its new
-- version's id, the edit's time, after each such field's latest edit as
-- `editsAfter` keeps it, and when it is decided: now, to the millisecond,
-- but after every edit of the Recipe decided before it, as the server
-- decides one (`decisionTime`).
WITH "zero" AS (
  SELECT "recipes"."id", gen_random_uuid() AS "version_id", "held"."fields",
    GREATEST(transaction_timestamp()::timestamptz(3), "held"."edited_at") AS "at",
    GREATEST(
      clock_timestamp()::timestamptz(3),
      (SELECT max(("edit" ->> 'decidedAt')::timestamptz) + interval '1 millisecond' FROM jsonb_each(COALESCE("recipes"."field_edits", '{}'::jsonb)) AS "edits"("field", "edit"))
    ) AS "decided_at"
  FROM "recipes"
  CROSS JOIN LATERAL (
    SELECT array_agg("field") AS "fields", max(("recipes"."field_edits" -> "field" ->> 'at')::timestamptz) AS "edited_at"
    FROM unnest(ARRAY['dose', 'grindSetting', 'rpm']) AS "fields"("field")
    -- A CASE, as PostgreSQL may cast before it checks the type in an AND.
    WHERE CASE WHEN jsonb_typeof("recipes"."content" -> "field") = 'number' THEN ("recipes"."content" ->> "field")::numeric = 0 ELSE false END
  ) AS "held"
  WHERE "held"."fields" IS NOT NULL
  FOR UPDATE OF "recipes"
), "versions" AS (
  INSERT INTO "item_versions" ("id", "kind", "item_id", "location_id", "fields", "edited_at")
  SELECT "version_id", 'recipe', "id"::text, NULL,
    (SELECT jsonb_object_agg("field", 'null'::jsonb) FROM unnest("zero"."fields") AS "fields"("field")), "at"
  FROM "zero"
)
UPDATE "recipes" SET
  "content" = "recipes"."content" - "zero"."fields",
  "field_edits" = COALESCE("recipes"."field_edits", '{}'::jsonb) || (
    SELECT jsonb_object_agg("field", jsonb_build_object(
      'at', to_char("zero"."at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'decidedAt', to_char("zero"."decided_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'tabletId', NULL,
      'versionId', "zero"."version_id"::text
    ))
    FROM unnest("zero"."fields") AS "fields"("field")
  )
FROM "zero"
WHERE "recipes"."id" = "zero"."id";

-- An open Conflict whose losing dose, grind setting or RPM is 0 is dismissed, as it is none to use.
UPDATE "conflicts" SET "state" = 'DISMISSED'
WHERE "kind" = 'recipe' AND "field" IN ('dose', 'grindSetting', 'rpm') AND "state" = 'OPEN'
  AND CASE WHEN jsonb_typeof("value") = 'number' THEN ("value" #>> '{}')::numeric = 0 ELSE false END;

COMMIT;
