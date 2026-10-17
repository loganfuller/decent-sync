# Upgrading

What to do when upgrading to a release, beyond running its server image and
letting Decaid update each tablet's plugin. Run the server and the plugin of
the same release
([ADR-0017](docs/adr/0017-supported-versions.md)).

Each release's notes on GitHub start with its section here. Notes for the next
release wait under Unreleased until it is tagged (see the README's Releasing
section).

## 1.0.0

### Start the server on an empty database

This release's database migrations start again, from one that creates the
whole schema, so it doesn't upgrade a database an earlier release migrated:
the server refuses to start on one, as its migration finds the tables there
already. Drop the database, or give the server a new one, before starting
this release, then create the first Admin, the Locations and the Machines
again, and give each tablet's plugin its Machine's new token. The Library
ids an earlier database wrote into each tablet's records name nothing in
the new one, so each tablet's report is taken in as its first.
