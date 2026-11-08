# Self-hosting

The server is one Docker image, `ghcr.io/loganfuller/decent-sync`, holding the
server and the management interface. It needs only PostgreSQL 14 or newer.

Each release publishes the image for amd64 and arm64, tagged with its version
(such as `1.6.4`), its minor series (`1.6`) and `latest`. On startup the
server applies any pending database migrations, so upgrading means running a
newer image.

- [Docker Compose](#docker-compose)
- [Using your own PostgreSQL](#using-your-own-postgresql)
- [Accounts](#accounts)
- [On a local network](#on-a-local-network)
- [On the internet](#on-the-internet)
- [Assistants](#assistants)
- [fly.io](#flyio)
- [Upgrading](#upgrading)
- [Configuration reference](#configuration-reference)

## Docker Compose

[docker-compose.yml](../docker-compose.yml) runs the server and PostgreSQL on
one computer. Put it in a directory with a `.env` file beside it, then start
both:

```bash
curl -O https://raw.githubusercontent.com/loganfuller/decent-sync/main/docker-compose.yml
echo 'PUBLIC_URL=http://192.168.1.20:3000' > .env
docker compose up -d
```

The management interface is then at `PUBLIC_URL`. Open it yourself before
you share the address, and create the first Admin account (see
[Accounts](#accounts)).

Open it at `PUBLIC_URL`, the server's IP address, or `localhost`. To guard
against cross-site attacks, the server refuses sign-in and every other change
from a page loaded under any other name.

### Settings

Set these in `.env`:

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | The `http://` or `https://` address people and tablets use to reach the server, with no path. Tablets can't reach the default. |
| `DECENT_SYNC_VERSION` | `latest` | The image tag to run. Pin a version, such as `1.6.4`, to upgrade deliberately. |
| `DECENT_SYNC_PORT` | `3000` | The host port the server is published on. Change `PUBLIC_URL` to match. |
| `POSTGRES_PASSWORD` | `decent_sync` | The database password. Use letters and digits only, since it goes into a URL. It takes effect only when the database volume is first created. |
| `POSTGRES_PORT` | `5432` | The port PostgreSQL is published on, on `127.0.0.1` only, for backups and inspection. |
| `CLIENT_ADDRESS_HEADER` | unset | Behind a reverse proxy, the header holding each tablet's address. See [Behind a reverse proxy](#behind-a-reverse-proxy). |
| `MCP_ENABLED` | `true` | Set to `false` to turn off connecting assistants. See [Assistants](#assistants). |

PostgreSQL's data lives in the `db-data` volume.

In a checkout of this repository, `docker compose up` builds the image from
source when it can't pull one.

### Upgrading with Compose

```bash
docker compose pull && docker compose up -d
```

The server is offline for a few seconds, until the new release has started
and migrated the database.

With `DECENT_SYNC_VERSION` at `latest`, a pull takes the newest release. So
either upgrade after every release, or pin the version and step through each
release in turn. See [Upgrading](#upgrading).

## Using your own PostgreSQL

To run the image against a PostgreSQL you already have, pass the server's own
environment variables (see [Configuration reference](#configuration-reference)).
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

## Accounts

The first person to open the management interface creates the first Admin
account. Setup then closes, and everyone else signs in.

| Role | What they can do |
|---|---|
| Admin | Everything, including accounts, Machines, tokens and deleting for good. |
| Staff | Work at the Locations chosen for them: edit the Library's shared content anywhere, and at their Locations move Machines, edit Machine settings, change what the Location offers, and manage Recipes. |
| Viewer | See everything Staff see, and change nothing. |

To bring someone in, an Admin creates an invite under **Accounts** and sends
them its one-time link. The server sends no email. The link expires after 7
days.

**Accounts** is also where an Admin changes someone's role, deactivates an
account, or resets a forgotten password. A reset issues a one-time link that
expires after a day.

## On a local network

The server can run on a computer on the same network as the machines, with no
public host name or certificate:

1. Give the computer a fixed address, such as with a DHCP reservation in your
   router.
2. Set `PUBLIC_URL` to that address with `http://`, such as
   `PUBLIC_URL=http://192.168.1.20:3000`.

The plugin connects to an `http://` server over plain `ws://`, and to an
`https://` one over `wss://`.

Over plain `http://`, all traffic is unencrypted, each Machine's token
included, so do this only on a network you trust. To reach the server from
outside the network, put it behind HTTPS instead.

## On the internet

### Limit sign-ins and connections

Anyone who can reach the server can try to sign in or open a sync connection.
Each server instance protects itself:

- It checks at most 2 passwords at once, with 16 more waiting, and refuses
  further sign-ins with 429.
- It holds at most 64 sync connections that haven't yet had a `hello`
  accepted, and refuses more with 503.

That keeps the instance running, but a flood can still keep real people and
tablets out. In front of a server on the internet, also set these limits at
the reverse proxy:

- **Sign-in rate.** Limit `POST /api/session`, per client address if the proxy
  sees it. People sign in rarely, so a few a minute is plenty.
- **Sync connections.** Limit concurrent connections to `/sync` to well above
  your number of tablets.

fly.io's proxy can't limit one route's request rate, but it can cap the
connections it sends each VM: see `[http_service.concurrency]` in the
[fly.io example](#3-write-flytoml).

### Behind a reverse proxy

Behind a reverse proxy, every connection comes from the proxy, so Machines
show the proxy's address instead of their tablet's. To fix this, set
`CLIENT_ADDRESS_HEADER` to the header the proxy puts the client's address in,
usually `X-Forwarded-For`. Caddy sets it, and nginx does with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.

The server uses the header's last comma-separated entry, the one the nearest
proxy added, if it is an IP address. Otherwise it uses the connection's own
address.

> [!WARNING]
> Any client can send that header. Set `CLIENT_ADDRESS_HEADER` only when every
> request reaches the server through a proxy that sets or overwrites it.

## Assistants

People connect AI assistants through the MCP endpoint at `/api/mcp` (see the
[README](../README.md#connecting-an-assistant)). The server approves them
itself, through its own authorization server, and each approval makes a
Connected App
([ADR-0026](adr/0026-assistants-reach-the-server-through-mcp.md),
[ADR-0027](adr/0027-the-server-authorizes-connected-apps-itself.md)).

### What the server needs

- **HTTPS.** Assistant apps connect only over HTTPS, so `PUBLIC_URL` must
  start with `https://`. The one exception is an app on the server's own
  computer, reaching it at `localhost`.
- **Reachable from where the app runs.** Claude and ChatGPT, on the web and on
  phones, connect from their own clouds. For them, the server must be
  reachable from the internet at `PUBLIC_URL`. A server reachable only on a
  local network serves only apps on that network.
- **The discovery paths.** A reverse proxy that passes only some paths to the
  server must pass `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource/api/mcp` as well as `/api`.

Apps that can register only by Dynamic Client Registration, such as Cursor,
can't connect.

### Connected Apps

- A Connected App acts as the account that approved it, within what that
  account may do.
- An app unused for 30 days stops working until it connects again.
- Apps usually ask the person before making a change, unless they are set to
  allow it without asking.
- Each Library change and each Settings Edit made through an app is recorded
  as the person's, through the app. It shows as "*account*, through *app*" in
  the item's history and Conflicts, and in the Machine's Settings Edits.
- Each person sees their own apps on the **Connected Apps** page, in the
  account menu under their name. Disconnecting one there stops it at once.
- Admins see and disconnect everyone's apps on the **Accounts** page.
  Deactivating an account disconnects all of its Connected Apps, and they stay
  disconnected if the account is reactivated.

### Turning assistants off

Set `MCP_ENABLED=false`. The endpoint, the authorization server and their
metadata then answer 404, and no Connected App's token is accepted. The
Connected Apps pages still list existing apps and can disconnect them.

## fly.io

[fly.io](https://fly.io) can host the server on the internet, for machines at
several sites. This example runs the published image on two VMs, with a
database on Fly Managed Postgres. Any PostgreSQL 14 or newer that fly.io can
reach also works.

### 1. Create the app and database

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

### 2. Fix the database URL

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
  [Using your own PostgreSQL](#using-your-own-postgresql)), and Managed
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

### 3. Write fly.toml

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

### 4. Deploy

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
one release at a time (see [Upgrading](#upgrading)).

### How it runs

- **Two instances, one database.** The server runs as two instances on one
  database ([ADR-0016](adr/0016-instances-share-only-postgresql.md)), on VMs
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
  runs beside the previous one ([Upgrading](#upgrading)).

### Database connections

A deploy briefly doubles the VMs, to four, and the database must take all of
their connections at once. Each instance holds up to 11: a pool of 10, and one
listening for notifications. So the database's `max_connections` must allow
44 beyond whatever else uses it, such as another app on the same cluster.

## Upgrading

From 1.4.0, each release runs beside the one before it
([ADR-0025](adr/0025-each-release-runs-beside-the-previous-one.md)). The new
release migrates the database in place while the old one may still be serving
from it. No upgrade asks you to stop the server or recreate the database.

- **Two or more instances**, behind a proxy that routes by `/api/health` as in
  the fly.io example, upgrade without going offline. The new release starts
  beside the old one and takes the traffic once it has migrated. The old one
  then stops.
- **One instance**, as with Docker Compose, stops and then starts the new
  release. It is offline until the new release has migrated, usually a few
  seconds.

### Keep the server within one release of the plugin

Decaid checks for plugin releases every 12 hours while it runs, and updates
each tablet's plugin whatever release its server runs. A plugin and server one
release apart work together, whichever is upgraded first. Two releases apart,
they may not. So upgrade the server to each release soon after it is
published.

### If you skipped a release

Take the server up one release at a time. Run each release until its
background work, such as rewriting stored data in batches, is done. A release
whose migrations need that work done checks that it is, and otherwise refuses
to start, naming the release to run until it is.

- With Docker Compose, set `DECENT_SYNC_VERSION` to each release in turn.
- On fly.io, set the image version in `fly.toml` to each release in turn.

### Release notes

Each release's notes start with anything it needs beyond its new image. The
same notes are kept in [UPGRADING.md](../UPGRADING.md).

Data from releases before 1.0.0 doesn't carry over: 1.0.0 started the
database afresh.

## Configuration reference

The server reads its configuration only from environment variables. If a
required variable is missing or invalid, it refuses to start and names each
problem.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | required | The PostgreSQL connection URL. |
| `PUBLIC_URL` | required | The `http://` or `https://` origin people and plugins use to reach the server, with no path. |
| `PORT` | `3000` | The port to listen on. |
| `HOST` | `0.0.0.0` | The address to bind to. |
| `WEB_DIST_DIR` | `web/dist` | Where the built management interface is. |
| `SYNC_HELLO_TIMEOUT_SECONDS` | `10` | How long a new plugin connection has to send `hello`. |
| `SYNC_HEARTBEAT_SECONDS` | `30` | How often plugins send a heartbeat. A connection silent for three heartbeats is closed. |
| `DRAIN_GRACE_SECONDS` | `15` | How long a stopping server keeps answering requests while its health check answers 503, so a proxy routing by that check moves traffic elsewhere. The server then finishes the requests under way and exits. The default is a 10 s check interval plus a 5 s timeout. Use `0` with one instance. |
| `LIVE_VIEW_KEEP_ALIVE_SECONDS` | `15` | How long a Live View stream can go with nothing to send before the server sends a comment on it, so a proxy doesn't close it as idle. |
| `CLIENT_ADDRESS_HEADER` | unset | A header, such as `X-Forwarded-For` or `X-Real-IP`, whose last entry, if it is an IP address, is taken as a tablet's address instead of the connection's. Set it only behind a proxy that sets or overwrites it ([Behind a reverse proxy](#behind-a-reverse-proxy)). |
| `MCP_ENABLED` | `true` | Whether assistants can connect, through the MCP endpoint and the authorization server that approves them. `false` makes both answer 404 ([Assistants](#assistants)). |

### What the server serves

| Path | What |
|---|---|
| `/api` | The REST API. `/api/health` is the health check. |
| `/api/mcp` | The MCP endpoint for assistants. |
| `/sync` | The plugin's WebSocket. |
| `/.well-known/` | The authorization server's metadata. |
| Everything else | The management interface. |
