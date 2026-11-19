-- Ticket #581 (ADR-0032): a Machine following a Draft, and Trial Shots.
-- `locations.tries_drafts`, whether Drafts may be tried at the Location, off
-- by default, and `machines.wire_revision`, the wire revision of the plugin
-- its latest accepted hello came from, so any instance can say which
-- Machines' plugins can follow a Draft: both are columns the previous release
-- neither reads nor writes, with a default or nullable, so its writes go on
-- as they are (ADR-0025); a hello it accepts leaves the revision as it was.
-- `draft_trials`, each profile a Draft was written to a following Machine
-- with, and `draft_followings`, which Machine follows a Draft, are new
-- tables it never touches. Both go with their Draft, as it is published or
-- discarded, and with their Machine.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "locations" ADD COLUMN "tries_drafts" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "machines" ADD COLUMN "wire_revision" INTEGER;

CREATE TABLE "draft_trials" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "profile" JSONB NOT NULL,
    "written_at" TIMESTAMPTZ(3) NOT NULL DEFAULT statement_timestamp(),
    "tablet_written_at" TIMESTAMPTZ(3) NOT NULL,
    "followed_until" TIMESTAMPTZ(3),

    CONSTRAINT "draft_trials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "draft_trials_draft_id_idx" ON "draft_trials"("draft_id");

CREATE INDEX "draft_trials_machine_id_idx" ON "draft_trials"("machine_id");

ALTER TABLE "draft_trials" ADD CONSTRAINT "draft_trials_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "draft_trials" ADD CONSTRAINT "draft_trials_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "draft_followings" (
    "draft_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT statement_timestamp(),
    "trial_id" UUID,
    "ended_at" TIMESTAMPTZ(3),
    "ended_why" TEXT,

    CONSTRAINT "draft_followings_pkey" PRIMARY KEY ("draft_id")
);

-- A Machine follows one Draft at a time.
CREATE UNIQUE INDEX "draft_followings_following_key" ON "draft_followings"("machine_id") WHERE "ended_at" IS NULL;

CREATE INDEX "draft_followings_machine_id_idx" ON "draft_followings"("machine_id");

CREATE INDEX "draft_followings_trial_id_idx" ON "draft_followings"("trial_id");

ALTER TABLE "draft_followings" ADD CONSTRAINT "draft_followings_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "draft_followings" ADD CONSTRAINT "draft_followings_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "draft_followings" ADD CONSTRAINT "draft_followings_trial_id_fkey" FOREIGN KEY ("trial_id") REFERENCES "draft_trials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
