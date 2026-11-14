-- Ticket #506: a Recipe Slot is a whole number from 1 to 9 wherever one is
-- read (`RECIPE_SLOTS` in `protocol/`), as DYE2 holds, shows and keeps a
-- `stripSlot` of 6 to 9, so a tablet's record in one moves its Recipe there.
-- The check is widened, which the previous release's writes, of 1 to 5 and
-- none, still pass (ADR-0025). Replacing it reads every row of `recipes`
-- under its lock; the table is small, a few rows per Location.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "recipes" DROP CONSTRAINT "recipes_slot_check";
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_slot_check" CHECK ("slot" IS NULL OR "slot" BETWEEN 1 AND 9);

COMMIT;
