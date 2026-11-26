---
title: Upgrading
description: Upgrading the server and the plugin, and what to do if you skipped a release.
---

From 1.4.0, each release runs beside the one before it
([ADR-0025](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0025-each-release-runs-beside-the-previous-one.md)). The new
release migrates the database in place while the old one may still be serving
from it. No upgrade asks you to stop the server or recreate the database.

- **Two or more instances**, behind a proxy that routes by `/api/health` as in
  the fly.io example, upgrade without going offline. The new release starts
  beside the old one and takes the traffic once it has migrated. The old one
  then stops.
- **One instance**, as with Docker Compose, stops and then starts the new
  release. It is offline until the new release has migrated, usually a few
  seconds.

## With Docker Compose

```bash
docker compose pull && docker compose up -d
```

The server is offline for a few seconds, until the new release has started
and migrated the database.

With `DECENT_SYNC_VERSION` at `latest`, a pull takes the newest release. So
either upgrade after every release, or pin the version and step through each
release in turn. See [If you skipped a release](#if-you-skipped-a-release).

## Keep the server within one release of the plugin

Decaid checks for plugin releases every 12 hours while it runs, and updates
each tablet's plugin whatever release its server runs, unless its automatic
update checks are turned off or the plugin is Pinned
([Updates](../../reference/tablet-plugin/#updates)). A plugin and server one
release apart work together, whichever is upgraded first. Two releases apart,
they may not. So upgrade the server to each release soon after it is
published.

## If you skipped a release

Take the server up one release at a time. Run each release until its
background work, such as rewriting stored data in batches, is done. A release
whose migrations need that work done checks that it is, and otherwise refuses
to start, naming the release to run until it is.

- With Docker Compose, set `DECENT_SYNC_VERSION` to each release in turn.
- On fly.io, set the image version in `fly.toml` to each release in turn.

## Release notes

Each release's notes start with anything it needs beyond its new image. The
same notes are in the [Upgrade notes](../../reference/upgrade-notes/).

Data from releases before 1.0.0 doesn't carry over: 1.0.0 started the
database afresh.
