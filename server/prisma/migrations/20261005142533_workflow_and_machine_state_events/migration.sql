-- CreateTable
CREATE TABLE "workflow_events" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflow" JSONB NOT NULL,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_state_events" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" TEXT NOT NULL,
    "substate" TEXT NOT NULL,

    CONSTRAINT "machine_state_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_event_deliveries" (
    "machine_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_event_deliveries_pkey" PRIMARY KEY ("machine_id","delivery_id")
);

-- CreateIndex
CREATE INDEX "workflow_events_machine_id_id_idx" ON "workflow_events"("machine_id", "id");

-- CreateIndex
CREATE INDEX "workflow_events_pending_machine_id_id_idx" ON "workflow_events"("pending_machine_id", "id");

-- CreateIndex
CREATE INDEX "machine_state_events_machine_id_id_idx" ON "machine_state_events"("machine_id", "id");

-- CreateIndex
CREATE INDEX "machine_state_events_pending_machine_id_id_idx" ON "machine_state_events"("pending_machine_id", "id");

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_state_events" ADD CONSTRAINT "machine_state_events_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_state_events" ADD CONSTRAINT "machine_state_events_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_event_deliveries" ADD CONSTRAINT "machine_event_deliveries_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An event belongs to a Machine, or to a Pending Machine until a Machine takes its hardware over.
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
ALTER TABLE "machine_state_events" ADD CONSTRAINT "machine_state_events_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
