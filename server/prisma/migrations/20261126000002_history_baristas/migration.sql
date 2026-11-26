-- Ticket #708: the barista a tablet's Workflow named as an edit was made on
-- it, for a Bean Batch brought to the Machine's Location by a scan
-- (ADR-0030): a version of the batch names the Machine, the tablet and that
-- barista, and no account. A Lost Edit keeps it as its version held it. Both
-- are null for every other edit, and the previous release neither reads nor
-- writes them (ADR-0025). No data is changed.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "item_versions" ADD COLUMN "barista" TEXT;
ALTER TABLE "conflicts" ADD COLUMN "barista" TEXT;

COMMIT;
