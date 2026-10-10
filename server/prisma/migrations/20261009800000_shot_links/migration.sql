-- Shots linked to the Library (ticket #92): each Shot keeps the tablet that
-- reported its metadata, and the Library's Bean Batch and Grinder its ids on
-- that tablet resolve to through the tablet's map. A Shot stored before this
-- has no tablet, and is not linked.

-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "tablet_id" UUID,
ADD COLUMN     "library_batch_id" UUID,
ADD COLUMN     "library_grinder_id" UUID;

-- CreateIndex
CREATE INDEX "shots_library_batch_id_idx" ON "shots"("library_batch_id");

-- CreateIndex
CREATE INDEX "shots_library_grinder_id_idx" ON "shots"("library_grinder_id");

-- The Shots still to link, found by their ids on their tablet when its map gains one.
CREATE INDEX "shots_unlinked_batch_idx" ON "shots"("bean_batch_id") WHERE "library_batch_id" IS NULL;
CREATE INDEX "shots_unlinked_grinder_idx" ON "shots"("grinder_id") WHERE "library_grinder_id" IS NULL;

-- A profile's steps as they are compared: a step's limiter of value 0, which
-- is no limiter (de1app's own sentinel), as null. streamline-js sends every
-- profile it loads into the Workflow so (`updateWorkflow` in
-- streamline-js:src/modules/api.js), while the profile's record keeps it.
CREATE FUNCTION "profile_steps_key"(steps JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(steps) = 'array' THEN (
    SELECT coalesce(jsonb_agg(
      CASE WHEN jsonb_typeof(step -> 'limiter') = 'object' AND step -> 'limiter' -> 'value' = '0'::jsonb
        THEN jsonb_set(step, '{limiter}', 'null'::jsonb) ELSE step END
      ORDER BY position), '[]'::jsonb)
    FROM jsonb_array_elements(steps) WITH ORDINALITY AS listed(step, position)
  ) ELSE steps END
$$;

-- A Shot's Workflow's profile is found by its steps as they are compared.
DROP INDEX "shots_profile_steps_idx";
CREATE INDEX "shots_profile_steps_idx" ON "shots" USING hash (profile_steps_key("record" -> 'workflow' -> 'profile' -> 'steps'));

-- The Profiles a Shot's Workflow's profile may be, found the same way.
CREATE INDEX "profiles_steps_idx" ON "profiles" USING hash (profile_steps_key("content" -> 'profile' -> 'steps'));

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_batch_id_fkey" FOREIGN KEY ("library_batch_id") REFERENCES "bean_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_grinder_id_fkey" FOREIGN KEY ("library_grinder_id") REFERENCES "grinders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
