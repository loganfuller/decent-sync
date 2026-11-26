---
title: Architecture
description: What syncs where, how the plugin, server and management interface talk, and each design decision in a line.
---

Decent Sync is a plugin on each machine's tablet, one server with PostgreSQL
behind it, and a management interface the server serves. This page is the
outline a developer needs before reading the code.
[Internals](../../technical/internals/) links to the full behaviour of each
area, and the [Glossary](../../reference/glossary/) defines the terms.

```
Tablets (Decaid + plugin) ── WebSocket ──┐
Management interface ─────── REST API ───┼──▶  Server  ──▶  PostgreSQL
AI assistants ────────────── MCP ────────┘
```

The plugin runs inside Decaid, beside the tablet's Skin. It sends the server
everything the tablet records, and writes the shared Library and Recipes back
to the tablet through Decaid's own API. Baristas keep using Decaid, DYE2 and
Streamline as before, and a Machine goes on working without the server: the
plugin catches up when it is back.

## What is shared with which Machines

| What | Shared with |
|---|---|
| Beans, Bean Batches, Profiles, Baskets and Tools | Every Location. Each Location offers its own part: the Profiles, Baskets and Tools shown there, the batches there with their Beans, and its own remaining weight of each batch. |
| Grinders, Recipes and Recipe Slots | The Machines at one Location. |
| What a Machine is using: its profile, dose, yield, batch, grinder, basket, and steam, hot water and flush settings | Nothing. Each Machine has its own, which loading a Recipe sets, steam turned on or off as the Recipe holds it. Turning steam off at the Machine never changes the Recipe. |

A tablet reports to the server everything it records: its Shots and Steam
Records, its Workflow changes and Machine States, and its settings, paired
devices, plugins and Skins. The server stores each as Decaid sent it, and
checks only the message that carries it.
[The protocol in outline](#the-protocol-in-outline) says what travels back
to tablets: the Library's writes, a Loaded Recipe's changes, Settings Edits,
Software Actions, a Shot's rating and note, and what a Skin is served.

A few rules shape the rest:

- **A Machine is its hardware**, identified by model and serial number, not
  by its tablet. A Shot is credited to the hardware that recorded it, and
  hardware the server has no Machine for waits as a Pending Machine for an
  Admin.
- **Machines are adopted by hand.** An Admin adds each Machine, which issues
  a Token for its plugin. The server keeps only the Token's hash.
- **The server is the source of truth, but tablets can still edit.** A tablet
  holds only what its Location offers, and what it creates starts at its
  Location. Edits merge field by field, the latest winning, and an edit that
  loses is kept in the item's history as a Lost Edit.
- **A Machine with no Location, or with sharing turned off, is capture-only.**
  Its records are kept, and it takes no part in the Library.

## The three connections

### The plugin's WebSocket

Each tablet's plugin opens one WebSocket to the server, at `/sync` on the
address in its **Server URL** setting, and keeps it open. Everything between
a tablet and the server travels on it, in both directions. Decaid's transport
sets no headers, so the plugin sends its Machine's Token in its first
message. [The protocol in outline](#the-protocol-in-outline) says what
travels on it.

### The REST API

Everything else uses the REST API, under `/api`. The management interface is
its main caller: a single-page app the server serves, which signs a person in
with a session cookie. Apart from a few open ones, such as signing in and
first-run setup, each route is for Admins alone unless it is marked as open
to Staff or to Viewers. Staff edit the Library's shared content anywhere,
and change the rest only at the Locations they work at
([Accounts and roles](../../guide/accounts-and-roles/)).

One route streams. A Machine's Live View is a Server-Sent Events stream
(`GET /api/machines/:id/live`): while someone is watching, the server asks
that Machine's plugin for live frames and passes them on, and stops asking
30 seconds after the last viewer leaves, so a page reloaded within that time
carries on.

The routes of Shots, Steam Records, Workflows and Machine States, what a
tablet reports of itself and the Library are documented in the behaviour
spec of each, which [Internals](../../technical/internals/) links. Those of
accounts, invites, first-run setup, Locations, Machines (listing, adopting
and moving them) and Connected Apps have no spec of their own: they are in the server's controllers, under
`server/src/`. There is no separate REST reference.

### The MCP endpoint

AI assistants connect to an MCP endpoint at `/api/mcp`, over streamable HTTP.
It keeps no session between calls, so any server instance answers any call.
The server is its own OAuth authorization server: a person signs in and
approves an app, to read only or to read and change, which makes it a
Connected App. The app then acts as that person's account, with its role, and
a change that records who made it records the app too.

A change that adds something for people to read or do in the management
interface adds it to the MCP endpoint too. What grants access or destroys
history stays out of it, and every answer is kept within a size an assistant
can read whole. [Assistants](../../guide/assistants/) says what an assistant
may do, [Assistant tools](../../reference/assistant-tools/) lists every tool,
and [On the internet](../../self-hosting/internet/#assistants) says what the
server needs for them.

## The protocol in outline

The messages and their runtime validators are defined once, in the
`protocol/` workspace, and shared by the plugin and the server.

1. **Hello.** The plugin's first message is `hello`: its Token, the
   machine's model and serial number, the plugin's and Decaid's versions, the
   protocol version and wire revision it speaks, and its tablet's id. The
   server settles which Machine this is there and then, and never again
   during the connection. It refuses a wrong Token, a Decaid older than
   [the oldest supported](../../get-started/install-the-plugin/#requirements)
   or a plugin too old to talk to, with an `error` message naming the reason
   before it closes. Otherwise it answers `welcome`, and the two exchange
   heartbeats from then on.
2. **Deliveries.** Each thing the tablet records is a delivery with an id of
   its own: a Shot, a Steam Record, a Workflow change, a Machine State, or a
   collection such as its settings or its plugins. The plugin keeps a
   delivery until the server acknowledges it, and the server acknowledges
   only after storing it. A delivery sent again after a dropped connection is
   stored once, since storing is idempotent.
3. **Chunks.** Decaid limits how much a plugin may send at once, so a message
   too large for one frame, such as a long Shot, travels as numbered chunks
   and is put back together at the other end.
4. **Backfill.** When the plugin loads, it sends an index of the Shots and
   Steam Records on its tablet. The server asks for those it lacks, newest
   first, so a tablet's history arrives without holding up new Shots.
5. **Writes to the tablet.** The server sends each Library change to the
   tablets at the Locations it concerns, one write at a time. The plugin
   carries it out through Decaid's API, or DYE2's storage for Recipes,
   Baskets and Tools, and answers whether it was written. Each shared item
   but a Profile carries its global id on the tablet's own record. A Profile
   keeps Decaid's id, a hash of what the machine runs, which is the same on
   every tablet.
6. **Requests made once.** A Settings Edit and a Software Action go to a
   connected tablet and are answered with what came of them. Neither is kept
   for a tablet that is not connected. An edit of a Shot's rating or note is
   written to the tablet that holds the Shot at once, or when that tablet
   next connects.
7. **For a Skin.** A Skin asks the plugin on its own tablet, and the plugin
   asks the server over the same connection.
   [For a Skin's author](../../technical/skin-authors/) has what it answers.

Two rules let a server of two or more instances upgrade without going offline:

- **Each release runs beside the previous one.** A plugin and a server one
  release apart work together, and so do two server releases on one
  database. Two releases apart is not supported, which is why a server is
  upgraded soon after each release
  ([Upgrading](../../self-hosting/upgrading/)).
- **The wire revision counts changes a receiver cannot ignore.** The protocol
  version stays as it is. Each end accepts a peer one revision behind, and
  sends what is new only to a peer that has it.

## Several server instances

The server can run as several instances on one database, and during an
upgrade as two releases side by side.

- State shared between connections or requests lives in PostgreSQL. An
  instance holds in memory only what belongs to one connection or one request,
  and the limits that protect its own resources, such as how many password
  checks it runs at once. A limit that must hold across instances, such as
  the sign-in limit for an email address, is kept in PostgreSQL.
- Changes that could collide are decided under row or advisory locks.
- A change made on one instance reaches the others with PostgreSQL's
  `LISTEN` and `NOTIFY`: a Library change on its way to tablets, a Settings
  Edit, a Live View frame.

There is no other shared store, and no instance talks to another directly.

## The design decisions

Each decision is recorded as an architecture decision record (ADR) in
[`docs/adr/`](https://github.com/loganfuller/decent-sync/tree/main/docs/adr),
with why it was made and what it rules out. In one line each:

### Scope and ownership

- [ADR-0001](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0001-one-owner-per-server.md): each server holds one owner's data, and the owner hosts it.
- [ADR-0002](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0002-open-source-core-private-extensions.md): the plugin, server and management interface are open source and complete on their own. Work for one business lives elsewhere, on the public API.
- [ADR-0013](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0013-mit-license.md): everything in the repository is released under the MIT license.

### The stack and the repository

- [ADR-0007](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0007-postgresql-for-storage.md): everything the server keeps is in PostgreSQL.
- [ADR-0010](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0010-repo-layout.md): two repositories, one for the plugin. Superseded by ADR-0012.
- [ADR-0011](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0011-typescript-nest-prisma-react-shadcn.md): TypeScript throughout, with NestJS and Prisma on the server and a React app with shadcn/ui.
- [ADR-0012](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0012-one-repo-in-decents-layout.md): one repository, a plain npm workspace laid out as Decent lays out its own plugins.

### Connections and running it

- [ADR-0009](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0009-websocket-for-plugin-rest-for-everything-else.md): one WebSocket for the plugin, and the REST API for everything else. Amended: the Live View streams over Server-Sent Events (ADR-0024), the MCP endpoint is a second public interface (ADR-0026), and a Skin reads through the plugin (ADR-0030).
- [ADR-0016](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0016-instances-share-only-postgresql.md): server instances share state only through PostgreSQL.
- [ADR-0017](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0017-supported-versions.md): only the newest versions of Decaid, DYE2 and Streamline are supported, with Decent Sync's current and previous release. The Decaid minimum and the plugin's protocol are enforced at `hello`.
- [ADR-0024](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0024-live-view-streams-over-sse-relayed-through-postgresql.md): the Live View streams over Server-Sent Events, relayed between instances through PostgreSQL.
- [ADR-0025](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0025-each-release-runs-beside-the-previous-one.md): each release runs beside the previous one, so a server of two or more instances upgrades without going offline.

### Machines and what they record

- [ADR-0004](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0004-machine-identity-is-the-hardware.md): a Machine is its hardware, model plus serial number.
- [ADR-0015](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0015-records-follow-recorded-hardware.md): a Shot follows the hardware that recorded it, and which Machine a connection is for is settled at `hello`.
- [ADR-0021](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0021-plugin-sets-values-streamline-remembers.md): a Skin takes a Workflow change made elsewhere, and the plugin sets nothing of Streamline's.
- [ADR-0022](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md): a Machine's Loaded Recipe is the recipe its Workflow names, and every change on the Machine is saved into it. Interim in part.
- [ADR-0023](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0023-decaid-and-the-machine-keep-their-settings.md): Decaid and the Machine keep their own settings, and the management interface edits them live, never for later.
- [ADR-0031](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0031-a-shots-rating-and-note-are-edited-through-the-server.md): a Shot's rating and note are edited through the server and written to the tablet that holds the Shot.
- [ADR-0034](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0034-the-plugin-manages-its-tablets-software-one-action-at-a-time.md): the plugin manages its tablet's software one Software Action at a time, only while connected.
- [ADR-0035](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0035-how-an-installed-plugin-or-skin-updates-is-changed-by-installing-it-again.md): how an installed plugin or Skin updates is changed by installing it again.

### The Library and Recipes

- [ADR-0003](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0003-server-is-source-of-truth.md): the server is the source of truth, and tablets can still edit.
- [ADR-0005](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0005-interim-recipe-sync-through-dye2-storage.md): Recipes, Baskets and Tools sync by writing DYE2's storage. Interim, until Decaid has resources of its own for them.
- [ADR-0006](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0006-global-ids-stored-on-tablet-records.md): a shared item carries its global id on the tablet's own record, but a Profile, which keeps Decaid's id.
- [ADR-0008](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0008-per-location-state-on-shared-items.md): an item is the same everywhere, and each Location keeps whether it is shown, which batches are there and the weight each batch's count there starts from.
- [ADR-0014](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0014-steam-hot-water-rinse-settings-shared-per-location.md): steam and rinse settings shared by a Location's Machines. Superseded: a Recipe holds them now (ADR-0022).
- [ADR-0018](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0018-new-tablet-items-join-the-library.md): a new item from a tablet joins the Library, and a Bean is matched by its roaster and name.
- [ADR-0019](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0019-tablet-deletes-act-at-its-location.md): a delete on a tablet acts only at that tablet's Location.
- [ADR-0020](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0020-latest-edit-wins-per-field.md): the latest edit wins field by field, not record by record.
- [ADR-0029](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0029-a-recipes-reference-shot-is-chosen-and-held-by-the-server.md): a Recipe's Reference Shot is chosen by a person and held by the server, outside DYE2's recipes. Amended: each tablet keeps a copy and may choose one (ADR-0030).
- [ADR-0030](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0030-the-plugin-serves-a-skin-what-the-server-holds.md): the plugin serves a Skin what the server holds, and a tablet may choose a Reference Shot.
- [ADR-0032](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0032-the-server-authors-profiles-as-drafts-published-under-decaids-id.md): the server authors Profiles, as Drafts published under the id Decaid would give them.
- [ADR-0036](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0036-interim-a-batch-code-in-the-records-extras.md): a Bean Batch's Batch Code is kept in its tablet record's `extras`, under a key of Decent Sync's own. Interim, until Decaid's record has a field for it.
- [ADR-0037](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0037-a-batchs-remaining-weight-is-per-location-and-worked-out-from-shots.md): a Bean Batch's Remaining Weight is held per Location and worked out, as it is read, from the weight its count there starts from, the Shots pulled there since and the Batch Moves to and from it since, which take from one Location exactly what they give the other.
- [ADR-0033](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0033-an-edit-that-loses-is-kept-in-the-items-history.md): an edit that loses is kept in the item's history as a Lost Edit, with nothing to settle.

### Assistants

- [ADR-0026](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0026-assistants-reach-the-server-through-mcp.md): assistants reach the server through an MCP endpoint that every instance serves.
- [ADR-0027](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0027-the-server-authorizes-connected-apps-itself.md): the server is its own OAuth authorization server for Connected Apps.
- [ADR-0028](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0028-every-mcp-response-keeps-within-a-size-budget.md): every MCP response keeps within a size budget.
