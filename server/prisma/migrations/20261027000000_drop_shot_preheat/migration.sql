-- A demonstration for #280, never committed: drops a column 1.3.1 writes.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "shots" DROP COLUMN "preheat";

COMMIT;
