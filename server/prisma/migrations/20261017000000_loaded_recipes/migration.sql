-- Each Machine's Loaded Recipe and its history (ticket #145, ADR-0022), read
-- from its tablet's Workflow deliveries.

-- CreateTable
CREATE TABLE "loaded_recipes" (
    "id" BIGSERIAL NOT NULL,
    "machine_id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "loaded_at" TIMESTAMPTZ(3) NOT NULL,
    "unloaded_at" TIMESTAMPTZ(3),

    CONSTRAINT "loaded_recipes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loaded_recipes_machine_id_id_idx" ON "loaded_recipes"("machine_id", "id");

-- CreateIndex
CREATE INDEX "loaded_recipes_recipe_id_idx" ON "loaded_recipes"("recipe_id");

-- A Machine has at most one Loaded Recipe at a time.
CREATE UNIQUE INDEX "loaded_recipes_current_key" ON "loaded_recipes"("machine_id") WHERE "unloaded_at" IS NULL;

-- AddForeignKey
ALTER TABLE "loaded_recipes" ADD CONSTRAINT "loaded_recipes_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loaded_recipes" ADD CONSTRAINT "loaded_recipes_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
