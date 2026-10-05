-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "deactivated_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "invites" ADD COLUMN     "revoked_at" TIMESTAMPTZ(3);

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

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_secret_hash_key" ON "password_resets"("secret_hash");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_account_id_key" ON "password_resets"("account_id");

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

