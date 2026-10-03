# AI Repo Map

## Start here

The repository currently contains `server.mjs`, its package files and documentation. That code is a receive-only prototype. [Ticket #2](https://github.com/loganfuller/decent-sync/issues/2) scaffolds the replacement; [ticket #19](https://github.com/loganfuller/decent-sync/issues/19) removes the prototype after milestone 1 replaces it.

Target requirements come from `GLOSSARY.md`, accepted `docs/adr/` decisions and [milestone 1](https://github.com/loganfuller/decent-sync/issues/1), then the assigned ticket. ADR-0010 is superseded by ADR-0012, and ADR-0015 extends ADR-0004. The prototype's code and protocol do not override these requirements.

## Target layout (created by ticket #2)

| Path | Responsibility |
|---|---|
| `plugin/` | TypeScript source for the Decaid plugin |
| `decent-sync.reaplugin/` | Committed ES2020 bundle and manifest installed by Decaid |
| `server/` | NestJS, Prisma, PostgreSQL, WebSocket gateway, REST API, serving the built web app |
| `web/` | React, Vite, shadcn/ui management interface; uses the REST API |
| `protocol/` | Internal shared wire types and runtime validators; never published |

These are planned paths, not existing entry points. Find actual commands in the workspace package files as implementation lands. One protocol change updates the plugin, server and shared package together here; the old plugin repo is archived.

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
