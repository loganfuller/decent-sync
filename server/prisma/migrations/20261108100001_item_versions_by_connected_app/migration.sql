-- Ticket #411: the versions a Connected App made, found as a lapsed one is
-- kept rather than deleted while any names it.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "item_versions_connected_app_id_idx";
CREATE INDEX CONCURRENTLY "item_versions_connected_app_id_idx" ON "item_versions"("connected_app_id");
