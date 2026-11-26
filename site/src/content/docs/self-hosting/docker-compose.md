---
title: Docker Compose
description: Running the server and PostgreSQL with Docker Compose.
---

The server is one Docker image, `ghcr.io/loganfuller/decent-sync`, holding the
server and the management interface. It needs only PostgreSQL 14 or newer.

Each release publishes the image for amd64 and arm64, tagged with its version
(such as `1.6.4`), its minor series (`1.6`) and `latest`. On startup the
server applies any pending database migrations, so upgrading means running a
newer image.

## Running it

[docker-compose.yml](https://github.com/loganfuller/decent-sync/blob/main/docker-compose.yml) runs the server and PostgreSQL on
one computer. Put it in a directory with a `.env` file beside it, then start
both:

```bash
curl -O https://raw.githubusercontent.com/loganfuller/decent-sync/main/docker-compose.yml
echo 'PUBLIC_URL=http://192.168.1.20:3000' > .env
docker compose up -d
```

The management interface is then at `PUBLIC_URL`. Open it yourself before
you share the address, and create the first Admin account (see
[Invite people](../../get-started/invite-people/)). Use `PUBLIC_URL`, the server's IP address or
`localhost`: to guard against cross-site attacks, the server refuses sign-in
and every other change from a page loaded under any other name.

Set Compose's settings in `.env`
([Docker Compose's settings](../../self-hosting/configuration/#docker-composes-settings)).

PostgreSQL's data lives in the `db-data` volume.

In a checkout of this repository, `docker compose up` builds the image from
source when it can't pull one.

To upgrade, see [Upgrading](../../self-hosting/upgrading/#with-docker-compose).

## Using your own PostgreSQL

To run the image against a PostgreSQL you already have, pass the server's own
environment variables (see [Configuration](../../self-hosting/configuration/)).
Replace `X.Y.Z` with the release to run:

```bash
docker run -d -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:password@db.example.com:5432/decent_sync \
  -e PUBLIC_URL=https://sync.example.com \
  -e DRAIN_GRACE_SECONDS=0 \
  ghcr.io/loganfuller/decent-sync:X.Y.Z
```

- **`DRAIN_GRACE_SECONDS=0`** makes a single instance stop at once. The grace
  period only helps when another instance can take over its requests, and
  Docker kills a container 10 seconds after asking it to stop.
- **The database user should own the database.** A migration sets the
  database's `idle_in_transaction_session_timeout`, so that a transaction left
  open by a vanished host releases its locks. Only the owner or a superuser
  may set it. If the user can't, the server warns at startup and prints the
  statement for the owner to run.
