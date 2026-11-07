-- Ticket #406: the authorization server that assistants connect through
-- (ADR-0027): Connected Apps, the requests to connect awaiting the consent
-- page, and the codes and tokens approvals issue, their secrets stored only
-- as hashes. New tables, which the previous release never reads.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "connected_apps" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_host" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_uri" TEXT,
    "scopes" TEXT[],
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "disconnected_at" TIMESTAMPTZ(3),

    CONSTRAINT "connected_apps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "authorization_requests" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_host" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "logo_uri" TEXT,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "state" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "authorization_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "authorization_codes" (
    "code_hash" BYTEA NOT NULL,
    "connected_app_id" UUID NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "authorization_codes_pkey" PRIMARY KEY ("code_hash")
);

CREATE TABLE "access_tokens" (
    "token_hash" BYTEA NOT NULL,
    "connected_app_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "access_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE TABLE "refresh_tokens" (
    "token_hash" BYTEA NOT NULL,
    "connected_app_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("token_hash")
);

CREATE INDEX "connected_apps_account_id_idx" ON "connected_apps"("account_id");

CREATE INDEX "connected_apps_last_used_at_idx" ON "connected_apps"("last_used_at");

CREATE INDEX "authorization_requests_expires_at_idx" ON "authorization_requests"("expires_at");

CREATE INDEX "authorization_codes_connected_app_id_idx" ON "authorization_codes"("connected_app_id");

CREATE INDEX "authorization_codes_expires_at_idx" ON "authorization_codes"("expires_at");

CREATE INDEX "access_tokens_connected_app_id_idx" ON "access_tokens"("connected_app_id");

CREATE INDEX "access_tokens_expires_at_idx" ON "access_tokens"("expires_at");

CREATE INDEX "refresh_tokens_connected_app_id_idx" ON "refresh_tokens"("connected_app_id");

ALTER TABLE "connected_apps" ADD CONSTRAINT "connected_apps_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "authorization_codes" ADD CONSTRAINT "authorization_codes_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_connected_app_id_fkey" FOREIGN KEY ("connected_app_id") REFERENCES "connected_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
