-- Ticket #260: the Live View's leases (ADR-0024), one for each Live View open
-- on a Machine's page, renewed by its stream's instance and judged by
-- PostgreSQL's clock. A new table, which the previous release never reads.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "live_view_leases" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "live_view_leases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "live_view_leases_machine_id_expires_at_idx" ON "live_view_leases"("machine_id", "expires_at");

CREATE INDEX "live_view_leases_session_id_idx" ON "live_view_leases"("session_id");

ALTER TABLE "live_view_leases" ADD CONSTRAINT "live_view_leases_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "live_view_leases" ADD CONSTRAINT "live_view_leases_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
