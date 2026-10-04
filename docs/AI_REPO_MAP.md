# AI Repo Map

## Start here

The repository holds the milestone 1 workspace, scaffolded by [ticket #2](https://github.com/loganfuller/decent-sync/issues/2) with no domain behavior yet, plus the receive-only prototype (`server.mjs`) that [ticket #19](https://github.com/loganfuller/decent-sync/issues/19) removes once milestone 1 replaces it.

Target requirements come from `GLOSSARY.md`, accepted `docs/adr/` decisions and [milestone 1](https://github.com/loganfuller/decent-sync/issues/1), then the assigned ticket. ADR-0010 is superseded by ADR-0012, and ADR-0015 extends ADR-0004. The prototype's code and protocol do not override these requirements.

## Layout

| Path | Responsibility | Entry points |
|---|---|---|
| `plugin/` | TypeScript source for the Decaid plugin | `src/index.ts`, `src/connection.ts` (hello, heartbeats, reconnects), `src/settings.ts`, `src/decaid.ts` (Decaid's local API); `build.mjs` writes `decent-sync.reaplugin/`; `manifest.json` is the manifest template (the version comes from the root `package.json`) |
| `decent-sync.reaplugin/` | Committed ES2020 bundle and manifest installed by Decaid | Generated; never edit by hand |
| `server/` | NestJS, Prisma, PostgreSQL, WebSocket gateway, REST API, serving the built web app | `src/main.ts` (config, migrations, bootstrap), `src/config.ts`, `src/accounts/` (accounts, sessions and the guards every route passes), `src/locations/` (Locations and the time zones they may use), `src/machines/` (machine entries, tokens, identification, aliases, Pending Machines, online status), `src/sync/` (the plugin's WebSocket gateway at `/sync`, and `identity.ts`, the pure identity resolution module), `prisma/schema.prisma`, `prisma/migrations/` |
| `web/` | React, Vite, shadcn/ui management interface; uses the REST API | `src/App.tsx` (routes), `src/auth.tsx`, `src/pages/Shell.tsx` (the signed-in frame later pages join), `src/pages/MachinesPage.tsx` and `src/pages/MachinePage.tsx` (Machines, Pending Machines, tokens and identity resolution), `src/components/TokenNotice.tsx` (a token shown once, with copy buttons that also work on a plain-`http://` LAN address); add components with `npx shadcn add` |
| `protocol/` | Internal shared wire types and runtime validators; never published | `src/index.ts` |
| `e2e/` | Playwright tests (Seam 2) | `playwright.config.ts` at the root |
| `Dockerfile`, `docker-compose.yml` | Server image (server plus built web app) and the self-hosting stack with PostgreSQL; `npm run db:up` starts only its `db` service | |
| `scripts/` | Repo checks and release packaging | `check-plugin-build.mjs`, `check-release-tag.mjs`, `package-plugin.mjs`; tests in `scripts/test/` |
| `.github/workflows/` | CI on pull requests and `main`; release on `vX.Y.Z` tags | `ci.yml` (also called by the release), `release.yml` |

Root `package.json` scripts are the commands; the README's Development section lists them. One protocol change updates the plugin, server and shared package together here; the old plugin repo is archived.

`protocol/` exports its TypeScript source under the `@decent-sync/source` condition, which esbuild, TypeScript and Vitest use, so they need no protocol build. Node at runtime uses `protocol/dist`, so the server needs `npm run build -w protocol` first (the root `build`, `start` and `dev:server` scripts do this). The Prisma client is generated into `server/src/generated/` (git-ignored) by the server's `build` and `typecheck` scripts. Tables and columns are snake_case (`@@map`, `@map`) while models keep Prisma's casing.

Every REST route requires a signed-in account unless marked `@Public()` (`server/src/accounts/guards.ts`); only health, first-run setup and sign-in are public so far. Role checks (Admin-only actions such as editing Locations or creating machine entries) arrive with Staff accounts in ticket #15. State-changing requests are refused as cross-site unless their `Origin` is `PUBLIC_URL`, or the requested host when that host is an IP address or `localhost` (not another domain name, which would admit DNS rebinding).

The plugin's WebSocket at `/sync` is outside the REST guards: it authenticates by the Machine token in `hello`. Tokens and session cookies are random secrets stored only as SHA-256 hashes (`server/src/secrets.ts`); a token is returned once, when it is issued (creating a machine entry, from a Pending Machine or not, or reissuing it, which revokes the old one). Do not assume one server instance: deployments run one for now, but the server must stay correct with several on one database. The connection that holds a Machine is stored on its row (`connected_session_id`, written when a hello is accepted, released when that connection closes or its instance shuts down, which first waits for hellos still being accepted); a Machine is online while that is set and it was heard from within three heartbeat intervals, so a crashed instance's Machines go offline by themselves. Last-seen times and session expiry are written and judged by PostgreSQL's `now()`, never an instance's clock; `server/test/session-expiry.test.ts` runs sessions on instances whose clocks are days off. The server's connections set `idle_in_transaction_session_timeout` (`server/src/prisma.service.ts`), so a transaction abandoned by a vanished host releases its row locks within 30 s. Each instance keeps only its own connections (`LiveConnections`). Accepting a hello, reissuing a token and dismissing hardware send a PostgreSQL `NOTIFY` (`AccessChanges`, ADR-0016) inside their transaction, delivered on commit; every instance then checks its connections to that Machine against the database (`MachinesService.standings`, read for all of them together: token still current, mismatched hardware not dismissed, still the connection holding the Machine) and closes those that fail. A new connection checks itself once registered, so a change committed while its hello was accepted is caught either there or by the notification; heartbeats check too, in the same query that records them (`MachinesService.heard`), and every connection is checked once the listener reconnects, covering notifications missed meanwhile. The server answers each heartbeat as it arrives, ahead of the database work queued for its connection, and the plugin drops a connection it has heard nothing on for three intervals (`MISSED_HEARTBEATS` in `protocol/`). A stalled database therefore closes no connection: until it recovers, the connection's heartbeat checks wait, and its Machine shows offline because its last-seen time cannot be written. A refused hello never writes `connected_session_id`, so it never replaces a connection. Whatever gives hardware to a Machine, holds it as a Pending Machine or dismisses it takes an advisory lock on that model and serial (`lockHardware`) before any Machine's row, so those run one at a time. `server/test/server-instances.test.ts` runs several instances on one database. Sign-in attempts are counted in `sign_in_windows` (`server/src/accounts/sign-in-limiter.ts`), one upsert per attempt with windows judged by PostgreSQL's `now()`, so every instance enforces one limit; `server/test/sign-in-limits.test.ts` runs it on two instances.

Identity is decided once per connection at `hello` (`resolveIdentity` in `server/src/sync/identity.ts`) and stored on the Machine as its identification: identified, hardware not reported, unidentified or mismatch. Beyond the spec's wording: a bound Machine reporting serial `"0"` is identified only from a known alias (so one identified by hand stays identified), an unbound Machine's `hello` without hardware is hardware not reported whatever its connection id, and a token reporting hardware another Machine has is a mismatch whose hardware belongs to that Machine, with no Pending Machine. Aliases are remembered only when a connection shows they are the Machine's (its own real hardware, or serial `"0"` on an unbound Machine) or when an Admin enters an Unidentified Machine's hardware. Dismissing a Pending Machine refuses its hardware for each Machine reporting that mismatch at dismissal (`DismissedHardware`). The refusal survives token rotation for those Machines; a later report using another Machine's token follows normal identity resolution.

Anything that decides a Machine's identity or tokens (`acceptHello`, token reissue, entering hardware by hand) runs in a transaction holding the Machine's row lock (`lockMachine` in `machines.service.ts`), so they are decided one at a time. Take Machine rows before a Pending Machine's, as a hello does: dismissing locks the mismatched Machines (in id order) before it writes the Pending Machine, since the reverse order deadlocks with a reconnecting tablet. Any new way of revoking access must notify the same way, inside its transaction.

A Location's time zone is an IANA name spelled as PostgreSQL's `pg_timezone_names` lists it, so date filters can use it in `AT TIME ZONE`. PostgreSQL built without tzdata's backward links lacks aliases such as `US/Eastern` and the older CLDR names browsers report (such as `Asia/Calcutta`); `server/src/locations/time-zones.ts` resolves those through `Intl` to a zone PostgreSQL knows.

## Task routing

| Task | Read |
|---|---|
| Scaffold, build, CI, release | ADR-0011, ADR-0012, ADR-0013; ticket #2; spec's Repo, build and release section |
| Plugin runtime or simulated tablet | `AI_RUNTIME_NOTES.md`, `AI_BUILD_NOTES.md`; `server/test/support/simulated-tablet.ts` |
| Wire messages, validators, delivery, chunking, backfill | `AI_PROTOCOL_NOTES.md`; spec's Protocol package and Testing Decisions sections |
| Machine identity, tokens, adoption | ADR-0004, ADR-0015; spec's Machines and Identity resolution sections |
| Capture, extraction, database | `AI_STORAGE_NOTES.md`; ADR-0007; spec's Capture, Record extraction and Schema outline sections |
| Accounts, Locations, management interface | Spec's Server modules and Management interface sections; ADR-0011 |
| Later sharing behavior | ADR-0003, ADR-0005, ADR-0006, ADR-0008, ADR-0014; spec's Out of Scope section |
| Inspecting the prototype | `server.mjs`, `PROTOCOL.md`, prototype sections of `AI_STORAGE_NOTES.md` and `AI_BUILD_NOTES.md` |

For upstream paths and checkout conventions, see `AGENTS.md` External sources. Verify Decaid payload fields in its source at the relevant version; the local runtime note identifies useful entry points.

## Data

`data/` is git-ignored and may hold real history. Use a scratch `DATA_DIR` for prototype experiments. Do not bulk-read history to learn a schema. Milestone 1 requires no prototype-data migration; the tablet backfills its records when adopted.
