-- A Machine's Workflows over a time range, as an assistant reads them (#407), found by when each was observed.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "workflow_events_machine_id_observed_at_id_idx";
CREATE INDEX CONCURRENTLY "workflow_events_machine_id_observed_at_id_idx" ON "workflow_events"("machine_id", "observed_at", "id");
