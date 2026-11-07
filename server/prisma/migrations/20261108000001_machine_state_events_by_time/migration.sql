-- A Machine's Machine States over a time range, as an assistant reads them (#407), found by when each was observed.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "machine_state_events_machine_id_observed_at_id_idx";
CREATE INDEX CONCURRENTLY "machine_state_events_machine_id_observed_at_id_idx" ON "machine_state_events"("machine_id", "observed_at", "id");
