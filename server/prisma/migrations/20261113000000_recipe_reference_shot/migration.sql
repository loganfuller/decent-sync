-- Ticket #472 (ADR-0029): a Recipe's Reference Shot, the one Shot chosen to
-- show how its Shots should go, held beside its Recipe Slot and outside its
-- content, so nothing of it is written to tablets. Nullable with no default,
-- so adding it rewrites no row, and unknown to the previous release, which
-- leaves it as it is (ADR-0025). A Shot is named by its id, as a Recipe's
-- versions name items, with no foreign key: Shots are never deleted, the
-- server checks the Shot is one the Shots list lists as it is chosen, and a
-- key would lock `shots` against the running release's writes while it is
-- added. The index finds the Recipes a Shot is the Reference Shot of, for
-- Shot reads and rows; `recipes` is small, so it is built here.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "recipes" ADD COLUMN "reference_shot_id" TEXT;

CREATE INDEX "recipes_reference_shot_idx" ON "recipes"("reference_shot_id") WHERE "reference_shot_id" IS NOT NULL;

COMMIT;
