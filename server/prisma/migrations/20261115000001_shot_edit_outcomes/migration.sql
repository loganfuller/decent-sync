-- Ticket #513 (ADR-0031): what became of an edit of a Shot's rating or note
-- that its tablet did not write, and what a Shot's tablet holds of the two.
-- `shot_edits` gains when each field of an edit was dropped, as the tablet
-- changed that field later than the edit was made, and when its tablet
-- answered that it no longer holds the Shot. `shots` gains the rating and
-- note its tablet holds, as far as the server knows, which differ from the
-- record's while an edit awaits that tablet: a version of the Shot the
-- tablet reports is read against them, to tell the fields the tablet
-- changed from those it only reports again. Nullable columns with no
-- default, so nothing is rewritten, and the previous release, which reads
-- and writes none of them, stores a Shot as before (ADR-0025).

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "shot_edits"
    ADD COLUMN "rating_dropped_at" TIMESTAMPTZ(3),
    ADD COLUMN "note_dropped_at" TIMESTAMPTZ(3),
    ADD COLUMN "unreachable_at" TIMESTAMPTZ(3);

ALTER TABLE "shots"
    ADD COLUMN "held_rating" DOUBLE PRECISION,
    ADD COLUMN "held_note" TEXT;

COMMIT;
