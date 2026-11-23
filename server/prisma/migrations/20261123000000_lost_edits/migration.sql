-- Ticket #632: a Lost Edit (ADR-0033) is kept where Conflicts were, with the
-- version of its item it lost to. The previous release still writes
-- Conflicts here and leaves the column null (ADR-0025), as every row has it
-- as it is added. No foreign key: a version goes only with its item, which
-- takes these rows with it.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "conflicts" ADD COLUMN "lost_to_version_id" UUID;

COMMIT;
