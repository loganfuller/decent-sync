-- Ticket #432: each Machine's Settings History, each value its tablet
-- reported for one of the collections it keeps that differs from the one
-- before it. A new table, which the previous release neither reads nor
-- writes (ADR-0025). Its baselines are taken from the stored latest values
-- by the server, in the background, not here.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "settings_history" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "tablet_id" UUID,
    "name" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "utc_offset_minutes" INTEGER,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "settings_edit_id" UUID,
    "edited_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "settings_history_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "settings_history" ALTER COLUMN "value" SET COMPRESSION lz4;

CREATE INDEX "settings_history_machine_id_name_received_at_idx" ON "settings_history"("machine_id", "name", "received_at");

CREATE INDEX "settings_history_pending_machine_id_name_received_at_idx" ON "settings_history"("pending_machine_id", "name", "received_at");

ALTER TABLE "settings_history" ADD CONSTRAINT "settings_history_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "settings_history" ADD CONSTRAINT "settings_history_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "settings_history" ADD CONSTRAINT "settings_history_settings_edit_id_fkey" FOREIGN KEY ("settings_edit_id") REFERENCES "settings_edits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "settings_history" ADD CONSTRAINT "settings_history_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));

COMMIT;
