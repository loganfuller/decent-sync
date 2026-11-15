-- Ticket #515 (ADR-0031): an edit of a Shot's rating or note made on a
-- Machine's tablet, for a Skin, names that Machine and tablet and no
-- account, as a version of a Library item made on a tablet does.
-- `shot_edits` gains both, nullable, each set to null if its Machine or
-- tablet is deleted, and indexed so that delete finds them. The table came
-- after the latest release, which neither reads nor writes it (ADR-0025),
-- and holds few rows, so the indexes are built here.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "shot_edits"
    ADD COLUMN "machine_id" UUID,
    ADD COLUMN "tablet_id" UUID;

CREATE INDEX "shot_edits_machine_id_idx" ON "shot_edits"("machine_id");

CREATE INDEX "shot_edits_tablet_id_idx" ON "shot_edits"("tablet_id");

ALTER TABLE "shot_edits" ADD CONSTRAINT "shot_edits_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shot_edits" ADD CONSTRAINT "shot_edits_tablet_id_fkey" FOREIGN KEY ("tablet_id") REFERENCES "tablets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
