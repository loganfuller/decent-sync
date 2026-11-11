# Development

- [Layout](#layout)
- [Setup](#setup)
- [Commands](#commands)
- [Tests](#tests)
- [The committed plugin](#the-committed-plugin)
- [Releasing](#releasing)

## Layout

One repository, laid out the way Decent lays out its own plugins
([ADR-0012](adr/0012-one-repo-in-decents-layout.md)), as an npm workspace:

```
plugin/                   Decaid plugin source (TypeScript)
decent-sync.reaplugin/    the built plugin, committed and released as a ZIP
server/                   NestJS + Prisma on PostgreSQL
web/                      management interface: React, Vite, shadcn/ui
protocol/                 wire types and runtime validators shared by plugin and server
```

The plugin talks to the server over one WebSocket. Everything else uses the
server's REST API. One version covers the whole repository, and each release
publishes the server image and the plugin together.

## Setup

You need Node.js 26 or newer and PostgreSQL 14 or newer. Node must include
Temporal, as nodejs.org's builds do. Some packaged builds, such as Homebrew's,
leave it out, and the server refuses to start on one.

```bash
npm install
cp .env.example .env         # DATABASE_URL and PUBLIC_URL for local use
npm run db:up                # PostgreSQL in Docker
npm start                    # build everything, migrate, serve http://localhost:3000
```

The server reads its configuration only from environment variables.
`npm start` and `npm run dev:server` also load `.env` if it is there.
[SELF-HOSTING.md](SELF-HOSTING.md#configuration-reference) lists every
variable, and the paths the server serves.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Build everything, migrate, and serve on port 3000 |
| `npm run dev:server` | Run the server, rebuilding on change |
| `npm run dev:web` | Run Vite's dev server for `web/`, proxying `/api` to the dev server |
| `npm run db:up` | Start the development PostgreSQL in Docker |
| `npm run typecheck` | Typecheck every workspace |
| `npm run build` | Build every workspace, including `decent-sync.reaplugin/` |
| `npm run build:stale` | Rebuild only the workspaces whose builds are older than their sources |
| `npm run build:latest-release` | Build the latest release from its tag, outside the checkout, for the tests that run it beside your change |
| `npm run db:test` | Start the shared test PostgreSQL in Docker, and drop test databases more than 2 hours old |
| `npm test` | Run Vitest. Run `npm run build` first. |
| `npm run test:e2e` | Run Playwright against the built server. Run `npm run build` first. |
| `npm run test:latest-release-suite` | Run the latest release's Vitest suite on this checkout's schema, on a throwaway PostgreSQL in Docker. Run `npm run build:latest-release` first. |
| `npm run check:plugin-build` | Fail if the committed `decent-sync.reaplugin/` differs from a fresh build |
| `npm run package:plugin` | Write the release ZIP of the committed plugin to `dist/` |
| `docker compose up --build` | Build the server image from this checkout and run it with PostgreSQL |

## Tests

- Tests use the built plugin and server, so run `npm run build` first.
- Server tests and Playwright start the built server once per test file. Each
  file gets a fresh database, created and dropped on the PostgreSQL named by
  `TEST_DATABASE_URL`, or else `DATABASE_URL`. That PostgreSQL must be
  running, and its user must be allowed to create databases and roles, as
  the ones `npm run db:test` and `npm run db:up` start are.
- `npm run db:test` runs a PostgreSQL for tests alone, with more connections,
  keeping test databases out of your development data (see `.env.example`).
- [AI_BUILD_NOTES.md](AI_BUILD_NOTES.md) says how to run part of the tests.

## The committed plugin

Decaid installs whatever is committed in `decent-sync.reaplugin/`, so commit
the rebuilt plugin with every change to `plugin/` or `protocol/`.

CI checks that the committed plugin matches a fresh build. It also packages
the plugin ZIP, runs the server image with Docker Compose, and builds the
image for amd64 and arm64 as the release does, without publishing any of them.

## Releasing

One version covers the whole repository. It lives in the root `package.json`,
and the plugin build copies it into `decent-sync.reaplugin/manifest.json`.

> [!WARNING]
> Decaid installs the latest release on every tablet that installed by repo
> name, and refuses prerelease-style tags. Publish only versions meant for
> every Machine.

### Steps

Replace `X.Y.Z` with the new version.

1. Set the version, rebuild the plugin, and retitle the Unreleased notes in
   `UPGRADING.md`, if there are any, with the version. Rebuild the test
   durations manifest too, once CI has passed on `main` for the last change
   the release holds. Commit the changes and merge them to `main`:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   npm run build -w plugin
   node scripts/update-test-durations.mjs
   ```

   The last command writes `vitest.durations.json`, which CI deals the test
   files out to its shards by, from the logs of the last 10 successful CI runs
   of `main`. It reads them through `gh` and takes a minute or two. A line
   starting "No CI data for" names a test file none of those runs' shards
   held, which gets an estimate from its size. The files under
   `server/test/latest-release/` are always named, as they run in a job of
   their own. If the release added any other, wait for its run on `main` to
   pass and rebuild again.

2. Tag the resulting commit on `main` as `vX.Y.Z`, and push the tag. A tag on
   any other commit fails the release, because pull request CI tests a merge
   with `main` rather than the tagged commit.
3. Once the release is published, deploy it to every server you run before
   tagging the next. Decaid installs the new plugin on every tablet within 12
   hours, and a plugin two releases ahead of its server falls outside what the
   two support together.

### What the release workflow does

The [release workflow](../.github/workflows/release.yml) runs on the pushed
tag. It fails unless:

- the tag is `vX.Y.Z` and matches the committed manifest's version;
- `UPGRADING.md` has no notes left under Unreleased;
- CI has passed on the tagged commit as a push to `main`. The workflow waits
  for that run rather than running CI again.

It then:

1. publishes the server image, for amd64 and arm64, to
   `ghcr.io/loganfuller/decent-sync` as `X.Y.Z`, `X.Y` and `latest`;
2. creates the GitHub release, with `decent-sync.reaplugin-vX.Y.Z.zip` as its
   only asset. Its notes start with the version's section of `UPGRADING.md`
   (`scripts/release-notes.mjs`), followed by GitHub's notes generated from
   the pull requests merged since the last release.

### Upgrade notes

Anything owners must do when upgrading goes in `UPGRADING.md` under
Unreleased, such as approving a plugin update that adds a permission on every
tablet.

No note may ask owners to stop the server, recreate the database or redo
anything. Each step is done while everything runs
([ADR-0025](adr/0025-each-release-runs-beside-the-previous-one.md)). Two kinds
of step come before the deploy, and the release's notes name them:

- **A raised Decaid, DYE2 or Streamline minimum**
  ([ADR-0017](adr/0017-supported-versions.md)). Update each tablet first.
- **A raised wire revision**, meaning `WIRE_REVISION` in
  `protocol/src/index.ts` is above the previous release's. The server refuses
  a plugin more than one revision behind it. Check on each Machine's page that
  its tablet runs the previous release's plugin or this one's. Where it
  doesn't, update it from the tablet's network with
  `POST http://<tablet>:8080/api/v1/plugins/update`, or approve an update that
  adds a permission with
  `POST http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/update/approve`.

### Breaking releases

A release that can't run beside the previous one is made only with the
owner's approval:

- The pull requests that break the rule carry the `breaking-release` label,
  which only the owner applies.
- From the first one's merge until the release is tagged, CI's checks against
  the latest release are skipped ([AI_BUILD_NOTES.md](AI_BUILD_NOTES.md)).
- The release takes a new major version. Its notes open with its downtime and
  how to deploy it: stop every instance, then start the new release.
