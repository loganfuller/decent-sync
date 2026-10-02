# decent-sync-server

The central server for Decent Sync. Each Decent espresso machine running Decaid
with [decent-sync-plugin](../decent-sync-plugin) connects here and streams its
shots, beans, batches, grinders, profiles, settings and machine activity.

**Prototype status:** receive-only. The server prints everything it gets to the
terminal and keeps a copy on disk.

## Run

```bash
npm install
npm start                    # or: node server.mjs --full --verbose
```

| | |
|---|---|
| `--full` | also pretty-print every payload |
| `--verbose` | also show heartbeats and duplicate deliveries |
| `PORT` | listen port (default 8787). Machines connect to `ws://<host>:<PORT>/sync` |
| `HOST` | bind address (default `0.0.0.0`) |
| `SYNC_TOKEN` | require this token in each machine's `hello`. Set the same value as the plugin's `AuthToken` |
| `DATA_DIR` | storage root (default `./data`) |

## Storage

```
data/machines/<machineId>/machine.json         latest hello (identity, versions, lastSeen)
data/machines/<machineId>/events.jsonl         every message received, append-only
data/machines/<machineId>/state/<name>.json    latest beans, beanBatches, grinders, profiles, settings, workflow
data/machines/<machineId>/shots/<shotId>.json  every shot, with measurements
```

When a machine connects, the server compares the machine's shot list with
`shots/` and asks for the shots it lacks.

## Protocol

See [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Roadmap

1. **Server → machine writes.** Push beans, batches, grinders and profiles to
   the other machines over the same socket. Each machine assigns its own UUIDs,
   so the server needs a global id and a `globalId ↔ localId` map per machine,
   plus a conflict rule (for example, last-writer-wins on `updatedAt`).
   Profiles are content-hashed, so they map directly.
2. **Shot chunking.** Decaid limits a plugin's pending outbound data to 1 MiB,
   so shots of roughly 7 minutes or longer can't be sent as one frame. See
   `docs/AI_STORAGE_NOTES.md`.
3. **Real storage.** Replace the JSON files with a database.
4. **Internet deployment.** Issue a token per machine, and serve only `wss://`
   (TLS, for example behind a reverse proxy). Decaid's WebSocket transport
   can't send custom headers, so auth stays in the `hello` message.
