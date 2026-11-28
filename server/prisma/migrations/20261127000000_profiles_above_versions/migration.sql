-- Ticket #735 (ADR-0038): the lasting Profile above its Profile Versions. A
-- `profiles` row stays one version, under Decaid's id, and `library_profiles`
-- holds the Profile it belongs to, with an id of the server's own, which of
-- its versions is current and the Profile it was started from. A row's
-- Profile and version number are null until the server places it
-- (server/src/library/profile-placing.ts), as every row is at first and as
-- one the previous release inserts is, which neither reads nor writes any of
-- this (ADR-0025). No data is changed: the server converts the rows itself,
-- in the background. The current version carries no foreign key, as the
-- previous release deletes a `profiles` row knowing nothing of it; the
-- server repairs a Profile left naming one. `last_version_number` is the
-- highest number it has given a version, kept when that version leaves the
-- Profile or is deleted, so no number is given twice.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "library_profiles" (
    "id" UUID NOT NULL,
    "current_version_id" TEXT NOT NULL,
    "started_from_id" UUID,
    "last_version_number" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "library_profiles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "library_profiles_current_version_id_idx" ON "library_profiles"("current_version_id");
CREATE INDEX "library_profiles_started_from_id_idx" ON "library_profiles"("started_from_id");

ALTER TABLE "library_profiles" ADD CONSTRAINT "library_profiles_started_from_id_fkey"
    FOREIGN KEY ("started_from_id") REFERENCES "library_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "profiles" ADD COLUMN "library_profile_id" UUID, ADD COLUMN "version_number" INTEGER;

CREATE UNIQUE INDEX "profiles_library_profile_id_version_number_key" ON "profiles"("library_profile_id", "version_number");

ALTER TABLE "profiles" ADD CONSTRAINT "profiles_library_profile_id_fkey"
    FOREIGN KEY ("library_profile_id") REFERENCES "library_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
