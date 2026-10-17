-- Measurements use lz4 column compression, which needs PostgreSQL 14 or newer.
DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'Decent Sync needs PostgreSQL 14 or newer; this server runs %', current_setting('server_version');
  END IF;
END
$$;

-- PostgreSQL ends a session that sits in an open transaction for 30 s without
-- running a statement. If a server instance's host vanishes mid-transaction,
-- PostgreSQL may not notice the lost connection for hours, and the transaction
-- would keep its row locks (such as a Machine's) until then. The server runs a
-- transaction's statements back to back and Prisma times it out after 5 s, so
-- only an abandoned one waits this long.
--
-- Set on the database rather than sent by each connection at startup, which a
-- pooler may refuse or drop. It applies to sessions started afterwards; the
-- server migrates before its own connections open. Only the database's owner
-- or a superuser may set it, so for anyone else this raises a notice instead,
-- and the server warns at startup while the timeout is off.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '30s');
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Only the owner of database % or a superuser may set its idle_in_transaction_session_timeout; Decent Sync warns at startup while it is off', current_database();
END
$$;

-- CreateEnum
CREATE TYPE "account_role" AS ENUM ('ADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "machine_identification" AS ENUM ('HARDWARE_NOT_REPORTED', 'IDENTIFIED', 'UNIDENTIFIED', 'MISMATCH');

-- CreateEnum
CREATE TYPE "conflict_state" AS ENUM ('OPEN', 'USED', 'DISMISSED');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "account_role" NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deactivated_at" TIMESTAMPTZ(3),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_locations" (
    "account_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,

    CONSTRAINT "staff_locations_pkey" PRIMARY KEY ("account_id","location_id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "secret_hash" BYTEA NOT NULL,
    "email" TEXT NOT NULL,
    "role" "account_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_locations" (
    "invite_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,

    CONSTRAINT "invite_locations_pkey" PRIMARY KEY ("invite_id","location_id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "secret_hash" BYTEA NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign_in_windows" (
    "email" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "sign_in_windows_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "serial" TEXT,
    "identification" "machine_identification" NOT NULL DEFAULT 'HARDWARE_NOT_REPORTED',
    "reported_model" TEXT,
    "reported_serial" TEXT,
    "firmware" TEXT,
    "connection_id" TEXT,
    "plugin_version" TEXT,
    "decaid_version" TEXT,
    "remote_address" TEXT,
    "sharing" BOOLEAN NOT NULL DEFAULT true,
    "sharing_since" TIMESTAMPTZ(3),
    "refusal_reason" TEXT,
    "refused_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "connected_session_id" UUID,
    "connected_tablet_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_assignments" (
    "id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "location_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_tokens" (
    "id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "machine_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "machine_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_aliases" (
    "machine_id" UUID NOT NULL,
    "connection_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "machine_aliases_pkey" PRIMARY KEY ("machine_id","connection_id")
);

-- CreateTable
CREATE TABLE "pending_machines" (
    "id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "last_seen_at" TIMESTAMPTZ(3),
    "dismissed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pending_machines_pkey" PRIMARY KEY ("id")
);

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
    "last_hello" BIGSERIAL NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "machine_tablets_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "dismissed_hardware" (
    "machine_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "dismissed_hardware_pkey" PRIMARY KEY ("machine_id","model","serial")
);

-- CreateTable
CREATE TABLE "shots" (
    "id" TEXT NOT NULL,
    "has_full_record" BOOLEAN NOT NULL DEFAULT false,
    "record" JSONB NOT NULL,
    "version_at" TIMESTAMPTZ(6) NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "machine_inferred" BOOLEAN NOT NULL DEFAULT false,
    "location_id" UUID,
    "pulled_at" TIMESTAMPTZ(3),
    "bean_batch_id" TEXT,
    "grinder_id" TEXT,
    "grinder_burrs" TEXT,
    "tablet_id" UUID,
    "library_batch_id" UUID,
    "library_grinder_id" UUID,
    "basket_id" TEXT,
    "library_basket_id" UUID,
    "tool_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "library_tool_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recipe_id" UUID,
    "selection_named" BOOLEAN NOT NULL DEFAULT false,
    "coffee_name" TEXT,
    "coffee_roaster" TEXT,
    "profile_title" TEXT,
    "profile_id" TEXT,
    "target_dose" DOUBLE PRECISION,
    "actual_dose" DOUBLE PRECISION,
    "target_yield" DOUBLE PRECISION,
    "actual_yield" DOUBLE PRECISION,
    "duration" DOUBLE PRECISION,
    "enjoyment" DOUBLE PRECISION,
    "barista" TEXT,
    "peak_pressure" DOUBLE PRECISION,
    "peak_flow" DOUBLE PRECISION,

    CONSTRAINT "shots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_measurements" (
    "shot_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "shot_measurements_pkey" PRIMARY KEY ("shot_id")
);

-- CreateTable
CREATE TABLE "steam_records" (
    "id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "location_id" UUID,
    "steamed_at" TIMESTAMPTZ(3) NOT NULL,
    "duration" DOUBLE PRECISION,
    "peak_milk_temperature" DOUBLE PRECISION,
    "final_milk_temperature" DOUBLE PRECISION,
    "barista" TEXT,

    CONSTRAINT "steam_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steam_measurements" (
    "steam_record_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "steam_measurements_pkey" PRIMARY KEY ("steam_record_id")
);

-- CreateTable
CREATE TABLE "workflow_events" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "workflow" JSONB NOT NULL,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_state_events" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "state" TEXT NOT NULL,
    "substate" TEXT NOT NULL,

    CONSTRAINT "machine_state_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_event_deliveries" (
    "machine_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "machine_event_deliveries_pkey" PRIMARY KEY ("machine_id","delivery_id")
);

-- CreateTable
CREATE TABLE "reported_collections" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID,
    "pending_machine_id" UUID,
    "name" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL,
    "value" JSONB,
    "received_at" TIMESTAMPTZ(3),
    "items" INTEGER,

    CONSTRAINT "reported_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "set_aside_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "record_id" TEXT,
    "sql_state" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "message" TEXT NOT NULL,

    CONSTRAINT "set_aside_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beans" (
    "id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "match_key" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "beans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bean_origins" (
    "bean_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "since" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "bean_origins_pkey" PRIMARY KEY ("bean_id","location_id")
);

-- CreateTable
CREATE TABLE "tablet_beans" (
    "tablet_id" UUID NOT NULL,
    "bean_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "seen_at" TIMESTAMPTZ(3),
    "seen_location_id" UUID,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_beans_pkey" PRIMARY KEY ("tablet_id","bean_id")
);

-- CreateTable
CREATE TABLE "bean_batches" (
    "id" UUID NOT NULL,
    "bean_id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "bean_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_locations" (
    "batch_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "presence_decided_at" TIMESTAMPTZ(3),
    "remaining_weight" DOUBLE PRECISION,
    "remaining_weight_at" TIMESTAMPTZ(3),
    "presence_version_id" UUID,
    "remaining_weight_version_id" UUID,

    CONSTRAINT "batch_locations_pkey" PRIMARY KEY ("batch_id","location_id")
);

-- CreateTable
CREATE TABLE "tablet_bean_batches" (
    "tablet_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "seen_at" TIMESTAMPTZ(3),
    "seen_location_id" UUID,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_bean_batches_pkey" PRIMARY KEY ("tablet_id","batch_id")
);

-- CreateTable
CREATE TABLE "grinders" (
    "id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "grinders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tablet_grinders" (
    "tablet_id" UUID NOT NULL,
    "grinder_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_grinders_pkey" PRIMARY KEY ("tablet_id","grinder_id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "bundled" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_locations" (
    "profile_id" TEXT NOT NULL,
    "location_id" UUID NOT NULL,
    "shown" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "decided_by_tablet_id" UUID,
    "version_id" UUID,

    CONSTRAINT "profile_locations_pkey" PRIMARY KEY ("profile_id","location_id")
);

-- CreateTable
CREATE TABLE "tablet_profiles" (
    "tablet_id" UUID NOT NULL,
    "profile_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "seen_at" TIMESTAMPTZ(3),
    "seen_location_id" UUID,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_profiles_pkey" PRIMARY KEY ("tablet_id","profile_id")
);

-- CreateTable
CREATE TABLE "baskets" (
    "id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "match_key" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "baskets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "basket_locations" (
    "basket_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "shown" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "decided_by_tablet_id" UUID,
    "version_id" UUID,

    CONSTRAINT "basket_locations_pkey" PRIMARY KEY ("basket_id","location_id")
);

-- CreateTable
CREATE TABLE "tablet_baskets" (
    "tablet_id" UUID NOT NULL,
    "basket_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "before_write" JSONB,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "seen_at" TIMESTAMPTZ(3),
    "seen_location_id" UUID,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_baskets_pkey" PRIMARY KEY ("tablet_id","basket_id")
);

-- CreateTable
CREATE TABLE "tools" (
    "id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "match_key" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_locations" (
    "tool_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "shown" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "decided_by_tablet_id" UUID,
    "version_id" UUID,

    CONSTRAINT "tool_locations_pkey" PRIMARY KEY ("tool_id","location_id")
);

-- CreateTable
CREATE TABLE "tablet_tools" (
    "tablet_id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "before_write" JSONB,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "seen_at" TIMESTAMPTZ(3),
    "seen_location_id" UUID,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_tools_pkey" PRIMARY KEY ("tablet_id","tool_id")
);

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "location_id" UUID,
    "slot" INTEGER,
    "content" JSONB NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "field_edits" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loaded_recipes" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "loaded_at" TIMESTAMPTZ(3) NOT NULL,
    "unloaded_at" TIMESTAMPTZ(3),
    "load_before" JSONB,

    CONSTRAINT "loaded_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tablet_loaded_recipes" (
    "tablet_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "held" JSONB NOT NULL,

    CONSTRAINT "tablet_loaded_recipes_pkey" PRIMARY KEY ("tablet_id")
);

-- CreateTable
CREATE TABLE "tablet_recipes" (
    "tablet_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),
    "before_write" JSONB,
    "listed" BOOLEAN NOT NULL DEFAULT true,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_recipes_pkey" PRIMARY KEY ("tablet_id","recipe_id")
);

-- CreateTable
CREATE TABLE "tablet_removed_recipes" (
    "tablet_id" UUID NOT NULL,
    "local_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,

    CONSTRAINT "tablet_removed_recipes_pkey" PRIMARY KEY ("tablet_id","local_id")
);

-- CreateTable
CREATE TABLE "tablet_unrecognised_lists" (
    "tablet_id" UUID NOT NULL,
    "list" TEXT NOT NULL,
    "since" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "tablet_unrecognised_lists_pkey" PRIMARY KEY ("tablet_id","list")
);

-- CreateTable
CREATE TABLE "versioned_items" (
    "kind" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,

    CONSTRAINT "versioned_items_pkey" PRIMARY KEY ("kind","item_id")
);

-- CreateTable
CREATE TABLE "item_versions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "location_id" UUID,
    "fields" JSONB NOT NULL,
    "machine_id" UUID,
    "tablet_id" UUID,
    "account_id" UUID,
    "edited_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "seq" BIGSERIAL NOT NULL,
    "copied_from_id" TEXT,
    "copied_from_location_id" UUID,

    CONSTRAINT "item_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflicts" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "location_id" UUID,
    "field" TEXT NOT NULL,
    "value" JSONB,
    "machine_id" UUID,
    "tablet_id" UUID,
    "account_id" UUID,
    "edited_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "seq" BIGSERIAL NOT NULL,
    "state" "conflict_state" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_items" (
    "kind" TEXT NOT NULL,
    "item_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "deleted_items_pkey" PRIMARY KEY ("kind","item_id")
);

-- CreateTable
CREATE TABLE "tablet_deletions" (
    "tablet_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "bean_local_id" TEXT,
    "profile_steps" JSONB,

    CONSTRAINT "tablet_deletions_pkey" PRIMARY KEY ("tablet_id","kind","local_id")
);

-- CreateTable
CREATE TABLE "tablet_left_out" (
    "tablet_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "local_id" TEXT NOT NULL,
    "set_aside" BOOLEAN NOT NULL,

    CONSTRAINT "tablet_left_out_pkey" PRIMARY KEY ("tablet_id","kind","local_id")
);

-- CreateTable
CREATE TABLE "tablet_reports" (
    "tablet_id" UUID NOT NULL,
    "report" TEXT NOT NULL,
    "assignment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sharing_since" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_reports_pkey" PRIMARY KEY ("tablet_id","report")
);

-- CreateTable
CREATE TABLE "workflow_clears" (
    "tablet_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "expected" JSONB NOT NULL,

    CONSTRAINT "workflow_clears_pkey" PRIMARY KEY ("tablet_id")
);

-- CreateTable
CREATE TABLE "tablet_refusals" (
    "tablet_id" UUID NOT NULL,
    "change_key" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT,
    "local_id" TEXT,
    "signature" TEXT NOT NULL,
    "status" INTEGER,
    "error" TEXT NOT NULL,
    "refused_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "tablet_refusals_pkey" PRIMARY KEY ("tablet_id","change_key")
);

-- CreateTable
CREATE TABLE "tablet_last_applied" (
    "tablet_id" UUID NOT NULL,
    "change" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT,
    "local_id" TEXT,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tablet_last_applied_pkey" PRIMARY KEY ("tablet_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE INDEX "staff_locations_location_id_idx" ON "staff_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_secret_hash_key" ON "invites"("secret_hash");

-- CreateIndex
CREATE INDEX "invite_locations_location_id_idx" ON "invite_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_secret_hash_key" ON "password_resets"("secret_hash");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_account_id_key" ON "password_resets"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_account_id_idx" ON "sessions"("account_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "sign_in_windows_started_at_idx" ON "sign_in_windows"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "locations_name_key" ON "locations"("name");

-- CreateIndex
CREATE UNIQUE INDEX "machines_name_key" ON "machines"("name");

-- CreateIndex
CREATE UNIQUE INDEX "machines_model_serial_key" ON "machines"("model", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "location_assignments_machine_id_effective_from_key" ON "location_assignments"("machine_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "machine_tokens_token_hash_key" ON "machine_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "machine_tokens_machine_id_idx" ON "machine_tokens"("machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_machines_model_serial_key" ON "pending_machines"("model", "serial");

-- CreateIndex
CREATE INDEX "machine_tablets_machine_id_idx" ON "machine_tablets"("machine_id");

-- CreateIndex
CREATE INDEX "machine_tablets_pending_machine_id_idx" ON "machine_tablets"("pending_machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "machine_tablets_tablet_id_machine_id_key" ON "machine_tablets"("tablet_id", "machine_id");

-- CreateIndex
CREATE UNIQUE INDEX "machine_tablets_tablet_id_pending_machine_id_key" ON "machine_tablets"("tablet_id", "pending_machine_id");

-- CreateIndex
CREATE INDEX "shots_pulled_at_id_idx" ON "shots"("pulled_at" DESC NULLS LAST, "id");

-- CreateIndex
CREATE INDEX "shots_machine_id_pulled_at_id_idx" ON "shots"("machine_id", "pulled_at" DESC NULLS LAST, "id");

-- CreateIndex
CREATE INDEX "shots_pending_machine_id_idx" ON "shots"("pending_machine_id");

-- CreateIndex
CREATE INDEX "shots_bean_batch_id_idx" ON "shots"("bean_batch_id");

-- CreateIndex
CREATE INDEX "shots_grinder_id_idx" ON "shots"("grinder_id");

-- CreateIndex
CREATE INDEX "shots_profile_id_idx" ON "shots"("profile_id");

-- CreateIndex
CREATE INDEX "shots_library_batch_id_idx" ON "shots"("library_batch_id");

-- CreateIndex
CREATE INDEX "shots_library_grinder_id_idx" ON "shots"("library_grinder_id");

-- CreateIndex
CREATE INDEX "shots_basket_id_idx" ON "shots"("basket_id");

-- CreateIndex
CREATE INDEX "shots_library_basket_id_idx" ON "shots"("library_basket_id");

-- CreateIndex
CREATE INDEX "shots_recipe_id_idx" ON "shots"("recipe_id");

-- CreateIndex
CREATE INDEX "shots_tool_ids_idx" ON "shots" USING GIN ("tool_ids");

-- CreateIndex
CREATE INDEX "shots_library_tool_ids_idx" ON "shots" USING GIN ("library_tool_ids");

-- CreateIndex
CREATE INDEX "steam_records_steamed_at_id_idx" ON "steam_records"("steamed_at" DESC, "id");

-- CreateIndex
CREATE INDEX "steam_records_machine_id_steamed_at_id_idx" ON "steam_records"("machine_id", "steamed_at" DESC, "id");

-- CreateIndex
CREATE INDEX "steam_records_pending_machine_id_idx" ON "steam_records"("pending_machine_id");

-- CreateIndex
CREATE INDEX "workflow_events_machine_id_id_idx" ON "workflow_events"("machine_id", "id");

-- CreateIndex
CREATE INDEX "workflow_events_pending_machine_id_id_idx" ON "workflow_events"("pending_machine_id", "id");

-- CreateIndex
CREATE INDEX "machine_state_events_machine_id_id_idx" ON "machine_state_events"("machine_id", "id");

-- CreateIndex
CREATE INDEX "machine_state_events_pending_machine_id_id_idx" ON "machine_state_events"("pending_machine_id", "id");

-- CreateIndex
CREATE INDEX "machine_event_deliveries_received_at_idx" ON "machine_event_deliveries"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "reported_collections_machine_id_name_key" ON "reported_collections"("machine_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "reported_collections_pending_machine_id_name_key" ON "reported_collections"("pending_machine_id", "name");

-- CreateIndex
CREATE INDEX "set_aside_deliveries_machine_id_id_idx" ON "set_aside_deliveries"("machine_id", "id");

-- CreateIndex
CREATE INDEX "set_aside_deliveries_machine_id_record_id_idx" ON "set_aside_deliveries"("machine_id", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "set_aside_deliveries_machine_id_delivery_id_key" ON "set_aside_deliveries"("machine_id", "delivery_id");

-- CreateIndex
CREATE INDEX "beans_match_key_idx" ON "beans"("match_key");

-- CreateIndex
CREATE INDEX "bean_origins_location_id_idx" ON "bean_origins"("location_id");

-- CreateIndex
CREATE INDEX "tablet_beans_bean_id_idx" ON "tablet_beans"("bean_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_beans_tablet_id_local_id_key" ON "tablet_beans"("tablet_id", "local_id");

-- CreateIndex
CREATE INDEX "bean_batches_bean_id_idx" ON "bean_batches"("bean_id");

-- CreateIndex
CREATE INDEX "batch_locations_location_id_idx" ON "batch_locations"("location_id");

-- CreateIndex
CREATE INDEX "tablet_bean_batches_batch_id_idx" ON "tablet_bean_batches"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_bean_batches_tablet_id_local_id_key" ON "tablet_bean_batches"("tablet_id", "local_id");

-- CreateIndex
CREATE INDEX "grinders_location_id_idx" ON "grinders"("location_id");

-- CreateIndex
CREATE INDEX "tablet_grinders_grinder_id_idx" ON "tablet_grinders"("grinder_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_grinders_tablet_id_local_id_key" ON "tablet_grinders"("tablet_id", "local_id");

-- CreateIndex
CREATE INDEX "profile_locations_location_id_idx" ON "profile_locations"("location_id");

-- CreateIndex
CREATE INDEX "tablet_profiles_profile_id_idx" ON "tablet_profiles"("profile_id");

-- CreateIndex
CREATE INDEX "baskets_match_key_idx" ON "baskets"("match_key");

-- CreateIndex
CREATE INDEX "basket_locations_location_id_idx" ON "basket_locations"("location_id");

-- CreateIndex
CREATE INDEX "tablet_baskets_basket_id_idx" ON "tablet_baskets"("basket_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_baskets_tablet_id_local_id_key" ON "tablet_baskets"("tablet_id", "local_id");

-- CreateIndex
CREATE INDEX "tools_match_key_idx" ON "tools"("match_key");

-- CreateIndex
CREATE INDEX "tool_locations_location_id_idx" ON "tool_locations"("location_id");

-- CreateIndex
CREATE INDEX "tablet_tools_tool_id_idx" ON "tablet_tools"("tool_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_tools_tablet_id_local_id_key" ON "tablet_tools"("tablet_id", "local_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_location_id_slot_key" ON "recipes"("location_id", "slot");

-- CreateIndex
CREATE INDEX "loaded_recipes_machine_id_id_idx" ON "loaded_recipes"("machine_id", "id");

-- CreateIndex
CREATE INDEX "loaded_recipes_recipe_id_idx" ON "loaded_recipes"("recipe_id");

-- CreateIndex
CREATE INDEX "loaded_recipes_machine_id_recipe_id_loaded_at_id_idx" ON "loaded_recipes"("machine_id", "recipe_id", "loaded_at", "id");

-- CreateIndex
CREATE INDEX "loaded_recipes_machine_id_loaded_at_id_idx" ON "loaded_recipes"("machine_id", "loaded_at", "id");

-- CreateIndex
CREATE INDEX "tablet_loaded_recipes_recipe_id_idx" ON "tablet_loaded_recipes"("recipe_id");

-- CreateIndex
CREATE INDEX "tablet_recipes_recipe_id_idx" ON "tablet_recipes"("recipe_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_recipes_tablet_id_local_id_key" ON "tablet_recipes"("tablet_id", "local_id");

-- CreateIndex
CREATE INDEX "item_versions_kind_item_id_received_at_idx" ON "item_versions"("kind", "item_id", "received_at");

-- CreateIndex
CREATE INDEX "item_versions_location_id_idx" ON "item_versions"("location_id");

-- CreateIndex
CREATE INDEX "item_versions_copied_from_location_id_idx" ON "item_versions"("copied_from_location_id");

-- CreateIndex
CREATE INDEX "item_versions_machine_id_idx" ON "item_versions"("machine_id");

-- CreateIndex
CREATE INDEX "item_versions_tablet_id_idx" ON "item_versions"("tablet_id");

-- CreateIndex
CREATE INDEX "item_versions_account_id_idx" ON "item_versions"("account_id");

-- CreateIndex
CREATE INDEX "conflicts_state_created_at_idx" ON "conflicts"("state", "created_at");

-- CreateIndex
CREATE INDEX "conflicts_kind_item_id_idx" ON "conflicts"("kind", "item_id");

-- CreateIndex
CREATE INDEX "conflicts_location_id_idx" ON "conflicts"("location_id");

-- CreateIndex
CREATE INDEX "conflicts_machine_id_idx" ON "conflicts"("machine_id");

-- CreateIndex
CREATE INDEX "conflicts_tablet_id_idx" ON "conflicts"("tablet_id");

-- CreateIndex
CREATE INDEX "conflicts_account_id_idx" ON "conflicts"("account_id");

-- CreateIndex
CREATE INDEX "workflow_clears_location_id_idx" ON "workflow_clears"("location_id");

-- AddForeignKey
ALTER TABLE "staff_locations" ADD CONSTRAINT "staff_locations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_locations" ADD CONSTRAINT "staff_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_locations" ADD CONSTRAINT "invite_locations_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "invites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_locations" ADD CONSTRAINT "invite_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_assignments" ADD CONSTRAINT "location_assignments_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_assignments" ADD CONSTRAINT "location_assignments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_tokens" ADD CONSTRAINT "machine_tokens_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_aliases" ADD CONSTRAINT "machine_aliases_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takeovers" ADD CONSTRAINT "takeovers_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dismissed_hardware" ADD CONSTRAINT "dismissed_hardware_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_batch_id_fkey" FOREIGN KEY ("library_batch_id") REFERENCES "bean_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_grinder_id_fkey" FOREIGN KEY ("library_grinder_id") REFERENCES "grinders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_library_basket_id_fkey" FOREIGN KEY ("library_basket_id") REFERENCES "baskets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_measurements" ADD CONSTRAINT "shot_measurements_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "steam_measurements" ADD CONSTRAINT "steam_measurements_steam_record_id_fkey" FOREIGN KEY ("steam_record_id") REFERENCES "steam_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_pending_machine_id_fkey" FOREIGN KEY ("pending_machine_id") REFERENCES "pending_machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "set_aside_deliveries" ADD CONSTRAINT "set_aside_deliveries_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beans" ADD CONSTRAINT "beans_created_location_id_fkey" FOREIGN KEY ("created_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bean_origins" ADD CONSTRAINT "bean_origins_bean_id_fkey" FOREIGN KEY ("bean_id") REFERENCES "beans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bean_origins" ADD CONSTRAINT "bean_origins_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_beans" ADD CONSTRAINT "tablet_beans_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_beans" ADD CONSTRAINT "tablet_beans_bean_id_fkey" FOREIGN KEY ("bean_id") REFERENCES "beans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bean_batches" ADD CONSTRAINT "bean_batches_bean_id_fkey" FOREIGN KEY ("bean_id") REFERENCES "beans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bean_batches" ADD CONSTRAINT "bean_batches_created_location_id_fkey" FOREIGN KEY ("created_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_locations" ADD CONSTRAINT "batch_locations_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_locations" ADD CONSTRAINT "batch_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_bean_batches" ADD CONSTRAINT "tablet_bean_batches_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_bean_batches" ADD CONSTRAINT "tablet_bean_batches_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bean_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grinders" ADD CONSTRAINT "grinders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_grinders" ADD CONSTRAINT "tablet_grinders_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_grinders" ADD CONSTRAINT "tablet_grinders_grinder_id_fkey" FOREIGN KEY ("grinder_id") REFERENCES "grinders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_created_location_id_fkey" FOREIGN KEY ("created_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_locations" ADD CONSTRAINT "profile_locations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_locations" ADD CONSTRAINT "profile_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_profiles" ADD CONSTRAINT "tablet_profiles_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_profiles" ADD CONSTRAINT "tablet_profiles_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_created_location_id_fkey" FOREIGN KEY ("created_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "basket_locations" ADD CONSTRAINT "basket_locations_basket_id_fkey" FOREIGN KEY ("basket_id") REFERENCES "baskets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "basket_locations" ADD CONSTRAINT "basket_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_baskets" ADD CONSTRAINT "tablet_baskets_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_baskets" ADD CONSTRAINT "tablet_baskets_basket_id_fkey" FOREIGN KEY ("basket_id") REFERENCES "baskets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tools" ADD CONSTRAINT "tools_created_location_id_fkey" FOREIGN KEY ("created_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_locations" ADD CONSTRAINT "tool_locations_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_locations" ADD CONSTRAINT "tool_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_tools" ADD CONSTRAINT "tablet_tools_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_tools" ADD CONSTRAINT "tablet_tools_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loaded_recipes" ADD CONSTRAINT "loaded_recipes_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loaded_recipes" ADD CONSTRAINT "loaded_recipes_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_loaded_recipes" ADD CONSTRAINT "tablet_loaded_recipes_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_recipes" ADD CONSTRAINT "tablet_recipes_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_recipes" ADD CONSTRAINT "tablet_recipes_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_removed_recipes" ADD CONSTRAINT "tablet_removed_recipes_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_unrecognised_lists" ADD CONSTRAINT "tablet_unrecognised_lists_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_kind_item_id_fkey" FOREIGN KEY ("kind", "item_id") REFERENCES "versioned_items"("kind", "item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_copied_from_location_id_fkey" FOREIGN KEY ("copied_from_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_kind_item_id_fkey" FOREIGN KEY ("kind", "item_id") REFERENCES "versioned_items"("kind", "item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_deletions" ADD CONSTRAINT "tablet_deletions_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_left_out" ADD CONSTRAINT "tablet_left_out_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_reports" ADD CONSTRAINT "tablet_reports_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_clears" ADD CONSTRAINT "workflow_clears_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_clears" ADD CONSTRAINT "workflow_clears_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_refusals" ADD CONSTRAINT "tablet_refusals_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tablet_last_applied" ADD CONSTRAINT "tablet_last_applied_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Metadata pages and lists never detoast the curves, and a Machine's profiles,
-- or a Shot's message, curves included, can run to megabytes.
ALTER TABLE "shot_measurements" ALTER COLUMN "data" SET COMPRESSION lz4;
ALTER TABLE "steam_measurements" ALTER COLUMN "data" SET COMPRESSION lz4;
ALTER TABLE "reported_collections" ALTER COLUMN "value" SET COMPRESSION lz4;
ALTER TABLE "set_aside_deliveries" ALTER COLUMN "message" SET COMPRESSION lz4;

-- A Shot is credited to a Machine or to a Pending Machine, never both, once its
-- full record arrives; an edit that arrived before it is credited to neither.
ALTER TABLE "shots" ADD CONSTRAINT "shots_credit_check" CHECK (
  (NOT has_full_record AND machine_id IS NULL AND pending_machine_id IS NULL)
  OR (has_full_record AND (machine_id IS NULL) <> (pending_machine_id IS NULL))
);
-- Each Steam Record is credited to a Machine or to a Pending Machine, never both.
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_credit_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
-- Only Machines have a Location History: a record held by a Pending Machine has no Location.
ALTER TABLE "shots" ADD CONSTRAINT "shots_location_check" CHECK (location_id IS NULL OR machine_id IS NOT NULL);
ALTER TABLE "steam_records" ADD CONSTRAINT "steam_records_location_check" CHECK (location_id IS NULL OR machine_id IS NOT NULL);
-- An event, a collection or a tablet belongs to a Machine, or to a Pending
-- Machine until a Machine takes its hardware over.
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
ALTER TABLE "machine_state_events" ADD CONSTRAINT "machine_state_events_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
ALTER TABLE "machine_tablets" ADD CONSTRAINT "machine_tablets_holder_check" CHECK ((machine_id IS NULL) <> (pending_machine_id IS NULL));
-- A value is kept with the time it was received, and a count only for a value.
ALTER TABLE "reported_collections" ADD CONSTRAINT "reported_collections_value_check" CHECK ((value IS NULL) = (received_at IS NULL) AND (value IS NOT NULL OR items IS NULL));
-- A slot is a positive whole number, and an Archived Recipe has none.
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_slot_check" CHECK ("slot" IS NULL OR "slot" > 0);
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_archived_slot_check" CHECK (NOT "archived" OR "slot" IS NULL);

-- A Machine has at most one Loaded Recipe at a time.
CREATE UNIQUE INDEX "loaded_recipes_current_key" ON "loaded_recipes"("machine_id") WHERE "unloaded_at" IS NULL;

-- The Shots still to link, found by their ids on their tablet when its map gains one.
CREATE INDEX "shots_unlinked_batch_idx" ON "shots"("bean_batch_id") WHERE "library_batch_id" IS NULL;
CREATE INDEX "shots_unlinked_grinder_idx" ON "shots"("grinder_id") WHERE "library_grinder_id" IS NULL;
CREATE INDEX "shots_unlinked_basket_idx" ON "shots"("basket_id") WHERE "library_basket_id" IS NULL;

-- A profile's steps as they identify it, leaving out what a skin overrides
-- in the profile it loads into the Workflow, which is the barista's input to
-- the Shot rather than another profile: each step's temperature, which
-- streamline-js's temperature setting writes into every step, and a step's
-- limiter of value 0, which is no limiter (de1app's own sentinel), and which
-- streamline-js sends as null (`updateWorkflow` in
-- streamline-js:src/modules/api.js) while the profile's record keeps it.
CREATE FUNCTION "profile_steps_key"(steps JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(steps) = 'array' THEN (
    SELECT coalesce(jsonb_agg(
      CASE WHEN jsonb_typeof(step) = 'object' THEN
        (CASE WHEN jsonb_typeof(step -> 'limiter') = 'object' AND step -> 'limiter' -> 'value' = '0'::jsonb
          THEN jsonb_set(step, '{limiter}', 'null'::jsonb) ELSE step END) - 'temperature'
      ELSE step END
      ORDER BY position), '[]'::jsonb)
    FROM jsonb_array_elements(steps) WITH ORDINALITY AS listed(step, position)
  ) ELSE steps END
$$;

-- A Shot's Workflow's profile is found by its steps as they identify it.
CREATE INDEX "shots_profile_steps_idx" ON "shots" USING hash (profile_steps_key("record" -> 'workflow' -> 'profile' -> 'steps'));

-- The Profiles a Shot's Workflow's profile may be, found the same way.
CREATE INDEX "profiles_steps_idx" ON "profiles" USING hash (profile_steps_key("content" -> 'profile' -> 'steps'));

-- Versions and Conflicts name their item by its kind and id (ticket #135),
-- so a new kind of Library item needs no column of its own in them. Each
-- item that keeps versions and Conflicts has a row in `versioned_items`,
-- which they reference, kept by a trigger on each kind's table: inserted as
-- the item is, its id changed as the item's is, and deleted as the item is,
-- taking the item's versions and Conflicts with it, or emptied of the kind as
-- its table is truncated. A new kind's migration creates its table's
-- triggers, each given its table's kind.
CREATE FUNCTION "versioned_item_added"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "versioned_items" ("kind", "item_id") VALUES (TG_ARGV[0], NEW."id"::text);
  RETURN NULL;
END $$;

CREATE FUNCTION "versioned_item_renamed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "versioned_items" SET "item_id" = NEW."id"::text WHERE "kind" = TG_ARGV[0] AND "item_id" = OLD."id"::text;
  RETURN NULL;
END $$;

CREATE FUNCTION "versioned_item_removed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "versioned_items" WHERE "kind" = TG_ARGV[0] AND "item_id" = OLD."id"::text;
  RETURN NULL;
END $$;

-- A truncated table fires no row trigger: every item of its kind is gone.
CREATE FUNCTION "versioned_items_truncated"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "versioned_items" WHERE "kind" = TG_ARGV[0];
  RETURN NULL;
END $$;

CREATE TRIGGER "beans_versioned_added" AFTER INSERT ON "beans" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('bean');
CREATE TRIGGER "beans_versioned_renamed" AFTER UPDATE OF "id" ON "beans" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('bean');
CREATE TRIGGER "beans_versioned_removed" AFTER DELETE ON "beans" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('bean');
CREATE TRIGGER "beans_versioned_truncated" AFTER TRUNCATE ON "beans" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('bean');

CREATE TRIGGER "bean_batches_versioned_added" AFTER INSERT ON "bean_batches" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('beanBatch');
CREATE TRIGGER "bean_batches_versioned_renamed" AFTER UPDATE OF "id" ON "bean_batches" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('beanBatch');
CREATE TRIGGER "bean_batches_versioned_removed" AFTER DELETE ON "bean_batches" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('beanBatch');
CREATE TRIGGER "bean_batches_versioned_truncated" AFTER TRUNCATE ON "bean_batches" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('beanBatch');

CREATE TRIGGER "grinders_versioned_added" AFTER INSERT ON "grinders" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('grinder');
CREATE TRIGGER "grinders_versioned_renamed" AFTER UPDATE OF "id" ON "grinders" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('grinder');
CREATE TRIGGER "grinders_versioned_removed" AFTER DELETE ON "grinders" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('grinder');
CREATE TRIGGER "grinders_versioned_truncated" AFTER TRUNCATE ON "grinders" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('grinder');

CREATE TRIGGER "profiles_versioned_added" AFTER INSERT ON "profiles" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('profile');
CREATE TRIGGER "profiles_versioned_renamed" AFTER UPDATE OF "id" ON "profiles" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('profile');
CREATE TRIGGER "profiles_versioned_removed" AFTER DELETE ON "profiles" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('profile');
CREATE TRIGGER "profiles_versioned_truncated" AFTER TRUNCATE ON "profiles" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('profile');

CREATE TRIGGER "baskets_versioned_added" AFTER INSERT ON "baskets" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('basket');
CREATE TRIGGER "baskets_versioned_renamed" AFTER UPDATE OF "id" ON "baskets" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('basket');
CREATE TRIGGER "baskets_versioned_removed" AFTER DELETE ON "baskets" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('basket');
CREATE TRIGGER "baskets_versioned_truncated" AFTER TRUNCATE ON "baskets" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('basket');

CREATE TRIGGER "tools_versioned_added" AFTER INSERT ON "tools" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('tool');
CREATE TRIGGER "tools_versioned_renamed" AFTER UPDATE OF "id" ON "tools" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('tool');
CREATE TRIGGER "tools_versioned_removed" AFTER DELETE ON "tools" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('tool');
CREATE TRIGGER "tools_versioned_truncated" AFTER TRUNCATE ON "tools" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('tool');

CREATE TRIGGER "recipes_versioned_added" AFTER INSERT ON "recipes" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('recipe');
CREATE TRIGGER "recipes_versioned_renamed" AFTER UPDATE OF "id" ON "recipes" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('recipe');
CREATE TRIGGER "recipes_versioned_removed" AFTER DELETE ON "recipes" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('recipe');
CREATE TRIGGER "recipes_versioned_truncated" AFTER TRUNCATE ON "recipes" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('recipe');
