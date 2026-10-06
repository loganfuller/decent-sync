-- PostgreSQL ends a session that sits in an open transaction for 30 s without
-- running a statement. If a server instance's host vanishes mid-transaction,
-- PostgreSQL may not notice the lost connection for hours, and the transaction
-- would keep its row locks (such as a Machine's) until then. The server runs a
-- transaction's statements back to back and Prisma times it out after 5 s, so
-- only an abandoned one waits this long.
--
-- Set on the database rather than sent by each connection at startup, which a
-- pooler may refuse or drop. It applies to sessions started afterwards; the
-- server migrates before its own connections open. Only the database's owner
-- or a superuser may set it, so for anyone else this raises a notice instead,
-- and the server warns at startup while the timeout is off.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '30s');
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Only the owner of database % or a superuser may set its idle_in_transaction_session_timeout; Decent Sync warns at startup while it is off', current_database();
END
$$;
