# Agent Instructions

For unfamiliar or multi-file tasks, read `docs/AI_REPO_MAP.md` first. For known files or exact symbols, open them directly. Read the topic notes only when the task needs them; do not preload them all.

decent-sync-server is the central half of Decent Sync. Each Decent espresso machine runs the `decent-sync.reaplugin` from the sibling repo `decent-sync-plugin`, which streams its data here over one WebSocket. The two repos share one wire contract, `docs/PROTOCOL.md`.

## Quick Commands

```bash
npm install                                   # once
npm start                                     # listen on ws://0.0.0.0:8787/sync
node server.mjs --full --verbose              # print payloads, heartbeats, duplicates
PORT=8799 DATA_DIR=/tmp/ds node server.mjs    # scratch instance; leaves data/ alone
node --check server.mjs                       # syntax check
```

## Always

- Preserve existing work. Keep changes focused; do not rewrite unrelated code or documentation.
- Default to the current branch and leave changes local. Never push, tag, publish, or create a PR or remote repository unless explicitly asked.
- Verify behavior in current source and against a real or harnessed plugin before claiming it works. Show the terminal output, not just "it works."
- Treat everything under `data/` as the user's real shot history. Never delete, rewrite, or migrate it without explicit approval. Use a scratch `DATA_DIR` for experiments.
- Treat `SYNC_TOKEN`, plugin `AuthToken` values, and `hello.token` as secrets. Never log, print, or persist them; `hello()` strips `token` before storing `machine.json`.
- Update an AI note only when a reusable, non-obvious constraint changes. Remove stale guidance instead of accumulating history.

## Hard Rules

- `docs/PROTOCOL.md` is the authoritative wire contract. Any change to a message type, field, close code, or delivery rule updates `docs/PROTOCOL.md` in the same commit and needs a matching change in `decent-sync-plugin`. Call out the cross-repo change explicitly.
- Don't couple the server to one Decaid or plugin version. Machines run different releases of both. Store Decaid payloads verbatim, treat every Decaid field as optional (display code uses optional chaining and `?? "–"`), and never reject a message because its Decaid data looks unfamiliar. See "Mixed Versions" in `docs/AI_PROTOCOL_NOTES.md`.
- Keep handlers idempotent. Delivery is at-least-once: the plugin resends anything not acked after a reconnect. A message processed twice must leave the same stored state.
- Ack only after the message is persisted. An ack tells the plugin it may drop the message forever.
- Never add a server-to-plugin message without a plugin handler for it; unknown types are ignored by the plugin, which silently drops behavior.
- Write stored JSON through `writeJson()` (temp file plus rename) so a crash never leaves a truncated state or shot file.
- Do not trust `env.machineId` for routing. A session's identity comes from its accepted `hello`.
- Keep the server dependency-light. `ws` is the only runtime dependency; ask before adding another.
- No emojis in comments or documentation.

## Code Style

- Plain Node ESM (`.mjs`), no build step, no TypeScript.
- Message handlers are `Session` methods named `on_<type>`; `handle()` dispatches by name. Add a new type by adding a method, not a switch.
- Terminal output goes through `out()` and `detail()` so every line carries time, machine, and tag. Full payloads print only under `--full`.
- Put rationale and debugging history in the matching `docs/AI_*_NOTES.md`, not in long code comments.

## Vocabulary

| Term | Meaning |
|------|---------|
| machine | one Decent espresso machine plus its Decaid tablet, identified by `machineId` (`de1-<BLE MAC>`) |
| session | one WebSocket connection after a successful `hello` |
| collection | a whole list or settings object the plugin polls: `beans`, `beanBatches`, `grinders`, `profiles`, `appSettings`, `machineSettings`, `machineAdvancedSettings` |
| backfill | shots the server requests with `requestShots` after comparing a `shotIndex` |
| Decaid | the Flutter app on the tablet (internal name ReaPrime; plugin extension `.reaplugin`) |

## External Sources

Paths written `<name>:<path>` are relative to that repo's root. Notes cite files and symbols, never line numbers, because line numbers change between versions.

| Name | Repo | Which version to read |
|------|------|-----------------------|
| `decent-sync-plugin` | [loganfuller/decent-sync-plugin](https://github.com/loganfuller/decent-sync-plugin) | `main`; the two repos change together. Machines may run older plugin releases (`hello.pluginVersion`) |
| `decaid` | [decentespresso/decaid](https://github.com/decentespresso/decaid) | the one the question is about: a machine's `hello.decaidVersion`, or `main` for upcoming changes. Payload shapes differ between versions |

To read one, use `$DECENT_SYNC_PLUGIN_DIR` or `$DECAID_DIR` if set, or a checkout you already have; never assume where a checkout lives. `git show <tag>:<path>` reads a version without checking it out. Without a checkout: `gh api 'repos/<owner>/<repo>/contents/<path>?ref=<ref>' -H 'Accept: application/vnd.github.raw'`.

## Deep References

- Fast file routing: `docs/AI_REPO_MAP.md`.
- Wire contract: `docs/PROTOCOL.md`.
- Delivery, de-duplication, sessions, protocol evolution: `docs/AI_PROTOCOL_NOTES.md`.
- `data/` layout, idempotent writes, collection diffing: `docs/AI_STORAGE_NOTES.md`.
- Running, smoke-testing, and verifying against a machine: `docs/AI_BUILD_NOTES.md`.
- The plugin and Decaid host constraints: `decent-sync-plugin:docs/AI_RUNTIME_NOTES.md`.

## Don't

- Don't change `docs/PROTOCOL.md` or a message shape without the matching plugin change.
- Don't ack before persisting.
- Don't touch `data/` outside a scratch `DATA_DIR` without approval.
- Don't print secrets, even under `--full` or `--verbose`.
