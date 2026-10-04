# AI Repo Map

## Start here

The repository holds the milestone 1 workspace, scaffolded by [ticket #2](https://github.com/loganfuller/decent-sync/issues/2) with no domain behavior yet, plus the receive-only prototype (`server.mjs`) that [ticket #19](https://github.com/loganfuller/decent-sync/issues/19) removes once milestone 1 replaces it.

Target requirements come from `GLOSSARY.md`, accepted `docs/adr/` decisions and [milestone 1](https://github.com/loganfuller/decent-sync/issues/1), then the assigned ticket. ADR-0010 is superseded by ADR-0012, and ADR-0015 extends ADR-0004. The prototype's code and protocol do not override these requirements.

## Layout

| Path | Responsibility | Entry points |
|---|---|---|
| `plugin/` | TypeScript source for the Decaid plugin | `src/index.ts`; `build.mjs` writes `decent-sync.reaplugin/`; `manifest.json` is the manifest template (the version comes from the root `package.json`) |
| `decent-sync.reaplugin/` | Committed ES2020 bundle and manifest installed by Decaid | Generated; never edit by hand |
| `server/` | NestJS, Prisma, PostgreSQL, WebSocket gateway, REST API, serving the built web app | `src/main.ts` (config, migrations, bootstrap), `src/config.ts`, `src/accounts/` (accounts, sessions and the guards every route passes), `src/locations/` (Locations and the time zones they may use), `prisma/schema.prisma`, `prisma/migrations/` |
| `web/` | React, Vite, shadcn/ui management interface; uses the REST API | `src/App.tsx` (routes), `src/auth.tsx`, `src/pages/Shell.tsx` (the signed-in frame later pages join); add components with `npx shadcn add` |
| `protocol/` | Internal shared wire types and runtime validators; never published | `src/index.ts` |
| `e2e/` | Playwright tests (Seam 2) | `playwright.config.ts` at the root |
| `Dockerfile`, `docker-compose.yml` | Server image (server plus built web app) and the self-hosting stack with PostgreSQL; `npm run db:up` starts only its `db` service | |
| `scripts/` | Repo checks and release packaging | `check-plugin-build.mjs`, `check-release-tag.mjs`, `package-plugin.mjs`; tests in `scripts/test/` |
| `.github/workflows/` | CI on pull requests and `main`; release on `vX.Y.Z` tags | `ci.yml` (also called by the release), `release.yml` |

Root `package.json` scripts are the commands; the README's Development section lists them. One protocol change updates the plugin, server and shared package together here; the old plugin repo is archived.

`protocol/` exports its TypeScript source under the `@decent-sync/source` condition, which esbuild, TypeScript and Vitest use, so they need no protocol build. Node at runtime uses `protocol/dist`, so the server needs `npm run build -w protocol` first (the root `build`, `start` and `dev:server` scripts do this). The Prisma client is generated into `server/src/generated/` (git-ignored) by the server's `build` and `typecheck` scripts. Tables and columns are snake_case (`@@map`, `@map`) while models keep Prisma's casing.

Every REST route requires a signed-in account unless marked `@Public()` (`server/src/accounts/guards.ts`); only health, first-run setup and sign-in are public so far. Role checks (Admin-only actions such as editing Locations) arrive with Staff accounts in ticket #15. State-changing requests are refused as cross-site unless their `Origin` is `PUBLIC_URL`, or the requested host when that host is an IP address or `localhost` (not another domain name, which would admit DNS rebinding).

A Location's time zone is an IANA name spelled as PostgreSQL's `pg_timezone_names` lists it, so date filters can use it in `AT TIME ZONE`. `server/src/locations/time-zones.ts` maps the older CLDR names browsers report (such as `Asia/Calcutta`), which PostgreSQL lacks when built without tzdata's backward links, to their IANA names.

## Task routing

| Task | Read |
|---|---|
| Scaffold, build, CI, release | ADR-0011, ADR-0012, ADR-0013; ticket #2; spec's Repo, build and release section |
| Plugin runtime or simulated tablet | `AI_RUNTIME_NOTES.md`, `AI_BUILD_NOTES.md`; ticket #5 |
| Wire messages, validators, delivery, chunking, backfill | `AI_PROTOCOL_NOTES.md`; spec's Protocol package and Testing Decisions sections |
| Machine identity, tokens, adoption | ADR-0004, ADR-0015; spec's Machines and Identity resolution sections |
| Capture, extraction, database | `AI_STORAGE_NOTES.md`; ADR-0007; spec's Capture, Record extraction and Schema outline sections |
| Accounts, Locations, management interface | Spec's Server modules and Management interface sections; ADR-0011 |
| Later sharing behavior | ADR-0003, ADR-0005, ADR-0006, ADR-0008, ADR-0014; spec's Out of Scope section |
| Inspecting the prototype | `server.mjs`, `PROTOCOL.md`, prototype sections of `AI_STORAGE_NOTES.md` and `AI_BUILD_NOTES.md` |

For upstream paths and checkout conventions, see `AGENTS.md` External sources. Verify Decaid payload fields in its source at the relevant version; the local runtime note identifies useful entry points.

## Data

`data/` is git-ignored and may hold real history. Use a scratch `DATA_DIR` for prototype experiments. Do not bulk-read history to learn a schema. Milestone 1 requires no prototype-data migration; the tablet backfills its records when adopted.
