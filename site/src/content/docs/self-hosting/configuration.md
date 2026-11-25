---
title: Configuration
description: Every configuration setting of the server, in one table.
---

The server reads its configuration only from environment variables. If a
required variable is missing or invalid, it refuses to start and names each
problem.

## The server's settings

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
| `CLIENT_ADDRESS_HEADER` | unset | A header, such as `X-Forwarded-For` or `X-Real-IP`, whose last entry, if it is an IP address, is taken as a tablet's address instead of the connection's. Set it only behind a proxy that sets or overwrites it ([Behind a reverse proxy](../../self-hosting/internet/#behind-a-reverse-proxy)). |
| `MCP_ENABLED` | `true` | Whether assistants can connect, through the MCP endpoint and the authorization server that approves them. `false` makes both answer 404 ([Assistants](../../self-hosting/internet/#assistants)). |

## Docker Compose's settings

With [Docker Compose](../../self-hosting/docker-compose/), set these in
`.env`. Compose passes them to the server and to PostgreSQL:

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | The `http://` or `https://` address people and tablets use to reach the server, with no path. Tablets can't reach the default. |
| `DECENT_SYNC_VERSION` | `latest` | The image tag to run. Pin a version, such as `1.6.4`, to upgrade deliberately. |
| `DECENT_SYNC_PORT` | `3000` | The host port the server is published on. Change `PUBLIC_URL` to match. |
| `POSTGRES_PASSWORD` | `decent_sync` | The database password. Use letters and digits only, since it goes into a URL. It takes effect only when the database volume is first created. |
| `POSTGRES_PORT` | `5432` | The port PostgreSQL is published on, on `127.0.0.1` only, for backups and inspection. |
| `CLIENT_ADDRESS_HEADER` | unset | Behind a reverse proxy, the header holding each tablet's address. See [Behind a reverse proxy](../../self-hosting/internet/#behind-a-reverse-proxy). |
| `MCP_ENABLED` | `true` | Set to `false` to turn off connecting assistants. See [Assistants](../../self-hosting/internet/#assistants). |

## What the server serves

| Path | What |
|---|---|
| `/api` | The REST API. `/api/health` is the health check. |
| `/api/mcp` | The MCP endpoint for assistants. |
| `/sync` | The plugin's WebSocket. |
| `/.well-known/` | The authorization server's metadata. |
| Everything else | The management interface. |

## What the server asks for

The server makes requests of its own to two places, both over HTTPS:

- an assistant app's Client ID Metadata Document, as the app connects
  ([Assistants](../../self-hosting/internet/#assistants));
- GitHub (`api.github.com` and `github.com`), without credentials, when an
  Admin opens the form that changes how a plugin or Skin updates, to find
  the build it is at so that it can be pinned there. Without it the form
  offers the other choices.
