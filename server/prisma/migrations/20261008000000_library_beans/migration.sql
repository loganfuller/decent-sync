-- The Library's Beans, the Locations where tablets created or linked them,
-- and each tablet's record of each (server/src/library/beans.ts).

-- CreateTable
CREATE TABLE "beans" (
    "id" UUID NOT NULL,
    "content" JSONB NOT NULL,
    "match_key" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_location_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

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

    CONSTRAINT "tablet_beans_pkey" PRIMARY KEY ("tablet_id","bean_id")
);

-- CreateIndex
CREATE INDEX "beans_match_key_idx" ON "beans"("match_key");

-- CreateIndex
CREATE INDEX "bean_origins_location_id_idx" ON "bean_origins"("location_id");

-- CreateIndex
CREATE INDEX "tablet_beans_bean_id_idx" ON "tablet_beans"("bean_id");

-- CreateIndex
CREATE UNIQUE INDEX "tablet_beans_tablet_id_local_id_key" ON "tablet_beans"("tablet_id", "local_id");

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
