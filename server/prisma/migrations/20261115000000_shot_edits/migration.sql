-- Ticket #512 (ADR-0031): the edits of a Shot's rating and note made through
-- the server, each kept with the fields it set, who made it and when, and
-- when its tablet's plugin answered that it wrote it into the Shot there. A
-- new table, which the previous release neither reads nor writes (ADR-0025).
-- A Shot is named by its id with no foreign key, as a Recipe names its
-- Reference Shot: Shots are never deleted, and a key would lock `shots`
-- against the running release's writes while it is added. Its maker's
-- account is nullable, as an account may be deleted, and as an edit made on
-- a Machine's tablet names none (#515). The partial index finds the edits
-- still to be written, oldest first, which each connection reads for its
-- tablet.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "shot_edits" (
    "id" UUID NOT NULL,
    "shot_id" TEXT NOT NULL,
    "rating" DOUBLE PRECISION,
    "note" TEXT,
    "account_id" UUID,
    "connected_app_id" UUID,
    "made_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "written_at" TIMESTAMPTZ(3),

    CONSTRAINT "shot_edits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shot_edits_shot_id_made_at_id_idx" ON "shot_edits"("shot_id", "made_at", "id");

CREATE INDEX "shot_edits_connected_app_id_idx" ON "shot_edits"("connected_app_id");

CREATE INDEX "shot_edits_unwritten_idx" ON "shot_edits"("made_at", "id") WHERE "written_at" IS NULL;

ALTER TABLE "shot_edits" ADD CONSTRAINT "shot_edits_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shot_edits" ADD CONSTRAINT "shot_edits_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
