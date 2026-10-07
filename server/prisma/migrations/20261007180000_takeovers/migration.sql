-- The tablet and address of the connection holding each Machine, and each
-- Machine's latest takeover by a connection from another tablet
-- (server/src/machines/takeovers.ts).

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "connected_tablet_id" UUID,
ADD COLUMN     "remote_address" TEXT;

-- CreateTable
CREATE TABLE "takeovers" (
    "machine_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "replaced_tablet_id" UUID NOT NULL,
    "replaced_remote_address" TEXT NOT NULL,
    "replaced_connection_id" TEXT,
    "replaced_plugin_version" TEXT NOT NULL,
    "replaced_decaid_version" TEXT NOT NULL,
    "tablet_id" UUID NOT NULL,
    "remote_address" TEXT NOT NULL,
    "connection_id" TEXT,
    "plugin_version" TEXT NOT NULL,
    "decaid_version" TEXT NOT NULL,

    CONSTRAINT "takeovers_pkey" PRIMARY KEY ("machine_id")
);

-- AddForeignKey
ALTER TABLE "takeovers" ADD CONSTRAINT "takeovers_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
