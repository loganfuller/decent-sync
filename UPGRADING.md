# Upgrading

What to do when upgrading to a release, beyond running its server image and
letting Decaid update each tablet's plugin. Run the server and the plugin of
the same release
([ADR-0017](docs/adr/0017-supported-versions.md)).

Each release's notes on GitHub start with its section here. Notes for the next
release wait under Unreleased until it is tagged (see the README's Releasing
section).

## Unreleased

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
