-- Ticket #376: the Viewer, a role that sees what Staff see and changes
-- nothing. Only adds the value, which the previous release never writes.
-- Its Prisma client refuses to read a row holding it, so an upgrade note asks
-- that Viewers be made only once no instance of it runs.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TYPE "account_role" ADD VALUE 'VIEWER';

COMMIT;
