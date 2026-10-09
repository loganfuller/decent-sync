-- Profiles in the management interface (ticket #88): an Admin's hard delete
-- of a Profile no Shot names. A tablet's record of a Profile is named by
-- Decaid's id, which is not a UUID, so a delete due on a tablet names its
-- item by text, and keeps what the machine executes of a Profile, so a Shot
-- taken in later that used it keeps its record on the tablet
-- (server/src/library/hard-deletes.ts). A Shot names a Profile by what its
-- Workflow's profile executes, its steps found by a hash index, or by the
-- profile id a skin recorded in its Workflow.

-- AlterTable
ALTER TABLE "tablet_deletions" ALTER COLUMN "item_id" SET DATA TYPE TEXT,
ADD COLUMN     "executed" JSONB;

-- CreateIndex
CREATE INDEX "shots_profile_id_idx" ON "shots"("profile_id");

-- Prisma cannot express an index on an expression.
CREATE INDEX "shots_profile_steps_idx" ON "shots" USING hash (("record" -> 'workflow' -> 'profile' -> 'steps'));
