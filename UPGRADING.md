# Upgrading

What to do when upgrading to a release, beyond running its server image and
letting Decaid update each tablet's plugin. From 1.4.0, the
plugin and server of adjacent releases work together, upgraded in either
order, and the new server runs beside the old one as it upgrades, so nothing
here stops the server or recreates the database
([ADR-0025](docs/adr/0025-each-release-runs-beside-the-previous-one.md)).
Earlier releases' notes may still ask that. A server that skipped a release
takes each release in turn (the README's Upgrading section).

Each release's notes on GitHub start with its section here. Notes for the next
release wait under Unreleased until it is tagged (see the README's Releasing
section).

## Unreleased

### A Recipe is shown on the strip by its slot alone

A Recipe no longer keeps a "Shown on the dashboard" setting of its own: it is
on Streamline's strip exactly while it is in a Recipe Slot (below). As it
migrates the database, this release takes each Recipe 1.6.0 left in a slot
but hidden out of that slot, so each strip still shows that button empty;
put the Recipe in a slot again to show it. The setting is dropped from every
Recipe, and each open Conflict over it is dismissed. Past versions in a
Recipe's history still show it.

Deploy it as any release, beside 1.6.0. For the minute or so that 1.6.0
still serves beside it:

- A recipe hidden by Streamline's "Clear button" on a tablet connected to
  1.6.0, or with the switch on a 1.6.0 page, is shown again, as this release
  writes a record shown exactly while its Recipe is in a slot. Hide it again
  once the deploy is done.
- A "Shown on the dashboard" value 1.6.0 saves then stays in the Recipe,
  where nothing reads it.
- A tablet still connected to 1.6.0 is written its recipe records without
  whether they are shown, which DYE2 and Streamline read as shown, until it
  connects to this release.
- A page of the management interface left open from 1.6.0 reloads at its
  next navigation. Until then, its Recipe page can't create a Recipe or use
  the switch, which this release refuses.

Let each tablet update its plugin promptly, as Decaid does within 12 hours:
the server writes the records of each Recipe naming no Bean once more, with
DYE2's explicit nulls for one (below), and only this release's plugin makes
that write.

### Tablets need Decaid v0.9.1 and DYE2 v0.1.32

This release follows Decaid v0.9.1 and DYE2 v0.1.32
([ADR-0017](docs/adr/0017-supported-versions.md)). Update Decaid on each
tablet to v0.9.1 or later before deploying: this release's server refuses a
tablet on an older Decaid, and its Machine's page says why, though 1.6.0
still accepts one while it serves beside this release. Decaid installs DYE2 on
every tablet within 12 hours of its release. Check that a tablet whose DYE2 is
pinned runs v0.1.32 or later.

With Decaid v0.9.1, an edit of a Machine's fan threshold or refill kit lasts
past the Machine reconnecting: the Tablet keeps the value and writes it again
each time it connects. So the Settings card no longer says they reset then,
and says instead that a replacement Tablet, or a reset of Decaid's data, puts
Decaid's default back. A page left open from 1.6.0 shows the old note until it
reloads.

Three things change with DYE2 v0.1.32:

- A Recipe naming no Bean means no bean as it is loaded: loading it, from
  DYE2 or Streamline's strip, leaves the Machine with no bean batch, and the
  load no longer gives it the Machine's. A batch picked once it is loaded is
  saved into it, with its Bean, as before. The server writes such a Recipe's
  records once more, with DYE2's explicit nulls for a Bean.
- A Recipe is on Streamline's strip exactly while it is in a Recipe Slot. The
  Recipe page's "Shown on the dashboard" switch is gone, and hiding a recipe
  on a tablet, by Streamline's "Clear button" or DYE2's switch, takes it out
  of its slot at its Location.
- A grind setting is kept as typed, as a three-dial grinder's `1.1.0`, and
  shown and edited so; one that reads as a number stays a number, and `.5`
  and `0.5` are one setting.

## 1.6.0

### Make Viewers once every instance runs this release

This release adds the Viewer, an account that sees everything Staff see and
changes nothing. 1.5.0 can't read an account or invite with that role: while
one exists, its Accounts page fails for Admins, and a Viewer's requests fail
on it. So invite a Viewer, or change an account to one, only once no 1.5.0
instance runs. Before rolling back to 1.5.0, change each Viewer to another
role, deactivated ones included, and revoke any Viewer invite still waiting.
1.5.0 then still fails to open the link of any other Viewer invite, used,
revoked or expired, rather than saying it can no longer be used. A Viewer
invite for an email that has since got an account through another invite
isn't listed to revoke, and keeps 1.5.0's Accounts page failing until it
expires, 7 days after it was made.

## 1.5.0

### Check every tablet runs the 1.4.0 plugin before deploying

This release is the first to raise the wire revision, for the Live View's
messages ([ADR-0025](docs/adr/0025-each-release-runs-beside-the-previous-one.md),
Deploying). Before deploying, check on each Machine's page that it runs the
1.4.0 plugin, the previous release's. Where one doesn't, update it at the
tablet, or through Decaid's API from its network with
`POST /api/v1/plugins/update`, or approve an update that adds a permission
with `POST /api/v1/plugins/decent-sync.reaplugin/update/approve`.

A Machine's Live View shows nothing live while its tablet runs the 1.4.0
plugin, or while an instance of 1.4.0 holds its connection during the deploy.

### Run the server from source on Node.js 26

The server now needs Node.js 26 or newer with Temporal, as nodejs.org's builds
have. It refuses to start without Temporal, which Node 24 lacks, as do some
packaged builds of Node 26, such as Homebrew's. The server image has it, so
Docker Compose and fly.io need nothing. Running from source, start this release
on Node.js 26. 1.4.0 runs on it too, so moving the old instance first is
optional.

## 1.4.0

### Upgrade without going offline from now on

This release runs beside 1.3.1, and each release from now on runs beside the
one before it. Pages opened from 1.3.1 don't reload into the new release by
themselves, as later pages do at their next navigation: reload them once after
upgrading.

On fly.io, set `fly.toml` up as the README's fly.io section now shows: a
blue-green deploy, a `wait_timeout`, a 10 s check interval and a
`kill_timeout` of 150 s. Deploy this release, then run `fly scale count 2`.
That deploy takes nothing offline, though 1.3.1 doesn't drain as it stops, so
a request under way on it then may fail.

A stopping server now still answers requests for 15 s
(`DRAIN_GRACE_SECONDS`), which a single instance has no use for. Set it to 0
there: with Docker Compose, add `DRAIN_GRACE_SECONDS: "0"` to the server's
`environment` in `docker-compose.yml`, as this release's file does. Otherwise
each later restart waits 10 s, until Docker kills the server.

### The health check reports the database in its body

`/api/health` answers 503 only while the server is stopping. While the server
can't reach its database, it answers 200 with `"database": "unreachable"` in
its body, so a proxy routing by it sends the server traffic again as soon as
the database is back, as after a failover. A monitor that took the 503 for the
database being down reads the body instead.

## 1.1.0

### Update DYE2 and Streamline on every tablet

This release follows DYE2 v0.1.26
([ADR-0017](docs/adr/0017-supported-versions.md)). A Machine that follows
Recipes needs DYE2 v0.1.26 or later and, where Streamline is its skin,
streamline-js from `main` at `cec5664` or later, as Streamline v0.2.18, its
latest release, cannot apply a recipe that holds a grinder or Basket. Decaid
installs the latest DYE2 and Streamline releases on every tablet within 12
hours, so DYE2 is likely there already; Streamline needs that build installed
until a release contains `ea04f83`.

### The migration keeps the database

The server's migration (`server/prisma/migrations/20261024000000_recipe_record_ids/migration.sql`)
runs as it starts, and keeps every Recipe, its history and its Shots' links.
Each Recipe takes a record id, the id of its record on every tablet at its
Location from now on: a Recipe in a slot keeps its slot's number, the id its
records have on the tablets now, and one in no slot is given a new one. A
Location has five Recipe Slots now, so a Recipe in slot 6 or higher leaves its
slot and stays at its Location. Every Recipe of a Location that is not
Archived is written to each of its tablets, those in no slot included, which
DYE2's Select Recipe page lists. What the rules this release drops kept is
dropped with them: each Loaded Recipe's record of what its load write replaced,
each tablet's recipe values from before the server's writes, the recipe records
removed from a slot, and whether each Shot's Workflow named a selection.

### Apply each Machine's recipe again

DYE2 v0.1.26 keeps no selection: it clears the field it wrote its selection
into, and names a recipe in the Workflow only as one is applied. The migration
also forgets which recipe each tablet's Workflow last named. So each Machine's
Loaded Recipe unloads at its next Workflow, and it has none until a barista
applies a recipe again, from Streamline's strip or DYE2's dashboard or Select
Recipe page. Shots pulled meanwhile are linked to no Recipe.

## 1.0.0

### Start the server on an empty database

This release's database migrations start again, from one that creates the
whole schema, so it doesn't upgrade a database an earlier release migrated:
the server refuses to start on one, as its migration finds the tables there
already. Drop the database, or give the server a new one, before starting
this release, then create the first Admin, the Locations and the Machines
again. The Library ids an earlier database wrote into each tablet's records
name nothing in the new one, so each tablet's report is taken in as its
first.

Adopting Machines again joins each to its Location, and the Location's
state wins (`docs/LIBRARY.md`, Joining a Location). At each Location, adopt
first the Machine whose tablet holds the beans, profiles, grinders, recipes,
baskets and tools the Location should keep: a kind the Location already has
is not taken from a Machine adopted after it, whose own are archived or
hidden on its tablet, and its DYE2 recipes, baskets and tools removed from
DYE2's lists. Turn sharing off for a Machine whose tablet's should stay as
they are.

### Install the plugin afresh on every tablet

Remove the plugin on each tablet (`DELETE /api/v1/plugins/decent-sync.reaplugin`
on the tablet's API, or under Decaid's Settings, Plugins), then install it
from this release as the README's Installing the plugin says, and give it
its Machine's new token. A fresh install takes its permissions, `emit`
among them, without the approval an update from 0.3.0 would wait on.
The plugin needs Decaid v0.9.0 or newer, and a Machine that follows Recipes
DYE2 built from `main` at `2cf631c` or later and, where Streamline is its
skin, streamline-js from `main` at `c006dac` or later
([ADR-0017](docs/adr/0017-supported-versions.md)).
