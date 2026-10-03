# decent-sync

Decent Sync connects Decent espresso machines (DE1Pro, DE1XL, DE1XXL, Bengle)
running [Decaid](https://github.com/decentespresso/decaid) to one self-hosted
server. Machines at several locations share a library of beans, batches and
profiles. Machines at the same location share equipment, recipes and steam
settings, working like the groups of one commercial espresso machine. The
server collects every shot and steam record they produce, and a web management
interface shows machines, stock and analytics across all locations.

It is built for one owner per server: a home user with two machines, or a
business with a roastery lab and several cafes.

## Status

**The design is settled and the build has not started.** The code in this repo
today (`server.mjs`) is a receive-only prototype. It will be replaced by the
layout below, starting with milestone 1.

## Design

- [GLOSSARY.md](GLOSSARY.md) defines the domain terms: machine, location,
  equipment, bean batch, stock, recipe, recipe slot, workflow, and the rest.
- [docs/adr/](docs/adr/) records the decisions and why they were made.

In short:

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

## Planned layout

One repo, laid out the way Decent lays out its own plugins (ADR-0012), as an
npm workspace:

```
plugin/                   Decaid plugin source (TypeScript)
decent-sync.reaplugin/    the built plugin, committed and released as a ZIP
server/                   NestJS + Prisma on PostgreSQL
web/                      management interface: React, Vite, shadcn/ui
protocol/                 wire types shared by plugin and server
```

The plugin talks to the server over one WebSocket, and everything else uses the
server's REST API. Machines install and update the plugin from this repo's
GitHub releases:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' -d '{"repo": "loganfuller/decent-sync"}'
```

Self-hosters run a Docker image with PostgreSQL.

## Milestones

1. **Foundation.** The new layout and stack, machine adoption and identity,
   locations, accounts. Captures shots, steam records, workflow and state
   changes, the library, settings and paired devices from every machine.
2. **Shared library.** Beans, batches, grinders and profiles pushed to tablets,
   plus shared steam, hot water and rinse settings.
3. **Location sharing.** DYE2 recipes and equipment, and moving machines between
   locations.
4. **Stock.** Deliveries, transfers, counts and the coffee each shot uses.
5. **Analytics.** Which batches and recipes each location is pulling, machine
   status, and comparing shots across machines and locations.

## The prototype

`server.mjs` receives what the prototype plugin
([decent-sync-plugin](https://github.com/loganfuller/decent-sync-plugin),
now deprecated) sends, prints it, and stores it as JSON files under `DATA_DIR`.
Its wire format is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

```bash
npm install
npm start                    # ws://0.0.0.0:8787/sync, data in ./data
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
