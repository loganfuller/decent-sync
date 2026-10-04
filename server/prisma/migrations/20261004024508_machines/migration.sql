-- CreateTable
CREATE TABLE "machines" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "serial" TEXT,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_tokens" (
    "id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "machine_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "machine_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "machines_name_key" ON "machines"("name");

-- CreateIndex
CREATE UNIQUE INDEX "machines_model_serial_key" ON "machines"("model", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "machine_tokens_token_hash_key" ON "machine_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "machine_tokens_machine_id_idx" ON "machine_tokens"("machine_id");

-- AddForeignKey
ALTER TABLE "machine_tokens" ADD CONSTRAINT "machine_tokens_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
