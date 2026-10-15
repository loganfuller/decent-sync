-- The Loaded Recipe each tablet's Workflow last named, with the parts that
-- follow it as the Workflow held them (ticket #146, ADR-0022).

-- CreateTable
CREATE TABLE "tablet_loaded_recipes" (
    "tablet_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "held" JSONB NOT NULL,
    "pending" JSONB,
    "content_seen_at" TIMESTAMPTZ(3),

    CONSTRAINT "tablet_loaded_recipes_pkey" PRIMARY KEY ("tablet_id")
);

-- CreateIndex
CREATE INDEX "tablet_loaded_recipes_recipe_id_idx" ON "tablet_loaded_recipes"("recipe_id");

-- AddForeignKey
ALTER TABLE "tablet_loaded_recipes" ADD CONSTRAINT "tablet_loaded_recipes_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
