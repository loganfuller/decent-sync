# AI Repo Map

Use this for orientation. Read the smallest matching topic note, inspect the named source, and widen only when the task crosses a boundary.

## The One Thing To Know First

This repo is half of a two-repo system. Every message the server handles is produced by `decent-sync-plugin` running inside Decaid on a Decent tablet, and every reply is consumed there. A change to message shape is a change to both repos. Start from `docs/PROTOCOL.md`.

## Task Routing

| Task | Read first | Then |
|------|-----------|------|
| Adding or changing a message type | `docs/PROTOCOL.md` | `docs/AI_PROTOCOL_NOTES.md`, `Session.on_<type>` in `server.mjs`, then the plugin's `onServerMessage` / `enqueue` call sites |
| Delivery, acks, duplicates, reconnects | `docs/AI_PROTOCOL_NOTES.md` | `Session.handle`, `Session.remember`, `Session.hello` |
| Auth, tokens, machine identity | `docs/AI_PROTOCOL_NOTES.md` | `Session.hello`, `SYNC_TOKEN` |
| Where data lands, file layout | `docs/AI_STORAGE_NOTES.md` | `machineDir`, `writeJson`, `on_shot`, `on_collection` |
| Collection diffs, multi-part collections | `docs/AI_STORAGE_NOTES.md` | `Session.on_collection` |
| Shot backfill | `docs/AI_PROTOCOL_NOTES.md` | `on_shotIndex`, `storedShotIds`, plugin `runBackfill` |
| Terminal output formatting | — | `out`, `detail`, `shotSummary`, `collectionFormatters` |
| Running, smoke-testing, verifying with a machine | `docs/AI_BUILD_NOTES.md` | `AGENTS.md` quick commands |
| What Decaid sends, field meanings | `decent-sync-plugin/docs/AI_DATA_NOTES.md` | Decaid's `assets/api/rest_v1.yml` |

## Coupling

| Changing... | Must also check... | Why |
|-------------|---------------------|-----|
| Any message type or field | `docs/PROTOCOL.md`, plugin `plugin.js` sender or handler, plugin `docs/AI_DATA_NOTES.md` | Two repos, one contract |
| Ack timing | Plugin outbox (`ackMessage`, `pump`) | The plugin drops a message forever once acked |
| `on_shotIndex` / `requestShots` | Plugin `runBackfill`, `BACKFILL_LOW_WATER`, `sentShots` | Backfill is flow-controlled by the plugin's outbox |
| `hello` fields or identity | Plugin `resolveIdentity`, `data/machines/<id>/` directory names | Changing `machineId` derivation splits one machine's history into two directories |
| Storage layout | `on_shotIndex` (reads `shots/`), README "Storage" section | Backfill decides what is missing from what is on disk |

## Production Entry Points

- `server.mjs` — the whole server: `Session` (one per connection), `WebSocketServer` setup, output helpers, storage helpers.
- `docs/PROTOCOL.md` — wire contract.

## Read Late, Not First

- `data/` — the user's real synced data. Git-ignored. Large; never bulk-read it to learn the schema. Read one `shots/*.json` or `state/*.json` if you need an example.
- `node_modules/`, `package-lock.json`.

## Source-Of-Truth Order

1. Current `server.mjs` and the plugin's `plugin.js`.
2. `docs/PROTOCOL.md`.
3. Decaid's own source and OpenAPI spec (`assets/api/rest_v1.yml`) for payload contents. Decaid is checked out at `../decaid` relative to this repo.
4. README and AI notes.

When sources disagree, describe the discrepancy and follow the higher item, unless the task is to reconcile documentation.
