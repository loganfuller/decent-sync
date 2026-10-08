-- The Library's Profiles, whether each is shown at each Location, and each
-- tablet's record of each (server/src/library/profiles.ts).

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "bundled" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_locations" (
    "profile_id" TEXT NOT NULL,
    "location_id" UUID NOT NULL,
    "shown" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profile_locations_pkey" PRIMARY KEY ("profile_id","location_id")
);

-- CreateTable
CREATE TABLE "tablet_profiles" (
    "tablet_id" UUID NOT NULL,
    "profile_id" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "record_updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_profiles_pkey" PRIMARY KEY ("tablet_id","profile_id")
);

-- CreateIndex
CREATE INDEX "profile_locations_location_id_idx" ON "profile_locations"("location_id");

-- CreateIndex
CREATE INDEX "tablet_profiles_profile_id_idx" ON "tablet_profiles"("profile_id");

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

