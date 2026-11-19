-- Ticket #579 (ADR-0032): Drafts, profiles being written or changed in the
-- management interface, held by the server alone. A new table, which the
-- previous release neither reads nor writes (ADR-0025). The Profile a Draft
-- was started from is named by Decaid's id with no foreign key, so adding the
-- table locks nothing on `profiles`, which the running release writes; who
-- saved it last is nullable, as an account or a Connected App may be deleted.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "draft_publishing" AS ENUM ('VERSION', 'SEPARATE');

CREATE TABLE "drafts" (
    "id" UUID NOT NULL,
    "profile" JSONB NOT NULL,
    "started_from_id" TEXT,
    "shape" TEXT,
    "publishes_as" "draft_publishing" NOT NULL,
    "saved_by_account_id" UUID,
    "saved_by_connected_app_id" UUID,
    "saved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "saves" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "drafts_saved_by_account_id_idx" ON "drafts"("saved_by_account_id");

CREATE INDEX "drafts_saved_by_connected_app_id_idx" ON "drafts"("saved_by_connected_app_id");

ALTER TABLE "drafts" ADD CONSTRAINT "drafts_saved_by_account_id_fkey" FOREIGN KEY ("saved_by_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "drafts" ADD CONSTRAINT "drafts_saved_by_connected_app_id_fkey" FOREIGN KEY ("saved_by_connected_app_id") REFERENCES "connected_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
