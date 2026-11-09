-- Ticket #442: each Machine's latest delivery, which its lastSeenAt reads
-- beside its heartbeats (server/src/machines/machines.service.ts), as one
-- index probe however many deliveries it keeps.
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "machine_event_deliveries_machine_id_received_at_idx";
CREATE INDEX CONCURRENTLY "machine_event_deliveries_machine_id_received_at_idx" ON "machine_event_deliveries" ("machine_id", "received_at");
