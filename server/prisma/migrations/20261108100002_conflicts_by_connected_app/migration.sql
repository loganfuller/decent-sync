-- Ticket #411: the Conflicts a Connected App made, found as a lapsed one is
-- kept rather than deleted while any names it.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "conflicts_connected_app_id_idx";
CREATE INDEX CONCURRENTLY "conflicts_connected_app_id_idx" ON "conflicts"("connected_app_id");
