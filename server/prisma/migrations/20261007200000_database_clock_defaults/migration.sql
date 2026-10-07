-- Creation and receipt times default to PostgreSQL's clock, applied by the
-- database. The defaults were CURRENT_TIMESTAMP, which Prisma reads as its own
-- now() and fills in from the server instance's clock instead (ADR-0016).
-- transaction_timestamp() is the same time under a name Prisma leaves to the
-- database.

-- AlterTable
ALTER TABLE "accounts" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "dismissed_hardware" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "invites" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "location_assignments" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "locations" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "machine_aliases" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "machine_event_deliveries" ALTER COLUMN "received_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "machine_state_events" ALTER COLUMN "received_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "machine_tokens" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "machines" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "pending_machines" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "sessions" ALTER COLUMN "created_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "set_aside_deliveries" ALTER COLUMN "received_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "sign_in_windows" ALTER COLUMN "started_at" SET DEFAULT transaction_timestamp();

-- AlterTable
ALTER TABLE "workflow_events" ALTER COLUMN "received_at" SET DEFAULT transaction_timestamp();
