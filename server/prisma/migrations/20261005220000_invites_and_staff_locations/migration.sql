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
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_locations" (
    "invite_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,

    CONSTRAINT "invite_locations_pkey" PRIMARY KEY ("invite_id","location_id")
);

-- CreateIndex
CREATE INDEX "staff_locations_location_id_idx" ON "staff_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_secret_hash_key" ON "invites"("secret_hash");

-- CreateIndex
CREATE INDEX "invite_locations_location_id_idx" ON "invite_locations"("location_id");

-- AddForeignKey
ALTER TABLE "staff_locations" ADD CONSTRAINT "staff_locations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_locations" ADD CONSTRAINT "staff_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_locations" ADD CONSTRAINT "invite_locations_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "invites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_locations" ADD CONSTRAINT "invite_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
