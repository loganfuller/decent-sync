# decent-sync

Decent Sync connects Decent espresso machines (any DE1 model or a Bengle)
running [Decaid](https://github.com/decentespresso/decaid) to one self-hosted
server. The target design lets Machines at several Locations share a library
of Beans, Bean Batches and Profiles. Machines at the same location share equipment, recipes and steam
settings, working like the groups of one commercial espresso machine. The
server collects every shot and steam record they produce, and a web management
interface shows machines, stock and analytics across all locations.

It is built for one owner per server: a home user with two machines, or a
business with a roastery lab and several cafes.

## Status

**Milestone 1 is in progress.** The workspace, stack and CI are in place
([the scaffold ticket](https://github.com/loganfuller/decent-sync/issues/2)), with no
domain behavior yet. The receive-only prototype (`server.mjs`) remains until
[ticket #19](https://github.com/loganfuller/decent-sync/issues/19) removes it.
[Milestone 1](https://github.com/loganfuller/decent-sync/issues/1) and its child tickets
define the build scope. The shared-library behavior below comes in later milestones;
milestone 1 captures data without pushing changes to tablets.

Releases publish the server image and the plugin ZIP, starting with
[v0.1.0](https://github.com/loganfuller/decent-sync/releases/tag/v0.1.0). Until
milestone 1's capture work lands, the plugin only loads and the server only
serves a placeholder page.

## Design

- [GLOSSARY.md](GLOSSARY.md) defines the domain terms: machine, location,
  equipment, bean batch, stock, recipe, recipe slot, workflow, and the rest.
- [docs/adr/](docs/adr/) records the decisions and why they were made.

The target sharing scopes are:

| Shared | Across |
|---|---|
| Beans, bean batches, profiles | every location. Which profiles are shown, and each batch's stock, are tracked per location |
| Equipment, recipe slots | machines at the same location |
| Steam, hot water and rinse settings | machines of the same model at the same location. Turning steam on or off stays per machine |
| Profile, dose, yield, batch and grinder in use | not shared: each machine has its own |

- A **machine** is the hardware, identified by model and serial. Replacing its
  tablet doesn't make it a new machine.
- Machines are adopted by hand. An admin creates the machine in the management
  interface, which issues a token. Someone enters the server URL and token in
  the plugin's settings.
- The server is the source of truth, and tablets can still edit. Conflicting
  edits resolve by last-writer-wins on the time of the original edit, and the
  management interface shows them. Sync never hard-deletes.

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
`ghcr.io/loganfuller/decent-sync`, tagged with its version (`0.1.0`), its minor
series (`0.1`) and `latest`. On startup the server applies any pending database
migrations, so upgrading is running a newer image.

### Docker Compose

[docker-compose.yml](docker-compose.yml) runs the server and PostgreSQL. Put it
in a directory with a `.env` file next to it, then start both:

```bash
curl -O https://raw.githubusercontent.com/loganfuller/decent-sync/main/docker-compose.yml
echo 'PUBLIC_URL=http://192.168.1.20:3000' > .env
docker compose up -d
```

The management interface is then at `PUBLIC_URL`. PostgreSQL's data lives in
the `db-data` volume. These variables in `.env` configure the stack:

| Variable | |
|---|---|
| `PUBLIC_URL` | the `http(s)://` address people and tablets use to reach the server (default `http://localhost:3000`, which a tablet cannot reach) |
| `DECENT_SYNC_VERSION` | the image tag to run (default `latest`); pin a version such as `0.1.0` to upgrade deliberately |
| `DECENT_SYNC_PORT` | the host port the server is published on (default 3000); keep `PUBLIC_URL` in step |
| `POSTGRES_PASSWORD` | the database password (default `decent_sync`); letters and digits only, since it goes into a URL. It takes effect only when the volume is first created |
| `POSTGRES_PORT` | the loopback port PostgreSQL is published on, for backups and inspection (default 5432) |

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
  ghcr.io/loganfuller/decent-sync:0.1.0
```

### On a LAN, without TLS

The server can run on a computer on the same network as the machines, with no
public host or certificate. Give that computer a fixed address on the network
(a DHCP reservation in the router) and set `PUBLIC_URL` to it with `http://`,
for example `PUBLIC_URL=http://192.168.1.20:3000`. The plugin connects to an
`http://` server URL over plain `ws://`, and to an `https://` one over `wss://`.

Traffic on the LAN is then unencrypted, including each Machine's token, so use
this only on a network you trust. To reach the server from outside the network,
put it behind HTTPS instead.

### fly.io

[fly.io](https://fly.io) can host the server on the internet for machines at
several sites. This example deploys the published image with a PostgreSQL
database on fly.io; any PostgreSQL 14 or newer that fly.io can reach works.

```bash
fly apps create my-decent-sync
fly mpg create                  # Fly Managed Postgres; note its connection URL
fly secrets set --app my-decent-sync DATABASE_URL='postgresql://...'
```

Save a `fly.toml` like this one, with your app's name and the image version to
run, then deploy one machine. Milestone 1 runs as a single server instance, so
skip fly.io's default second machine:

```bash
fly deploy --ha=false
```

```toml
# fly.toml
app = "my-decent-sync"
primary_region = "ord"

[build]
  image = "ghcr.io/loganfuller/decent-sync:0.1.0"

[env]
  PUBLIC_URL = "https://my-decent-sync.fly.dev"

[http_service]
  internal_port = 3000
  force_https = true
  # Tablets hold a WebSocket open; keep one machine running for them.
  auto_stop_machines = "off"
  min_machines_running = 1

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

The plugin needs Decaid v0.8.7 or newer. Decaid installs it from this repo's
GitHub releases by repo name. On the tablet, open Decaid's Settings, then
Plugins; choose **Install Plugin**, then **GitHub Release**, and enter
`loganfuller/decent-sync` as the repository. Or, from a computer on the same
network:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' -d '{"repo": "loganfuller/decent-sync"}'
```

Decaid records where the plugin came from and updates it with its other update
checks, or when you press **Check for updates** under Plugins
(`POST /api/v1/plugins/update` does the same). An update that asks for new
permissions waits under Plugins for approval.

Then enter the server URL and the Machine's token in the plugin's settings.

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

On startup the server applies pending database migrations, then serves the
REST API under `/api` and the management interface everywhere else.

| Command | |
|---|---|
| `npm run dev:server` | server with rebuild on change |
| `npm run dev:web` | Vite dev server for `web/`, proxying `/api` to the dev server |
| `npm run typecheck` | typecheck every workspace |
| `npm run build` | build every workspace, including `decent-sync.reaplugin/` |
| `npm test` | Vitest (run `npm run build` first: tests use the built plugin and server) |
| `npm run test:e2e` | Playwright against the built server; starts it unless one is running |
| `npm run check:plugin-build` | fail if the committed `decent-sync.reaplugin/` differs from a fresh build |
| `npm run package:plugin` | write the release ZIP of the committed plugin to `dist/` |
| `docker compose up --build` | build the server image from this checkout and run it with PostgreSQL |

Decaid installs whatever is committed in `decent-sync.reaplugin/`, so commit the
rebuilt plugin with every change to `plugin/` or `protocol/`. CI checks it, and
also packages the plugin ZIP and runs the server image with Docker Compose,
without publishing either.

### Releasing

One version covers the whole repo. It lives in the root `package.json`, and the
plugin build copies it into `decent-sync.reaplugin/manifest.json`.

1. Set the version and rebuild the plugin, then commit both and merge to `main`:
   ```bash
   npm version 0.2.0 --no-git-tag-version
   npm run build -w plugin
   ```
2. Tag that commit `v0.2.0` and push the tag.

The [release workflow](.github/workflows/release.yml) then fails unless the tag
is `vX.Y.Z` matching the committed manifest's version, runs CI on the tagged
commit, publishes the server image (amd64 and arm64) to
`ghcr.io/loganfuller/decent-sync` as `0.2.0`, `0.2` and `latest`, and finally
creates the GitHub release with `decent-sync.reaplugin-v0.2.0.zip` as its only
asset. Decaid's release install and update read the latest release, and refuse
prerelease-style tags, so publish only versions meant for every Machine.

## Milestones

1. **Foundation.** The new layout and stack, machine adoption and identity,
   Locations with time zones, Admin and Staff accounts. Captures Shots, Steam
   Records, Workflow changes and machine state transitions, the library (including DYE2 recipes and equipment), settings and paired
   devices from every Machine. Includes Shot and Steam Record lists and detail
   pages, Shot filters and comparison, and Machine Location history.
2. **Shared library.** Beans, batches, grinders and profiles pushed to tablets,
   plus shared steam, hot water and rinse settings and a durable outbox.
3. **Location sharing.** DYE2 recipes and equipment, Recipe Slots, and the effects
   of moving a Machine on its tablet. Recording Location moves is already in
   milestone 1.
4. **Stock.** Deliveries, transfers, counts and the coffee each shot uses.
5. **Analytics.** Broader views across Machines and Locations, inferred Recipes
   and Barista grouping. Machine status, Shot filtering and comparison with the
   previous Shot on the same Machine are already in milestone 1.

## The prototype

`server.mjs` receives what the prototype plugin
([decent-sync-plugin](https://github.com/loganfuller/decent-sync-plugin),
archived and read-only) sends, prints it, and stores it as JSON files under `DATA_DIR`.
Its unreleased wire format is in [docs/PROTOCOL.md](docs/PROTOCOL.md); it is not
the new protocol version 1. The prototype is not a foundation for milestone 1.
[Ticket #19](https://github.com/loganfuller/decent-sync/issues/19) removes it after
the replacement works. See [build notes](docs/AI_BUILD_NOTES.md) for scratch runs
and the real-tablet installation rule.

```bash
npm install
npm run prototype            # ws://0.0.0.0:8787/sync, data in ./data
node server.mjs --full --verbose
```

| | |
|---|---|
| `--full` | also pretty-print every payload |
| `--verbose` | also show heartbeats and duplicate deliveries |
| `PORT` | listen port (default 8787) |
| `HOST` | bind address (default `0.0.0.0`) |
| `SYNC_TOKEN` | require this token in each machine's `hello` |
| `DATA_DIR` | storage root (default `./data`) |

## License

[MIT](LICENSE)
