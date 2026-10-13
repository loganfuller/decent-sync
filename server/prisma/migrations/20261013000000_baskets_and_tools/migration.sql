-- Baskets and Tools (ticket #138): DYE2's baskets and equipment, taken into
-- the Library from its lists in Decaid's store and written back to them
-- (ADR-0005), each shown or hidden at each Location (ADR-0008), with each
-- tablet's map of its records, and the lists a tablet holds in a shape
-- neither the plugin nor the server recognises.

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
CREATE TABLE "tablet_unrecognised_lists" (
    "tablet_id" UUID NOT NULL,
    "list" TEXT NOT NULL,
    "since" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "tablet_unrecognised_lists_pkey" PRIMARY KEY ("tablet_id","list")
);

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
ALTER TABLE "tablet_unrecognised_lists" ADD CONSTRAINT "tablet_unrecognised_lists_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The triggers that keep `versioned_items` for each kind (20261012000000_versioned_items).
CREATE TRIGGER "baskets_versioned_added" AFTER INSERT ON "baskets" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('basket');
CREATE TRIGGER "baskets_versioned_renamed" AFTER UPDATE OF "id" ON "baskets" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('basket');
CREATE TRIGGER "baskets_versioned_removed" AFTER DELETE ON "baskets" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('basket');
CREATE TRIGGER "baskets_versioned_truncated" AFTER TRUNCATE ON "baskets" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('basket');

CREATE TRIGGER "tools_versioned_added" AFTER INSERT ON "tools" FOR EACH ROW EXECUTE FUNCTION "versioned_item_added"('tool');
CREATE TRIGGER "tools_versioned_renamed" AFTER UPDATE OF "id" ON "tools" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id") EXECUTE FUNCTION "versioned_item_renamed"('tool');
CREATE TRIGGER "tools_versioned_removed" AFTER DELETE ON "tools" FOR EACH ROW EXECUTE FUNCTION "versioned_item_removed"('tool');
CREATE TRIGGER "tools_versioned_truncated" AFTER TRUNCATE ON "tools" FOR EACH STATEMENT EXECUTE FUNCTION "versioned_items_truncated"('tool');

-- A tablet that took part at its Location before this release first reports DYE2's lists after it: that is no join of
-- its Location (ADR-0008), so its baskets and tools are taken into the Library, matched by name (ADR-0018), rather than
-- left out of it and removed from its lists. Its first report of each is taken in where its profiles last were.
INSERT INTO "tablet_reports" ("tablet_id", "report", "assignment_id", "location_id", "sharing_since")
SELECT reported."tablet_id", list."name", reported."assignment_id", reported."location_id", reported."sharing_since"
FROM "tablet_reports" AS reported CROSS JOIN (VALUES ('dye2Baskets'), ('dye2Equipment')) AS list("name")
WHERE reported."report" = 'profiles'
ON CONFLICT DO NOTHING;
