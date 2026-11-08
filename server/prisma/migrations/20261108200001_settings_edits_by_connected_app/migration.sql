-- Ticket #413: the Settings Edits a Connected App made, found as a lapsed one
-- is kept rather than deleted while any names it.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "settings_edits_connected_app_id_idx";
CREATE INDEX CONCURRENTLY "settings_edits_connected_app_id_idx" ON "settings_edits"("connected_app_id");
