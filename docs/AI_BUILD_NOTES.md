# AI Build Notes

## Milestone 1 verification

Use the root package scripts listed in the README's Development section: `npm run typecheck`, `npm run build`, `npm test` (Vitest, after a build), `npm run test:e2e` (Playwright) and `npm run check:plugin-build`. CI (`.github/workflows/ci.yml`) runs all of them against a PostgreSQL service on every push and pull request. Its `package` job writes the plugin ZIP (`npm run package:plugin`) and runs `docker compose up --build`, checking that the image migrates and serves the management interface, without publishing anything. `npm run prototype` runs `server.mjs`. [The spec's Testing Decisions](https://github.com/loganfuller/decent-sync/issues/1) are the testing contract:

- Seam 1 runs the built `decent-sync.reaplugin/plugin.js` in a simulated Decaid host against a real server and a fresh PostgreSQL database per test file. Assertions use the REST API. Raw frames exercise protocol failures and delivery cases.
- Seam 2 uses Playwright against the management interface, with data seeded through Seam 1.
- Vitest module tests cover the spec's listed pure modules through their public interfaces without mocks. Other behavior is tested through the two seams unless it proves untestable there.

Ticket #5 builds Seam 1 from prior art in the archived [plugin dev harness](https://github.com/loganfuller/decent-sync-plugin/blob/main/scripts/dev-harness.mjs). That old harness calls a real tablet API; it is not yet the fixture-backed simulated tablet required by the spec. Until then, `plugin/test/stand-in-host.ts` loads the built `plugin.js` the way Decaid does (source pasted into a function body, global `createPlugin(host)`, id check, synchronous `onLoad`).

`npm run check:plugin-build` rebuilds the plugin and fails if `decent-sync.reaplugin/` then differs from the git index (on a CI checkout, the commit under test). Report verification commands and results, including anything not exercised.

Vitest tests that need build output (the committed plugin, the compiled server) read it directly, so build before `npm test`. Server tests run the built server as a process rather than importing Nest modules: Vitest's esbuild transform does not emit the decorator metadata Nest's dependency injection needs.

## Releases

`.github/workflows/release.yml` publishes on a pushed `vX.Y.Z` tag: it checks the tag against the committed manifest (`scripts/check-release-tag.mjs`), waits for CI to have passed on the tagged commit (it does not run CI again), pushes the server image to GHCR, then creates the GitHub release with the one plugin ZIP. The README's Releasing section has the procedure. Pushing a release tag publishes to every Machine that installed by repo name, so tag, push or create releases only when explicitly asked. To check packaging, run `npm run package:plugin` and `docker compose up --build` locally; use a separate Compose project name and ports (`-p`, `DECENT_SYNC_PORT`, `POSTGRES_PORT`) when the development database is already running.

## Fixtures

Fixtures are records Decaid produced: real records from the test tablet where they exist, otherwise records from a Decaid build running simulated devices (it has a mock Bengle with a milk probe). A derived fixture, such as a real Shot with its measurements repeated past 1 MiB, is allowed if its file or test names it as derived. Never hand-write a record shape. Trim fixtures, and scrub Barista names and notes before committing them: the repo is public.

## Real tablet

The last documented test endpoint is the DE1Pro tablet at `http://192.168.4.33:8080`. Confirm its identity and reachability before using it; a LAN address is not a permanent identity. Decaid's API definitions are in `decaid:assets/api/rest_v1.yml`.

The tablet API is unauthenticated on the LAN. Read-only `GET` requests, for example to gather fixtures, are allowed once its identity is confirmed. Any write needs an explicit request. Installing or updating a plugin executes code there: do so only when explicitly asked, including uploads through `PUT /api/v1/plugins/:id/source` and release installation. Install only this project's code. Use the simulated tablet for routine verification. Check the relevant Decaid source before relying on host behavior.

## Prototype inspection only

There is no prototype build or automated test suite. To inspect it in isolation:

```bash
npm install
node --check server.mjs
PORT=8799 DATA_DIR=/tmp/decent-sync-prototype-audit node server.mjs
```

Choose an unused scratch directory and port. `--full` prints payloads; `--verbose` includes heartbeats and duplicate deliveries. Read `server.mjs` for its remaining options. A stale process can keep syncing into its own `DATA_DIR`; inspect listeners before diagnosing a port conflict.

With the archived prototype plugin, a basic smoke check observes connection, collections, shot index and backfill. Reconnecting should resend snapshots and request only missing shot ids. This does not verify milestone 1's authentication, Steam Records, identity resolution or chunking. Ticket #19 removes these prototype instructions.
