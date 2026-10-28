-- Ticket #224: Settings Edits (ADR-0023), each a one-off write of a Machine's
-- settings made in the management interface, sent on the connection that held
-- the Machine as it was made, and answered by its plugin.

CREATE TYPE "settings_edit_outcome" AS ENUM ('APPLIED', 'ADJUSTED', 'REFUSED');

CREATE TYPE "settings_edit_refusal" AS ENUM ('MACHINE_BUSY', 'CHANGED_SINCE', 'EXPIRED', 'DECAID');

CREATE TABLE "settings_edits" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "tablet_id" UUID NOT NULL,
    "account_id" UUID,
    "collection" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "made_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "sent_at" TIMESTAMPTZ(3),
    "answered_at" TIMESTAMPTZ(3),
    "outcome" "settings_edit_outcome",
    "refusal" "settings_edit_refusal",
    "machine_state" TEXT,
    "decaid_status" INTEGER,
    "decaid_message" TEXT,
    "read_back" JSONB,

    CONSTRAINT "settings_edits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "settings_edits_machine_id_made_at_idx" ON "settings_edits"("machine_id", "made_at");

CREATE INDEX "settings_edits_session_id_idx" ON "settings_edits"("session_id");

ALTER TABLE "settings_edits" ADD CONSTRAINT "settings_edits_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "settings_edits" ADD CONSTRAINT "settings_edits_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
