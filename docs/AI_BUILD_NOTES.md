# AI Build Notes

Read this when running, smoke-testing, or verifying the server. There is no build step and no automated test suite yet.

## Run

```bash
npm install
npm start                                   # ws://0.0.0.0:8787/sync, data in ./data
node server.mjs --full --verbose            # payloads, heartbeats, duplicate deliveries
PORT=8799 DATA_DIR=/tmp/ds node server.mjs  # scratch instance
```

On start the server prints the `ws://` URL for every non-internal IPv4 interface. Give the plugin a URL the tablet can reach, normally the LAN address.

Only one server can bind a port. A stale instance gives `port 8787 is already in use`; find it with `lsof -iTCP:8787 -sTCP:LISTEN`. While a stale instance holds the port, connected machines keep syncing into that instance's `DATA_DIR`.

## Verify

1. `node --check server.mjs` after every edit.
2. Start a scratch instance on a spare port with a scratch `DATA_DIR`.
3. Drive it with the plugin, either:
   - the plugin repo's dev harness, `decent-sync-plugin/scripts/dev-harness.mjs`, which runs `plugin.js` in Node against a real machine's API and your server, with no tablet changes; or
   - the real plugin on a tablet, via `decent-sync-plugin/scripts/install-plugin.sh`, pointed at your instance.
4. Expect, in order: `connected`, one line per collection, `shot index`, then `shot (backfill)` lines until every shot is stored, with no `error` lines.
5. Restart the server while the plugin is connected. The plugin should reconnect within 60 seconds, resend a full snapshot, and `shot index` should report `0 not yet stored`.

Show this terminal output as evidence when reporting a change as working.

## Machines on the Test LAN

| | |
|---|---|
| DE1Pro tablet (Decaid API) | `http://192.168.4.33:8080` |
| Decaid API docs | Decaid's `assets/api/rest_v1.yml`, or the interactive docs on port 4001 of a running Decaid |

The tablet's API is unauthenticated on the LAN, and `PUT /api/v1/plugins/:id/source` runs arbitrary code there. Install only code from this project, and only when asked.
