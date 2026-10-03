-- Measurements use lz4 column compression, which needs PostgreSQL 14 or newer.
DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'Decent Sync needs PostgreSQL 14 or newer; this server runs %', current_setting('server_version');
  END IF;
END
$$;
