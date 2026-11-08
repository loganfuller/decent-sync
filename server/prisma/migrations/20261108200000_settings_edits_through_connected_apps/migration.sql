-- Ticket #413: the Connected App each Settings Edit was made through, if one
-- (ADR-0026), null for the management interface's. The previous release
-- leaves it null (ADR-0025). The constraint is added NOT VALID: every row's
-- value is null as the column is added, so there is nothing to check, and the
-- table is not scanned under its lock; rows written from now on are checked.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "settings_edits" ADD COLUMN "connected_app_id" UUID;

ALTER TABLE "settings_edits" ADD CONSTRAINT "settings_edits_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

COMMIT;
