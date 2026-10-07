-- Delivery ids are deleted once older than the retention period
-- (server/src/machines/delivery-id-cleanup.ts), found by when they were recorded.

-- CreateIndex
CREATE INDEX "machine_event_deliveries_received_at_idx" ON "machine_event_deliveries"("received_at");
