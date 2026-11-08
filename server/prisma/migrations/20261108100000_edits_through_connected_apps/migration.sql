-- Ticket #411: the Connected App each of the Library's versions and Conflicts
-- came through, if one (ADR-0026), null for the management interface's and
-- tablets'. The previous release leaves it null (ADR-0025). Each constraint
-- is added NOT VALID: every row's value is null as the column is added, so
-- there is nothing to check, and the table is not scanned under its lock;
-- rows written from now on are checked.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "item_versions" ADD COLUMN "connected_app_id" UUID;
ALTER TABLE "conflicts" ADD COLUMN "connected_app_id" UUID;

ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

COMMIT;
