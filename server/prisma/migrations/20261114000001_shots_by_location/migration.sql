-- Ticket #509: a page of a Location's Shots, newest first, which each of its
-- tablets reads for a Skin (server/src/shots/location-shots.ts), as one index
-- range however many Shots the other Locations hold. Without it, a Location
-- with few Shots, or none yet, had the whole index on pulled_at read for
-- every page. Ordered NULLS LAST, as the other indexes on pulled_at are.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "shots_location_id_pulled_at_id_idx";
CREATE INDEX CONCURRENTLY "shots_location_id_pulled_at_id_idx" ON "shots" ("location_id", "pulled_at" DESC NULLS LAST, "id");
