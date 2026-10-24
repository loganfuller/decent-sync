# Upgrading

What to do when upgrading to a release, beyond running its server image and
letting Decaid update each tablet's plugin. Run the server and the plugin of
the same release
([ADR-0017](docs/adr/0017-supported-versions.md)).

Each release's notes on GitHub start with its section here. Notes for the next
release wait under Unreleased until it is tagged (see the README's Releasing
section).

## Unreleased

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
