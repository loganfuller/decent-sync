-- Ticket #704: a Bean Batch is at one Location at a time (ADR-0037). Adding
-- it at a Location now moves it there, so nothing this release does leaves
-- one at two. A batch that is at several when this runs stays at the one it
-- was added at last, with the weight entered there, and is finished at the
-- others: a version of its own, from the server, at the Location kept,
-- naming those left (`movedFrom`) and marked as the upgrade's (`settled`),
-- which each Location left keeps as what decided the batch's presence there.
-- It changes data, a row or two per such batch, which the owner asked for in
-- the ticket (docs/AI_STORAGE_NOTES.md). 1.14.0, which may still serve
-- beside this release for a deploy's overlap, adds a batch at a second
-- Location and leaves it at both: this release reads such a batch as at the
-- one added last first, and settles it in the background (`BatchSettling`).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Under the lock of each Location such a batch is at, in id order, as every
-- change of a Location's state runs under it (`lockLocation`).
SELECT pg_advisory_xact_lock(4000007, hashtext("place"."id"))
FROM (
  SELECT DISTINCT "location_id"::text AS "id" FROM "batch_locations"
  WHERE "added_at" IS NOT NULL AND "finished_at" IS NULL AND "batch_id" IN (
    SELECT "batch_id" FROM "batch_locations" WHERE "added_at" IS NOT NULL AND "finished_at" IS NULL
    GROUP BY "batch_id" HAVING count(*) > 1
  )
  ORDER BY 1
) AS "place";

WITH "ranked" AS (
  SELECT "batch_id", "location_id",
    row_number() OVER (PARTITION BY "batch_id" ORDER BY "added_at" DESC, "location_id") AS "rank",
    count(*) OVER (PARTITION BY "batch_id") AS "places"
  FROM "batch_locations"
  WHERE "added_at" IS NOT NULL AND "finished_at" IS NULL
), "settled" AS (
  SELECT "batch_id", gen_random_uuid() AS "version_id",
    (array_agg("location_id") FILTER (WHERE "rank" = 1))[1] AS "kept",
    jsonb_agg("location_id"::text ORDER BY "rank") FILTER (WHERE "rank" > 1) AS "left_ids",
    transaction_timestamp()::timestamptz(3) AS "at"
  FROM "ranked"
  WHERE "places" > 1
  GROUP BY "batch_id"
), "versions" AS (
  INSERT INTO "item_versions" ("id", "kind", "item_id", "location_id", "fields", "edited_at")
  SELECT "version_id", 'beanBatch', "batch_id"::text, "kept",
    jsonb_build_object('atLocation', true, 'movedFrom', "left_ids", 'settled', true), "at"
  FROM "settled"
), "finished" AS (
  UPDATE "batch_locations" SET
    "finished_at" = GREATEST("batch_locations"."added_at", "settled"."at"),
    "presence_decided_at" = clock_timestamp(),
    "presence_version_id" = "settled"."version_id"
  FROM "settled"
  WHERE "batch_locations"."batch_id" = "settled"."batch_id" AND "batch_locations"."location_id" <> "settled"."kept"
    AND "batch_locations"."added_at" IS NOT NULL AND "batch_locations"."finished_at" IS NULL
  RETURNING "batch_locations"."batch_id"
)
-- Tells every instance, the previous release's too, as `BatchSettling` does,
-- so the tablets at each Location left archive their record (ADR-0016). It
-- is delivered as the transaction commits.
SELECT pg_notify('library_changes', "batch_id"::text) FROM (SELECT DISTINCT "batch_id" FROM "finished") AS "moved";

COMMIT;
