---
title: fly.io
description: Deploying the server to fly.io, step by step.
---

[fly.io](https://fly.io) can host the server on the internet, for machines at
several sites. This example runs the published image on two VMs, with a
database on Fly Managed Postgres. Any PostgreSQL 14 or newer that fly.io can
reach also works.

## 1. Create the app and database

Create the app, a Managed Postgres cluster, and a database and user for the
server, then attach them. Attaching sets the app's `DATABASE_URL` secret.

```bash
fly apps create my-decent-sync
fly mpg create                  # note the cluster's id
fly mpg databases create <cluster id> --name decent_sync
fly mpg users create <cluster id> --username decent_sync --role schema_admin
fly mpg attach <cluster id> --app my-decent-sync --database decent_sync --username decent_sync
```

The user needs the `schema_admin` role, because migrations create tables,
which a `writer` may not.

## 2. Fix the database URL

The URL that `fly mpg attach` sets needs two changes:

1. **Use the direct host.** Replace the pooler,
   `pgbouncer.<cluster id>.flympg.net`, with
   `direct.<cluster id>.flympg.net`.
2. **Add the idle-in-transaction timeout.** Add
   `options=-c idle_in_transaction_session_timeout=30s` to the URL.

Why both are needed:

- The server listens for PostgreSQL notifications, which a pooler drops in
  transaction mode. Session mode is fly.io's documented default, but a cluster
  has been found in transaction mode. You can check under View Pooler
  Settings, on the cluster's Connect tab in fly.io's dashboard.
- Managed Postgres databases are owned by `postgres`, so the migration can't
  set the timeout on the database (see
  [Using your own PostgreSQL](../../self-hosting/docker-compose/#using-your-own-postgresql)), and Managed
  Postgres refuses role settings too. That leaves sending it as the
  connection starts. The direct host accepts this. The pooler refuses any
  connection that sends it, even in session mode. Without the timeout, the
  server warns at startup.
- The server needs few connections, at most 11 per instance, so it doesn't
  need a pooler. See [Database connections](#database-connections) for what a
  deploy needs.

fly.io never shows a secret again, so there are two ways to make the change.
Either set the whole URL yourself, with the user's password:

```bash
fly secrets set --app my-decent-sync --stage \
  DATABASE_URL='postgresql://decent_sync:<password>@direct.<cluster id>.flympg.net/decent_sync?options=-c+idle_in_transaction_session_timeout%3D30s'
```

Or, before the first deploy, rewrite the attached URL on a temporary machine,
which keeps the password out of your terminal. The machine removes itself
after 10 minutes:

```bash
fly machine run ghcr.io/loganfuller/decent-sync:latest sleep 600 --app my-decent-sync --rm
fly ssh console --app my-decent-sync -q -C 'node -e "const u = new URL(process.env.DATABASE_URL); u.hostname = u.hostname.replace(/^pgbouncer[.]/, \"direct.\"); u.searchParams.set(\"options\", \"-c idle_in_transaction_session_timeout=30s\"); console.log(\"DATABASE_URL=\" + u)"' \
  | tr -d '\r' | fly secrets import --app my-decent-sync --stage
```

## 3. Write fly.toml

Save this as `fly.toml`. Change the app name, the region (pick the one
nearest the database), and `X.Y.Z` to the release to run.

```toml
app = "my-decent-sync"
primary_region = "yyz"

# How long a stopping VM has before fly.io kills it. On fly.io's signal, the
# server fails its health check, hands its tablets to the other VMs, and keeps
# answering requests for 15 s (DRAIN_GRACE_SECONDS) until the proxy notices.
# It then finishes the requests and background batches under way. That is
# usually instant, but a large change, such as one to a long Location
# History, can take a minute or two. Work still running at the limit is cut
# off and rolled back. fly.io's default of 5 s would cut off even the 15 s.
kill_timeout = 150

[build]
  image = "ghcr.io/loganfuller/decent-sync:X.Y.Z"

[deploy]
  # Start a new VM beside each old one, and move traffic once it is healthy.
  strategy = "bluegreen"
  # How long a new VM has to pass its health check before the deploy fails.
  # It must cover the release's migrations plus another new VM's, which it
  # waits for. A release whose migrations take longer says so in its notes.
  wait_timeout = "10m"

[env]
  PUBLIC_URL = "https://my-decent-sync.fly.dev"
  # So Machines show each tablet's address, not fly.io's proxy's. fly.io puts
  # its own address last in X-Forwarded-For, so use fly.io's header instead.
  CLIENT_ADDRESS_HEADER = "Fly-Client-IP"

[http_service]
  internal_port = 3000
  force_https = true
  # Tablets hold a WebSocket open, so keep every VM running.
  auto_stop_machines = "off"

  # Optional: the most connections, tablets' included, the proxy sends one VM
  # at once. It holds back the rest. fly.io sets no limit by default.
  [http_service.concurrency]
    type = "connections"
    soft_limit = 100
    hard_limit = 200

  # The check the proxy routes by. A stopping server keeps answering for 15 s
  # (DRAIN_GRACE_SECONDS), which is this interval plus the timeout. Change
  # them together.
  [[http_service.checks]]
    method = "GET"
    path = "/api/health"
    interval = "10s"
    timeout = "5s"
    grace_period = "30s"
```

With a custom domain, set `PUBLIC_URL` to it.

## 4. Deploy

```bash
fly deploy
fly scale count 2
fly ips list --app my-decent-sync
```

- A first deploy already starts two VMs, so `fly scale count 2` changes
  nothing then. It adds the second VM to an app running only one, such as one
  deployed with `--ha=false`.
- If the app has no IP addresses after its first deploy, as can happen when
  deploying from a script, allocate them with `fly ips allocate-v4 --shared`
  and `fly ips allocate-v6`.
- Once the app is reachable, anyone can open it and create the first Admin.
  Do that yourself straight away.

To upgrade, change the image version in `fly.toml` and run `fly deploy` again,
one release at a time (see [Upgrading](../../self-hosting/upgrading/)).

## How it runs

- **Two instances, one database.** The server runs as two instances on one
  database ([ADR-0016](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0016-instances-share-only-postgresql.md)), on VMs
  in one region. fly.io normally places them on separate hosts, though it
  doesn't promise to. If a host fails, the other VM usually keeps serving, and
  tablets reconnect to it within seconds.
- **Blue-green deploys.** fly.io starts a VM of the new release beside each
  old one and waits for its health check. The server passes the check only
  once it has migrated the database. fly.io then moves traffic to the new VMs
  over 10 to 20 seconds and stops the old ones, whose tablets reconnect to the
  new ones within about a second. Nothing goes offline, and an open page loads
  the new release at its next navigation. If a new VM fails its check, the
  deploy fails and the old VMs keep serving. This works because each release
  runs beside the previous one ([Upgrading](../../self-hosting/upgrading/)).

## Database connections

A deploy briefly doubles the VMs, to four, and the database must take all of
their connections at once. Each instance holds up to 11: a pool of 10, and one
listening for notifications. So the database's `max_connections` must allow
44 beyond whatever else uses it, such as another app on the same cluster.
