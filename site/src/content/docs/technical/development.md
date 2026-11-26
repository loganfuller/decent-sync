---
title: Development
description: Where to find how to build, test and release Decent Sync.
---

Decent Sync is one repository, an npm workspace holding the plugin, the
server, the management interface, the protocol they share and this site. How
to work on it is in the development guide,
[docs/DEVELOPMENT.md](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md),
which is kept in the repository beside the code it describes.

## Run it from a checkout

You need Node.js 26 or newer with Temporal, and Docker for PostgreSQL.
nodejs.org's builds include Temporal. Some packaged builds, such as
Homebrew's, don't, and the server refuses to start on one.

```bash
npm install
cp .env.example .env
npm run db:up      # PostgreSQL in Docker
npm start          # build, migrate and serve http://localhost:3000
```

## The development guide

| Section | What it covers |
|---|---|
| [Layout](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#layout) | What each folder of the workspace holds. |
| [Setup](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#setup) | What you need, and the server's configuration. |
| [Commands](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#commands) | Every command: building, serving, checking and testing. |
| [Tests](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#tests) | What the tests need, and the PostgreSQL they run on. |
| [The committed plugin](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#the-committed-plugin) | Why the built plugin is committed, and what CI checks of it. |
| [Images of the management interface](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#images-of-the-management-interface) | The generator of the images the README and this site show. |
| [The documentation site](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#the-documentation-site) | How this site is written, built, checked and deployed. |
| [The simulation's scorecard](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#the-simulations-scorecard) | How close the simulation of a Profile comes to recorded Shots. |
| [Releasing](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#releasing) | The steps of a release, what its workflow does, and upgrade notes. |

## Before changing the code

- [Architecture](../../technical/architecture/) is the outline, and
  [Internals](../../technical/internals/) links to the full behaviour of each
  area and to the notes agents work from.
- [AGENTS.md](https://github.com/loganfuller/decent-sync/blob/main/AGENTS.md)
  holds the rules every change follows, for a person as for an agent. One of
  them: a change that alters what people read or do updates its page of this
  site in the same change.
