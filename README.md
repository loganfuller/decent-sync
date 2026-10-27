# decent-sync

Decent Sync connects Decent espresso machines (any DE1 model or a Bengle)
running [Decaid](https://github.com/decentespresso/decaid) to one self-hosted
server. The target design lets Machines at several Locations share a Library
of Beans, Bean Batches, Grinders and Profiles, each Location offering its own
part of it.
Machines at the same location share grinders and recipes, with the steam,
hot water and flush settings each recipe holds, working like the groups of one commercial espresso machine. The
server collects every shot and steam record they produce, and a web management
interface shows machines, stock and analytics across all locations.

It is built for one owner per server: a home user with two machines, or a
business with a roastery lab and several cafes.

## Status

**Milestones 1 to 3 are built, and released in
[v1.0.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.0.0).**
Admins sign in, manage Locations, and adopt Machines, which are identified by
their hardware and record where they were in a Location History. Adopted
tablets send their Shots and Steam Records, which the REST API serves, each
credited to the Location its Machine was at when it was recorded, their
Workflow changes and machine state transitions, and their library, settings
and paired devices, so the management interface shows what each Machine is
set up to pull next, what it is doing, and its scale, sensors and calibration.
Admins and Staff list Shots across every Location, filter them, and open each
one's curves beside the previous Shot on its Machine, and review Steam Records
the same way, with each one's milk temperature and curves. Milestone 1's spec
is [#1](https://github.com/loganfuller/decent-sync/issues/1), and its [GitHub
milestone](https://github.com/loganfuller/decent-sync/milestone/1) holds its
tickets and their hardening.

[Milestone 2](https://github.com/loganfuller/decent-sync/issues/77) ([GitHub
milestone](https://github.com/loganfuller/decent-sync/milestone/2)) shares the
Library with each Location's Machines: Beans, Bean Batches, Grinders and
Profiles. A bean, batch, grinder or profile entered on a tablet at a Location
joins the Library (a bean may become the Bean with the same roaster and name,
and a profile is the Profile with the same steps) and is written to that
Location's other tablets. A batch is at the Locations where it was added until
it is finished there, with its own remaining weight at each, a Bean is offered
where its batches are, a Grinder belongs to the Location where it was created,
and a Profile is shown or hidden at each Location. Archiving, hiding or
deleting one on a tablet acts at that tablet's Location only; a Grinder
archived or deleted there is Archived. Each Machine keeps its own steam, hot
water and flush settings, but those the Recipe it has loaded holds. An edit made on a tablet or in the management
interface reaches every tablet that holds the item, merged field by field with
the latest edit winning; each item keeps its history, and an edit that lost to one made without seeing it is kept as a
Conflict, whose value the management interface uses or dismisses. The
management interface's Library lists the Beans, the Bean Batches, the
Grinders, the Profiles, and where each is, and creates, edits, Archives and
restores Beans, Bean Batches and Grinders, adding and finishing batches at
each Location; it shows and hides each Profile at each Location, which is how
a lab Profile reaches a cafe, and Archives and restores Profiles; an Admin
hard-deletes an item no Shot names, from every tablet too. Each Shot is linked
to the Bean Batch, Grinder and Profile it used, Shots filter by them, and each
item's page lists its Shots. A Machine adopted at a Location, moved there, or
whose sharing an Admin turns back on after making it capture-only takes on
that Location's Library: what its tablet held of its own stays
out of the Library, archived or hidden on it, unless the Location had none of
that kind yet. A write a tablet refuses is skipped, and tried again once its
item changes or the tablet reconnects, while the others go on; each Machine's
page shows its sharing status: the changes waiting for its tablet, the last it
applied, and the writes it refused, with Decaid's answer. The Workflow changes
and machine state transitions a tablet has yet to deliver are kept in Decaid's
plugin storage, so unloading the plugin loses none. Everything else is
captured without being written to tablets.

[Milestone 3](https://github.com/loganfuller/decent-sync/issues/134) ([GitHub
milestone](https://github.com/loganfuller/decent-sync/milestone/3)) shares
each Location's DYE2 recipes, baskets and tools as Recipes, each in one of
its five Recipe Slots or none, Baskets and Tools, and follows each Machine's Loaded Recipe, which its
Workflow follows and which follows the changes made on it, its steam, hot
water and flush settings included. Each Shot is linked to its Recipe and
Basket.

Releases publish the server image and the plugin ZIP. v1.0.0 starts the
database afresh; nothing from earlier releases carries over.

## Design

- [GLOSSARY.md](GLOSSARY.md) defines the domain terms: machine, location,
  equipment, bean batch, stock, recipe, recipe slot, workflow, and the rest.
- [docs/adr/](docs/adr/) records the decisions and why they were made.

The target sharing scopes are:

| Shared | Across |
|---|---|
| Beans, bean batches, profiles, baskets and tools | every location, each offering its own part: the profiles, baskets and tools shown there, the batches at that location and their beans, and each batch's stock there |
| Grinders, recipes and their slots | machines at the same location |
| Profile, dose, yield, batch, grinder, basket, and steam, hot water and flush settings in use | not shared: each machine has its own, which loading a recipe sets; turning steam off never changes a recipe |

- A **machine** is the hardware, identified by model and serial. Replacing its
  tablet doesn't make it a new machine.
- Machines are adopted by hand. An admin creates the machine in the management
  interface, which issues a token. Someone enters the server URL and token in
  the plugin's settings.
- The server is the source of truth, and tablets can still edit. A tablet
  holds only what its location offers, and what a tablet creates starts at its
  location only. Edits resolve per field by last-writer-wins on the time of the
  original edit, and the management interface keeps a losing edit as a
  Conflict to review. A delete on a tablet acts only at its location, and sync
  deletes nothing from tablets but what an admin hard-deletes.

## Layout

One repo, laid out the way Decent lays out its own plugins (ADR-0012), as an
npm workspace:

```
plugin/                   Decaid plugin source (TypeScript)
decent-sync.reaplugin/    the built plugin, committed and released as a ZIP
server/                   NestJS + Prisma on PostgreSQL
web/                      management interface: React, Vite, shadcn/ui
protocol/                 internal wire types and runtime validators
```

The plugin talks to the server over one WebSocket, and everything else uses the
server's REST API. Each release publishes the server image and the plugin
together, at one version for the whole repo.

## Self-hosting

The server needs only PostgreSQL 14 or newer. Each release publishes a Docker
image of the server and the built management interface to
`ghcr.io/loganfuller/decent-sync`, tagged with its version (`1.0.0`), its minor
series (`1.0`) and `latest`. On startup the server applies any pending database
migrations, so upgrading is running a newer image. A release may change the
database incompatibly: stop the running server before starting a new version,
and read its upgrade notes, which say when to recreate the database.

### Docker Compose

[docker-compose.yml](docker-compose.yml) runs the server and PostgreSQL. Put it
in a directory with a `.env` file next to it, then start both:

```bash
curl -O https://raw.githubusercontent.com/loganfuller/decent-sync/main/docker-compose.yml
echo 'PUBLIC_URL=http://192.168.1.20:3000' > .env
docker compose up -d
```

The management interface is then at `PUBLIC_URL`. The first person to open it
creates the first Admin account; after that, setup is closed and everyone
signs in. Open it yourself before sharing the address. To bring others in, an
Admin creates an invite under Accounts, as an Admin or as Staff at chosen
Locations, and sends its one-time link themselves: the server sends no email.
The link expires after 7 days. Accounts is also where an Admin changes
someone's role, deactivates an account, and resets a forgotten password by
issuing a one-time link that expires after a day. Use `PUBLIC_URL` or the
server's IP address: to guard against cross-site attacks, the server refuses
setup and sign-in from a page loaded under any other name. PostgreSQL's data lives
in the `db-data` volume. These variables in `.env` configure the stack:

| Variable | |
|---|---|
| `PUBLIC_URL` | the `http(s)://` address people and tablets use to reach the server (default `http://localhost:3000`, which a tablet cannot reach) |
| `DECENT_SYNC_VERSION` | the image tag to run (default `latest`); pin a version such as `1.0.0` to upgrade deliberately |
| `DECENT_SYNC_PORT` | the host port the server is published on (default 3000); keep `PUBLIC_URL` in step |
| `POSTGRES_PASSWORD` | the database password (default `decent_sync`); letters and digits only, since it goes into a URL. It takes effect only when the volume is first created |
| `POSTGRES_PORT` | the loopback port PostgreSQL is published on, for backups and inspection (default 5432) |
| `CLIENT_ADDRESS_HEADER` | optional: the request header a reverse proxy puts the tablet's address in, such as `X-Forwarded-For` (see [On the internet](#on-the-internet)) |

To upgrade, pull the newer image and restart:

```bash
docker compose pull && docker compose up -d
```

In a checkout of this repo, `docker compose up` builds the image from source
when it cannot pull one.

To run the image against an existing PostgreSQL instead, pass the server's own
environment variables (see [Development](#development)):

```bash
docker run -d -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:password@db.example.com:5432/decent_sync \
  -e PUBLIC_URL=https://sync.example.com \
  ghcr.io/loganfuller/decent-sync:1.0.0
```

The user in `DATABASE_URL` should own its database: a migration sets the
database's `idle_in_transaction_session_timeout`, so that a transaction left
open by a vanished host releases its locks, and only the owner or a superuser
may set it. If the user cannot, the server warns at startup and gives the
statement for the owner to run.

### On a LAN, without TLS

The server can run on a computer on the same network as the machines, with no
public host or certificate. Give that computer a fixed address on the network
(a DHCP reservation in the router) and set `PUBLIC_URL` to it with `http://`,
for example `PUBLIC_URL=http://192.168.1.20:3000`. The plugin connects to an
`http://` server URL over plain `ws://`, and to an `https://` one over `wss://`.

Traffic on the LAN is then unencrypted, including each Machine's token, so use
this only on a network you trust. To reach the server from outside the network,
put it behind HTTPS instead.

### On the internet

Anyone who can reach the server can try to sign in or open a sync connection.
Each server instance checks at most 2 passwords at once, with 16 more
waiting, and refuses further sign-ins with 429. It also holds at most 64 sync
connections that have not yet had a `hello` accepted, and refuses more with
503. That keeps the instance running, but a flood can still keep real sign-ins
and tablets out. In front of a server exposed to the internet, also limit, at
the reverse proxy:

- the rate of sign-in requests (`POST /api/session`), per client address if
  the proxy sees it: people sign in rarely, so a few a minute is plenty;
- concurrent connections to `/sync`, to well above your number of tablets.

fly.io's proxy cannot limit one route's request rate, but it can cap the
connections it sends each machine: see `[http_service.concurrency]` in the
fly.io example below.

Behind a reverse proxy, every tablet's connection comes from the proxy, so
Machines show the proxy's address rather than the tablet's. Set
`CLIENT_ADDRESS_HEADER` to the header the proxy puts the client's address in,
usually `X-Forwarded-For`: Caddy sets it, and nginx does with
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. The server
takes the header's last comma-separated entry, the one the nearest proxy
added, when it is an IP address, and the connection's own address otherwise.
Any client can send that header, so set it only when every request reaches the
server through a proxy that sets or overwrites it.

### fly.io

[fly.io](https://fly.io) can host the server on the internet for machines at
several sites. This example deploys the published image with a database on
Fly Managed Postgres; any PostgreSQL 14 or newer that fly.io can reach works.

Create the app, a cluster, and a database and user for the server, then attach
them, which sets the app's `DATABASE_URL` secret. The user needs the
`schema_admin` role: migrations create tables, which a `writer` may not.

```bash
fly apps create my-decent-sync
fly mpg create                  # note the cluster's id
fly mpg databases create <cluster id> --name decent_sync
fly mpg users create <cluster id> --username decent_sync --role schema_admin
fly mpg attach <cluster id> --app my-decent-sync --database decent_sync --username decent_sync
```

Two changes to that URL are needed:

- `fly mpg attach` points it at the cluster's pooler,
  `pgbouncer.<cluster id>.flympg.net`. Use the direct host,
  `direct.<cluster id>.flympg.net`, instead. The server runs through the
  pooler only in session mode, as it listens for PostgreSQL notifications,
  which a pooler drops in transaction mode. Session mode is fly.io's documented
  default, but a cluster has been found in transaction mode; the mode is under
  View Pooler Settings on the cluster's Connect tab in fly.io's dashboard. Even
  in session mode, the pooler cannot carry the timeout below, so the direct
  host is the one to use. The server needs only a few connections per
  instance, well within the cluster's limit without a pooler.
- Managed Postgres's databases are owned by `postgres`, so the migration cannot
  set the database's idle-in-transaction timeout (see above), and Managed
  Postgres refuses role settings too. Send the timeout at connection startup
  instead, by adding `options=-c idle_in_transaction_session_timeout=30s` to
  the URL. The direct host accepts it; the pooler refuses any connection that
  sends it. Without it the server warns at startup.

fly.io does not show a secret again. Either set the whole URL yourself, with
the user's password:

```bash
fly secrets set --app my-decent-sync --stage \
  DATABASE_URL='postgresql://decent_sync:<password>@direct.<cluster id>.flympg.net/decent_sync?options=-c+idle_in_transaction_session_timeout%3D30s'
```

Or, before the first deploy, rewrite the attached one on a temporary machine,
which keeps the password out of your terminal. The machine removes itself
after 10 minutes:

```bash
fly machine run ghcr.io/loganfuller/decent-sync:1.0.0 sleep 600 --app my-decent-sync --rm
fly ssh console --app my-decent-sync -q -C 'node -e "const u = new URL(process.env.DATABASE_URL); u.hostname = u.hostname.replace(/^pgbouncer[.]/, \"direct.\"); u.searchParams.set(\"options\", \"-c idle_in_transaction_session_timeout=30s\"); console.log(\"DATABASE_URL=\" + u)"' \
  | tr -d '\r' | fly secrets import --app my-decent-sync --stage
```

Save a `fly.toml` like this one, with your app's name, the region nearest the
database and the image version to run, then deploy one machine. The server can
run as several instances on one database
([ADR-0016](docs/adr/0016-instances-share-only-postgresql.md)), but a new
version must not run beside the old one, and fly.io deploys to several
machines one at a time, so skip its default second machine:

```bash
fly deploy --ha=false
fly ips list --app my-decent-sync
```

If the app has no addresses after its first deploy, as can happen when
deploying from a script, allocate them with `fly ips allocate-v4 --shared` and
`fly ips allocate-v6`. Once the app is reachable, anyone can open it and create
the first Admin, so do that straight away.

```toml
# fly.toml
app = "my-decent-sync"
primary_region = "yyz"

[build]
  image = "ghcr.io/loganfuller/decent-sync:1.0.0"

[env]
  PUBLIC_URL = "https://my-decent-sync.fly.dev"
  # So Machines show each tablet's address, not fly.io's proxy's. fly.io puts
  # the app's own address last in X-Forwarded-For, so use its own header.
  CLIENT_ADDRESS_HEADER = "Fly-Client-IP"

[http_service]
  internal_port = 3000
  force_https = true
  # Tablets hold a WebSocket open; keep one machine running for them.
  auto_stop_machines = "off"
  min_machines_running = 1

  # Optional: the most connections, tablets' included, the proxy sends this
  # machine at once; it holds back the rest. fly.io sets no limit by default.
  [http_service.concurrency]
    type = "connections"
    soft_limit = 100
    hard_limit = 200

  [[http_service.checks]]
    method = "GET"
    path = "/api/health"
    interval = "30s"
    timeout = "5s"
    grace_period = "30s"
```

To upgrade, change the image version in `fly.toml` and deploy again. With a
custom domain, set `PUBLIC_URL` to it.

## Installing the plugin

The plugin needs Decaid v0.9.0 or newer. The server refuses a tablet running
an older Decaid, and the Machine's page says why. Run the plugin and server
from the same release ([ADR-0017](docs/adr/0017-supported-versions.md)).

Decaid installs the plugin from this repo's GitHub releases by repo name. On
the tablet, open Decaid's Settings, then Plugins; choose **Install Plugin**,
then **GitHub Release**, and enter `loganfuller/decent-sync` as the repository.
Or, from a computer on the same network:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' -d '{"repo": "loganfuller/decent-sync"}'
```

Decaid records where the plugin came from and updates it with its other update
checks, or when you press **Check for updates** under Plugins
(`POST /api/v1/plugins/update` does the same). Decaid installs an update by
itself only when it asks for no new permissions. One that does waits under
Plugins, saying it needs approval and which permissions it adds, until someone
at that tablet presses **Review**, then **Approve and update**, or sends
`POST /api/v1/plugins/decent-sync.reaplugin/update/approve` to the tablet's API.
Each tablet needs its own approval. Until a tablet's update is approved, it
runs the plugin it has, which a newer server may refuse.
[UPGRADING.md](UPGRADING.md) lists what each release needs.

Then enter the server URL and the Machine's token in the plugin's settings.
Both are shown once, with copy buttons, when an Admin creates the Machine's
entry under **Machines** in the management interface. A lost token can't be
shown again: issue a new one from the Machine's page, which disconnects any
tablet still using the old one. The plugin connects to
`ws(s)://<server host>/sync`, derived from the server URL, and the Machine
shows as online.

On its first run on a tablet, the plugin gives the tablet an id, which it keeps
in Decaid's plugin storage, where it survives plugin updates. The Machine's
page shows the tablet its latest connection came from, and its earlier ones.
Resetting the tablet's Decaid data, or replacing the tablet, makes a new tablet
there. Decaid's backups hold the id only once Decaid's store API has read the
plugin's storage since Decaid started, which the plugin asks for as it loads
and again every 30 s until Decaid answers. Restoring such a backup brings back
the tablet it came from, provided the restore puts the id back: restore before
installing the plugin, as Decaid's onboarding does, or choose to overwrite
existing data. Otherwise the tablet keeps the new id it was given, and shows
up as a new tablet.

The plugin also keeps the Workflow changes and machine state transitions the
server has not yet acknowledged in Decaid's plugin storage, so disabling the
plugin, changing its settings or restarting Decaid while the server can't be
reached loses none of them: the next load sends them first, unless the token
was changed meanwhile. While the server
is unreachable for long, it keeps the newest 2,000 of them, up to 2 Mi
characters, dropping the oldest. Shots and Steam Records need no keeping:
every load sends the server an index of the tablet's records, and the server
asks for those it lacks.

A Machine at a Location shares its tablet's beans, bean batches, grinders and
profiles with that Location's other Machines. The plugin writes to its
tablet's Decaid: it adds the beans, batches, grinders and profiles another
tablet at the Location entered, writes each bean's, batch's and grinder's id
in the Library into the record's
`extras`, keeping what other plugins keep there, sets each batch's remaining
weight to its Location's, and shows each profile its Location shows. What the
Location no longer offers, such as a batch finished there or a profile hidden
there, is archived or hidden on the tablet, never deleted. A barista archiving
a batch finishes it at that Location, un-archiving it adds it back, deleting
or archiving a bean finishes its batches there, archiving or deleting a
grinder archives it on every tablet at that Location, and hiding, deleting or
changing a profile's steps hides it there. A Machine with no Location is only
captured: its tablet is written nothing, and its library stays out of the
Library. See [docs/LIBRARY.md](docs/LIBRARY.md).

Recipes are shared through DYE2's storage, and a Machine's Loaded Recipe is
the recipe DYE2 and Streamline name in its Workflow as a barista applies one,
into which the plugin has DYE2 save each change made on the Machine
([ADR-0022](docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md)). So
a Machine that follows Recipes needs DYE2 v0.1.26 or later, and streamline-js
from `main` at `cec5664` or later where Streamline is its skin. That untagged
build is Streamline's minimum until a tagged release contains `ea04f83`, which
lets its DYE strip apply a recipe holding a grinder or Basket
([ADR-0017](docs/adr/0017-supported-versions.md)).

| Setting | |
|---|---|
| Server URL | the server's `PUBLIC_URL`, such as `https://sync.example.com` |
| Token | the Machine's token (stored securely by Decaid) |
| Poll interval | seconds between checks for changes to the library, Tablet Settings, paired devices, scale, sensors and Steam Records (default 30, at least 5); the machine's own settings are read every 60 s, or this often if longer, and whenever a Workflow change writes them |

## Development

Needs Node.js 22.12 or newer and PostgreSQL 14 or newer. `docker-compose.yml`
runs a local PostgreSQL.

```bash
npm install
cp .env.example .env         # DATABASE_URL and PUBLIC_URL for local use
npm run db:up                # PostgreSQL in Docker
npm start                    # build everything, migrate, serve http://localhost:3000
```

The server reads its configuration only from environment variables; `npm start`
also loads `.env` if present. It refuses to start, naming each problem, when a
required variable is missing or invalid.

| Variable | |
|---|---|
| `DATABASE_URL` | required: PostgreSQL connection URL |
| `PUBLIC_URL` | required: the `http(s)://` origin people and plugins use to reach the server |
| `PORT` | listen port (default 3000) |
| `HOST` | bind address (default `0.0.0.0`) |
| `WEB_DIST_DIR` | the built management interface (default `web/dist`) |
| `SYNC_HELLO_TIMEOUT_SECONDS` | how long a plugin connection has to send `hello` (default 10) |
| `SYNC_HEARTBEAT_SECONDS` | how often plugins send a heartbeat (default 30); a connection silent for three is closed |
| `DRAIN_GRACE_SECONDS` | how long a stopping server, its health check answering 503, still answers requests, so a proxy that routes by that check notices and sends them elsewhere (default 15, a 10 s check interval plus a 5 s timeout; 0 with one instance). It then finishes those under way and exits |
| `CLIENT_ADDRESS_HEADER` | the request header, such as `X-Forwarded-For` or `X-Real-IP`, whose last entry, when an IP address, is a tablet's address instead of the connection's (default unset: the connection's). Set it only when every request reaches the server through a proxy that sets or overwrites that header ([On the internet](#on-the-internet)) |

On startup the server applies pending database migrations, then serves the
REST API under `/api`, the plugin's WebSocket at `/sync`, and the management
interface everywhere else.

| Command | |
|---|---|
| `npm run dev:server` | server with rebuild on change |
| `npm run dev:web` | Vite dev server for `web/`, proxying `/api` to the dev server |
| `npm run typecheck` | typecheck every workspace |
| `npm run build` | build every workspace, including `decent-sync.reaplugin/` |
| `npm run build:stale` | rebuild only the workspaces whose builds are older than their sources |
| `npm run build:latest-release` | build the latest release from its tag, outside the checkout, for the tests that run it beside the change |
| `npm run db:test` | start the shared test PostgreSQL in Docker, and drop test databases left over 2 hours old |
| `npm test` | Vitest (run `npm run build` first: tests use the built plugin and server) |
| `npm run test:e2e` | Playwright against the built server (run `npm run build` first) |
| `npm run test:latest-release-suite` | the latest release's Vitest suite on this checkout's schema, on a throwaway PostgreSQL in Docker (run `npm run build:latest-release` first) |
| `npm run check:plugin-build` | fail if the committed `decent-sync.reaplugin/` differs from a fresh build |
| `npm run package:plugin` | write the release ZIP of the committed plugin to `dist/` |
| `docker compose up --build` | build the server image from this checkout and run it with PostgreSQL |

Server tests and Playwright start the built server once per test file, each on
a fresh database they create and drop on the PostgreSQL server named by
`TEST_DATABASE_URL`, or else `DATABASE_URL`, so they need it running and its
user allowed to create databases and roles (true of `npm run db:test`'s and
`npm run db:up`'s). `npm run db:test` runs a PostgreSQL for tests alone, with
more connections, keeping test databases out of development data
(`.env.example`). `docs/AI_BUILD_NOTES.md` says how to run part of the tests.

Decaid installs whatever is committed in `decent-sync.reaplugin/`, so commit the
rebuilt plugin with every change to `plugin/` or `protocol/`. CI checks it, and
also packages the plugin ZIP and runs the server image with Docker Compose,
without publishing either.

### Releasing

One version covers the whole repo. It lives in the root `package.json`, and the
plugin build copies it into `decent-sync.reaplugin/manifest.json`.

1. Set the version, rebuild the plugin, and retitle the Unreleased notes in
   `UPGRADING.md`, if any, with the version. Commit the changes and merge them
   to `main`:
   ```bash
   npm version 0.3.0 --no-git-tag-version
   npm run build -w plugin
   ```
2. Tag the resulting commit on `main` `v0.3.0` and push the tag. A tag on any
   other commit fails the release, since pull request CI tests a merge with
   `main` rather than the tagged commit.

The [release workflow](.github/workflows/release.yml) then fails unless the tag
is `vX.Y.Z` matching the committed manifest's version, `UPGRADING.md` has no
notes left under Unreleased, and CI has passed on the tagged commit as a push
to `main` (waiting for it rather than running it again), publishes the server
image (amd64 and arm64) to `ghcr.io/loganfuller/decent-sync` as `0.3.0`, `0.3`
and `latest`, and finally creates the GitHub release with
`decent-sync.reaplugin-v0.3.0.zip` as its only asset. Its notes start with the
version's section of `UPGRADING.md` (`scripts/release-notes.mjs`), followed by
GitHub's notes generated from the pull requests merged since the last release.
Anything owners must do when upgrading, such as approving a plugin update that
adds a permission on every tablet, goes in `UPGRADING.md` under Unreleased.
Decaid's release install and update read the latest release, and refuse
prerelease-style tags, so publish only versions meant for every Machine.

## Milestones

Each milestone is a
[GitHub milestone](https://github.com/loganfuller/decent-sync/milestones)
holding its spec, tickets and pull requests.

1. **[Foundation](https://github.com/loganfuller/decent-sync/milestone/1).** The new layout and stack, machine adoption and identity,
   Locations with time zones, Admin and Staff accounts. Captures Shots, Steam
   Records, Workflow changes and machine state transitions, the library (including DYE2 recipes and equipment), settings and paired
   devices from every Machine. Includes Shot and Steam Record lists and detail
   pages, Shot filters and comparison, and Machine Location history.
2. **[Shared library](https://github.com/loganfuller/decent-sync/milestone/2).**
   Beans, Bean Batches, Grinders and Profiles shared with each Location's
   Machines, each Location offering its own part, Conflicts and history in
   the management interface, Shots
   linked to the Library, and a durable outbox. Spec:
   [#77](https://github.com/loganfuller/decent-sync/issues/77).
3. **[Recipes and equipment](https://github.com/loganfuller/decent-sync/milestone/3).**
   DYE2 recipes, baskets and tools shared through DYE2's storage, Recipe
   Slots, each Machine's Loaded Recipe, which its Workflow follows and which
   follows the changes made on it, and Shots linked to their Recipe and Basket.
   Recording Location moves is in milestone 1, and what a move changes in a
   tablet's Library is in milestone 2. Spec:
   [#134](https://github.com/loganfuller/decent-sync/issues/134).
4. **[Machine management](https://github.com/loganfuller/decent-sync/milestone/4).**
   Each Machine's Machine Settings and its Tablet's Tablet Settings edited in
   the management interface, live while its Tablet is connected (ADR-0023), each
   Machine's Live View on its page (ADR-0024), then commands such as sleep and
   wake. Specs:
   [#220](https://github.com/loganfuller/decent-sync/issues/220) and, for the
   Live View, [#258](https://github.com/loganfuller/decent-sync/issues/258).
5. **[Rolling upgrades](https://github.com/loganfuller/decent-sync/milestone/5).**
   Each release runs beside the previous one (ADR-0025), so several server
   instances upgrade without taking anything offline, and Roux's server runs
   on two fly.io VMs deployed blue-green. Built before the Live View, whose
   messages are the first to need it. Spec:
   [#277](https://github.com/loganfuller/decent-sync/issues/277).
6. **Analytics.** Broader views across Machines and Locations, and Barista
   grouping, including who dialled each Recipe. Machine status, Shot filtering and comparison with the
   previous Shot on the same Machine are already in milestone 1.
7. **Stock.** Deliveries, transfers, counts and the coffee each shot uses.

## License

[MIT](LICENSE)
