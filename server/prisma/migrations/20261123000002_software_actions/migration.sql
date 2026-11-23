-- Ticket #660: Software Actions (ADR-0034), each thing an Admin asked a
-- Machine's Tablet to do to its plugins or to Decaid, and the action a
-- Settings History entry was the read-back of. A new table and a new
-- nullable column, which the previous release neither reads nor writes
-- (ADR-0025): its history entries leave the column null, as theirs are of no
-- action. The column has no foreign key: an action goes only with its
-- Machine, which takes its history with it.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "software_actions" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "tablet_id" UUID NOT NULL,
    "account_id" UUID,
    "connected_app_id" UUID,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "held" JSONB,
    "time_ms" INTEGER NOT NULL,
    "made_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "sent_at" TIMESTAMPTZ(3),
    "answered_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "refusal" TEXT,
    "machine_state" TEXT,
    "decaid_status" INTEGER,
    "message" TEXT,
    "result" JSONB,

    CONSTRAINT "software_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "software_actions_machine_id_made_at_idx" ON "software_actions"("machine_id", "made_at");

CREATE INDEX "software_actions_session_id_idx" ON "software_actions"("session_id");

CREATE INDEX "software_actions_connected_app_id_idx" ON "software_actions"("connected_app_id");

ALTER TABLE "software_actions" ADD CONSTRAINT "software_actions_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "software_actions" ADD CONSTRAINT "software_actions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "software_actions" ADD CONSTRAINT "software_actions_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "settings_history" ADD COLUMN "software_action_id" UUID;

COMMIT;
