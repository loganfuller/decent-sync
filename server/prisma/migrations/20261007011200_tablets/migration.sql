-- CreateTable
CREATE TABLE "tablets" (
    "id" UUID NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tablets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_tablets" (
    "id" BIGSERIAL NOT NULL,
    "tablet_id" UUID NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "machine_tablets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "machine_tablets_machine_id_idx" ON "machine_tablets"("machine_id");

-- CreateIndex
CREATE INDEX "machine_tablets_pending_machine_id_idx" ON "machine_tablets"("pending_machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "machine_tablets_tablet_id_machine_id_key" ON "machine_tablets"("tablet_id", "machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "machine_tablets_tablet_id_pending_machine_id_key" ON "machine_tablets"("tablet_id", "pending_machine_id");

-- AddForeignKey
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A tablet is recorded against a Machine, or a Pending Machine until a Machine takes its hardware over.
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
